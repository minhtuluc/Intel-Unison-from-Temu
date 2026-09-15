import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PendingUploadService } from '../../src/services/pending-upload.js';

describe('PendingUploadService (Unit)', () => {
  let service;
  let testTempDir;
  let testUploadDir;

  beforeEach(async () => {
    testTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-pending-test-'));
    testUploadDir = path.join(testTempDir, 'uploads');
    await fs.promises.mkdir(testUploadDir, { recursive: true });
    service = new PendingUploadService({
      config: { uploadDir: testUploadDir, tempDir: testTempDir },
    });
  });

  afterEach(async () => {
    await service.cleanup();
    try {
      await fs.promises.rm(testTempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('should register a pending upload and return sanitized metadata', async () => {
    const tempFile = path.join(testTempDir, 'sample_photo.jpg');
    await fs.promises.writeFile(tempFile, 'JPEG_MOCK_DATA');

    const pending = service.createPending({
      fileName: 'sample_photo.jpg',
      fileSize: 14,
      mimeType: 'image/jpeg',
      tempPath: tempFile,
      sender: {
        ip: '192.168.1.42',
        label: 'Pixel 8',
        platform: 'android',
      },
    });

    assert.ok(pending.transferId);
    assert.equal(pending.fileName, 'sample_photo.jpg');
    assert.equal(pending.fileSize, 14);
    assert.equal(pending.sender.label, 'Pixel 8');
    assert.equal(pending.sender.ip, '192.168.1.42');
    assert.equal(pending.sender.labelUntrusted, true);
    assert.equal(pending.sender.platform, 'android');
    assert.equal(pending.tempPath, undefined, 'tempPath must not be exposed');
    assert.equal(pending.timeoutId, undefined, 'timeoutId must not be exposed');

    const found = service.getPending(pending.transferId);
    assert.ok(found);
    assert.equal(found.fileName, 'sample_photo.jpg');
  });

  it('should list all pending uploads', async () => {
    const file1 = path.join(testTempDir, 'file1.txt');
    const file2 = path.join(testTempDir, 'file2.txt');
    await fs.promises.writeFile(file1, '1');
    await fs.promises.writeFile(file2, '2');

    service.createPending({ fileName: 'file1.txt', fileSize: 1, tempPath: file1 });
    service.createPending({ fileName: 'file2.txt', fileSize: 1, tempPath: file2 });

    const list = service.listPending();
    assert.equal(list.length, 2);
  });

  it('should accept a pending upload and move file to uploadDir', async () => {
    const tempFile = path.join(testTempDir, 'test_video.mp4');
    await fs.promises.writeFile(tempFile, 'VIDEO_PAYLOAD_CONTENT');

    const pending = service.createPending({
      fileName: 'test_video.mp4',
      fileSize: 21,
      mimeType: 'video/mp4',
      tempPath: tempFile,
    });

    const accepted = await service.accept(pending.transferId);
    assert.equal(accepted.transferId, pending.transferId);
    assert.equal(accepted.fileName, 'test_video.mp4');
    // UT-015: accept() no longer returns the host path.
    assert.equal(accepted.filePath, undefined);
    const savedPath = path.join(testUploadDir, 'test_video.mp4');
    assert.ok(fs.existsSync(savedPath));

    const content = await fs.promises.readFile(savedPath, 'utf8');
    assert.equal(content, 'VIDEO_PAYLOAD_CONTENT');
    assert.equal(fs.existsSync(tempFile), false, 'Original temp file should have been moved');
    assert.equal(service.getPending(pending.transferId), null);
  });

  it('should resolve collisions cleanly when accepted file already exists in uploadDir', async () => {
    const existingFile = path.join(testUploadDir, 'document.pdf');
    await fs.promises.writeFile(existingFile, 'EXISTING_PDF');

    const tempFile = path.join(testTempDir, 'new_document.pdf');
    await fs.promises.writeFile(tempFile, 'NEW_PDF');

    const pending = service.createPending({
      fileName: 'document.pdf',
      fileSize: 7,
      tempPath: tempFile,
    });

    const accepted = await service.accept(pending.transferId);
    assert.equal(accepted.fileName, 'document_(1).pdf');
    assert.equal(accepted.filePath, undefined);
    assert.ok(fs.existsSync(path.join(testUploadDir, 'document_(1).pdf')));
    assert.ok(fs.existsSync(existingFile), 'Existing file must be preserved');
  });

  it('should decline a pending upload and delete the temporary file', async () => {
    const tempFile = path.join(testTempDir, 'unwanted_file.bin');
    await fs.promises.writeFile(tempFile, 'UNWANTED_BINARY_DATA');

    const pending = service.createPending({
      fileName: 'unwanted_file.bin',
      fileSize: 20,
      tempPath: tempFile,
    });

    const declined = await service.decline(pending.transferId);
    assert.equal(declined.transferId, pending.transferId);
    assert.equal(declined.declined, true);
    assert.equal(fs.existsSync(tempFile), false, 'Temporary file must be deleted on decline');
    assert.equal(service.getPending(pending.transferId), null);
  });

  it('should throw 404 when accepting non-existent transferId', async () => {
    await assert.rejects(async () => {
      await service.accept('non_existent_transfer');
    }, /not found/i);
  });

  it('should automatically delete temporary file when TTL expires', async () => {
    const tempFile = path.join(testTempDir, 'ttl_test.txt');
    await fs.promises.writeFile(tempFile, 'TTL_EXPIRE_CONTENT');

    const pending = service.createPending({
      fileName: 'ttl_test.txt',
      fileSize: 18,
      tempPath: tempFile,
      ttlMs: 50, // 50ms for test
    });

    assert.ok(fs.existsSync(tempFile));

    // Wait for TTL to fire
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(fs.existsSync(tempFile), false, 'Temp file should be deleted on TTL expiry');
    assert.equal(service.getPending(pending.transferId), null);
  });

  it('preserves pending record and temp file when move fails (transactional accept for retry)', async () => {
    // Point uploadDir to a regular file so mkdir/atomicMove fails
    const blockerFile = path.join(testTempDir, 'blocked_dir');
    await fs.promises.writeFile(blockerFile, 'BLOCKER');

    const failingService = new PendingUploadService({
      config: {
        uploadDir: path.join(blockerFile, 'sub'), // Cannot create directory inside regular file
        tempDir: testTempDir,
      },
    });

    const tempFile = path.join(testTempDir, 'retryable.txt');
    await fs.promises.writeFile(tempFile, 'RETRYABLE_CONTENT');

    const pending = failingService.createPending({
      fileName: 'retryable.txt',
      fileSize: 17,
      tempPath: tempFile,
      ttlMs: 60000,
    });

    // Accept should throw because destination directory cannot be created
    await assert.rejects(async () => {
      await failingService.accept(pending.transferId);
    });

    // Record MUST still exist in pending map and temp file must be intact!
    assert.ok(failingService.getPending(pending.transferId));
    assert.ok(fs.existsSync(tempFile), 'Temporary file must be kept for retry');
  });

  it('rejects concurrent accept calls on the same transferId with 409 TRANSFER_IN_PROGRESS', async () => {
    const tempFile = path.join(testTempDir, 'concurrent.bin');
    await fs.promises.writeFile(tempFile, 'CONCURRENT_TEST');

    const pending = service.createPending({
      fileName: 'concurrent.bin',
      fileSize: 15,
      tempPath: tempFile,
    });

    // Run two accepts simultaneously
    const p1 = service.accept(pending.transferId);
    const p2 = service.accept(pending.transferId);

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.statusCode, 409);
    assert.equal(rejected[0].reason.code, 'TRANSFER_IN_PROGRESS');
  });

  it('should sweep orphaned pending files in tempDir/pending', async () => {
    const pendingDir = path.join(testTempDir, 'pending');
    await fs.promises.mkdir(pendingDir, { recursive: true });

    const orphanFile = path.join(pendingDir, 'orphan_pending.bin');
    await fs.promises.writeFile(orphanFile, 'abandoned pending');

    const activeTemp = path.join(pendingDir, 'active_pending.bin');
    await fs.promises.writeFile(activeTemp, 'active pending');
    service.createPending({
      fileName: 'active.bin',
      fileSize: 14,
      tempPath: activeTemp,
    });

    await service.sweepOrphans(0);

    assert.equal(fs.existsSync(orphanFile), false, 'Orphaned pending file should be swept');
    assert.equal(fs.existsSync(activeTemp), true, 'Tracked pending file must be preserved');
  });
});
