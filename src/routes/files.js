/**
 * File Sharing and Staging Routes
 * Manages staged files, dual-mode sharing (Browser drop-zone upload vs CLI local paths).
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { AppError } from '../middleware/error-handler.js';
import { broadcastEvent } from '../websocket/handlers.js';
import { requireHost } from '../middleware/host-auth.js';
import { assertPathShape, validatePath } from '../middleware/security.js';

export const filesRouter = Router();

// Only the multipart branch is a client upload into staging. Every other body
// format is treated as a host source-path request and gated on host authority —
// gating on "is JSON" would let another content type (urlencoded, text) through.
function hostOnlyForSourcePaths(req, res, next) {
  if (req.is('multipart/form-data')) {
    return next();
  }
  return requireHost(req, res, next);
}

// Configure multer storage for browser drop-zone uploads to staging directory.
// The destination is resolved per request from the app runtime.
const stagingStorage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    const stagingDir = path.join(req.app.locals.runtime.config.tempDir, 'staging');
    try {
      await fs.promises.mkdir(stagingDir, { recursive: true });
      cb(null, stagingDir);
    } catch (err) {
      cb(err, stagingDir);
    }
  },
  filename: (_req, file, cb) => {
    // Generate unique storage name to avoid colliding names in staging
    const uniqueSuffix = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}_${file.originalname}`);
  },
});

// Limits come from the app runtime, so two runtimes can differ. Instances are
// cached per runtime instead of being created at module load.
const stagingUploads = new WeakMap();
function stagingUploadFor(runtime) {
  let upload = stagingUploads.get(runtime);
  if (!upload) {
    upload = multer({
      storage: stagingStorage,
      limits: { fileSize: runtime.config.maxFileSize },
    });
    stagingUploads.set(runtime, upload);
  }
  return upload;
}

/** Runs the multipart parser and maps transport-level limits to API errors. */
function parseStagingUpload(req, res, next) {
  stagingUploadFor(req.app.locals.runtime).array('files')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(
        new AppError(
          'FILE_TOO_LARGE',
          413,
          `File exceeds maximum allowed size (${req.app.locals.runtime.config.maxFileSize} bytes)`
        )
      );
    }
    return next(err);
  });
}

/**
 * GET /api/shared
 * Returns list of currently staged files available for download over LAN.
 */
filesRouter.get('/api/shared', (req, res) => {
  const result = req.app.locals.runtime.shareManager.listFiles();
  res.json({
    success: true,
    data: result,
  });
});

/**
 * POST /api/share
 * Dual mode sharing:
 * 1. Browser drag-and-drop: multipart/form-data with 'files'
 * 2. Local CLI / Electron: JSON body with { "paths": ["..."] }
 */
filesRouter.post('/api/share', hostOnlyForSourcePaths, (req, res, next) => {
  // Check if content-type is multipart
  if (req.is('multipart/form-data')) {
    parseStagingUpload(req, res, async (err) => {
      if (err) return next(err);

      try {
        const uploadedFiles = req.files || [];
        if (uploadedFiles.length === 0) {
          throw new AppError('NO_FILES_PROVIDED', 400, 'No files found in multipart request');
        }

        const { shareManager } = req.app.locals.runtime;
        const shared = [];
        for (const file of uploadedFiles) {
          const meta = await shareManager.addFile(file.path, file.originalname);
          shared.push(meta);
        }

        const wss = req.app.get('wss');
        if (wss) {
          broadcastEvent(wss, 'share:update', shareManager.listFiles());
        }

        res.status(201).json({
          success: true,
          data: { shared },
        });
      } catch (error) {
        next(error);
      }
    });
  } else {
    // Host source-path mode. Strictly JSON: any other parsed body shape is refused
    // rather than interpreted as a path list.
    if (!req.is('application/json')) {
      return next(
        new AppError(
          'UNSUPPORTED_MEDIA_TYPE',
          415,
          'Source paths must be sent as application/json; clients upload with multipart/form-data'
        )
      );
    }

    (async () => {
      try {
        const { paths } = req.body || {};
        if (!paths || !Array.isArray(paths) || paths.length === 0) {
          throw new AppError(
            'INVALID_INPUT',
            400,
            'Request body must contain a non-empty "paths" array'
          );
        }

        const allowedDirs = req.app.locals.runtime.config.allowedSourceDirs || [];
        for (const sourcePath of paths) {
          if (allowedDirs.length > 0) {
            validatePath(sourcePath, allowedDirs);
          } else {
            assertPathShape(sourcePath);
          }
        }

        const { shareManager } = req.app.locals.runtime;
        const shared = await shareManager.addFiles(paths);

        const wss = req.app.get('wss');
        if (wss) {
          broadcastEvent(wss, 'share:update', shareManager.listFiles());
        }

        res.status(201).json({
          success: true,
          data: { shared },
        });
      } catch (error) {
        next(error);
      }
    })();
  }
});

/**
 * DELETE /api/share/:fileId
 * Removes a file from the staging area.
 */
filesRouter.delete('/api/share/:fileId', (req, res, next) => {
  try {
    const { fileId } = req.params;
    const removed = req.app.locals.runtime.shareManager.removeFile(fileId);

    if (!removed) {
      throw new AppError('FILE_NOT_FOUND', 404, `File ${fileId} not found in staging`);
    }

    const wss = req.app.get('wss');
    if (wss) {
      broadcastEvent(wss, 'share:update', req.app.locals.runtime.shareManager.listFiles());
    }

    res.json({
      success: true,
      data: { removed: fileId },
    });
  } catch (error) {
    next(error);
  }
});
