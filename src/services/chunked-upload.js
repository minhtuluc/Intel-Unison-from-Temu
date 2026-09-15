/**
 * Chunked Upload Manager
 * Handles multi-gigabyte chunked file uploads (up to 10GB) with resume support.
 * Conforms to performance rule: Uses streaming chunk concatenation to keep RAM < 256MB.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { DEFAULT_CONFIG } from '../config.js';
import { generateUploadId } from '../utils/id-generator.js';
import { sanitizeFileName, formatFileSize, reserveWritableFile } from '../utils/file-utils.js';
import { AppError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';

export class ChunkedUploadManager {
  constructor(customConfig = DEFAULT_CONFIG) {
    this.config = customConfig || DEFAULT_CONFIG;
    this.tempDir = path.join(this.config.tempDir, 'chunks');
    /** @type {Map<string, object>} */
    this.sessions = new Map();
    /** @type {Map<string, object>} uploadId -> completion outcome */
    this.completedOutcomes = new Map();
    this.completedOutcomesLimit = 200;
  }

  getCompletedOutcome(uploadId) {
    return this.completedOutcomes.get(uploadId) || null;
  }

  recordCompletedOutcome(uploadId, outcome) {
    if (this.completedOutcomes.size >= this.completedOutcomesLimit) {
      const oldestKey = this.completedOutcomes.keys().next().value;
      this.completedOutcomes.delete(oldestKey);
    }
    this.completedOutcomes.set(uploadId, outcome);
  }

  /**
   * Initializes a chunked upload session.
   * @param {{ fileName: string, fileSize: number, mimeType?: string }} params
   * @returns {Promise<{ uploadId: string, chunkSize: number, totalChunks: number, expiresAt: string }>}
   */
  async initUpload({ fileName, fileSize, mimeType = null, checksum = null }) {
    await this.cleanup();

    const maxSessions =
      this.config.maxUploadSessions ??
      this.config.maxSessions ??
      this.config.maxConcurrentTransfers ??
      10;
    if (this.sessions.size >= maxSessions) {
      throw new AppError(
        'TOO_MANY_SESSIONS',
        429,
        `Maximum concurrent upload sessions (${maxSessions}) reached. Try again later.`
      );
    }

    if (!fileName || typeof fileName !== 'string') {
      throw new AppError('INVALID_INPUT', 400, 'fileName must be provided');
    }

    const size = Number(fileSize);
    if (!Number.isInteger(size) || size <= 0) {
      throw new AppError('INVALID_FILE_SIZE', 400, 'fileSize must be a positive integer');
    }

    if (size > this.config.maxFileSize) {
      throw new AppError(
        'FILE_TOO_LARGE',
        413,
        `File exceeds maximum allowed size (${formatFileSize(this.config.maxFileSize)})`
      );
    }

    if (!checksum || typeof checksum !== 'string' || !/^[a-fA-F0-9]{64}$/.test(checksum)) {
      throw new AppError(
        'INVALID_CHECKSUM',
        400,
        'checksum must be a valid 64-character SHA-256 hex string'
      );
    }
    const normalizedChecksum = checksum.toLowerCase();

    if (this.config.quotaTracker) {
      this.config.quotaTracker.reserve(size);
    }

    const uploadId = generateUploadId();
    const chunkSize = this.config.chunkSize;
    const totalChunks = Math.ceil(size / chunkSize);
    const expiresAt = Date.now() + this.config.uploadExpiry;
    const sessionDir = path.join(this.tempDir, uploadId);

    // Create session temp directory
    try {
      await fs.promises.mkdir(sessionDir, { recursive: true });
    } catch (err) {
      if (this.config.quotaTracker) {
        this.config.quotaTracker.release(size);
      }
      throw err;
    }

    const session = {
      uploadId,
      status: 'uploading', // 'uploading' | 'completing' | 'completed' | 'cancelled'
      fileName: sanitizeFileName(fileName),
      fileSize: size,
      mimeType: mimeType || 'application/octet-stream',
      expectedChecksum: normalizedChecksum,
      chunkSize,
      totalChunks,
      receivedChunks: new Set(),
      createdAt: Date.now(),
      expiresAt,
      sessionDir,
    };

    this.sessions.set(uploadId, session);

    logger.info('Initialized chunked upload session', {
      uploadId,
      name: session.fileName,
      totalChunks,
      size,
    });

    return {
      uploadId,
      chunkSize,
      totalChunks,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * Adds an uploaded chunk to the session's staging directory.
   * @param {string} uploadId
   * @param {number} chunkIndex
   * @param {Buffer} chunkBuffer
   * @param {string} [checksum] Optional SHA-256 hex digest
   * @returns {Promise<{ chunkIndex: number, receivedChunks: number, totalChunks: number, progress: number }>}
   */
  async addChunk(uploadId, chunkIndex, chunkBuffer, checksum = null) {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new AppError('UPLOAD_EXPIRED', 410, 'Upload session not found or has expired');
    }

    if (session.status === 'completing') {
      throw new AppError(
        'TRANSFER_IN_PROGRESS',
        409,
        `Upload ${uploadId} is currently being completed`
      );
    }
    if (session.status === 'completed') {
      throw new AppError('ALREADY_COMPLETED', 409, `Upload ${uploadId} has already been completed`);
    }
    if (session.status === 'cancelled') {
      throw new AppError('UPLOAD_CANCELLED', 409, `Upload ${uploadId} was cancelled`);
    }
    if (session.status !== 'uploading') {
      throw new AppError('INVALID_STATE', 409, `Session in state ${session.status}`);
    }

    const idx = Number(chunkIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= session.totalChunks) {
      throw new AppError(
        'CHUNK_INVALID',
        400,
        `Invalid chunkIndex: ${chunkIndex}. Must be 0 <= index < ${session.totalChunks}`
      );
    }

    if (!chunkBuffer || !Buffer.isBuffer(chunkBuffer) || chunkBuffer.length === 0) {
      throw new AppError('CHUNK_INVALID', 400, 'Chunk data is empty or invalid');
    }

    // Verify chunk byte length against expected slice size
    const isLastChunk = idx === session.totalChunks - 1;
    const expectedSize = isLastChunk
      ? session.fileSize - (session.totalChunks - 1) * session.chunkSize
      : session.chunkSize;

    if (chunkBuffer.length !== expectedSize) {
      throw new AppError(
        'CHUNK_SIZE_MISMATCH',
        400,
        `Chunk ${idx} length ${chunkBuffer.length} does not match expected length ${expectedSize}`
      );
    }

    // Verify optional SHA-256 chunk checksum if provided
    if (checksum && typeof checksum === 'string') {
      const actualChecksum = crypto.createHash('sha256').update(chunkBuffer).digest('hex');
      if (actualChecksum.toLowerCase() !== checksum.toLowerCase()) {
        throw new AppError('CHECKSUM_MISMATCH', 400, `Checksum mismatch for chunk ${idx}`);
      }
    }

    // Write chunk to isolated temporary file
    const chunkPath = path.join(session.sessionDir, `chunk_${idx}`);
    await fs.promises.writeFile(chunkPath, chunkBuffer);

    session.receivedChunks.add(idx);

    const progress = parseFloat(
      ((session.receivedChunks.size / session.totalChunks) * 100).toFixed(1)
    );

    return {
      chunkIndex: idx,
      receivedChunks: session.receivedChunks.size,
      totalChunks: session.totalChunks,
      progress,
    };
  }

  /**
   * Retrieves upload status to support resuming interrupted transfers.
   * @param {string} uploadId
   */
  getStatus(uploadId) {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new AppError('UPLOAD_EXPIRED', 410, 'Upload session not found or has expired');
    }

    const receivedArray = Array.from(session.receivedChunks).sort((a, b) => a - b);
    let nextChunk = 0;
    while (session.receivedChunks.has(nextChunk) && nextChunk < session.totalChunks) {
      nextChunk++;
    }

    const progress = parseFloat(
      ((session.receivedChunks.size / session.totalChunks) * 100).toFixed(1)
    );

    return {
      uploadId: session.uploadId,
      fileName: session.fileName,
      totalChunks: session.totalChunks,
      receivedChunks: receivedArray,
      nextChunk: nextChunk < session.totalChunks ? nextChunk : null,
      progress,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  /**
   * Reassembles chunks into final file in upload directory and cleans up temp chunks.
   * Streams chunk files sequentially into destination file to minimize memory usage.
   * @param {string} uploadId
   * @param {string} [targetDir] Destination directory
   * @returns {Promise<{ fileName: string, filePath: string, size: number, mimeType: string, duration: number, averageSpeed: string }>}
   */
  async complete(uploadId, targetDir = this.config.uploadDir) {
    if (this.completedOutcomes.has(uploadId)) {
      return { ...this.completedOutcomes.get(uploadId), alreadyCompleted: true };
    }

    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new AppError('UPLOAD_EXPIRED', 410, 'Upload session not found or has expired');
    }

    if (session.status === 'completing') {
      throw new AppError(
        'TRANSFER_IN_PROGRESS',
        409,
        `Upload ${uploadId} is currently being completed`
      );
    }
    if (session.status === 'completed') {
      if (this.completedOutcomes.has(uploadId)) {
        return { ...this.completedOutcomes.get(uploadId), alreadyCompleted: true };
      }
      throw new AppError('ALREADY_COMPLETED', 409, `Upload ${uploadId} has already been completed`);
    }
    if (session.status === 'cancelled') {
      throw new AppError('UPLOAD_CANCELLED', 409, `Upload ${uploadId} was cancelled`);
    }
    if (session.status !== 'uploading') {
      throw new AppError('INVALID_STATE', 409, `Session in state ${session.status}`);
    }

    if (session.receivedChunks.size < session.totalChunks) {
      throw new AppError(
        'CHUNK_MISSING',
        400,
        `Cannot complete upload. Received ${session.receivedChunks.size} of ${session.totalChunks} chunks.`
      );
    }

    // Atomically transition state
    session.status = 'completing';

    // Ensure target directory exists and reserve non-colliding destination file exclusively
    const {
      fileName: finalFileName,
      filePath: finalPath,
      fileHandle,
    } = await reserveWritableFile(targetDir, session.fileName);
    const writeStream = fileHandle.createWriteStream();
    const hasher = session.expectedChecksum ? crypto.createHash('sha256') : null;

    try {
      for (let i = 0; i < session.totalChunks; i++) {
        if (session.status === 'cancelled') {
          throw new AppError('UPLOAD_CANCELLED', 409, `Upload ${uploadId} was cancelled`);
        }
        const chunkPath = path.join(session.sessionDir, `chunk_${i}`);
        const readStream = fs.createReadStream(chunkPath);
        if (hasher) {
          readStream.on('data', (chunk) => hasher.update(chunk));
        }
        await pipeline(readStream, writeStream, { end: false });
      }

      // Close write stream
      await new Promise((resolve, reject) => {
        writeStream.end((err) => (err ? reject(err) : resolve()));
      });

      // Integrity check 1: verify reassembled size equals declared fileSize
      const stat = await fs.promises.stat(finalPath);
      if (stat.size !== session.fileSize) {
        throw new AppError(
          'FILE_CORRUPTED',
          500,
          `Reassembled file size (${stat.size}) does not match expected size (${session.fileSize})`
        );
      }

      // Integrity check 2: verify SHA-256 if expectedChecksum was provided
      if (hasher && session.expectedChecksum) {
        const actualChecksum = hasher.digest('hex');
        if (actualChecksum.toLowerCase() !== session.expectedChecksum.toLowerCase()) {
          throw new AppError(
            'CHECKSUM_MISMATCH',
            400,
            `File checksum mismatch: expected ${session.expectedChecksum}, got ${actualChecksum}`
          );
        }
      }

      session.status = 'completed';
    } catch (err) {
      try {
        await fs.promises.unlink(finalPath);
      } catch {
        // Ignore unlink error
      }
      if (err.code === 'CHECKSUM_MISMATCH' || err.code === 'FILE_CORRUPTED') {
        await fs.promises.rm(session.sessionDir, { recursive: true, force: true }).catch(() => {});
        this.sessions.delete(uploadId);
        if (this.config.quotaTracker) {
          this.config.quotaTracker.release(session.fileSize);
        }
      } else if (session.status !== 'cancelled') {
        session.status = 'uploading'; // Allow retry if transient disk error
      }
      throw err;
    }

    // Cleanup session temporary chunks directory (best-effort, recoverable)
    try {
      await fs.promises.rm(session.sessionDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      logger.warn('Failed to clean up chunk session directory (best-effort)', {
        uploadId,
        sessionDir: session.sessionDir,
        error: cleanupErr.message,
      });
    }
    this.sessions.delete(uploadId);
    if (this.config.quotaTracker) {
      this.config.quotaTracker.release(session.fileSize);
    }

    const duration = Math.max(0.1, (Date.now() - session.createdAt) / 1000);
    const speedMBs = (session.fileSize / (1024 * 1024) / duration).toFixed(1);

    logger.info('Chunked upload completed successfully', {
      uploadId,
      fileName: finalFileName,
      size: session.fileSize,
      duration,
      speed: `${speedMBs} MB/s`,
    });

    const completionResult = {
      fileName: finalFileName,
      filePath: finalPath,
      size: session.fileSize,
      mimeType: session.mimeType,
      duration: parseFloat(duration.toFixed(1)),
      averageSpeed: `${speedMBs} MB/s`,
    };

    this.recordCompletedOutcome(uploadId, completionResult);

    return completionResult;
  }

  /**
   * Cancels an active chunked upload session and immediately removes temp files.
   * @param {string} uploadId
   * @returns {Promise<boolean>}
   */
  async cancelUpload(uploadId) {
    const session = this.sessions.get(uploadId);
    if (!session) {
      return false;
    }

    if (session.status === 'completing') {
      throw new AppError(
        'TRANSFER_IN_PROGRESS',
        409,
        `Cannot cancel upload ${uploadId} while completion is in progress`
      );
    }

    session.status = 'cancelled';
    this.sessions.delete(uploadId);
    if (this.config.quotaTracker) {
      this.config.quotaTracker.release(session.fileSize);
    }
    try {
      await fs.promises.rm(session.sessionDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }

    logger.info('Cancelled chunked upload session', { uploadId, name: session.fileName });
    return true;
  }

  /**
   * Cleans up expired upload sessions and removes abandoned chunk directories.
   */
  async cleanup() {
    const now = Date.now();
    for (const [uploadId, session] of this.sessions.entries()) {
      if (session.status === 'completing') {
        continue; // Do not interrupt in-progress completion
      }
      if (now > session.expiresAt) {
        logger.warn('Cleaning up expired upload session', { uploadId, name: session.fileName });
        try {
          await fs.promises.rm(session.sessionDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
        if (this.config.quotaTracker) {
          this.config.quotaTracker.release(session.fileSize);
        }
        this.sessions.delete(uploadId);
      }
    }
  }

  /**
   * Sweeps orphaned chunk session directories from tempDir/chunks that are not tracked in this.sessions
   * and are older than olderThanMs.
   * @param {number} [olderThanMs] Defaults to config.uploadExpiry
   */
  async sweepOrphans(olderThanMs = this.config.uploadExpiry) {
    try {
      const entries = await fs.promises.readdir(this.tempDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!this.sessions.has(entry.name)) {
          const fullPath = path.join(this.tempDir, entry.name);
          try {
            const stat = await fs.promises.stat(fullPath);
            if (olderThanMs <= 0 || Date.now() - stat.mtimeMs >= olderThanMs) {
              await fs.promises.rm(fullPath, { recursive: true, force: true });
              logger.info('Swept orphaned chunk session directory', { dir: entry.name });
            }
          } catch {
            // Ignore stat/rm errors
          }
        }
      }
    } catch {
      // Ignore if this.tempDir doesn't exist yet
    }
  }
}
