/**
 * Transfer Routes
 * Handles streaming downloads with Range header (206 Partial Content),
 * simple uploads (<100MB), and chunked uploads (up to 10GB).
 */

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { shareManager } from '../services/share-manager.js';
import { chunkedUploadManager } from '../services/chunked-upload.js';
import { pendingUploadManager } from '../services/pending-upload.js';
import { broadcastEvent } from '../websocket/handlers.js';
import { config } from '../config.js';
import { AppError } from '../middleware/error-handler.js';
import { sanitizeFileName } from '../utils/file-utils.js';

export const transferRouter = Router();

// Storage for simple upload (<100MB) staged in pending directory awaiting approval
const simpleUploadStorage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    const pendingDir = path.join(config.tempDir, 'pending');
    try {
      await fs.promises.mkdir(pendingDir, { recursive: true });
      cb(null, pendingDir);
    } catch (err) {
      cb(err, pendingDir);
    }
  },
  filename: (_req, file, cb) => {
    const cleanName = sanitizeFileName(file.originalname);
    const pendingDir = path.join(config.tempDir, 'pending');
    let finalPath = path.join(pendingDir, cleanName);

    if (!fs.existsSync(finalPath)) {
      return cb(null, cleanName);
    }

    // Resolve name collisions safely in pending area
    const ext = path.extname(cleanName);
    const base = path.basename(cleanName, ext);
    let counter = 1;
    while (fs.existsSync(finalPath)) {
      finalPath = path.join(pendingDir, `${base}_(${counter})${ext}`);
      counter++;
    }
    cb(null, path.basename(finalPath));
  },
});

const simpleUpload = multer({
  storage: simpleUploadStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit for simple upload
});

// Memory storage for receiving chunk buffer
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.chunkSize + 1024 * 1024 }, // Chunk size with headroom
});

/**
 * GET /api/download/:fileId
 * Streams a staged file to client with Range header (resume & seeking) support.
 */
transferRouter.get('/api/download/:fileId', async (req, res, next) => {
  try {
    const { fileId } = req.params;
    const fileRecord = shareManager.getFile(fileId);

    if (!fileRecord) {
      throw new AppError('FILE_NOT_FOUND', 404, `File ${fileId} not found`);
    }

    let stat;
    try {
      stat = await fs.promises.stat(fileRecord.path);
    } catch {
      throw new AppError('FILE_NOT_FOUND', 404, `Physical file missing: ${fileRecord.name}`);
    }

    const fileSize = stat.size;
    const range = req.headers.range;

    // Standard headers
    res.setHeader('Content-Type', fileRecord.mimeType || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-transform');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(fileRecord.name)}"; filename*=UTF-8''${encodeURIComponent(fileRecord.name)}`
    );

    if (range) {
      // Range header format: "bytes=start-end"
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (isNaN(start) || isNaN(end) || start < 0 || start > end || end >= fileSize) {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).json({
          success: false,
          error: { code: 'RANGE_NOT_SATISFIABLE', message: 'Requested range not satisfiable' },
        });
      }

      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);

      const stream = fs.createReadStream(fileRecord.path, { start, end });
      stream.on('error', (err) => next(err));
      stream.pipe(res);
    } else {
      res.status(200);
      res.setHeader('Content-Length', fileSize);

      const stream = fs.createReadStream(fileRecord.path);
      stream.on('error', (err) => next(err));
      stream.pipe(res);
    }
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/thumbnail/:fileId
 * Placeholder for MVP (thumbnails disabled/optional).
 */
transferRouter.get('/api/thumbnail/:fileId', (req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'THUMBNAIL_NOT_AVAILABLE', message: 'Thumbnails not enabled in MVP' },
  });
});

/**
 * POST /api/upload
 * Simple upload endpoint for single/multiple files (<100MB).
 */
