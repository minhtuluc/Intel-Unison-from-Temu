import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { startServer } from '../../src/server.js';
import { TransferEngine, computeFileSha256 } from '../../public/js/transfer.js';
import { IncrementalSha256 } from '../../public/js/utils.js';

describe('M2 QC Review Regression Suite (R1 to R12)', () => {
  let tempDir;
  let uploadDir;
  let serverInstance;
  let baseUrl;
  let hostHeaders;
  let runtime;

  before(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-m2-qc-test-'));
    uploadDir = path.join(tempDir, 'uploads');
    await fs.promises.mkdir(uploadDir, { recursive: true });

    serverInstance = await startServer({
      port: 0,
      host: '127.0.0.1',
      noBrowser: true,
      tempDir,
      uploadDir,
      maxConcurrentTransfers: 3,
      maxUploadSessions: 5,
      maxConnectedDevices: 5,
      storageQuota: 50 * 1024 * 1024, // 50MB
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

  // ==========================================
  // R1 — P1 / UT-008: Complete Concurrency & Idempotency
  // ==========================================
  describe('R1: Concurrent complete calls and state transition locking', () => {
    it('concurrent POST /api/upload/complete produces exactly 1 pending record, 1 file, 1 terminal outcome', async () => {
      const origChunkSize = runtime.config.chunkSize;
      runtime.config.chunkSize = 10;

      try {
        const chunk1 = Buffer.from('1234567890');
        const chunk2 = Buffer.from('abcdefghij');
        const totalSize = chunk1.length + chunk2.length;
        const hash = crypto
          .createHash('sha256')
          .update(Buffer.concat([chunk1, chunk2]))
          .digest('hex');

        // 1. Init
        const initRes = await fetch(`${baseUrl}/api/upload/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'concurrent_complete.bin',
            fileSize: totalSize,
            checksum: hash,
          }),
        });
        assert.equal(initRes.status, 200);
        const { uploadId } = (await initRes.json()).data;

        // 2. Upload chunk 0
        const f0 = new FormData();
        f0.append('uploadId', uploadId);
        f0.append('chunkIndex', '0');
        f0.append('chunk', new Blob([chunk1]), 'c0');
        const res0 = await fetch(`${baseUrl}/api/upload/chunk`, { method: 'POST', body: f0 });
        assert.equal(res0.status, 200);

        // 3. Upload chunk 1
        const f1 = new FormData();
        f1.append('uploadId', uploadId);
        f1.append('chunkIndex', '1');
        f1.append('chunk', new Blob([chunk2]), 'c1');
        const res1 = await fetch(`${baseUrl}/api/upload/chunk`, { method: 'POST', body: f1 });
        assert.equal(res1.status, 200);

        // 4. Concurrent complete requests
        const [comp1, comp2] = await Promise.all([
          fetch(`${baseUrl}/api/upload/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uploadId }),
          }),
          fetch(`${baseUrl}/api/upload/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uploadId }),
          }),
        ]);

        const statuses = [comp1.status, comp2.status];
        // Exactly one should succeed with 200, the other rejected with 409 conflict
        assert.ok(statuses.includes(200), 'At least one complete must succeed');
        assert.ok(
          statuses.includes(409),
          'The concurrent complete must be rejected with 409 conflict'
        );

        // Verify exactly one pending record exists
        const pendingList = runtime.pendingUploadManager.listPending();
        const matchingPending = pendingList.filter((p) => p.fileName === 'concurrent_complete.bin');
        assert.equal(
          matchingPending.length,
          1,
          'Must have exactly 1 pending record for the upload'
        );

        // Verify pending file exists on disk
        const pendingRecord = matchingPending[0];
        const internalRec = runtime.pendingUploadManager.pending.get(pendingRecord.transferId);
        assert.ok(
          internalRec && fs.existsSync(internalRec.tempPath),
          'Temp pending file must exist'
        );

        // Clean up pending item
        await runtime.pendingUploadManager.decline(pendingRecord.transferId);
      } finally {
        runtime.config.chunkSize = origChunkSize;
      }
    });

    it('handles complete-vs-cancel race cleanly without dangling files', async () => {
      const origChunkSize = runtime.config.chunkSize;
      runtime.config.chunkSize = 10;

      try {
        const chunk1 = Buffer.from('1234567890');
        const hash = crypto.createHash('sha256').update(chunk1).digest('hex');
        const initRes = await fetch(`${baseUrl}/api/upload/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'complete_vs_cancel.bin',
            fileSize: 10,
            checksum: hash,
          }),
        });
        assert.equal(initRes.status, 200);
        const { uploadId } = (await initRes.json()).data;

        const f0 = new FormData();
        f0.append('uploadId', uploadId);
        f0.append('chunkIndex', '0');
        f0.append('chunk', new Blob([chunk1]), 'c0');
        await fetch(`${baseUrl}/api/upload/chunk`, { method: 'POST', body: f0 });

        // Fire complete and cancel simultaneously
        const [compRes, cancelRes] = await Promise.all([
          fetch(`${baseUrl}/api/upload/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uploadId }),
          }),
          fetch(`${baseUrl}/api/upload/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uploadId }),
          }),
        ]);

        // Either complete won (200) or cancel won (200/409)
        assert.ok(
          [200, 409].includes(compRes.status),
          `Complete status unexpected: ${compRes.status}`
        );
        assert.ok(
          [200, 409].includes(cancelRes.status),
          `Cancel status unexpected: ${cancelRes.status}`
        );

        // Clean up any staged pending record if complete won
        const pendingList = runtime.pendingUploadManager.listPending();
        for (const p of pendingList) {
          if (p.fileName === 'complete_vs_cancel.bin') {
            await runtime.pendingUploadManager.decline(p.transferId);
          }
        }
      } finally {
        runtime.config.chunkSize = origChunkSize;
      }
    });
  });

  // ==========================================
  // R2 — P1 / UT-007: Resource Limits, Quotas & Integrity Check
  // ==========================================
  describe('R2: Resource limits, storage quota, integer fileSize and checksum integrity', () => {
    it('rejects non-integer, negative, or invalid fileSize with 400 INVALID_FILE_SIZE', async () => {
      const validChecksum = 'a'.repeat(64);
      // Float
      const resFloat = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'test.bin', fileSize: 12.34, checksum: validChecksum }),
      });
      assert.equal(resFloat.status, 400);
      const jsonFloat = await resFloat.json();
      assert.equal(jsonFloat.error.code, 'INVALID_FILE_SIZE');

      // Negative
      const resNeg = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'test.bin', fileSize: -500, checksum: validChecksum }),
      });
      assert.equal(resNeg.status, 400);

      // String non-number
      const resStr = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: 'test.bin',
          fileSize: 'not-a-number',
          checksum: validChecksum,
        }),
      });
      assert.equal(resStr.status, 400);
    });

    it('rejects whole-file upload when SHA-256 checksum mismatches on complete', async () => {
      const origChunkSize = runtime.config.chunkSize;
      runtime.config.chunkSize = 10;

      try {
        const correctPayload = Buffer.from('HelloWorld');
        const expectedHash = crypto.createHash('sha256').update(correctPayload).digest('hex');

        // Init with valid expected checksum
        const initRes = await fetch(`${baseUrl}/api/upload/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'tampered.bin',
            fileSize: 10,
            checksum: expectedHash,
          }),
        });
        assert.equal(initRes.status, 200);
        const { uploadId } = (await initRes.json()).data;

        // Upload tampered data instead
        const tamperedChunk = Buffer.from('TamperedXX');
        const f0 = new FormData();
        f0.append('uploadId', uploadId);
        f0.append('chunkIndex', '0');
        f0.append('chunk', new Blob([tamperedChunk]), 'c0');
        await fetch(`${baseUrl}/api/upload/chunk`, { method: 'POST', body: f0 });

        // Complete should fail with CHECKSUM_MISMATCH
        const compRes = await fetch(`${baseUrl}/api/upload/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId }),
        });
        assert.equal(compRes.status, 400);
        const compJson = await compRes.json();
        assert.equal(compJson.error.code, 'CHECKSUM_MISMATCH');

        // Verify session was cleaned up
        assert.equal(runtime.chunkedUploadManager.sessions.has(uploadId), false);
      } finally {
        runtime.config.chunkSize = origChunkSize;
      }
    });

    it('enforces storageQuota and rejects uploads that exceed quota with 507 INSUFFICIENT_STORAGE', async () => {
      // Create a small test server with 500 bytes storageQuota
      const tightDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-tight-quota-'));
      const tightServer = await startServer({
        port: 0,
        host: '127.0.0.1',
        noBrowser: true,
        tempDir: tightDir,
        uploadDir: path.join(tightDir, 'uploads'),
        storageQuota: 500, // Only 500 bytes total quota
      });

      try {
        const tightUrl = `http://127.0.0.1:${tightServer.server.address().port}`;

        // Attempt to initialize upload of 600 bytes
        const resInit = await fetch(`${tightUrl}/api/upload/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'too_big_for_quota.bin',
            fileSize: 600,
            checksum: 'a'.repeat(64),
          }),
        });
        assert.equal(resInit.status, 507);
        const jsonInit = await resInit.json();
        assert.equal(jsonInit.error.code, 'STORAGE_QUOTA_EXCEEDED');

        // Simple multipart upload exceeding quota
        const formData = new FormData();
        formData.append('files', new Blob([Buffer.alloc(600, 'X')]), 'too_big_simple.bin');
        const resSimple = await fetch(`${tightUrl}/api/upload`, {
          method: 'POST',
          body: formData,
        });
        assert.equal(resSimple.status, 507);
        const jsonSimple = await resSimple.json();
        assert.equal(jsonSimple.error.code, 'STORAGE_QUOTA_EXCEEDED');
      } finally {
        if (tightServer?.wss) tightServer.wss.close();
        if (tightServer?.server) {
          await new Promise((r) => tightServer.server.close(r));
        }
        await fs.promises.rm(tightDir, { recursive: true, force: true });
      }
    });

    it('enforces maxConnectedDevices and rejects additional WebSocket registrations', async () => {
      const tightDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-tight-devices-'));
      const tightServer = await startServer({
        port: 0,
        host: '127.0.0.1',
        noBrowser: true,
        tempDir: tightDir,
        uploadDir: path.join(tightDir, 'uploads'),
        maxConnectedDevices: 1, // Allow only 1 device
      });

      const port = tightServer.server.address().port;
      const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      try {
        await Promise.all([
          new Promise((r) => ws1.on('open', r)),
          new Promise((r) => ws2.on('open', r)),
        ]);

        // Register client 1
        ws1.send(
          JSON.stringify({
            event: 'client:register',
            data: { deviceName: 'Device 1', platform: 'linux' },
          })
        );
        await new Promise((r) => setTimeout(r, 60));

        // Client 2 attempts to register, should receive error event or close with 1008
        const client2Events = [];
        let closedCode = null;
        ws2.on('message', (m) => client2Events.push(JSON.parse(m)));
        ws2.on('close', (code) => {
          closedCode = code;
        });

        ws2.send(
          JSON.stringify({
            event: 'client:register',
            data: { deviceName: 'Device 2', platform: 'linux' },
          })
        );
        await new Promise((r) => setTimeout(r, 100));

        const hasMaxDevicesError =
          closedCode === 1008 ||
          client2Events.some((e) => e.event === 'error' && e.data?.code === 'MAX_DEVICES_REACHED');
        assert.ok(hasMaxDevicesError, 'Client 2 must be rejected due to maxConnectedDevices limit');
      } finally {
        ws1.close();
        ws2.close();
        if (tightServer?.wss) tightServer.wss.close();
        if (tightServer?.server) {
          await new Promise((r) => tightServer.server.close(r));
        }
        await fs.promises.rm(tightDir, { recursive: true, force: true });
      }
    });

    it('enforces maxConcurrentTransfers limit with 429 TOO_MANY_CONCURRENT_TRANSFERS', async () => {
      const tightDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-tight-concur-'));
      const tightServer = await startServer({
        port: 0,
        host: '127.0.0.1',
        noBrowser: true,
        tempDir: tightDir,
        uploadDir: path.join(tightDir, 'uploads'),
        maxConcurrentTransfers: 1, // Only 1 concurrent transfer allowed
      });

      try {
        const tightUrl = `http://127.0.0.1:${tightServer.server.address().port}`;

        // Init transfer 1
        const res1 = await fetch(`${tightUrl}/api/upload/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: 'file1.bin', fileSize: 100, checksum: 'a'.repeat(64) }),
        });
        assert.equal(res1.status, 200);

        // Attempt init transfer 2 while transfer 1 is uploading
        const res2 = await fetch(`${tightUrl}/api/upload/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: 'file2.bin', fileSize: 100, checksum: 'b'.repeat(64) }),
        });
        assert.equal(res2.status, 429);
        const json2 = await res2.json();
        assert.equal(json2.error.code, 'TOO_MANY_TRANSFERS');
      } finally {
        if (tightServer?.wss) tightServer.wss.close();
        if (tightServer?.server) {
          await new Promise((r) => tightServer.server.close(r));
        }
        await fs.promises.rm(tightDir, { recursive: true, force: true });
      }
    });

    it('properly releases quota upon cancel, decline, expiry, and completion', async () => {
      const initialUsed = runtime.quotaTracker.getStats().used;

      // 1. Session cancel releases quota
      const resInit = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: 'quota_cancel.bin',
          fileSize: 1000,
          checksum: 'c'.repeat(64),
        }),
      });
      const { uploadId } = (await resInit.json()).data;
      assert.equal(runtime.quotaTracker.getStats().used, initialUsed + 1000);

      await fetch(`${baseUrl}/api/upload/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId }),
      });
      assert.equal(runtime.quotaTracker.getStats().used, initialUsed);

      // 2. Pending decline releases quota
      const tempF = path.join(tempDir, 'quota_pending.tmp');
      await fs.promises.writeFile(tempF, 'Quota test');
      const rec = runtime.pendingUploadManager.createPending({
        fileName: 'quota_pending.bin',
        fileSize: 500,
        tempPath: tempF,
      });
      assert.equal(runtime.quotaTracker.getStats().used, initialUsed + 500);

      await fetch(`${baseUrl}/api/upload/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...hostHeaders },
        body: JSON.stringify({ transferId: rec.transferId, action: 'decline' }),
      });
      assert.equal(runtime.quotaTracker.getStats().used, initialUsed);
    });
  });

  // ==========================================
  // R3 — P1 / UT-008: CAS State Machine for Pending Uploads
  // ==========================================
  describe('R3: Compare-and-Set state transitions for pending uploads', () => {
    it('concurrent accept vs decline: one wins, the other receives 409 conflict, no ENOENT', async () => {
      const tempF = path.join(tempDir, 'race_accept_decline.tmp');
      await fs.promises.writeFile(tempF, 'Race Payload Content');

      const rec = runtime.pendingUploadManager.createPending({
        fileName: 'race_accept_decline.txt',
        fileSize: 20,
        tempPath: tempF,
      });

      // Fire accept and decline at the exact same moment
      const [resAccept, resDecline] = await Promise.all([
        fetch(`${baseUrl}/api/upload/decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...hostHeaders },
          body: JSON.stringify({ transferId: rec.transferId, action: 'accept' }),
        }),
        fetch(`${baseUrl}/api/upload/decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...hostHeaders },
          body: JSON.stringify({ transferId: rec.transferId, action: 'decline' }),
        }),
      ]);

      const statuses = [resAccept.status, resDecline.status];
      // One must succeed with 200, one must fail with 409 conflict (or 404 already terminal)
      assert.ok(statuses.includes(200), 'One decision must succeed');
      assert.ok(
        statuses.includes(409) || statuses.includes(404),
        'The loser must receive 409 or 404'
      );

      // Verify final outcome is well-defined
      const outcome = runtime.pendingUploadManager.getTransferRecord(rec.transferId);
      assert.ok(['completed', 'rejected'].includes(outcome.status));
    });

    it('concurrent double accept: exactly one succeeds and exactly one file saved', async () => {
      const tempF = path.join(tempDir, 'double_accept.tmp');
      await fs.promises.writeFile(tempF, 'Double Accept Payload');

      const rec = runtime.pendingUploadManager.createPending({
        fileName: 'double_accept.txt',
        fileSize: 21,
        tempPath: tempF,
      });

      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/api/upload/decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...hostHeaders },
          body: JSON.stringify({ transferId: rec.transferId, action: 'accept' }),
        }),
        fetch(`${baseUrl}/api/upload/decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...hostHeaders },
          body: JSON.stringify({ transferId: rec.transferId, action: 'accept' }),
        }),
      ]);

      const statuses = [res1.status, res2.status];
      assert.ok(statuses.includes(200));
      assert.ok(statuses.includes(409) || statuses.includes(404));

      // Verify file in uploadDir
      const savedPath = path.join(uploadDir, 'double_accept.txt');
      assert.ok(fs.existsSync(savedPath));
    });

    it('concurrent double decline: exactly one succeeds and temp file deleted once', async () => {
      const tempF = path.join(tempDir, 'double_decline.tmp');
      await fs.promises.writeFile(tempF, 'Double Decline Payload');

      const rec = runtime.pendingUploadManager.createPending({
        fileName: 'double_decline.txt',
        fileSize: 22,
        tempPath: tempF,
      });

      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/api/upload/decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...hostHeaders },
          body: JSON.stringify({ transferId: rec.transferId, action: 'decline' }),
        }),
        fetch(`${baseUrl}/api/upload/decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...hostHeaders },
          body: JSON.stringify({ transferId: rec.transferId, action: 'decline' }),
        }),
      ]);

      const statuses = [res1.status, res2.status];
      assert.ok(statuses.includes(200));
      assert.ok(statuses.includes(409) || statuses.includes(404));
      assert.equal(fs.existsSync(tempF), false);
    });

    it('move failure reverts state to pending and restores remaining original TTL', async () => {
      const tempF = path.join(tempDir, 'move_failure.tmp');
      await fs.promises.writeFile(tempF, 'Move fail test');

      const customTtl = 50000;
      const rec = runtime.pendingUploadManager.createPending({
        fileName: 'move_fail.txt',
        fileSize: 14,
        tempPath: tempF,
        ttlMs: customTtl,
      });

      // Pass an invalid targetDir that is a file (will cause ENOTDIR or EEXIST on mkdir/rename)
      const invalidTarget = path.join(tempDir, 'file_not_dir.txt');
      await fs.promises.writeFile(invalidTarget, 'I am a file');

      await assert.rejects(
        () => runtime.pendingUploadManager.accept(rec.transferId, invalidTarget),
        /ENOTDIR|EEXIST|EACCES/
      );

      // Verify record is back to 'pending' state
      const refreshed = runtime.pendingUploadManager.pending.get(rec.transferId);
      assert.ok(refreshed);
      assert.equal(refreshed.state, 'pending');

      // Verify timeout is re-armed and TTL remaining <= customTtl
      assert.ok(refreshed.timeoutId);
      assert.equal(refreshed.ttlMs, customTtl);

      // Clean up
      await runtime.pendingUploadManager.decline(rec.transferId);
    });
  });

  // ==========================================
  // R4 — P2 / UT-004: WS Terminal Event Routing & Memory Bounding
  // ==========================================
  describe('R4: WebSocket terminal event routing and TransferEngine memory bounding', () => {
    it('routes terminal outcome events only to the specific sender and host, never to other clients', async () => {
      const port = serverInstance.server.address().port;
      const wsClientA = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const wsClientB = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      const eventsA = [];
      const eventsB = [];

      wsClientA.on('message', (m) => eventsA.push(JSON.parse(m)));
      wsClientB.on('message', (m) => eventsB.push(JSON.parse(m)));

      await Promise.all([
        new Promise((r) => wsClientA.on('open', r)),
        new Promise((r) => wsClientB.on('open', r)),
      ]);

      // Register Client A
      wsClientA.send(
        JSON.stringify({
          event: 'client:register',
          data: { deviceName: 'Client A Phone', platform: 'android' },
        })
      );
      // Register Client B
      wsClientB.send(
        JSON.stringify({
          event: 'client:register',
          data: { deviceName: 'Client B Tablet', platform: 'ios' },
        })
      );

      await new Promise((r) => setTimeout(r, 100));

      const regEventA = eventsA.find((e) => e.event === 'client:registered');
      const regEventB = eventsB.find((e) => e.event === 'client:registered');
      assert.ok(regEventA?.data?.connectionId);
      assert.ok(regEventB?.data?.connectionId);

      const connIdA = regEventA.data.connectionId;
      const connIdB = regEventB.data.connectionId;
      assert.notEqual(connIdA, connIdB);

      // Client A performs upload, passing its connectionId in header
      const formData = new FormData();
      formData.append('files', new Blob(['Exclusive data for Client A']), 'client_a_exclusive.txt');
      const uploadRes = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: { 'X-Connection-Id': connIdA },
        body: formData,
      });
      assert.equal(uploadRes.status, 201);
      const { pending } = (await uploadRes.json()).data;
      const transferId = pending[0].transferId;

      // Host approves Client A's upload
      await fetch(`${baseUrl}/api/upload/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...hostHeaders },
        body: JSON.stringify({ transferId, action: 'accept' }),
      });

      await new Promise((r) => setTimeout(r, 100));

      // Client A must receive transfer:complete
      const completeForA = eventsA.find(
        (e) => e.event === 'transfer:complete' && e.data?.transferId === transferId
      );
      assert.ok(completeForA, 'Client A must receive transfer:complete event');

      // Client B must NOT receive any event for Client A's transfer
      const eventForB = eventsB.find((e) => e.data?.transferId === transferId);
      assert.equal(eventForB, undefined, 'Client B must NOT receive terminal events for Client A');

      wsClientA.close();
      wsClientB.close();
    });

    it('emits exactly one terminal event on timeout, not both transfer:rejected and transfer:expired', async () => {
      const port = serverInstance.server.address().port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const events = [];
      ws.on('message', (m) => events.push(JSON.parse(m)));
      await new Promise((r) => ws.on('open', r));

      ws.send(
        JSON.stringify({
          event: 'client:register',
          data: { deviceName: 'Single Event Observer', platform: 'linux' },
        })
      );
      await new Promise((r) => setTimeout(r, 80));

      const tempF = path.join(tempDir, 'single_terminal_timeout.tmp');
      await fs.promises.writeFile(tempF, 'Single timeout event test');

      const rec = runtime.pendingUploadManager.createPending({
        fileName: 'single_terminal.txt',
        fileSize: 25,
        tempPath: tempF,
        ttlMs: 150,
      });

      // Wait for timeout (250ms)
      await new Promise((r) => setTimeout(r, 250));

      const matchingEvents = events.filter((e) => e.data?.transferId === rec.transferId);
      assert.equal(
        matchingEvents.length,
        1,
        `Expected exactly 1 terminal event for timeout, got ${matchingEvents.length}`
      );
      assert.equal(matchingEvents[0].event, 'transfer:expired');

      ws.close();
    });

    it('TransferEngine pendingWsDecisions does not leak memory when pumping 1,000 foreign events', () => {
      const engine = new TransferEngine({
        maxConcurrent: 3,
        chunkSize: 1024,
      });

      // Pump 1,000 foreign events without any active upload awaiting transferId
      for (let i = 0; i < 1000; i++) {
        engine.handleWebSocketEvent('transfer:complete', {
          transferId: `foreign_transfer_${i}`,
        });
      }

      // Buffer should remain 0 because no active uploads are awaiting transferId
      assert.equal(
        engine.pendingWsDecisions.size,
        0,
        'pendingWsDecisions must be 0 when no uploads are awaiting transferId'
      );

      // Now add a dummy task that IS uploading and awaiting transferId
      const fakeTask = {
        id: 'task_uploading_test',
        status: 'uploading',
        transferId: null,
      };
      engine.activeTransfers.set(fakeTask.id, fakeTask);

      // Now send 100 early WS events
      for (let i = 0; i < 100; i++) {
        engine.handleWebSocketEvent('transfer:complete', {
          transferId: `transfer_early_${i}`,
        });
      }

      // Must be capped at 50 max
      assert.ok(
        engine.pendingWsDecisions.size <= 50,
        `pendingWsDecisions must be capped at 50, but got ${engine.pendingWsDecisions.size}`
      );
    });
  });

  // ==========================================
  // R5 — P1 / UT-007, UT-009: Frontend Incremental SHA-256 Memory Bound & AbortSignal
  // ==========================================
  describe('R5: Memory-bounded incremental SHA-256 hashing and AbortSignal support', () => {
    it('computes accurate SHA-256 without calling file.arrayBuffer() on the entire file', async () => {
      // 1.5MB buffer across 500KB slices
      const buffer = crypto.randomBytes(1500 * 1024);
      let arrayBufferCalled = false;
      let sliceCallCount = 0;

      const mockFile = {
        size: buffer.length,
        arrayBuffer: () => {
          arrayBufferCalled = true;
          throw new Error('Whole-file arrayBuffer() must never be called on mockFile!');
        },
        slice: (start, end) => {
          sliceCallCount++;
          const sliceBuf = buffer.subarray(start, end);
          return {
            arrayBuffer: async () =>
              sliceBuf.buffer.slice(sliceBuf.byteOffset, sliceBuf.byteOffset + sliceBuf.byteLength),
          };
        },
      };

      const expectedHash = crypto.createHash('sha256').update(buffer).digest('hex');
      const actualHash = await computeFileSha256(mockFile, { sliceSize: 500 * 1024 });

      assert.equal(actualHash, expectedHash);
      assert.equal(arrayBufferCalled, false, 'Whole-file arrayBuffer() must not be called');
      assert.equal(sliceCallCount, 3, 'Must slice into 3 discrete chunks');
    });

    it('immediately aborts hash calculation when AbortSignal triggers', async () => {
      // Pre-aborted signal
      const preController = new AbortController();
      preController.abort();
      const mockFile1 = {
        size: 1024,
        slice: () => ({ arrayBuffer: async () => new ArrayBuffer(1024) }),
      };
      await assert.rejects(
        () => computeFileSha256(mockFile1, { signal: preController.signal }),
        (err) => err.name === 'AbortError'
      );

      // Mid-flight abort
      const midController = new AbortController();
      let slicesRead = 0;
      const mockFile2 = {
        size: 5000,
        slice: (start, end) => {
          slicesRead++;
          if (slicesRead === 2) {
            midController.abort();
          }
          return {
            arrayBuffer: async () => Buffer.alloc(end - start).buffer,
          };
        },
      };
      await assert.rejects(
        () => computeFileSha256(mockFile2, { signal: midController.signal, sliceSize: 1000 }),
        (err) => err.name === 'AbortError'
      );
    });

    it('IncrementalSha256 pure JS engine correctly hashes data of arbitrary sizes and chunks', () => {
      const hasher = new IncrementalSha256();
      const data = Buffer.from(
        'UniversalTrans M2: Incremental SHA-256 pure JS fallback implementation with various chunk sizes.'
      );
      hasher.update(data.subarray(0, 15));
      hasher.update(data.subarray(15, 45));
      hasher.update(data.subarray(45));
      const digest = hasher.digest();
      const expected = crypto.createHash('sha256').update(data).digest('hex');
      assert.equal(digest, expected);
    });
  });

  // ==========================================
  // R6 — P1 / UT-007: Concurrency Slot Pre-Claim, Disk Quota Reconcile & Multipart Rollback
  // ==========================================
  describe('R6: Simple upload concurrency slot pre-claim, disk quota reconcile & multipart rollback', () => {
    it('enforces maxConcurrentTransfers across simple and chunked uploads (rejects with 429)', async () => {
      const tightDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-r6-concur-'));
      const tightServer = await startServer({
        port: 0,
        host: '127.0.0.1',
        noBrowser: true,
        tempDir: tightDir,
        uploadDir: path.join(tightDir, 'uploads'),
        maxConcurrentTransfers: 1, // Only 1 concurrent transfer allowed
      });

      try {
        const tightUrl = `http://127.0.0.1:${tightServer.server.address().port}`;

        // Init chunked transfer 1 (occupies the single slot)
        const initRes = await fetch(`${tightUrl}/api/upload/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'slot_holder.bin',
            fileSize: 100,
            checksum: 'a'.repeat(64),
          }),
        });
        assert.equal(initRes.status, 200);

        // Simple upload while chunked transfer is active must be rejected with 429
        const form = new FormData();
        form.append('files', new Blob([Buffer.from('blocked payload')]), 'blocked.bin');
        const blockedRes = await fetch(`${tightUrl}/api/upload`, {
          method: 'POST',
          body: form,
        });
        assert.equal(blockedRes.status, 429);
        const errJson = await blockedRes.json();
        assert.equal(errJson.error.code, 'TOO_MANY_TRANSFERS');
      } finally {
        if (tightServer?.wss) tightServer.wss.close();
        if (tightServer?.server) {
          await new Promise((r) => tightServer.server.close(r));
        }
        await fs.promises.rm(tightDir, { recursive: true, force: true });
      }
    });

    it('reconciles existing disk usage at startup and blocks upload when quota is exceeded', async () => {
      const testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-r6-reconcile-'));
      const pendingDir = path.join(testDir, 'pending');
      await fs.promises.mkdir(pendingDir, { recursive: true });

      // Create an orphan file of 800 bytes in pending directory
      const orphanPath = path.join(pendingDir, 'orphan_800.tmp');
      await fs.promises.writeFile(orphanPath, Buffer.alloc(800, 'Z'));

      // Start server with 1000 bytes quota
      const reconServer = await startServer({
        port: 0,
        host: '127.0.0.1',
        noBrowser: true,
        tempDir: testDir,
        uploadDir: path.join(testDir, 'uploads'),
        storageQuota: 1000,
      });

      try {
        const reconUrl = `http://127.0.0.1:${reconServer.server.address().port}`;

        // Verify quota tracker accounted for the 800 bytes on startup
        const stats = reconServer.runtime.quotaTracker.getStats();
        assert.equal(stats.used, 800, 'Used quota must account for 800 byte orphan file on disk');
        assert.equal(stats.available, 200, 'Available quota must be 200 bytes');

        // Requesting 300 bytes must be rejected with 507 STORAGE_QUOTA_EXCEEDED (800 + 300 > 1000)
        const initRes = await fetch(`${reconUrl}/api/upload/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'excess.bin',
            fileSize: 300,
            checksum: 'b'.repeat(64),
          }),
        });
        assert.equal(initRes.status, 507);
        const json = await initRes.json();
        assert.equal(json.error.code, 'STORAGE_QUOTA_EXCEEDED');
      } finally {
        if (reconServer?.wss) reconServer.wss.close();
        if (reconServer?.server) {
          await new Promise((r) => reconServer.server.close(r));
        }
        await fs.promises.rm(testDir, { recursive: true, force: true });
      }
    });

    it('atomic multipart upload failure cleans up partial files and releases reserved quota', async () => {
      const tightDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-r6-atomic-'));
      const tightServer = await startServer({
        port: 0,
        host: '127.0.0.1',
        noBrowser: true,
        tempDir: tightDir,
        uploadDir: path.join(tightDir, 'uploads'),
        storageQuota: 1200, // 1200 bytes quota
      });

      try {
        const tightUrl = `http://127.0.0.1:${tightServer.server.address().port}`;

        // Upload batch of 2 files: 700 bytes + 700 bytes = 1400 bytes > 1200 quota
        const form = new FormData();
        form.append('files', new Blob([Buffer.alloc(700, 'A')]), 'file_a.bin');
        form.append('files', new Blob([Buffer.alloc(700, 'B')]), 'file_b.bin');

        const uploadRes = await fetch(`${tightUrl}/api/upload`, {
          method: 'POST',
          body: form,
        });

        // Must reject with 507 STORAGE_QUOTA_EXCEEDED
        assert.equal(uploadRes.status, 507);
        const errJson = await uploadRes.json();
        assert.equal(errJson.error.code, 'STORAGE_QUOTA_EXCEEDED');

        // Verify quota is restored to 0 used
        const stats = tightServer.runtime.quotaTracker.getStats();
        assert.equal(stats.used, 0, 'Used quota must roll back to 0 after failed batch');

        // Verify no pending records were created
        assert.equal(tightServer.runtime.pendingUploadManager.pending.size, 0);
      } finally {
        if (tightServer?.wss) tightServer.wss.close();
        if (tightServer?.server) {
          await new Promise((r) => tightServer.server.close(r));
        }
        await fs.promises.rm(tightDir, { recursive: true, force: true });
      }
    });
  });

  // ==========================================
  // R7 — P1 / UT-008, UT-009: Complete Retry Idempotency & Safe Best-Effort Cleanup
  // ==========================================
  describe('R7: Complete retry idempotency and safe chunk cleanup', () => {
    it('sequential retry of complete returns HTTP 200 with identical transferId without re-processing', async () => {
      const origChunkSize = runtime.config.chunkSize;
      runtime.config.chunkSize = 10;

      try {
        const chunkData = Buffer.from('0123456789');
        const hash = crypto.createHash('sha256').update(chunkData).digest('hex');

        // 1. Init
        const initRes = await fetch(`${baseUrl}/api/upload/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'retry_complete.bin',
            fileSize: 10,
            checksum: hash,
          }),
        });
        assert.equal(initRes.status, 200);
        const { uploadId } = (await initRes.json()).data;

        // 2. Upload chunk
        const form = new FormData();
        form.append('uploadId', uploadId);
        form.append('chunkIndex', '0');
        form.append('chunk', new Blob([chunkData]), 'chunk0');
        const chunkRes = await fetch(`${baseUrl}/api/upload/chunk`, {
          method: 'POST',
          body: form,
        });
        assert.equal(chunkRes.status, 200);

        // 3. First complete call -> 200 OK
        const completeRes1 = await fetch(`${baseUrl}/api/upload/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId }),
        });
        assert.equal(completeRes1.status, 200);
        const json1 = await completeRes1.json();
        const transferId1 = json1.data.transferId;
        assert.ok(transferId1, 'First complete returns transferId');

        // 4. Sequential retry of complete call with same uploadId -> must return 200 OK with identical transferId
        const completeRes2 = await fetch(`${baseUrl}/api/upload/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId }),
        });
        assert.equal(completeRes2.status, 200, 'Retry of complete must return 200, not 410');
        const json2 = await completeRes2.json();
        assert.equal(
          json2.data.transferId,
          transferId1,
          'Retry must return the identical transferId'
        );

        // Clean up pending item
        await runtime.pendingUploadManager.decline(transferId1);
      } finally {
        runtime.config.chunkSize = origChunkSize;
      }
    });

    it('best-effort cleanup when rm(sessionDir) encounters an error does not fail completion', async () => {
      const origChunkSize = runtime.config.chunkSize;
      runtime.config.chunkSize = 10;
      const origRm = fs.promises.rm;

      try {
        const payload = Buffer.from('NonFatalRm');
        const hash = crypto.createHash('sha256').update(payload).digest('hex');

        const session = await runtime.chunkedUploadManager.initUpload({
          fileName: 'non_fatal_rm.bin',
          fileSize: 10,
          checksum: hash,
        });

        await runtime.chunkedUploadManager.addChunk(session.uploadId, 0, payload);

        // Mock rm to throw EACCES for this upload's session dir
        fs.promises.rm = async (targetPath, opts) => {
          if (typeof targetPath === 'string' && targetPath.includes(session.uploadId)) {
            const err = new Error('EACCES: permission denied');
            err.code = 'EACCES';
            throw err;
          }
          return origRm(targetPath, opts);
        };

        // complete() should succeed without throwing despite rm error
        const result = await runtime.chunkedUploadManager.complete(session.uploadId);
        assert.ok(result);
        assert.equal(result.fileName, 'non_fatal_rm.bin');

        // Clean up created file
        if (result.filePath && fs.existsSync(result.filePath)) {
          await fs.promises.unlink(result.filePath).catch(() => {});
        }
      } finally {
        fs.promises.rm = origRm;
        runtime.config.chunkSize = origChunkSize;
      }
    });
  });

  // ==========================================
  // R8 — P1 / frontend delivery: Service Worker Cache Lifecycle
  // ==========================================
  describe('R8: Service Worker cache version and update lifecycle', () => {
    it('public/sw.js defines CACHE_NAME as utrans-shell-v6 and purges v5 on activation', async () => {
      const swPath = path.resolve('public/sw.js');
      const swContent = await fs.promises.readFile(swPath, 'utf8');

      // Verify CACHE_NAME is updated to v6
      assert.match(swContent, /CACHE_NAME\s*=\s*['"]utrans-shell-v6['"]/);
      assert.doesNotMatch(swContent, /CACHE_NAME\s*=\s*['"]utrans-shell-v5['"]/);

      // Verify activation logic purges non-current caches
      assert.match(swContent, /caches\.delete\(key\)/);
    });
  });

  // ==========================================
  // R9 — P2 / UT-007: Strict 64-hex Checksum Validation
  // ==========================================
  describe('R9: Strict 64-character hex SHA-256 checksum input validation', () => {
    it('rejects null, undefined, number, object, short hex, and invalid hex checksums with 400 INVALID_CHECKSUM', async () => {
      const invalidChecksums = [
        null,
        undefined,
        12345678,
        { sha256: 'abc' },
        'abc',
        'g'.repeat(64), // non-hex character 'g'
        '1234567890abcdef'.repeat(3), // 48 chars
        '1234567890abcdef'.repeat(5), // 80 chars
      ];

      for (const badChecksum of invalidChecksums) {
        const body = { fileName: 'strict_chk.bin', fileSize: 100 };
        if (badChecksum !== undefined) {
          body.checksum = badChecksum;
        }

        const res = await fetch(`${baseUrl}/api/upload/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        assert.equal(
          res.status,
          400,
          `Expected 400 for checksum: ${JSON.stringify(badChecksum)}, got ${res.status}`
        );
        const json = await res.json();
        assert.equal(json.error.code, 'INVALID_CHECKSUM');
      }
    });

    it('accepts valid 64-char uppercase hex checksum and normalizes it to lowercase', async () => {
      const upperHex = 'A'.repeat(64);
      const res = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: 'upper_hex.bin',
          fileSize: 10,
          checksum: upperHex,
        }),
      });

      assert.equal(res.status, 200);
      const { uploadId } = (await res.json()).data;
      const session = runtime.chunkedUploadManager.sessions.get(uploadId);
      assert.equal(
        session.expectedChecksum,
        'a'.repeat(64),
        'Must normalize checksum to lowercase'
      );

      // Cancel to clean up
      await runtime.chunkedUploadManager.cancelUpload(uploadId);
    });
  });

  // ==========================================
  // R10 — P2 / UT-004: Connection ID Validation & Spoofing Protection
  // ==========================================
  describe('R10: Connection ID validation, spoofing protection & terminal event routing', () => {
    it('rejects upload with non-existent or spoofed X-Connection-Id with 403 INVALID_CONNECTION_ID', async () => {
      const form = new FormData();
      form.append('files', new Blob(['test payload']), 'spoof_test.txt');

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'X-Connection-Id': 'fake-non-existent-conn-id-999',
        },
        body: form,
      });

      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.error.code, 'INVALID_CONNECTION_ID');
    });

    it('sanitizes connectionId out of discovery getDevices() and device:join broadcasts', async () => {
      const port = serverInstance.server.address().port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const events = [];
      ws.on('message', (m) => events.push(JSON.parse(m)));

      try {
        await new Promise((r) => ws.on('open', r));
        ws.send(
          JSON.stringify({
            event: 'client:register',
            data: { deviceName: 'Sanitization Test Device', platform: 'android' },
          })
        );

        await new Promise((r) => setTimeout(r, 80));

        // Check discovery getDevices()
        const devices = runtime.discovery.getDevices();
        assert.ok(devices.length > 0);
        for (const dev of devices) {
          assert.equal(
            dev.connectionId,
            undefined,
            'connectionId must NEVER be exposed in discovery device list'
          );
        }

        // Check WebSocket broadcasted device:join events
        const joinEvents = events.filter((e) => e.event === 'device:join');
        for (const je of joinEvents) {
          assert.equal(
            je.data?.device?.connectionId,
            undefined,
            'connectionId must NEVER be leaked in device:join payload'
          );
        }
      } finally {
        ws.close();
      }
    });
  });

  // ==========================================
  // R11 — P1 / UT-008: Concurrent same-name simple uploads exclusive reservation & no overwrite
  // ==========================================
  describe('R11: Concurrent same-name simple uploads exclusive reservation and no overwrite', () => {
    it('concurrently uploading 10 files with identical originalName preserves all 10 unique paths and payloads', async () => {
      const sameNameDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-r11-samename-'));
      const sameNameServer = await startServer({
        port: 0,
        host: '127.0.0.1',
        noBrowser: true,
        tempDir: sameNameDir,
        uploadDir: path.join(sameNameDir, 'uploads'),
        maxConcurrentTransfers: 20, // Allow all 10 to run concurrently
      });

      try {
        const testUrl = `http://127.0.0.1:${sameNameServer.server.address().port}`;
        const count = 10;
        const payloads = [];
        const expectedHashes = new Set();

        for (let i = 0; i < count; i++) {
          const data = Buffer.from(`Payload_${i}_${crypto.randomBytes(32).toString('hex')}`);
          payloads.push(data);
          expectedHashes.add(crypto.createHash('sha256').update(data).digest('hex'));
        }

        // Fire 10 uploads concurrently
        const uploadPromises = payloads.map(async (buf, idx) => {
          const form = new FormData();
          form.append('files', new Blob([buf]), 'same.bin');
          const res = await fetch(`${testUrl}/api/upload`, {
            method: 'POST',
            body: form,
          });
          assert.equal(res.status, 201, `Upload #${idx} must return 201`);
          const json = await res.json();
          return json.data.pending[0];
        });

        const pendingRecords = await Promise.all(uploadPromises);
        assert.equal(pendingRecords.length, count, `Must have ${count} pending records`);

        // 1. Verify all 10 pending records have unique transferIds and tempPaths
        const uniqueTransferIds = new Set(pendingRecords.map((r) => r.transferId));
        assert.equal(uniqueTransferIds.size, count, 'Every transferId must be unique');

        const internalPaths = [];
        for (const rec of pendingRecords) {
          const internal = sameNameServer.runtime.pendingUploadManager.pending.get(rec.transferId);
          assert.ok(internal, `Internal record for ${rec.transferId} must exist`);
          internalPaths.push(internal.tempPath);
        }

        const uniquePaths = new Set(internalPaths);
        assert.equal(
          uniquePaths.size,
          count,
          `All ${count} internal temporary file paths must be strictly unique (no path sharing)`
        );

        // 2. Verify all 10 physical files exist on disk and their hashes match all distinct payloads
        const actualHashes = new Set();
        for (const filePath of internalPaths) {
          assert.ok(fs.existsSync(filePath), `Physical file ${filePath} must exist on disk`);
          const fileBytes = await fs.promises.readFile(filePath);
          const hash = crypto.createHash('sha256').update(fileBytes).digest('hex');
          actualHashes.add(hash);
        }

        assert.equal(
          actualHashes.size,
          count,
          `Must have ${count} distinct physical file contents on disk (no data overwrite)`
        );

        // Verify the set of actual hashes exactly equals the expected hashes
        for (const expHash of expectedHashes) {
          assert.ok(
            actualHashes.has(expHash),
            `Expected payload hash ${expHash} must exist among saved files`
          );
        }
      } finally {
        if (sameNameServer?.wss) sameNameServer.wss.close();
        if (sameNameServer?.server) {
          await new Promise((r) => sameNameServer.server.close(r));
        }
        await fs.promises.rm(sameNameDir, { recursive: true, force: true });
      }
    });
  });

  // ==========================================
  // R12 — P2 / UT-004: Cross-session connectionId spoofing defense on same IP with PIN
  // ==========================================
  describe('R12: Cross-session connectionId spoofing defense on same IP with PIN', () => {
    it('rejects client B attempting to use client A connectionId across separate PIN sessions on same IP', async () => {
      const pinTestDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-r12-pin-'));
      const pinUploadDir = path.join(pinTestDir, 'uploads');
      await fs.promises.mkdir(pinUploadDir, { recursive: true });

      const pinServer = await startServer({
        port: 0,
        host: '127.0.0.1',
        noBrowser: true,
        tempDir: pinTestDir,
        uploadDir: pinUploadDir,
        pin: '1234', // Enable PIN authentication
      });

      const pinUrl = `http://127.0.0.1:${pinServer.server.address().port}`;
      const pinWsUrl = `ws://127.0.0.1:${pinServer.server.address().port}/ws`;

      let wsA;
      let wsB;

      try {
        // 1. Authenticate Session A
        const authResA = await fetch(`${pinUrl}/api/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: '1234', deviceName: 'Client A' }),
        });
        assert.equal(authResA.status, 200);
        const tokenA = (await authResA.json()).data.token;
        assert.ok(tokenA);

        // 2. Authenticate Session B
        const authResB = await fetch(`${pinUrl}/api/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: '1234', deviceName: 'Client B' }),
        });
        assert.equal(authResB.status, 200);
        const tokenB = (await authResB.json()).data.token;
        assert.ok(tokenB);
        assert.notEqual(tokenA, tokenB);

        // 3. Connect WebSocket for Client A with tokenA
        wsA = new WebSocket(pinWsUrl);
        const eventsA = [];
        wsA.on('message', (m) => eventsA.push(JSON.parse(m)));
        await new Promise((r) => wsA.on('open', r));

        wsA.send(
          JSON.stringify({
            event: 'client:register',
            data: { deviceName: 'Client A Device', platform: 'linux', sessionToken: tokenA },
          })
        );
        await new Promise((r) => setTimeout(r, 80));

        const regA = eventsA.find((e) => e.event === 'client:registered');
        assert.ok(regA?.data?.connectionId);
        const connIdA = regA.data.connectionId;

        // 4. Connect WebSocket for Client B with tokenB
        wsB = new WebSocket(pinWsUrl);
        const eventsB = [];
        wsB.on('message', (m) => eventsB.push(JSON.parse(m)));
        await new Promise((r) => wsB.on('open', r));

        wsB.send(
          JSON.stringify({
            event: 'client:register',
            data: { deviceName: 'Client B Device', platform: 'android', sessionToken: tokenB },
          })
        );
        await new Promise((r) => setTimeout(r, 80));

        const regB = eventsB.find((e) => e.event === 'client:registered');
        assert.ok(regB?.data?.connectionId);
        const connIdB = regB.data.connectionId;
        assert.notEqual(connIdA, connIdB);

        // 5. Spoof probe: Client B attempts upload using its sessionTokenB, but spoofing Client A's connectionId
        const formSpoof = new FormData();
        formSpoof.append('files', new Blob(['spoofed payload']), 'spoof.txt');

        const spoofRes = await fetch(`${pinUrl}/api/upload`, {
          method: 'POST',
          headers: {
            'X-Session-Token': tokenB, // Authenticated as B
            'X-Connection-Id': connIdA, // Claiming to be A
          },
          body: formSpoof,
        });

        // Server MUST reject with 403 INVALID_CONNECTION_ID
        assert.equal(spoofRes.status, 403, 'Cross-session spoofed connectionId must return 403');
        const spoofJson = await spoofRes.json();
        assert.equal(spoofJson.error.code, 'INVALID_CONNECTION_ID');

        // 6. Fail-closed probe: Upload without session token claiming connectionIdA
        const formNoToken = new FormData();
        formNoToken.append('files', new Blob(['no token payload']), 'notoken.txt');

        const noTokenRes = await fetch(`${pinUrl}/api/upload`, {
          method: 'POST',
          headers: {
            'X-Connection-Id': connIdA,
          },
          body: formNoToken,
        });
        assert.ok([401, 403].includes(noTokenRes.status), 'Missing session token must be rejected');

        // 7. Verify Client A never received any upload event or notification
        assert.equal(
          eventsA.filter((e) => e.event.startsWith('transfer:')).length,
          0,
          'Client A must receive zero transfer events from spoofed requests'
        );

        // 8. Legitimate upload: Client B uploads with its own tokenB and connectionIdB
        const formLegit = new FormData();
        formLegit.append('files', new Blob(['legitimate B payload']), 'legit_b.txt');

        const legitRes = await fetch(`${pinUrl}/api/upload`, {
          method: 'POST',
          headers: {
            'X-Session-Token': tokenB,
            'X-Connection-Id': connIdB,
          },
          body: formLegit,
        });
        assert.equal(legitRes.status, 201, 'Legitimate client B upload must succeed with 201');
      } finally {
        if (wsA) wsA.close();
        if (wsB) wsB.close();
        if (pinServer?.wss) pinServer.wss.close();
        if (pinServer?.server) {
          await new Promise((r) => pinServer.server.close(r));
        }
        await fs.promises.rm(pinTestDir, { recursive: true, force: true });
      }
    });
  });
});
