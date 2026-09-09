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
import { config } from '../config.js';
import { AppError } from '../middleware/error-handler.js';
import { sanitizeFileName } from '../utils/file-utils.js';

export const transferRouter = Router();

// Storage for simple upload (<100MB) directly to uploadDir
const simpleUploadStorage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await fs.promises.mkdir(config.uploadDir, { recursive: true });
      cb(null, config.uploadDir);
    } catch (err) {
      cb(err, config.uploadDir);
    }
  },
  filename: (_req, file, cb) => {
    const cleanName = sanitizeFileName(file.originalname);
    let finalPath = path.join(config.uploadDir, cleanName);

    if (!fs.existsSync(finalPath)) {
      return cb(null, cleanName);
    }

    // Resolve name collisions safely
    const ext = path.extname(cleanName);
    const base = path.basename(cleanName, ext);
    let counter = 1;
    while (fs.existsSync(finalPath)) {
      finalPath = path.join(config.uploadDir, `${base}_(${counter})${ext}`);
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
transferRouter.post('/api/upload', simpleUpload.array('files'), (req, res, next) => {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      throw new AppError('NO_FILES_UPLOADED', 400, 'No files provided in upload');
    }

    const uploaded = files.map((f) => ({
      name: f.filename,
      size: f.size,
      path: f.path,
    }));

    res.status(201).json({
      success: true,
      data: { uploaded },
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
 * Merges all uploaded chunks into the final destination file.
 */
transferRouter.post('/api/upload/complete', async (req, res, next) => {
  try {
    const { uploadId } = req.body || {};
    if (!uploadId) {
      throw new AppError('INVALID_INPUT', 400, 'uploadId is required');
    }

    const result = await chunkedUploadManager.complete(uploadId);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});
