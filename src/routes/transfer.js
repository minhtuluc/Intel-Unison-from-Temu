/**
 * Transfer Routes
 * Handles streaming downloads with Range header (206 Partial Content),
 * simple uploads (<100MB), and chunked uploads (up to 10GB).
 */

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { broadcastEvent, sendTransferTerminalEvent } from '../websocket/handlers.js';
import { AppError } from '../middleware/error-handler.js';
import { parseRange, reserveWritableFile, atomicMove } from '../utils/file-utils.js';
import { requireHost } from '../middleware/host-auth.js';
import { extractSessionToken } from '../middleware/session-auth.js';
import { requireTransferGrant, assertGrantsMatchFiles } from '../middleware/transfer-grant.js';
import { assertDownloadAllowed } from '../middleware/download-acl.js';
import { hashDeviceToken } from '../services/trusted-devices.js';
import { resolveSender } from '../utils/connection-identity.js';

export const transferRouter = Router();

/**
 * Moves a finished relay upload into the relay staging area and registers it for its
 * receiver. Relayed bytes never enter the host's receive directory, and the file carries
 * an ACL so only the addressed receiver can fetch it (UT-022).
 * @param {object} runtime
 * @param {{ path: string, name: string, size: number, mimeType?: string|null }} file
 * @param {{ relayId: string, fileIndex: number }} grant relay grant issued by the receiver
 * @returns {Promise<object>} public metadata of the stored file
 */
async function storeRelayFile(runtime, { path: tempPath, name, size, mimeType }, grant) {
  const relayDir = path.join(runtime.config.tempDir, 'relay');
  const moved = await atomicMove(tempPath, relayDir, name);
  const acl = runtime.relayService.getFileAcl(grant.relayId, grant.fileIndex);
  const meta = await runtime.shareManager.addFile(moved.filePath, name, true, { acl });
  runtime.relayService.attachStoredFile({
    relayId: grant.relayId,
    fileIndex: grant.fileIndex,
    fileId: meta.id,
    size,
    name,
    mimeType: mimeType || null,
  });
  return meta;
}

function hashUploadToken(token) {
  return crypto.createHash('sha256').update(token).digest();
}

