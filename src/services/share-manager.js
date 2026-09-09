/**
 * Share Manager Service
 * Manages in-memory staged files for sharing over local WLAN.
 * Provides thread-safe, secure path validation, directory recursion, and deduplication.
 */

import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import { generateFileId } from '../utils/id-generator.js';
import { formatFileSize, getFileType, sanitizeFileName } from '../utils/file-utils.js';
import { AppError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';

export class ShareManager {
  constructor() {
    /** @type {Map<string, object>} fileId -> file metadata */
    this.stagedFiles = new Map();
    /** @type {Map<string, string>} resolvedPath -> fileId */
    this.pathToId = new Map();
  }

  /**
   * Adds a single file to the staging area.
   * @param {string} filePath - Absolute or relative path to file
   * @param {string} [customName] - Optional custom display name
   * @returns {Promise<object>} Public file metadata
   */
  async addFile(filePath, customName = null) {
    if (!filePath || typeof filePath !== 'string') {
      throw new AppError('INVALID_PATH', 400, 'File path must be a non-empty string');
    }

    if (filePath.includes('\0')) {
      throw new AppError('ACCESS_DENIED', 403, 'Path contains null bytes');
    }

    const resolved = path.resolve(filePath);

    // Verify file existence and get stats
    let stat;
    try {
      stat = await fs.promises.stat(resolved);
    } catch {
      throw new AppError('FILE_NOT_FOUND', 404, `File not found: ${path.basename(resolved)}`);
    }

    if (stat.isDirectory()) {
      throw new AppError(
        'IS_DIRECTORY',
        400,
        'Path is a directory, use addFiles to add directories'
      );
    }

    // Resolve real path in case of symlinks
    let realPath = resolved;
    try {
      realPath = await fs.promises.realpath(resolved);
    } catch {
      // Fallback to resolved if realpath fails
    }

    // Check if file is already staged (deduplication)
    if (this.pathToId.has(realPath)) {
      const existingId = this.pathToId.get(realPath);
      const existing = this.stagedFiles.get(existingId);
      if (existing) {
        return this._getPublicMetadata(existing);
      }
    }

    const fileName = customName ? sanitizeFileName(customName) : path.basename(resolved);
    const mimeType = mime.lookup(fileName) || 'application/octet-stream';
    const type = getFileType(fileName, mimeType);
    const fileId = generateFileId();

    const fileRecord = {
      id: fileId,
      name: fileName,
      path: realPath,
      size: stat.size,
      sizeFormatted: formatFileSize(stat.size),
      mimeType,
      type,
      sharedAt: new Date().toISOString(),
      hasThumbnail: false,
    };

    this.stagedFiles.set(fileId, fileRecord);
    this.pathToId.set(realPath, fileId);

    logger.info('File staged for sharing', {
      fileId,
      name: fileName,
      size: stat.size,
    });

    return this._getPublicMetadata(fileRecord);
  }

  /**
   * Adds multiple files or recursively traverses directories to add all files.
   * @param {string[]} paths - Array of file or directory paths
   * @returns {Promise<object[]>} Array of public file metadata
   */
  async addFiles(paths = []) {
    if (!Array.isArray(paths)) {
      throw new AppError('INVALID_INPUT', 400, 'Paths must be an array');
    }

    const added = [];

    for (const p of paths) {
      if (!p || typeof p !== 'string') continue;
      const resolved = path.resolve(p);

      try {
        const stat = await fs.promises.stat(resolved);
        if (stat.isDirectory()) {
          const dirFiles = await this._traverseDirectory(resolved);
          for (const file of dirFiles) {
            const meta = await this.addFile(file);
            added.push(meta);
          }
        } else {
          const meta = await this.addFile(resolved);
          added.push(meta);
        }
      } catch (err) {
        logger.warn('Failed to add path during batch share', {
          error: err.message,
          path: path.basename(resolved),
        });
      }
    }

    return added;
  }

  /**
   * Recursively discovers all files inside a directory.
   * @private
   * @param {string} dirPath
   * @returns {Promise<string[]>}
   */
  async _traverseDirectory(dirPath) {
    const results = [];
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const nested = await this._traverseDirectory(fullPath);
        results.push(...nested);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }

    return results;
  }

  /**
   * Removes a file from the staging area.
   * @param {string} fileId
   * @returns {boolean} True if removed, false if not found
   */
  removeFile(fileId) {
    if (!this.stagedFiles.has(fileId)) {
      return false;
    }

    const file = this.stagedFiles.get(fileId);
    this.stagedFiles.delete(fileId);
    if (file && file.path) {
      this.pathToId.delete(file.path);
    }

    logger.info('File removed from staging', { fileId, name: file?.name });
    return true;
  }

  /**
   * Gets internal file record (including absolute path) for streaming.
   * @param {string} fileId
   * @returns {object|null}
   */
  getFile(fileId) {
    return this.stagedFiles.get(fileId) || null;
  }

  /**
   * Returns all staged files and summary statistics for clients.
   * @returns {{ files: object[], totalSize: number, totalSizeFormatted: string, fileCount: number }}
   */
  listFiles() {
    const files = Array.from(this.stagedFiles.values()).map((f) => this._getPublicMetadata(f));
    const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);

    return {
      files,
      totalSize,
      totalSizeFormatted: formatFileSize(totalSize),
      fileCount: files.length,
    };
  }

  /**
   * Clears all files from the staging area.
   */
  clear() {
    this.stagedFiles.clear();
    this.pathToId.clear();
    logger.info('Staging area cleared');
  }

  /**
   * Filters out server-internal properties (like full disk path) before sending to clients.
   * @private
   */
  _getPublicMetadata(fileRecord) {
    return {
      id: fileRecord.id,
      name: fileRecord.name,
      size: fileRecord.size,
      sizeFormatted: fileRecord.sizeFormatted,
      mimeType: fileRecord.mimeType,
      type: fileRecord.type,
      sharedAt: fileRecord.sharedAt,
      hasThumbnail: fileRecord.hasThumbnail,
    };
  }
}

export const shareManager = new ShareManager();
