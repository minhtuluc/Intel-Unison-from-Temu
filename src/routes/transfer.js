/**
 * Transfer Routes
 * Handles streaming downloads with Range header (206 Partial Content),
 * simple uploads (<100MB), and chunked uploads (up to 10GB).
 */

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { broadcastEvent, sendTransferTerminalEvent } from '../websocket/handlers.js';
import { AppError } from '../middleware/error-handler.js';
import { parseRange, reserveWritableFile } from '../utils/file-utils.js';
import { requireHost } from '../middleware/host-auth.js';
import { extractSessionToken } from '../middleware/session-auth.js';

export const transferRouter = Router();

/**
 * Resolves and strictly validates sender attribution from request headers/body against
 * observed connection state. Throws 403 INVALID_CONNECTION_ID if connectionId is spoofed
 * or belongs to a different socket IP / session.
 * @param {import('express').Request} req
 */
function resolveSender(req) {
  const connectionId = req.headers['x-connection-id'] || req.body?.connectionId || null;
  const rawReqIp = req.ip || req.socket?.remoteAddress || 'unknown';
  const cleanReqIp = rawReqIp.replace(/^::ffff:/, '');

  if (connectionId) {
    const wss = req.app.get('wss') || req.app.locals.runtime?.wss;
    if (wss && wss.clients) {
      let matchedClient = null;
      for (const client of wss.clients) {
        if (client.connectionId === connectionId) {
          matchedClient = client;
          break;
        }
      }
      if (!matchedClient) {
        throw new AppError('INVALID_CONNECTION_ID', 403, 'Connection ID not found or expired');
      }

      const clientIp = (matchedClient._remoteIp || '').replace(/^::ffff:/, '');
      if (clientIp && cleanReqIp && cleanReqIp !== 'unknown' && clientIp !== cleanReqIp) {
        throw new AppError('INVALID_CONNECTION_ID', 403, 'Connection ID does not match sender IP');
      }

      // If PIN is required (or socket is bound to a session), verify that session matches
      const isPinRequired =
        req.app.locals.pinRequired ?? req.app.locals.runtime?.pinRequired ?? false;
      const hostAuth = req.app.locals.hostAuth || req.app.locals.runtime?.hostAuth;
      const hostToken = req.headers['x-host-token'];
      const isHostReq = Boolean(hostToken && hostAuth?.validate(hostToken));

      if (!isHostReq && (isPinRequired || matchedClient.sessionToken)) {
        const reqToken = extractSessionToken(req);
        if (!reqToken || !matchedClient.sessionToken || matchedClient.sessionToken !== reqToken) {
          throw new AppError(
            'INVALID_CONNECTION_ID',
            403,
            'Connection ID belongs to a different session'
          );
        }
      }
    }
  }

  return {
    connectionId,
    ip: rawReqIp,
    label: req.headers['x-device-name'] || req.body?.deviceName || 'Unknown device',
    labelUntrusted: true,
    platform: req.headers['x-platform'] || req.body?.platform || 'unknown',
  };
}

/**
 * Custom Multer storage engine that streams files to pending staging area while atomically
 * enforcing quota reservations on each incoming byte and tracking created files for transaction rollback.
 */
class SimpleUploadQuotaStorage {
  async _handleFile(req, file, cb) {
    const runtime = req.app.locals.runtime;
    const pendingDir = path.join(runtime.config.tempDir, 'pending');

    let reserved;
    try {
      reserved = await reserveWritableFile(pendingDir, file.originalname || 'unnamed');
    } catch (err) {
      return cb(err);
    }

    const { fileName: finalName, filePath: finalPath, fileHandle } = reserved;

    req._createdFiles = req._createdFiles || [];
    const fileRecord = { path: finalPath, size: 0, reservedQuota: 0, fileHandle };
    req._createdFiles.push(fileRecord);

    const outStream = fileHandle.createWriteStream();
    let bytesWritten = 0;
    let aborted = false;

    file.stream.on('data', (chunk) => {
      bytesWritten += chunk.length;
      fileRecord.size = bytesWritten;
      if (runtime.quotaTracker) {
        try {
          runtime.quotaTracker.reserve(chunk.length);
          fileRecord.reservedQuota += chunk.length;
        } catch (quotaErr) {
          aborted = true;
          file.stream.unpipe?.();
          file.stream.destroy?.();
          outStream.destroy(quotaErr);
        }
      }
    });

    file.stream.on('error', (err) => {
      if (!aborted) {
        outStream.destroy(err);
      }
    });

    outStream.on('error', (err) => {
      cb(err);
    });

    outStream.on('finish', () => {
      if (aborted) return;
      cb(null, {
        destination: pendingDir,
        filename: finalName,
        path: finalPath,
        size: bytesWritten,
      });
    });

    file.stream.pipe(outStream);
  }

