import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../../src/server.js';
import { config } from '../../src/config.js';

describe('Upload Approval & Decision Integration Tests', () => {
  let serverInstance;
  let baseUrl;
  let tempDir;
  let uploadDir;

  let origUploadDir;
  let origTempDir;

  before(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-approval-test-'));
    uploadDir = path.join(tempDir, 'uploads');
    await fs.promises.mkdir(uploadDir, { recursive: true });

    origUploadDir = config.uploadDir;
    origTempDir = config.tempDir;
    config.uploadDir = uploadDir;
    config.tempDir = tempDir;

    serverInstance = await startServer({
      port: 0,
      host: '127.0.0.1',
      noBrowser: true,
      tempDir,
      uploadDir,
    });

    const addr = serverInstance.server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (serverInstance?.wss) {
      for (const client of serverInstance.wss.clients) {
        client.terminate();
      }
      serverInstance.wss.close();
    }
    if (serverInstance?.server) {
      await new Promise((resolve) => serverInstance.server.close(resolve));
    }
    config.uploadDir = origUploadDir;
    config.tempDir = origTempDir;
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('should stage mobile upload in pending area until PC user accepts', async () => {
    const formData = new FormData();
    const payload = 'SECRET_PHOTO_PAYLOAD_12345';
    formData.append('files', new Blob([payload], { type: 'text/plain' }), 'photo_from_phone.jpg');

    // 1. Mobile uploads file
    const uploadRes = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: {
        'x-device-id': 'dev_phone_1',
        'x-device-name': 'Pixel Phone',
        'x-platform': 'android',
      },
      body: formData,
    });

    assert.equal(uploadRes.status, 201);
    const uploadBody = await uploadRes.json();
    assert.equal(uploadBody.success, true);
    assert.ok(uploadBody.data.pending);
    const pendingItem = uploadBody.data.pending[0];
    const transferId = pendingItem.transferId;
    assert.ok(transferId);

    // File should NOT yet be in uploadDir
    const expectedFinalPath = path.join(uploadDir, 'photo_from_phone.jpg');
    assert.equal(
      fs.existsSync(expectedFinalPath),
      false,
      'File must not be in uploadDir before acceptance'
    );

    // 2. PC fetches pending list
    const pendingRes = await fetch(`${baseUrl}/api/upload/pending`);
    assert.equal(pendingRes.status, 200);
    const pendingList = await pendingRes.json();
    assert.ok(pendingList.data.some((p) => p.transferId === transferId));

    // 3. PC clicks Accept
    const decisionRes = await fetch(`${baseUrl}/api/upload/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transferId,
        action: 'accept',
      }),
    });

    assert.equal(decisionRes.status, 200);
    const decisionBody = await decisionRes.json();
    assert.equal(decisionBody.success, true);
    assert.equal(decisionBody.data.fileName, 'photo_from_phone.jpg');

    // File now exists in uploadDir
    assert.ok(fs.existsSync(expectedFinalPath), 'File must exist in uploadDir after acceptance');
    const savedContent = await fs.promises.readFile(expectedFinalPath, 'utf8');
    assert.equal(savedContent, payload);

    // Pending list is now cleared of this item
    const pendingResAfter = await fetch(`${baseUrl}/api/upload/pending`);
    const pendingListAfter = await pendingResAfter.json();
    assert.ok(!pendingListAfter.data.some((p) => p.transferId === transferId));
  });

  it('should immediately delete file and reject when PC user declines', async () => {
    const formData = new FormData();
    const payload = 'UNWANTED_SPAM_FILE_DATA';
    formData.append('files', new Blob([payload], { type: 'text/plain' }), 'unwanted_file.exe');

    const uploadRes = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      body: formData,
    });

    const uploadBody = await uploadRes.json();
    const transferId = uploadBody.data.pending[0].transferId;

    // PC declines
    const decisionRes = await fetch(`${baseUrl}/api/upload/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transferId,
        action: 'decline',
      }),
    });

    assert.equal(decisionRes.status, 200);
    const decisionBody = await decisionRes.json();
    assert.equal(decisionBody.data.declined, true);

    // Verify file does not exist in uploadDir
    const expectedFinalPath = path.join(uploadDir, 'unwanted_file.exe');
    assert.equal(fs.existsSync(expectedFinalPath), false);
  });

  it('should handle chunked upload complete staging and approval flow', async () => {
    const origChunkSize = config.chunkSize;
    config.chunkSize = 25; // 25 bytes per chunk

    try {
      const chunkData = Buffer.from('Chunked_Payload_Data_123456'); // 27 bytes -> 2 chunks
      const initRes = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: 'large_recording.mp4',
          fileSize: chunkData.length,
          mimeType: 'video/mp4',
        }),
      });

      const initBody = await initRes.json();
      const uploadId = initBody.data.uploadId;

      // Upload chunks
      const c0 = chunkData.subarray(0, 25);
      const c1 = chunkData.subarray(25);

      const f0 = new FormData();
      f0.append('uploadId', uploadId);
      f0.append('chunkIndex', '0');
      f0.append('chunk', new Blob([c0]), 'c0');
      await fetch(`${baseUrl}/api/upload/chunk`, { method: 'POST', body: f0 });

      const f1 = new FormData();
      f1.append('uploadId', uploadId);
      f1.append('chunkIndex', '1');
      f1.append('chunk', new Blob([c1]), 'c1');
      await fetch(`${baseUrl}/api/upload/chunk`, { method: 'POST', body: f1 });

      // Call complete
      const compRes = await fetch(`${baseUrl}/api/upload/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId }),
      });

      assert.equal(compRes.status, 200);
      const compBody = await compRes.json();
      assert.ok(compBody.data.transferId);
      const transferId = compBody.data.transferId;

      // Should not be in uploadDir yet
      const expectedPath = path.join(uploadDir, 'large_recording.mp4');
      assert.equal(fs.existsSync(expectedPath), false);

      // PC accepts
      await fetch(`${baseUrl}/api/upload/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transferId, action: 'accept' }),
      });

      assert.ok(fs.existsSync(expectedPath));
      const readContent = await fs.promises.readFile(expectedPath);
      assert.deepEqual(readContent, chunkData);
    } finally {
      config.chunkSize = origChunkSize;
    }
  });
});
