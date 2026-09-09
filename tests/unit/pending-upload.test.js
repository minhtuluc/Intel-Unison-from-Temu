import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PendingUploadService } from '../../src/services/pending-upload.js';
import { config } from '../../src/config.js';

describe('PendingUploadService (Unit)', () => {
  let service;
  let testTempDir;
  let testUploadDir;
  let origUploadDir;

  beforeEach(async () => {
    service = new PendingUploadService();
    testTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-pending-test-'));
    testUploadDir = path.join(testTempDir, 'uploads');
    await fs.promises.mkdir(testUploadDir, { recursive: true });

    origUploadDir = config.uploadDir;
    config.uploadDir = testUploadDir;
  });

  afterEach(async () => {
    await service.cleanup();
    config.uploadDir = origUploadDir;
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
      senderDevice: {
        deviceId: 'dev_test_123',
        deviceName: 'Pixel 8',
        platform: 'android',
      },
    });

    assert.ok(pending.transferId);
    assert.equal(pending.fileName, 'sample_photo.jpg');
    assert.equal(pending.fileSize, 14);
    assert.equal(pending.senderDevice.deviceName, 'Pixel 8');
    assert.equal(pending.senderDevice.platform, 'android');
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
    assert.ok(fs.existsSync(accepted.filePath));

    const content = await fs.promises.readFile(accepted.filePath, 'utf8');
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
    assert.ok(fs.existsSync(accepted.filePath));
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
});
