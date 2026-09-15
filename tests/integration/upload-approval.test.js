import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import { startServer } from '../../src/server.js';

describe('Upload Approval & Decision Integration Tests', () => {
  let serverInstance;
  let baseUrl;
  let tempDir;
  let uploadDir;
  let runtime;
  let hostHeaders;

  before(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-approval-test-'));
    uploadDir = path.join(tempDir, 'uploads');
    await fs.promises.mkdir(uploadDir, { recursive: true });

    serverInstance = await startServer({
      port: 0,
      host: '127.0.0.1',
      noBrowser: true,
      tempDir,
      uploadDir,
    });
    runtime = serverInstance.runtime;

    const addr = serverInstance.server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
    hostHeaders = { 'X-Host-Token': serverInstance.app.locals.hostAuth.token };
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
    runtime.shareManager.clear();
    await runtime.pendingUploadManager.cleanup();
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
    const pendingRes = await fetch(`${baseUrl}/api/upload/pending`, { headers: hostHeaders });
    assert.equal(pendingRes.status, 200);
    const pendingList = await pendingRes.json();
    assert.ok(pendingList.data.some((p) => p.transferId === transferId));

    // 3. PC clicks Accept
    const decisionRes = await fetch(`${baseUrl}/api/upload/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...hostHeaders },
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
    const pendingResAfter = await fetch(`${baseUrl}/api/upload/pending`, { headers: hostHeaders });
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
      headers: { 'Content-Type': 'application/json', ...hostHeaders },
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
    const origChunkSize = runtime.config.chunkSize;
    runtime.config.chunkSize = 25; // 25 bytes per chunk

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
        headers: { 'Content-Type': 'application/json', ...hostHeaders },
        body: JSON.stringify({ transferId, action: 'accept' }),
      });

      assert.ok(fs.existsSync(expectedPath));
      const readContent = await fs.promises.readFile(expectedPath);
      assert.deepEqual(readContent, chunkData);
    } finally {
      runtime.config.chunkSize = origChunkSize;
    }
  });

  it('should broadcast terminal event on TTL expiry and record outcome', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverInstance.server.address().port}/ws`);
    const receivedEvents = [];
    ws.on('message', (raw) => {
      try {
        receivedEvents.push(JSON.parse(raw));
      } catch {
        // ignore
      }
    });
    await new Promise((resolve) => ws.on('open', resolve));

    ws.send(
      JSON.stringify({
        event: 'client:register',
        data: { deviceName: 'TTL Observer', platform: 'linux' },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    const tempFile = path.join(tempDir, 'short_ttl.tmp');
    await fs.promises.writeFile(tempFile, 'TTL test data');
    const record = runtime.pendingUploadManager.createPending({
      fileName: 'short_ttl.txt',
      fileSize: 13,
      mimeType: 'text/plain',
      tempPath: tempFile,
      ttlMs: 150,
    });

    const statusPending = await fetch(`${baseUrl}/api/upload/pending/${record.transferId}`);
    assert.equal(statusPending.status, 200);
    const pendingJson = await statusPending.json();
    assert.equal(pendingJson.data.status, 'pending');

    // Wait for TTL to expire (250ms)
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Verify temp file deleted on disk
    assert.equal(fs.existsSync(tempFile), false);

    // Verify endpoint returns expired outcome
    const statusExpired = await fetch(`${baseUrl}/api/upload/pending/${record.transferId}`);
    assert.equal(statusExpired.status, 200);
    const expiredJson = await statusExpired.json();
    assert.equal(expiredJson.data.status, 'expired');
    assert.equal(expiredJson.data.reason, 'TIMEOUT');

    // Verify WebSocket broadcast
    const hasTimeoutEvent = receivedEvents.some(
      (e) =>
        (e.event === 'transfer:rejected' && e.data?.reason === 'TIMEOUT') ||
        e.event === 'transfer:expired'
    );
    assert.ok(hasTimeoutEvent, 'Expected timeout/expiry event broadcast over WS');

    ws.close();
  });
});