transferRouter.post('/api/upload', simpleUpload.array('files'), async (req, res, next) => {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      throw new AppError('NO_FILES_UPLOADED', 400, 'No files provided in upload');
    }

    const senderDevice = {
      deviceId: req.headers['x-device-id'] || req.body?.deviceId || 'unknown',
      deviceName: req.headers['x-device-name'] || req.body?.deviceName || 'Mobile Device',
      platform: req.headers['x-platform'] || req.body?.platform || 'unknown',
    };

    const uploaded = [];
    const pending = [];
    const wss = req.app.get('wss');

    for (const f of files) {
      const record = pendingUploadManager.createPending({
        fileName: f.originalname || f.filename,
        fileSize: f.size,
        mimeType: f.mimetype,
        tempPath: f.path,
        senderDevice,
      });

      uploaded.push({
        name: f.filename,
        size: f.size,
        path: f.path,
        transferId: record.transferId,
      });
      pending.push(record);

      if (wss) {
        broadcastEvent(wss, 'upload:request', { pending: record });
      }
    }

    res.status(201).json({
      success: true,
      data: { uploaded, pending },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/upload/init
 * Initializes a chunked upload session for large files.
 */
transferRouter.post('/api/upload/init', async (req, res, next) => {
  try {
    const { fileName, fileSize, mimeType } = req.body || {};
    const result = await chunkedUploadManager.initUpload({ fileName, fileSize, mimeType });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/upload/chunk
 * Uploads a single chunk of a large file.
 */
transferRouter.post('/api/upload/chunk', chunkUpload.single('chunk'), async (req, res, next) => {
  try {
    const { uploadId, chunkIndex } = req.body || {};

    if (!uploadId || chunkIndex === undefined) {
      throw new AppError('INVALID_INPUT', 400, 'uploadId and chunkIndex are required');
    }

    if (!req.file || !req.file.buffer) {
      throw new AppError('CHUNK_INVALID', 400, 'No chunk data provided');
    }

    const result = await chunkedUploadManager.addChunk(
      uploadId,
      parseInt(chunkIndex, 10),
      req.file.buffer
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/upload/status/:uploadId
 * Fetches status of chunks received so far to resume after disconnection.
 */
transferRouter.get('/api/upload/status/:uploadId', (req, res, next) => {
  try {
    const { uploadId } = req.params;
    const status = chunkedUploadManager.getStatus(uploadId);

    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/upload/complete
 * Merges all uploaded chunks into the pending staging file awaiting approval.
 */
transferRouter.post('/api/upload/complete', async (req, res, next) => {
  try {
    const { uploadId } = req.body || {};
    if (!uploadId) {
      throw new AppError('INVALID_INPUT', 400, 'uploadId is required');
    }

    const pendingDir = path.join(config.tempDir, 'pending');
    const result = await chunkedUploadManager.complete(uploadId, pendingDir);

    const senderDevice = {
      deviceId: req.headers['x-device-id'] || req.body?.deviceId || 'unknown',
      deviceName: req.headers['x-device-name'] || req.body?.deviceName || 'Mobile Device',
      platform: req.headers['x-platform'] || req.body?.platform || 'unknown',
    };

    const record = pendingUploadManager.createPending({
      fileName: result.fileName,
      fileSize: result.size,
      mimeType: result.mimeType || 'application/octet-stream',
      tempPath: result.filePath,
      senderDevice,
    });

    const wss = req.app.get('wss');
    if (wss) {
      broadcastEvent(wss, 'upload:request', { pending: record });
    }

    res.json({
      success: true,
      data: { ...result, pending: record, transferId: record.transferId },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/upload/pending
 * Returns list of pending file transfers awaiting PC user approval.
 */
transferRouter.get('/api/upload/pending', (_req, res) => {
  res.json({
    success: true,
    data: pendingUploadManager.listPending(),
  });
});

/**
 * POST /api/upload/decision
 * PC user accepts or declines a pending upload.
 */
transferRouter.post('/api/upload/decision', async (req, res, next) => {
  try {
    const { transferId, action } = req.body || {};
    if (!transferId || !action) {
      throw new AppError('INVALID_INPUT', 400, 'transferId and action are required');
    }

    const wss = req.app.get('wss');

    if (action === 'accept') {
      const accepted = await pendingUploadManager.accept(transferId);
      if (wss) {
        broadcastEvent(wss, 'transfer:complete', {
          transferId,
          fileName: accepted.fileName,
          size: accepted.size,
        });
      }
      return res.json({
        success: true,
        data: accepted,
      });
    }

    if (action === 'decline') {
      const declined = await pendingUploadManager.decline(transferId);
      if (wss) {
        broadcastEvent(wss, 'transfer:rejected', {
          transferId,
          reason: 'REJECTED_BY_PC',
        });
      }
      return res.json({
        success: true,
        data: declined,
      });
    }

    throw new AppError('INVALID_INPUT', 400, 'Action must be "accept" or "decline"');
  } catch (error) {
    next(error);
  }
});
