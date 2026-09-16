import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { startServer } from '../../src/server.js';

describe('Upload Approval & Decision Integration Tests', () => {
  let serverInstance;
  let baseUrl;
  let tempDir;
  let uploadDir;
  let runtime;
  let hostHeaders;
  let clientConnectionId;
  let clientWs;

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

    clientWs = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    const registered = new Promise((resolve) => {
      clientWs.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.event === 'client:registered') resolve(message.data.connectionId);
      });
    });
    await new Promise((resolve) => clientWs.on('open', resolve));
    clientWs.send(
      JSON.stringify({
        event: 'client:register',
        data: { deviceName: 'Approval Test Client', platform: 'test' },
      })
    );
    clientConnectionId = await registered;
  });

  after(async () => {
    clientWs?.terminate();
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

  it('should keep a mobile upload off disk until the host approves the offer', async () => {
    const payload = 'SECRET_PHOTO_PAYLOAD_12345';
    const expectedFinalPath = path.join(uploadDir, 'photo_from_phone.jpg');

    // 1. The phone announces what it wants to send. No payload moves yet.
    const offerRes = await fetch(`${baseUrl}/api/transfer/offer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': 'dev_phone_1',
        'x-device-name': 'Pixel Phone',
        'x-platform': 'android',
        'X-Connection-Id': clientConnectionId,
      },
      body: JSON.stringify({
        files: [{ name: 'photo_from_phone.jpg', size: payload.length, mimeType: 'text/plain' }],
      }),
    });
    assert.equal(offerRes.status, 201);
    const offer = (await offerRes.json()).data.offer;
    assert.equal(offer.state, 'pending');
    // The device label is display-only and must never be treated as identity.
    assert.equal(offer.sender.label, 'Pixel Phone');
    assert.equal(offer.sender.labelUntrusted, true);

    // 2. The host can see the offer, and nothing has reached the receive dir.
    const offersRes = await fetch(`${baseUrl}/api/transfer/offers`, { headers: hostHeaders });
    assert.equal(offersRes.status, 200);
    assert.ok((await offersRes.json()).data.some((o) => o.offerId === offer.offerId));
    assert.equal(
      fs.existsSync(expectedFinalPath),
      false,
      'File must not be in uploadDir before the host approves'
    );

    // 3. The host approves this file, which issues the grant that unlocks the write path.
    const decisionRes = await fetch(`${baseUrl}/api/transfer/offer/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...hostHeaders },
      body: JSON.stringify({
        offerId: offer.offerId,
        decisions: [{ index: 0, action: 'approve' }],
      }),
    });
    assert.equal(decisionRes.status, 200);
    const grantId = (await decisionRes.json()).data.decisions[0].grantId;
    assert.ok(grantId);

    // 4. Only now can the payload move.
    const formData = new FormData();
    formData.append('files', new Blob([payload], { type: 'text/plain' }), 'photo_from_phone.jpg');
    const uploadRes = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: {
        'X-Transfer-Grant': grantId,
        'X-Connection-Id': clientConnectionId,
      },
      body: formData,
    });
    assert.equal(uploadRes.status, 201);

    // Consent already happened, so the file is saved rather than queued for a second prompt.
    assert.ok(fs.existsSync(expectedFinalPath), 'File must exist in uploadDir once approved');
    assert.equal(await fs.promises.readFile(expectedFinalPath, 'utf8'), payload);
    assert.equal((await uploadRes.json()).data.pending.length, 0);
  });

  it('should reject a file at offer time so no payload is ever written', async () => {
    const payload = 'UNWANTED_SPAM_FILE_DATA';
    const expectedFinalPath = path.join(uploadDir, 'unwanted_file.exe');

    const offerRes = await fetch(`${baseUrl}/api/transfer/offer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Connection-Id': clientConnectionId,
      },
      body: JSON.stringify({ files: [{ name: 'unwanted_file.exe', size: payload.length }] }),
    });
    const offer = (await offerRes.json()).data.offer;

    // The host rejects this file; no grant is issued for it.
    const decisionRes = await fetch(`${baseUrl}/api/transfer/offer/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...hostHeaders },
      body: JSON.stringify({
        offerId: offer.offerId,
        decisions: [{ index: 0, action: 'reject' }],
      }),
    });
    assert.equal(decisionRes.status, 200);
    const decision = (await decisionRes.json()).data.decisions[0];
    assert.equal(decision.decision, 'rejected');
    assert.equal(decision.grantId, null);

    // Without a grant the upload is refused at the gate, before Multer parses anything.
    const formData = new FormData();
    formData.append('files', new Blob([payload]), 'unwanted_file.exe');
    const uploadRes = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: formData });
    assert.equal(uploadRes.status, 428);
    assert.equal((await uploadRes.json()).error.code, 'TRANSFER_GRANT_REQUIRED');

    assert.equal(fs.existsSync(expectedFinalPath), false);
    const pendingDir = path.join(tempDir, 'pending');
    const staged = fs.existsSync(pendingDir) ? await fs.promises.readdir(pendingDir) : [];
    assert.equal(
      staged.some((name) => name.includes('unwanted_file')),
      false,
      'a rejected file must not reach temp staging'
    );
  });

  it('should stage a host chunked upload in pending until the host accepts', async () => {
    const origChunkSize = runtime.config.chunkSize;
    runtime.config.chunkSize = 25; // 25 bytes per chunk

    try {
      const chunkData = Buffer.from('Chunked_Payload_Data_123456'); // 27 bytes -> 2 chunks
      const checksum = crypto.createHash('sha256').update(chunkData).digest('hex');
      // Host authority bypasses consent: the host is not asked to approve itself,
      // so this flow keeps exercising the pending + accept path.
      const initRes = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...hostHeaders },
        body: JSON.stringify({
          fileName: 'large_recording.mp4',
          fileSize: chunkData.length,
          mimeType: 'video/mp4',
          checksum,
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
      await fetch(`${baseUrl}/api/upload/chunk`, {
        method: 'POST',
        headers: { 'X-Upload-Id': uploadId, ...hostHeaders },
        body: f0,
      });

      const f1 = new FormData();
      f1.append('uploadId', uploadId);
      f1.append('chunkIndex', '1');
      f1.append('chunk', new Blob([c1]), 'c1');
      await fetch(`${baseUrl}/api/upload/chunk`, {
        method: 'POST',
        headers: { 'X-Upload-Id': uploadId, ...hostHeaders },
        body: f1,
      });

      // Call complete
      const compRes = await fetch(`${baseUrl}/api/upload/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...hostHeaders },
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
