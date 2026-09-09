/**
 * File Sharing and Staging Routes
 * Manages staged files, dual-mode sharing (Browser drop-zone upload vs CLI local paths).
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { shareManager } from '../services/share-manager.js';
import { config } from '../config.js';
import { AppError } from '../middleware/error-handler.js';

export const filesRouter = Router();

// Configure multer storage for browser drop-zone uploads to staging directory
const stagingStorage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    const stagingDir = path.join(config.tempDir, 'staging');
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

const stagingUpload = multer({
  storage: stagingStorage,
  limits: { fileSize: config.maxFileSize },
});

/**
 * GET /api/shared
 * Returns list of currently staged files available for download over LAN.
 */
filesRouter.get('/api/shared', (_req, res) => {
  const result = shareManager.listFiles();
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
filesRouter.post('/api/share', (req, res, next) => {
  // Check if content-type is multipart
  if (req.is('multipart/form-data')) {
    stagingUpload.array('files')(req, res, async (err) => {
      if (err) return next(err);

      try {
        const uploadedFiles = req.files || [];
        if (uploadedFiles.length === 0) {
          throw new AppError('NO_FILES_PROVIDED', 400, 'No files found in multipart request');
        }

        const shared = [];
        for (const file of uploadedFiles) {
          const meta = await shareManager.addFile(file.path, file.originalname);
          shared.push(meta);
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
    // JSON local path mode
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

        const shared = await shareManager.addFiles(paths);

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
    const removed = shareManager.removeFile(fileId);

    if (!removed) {
      throw new AppError('FILE_NOT_FOUND', 404, `File ${fileId} not found in staging`);
    }

    res.json({
      success: true,
      data: { removed: fileId },
    });
  } catch (error) {
    next(error);
  }
});