  _removeFile(req, file, cb) {
    if (file && file.path) {
      fs.unlink(file.path, cb);
    } else {
      cb(null);
    }
  }
}

const simpleUploadStorage = new SimpleUploadQuotaStorage();

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

/** Parses simple multipart uploads, enforces atomic concurrency slot and quota with batch rollback. */
function parseSimpleUpload(req, res, next) {
  const runtime = req.app.locals.runtime;
  if (runtime.getActiveTransferCount() >= runtime.config.maxConcurrentTransfers) {
    return next(
      new AppError(
        'TOO_MANY_TRANSFERS',
        429,
        `Maximum concurrent transfers (${runtime.config.maxConcurrentTransfers}) reached. Try again later.`
      )
    );
  }

  // Pre-claim transfer slot before Multer parses and buffers body
  runtime.inFlightSimpleUploads++;
  let slotReleased = false;
  const releaseSlot = () => {
    if (!slotReleased) {
      slotReleased = true;
      runtime.inFlightSimpleUploads = Math.max(0, runtime.inFlightSimpleUploads - 1);
    }
  };

  const cleanupCreatedFiles = async () => {
    if (req._createdFiles && req._createdFiles.length > 0) {
      const filesToClean = [...req._createdFiles];
      req._createdFiles = [];
      for (const item of filesToClean) {
        if (item.fileHandle) {
          try {
            await item.fileHandle.close();
          } catch {
            // ignore handle close failure
          }
        }
        try {
          if (fs.existsSync(item.path)) {
            await fs.promises.unlink(item.path);
          }
        } catch {
          // ignore unlink failure
        }
        if (runtime.quotaTracker && item.reservedQuota > 0) {
          runtime.quotaTracker.release(item.reservedQuota);
          item.reservedQuota = 0;
        }
      }
    }
  };

  res.on('finish', releaseSlot);
  res.on('close', async () => {
    releaseSlot();
    if (!res.writableEnded) {
      await cleanupCreatedFiles();
    }
  });

  const contentLength = Number(req.headers['content-length'] || 0);
  if (runtime.quotaTracker && contentLength > 0) {
    const stats = runtime.quotaTracker.getStats();
    if (contentLength > stats.available) {
      releaseSlot();
      return next(
        new AppError(
          'STORAGE_QUOTA_EXCEEDED',
          507,
          `Storage quota exceeded: required ${contentLength} bytes, available ${stats.available} bytes`
        )
      );
    }
  }

  const limit = Math.min(runtime.config.maxFileSize, SIMPLE_UPLOAD_CEILING);
  simpleUploadFor(runtime).array('files')(req, res, async (err) => {
    if (!err) return next();

    releaseSlot();
    await cleanupCreatedFiles();

    if (err.code === 'LIMIT_FILE_SIZE') {
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
  const runtime = req.app.locals.runtime;
  try {
    const files = req.files || [];
    if (files.length === 0) {
      throw new AppError('NO_FILES_UPLOADED', 400, 'No files provided in upload');
    }

    // Sender attribution is strictly verified against active connection and remote IP
    const sender = resolveSender(req);

    const uploaded = [];
    const pending = [];
    const wss = req.app.get('wss');

    for (const f of files) {
      const record = runtime.pendingUploadManager.createPending({
        fileName: f.originalname || f.filename,
        fileSize: f.size,
        mimeType: f.mimetype,
        tempPath: f.path,
        sender,
        quotaAlreadyReserved: true,
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
    if (req.files && Array.isArray(req.files)) {
      for (const f of req.files) {
        try {
          if (fs.existsSync(f.path)) await fs.promises.unlink(f.path);
        } catch {
          // ignore unlink failure
        }
        if (runtime.quotaTracker) runtime.quotaTracker.release(f.size);
      }
    }
    next(error);
  }
});

/**
 * POST /api/upload/init
 * Initializes a chunked upload session for large files.
 */
transferRouter.post('/api/upload/init', async (req, res, next) => {
  try {
    const runtime = req.app.locals.runtime;
    if (runtime.getActiveTransferCount() >= runtime.config.maxConcurrentTransfers) {
      throw new AppError(
        'TOO_MANY_TRANSFERS',
        429,
        `Maximum concurrent transfers (${runtime.config.maxConcurrentTransfers}) reached. Try again later.`
      );
    }

    const sender = resolveSender(req);

    const { fileName, fileSize, mimeType, checksum } = req.body || {};
    const result = await runtime.chunkedUploadManager.initUpload({
      fileName,
      fileSize,
      mimeType,
      checksum,
    });

    const session = runtime.chunkedUploadManager.sessions.get(result.uploadId);
    if (session) {
      session.sender = sender;
    }

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
 * POST /api/upload/cancel
 * Client cancels an active chunked upload session and cleans up temporary chunks.
 */
transferRouter.post('/api/upload/cancel', async (req, res, next) => {
  try {
    const { uploadId } = req.body || {};
    if (!uploadId) {
      throw new AppError('INVALID_INPUT', 400, 'uploadId is required');
    }

    const cancelled = await req.app.locals.runtime.chunkedUploadManager.cancelUpload(uploadId);
    res.json({
      success: true,
      data: { uploadId, cancelled },
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
    const existingOutcome = runtime.chunkedUploadManager.getCompletedOutcome(uploadId);
    if (existingOutcome && existingOutcome.pending) {
      return res.json({
        success: true,
        data: {
          fileName: existingOutcome.fileName,
          size: existingOutcome.size,
          duration: existingOutcome.duration,
          averageSpeed: existingOutcome.averageSpeed,
          pending: existingOutcome.pending,
          transferId: existingOutcome.transferId,
        },
      });
    }

    const pendingDir = path.join(runtime.config.tempDir, 'pending');
    const result = await runtime.chunkedUploadManager.complete(uploadId, pendingDir);
    if (result.pending) {
      return res.json({
        success: true,
        data: {
          fileName: result.fileName,
          size: result.size,
          duration: result.duration,
          averageSpeed: result.averageSpeed,
          pending: result.pending,
          transferId: result.transferId,
        },
      });
    }

    let sender;
    if (req.headers['x-connection-id'] || req.body?.connectionId) {
      sender = resolveSender(req);
    } else {
      sender = result.sender || resolveSender(req);
    }

    const record = runtime.pendingUploadManager.createPending({
      fileName: result.fileName,
      fileSize: result.size,
      mimeType: result.mimeType || 'application/octet-stream',
      tempPath: result.filePath,
      sender,
      quotaAlreadyReserved: true,
    });

    const outcomeData = {
      fileName: result.fileName,
      size: result.size,
      duration: result.duration,
      averageSpeed: result.averageSpeed,
      pending: record,
      transferId: record.transferId,
      filePath: result.filePath,
    };

    runtime.chunkedUploadManager.recordCompletedOutcome(uploadId, outcomeData);

    const wss = req.app.get('wss');
    if (wss) {
      broadcastEvent(wss, 'upload:request', { pending: record });
    }

    res.json({
      success: true,
      data: {
        fileName: outcomeData.fileName,
        size: outcomeData.size,
        duration: outcomeData.duration,
        averageSpeed: outcomeData.averageSpeed,
        pending: outcomeData.pending,
        transferId: outcomeData.transferId,
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
 * GET /api/upload/pending/:transferId
 * Returns the status or outcome of a specific transfer (pending, completed, rejected, expired).
 */
transferRouter.get('/api/upload/pending/:transferId', (req, res) => {
  const status = req.app.locals.runtime.pendingUploadManager.getTransferStatus(
    req.params.transferId
  );
  if (!status) {
    throw new AppError('TRANSFER_NOT_FOUND', 404, `Transfer ${req.params.transferId} not found`);
  }
  res.json({
    success: true,
    data: status,
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

    const runtime = req.app.locals.runtime;
    const wss = req.app.get('wss');
    const record = runtime.pendingUploadManager.getTransferRecord(transferId);
    const sender = record?.sender || null;

    if (action === 'accept') {
      const accepted = await runtime.pendingUploadManager.accept(transferId);
      if (wss) {
        sendTransferTerminalEvent(
          wss,
          'transfer:complete',
          {
            transferId,
            fileName: accepted.fileName,
            size: accepted.size,
          },
          sender
        );
      }
      return res.json({
        success: true,
        data: accepted,
      });
    }

    if (action === 'decline') {
      const declined = await runtime.pendingUploadManager.decline(transferId);
      if (wss) {
        sendTransferTerminalEvent(
          wss,
          'transfer:rejected',
          {
            transferId,
            reason: 'REJECTED_BY_PC',
          },
          sender
        );
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
