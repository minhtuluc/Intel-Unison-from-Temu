/**
 * Chunked Upload Manager
 * Handles multi-gigabyte chunked file uploads (up to 10GB) with resume support.
 * Conforms to performance rule: Uses streaming chunk concatenation to keep RAM < 256MB.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { generateUploadId } from '../utils/id-generator.js';
import { sanitizeFileName, formatFileSize } from '../utils/file-utils.js';
import { AppError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';

export class ChunkedUploadManager {
  constructor(customConfig = null) {
    this.config = customConfig || config;
    this.tempDir = path.join(this.config.tempDir, 'chunks');
    /** @type {Map<string, object>} */
    this.sessions = new Map();
  }

  /**
   * Initializes a chunked upload session.
   * @param {{ fileName: string, fileSize: number, mimeType?: string }} params
   * @returns {Promise<{ uploadId: string, chunkSize: number, totalChunks: number, expiresAt: string }>}
   */
  async initUpload({ fileName, fileSize, mimeType = null }) {
    if (!fileName || typeof fileName !== 'string') {
      throw new AppError('INVALID_INPUT', 400, 'fileName must be provided');
    }

    const size = Number(fileSize);
    if (!Number.isFinite(size) || size <= 0) {
      throw new AppError('INVALID_FILE_SIZE', 400, 'fileSize must be a positive number');
    }

    if (size > this.config.maxFileSize) {
      throw new AppError(
        'FILE_TOO_LARGE',
        413,
        `File exceeds maximum allowed size (${formatFileSize(this.config.maxFileSize)})`
      );
    }

    const uploadId = generateUploadId();
    const chunkSize = this.config.chunkSize;
    const totalChunks = Math.ceil(size / chunkSize);
    const expiresAt = Date.now() + this.config.uploadExpiry;
    const sessionDir = path.join(this.tempDir, uploadId);

    // Create session temp directory
    await fs.promises.mkdir(sessionDir, { recursive: true });

    const session = {
      uploadId,
      fileName: sanitizeFileName(fileName),
      fileSize: size,
      mimeType: mimeType || 'application/octet-stream',
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
   * @returns {Promise<{ chunkIndex: number, receivedChunks: number, totalChunks: number, progress: number }>}
   */
  async addChunk(uploadId, chunkIndex, chunkBuffer) {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new AppError('UPLOAD_EXPIRED', 410, 'Upload session not found or has expired');
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
   * @returns {Promise<{ fileName: string, filePath: string, size: number, duration: number, averageSpeed: string }>}
   */
  async complete(uploadId, targetDir = this.config.uploadDir) {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new AppError('UPLOAD_EXPIRED', 410, 'Upload session not found or has expired');
    }

    if (session.receivedChunks.size < session.totalChunks) {
      throw new AppError(
        'CHUNK_MISSING',
        400,
        `Cannot complete upload. Received ${session.receivedChunks.size} of ${session.totalChunks} chunks.`
      );
    }

    // Ensure target directory exists
    await fs.promises.mkdir(targetDir, { recursive: true });

    // Handle existing filename collisions cleanly
    let finalFileName = session.fileName;
    let finalPath = path.join(targetDir, finalFileName);

    let counter = 1;
    const ext = path.extname(session.fileName);
    const base = path.basename(session.fileName, ext);

    while (fs.existsSync(finalPath)) {
      finalFileName = `${base}_(${counter})${ext}`;
      finalPath = path.join(targetDir, finalFileName);
      counter++;
    }

    // Stream-merge chunks into destination file
    const writeStream = fs.createWriteStream(finalPath, { flags: 'w' });

    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(session.sessionDir, `chunk_${i}`);
      const readStream = fs.createReadStream(chunkPath);
      await pipeline(readStream, writeStream, { end: false });
    }

    // Close write stream
    await new Promise((resolve, reject) => {
      writeStream.end((err) => (err ? reject(err) : resolve()));
    });

    // Cleanup session temporary chunks directory
    await fs.promises.rm(session.sessionDir, { recursive: true, force: true });
    this.sessions.delete(uploadId);

    const duration = Math.max(0.1, (Date.now() - session.createdAt) / 1000);
    const speedMBs = (session.fileSize / (1024 * 1024) / duration).toFixed(1);

    logger.info('Chunked upload completed successfully', {
      uploadId,
      fileName: finalFileName,
      size: session.fileSize,
      duration,
      speed: `${speedMBs} MB/s`,
    });

    return {
      fileName: finalFileName,
      filePath: finalPath,
      size: session.fileSize,
      duration: parseFloat(duration.toFixed(1)),
      averageSpeed: `${speedMBs} MB/s`,
    };
  }

  /**
   * Cleans up expired upload sessions and removes abandoned chunk directories.
   */
  async cleanup() {
    const now = Date.now();
    for (const [uploadId, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        logger.warn('Cleaning up expired upload session', { uploadId, name: session.fileName });
        try {
          await fs.promises.rm(session.sessionDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
        this.sessions.delete(uploadId);
      }
    }
  }
}

export const chunkedUploadManager = new ChunkedUploadManager();
