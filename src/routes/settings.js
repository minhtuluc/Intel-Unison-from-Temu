/**
 * Settings, quota and history.
 *
 * Settings are host-only and are the one place internal paths are returned, because
 * the host is the machine that owns them. Quota and history carry numbers and file
 * names only, so they stay safe for a client to read about its own transfers.
 */

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { requireHost } from '../middleware/host-auth.js';
import { AppError } from '../middleware/error-handler.js';
import { resolvePath } from '../config.js';
import { logger } from '../utils/logger.js';
import { extractSessionToken } from '../middleware/session-auth.js';
import { resolveSender, getSessionConnectionIds } from '../utils/connection-identity.js';

export const settingsRouter = Router();

/** True when child is the same as, or lives under, parent. */
function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Validates a proposed receive directory.
 *
 * The receive dir is where approved files land, so it must be a real, writable
 * location that is not the app's own staging: pointing it at tempDir would let
 * cleanup delete delivered files.
 * @param {string} candidate
 * @param {object} config
 * @returns {string} the resolved directory
 */
export function validateReceiveDir(candidate, config) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new AppError('INVALID_INPUT', 400, 'uploadDir must be a non-empty path string');
  }
  if (candidate.includes('\0')) {
    throw new AppError('INVALID_INPUT', 400, 'uploadDir must not contain null bytes');
  }

  // A relative path would silently resolve against the server process's cwd, which
  // is not something the person setting it can see, so it is refused outright.
  const trimmed = candidate.trim();
  if (!path.isAbsolute(trimmed) && !trimmed.startsWith('~')) {
    throw new AppError(
      'INVALID_INPUT',
      400,
      'uploadDir must be an absolute path, or start with ~ for the home directory'
    );
  }

  const resolved = resolvePath(trimmed);
  if (isInside(resolved, config.tempDir)) {
    throw new AppError(
      'INVALID_UPLOAD_DIR',
      400,
      'The receive directory cannot live inside the app temp directory; cleanup would delete delivered files'
    );
  }
  if (isInside(config.tempDir, resolved)) {
    throw new AppError(
      'INVALID_UPLOAD_DIR',
      400,
      'The receive directory cannot contain the app temp directory'
    );
  }
  return resolved;
}

/** GET /api/settings — host-only view of the paths and limits in force. */
settingsRouter.get('/api/settings', requireHost, (req, res) => {
  const { config } = req.app.locals.runtime;
  res.json({
    success: true,
    data: {
      uploadDir: config.uploadDir,
      tempDir: config.tempDir,
      dataDir: config.dataDir,
      maxFileSize: config.maxFileSize,
      chunkSize: config.chunkSize,
      storageQuota: config.storageQuota,
      maxConcurrentTransfers: config.maxConcurrentTransfers,
      offerTtlMs: config.offerTtlMs,
    },
  });
});

/**
 * PATCH /api/settings — host-only, currently limited to the receive directory.
 *
 * Only `uploadDir` is mutable: it is read at move time, so a change applies to the
 * next delivered file without restarting. Everything else stays frozen for the
 * process lifetime, which is the invariant ADR-0002 relied on.
 */
settingsRouter.patch('/api/settings', requireHost, async (req, res, next) => {
  try {
    const body = req.body || {};
    const unknown = Object.keys(body).filter((key) => key !== 'uploadDir');
    if (unknown.length > 0) {
      throw new AppError(
        'INVALID_INPUT',
        400,
        `Only uploadDir can be changed at runtime (received: ${unknown.join(', ')})`
      );
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'uploadDir')) {
      throw new AppError('INVALID_INPUT', 400, 'uploadDir is required');
    }

    const runtime = req.app.locals.runtime;
    const resolved = validateReceiveDir(body.uploadDir, runtime.config);

    try {
      await fs.promises.mkdir(resolved, { recursive: true });
      const stat = await fs.promises.stat(resolved);
      if (!stat.isDirectory()) {
        throw new AppError('INVALID_UPLOAD_DIR', 400, 'uploadDir is not a directory');
      }
      // Probe write capability (M3 QC review)
      const probeFile = path.join(resolved, `.probe-${process.pid}-${Date.now()}.tmp`);
      try {
        await fs.promises.writeFile(probeFile, '');
        await fs.promises.rm(probeFile, { force: true });
      } catch (writeErr) {
        throw new AppError(
          'INVALID_UPLOAD_DIR',
          400,
          `uploadDir is not writable: ${writeErr.message}`
        );
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('INVALID_UPLOAD_DIR', 400, `uploadDir cannot be used: ${err.message}`);
    }

    const previous = runtime.config.uploadDir;
    runtime.config.uploadDir = resolved;
    logger.info('Receive directory changed by host', { from: previous, to: resolved });

    res.json({ success: true, data: { uploadDir: resolved } });
  } catch (error) {
    next(error);
  }
});

/** GET /api/quota — how much staging space is committed, so the UI can explain a 507. */
settingsRouter.get('/api/quota', (req, res) => {
  const stats = req.app.locals.runtime.quotaTracker.getStats();
  res.json({
    success: true,
    data: {
      limitBytes: stats.limit,
      usedBytes: stats.used,
      availableBytes: stats.available,
    },
  });
});

/** GET /api/transfers/history — host sees everything, a client sees only its own. */
settingsRouter.get('/api/transfers/history', (req, res, next) => {
  try {
    const runtime = req.app.locals.runtime;
    const hostAuth = req.app.locals.hostAuth || runtime.hostAuth;
    const isHost = Boolean(hostAuth?.verify(req, req.headers['x-host-token']));

    if (isHost) {
      return res.json({
        success: true,
        data: {
          scope: 'host',
          entries: runtime.history.list({
            isHost: true,
            limit: Number(req.query.limit) || undefined,
          }),
        },
      });
    }

    // Non-host client: verify connection identity server-side (M3-QC-03)
    const connectionHeader = req.headers['x-connection-id'];
    const reqToken = extractSessionToken(req);
    let allowedConnectionIds = [];
    if (connectionHeader) {
      // Claimed connectionId MUST belong to the caller's session/IP
      const sender = resolveSender(req, { required: true });
      if (reqToken) {
        allowedConnectionIds = getSessionConnectionIds(req);
        if (sender.connectionId && !allowedConnectionIds.includes(sender.connectionId)) {
          allowedConnectionIds.push(sender.connectionId);
        }
      } else {
        allowedConnectionIds = [sender.connectionId];
      }
    } else {
      // No header: query all connections registered under caller's session
      allowedConnectionIds = getSessionConnectionIds(req);
    }

    res.json({
      success: true,
      data: {
        scope: 'self',
        entries: runtime.history.list({
          isHost: false,
          connectionIds: allowedConnectionIds,
          limit: Number(req.query.limit) || undefined,
        }),
      },
    });
  } catch (err) {
    next(err);
  }
});
