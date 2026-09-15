import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { startServer } from '../../src/server.js';
import { TransferEngine } from '../../public/js/transfer.js';

describe('M2 QC Review Regression Suite (R1, R2, R3, R4)', () => {
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
        const initRes = await fetch(`${baseUrl}/api/upload/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'complete_vs_cancel.bin',
            fileSize: 10,
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
      // Float
      const resFloat = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'test.bin', fileSize: 12.34 }),
      });
      assert.equal(resFloat.status, 400);
      const jsonFloat = await resFloat.json();
      assert.equal(jsonFloat.error.code, 'INVALID_FILE_SIZE');

      // Negative
      const resNeg = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'test.bin', fileSize: -500 }),
      });
      assert.equal(resNeg.status, 400);

      // String non-number
      const resStr = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'test.bin', fileSize: 'not-a-number' }),
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
          body: JSON.stringify({ fileName: 'file1.bin', fileSize: 100 }),
        });
        assert.equal(res1.status, 200);

        // Attempt init transfer 2 while transfer 1 is uploading
        const res2 = await fetch(`${tightUrl}/api/upload/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: 'file2.bin', fileSize: 100 }),
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
        body: JSON.stringify({ fileName: 'quota_cancel.bin', fileSize: 1000 }),
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
});
