/**
 * Pending Upload Service
 * Manages uploaded files awaiting PC user approval (Accept / Decline).
 * Includes 5-minute TTL cleanup, collision-safe moving to uploadDir,
 * and immediate disk cleanup on decline.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../config.js';
import { generateUploadId } from '../utils/id-generator.js';
import { sanitizeFileName, atomicMove } from '../utils/file-utils.js';
import { AppError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';

export class PendingUploadService {
  /**
   * @param {{ config?: object }} [options] runtime config; defaults keep unit tests simple
   */
  constructor({ config = DEFAULT_CONFIG } = {}) {
    this.config = config;
    this.pending = new Map();
  }

  /**
   * Registers a newly uploaded file into pending approval staging.
   * @param {object} params
   * @returns {object} Pending transfer record
   */
  createPending({ fileName, fileSize, mimeType, tempPath, sender = {}, ttlMs = 300000 }) {
    const transferId = generateUploadId();
    const cleanName = sanitizeFileName(fileName || 'unnamed_file');

    const timeoutId = setTimeout(async () => {
      logger.warn('Pending upload timed out, removing temp file', {
        transferId,
        fileName: cleanName,
      });
      await this._deleteTemp(tempPath);
      this.pending.delete(transferId);
    }, ttlMs);

    // Prevent timer from keeping Node process alive if exiting
    if (timeoutId.unref) {
      timeoutId.unref();
    }

    const record = {
      transferId,
      fileName: cleanName,
      fileSize: Number(fileSize) || 0,
      mimeType: mimeType || 'application/octet-stream',
      tempPath,
      sender: {
        ip: sender.ip || 'unknown',
        label: sender.label || 'Unknown device',
        labelUntrusted: true,
        platform: sender.platform || 'unknown',
      },
      createdAt: Date.now(),
      timeoutId,
    };

    this.pending.set(transferId, record);

    return this._sanitizeRecord(record);
  }

  getPending(transferId) {
    const record = this.pending.get(transferId);
    return record ? this._sanitizeRecord(record) : null;
  }

  listPending() {
    return Array.from(this.pending.values()).map((rec) => this._sanitizeRecord(rec));
  }

  /**
   * Accepts a pending upload, moving it safely to the configured uploadDir.
   * @param {string} transferId
   * @returns {Promise<{ transferId: string, fileName: string, size: number }>}
   */
  /**
   * Accepts a pending upload, moving it safely to the configured uploadDir.
   * Atomic collision resolution and transactional: preserves record and temp file on move failure.
   * @param {string} transferId
   * @returns {Promise<{ transferId: string, fileName: string, size: number }>}
   */
  async accept(transferId) {
    const record = this.pending.get(transferId);
    if (!record) {
      throw new AppError('PENDING_NOT_FOUND', 404, `Pending transfer ${transferId} not found`);
    }

    if (record.isAccepting) {
      throw new AppError(
        'TRANSFER_IN_PROGRESS',
        409,
        `Transfer ${transferId} is already being accepted`
      );
    }
    record.isAccepting = true;

    // Pause timeout while move is in progress
    clearTimeout(record.timeoutId);

    try {
      // Ensure upload directory exists
      await fs.promises.mkdir(this.config.uploadDir, { recursive: true });

      // Atomic move with race-free collision resolution
      const moved = await atomicMove(record.tempPath, this.config.uploadDir, record.fileName);

      // Only delete record from pending map after the file is successfully moved to uploadDir
      this.pending.delete(transferId);

      logger.info('Pending transfer accepted by PC', {
        transferId,
        originalName: record.fileName,
        savedAs: moved.fileName,
      });

      // The absolute path stays inside the service: responses never expose it.
      return {
        transferId,
        fileName: moved.fileName,
        size: record.fileSize,
      };
    } catch (err) {
      record.isAccepting = false;

      // Re-arm timeout with remaining TTL (minimum 10 seconds) so user can resolve issue and retry
      const elapsed = Date.now() - record.createdAt;
      const remainingTtl = Math.max(10000, 300000 - elapsed);
      record.timeoutId = setTimeout(async () => {
        logger.warn('Pending upload timed out, removing temp file', {
          transferId,
          fileName: record.fileName,
        });
        await this._deleteTemp(record.tempPath);
        this.pending.delete(transferId);
      }, remainingTtl);
      if (record.timeoutId.unref) record.timeoutId.unref();

      throw err;
    }
  }

  /**
   * Declines a pending upload, removing the temporary file immediately.
   * @param {string} transferId
   * @returns {Promise<{ transferId: string, declined: boolean }>}
   */
  async decline(transferId) {
    const record = this.pending.get(transferId);
    if (!record) {
      throw new AppError('PENDING_NOT_FOUND', 404, `Pending transfer ${transferId} not found`);
    }

    clearTimeout(record.timeoutId);
    this.pending.delete(transferId);

    await this._deleteTemp(record.tempPath);

    logger.info('Pending transfer declined by PC, file deleted', {
      transferId,
      fileName: record.fileName,
    });

    return {
      transferId,
      declined: true,
    };
  }

  async cleanup() {
    for (const record of this.pending.values()) {
      clearTimeout(record.timeoutId);
      await this._deleteTemp(record.tempPath);
    }
    this.pending.clear();
  }

  /**
   * Sweeps orphaned pending files from tempDir/pending that are not tracked in this.pending
   * and are older than olderThanMs.
   * @param {number} [olderThanMs] Defaults to 5 minutes
   */
  async sweepOrphans(olderThanMs = 300000) {
    const pendingDir = path.join(this.config.tempDir, 'pending');
    try {
      const entries = await fs.promises.readdir(pendingDir, { withFileTypes: true });
      const now = Date.now();
      const activePaths = new Set(Array.from(this.pending.values()).map((r) => r.tempPath));

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fullPath = path.join(pendingDir, entry.name);
        if (!activePaths.has(fullPath)) {
          try {
            const stat = await fs.promises.stat(fullPath);
            if (now - stat.mtimeMs >= olderThanMs) {
              await fs.promises.unlink(fullPath);
              logger.info('Swept orphaned pending file', { path: entry.name });
            }
          } catch {
            // Ignore individual file errors
          }
        }
      }
    } catch {
      // Ignore if pendingDir does not exist yet
    }
  }

  async _deleteTemp(tempPath) {
    if (!tempPath) return;
    try {
      if (fs.existsSync(tempPath)) {
        await fs.promises.unlink(tempPath);
      }
    } catch (err) {
      logger.warn('Failed to delete temp pending file', { path: tempPath, error: err.message });
    }
  }

  _sanitizeRecord(record) {
    const { timeoutId: _timeoutId, tempPath: _tempPath, ...safeRecord } = record;
    return safeRecord;
  }
}
