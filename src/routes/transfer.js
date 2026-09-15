/**
 * Transfer Routes
 * Handles streaming downloads with Range header (206 Partial Content),
 * simple uploads (<100MB), and chunked uploads (up to 10GB).
 */

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { broadcastEvent } from '../websocket/handlers.js';
import { AppError } from '../middleware/error-handler.js';
import { sanitizeFileName, parseRange } from '../utils/file-utils.js';
import { requireHost } from '../middleware/host-auth.js';

export const transferRouter = Router();

/**
 * Sender attribution for approvals. The IP is observed by the server; the display
 * name is whatever the client claimed and is marked untrusted for the host UI.
 * @param {import('express').Request} req
 */
function describeSender(req) {
  return {
    ip: req.ip || req.socket?.remoteAddress || 'unknown',
    label: req.headers['x-device-name'] || req.body?.deviceName || 'Unknown device',
    labelUntrusted: true,
    platform: req.headers['x-platform'] || req.body?.platform || 'unknown',
  };
}

// Storage for simple upload (<100MB) staged in pending directory awaiting approval
const simpleUploadStorage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    const pendingDir = path.join(req.app.locals.runtime.config.tempDir, 'pending');
    try {
      await fs.promises.mkdir(pendingDir, { recursive: true });
      cb(null, pendingDir);
    } catch (err) {
      cb(err, pendingDir);
    }
  },
  filename: (req, file, cb) => {
    const cleanName = sanitizeFileName(file.originalname);
    const pendingDir = path.join(req.app.locals.runtime.config.tempDir, 'pending');
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

const SIMPLE_UPLOAD_CEILING = 100 * 1024 * 1024;
const simpleUploads = new WeakMap();

function simpleUploadFor(runtime) {
  let upload = simpleUploads.get(runtime);
  if (!upload) {
    const limit = Math.min(runtime.config.maxFileSize, SIMPLE_UPLOAD_CEILING);
    upload = multer({
      storage: simpleUploadStorage,
      limits: { fileSize: limit },
    });
    simpleUploads.set(runtime, upload);
  }
  return upload;
}

/** Parses simple multipart uploads and reports oversized files as 413. */
function parseSimpleUpload(req, res, next) {
  const runtime = req.app.locals.runtime;
  const limit = Math.min(runtime.config.maxFileSize, SIMPLE_UPLOAD_CEILING);
  simpleUploadFor(runtime).array('files')(req, res, async (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      if (req.files && Array.isArray(req.files)) {
        for (const file of req.files) {
          if (file.path) {
            try {
              await fs.promises.unlink(file.path);
            } catch {
              // Ignore unlink error
            }
          }
        }
      }
      return next(
        new AppError(
          'FILE_TOO_LARGE',
          413,
          `File exceeds the maximum allowed size (${limit} bytes)`
        )
      );
    }
    return next(err);
  });
}

/** Headroom above one chunk allowed by the transport layer. */
const CHUNK_HEADROOM = 1024 * 1024;

// Chunk bodies are buffered in memory, so the transport ceiling must stay close to
// one chunk: it is derived from the runtime config and cached per runtime.
const chunkUploads = new WeakMap();
function chunkUploadFor(runtime) {
  let upload = chunkUploads.get(runtime);
  if (!upload) {
    upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: runtime.config.chunkSize + CHUNK_HEADROOM },
    });
    chunkUploads.set(runtime, upload);
  }
  return upload;
}

/** Parses one chunk and reports an oversized body as 413 instead of a 500. */
function parseChunkUpload(req, res, next) {
  const { chunkSize } = req.app.locals.runtime.config;
  chunkUploadFor(req.app.locals.runtime).single('chunk')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(
        new AppError(
          'CHUNK_TOO_LARGE',
          413,
          `Chunk exceeds the allowed size (${chunkSize} bytes plus headroom)`
        )
      );
    }
    return next(err);
  });
}

/**
 * GET /api/download/:fileId
 * Streams a staged file to client with Range header (resume & seeking) support.
 */
