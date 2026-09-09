/**
 * Pending Upload Service
 * Manages uploaded files awaiting PC user approval (Accept / Decline).
 * Includes 5-minute TTL cleanup, collision-safe moving to uploadDir,
 * and immediate disk cleanup on decline.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { generateUploadId } from '../utils/id-generator.js';
import { sanitizeFileName } from '../utils/file-utils.js';
import { AppError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';

async function moveFileSafe(src, dest) {
  try {
    await fs.promises.rename(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fs.promises.copyFile(src, dest);
      await fs.promises.unlink(src);
    } else {
      throw err;
    }
  }
}

export class PendingUploadService {
  constructor() {
    this.pending = new Map();
  }

  /**
   * Registers a newly uploaded file into pending approval staging.
   * @param {object} params
   * @returns {object} Pending transfer record
   */
  createPending({ fileName, fileSize, mimeType, tempPath, senderDevice = {}, ttlMs = 300000 }) {
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
      senderDevice: {
        deviceId: senderDevice.deviceId || 'unknown',
        deviceName: senderDevice.deviceName || 'Mobile Device',
        platform: senderDevice.platform || 'unknown',
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
   * @returns {Promise<{ transferId: string, fileName: string, filePath: string, size: number }>}
   */
  async accept(transferId) {
    const record = this.pending.get(transferId);
    if (!record) {
      throw new AppError('PENDING_NOT_FOUND', 404, `Pending transfer ${transferId} not found`);
    }

    clearTimeout(record.timeoutId);
    this.pending.delete(transferId);

    // Ensure upload directory exists
    await fs.promises.mkdir(config.uploadDir, { recursive: true });

    // Handle collision safely
    const ext = path.extname(record.fileName);
    const base = path.basename(record.fileName, ext);
    let finalPath = path.join(config.uploadDir, record.fileName);
    let counter = 1;

    while (fs.existsSync(finalPath)) {
      finalPath = path.join(config.uploadDir, `${base}_(${counter})${ext}`);
      counter++;
    }

    await moveFileSafe(record.tempPath, finalPath);

    logger.info('Pending transfer accepted by PC', {
      transferId,
      originalName: record.fileName,
      savedAs: path.basename(finalPath),
    });

    return {
      transferId,
      fileName: path.basename(finalPath),
      filePath: finalPath,
      size: record.fileSize,
    };
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

export const pendingUploadManager = new PendingUploadService();
