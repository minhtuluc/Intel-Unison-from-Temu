import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ChunkedUploadManager } from '../../src/services/chunked-upload.js';

describe('ChunkedUploadManager Service', () => {
  const testTempDir = path.resolve('temp/test_chunk_service');
  const testUploadDir = path.resolve('temp/test_upload_out');
  let manager;

  beforeEach(async () => {
    await fs.promises.mkdir(testTempDir, { recursive: true });
    await fs.promises.mkdir(testUploadDir, { recursive: true });

    manager = new ChunkedUploadManager({
      tempDir: testTempDir,
      uploadDir: testUploadDir,
      chunkSize: 1024, // 1KB chunks for fast unit tests
      maxFileSize: 10 * 1024 * 1024,
      uploadExpiry: 1000, // 1 sec expiry for test
    });
  });

  afterEach(async () => {
    await fs.promises.rm(testTempDir, { recursive: true, force: true });
    await fs.promises.rm(testUploadDir, { recursive: true, force: true });
  });

  describe('initUpload()', () => {
    it('should initialize session and calculate correct totalChunks', async () => {
      const init = await manager.initUpload({
        fileName: 'large_data.bin',
        fileSize: 2500, // Needs 3 chunks of 1024 bytes
      });

      assert.ok(init.uploadId.startsWith('up_'));
      assert.equal(init.chunkSize, 1024);
      assert.equal(init.totalChunks, 3);
      assert.ok(init.expiresAt);
    });

    it('should reject invalid fileSize <= 0', async () => {
      await assert.rejects(() => manager.initUpload({ fileName: 'file.bin', fileSize: 0 }), {
        code: 'INVALID_FILE_SIZE',
      });
    });

    it('should reject file exceeding maxFileSize with 413', async () => {
      await assert.rejects(
        () => manager.initUpload({ fileName: 'huge.bin', fileSize: 50 * 1024 * 1024 }),
        { code: 'FILE_TOO_LARGE', statusCode: 413 }
      );
    });
  });

  describe('addChunk() & getStatus()', () => {
    it('should store chunks and track received progress', async () => {
      const init = await manager.initUpload({
        fileName: 'transfer.bin',
        fileSize: 2048, // 2 chunks
      });

      const chunk0 = Buffer.alloc(1024, 'A');
      const chunk1 = Buffer.alloc(1024, 'B');

      const res0 = await manager.addChunk(init.uploadId, 0, chunk0);
      assert.equal(res0.chunkIndex, 0);
      assert.equal(res0.receivedChunks, 1);
      assert.equal(res0.progress, 50.0);

      const status = manager.getStatus(init.uploadId);
      assert.deepEqual(status.receivedChunks, [0]);
      assert.equal(status.nextChunk, 1);

      const res1 = await manager.addChunk(init.uploadId, 1, chunk1);
      assert.equal(res1.receivedChunks, 2);
      assert.equal(res1.progress, 100.0);
    });

    it('should reject invalid chunk index out of bounds', async () => {
      const init = await manager.initUpload({
        fileName: 'transfer.bin',
        fileSize: 1024, // 1 chunk
      });

      await assert.rejects(() => manager.addChunk(init.uploadId, 5, Buffer.from('data')), {
        code: 'CHUNK_INVALID',
        statusCode: 400,
      });
    });

    it('should throw UPLOAD_EXPIRED for non-existent session', async () => {
      await assert.rejects(() => manager.addChunk('up_unknown', 0, Buffer.from('data')), {
        code: 'UPLOAD_EXPIRED',
        statusCode: 410,
      });
    });
  });

  describe('complete()', () => {
    it('should merge all chunks sequentially and output full file to uploadDir', async () => {
      const init = await manager.initUpload({
        fileName: 'final_merged.txt',
        fileSize: 15,
      });

      // 15 bytes in 1KB chunkSize -> 1 chunk
      const content = Buffer.from('Hello Universe!');
      await manager.addChunk(init.uploadId, 0, content);

      const result = await manager.complete(init.uploadId);
      assert.equal(result.fileName, 'final_merged.txt');
      assert.ok(fs.existsSync(result.filePath));

      const fileOnDisk = await fs.promises.readFile(result.filePath, 'utf8');
      assert.equal(fileOnDisk, 'Hello Universe!');
    });

    it('should fail if complete is called when chunks are missing', async () => {
      const init = await manager.initUpload({
        fileName: 'incomplete.bin',
        fileSize: 3000, // 3 chunks
      });

      await manager.addChunk(init.uploadId, 0, Buffer.alloc(1024));

      await assert.rejects(() => manager.complete(init.uploadId), {
        code: 'CHUNK_MISSING',
        statusCode: 400,
      });
    });
  });

  describe('cleanup()', () => {
    it('should remove expired sessions and temporary chunk files', async () => {
      const init = await manager.initUpload({
        fileName: 'expired.bin',
        fileSize: 1024,
      });

      // Wait for session to expire (expiry was set to 1000ms in test setup)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      await manager.cleanup();
      assert.equal(manager.sessions.has(init.uploadId), false);
    });
  });
});