function hasValidUploadToken(req, session) {
  const token = req.headers['x-upload-token'];
  if (typeof token !== 'string' || !session?.ownerTokenHash) return false;
  const actual = hashUploadToken(token);
  const expected = Buffer.from(session.ownerTokenHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
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

/** Device tokens are client-generated; the server only ever compares stored hashes. */
function readDeviceToken(req) {
  const token = req.headers['x-device-token'];
  return typeof token === 'string' && token ? token : null;
}

/**
 * Decision payload shared by the HTTP response and the WebSocket event, so a sender
 * sees the same result whether it learned it by event or by polling.
 * @param {import('../services/transfer-offer.js').TransferOfferService} offerService
 * @param {object} offer
 * @param {boolean} autoApproved
 */
function buildOfferDecisionPayload(offerService, offer, autoApproved) {
  const grantByIndex = new Map(
    offerService.getGrantsForOffer(offer.offerId).map((grant) => [grant.index, grant.grantId])
  );
  return {
    offerId: offer.offerId,
    autoApproved: Boolean(autoApproved),
    decisions: offer.files.map((file) => ({
      index: file.index,
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
      decision: file.decision,
      grantId: grantByIndex.get(file.index) || null,
    })),
  };
}

/**
 * Verifies that the caller is authorized to view or mutate an active/completed chunk session.
 * Only host authority or the verified session/connection owner may access it (M3-QC-R2-02).
 *
 * @param {import('express').Request} req
 * @param {object} session
 * @throws {AppError} 403 UPLOAD_FORBIDDEN if caller is neither host nor the session owner
 */
export function assertChunkSessionOwner(req, session) {
  if (!session) return;

  const hostAuth = req.app.locals.hostAuth || req.app.locals.runtime?.hostAuth;
  const isHost = Boolean(hostAuth?.verify(req, req.headers['x-host-token']));
  if (isHost) return;
  const isPinRequired = req.app.locals.pinRequired ?? req.app.locals.runtime?.pinRequired ?? false;
  if (!isPinRequired && hasValidUploadToken(req, session)) return;
  if (!session.sender) {
    throw new AppError('UPLOAD_FORBIDDEN', 403, 'Upload session has no verified owner');
  }

  const caller = resolveSender(req);
  const reqToken = extractSessionToken(req);
  const sessions = req.app.locals.sessions || req.app.locals.runtime?.sessions;

  const ownerSender = session.sender;
  if (isPinRequired || ownerSender.sessionToken || reqToken) {
    const sessionMatch = Boolean(
      reqToken && ownerSender.sessionToken && reqToken === ownerSender.sessionToken
    );
    const sessionConnMatch = Boolean(
      reqToken &&
      ownerSender.connectionId &&
      sessions?.hasConnection?.(reqToken, ownerSender.connectionId)
    );
    if (!sessionMatch && !sessionConnMatch) {
      throw new AppError('UPLOAD_FORBIDDEN', 403, 'Upload session belongs to another client');
    }
    return;
  }

  // Without PIN, check connection ID
  if (ownerSender.connectionId) {
    if (!caller.connectionId || caller.connectionId !== ownerSender.connectionId) {
      throw new AppError('UPLOAD_FORBIDDEN', 403, 'Upload session belongs to another connection');
    }
    return;
  }

  throw new AppError('UPLOAD_FORBIDDEN', 403, 'Upload capability is required');
}

/** Authorizes a chunk request before Multer can buffer any attacker-controlled bytes. */
function requireChunkSessionOwner(req, res, next) {
  try {
    const uploadId = req.headers['x-upload-id'];
    if (typeof uploadId !== 'string' || !uploadId) {
      throw new AppError('UPLOAD_ID_REQUIRED', 400, 'X-Upload-Id header is required');
    }
    const session = req.app.locals.runtime.chunkedUploadManager.sessions.get(uploadId);
    if (!session) {
      throw new AppError('UPLOAD_EXPIRED', 410, 'Upload session not found or has expired');
    }
    assertChunkSessionOwner(req, session);
    req.authorizedUploadId = uploadId;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/transfer/offer
 * Declares a batch the sender intends to upload. No payload moves yet: the host
 * reviews name/size/type and decides per file. A remembered device is approved
 * immediately, but the offer is still recorded so the host can see what arrived.
 */
transferRouter.post('/api/transfer/offer', async (req, res, next) => {
  try {
    const runtime = req.app.locals.runtime;
    const sender = resolveSender(req, { required: true });
    const deviceToken = readDeviceToken(req);
    const trusted = Boolean(deviceToken && runtime.trustedDevices.isTrusted(deviceToken));
    const reqToken = extractSessionToken(req);
    if (reqToken) sender.sessionToken = reqToken;
    if (deviceToken) sender.deviceTokenHash = hashDeviceToken(deviceToken);

    const { offer, autoApproved } = runtime.offerService.createOffer({
      files: req.body?.files,
      sender,
      trusted,
    });

    const wss = req.app.get('wss');
    const sanitized = runtime.offerService.sanitize(offer);
    if (wss) {
      broadcastEvent(wss, 'transfer:offer', {
        offer: sanitized,
        autoApproved: Boolean(autoApproved),
      });
    }

    res.status(201).json({
      success: true,
      data: {
        offer: sanitized,
        autoApproved: Boolean(autoApproved),
        decisions: buildOfferDecisionPayload(runtime.offerService, offer, autoApproved).decisions,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/transfer/offer/:offerId
 * Lets a sender that missed the WebSocket event read the host's decision.
 */
transferRouter.get('/api/transfer/offer/:offerId', (req, res, next) => {
  try {
    const runtime = req.app.locals.runtime;
    const offer = runtime.offerService.getOffer(req.params.offerId);
    if (!offer) {
      throw new AppError('OFFER_NOT_FOUND', 404, `Offer ${req.params.offerId} not found`);
    }

    const hostAuth = req.app.locals.hostAuth || runtime.hostAuth;
    const isHost = Boolean(hostAuth?.verify(req, req.headers['x-host-token']));

    if (!isHost && offer.sender?.connectionId) {
      const sender = resolveSender(req, { required: true });
      const reqToken = extractSessionToken(req);
      const sessions = req.app.locals.sessions || runtime.sessions;
      const isOwnerConn = offer.sender.connectionId === sender.connectionId;
      const isOwnerSession = Boolean(
        reqToken &&
        ((offer.sender.sessionToken && offer.sender.sessionToken === reqToken) ||
          sessions?.hasConnection?.(reqToken, offer.sender.connectionId))
      );
      if (!isOwnerConn && !isOwnerSession) {
        throw new AppError('OFFER_FORBIDDEN', 403, 'Offer belongs to another connection');
      }
    }

    res.json({
      success: true,
      data: {
        offer: runtime.offerService.sanitize(offer),
        decisions: buildOfferDecisionPayload(runtime.offerService, offer, offer.trusted).decisions,
      },
    });
  } catch (error) {
    next(error);
  }
});

/** POST /api/transfer/offer/cancel — sender abandons the batch before the host acts. */
transferRouter.post('/api/transfer/offer/cancel', (req, res, next) => {
  try {
    const { offerId } = req.body || {};
    if (!offerId) {
      throw new AppError('INVALID_INPUT', 400, 'offerId is required');
    }
    const hostAuth = req.app.locals.hostAuth || req.app.locals.runtime?.hostAuth;
    const isHost = Boolean(hostAuth?.verify(req, req.headers['x-host-token']));
    const sender = isHost ? { connectionId: null } : resolveSender(req, { required: true });
    const reqToken = extractSessionToken(req);
    const sessions = req.app.locals.sessions || req.app.locals.runtime?.sessions;
    const canceled = req.app.locals.runtime.offerService.cancelOffer(offerId, {
      connectionId: sender.connectionId,
      sessionToken: reqToken,
      isSessionOwner: (offerConnId) =>
        Boolean(reqToken && sessions?.hasConnection?.(reqToken, offerConnId)),
      isHost,
    });
    res.json({ success: true, data: canceled });
  } catch (error) {
    next(error);
  }
});

/** GET /api/transfer/offers — open offers, for the host to re-sync after a reload. */
transferRouter.get('/api/transfer/offers', requireHost, (req, res) => {
  res.json({
    success: true,
    data: req.app.locals.runtime.offerService.listPending(),
  });
});

/**
 * POST /api/transfer/offer/decision
 * Host approves or rejects individual files in an offer. Approving issues the
 * single-use grants that authorize the upload.
 */
transferRouter.post('/api/transfer/offer/decision', requireHost, async (req, res, next) => {
  try {
    const { offerId, decisions, trustDevice } = req.body || {};
    if (!offerId) {
      throw new AppError('INVALID_INPUT', 400, 'offerId is required');
    }

    const runtime = req.app.locals.runtime;
    const { offer } = runtime.offerService.decide(offerId, decisions);

    let trustedDevice = null;
    if (trustDevice) {
      const tokenHash = offer.sender?.deviceTokenHash;
      if (!tokenHash) {
        throw new AppError(
          'DEVICE_TOKEN_UNAVAILABLE',
          400,
          'This sender presented no device token, so it cannot be remembered'
        );
      }
      trustedDevice = await runtime.trustedDevices.trustByHash({
        tokenHash,
        label: offer.sender?.label || 'Unknown device',
        platform: offer.sender?.platform || 'unknown',
      });
    }

    const payload = buildOfferDecisionPayload(runtime.offerService, offer, false);

    // A rejected file never reaches the upload pipeline, so nothing else would
    // record it; without this the host's "Decline" leaves no trace at all.
    for (const decision of payload.decisions) {
      if (decision.decision !== 'rejected') continue;
      runtime.history.record({
        status: 'rejected',
        reason: 'REJECTED_BY_PC',
        source: 'offer',
        fileName: decision.name,
        size: decision.size,
        sender: offer.sender,
      });
    }

    const wss = req.app.get('wss');
    if (wss) {
      sendTransferTerminalEvent(wss, 'transfer:offer:decision', payload, offer.sender);
    }

    res.json({
      success: true,
      data: { ...payload, trustedDevice },
    });
  } catch (error) {
    next(error);
  }
});

/** GET /api/devices/trusted — host-facing list; never exposes stored token hashes. */
transferRouter.get('/api/devices/trusted', requireHost, (req, res) => {
  res.json({
    success: true,
    data: req.app.locals.runtime.trustedDevices.list(),
  });
});

/** DELETE /api/devices/trusted/:id — revoke a remembered device. */
transferRouter.delete('/api/devices/trusted/:id', requireHost, async (req, res, next) => {
  try {
    const result = await req.app.locals.runtime.trustedDevices.revoke(req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/download/:fileId
 * Streams a staged file to client with Range header (resume & seeking) support.
 */
transferRouter.get('/api/download/:fileId', async (req, res, next) => {
  try {
    const runtime = req.app.locals.runtime;
    const { fileId } = req.params;
    const fileRecord = runtime.shareManager.getFile(fileId);

    if (!fileRecord) {
      throw new AppError('FILE_NOT_FOUND', 404, `File ${fileId} not found`);
    }

    // A relayed file belongs to one receiver; the host has no bypass here.
    assertDownloadAllowed(req, fileRecord);

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

    // Only a completed full download counts as delivered. A range request (206), a stream
    // error or a client that walks away mid-transfer must not be reported as one, and a
    // file that is already marked stays marked — one event per file (M4-QC-04).
    if (fileRecord.acl?.mode === 'receiver') {
      res.on('finish', () => {
        if (res.statusCode === 200 && res.writableEnded) {
          runtime.relayService.markDownloaded(fileId);
        }
      });
    }

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
transferRouter.post(
  '/api/upload',
  requireTransferGrant(),
  parseSimpleUpload,
  async (req, res, next) => {
    const runtime = req.app.locals.runtime;
    // Files already handed to a relay receiver, keyed by their multer temp path. A later
    // failure in the same batch must take them back, and their quota belongs to the relay
    // service from that point on — releasing it here too would under-count the disk.
    const relayStored = new Map();
    try {
      const files = req.files || [];
      if (files.length === 0) {
        throw new AppError('NO_FILES_UPLOADED', 400, 'No files provided in upload');
      }

      // The gate ran before Multer, so this is what binds the parsed bytes to what
      // the host actually approved: wrong name, wrong size or extra files all fail.
      const pairs = assertGrantsMatchFiles(req, files);

      // A relay grant names the receiver the file belongs to; the host-approved grants
      // do not, and keep flowing down the M3 path unchanged.
      const relayGrants = new Map();
      for (const pair of pairs) {
        if (pair.grant.relayId) relayGrants.set(pair.file, pair.grant);
      }

      // Sender attribution is strictly verified against active connection and remote IP
      const sender = resolveSender(req);
      const consented = Boolean(req.transferGrants?.length);

      const uploaded = [];
      const pending = [];
      const wss = req.app.get('wss');

      for (const f of files) {
        const relayGrant = relayGrants.get(f);
        if (relayGrant) {
          const meta = await storeRelayFile(
            runtime,
            {
              path: f.path,
              name: f.originalname || f.filename,
              size: f.size,
              mimeType: f.mimetype,
            },
            relayGrant
          );
          uploaded.push({
            name: f.originalname || f.filename,
            size: f.size,
            relayId: relayGrant.relayId,
            fileId: meta.id,
            status: 'relayed',
          });
          relayStored.set(f.path, meta.id);
          continue;
        }

        const recordParams = {
          fileName: f.originalname || f.filename,
          fileSize: f.size,
          mimeType: f.mimetype,
          tempPath: f.path,
          sender,
          quotaAlreadyReserved: true,
        };

        if (consented) {
          // Host consent already happened at offer time, so the file goes straight to
          // the receive dir. Asking again here would be the duplicate consent UT-012
          // sets out to remove, and the size already matched the approved manifest.
          const saved = await runtime.pendingUploadManager.createPreApproved(recordParams);
          uploaded.push({
            name: f.filename,
            size: f.size,
            transferId: saved.transferId,
            savedAs: saved.fileName,
            status: 'saved',
          });
          continue;
        }

        const record = runtime.pendingUploadManager.createPending(recordParams);

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
          // Relay files are no longer pending: revokeFile removes them and releases
          // their quota, so the generic rollback must leave them alone.
          if (relayStored.has(f.path)) continue;
          try {
            if (fs.existsSync(f.path)) await fs.promises.unlink(f.path);
          } catch {
            // ignore unlink failure
          }
          if (runtime.quotaTracker) runtime.quotaTracker.release(f.size);
        }
      }
      for (const fileId of relayStored.values()) {
        try {
          runtime.relayService.revokeFile(fileId);
        } catch {
          // A revoke failure must not mask the original error.
        }
      }
      next(error);
    }
  }
);

/**
 * POST /api/upload/init
 * Initializes a chunked upload session for large files.
 */
transferRouter.post('/api/upload/init', requireTransferGrant(), async (req, res, next) => {
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
    const grants = req.transferGrants || [];
    if (grants.length > 1) {
      throw new AppError(
        'GRANT_FILE_COUNT_MISMATCH',
        403,
        'A chunked session is initialized for exactly one approved file'
      );
    }
    const grant = grants[0] || null;
    if (grant) {
      assertGrantsMatchFiles(req, [
        {
          fileName,
          fileSize: Number(fileSize),
          mimeType,
          checksum,
        },
      ]);
    }

    const result = await runtime.chunkedUploadManager.initUpload({
      fileName,
      fileSize,
      mimeType,
      checksum,
      preApproved: Boolean(grant),
    });

    const session = runtime.chunkedUploadManager.sessions.get(result.uploadId);
    const uploadToken = runtime.pinRequired ? null : crypto.randomBytes(32).toString('hex');
    if (session) {
      session.sender = sender;
      // A relay-approved session stores its bytes for the receiver, not in the host's
      // receive directory; the grant is what carries that destination (UT-022).
      if (grant?.relayId) {
        session.relayId = grant.relayId;
        session.relayFileIndex = grant.fileIndex;
      }
      if (uploadToken) session.ownerTokenHash = hashUploadToken(uploadToken).toString('hex');
    }

    res.json({
      success: true,
      data: uploadToken ? { ...result, uploadToken } : result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/upload/chunk
 * Uploads a single chunk of a large file.
 */
transferRouter.post(
  '/api/upload/chunk',
  requireChunkSessionOwner,
  parseChunkUpload,
  async (req, res, next) => {
    try {
      const { uploadId, chunkIndex, checksum } = req.body || {};

      if (!uploadId || chunkIndex === undefined || chunkIndex === null || chunkIndex === '') {
        throw new AppError('INVALID_INPUT', 400, 'uploadId and chunkIndex are required');
      }
      if (uploadId !== req.authorizedUploadId) {
        throw new AppError('UPLOAD_ID_MISMATCH', 400, 'Multipart uploadId must match X-Upload-Id');
      }

      const runtime = req.app.locals.runtime;

      const idx = Number(chunkIndex);
      if (!Number.isInteger(idx) || idx < 0) {
        throw new AppError('INVALID_INPUT', 400, 'chunkIndex must be a non-negative integer');
      }

      if (!req.file || !req.file.buffer) {
        throw new AppError('CHUNK_INVALID', 400, 'No chunk data provided');
      }

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
  }
);

/**
 * GET /api/upload/status/:uploadId
 * Fetches status of chunks received so far to resume after disconnection.
 */
transferRouter.get('/api/upload/status/:uploadId', (req, res, next) => {
  try {
    const { uploadId } = req.params;
    const runtime = req.app.locals.runtime;
    const session = runtime.chunkedUploadManager.sessions.get(uploadId);
    if (session) {
      assertChunkSessionOwner(req, session);
    }
    const status = runtime.chunkedUploadManager.getStatus(uploadId);

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

    const runtime = req.app.locals.runtime;
    const session = runtime.chunkedUploadManager.sessions.get(uploadId);
    if (session) {
      assertChunkSessionOwner(req, session);
    }

    const cancelled = await runtime.chunkedUploadManager.cancelUpload(uploadId);
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
    if (existingOutcome) {
      assertChunkSessionOwner(req, existingOutcome);
      if (existingOutcome.pending) {
        return res.json({
          success: true,
          data: {
            fileName: existingOutcome.fileName,
            size: existingOutcome.size,
            duration: existingOutcome.duration,
            averageSpeed: existingOutcome.averageSpeed,
            pending: existingOutcome.pending,
            transferId: existingOutcome.transferId,
            savedAs: existingOutcome.savedAs || null,
          },
        });
      }
      if (existingOutcome.relay) {
        // Same relay completion retried: report the stored file, do not merge again.
        return res.json({ success: true, data: existingOutcome.relay });
      }
    }

    // Read before completion clears the session: this is the consent the host gave
    // at offer time, and it decides whether a second prompt happens.
    const session = runtime.chunkedUploadManager.sessions.get(uploadId);
    if (session) {
      assertChunkSessionOwner(req, session);
    }
    const preApproved = Boolean(session?.preApproved);
    const relayGrant = session?.relayId
      ? { relayId: session.relayId, fileIndex: session.relayFileIndex }
      : null;

    // A relay-approved session reassembles straight into the relay staging area. The
    // reservation moves to the relay file, which owns it until TTL/revoke (M4-QC-03).
    const targetDir = relayGrant
      ? path.join(runtime.config.tempDir, 'relay')
      : path.join(runtime.config.tempDir, 'pending');
    const result = await runtime.chunkedUploadManager.complete(uploadId, targetDir, {
      releaseQuota: !relayGrant,
    });
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
          savedAs: result.savedAs || null,
        },
      });
    }

    let sender;
    if (req.headers['x-connection-id'] || req.body?.connectionId) {
      sender = resolveSender(req);
    } else {
      sender = result.sender || resolveSender(req);
    }

    if (relayGrant) {
      let meta;
      try {
        meta = await storeRelayFile(
          runtime,
          {
            path: result.filePath,
            name: result.fileName,
            size: result.size,
            mimeType: result.mimeType,
          },
          relayGrant
        );
      } catch (err) {
        // A merged file that could not be registered must not squat in the relay area
        // or keep holding quota: the sender can retry the completion.
        try {
          await fs.promises.unlink(result.filePath);
        } catch {
          // Ignore unlink failure; the sweeper will reclaim it.
        }
        if (runtime.quotaTracker) runtime.quotaTracker.release(result.size);
        throw err;
      }
      const relayOutcome = {
        relayId: relayGrant.relayId,
        fileId: meta.id,
        fileName: result.fileName,
        size: result.size,
        duration: result.duration,
        averageSpeed: result.averageSpeed,
      };
      runtime.chunkedUploadManager.recordCompletedOutcome(uploadId, {
        ...result,
        relay: relayOutcome,
      });
      // The receiver is notified by the relay service; the host is not asked to approve.
      return res.json({ success: true, data: relayOutcome });
    }

    const recordParams = {
      fileName: result.fileName,
      fileSize: result.size,
      mimeType: result.mimeType || 'application/octet-stream',
      tempPath: result.filePath,
      sender,
      quotaAlreadyReserved: true,
    };

    // A consented session already carries the whole-file checksum the client
    // declared and `complete` verified it, so the file can be saved directly.
    const record = preApproved
      ? await runtime.pendingUploadManager.createPreApproved(recordParams)
      : runtime.pendingUploadManager.createPending(recordParams);

    const outcomeData = {
      fileName: result.fileName,
      size: result.size,
      duration: result.duration,
      averageSpeed: result.averageSpeed,
      pending: record,
      transferId: record.transferId,
      savedAs: preApproved ? record.fileName : null,
      filePath: result.filePath,
      sender: session?.sender || result.sender || sender || null,
      ownerTokenHash: session?.ownerTokenHash || result.ownerTokenHash || null,
    };

    runtime.chunkedUploadManager.recordCompletedOutcome(uploadId, outcomeData);

    const wss = req.app.get('wss');
    if (wss && !preApproved) {
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
        savedAs: outcomeData.savedAs,
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
