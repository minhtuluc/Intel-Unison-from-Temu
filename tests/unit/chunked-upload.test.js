import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ChunkedUploadManager } from '../../src/services/chunked-upload.js';

describe('ChunkedUploadManager Service', () => {
  let testTempDir;
  let testUploadDir;
  let rootDir;
  let manager;

  beforeEach(async () => {
    rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-chunk-test-'));
    testTempDir = path.join(rootDir, 'temp');
    testUploadDir = path.join(rootDir, 'uploads');
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
    await fs.promises.rm(rootDir, { recursive: true, force: true });
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

    it('should enforce maxSessions limit with 429 TOO_MANY_SESSIONS', async () => {
      const tinyManager = new ChunkedUploadManager({
        tempDir: testTempDir,
        uploadDir: testUploadDir,
        chunkSize: 1024,
        maxFileSize: 10 * 1024 * 1024,
        maxSessions: 2,
        uploadExpiry: 60000,
      });

      await tinyManager.initUpload({ fileName: 'file1.bin', fileSize: 1024 });
      await tinyManager.initUpload({ fileName: 'file2.bin', fileSize: 1024 });

      await assert.rejects(
        () => tinyManager.initUpload({ fileName: 'file3.bin', fileSize: 1024 }),
        { code: 'TOO_MANY_SESSIONS', statusCode: 429 }
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

    it('should reject chunk when byte length does not match expected size', async () => {
      const init = await manager.initUpload({
        fileName: 'transfer.bin',
        fileSize: 2048, // 2 chunks of 1024
      });

      // Pass only 500 bytes for chunk 0 when 1024 is expected
      await assert.rejects(() => manager.addChunk(init.uploadId, 0, Buffer.alloc(500)), {
        code: 'CHUNK_SIZE_MISMATCH',
        statusCode: 400,
      });
    });

    it('should verify optional SHA-256 chunk checksum when provided', async () => {
      const init = await manager.initUpload({
        fileName: 'transfer.bin',
        fileSize: 1024,
      });

      const chunkData = Buffer.alloc(1024, 'Z');
      const correctHash = crypto.createHash('sha256').update(chunkData).digest('hex');
      const wrongHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

      // Checksum mismatch
      await assert.rejects(() => manager.addChunk(init.uploadId, 0, chunkData, wrongHash), {
        code: 'CHECKSUM_MISMATCH',
        statusCode: 400,
      });

      // Correct checksum
      const res = await manager.addChunk(init.uploadId, 0, chunkData, correctHash);
      assert.equal(res.chunkIndex, 0);
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

    it('should detect file size corruption during complete() and reject with FILE_CORRUPTED', async () => {
      const init = await manager.initUpload({
        fileName: 'corrupt.bin',
        fileSize: 2048,
      });

      await manager.addChunk(init.uploadId, 0, Buffer.alloc(1024, 'A'));
      await manager.addChunk(init.uploadId, 1, Buffer.alloc(1024, 'B'));

      // Tamper with chunk_1 on disk to truncate it
      const chunk1Path = path.join(testTempDir, 'chunks', init.uploadId, 'chunk_1');
      await fs.promises.writeFile(chunk1Path, Buffer.alloc(500, 'B'));

      await assert.rejects(() => manager.complete(init.uploadId), {
        code: 'FILE_CORRUPTED',
        statusCode: 500,
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

  describe('cancelUpload()', () => {
    it('should cancel active session and immediately delete chunk files from disk', async () => {
      const init = await manager.initUpload({
        fileName: 'to_cancel.bin',
        fileSize: 2048,
      });

      await manager.addChunk(init.uploadId, 0, Buffer.alloc(1024));
      const sessionDir = path.join(testTempDir, 'chunks', init.uploadId);
      assert.ok(fs.existsSync(sessionDir));

      const cancelled = await manager.cancelUpload(init.uploadId);
      assert.equal(cancelled, true);
      assert.equal(manager.sessions.has(init.uploadId), false);
      assert.equal(
        fs.existsSync(sessionDir),
        false,
        'Session temp dir must be deleted immediately'
      );
    });

    it('should return false when cancelling non-existent uploadId', async () => {
      const cancelled = await manager.cancelUpload('up_non_existent');
      assert.equal(cancelled, false);
    });
  });

  describe('sweepOrphans()', () => {
    it('should sweep orphaned chunk session directories not in memory', async () => {
      const chunksDir = path.join(testTempDir, 'chunks');
      const orphanDir = path.join(chunksDir, 'up_orphan_session');
      await fs.promises.mkdir(orphanDir, { recursive: true });
      await fs.promises.writeFile(path.join(orphanDir, 'chunk_0'), 'orphan');

      const init = await manager.initUpload({
        fileName: 'active.bin',
        fileSize: 1024,
      });
      const activeDir = path.join(chunksDir, init.uploadId);

      await manager.sweepOrphans(0);

      assert.equal(fs.existsSync(orphanDir), false, 'Orphaned chunk folder must be swept');
      assert.equal(fs.existsSync(activeDir), true, 'Active chunk folder must be kept');
    });
  });
});
