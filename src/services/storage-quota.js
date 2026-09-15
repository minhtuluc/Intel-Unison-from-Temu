/**
 * Storage Quota Tracker Service
 * Tracks and enforces disk byte quotas across temporary upload sessions and pending staging files.
 */

import { AppError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';

export class StorageQuotaTracker {
  /**
   * @param {number} quotaLimit - Maximum allowed bytes
   */
  constructor(quotaLimit = 20 * 1024 * 1024 * 1024) {
    this.quotaLimit = Number(quotaLimit);
    this.allocatedBytes = 0;
  }

  /**
   * Reserves byte quota for a transfer.
   * Throws 507 STORAGE_QUOTA_EXCEEDED if the quota would be breached.
   * @param {number} bytes
   * @throws {AppError}
   */
  reserve(bytes) {
    const numBytes = Number(bytes);
    if (!Number.isFinite(numBytes) || numBytes < 0) {
      return;
    }

    if (this.allocatedBytes + numBytes > this.quotaLimit) {
      logger.warn('Storage quota exceeded', {
        requested: numBytes,
        allocated: this.allocatedBytes,
        limit: this.quotaLimit,
      });
      throw new AppError(
        'STORAGE_QUOTA_EXCEEDED',
        507,
        `Storage quota exceeded: requested ${numBytes} bytes, available ${Math.max(
          0,
          this.quotaLimit - this.allocatedBytes
        )} bytes`
      );
    }

    this.allocatedBytes += numBytes;
  }

  /**
   * Releases previously reserved byte quota.
   * @param {number} bytes
   */
  release(bytes) {
    const numBytes = Number(bytes);
    if (!Number.isFinite(numBytes) || numBytes <= 0) {
      return;
    }

    this.allocatedBytes = Math.max(0, this.allocatedBytes - numBytes);
  }

  /**
   * Returns current quota statistics.
   * @returns {{ allocated: number, limit: number, available: number }}
   */
  getStats() {
    return {
      allocated: this.allocatedBytes,
      used: this.allocatedBytes,
      limit: this.quotaLimit,
      available: Math.max(0, this.quotaLimit - this.allocatedBytes),
    };
  }

  /**
   * Resets or recalibrates allocated bytes.
   * @param {number} bytes
   */
  recalibrate(bytes = 0) {
    this.allocatedBytes = Math.max(0, Number(bytes) || 0);
  }
}
