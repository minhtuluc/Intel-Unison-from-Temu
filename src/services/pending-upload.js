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
  createPending({
    fileName,
    fileSize,
    mimeType,
    tempPath,
    sender = {},
    ttlMs = 300000,
    quotaAlreadyReserved = false,
  }) {
    const transferId = generateUploadId();
    const cleanName = sanitizeFileName(fileName || 'unnamed_file');
    const size = Number(fileSize) || 0;
    const finalTtl = Number(ttlMs) || 300000;

    if (!quotaAlreadyReserved && this.config.quotaTracker) {
      this.config.quotaTracker.reserve(size);
    }

    const timeoutId = setTimeout(async () => {
      // If record is already being accepted, rejected, or completed, abort
      if (record.state !== 'pending') {
        return;
      }
      record.state = 'expiring';

      logger.warn('Pending upload timed out, removing temp file', {
        transferId,
        fileName: cleanName,
      });
      await this._deleteTemp(tempPath);
      if (this.config.quotaTracker) {
        this.config.quotaTracker.release(size);
      }
      record.state = 'expired';
      this.pending.delete(transferId);
      this._recordOutcome(transferId, {
        status: 'expired',
        reason: 'TIMEOUT',
        fileName: cleanName,
        timestamp: Date.now(),
      });
      if (typeof this.onTimeout === 'function') {
        try {
          this.onTimeout({ transferId, fileName: cleanName, sender: record.sender });
        } catch (err) {
          logger.error('Error in onTimeout handler', err);
        }
      }
    }, finalTtl);

    // Prevent timer from keeping Node process alive if exiting
    if (timeoutId.unref) {
      timeoutId.unref();
    }

    const record = {
      transferId,
      state: 'pending', // 'pending' | 'accepting' | 'rejecting' | 'expiring' | 'completed' | 'rejected' | 'expired'
      fileName: cleanName,
      fileSize: size,
      mimeType: mimeType || 'application/octet-stream',
      tempPath,
      sender: {
        connectionId: sender.connectionId || null,
        ip: sender.ip || 'unknown',
        label: sender.label || 'Unknown device',
        labelUntrusted: true,
        platform: sender.platform || 'unknown',
      },
      createdAt: Date.now(),
      ttlMs: finalTtl,
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
  async accept(transferId, targetDir = this.config.uploadDir) {
    const record = this.pending.get(transferId);
    if (!record) {
      const outcome = this.recentOutcomes?.get(transferId);
      if (outcome) {
        throw new AppError(
          'TRANSFER_IN_PROGRESS',
          409,
          `Transfer ${transferId} has already finished with status: ${outcome.status}`
        );
      }
      throw new AppError('PENDING_NOT_FOUND', 404, `Pending transfer ${transferId} not found`);
    }

    if (record.state !== 'pending') {
      throw new AppError(
        'TRANSFER_IN_PROGRESS',
        409,
        `Transfer ${transferId} is currently in state: ${record.state}`
      );
    }
    record.state = 'accepting';

    // Pause timeout while move is in progress
    clearTimeout(record.timeoutId);

    try {
      // Ensure upload directory exists
      await fs.promises.mkdir(targetDir, { recursive: true });

      // Atomic move with race-free collision resolution
      const moved = await atomicMove(record.tempPath, targetDir, record.fileName);

      record.state = 'completed';
      this.pending.delete(transferId);
      if (this.config.quotaTracker) {
        this.config.quotaTracker.release(record.fileSize);
      }
      this._recordOutcome(transferId, {
        status: 'completed',
        fileName: moved.fileName,
        size: record.fileSize,
        timestamp: Date.now(),
      });

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
      record.state = 'pending';

      // Re-arm timeout with remaining TTL based on original ttlMs (minimum 10 seconds)
      const elapsed = Date.now() - record.createdAt;
      const remainingTtl = Math.max(10000, record.ttlMs - elapsed);
      record.timeoutId = setTimeout(async () => {
        if (record.state !== 'pending') return;
        record.state = 'expiring';
        logger.warn('Pending upload timed out, removing temp file', {
          transferId,
          fileName: record.fileName,
        });
        await this._deleteTemp(record.tempPath);
        if (this.config.quotaTracker) {
          this.config.quotaTracker.release(record.fileSize);
        }
        record.state = 'expired';
        this.pending.delete(transferId);
        this._recordOutcome(transferId, {
          status: 'expired',
          reason: 'TIMEOUT',
          fileName: record.fileName,
          timestamp: Date.now(),
        });
        if (typeof this.onTimeout === 'function') {
          try {
            this.onTimeout({ transferId, fileName: record.fileName, sender: record.sender });
          } catch (tErr) {
            logger.error('Error in onTimeout handler', tErr);
          }
        }
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
      const outcome = this.recentOutcomes?.get(transferId);
      if (outcome) {
        throw new AppError(
          'TRANSFER_IN_PROGRESS',
          409,
          `Transfer ${transferId} has already finished with status: ${outcome.status}`
        );
      }
      throw new AppError('PENDING_NOT_FOUND', 404, `Pending transfer ${transferId} not found`);
    }

    if (record.state !== 'pending') {
      throw new AppError(
        'TRANSFER_IN_PROGRESS',
        409,
        `Transfer ${transferId} is currently in state: ${record.state}`
      );
    }
    record.state = 'rejecting';

    clearTimeout(record.timeoutId);
    try {
      await this._deleteTemp(record.tempPath);
      if (this.config.quotaTracker) {
        this.config.quotaTracker.release(record.fileSize);
      }
    } finally {
      record.state = 'rejected';
      this.pending.delete(transferId);
      this._recordOutcome(transferId, {
        status: 'rejected',
        reason: 'REJECTED_BY_PC',
        timestamp: Date.now(),
      });
    }

    logger.info('Pending transfer declined by PC, file deleted', {
      transferId,
      fileName: record.fileName,
    });

    return {
      transferId,
      declined: true,
    };
  }

  /**
   * Gets internal transfer record (e.g. for sender metadata).
   * @param {string} transferId
   * @returns {object|null}
   */
  getTransferRecord(transferId) {
    return this.pending.get(transferId) || this.recentOutcomes?.get(transferId) || null;
  }

  _recordOutcome(transferId, outcome) {
    if (!this.recentOutcomes) {
      this.recentOutcomes = new Map();
    }
    if (this.recentOutcomes.size >= 200) {
      const oldestKey = this.recentOutcomes.keys().next().value;
      this.recentOutcomes.delete(oldestKey);
    }
    this.recentOutcomes.set(transferId, outcome);
  }

  getTransferStatus(transferId) {
    const record = this.pending.get(transferId);
    if (record) {
      return { status: 'pending', ...this._sanitizeRecord(record) };
    }
    if (this.recentOutcomes && this.recentOutcomes.has(transferId)) {
      return this.recentOutcomes.get(transferId);
    }
    return null;
  }

  async cleanup() {
    for (const record of this.pending.values()) {
      clearTimeout(record.timeoutId);
      await this._deleteTemp(record.tempPath);
    }
    this.pending.clear();
    this.recentOutcomes?.clear();
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
      const activePaths = new Set();
      for (const r of this.pending.values()) {
        if (!r.tempPath) continue;
        const p = path.resolve(r.tempPath);
        activePaths.add(p);
        if (process.platform === 'win32') {
          activePaths.add(p.toLowerCase());
        }
        try {
          const real = await fs.promises.realpath(p);
          activePaths.add(real);
          if (process.platform === 'win32') {
            activePaths.add(real.toLowerCase());
          }
        } catch {
          // Ignore if realpath fails
        }
      }

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fullPath = path.join(pendingDir, entry.name);
        let realFullPath = fullPath;
        try {
          realFullPath = await fs.promises.realpath(fullPath);
        } catch {
          // Fallback to fullPath
        }

        const isTracked =
          activePaths.has(fullPath) ||
          activePaths.has(realFullPath) ||
          (process.platform === 'win32' &&
            (activePaths.has(fullPath.toLowerCase()) ||
              activePaths.has(realFullPath.toLowerCase())));

        if (!isTracked) {
          try {
            const stat = await fs.promises.stat(fullPath);
            if (olderThanMs <= 0 || Date.now() - stat.mtimeMs >= olderThanMs) {
              await fs.promises.unlink(fullPath);
              if (this.config.quotaTracker) {
                this.config.quotaTracker.release(stat.size);
              }
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
