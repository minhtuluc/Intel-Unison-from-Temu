/**
 * Storage Quota Tracker Service
 * Tracks and enforces disk byte quotas across temporary upload sessions and pending staging files.
 */

import fs from 'node:fs';
import path from 'node:path';
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

  /**
   * Synchronously scans specified directories and updates allocatedBytes
   * based on actual files found on disk.
   * @param {string[]} directories
   * @returns {number} Total bytes reconciled
   */
  reconcileFromDiskSync(directories = []) {
    let total = 0;
    for (const dir of directories) {
      if (!dir) continue;
      try {
        const scanDir = (d) => {
          let subtotal = 0;
          const entries = fs.readdirSync(d, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(d, entry.name);
            if (entry.isDirectory()) {
              subtotal += scanDir(fullPath);
            } else if (entry.isFile()) {
              const stat = fs.statSync(fullPath);
              subtotal += stat.size;
            }
          }
          return subtotal;
        };
        total += scanDir(dir);
      } catch {
        // Directory may not exist yet
      }
    }
    this.recalibrate(total);
    return total;
  }

  /**
   * Asynchronously scans specified directories and updates allocatedBytes
   * based on actual files found on disk.
   * @param {string[]} directories
   * @returns {Promise<number>} Total bytes reconciled
   */
  async reconcileFromDisk(directories = []) {
    let total = 0;
    for (const dir of directories) {
      if (!dir) continue;
      try {
        const scanDir = async (d) => {
          let subtotal = 0;
          const entries = await fs.promises.readdir(d, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(d, entry.name);
            if (entry.isDirectory()) {
              subtotal += await scanDir(fullPath);
            } else if (entry.isFile()) {
              const stat = await fs.promises.stat(fullPath);
              subtotal += stat.size;
            }
          }
          return subtotal;
        };
        total += await scanDir(dir);
      } catch {
        // Directory may not exist yet
      }
    }
    this.recalibrate(total);
    return total;
  }
}