transferRouter.get('/api/download/:fileId', async (req, res, next) => {
  try {
    const { fileId } = req.params;
    const fileRecord = req.app.locals.runtime.shareManager.getFile(fileId);

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
    const rangeHeader = req.headers.range;

    // Standard headers
    res.setHeader('Content-Type', fileRecord.mimeType || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-transform');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(fileRecord.name)}"; filename*=UTF-8''${encodeURIComponent(fileRecord.name)}`
    );

    let stream;

    if (rangeHeader) {
      const parsed = parseRange(rangeHeader, fileSize);
      if (parsed) {
        if (!parsed.satisfiable) {
          res.setHeader('Content-Range', `bytes */${fileSize}`);
          return res.status(416).json({
            success: false,
            error: { code: 'RANGE_NOT_SATISFIABLE', message: 'Requested range not satisfiable' },
          });
        }

        res.status(206);
        res.setHeader('Content-Range', `bytes ${parsed.start}-${parsed.end}/${fileSize}`);
        res.setHeader('Content-Length', parsed.contentLength);

        stream = fs.createReadStream(fileRecord.path, { start: parsed.start, end: parsed.end });
      }
    }

    if (!stream) {
      res.status(200);
      res.setHeader('Content-Length', fileSize);
      stream = fs.createReadStream(fileRecord.path);
    }

    res.on('close', () => {
      stream.destroy();
    });

    stream.on('error', (err) => {
      if (!res.headersSent) {
        next(err);
      } else {
        res.destroy(err);
      }
    });

    stream.pipe(res);
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
transferRouter.post('/api/upload', parseSimpleUpload, async (req, res, next) => {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      throw new AppError('NO_FILES_UPLOADED', 400, 'No files provided in upload');
    }

    // Sender attribution is observed by the server; the claimed name is a label only.
    const sender = describeSender(req);

    const uploaded = [];
    const pending = [];
    const wss = req.app.get('wss');

    for (const f of files) {
      const record = req.app.locals.runtime.pendingUploadManager.createPending({
        fileName: f.originalname || f.filename,
        fileSize: f.size,
        mimeType: f.mimetype,
        tempPath: f.path,
        sender,
      });

      uploaded.push({
        name: f.filename,
        size: f.size,
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
    const result = await req.app.locals.runtime.chunkedUploadManager.initUpload({
      fileName,
      fileSize,
      mimeType,
    });

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
transferRouter.post('/api/upload/chunk', parseChunkUpload, async (req, res, next) => {
  try {
    const { uploadId, chunkIndex, checksum } = req.body || {};

    if (!uploadId || chunkIndex === undefined || chunkIndex === null || chunkIndex === '') {
      throw new AppError('INVALID_INPUT', 400, 'uploadId and chunkIndex are required');
    }

    const idx = Number(chunkIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      throw new AppError('INVALID_INPUT', 400, 'chunkIndex must be a non-negative integer');
    }

    if (!req.file || !req.file.buffer) {
      throw new AppError('CHUNK_INVALID', 400, 'No chunk data provided');
    }

    const runtime = req.app.locals.runtime;
    if (req.file.size > runtime.config.chunkSize + CHUNK_HEADROOM) {
      throw new AppError(
        'CHUNK_TOO_LARGE',
        413,
        `Chunk exceeds the allowed size (${runtime.config.chunkSize} + headroom bytes)`
      );
    }

    const result = await runtime.chunkedUploadManager.addChunk(
      uploadId,
      idx,
      req.file.buffer,
      checksum
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
    const status = req.app.locals.runtime.chunkedUploadManager.getStatus(uploadId);

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

    const runtime = req.app.locals.runtime;
    const pendingDir = path.join(runtime.config.tempDir, 'pending');
    const result = await runtime.chunkedUploadManager.complete(uploadId, pendingDir);

    // Sender attribution is observed by the server; the claimed name is a label only.
    const sender = describeSender(req);

    const record = runtime.pendingUploadManager.createPending({
      fileName: result.fileName,
      fileSize: result.size,
      mimeType: result.mimeType || 'application/octet-stream',
      tempPath: result.filePath,
      sender,
    });

    const wss = req.app.get('wss');
    if (wss) {
      broadcastEvent(wss, 'upload:request', { pending: record });
    }

    res.json({
      success: true,
      data: {
        fileName: result.fileName,
        size: result.size,
        duration: result.duration,
        averageSpeed: result.averageSpeed,
        pending: record,
        transferId: record.transferId,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/upload/pending
 * Returns list of pending file transfers awaiting PC user approval.
 */
transferRouter.get('/api/upload/pending', requireHost, (req, res) => {
  res.json({
    success: true,
    data: req.app.locals.runtime.pendingUploadManager.listPending(),
  });
});

/**
 * POST /api/upload/decision
 * PC user accepts or declines a pending upload.
 */
transferRouter.post('/api/upload/decision', requireHost, async (req, res, next) => {
  try {
    const { transferId, action } = req.body || {};
    if (!transferId || !action) {
      throw new AppError('INVALID_INPUT', 400, 'transferId and action are required');
    }

    const wss = req.app.get('wss');

    if (action === 'accept') {
      const accepted = await req.app.locals.runtime.pendingUploadManager.accept(transferId);
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
      const declined = await req.app.locals.runtime.pendingUploadManager.decline(transferId);
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
