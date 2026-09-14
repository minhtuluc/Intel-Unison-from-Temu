/**
 * System and Server Information Routes
 * Endpoints for discovering server status, QR codes, and PIN authentication.
 */

import { Router } from 'express';
import os from 'node:os';
import qrcode from 'qrcode';
import { getLanIp } from '../utils/network.js';
import { AppError } from '../middleware/error-handler.js';
import { requireHost } from '../middleware/host-auth.js';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  extractSessionToken,
} from '../middleware/session-auth.js';

export const infoRouter = Router();

// Track PIN attempts per IP for rate limiting: ip -> { attempts, lastAttempt, lockedUntil }.
// Kept on app.locals so two app instances in one process cannot share counters.
function attemptsFor(req) {
  if (!req.app.locals.authAttempts) {
    req.app.locals.authAttempts = new Map();
  }
  return req.app.locals.authAttempts;
}

/**
 * GET /api/info
 * Returns server identification, platform, LAN connection URL, and QR code.
 */
infoRouter.get('/api/info', async (req, res, next) => {
  try {
    const runtime = req.app.locals.runtime;
    const ip = getLanIp() || '127.0.0.1';
    const port = runtime.port;
    const connectUrl = `http://${ip}:${port}`;

    let qrCode = '';
    try {
      qrCode = await qrcode.toDataURL(connectUrl, {
        errorCorrectionLevel: 'M',
        margin: 2,
        scale: 6,
        color: {
          dark: '#0a0e1aff',
          light: '#ffffffff',
        },
      });
    } catch {
      // Graceful fallback if QR generation encounters an issue
    }

    const connectedDevices = runtime.discovery.getDevices().length;

    res.json({
      success: true,
      data: {
        serverName: os.hostname(),
        platform: process.platform,
        version: '1.0.0',
        ip,
        port,
        connectUrl,
        qrCode,
        pinRequired: Boolean(req.app.locals.pinRequired),
        connectedDevices,
        uptime: Math.floor(process.uptime()),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth
 * PIN code verification with brute-force rate limiting (5 attempts/min, 5-min lockout).
 */
infoRouter.post('/api/auth', (req, res, next) => {
  try {
    const pin = req.app.locals.runtime.config.pin;

    // If no PIN is configured on server, bypass authentication
    if (!pin) {
      return res.json({
        success: true,
        data: {
          token: 'bypass',
          message: 'No PIN protection configured',
        },
      });
    }

    const authAttempts = attemptsFor(req);
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const attemptRecord = authAttempts.get(clientIp) || {
      attempts: 0,
      lastAttempt: now,
      lockedUntil: 0,
    };

    // Check if client is locked out
    if (attemptRecord.lockedUntil > now) {
      const remainingSecs = Math.ceil((attemptRecord.lockedUntil - now) / 1000);
      throw new AppError(
        'RATE_LIMITED',
        429,
        `Too many failed attempts. Try again in ${remainingSecs} seconds.`
      );
    }

    // Reset attempt counter after 1 minute of inactivity
    if (now - attemptRecord.lastAttempt > 60000) {
      attemptRecord.attempts = 0;
    }

    attemptRecord.lastAttempt = now;

    const submittedPin = (req.body || {}).pin;

    if (!submittedPin || String(submittedPin).trim() !== String(pin)) {
      attemptRecord.attempts += 1;

      // Lockout for 5 minutes after 5 failed attempts
      if (attemptRecord.attempts >= 5) {
        attemptRecord.lockedUntil = now + 5 * 60 * 1000;
        authAttempts.set(clientIp, attemptRecord);
        throw new AppError(
          'RATE_LIMITED',
          429,
          'Maximum PIN attempts reached. Locked out for 5 minutes.'
        );
      }

      authAttempts.set(clientIp, attemptRecord);
      throw new AppError('UNAUTHORIZED', 401, 'Invalid PIN code');
    }

    // Success - reset attempts
    authAttempts.delete(clientIp);

    const issued = req.app.locals.sessions.issue(clientIp);

    // Media and download URLs cannot set headers in a browser, so the session is
    // also carried in an HttpOnly, SameSite=Strict cookie.
    res.setHeader('Set-Cookie', buildSessionCookie(issued.token, Math.floor(issued.ttlMs / 1000)));

    res.json({
      success: true,
      data: {
        token: issued.token,
        expiresAt: issued.expiresAt,
        expiresIn: Math.floor(issued.ttlMs / 1000),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/logout
 * Revokes the caller's session capability.
 */
infoRouter.post('/api/auth/logout', (req, res) => {
  const token = extractSessionToken(req);
  const revoked = token ? req.app.locals.sessions.revoke(token) : false;
  res.setHeader('Set-Cookie', buildClearedSessionCookie());
  res.json({ success: true, data: { revoked } });
});

/**
 * POST /api/auth/revoke-all
 * Host-only: invalidates every issued session.
 */
infoRouter.post('/api/auth/revoke-all', requireHost, (req, res) => {
  const revoked = req.app.locals.sessions.revokeAll();
  res.setHeader('Set-Cookie', buildClearedSessionCookie());
  res.json({ success: true, data: { revoked } });
});
