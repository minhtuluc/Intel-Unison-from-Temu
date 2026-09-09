/**
 * System and Server Information Routes
 * Endpoints for discovering server status, QR codes, and PIN authentication.
 */

import { Router } from 'express';
import os from 'node:os';
import qrcode from 'qrcode';
import { config } from '../config.js';
import { getLanIp } from '../utils/network.js';
import { AppError } from '../middleware/error-handler.js';
import { discoveryService } from '../services/discovery.js';

export const infoRouter = Router();

// Track PIN attempts per IP for rate limiting: ip -> { attempts: number, lastAttempt: number, lockedUntil: number }
const authAttempts = new Map();

/**
 * GET /api/info
 * Returns server identification, platform, LAN connection URL, and QR code.
 */
infoRouter.get('/api/info', async (_req, res, next) => {
  try {
    const ip = getLanIp() || '127.0.0.1';
    const port = config.port;
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

    const connectedDevices = discoveryService.getDevices().length;

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
    // If no PIN is configured on server, bypass authentication
    if (!config.pin) {
      return res.json({
        success: true,
        data: {
          token: 'bypass',
          message: 'No PIN protection configured',
        },
      });
    }

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

    const { pin } = req.body || {};

    if (!pin || String(pin).trim() !== String(config.pin)) {
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

    // Simple deterministic session token for local WLAN
    const token = `utrans_${Buffer.from(`${clientIp}:${now}`).toString('base64url')}`;

    res.json({
      success: true,
      data: {
        token,
        expiresIn: 86400,
      },
    });
  } catch (error) {
    next(error);
  }
});
