import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { startServer } from '../../src/server.js';

describe('M3 QC Review Regression Suite (M3-QC-01 to M3-QC-04)', () => {
  let tempDir;
  let uploadDir;
  let serverInstance;
  let baseUrl;
  let hostToken;
  const pin = '1234';
  let tokenA;
  let tokenB;
  let wsA;
  let wsB;
  let connIdA;
  let connIdB;

  /** Helper to connect and register a WebSocket client with PIN session */
  function connectWs(port, sessionToken, deviceName, platform) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      let connId = null;

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            event: 'client:register',
            data: {
              deviceName,
              platform,
              sessionToken,
            },
          })
        );
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.event === 'client:registered') {
            connId = msg.data.connectionId;
            resolve({ ws, connId });
          } else if (msg.event === 'client:rejected') {
            reject(new Error(`WS rejected: ${JSON.stringify(msg.data)}`));
          }
        } catch (err) {
          reject(err);
        }
      });

      ws.on('error', reject);
    });
  }

  before(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-m3-qc-test-'));
    uploadDir = path.join(tempDir, 'uploads');
    await fs.promises.mkdir(uploadDir, { recursive: true });

    serverInstance = await startServer({
      port: 0,
      host: '127.0.0.1',
      noBrowser: true,
      tempDir,
      uploadDir,
      dataDir: path.join(tempDir, 'data'),
      pin,
      offerTtlMs: 30000,
    });

    const addr = serverInstance.server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
    hostToken = serverInstance.app.locals.hostAuth.token;

    // Authenticate Client A
    const authResA = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    assert.equal(authResA.status, 200);
    tokenA = (await authResA.json()).data.token;

    // Authenticate Client B
    const authResB = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    assert.equal(authResB.status, 200);
    tokenB = (await authResB.json()).data.token;

    // Connect WebSocket A
    const wsResA = await connectWs(addr.port, tokenA, 'Client A Phone', 'ios');
    wsA = wsResA.ws;
    connIdA = wsResA.connId;

    // Connect WebSocket B
    const wsResB = await connectWs(addr.port, tokenB, 'Client B Laptop', 'linux');
    wsB = wsResB.ws;
    connIdB = wsResB.connId;
  });

  after(async () => {
    if (wsA && wsA.readyState === WebSocket.OPEN) wsA.terminate();
    if (wsB && wsB.readyState === WebSocket.OPEN) wsB.terminate();
    if (serverInstance?.runtime?.history) {
      await serverInstance.runtime.history.flush().catch(() => {});
    }
    if (serverInstance?.wss) {
      for (const client of serverInstance.wss.clients) client.terminate();
      serverInstance.wss.close();
    }
    if (serverInstance?.server) {
      await new Promise((resolve) => serverInstance.server.close(resolve));
    }
    await fs.promises
      .rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      .catch(() => {});
  });

  describe('M3-QC-01: Grant bound to connection requires valid connection ID', () => {
    it('enforces connection identity on simple upload and allows owner retry', async () => {
      const bodyText = 'alpha payload secret content';
      const bodyBytes = Buffer.from(bodyText);

      // Client A creates offer
      const offerRes = await fetch(`${baseUrl}/api/transfer/offer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': tokenA,
          'X-Connection-Id': connIdA,
        },
        body: JSON.stringify({
          files: [{ name: 'file_a.txt', size: bodyBytes.length }],
        }),
      });
      assert.equal(offerRes.status, 201);
      const offer = (await offerRes.json()).data.offer;

      // Host approves file
      const decisionRes = await fetch(`${baseUrl}/api/transfer/offer/decision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Host-Token': hostToken,
        },
        body: JSON.stringify({
          offerId: offer.offerId,
          decisions: [{ index: 0, action: 'approve' }],
        }),
      });
      assert.equal(decisionRes.status, 200);
      const grantA = (await decisionRes.json()).data.decisions[0].grantId;
      assert.ok(grantA);

      // Case 1: Session B tries to spend grantA WITHOUT X-Connection-Id header
      const formMissing = new FormData();
      formMissing.append('files', new Blob([bodyBytes]), 'file_a.txt');
      const resMissing = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'X-Session-Token': tokenB,
          'X-Transfer-Grant': grantA,
        },
        body: formMissing,
      });
      assert.equal(resMissing.status, 403, 'Missing connectionId header must return 403');
      const jsonMissing = await resMissing.json();
      assert.equal(jsonMissing.error.code, 'TRANSFER_GRANT_INVALID');
      assert.equal(fs.existsSync(path.join(uploadDir, 'file_a.txt')), false);

      // Case 1b: Owner Session A itself tries to spend grantA WITHOUT X-Connection-Id header (M3-QC-R2-01)
      const formOwnerMissing = new FormData();
      formOwnerMissing.append('files', new Blob([bodyBytes]), 'file_a.txt');
      const resOwnerMissing = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'X-Session-Token': tokenA,
          'X-Transfer-Grant': grantA,
        },
        body: formOwnerMissing,
      });
      assert.equal(
        resOwnerMissing.status,
        403,
        'Owner session missing connectionId header must return 403'
      );
      const jsonOwnerMissing = await resOwnerMissing.json();
      assert.equal(jsonOwnerMissing.error.code, 'TRANSFER_GRANT_INVALID');
      assert.equal(fs.existsSync(path.join(uploadDir, 'file_a.txt')), false);

      // Case 2: Session B tries to spend grantA with its own connectionId (connIdB)
      const formForeign = new FormData();
      formForeign.append('files', new Blob([bodyBytes]), 'file_a.txt');
      const resForeign = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'X-Session-Token': tokenB,
          'X-Connection-Id': connIdB,
          'X-Transfer-Grant': grantA,
        },
        body: formForeign,
      });
      assert.equal(resForeign.status, 403, 'Foreign connectionId must return 403');
      const jsonForeign = await resForeign.json();
      assert.equal(jsonForeign.error.code, 'TRANSFER_GRANT_INVALID');
      assert.equal(fs.existsSync(path.join(uploadDir, 'file_a.txt')), false);

      // Case 3: Session B tries to spend grantA with forged connectionId (connIdA) under Session B
      const formForged = new FormData();
      formForged.append('files', new Blob([bodyBytes]), 'file_a.txt');
      const resForged = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'X-Session-Token': tokenB,
          'X-Connection-Id': connIdA,
          'X-Transfer-Grant': grantA,
        },
        body: formForged,
      });
      assert.equal(resForged.status, 403, 'Forged connectionId must return 403');
      const jsonForged = await resForged.json();
      assert.ok(
        ['INVALID_CONNECTION_ID', 'TRANSFER_GRANT_INVALID'].includes(jsonForged.error.code)
      );
      assert.equal(fs.existsSync(path.join(uploadDir, 'file_a.txt')), false);

      // Case 4: Rightful owner (Client A) retries and succeeds
      const formOwner = new FormData();
      formOwner.append('files', new Blob([bodyBytes]), 'file_a.txt');
      const resOwner = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'X-Session-Token': tokenA,
          'X-Connection-Id': connIdA,
          'X-Transfer-Grant': grantA,
        },
        body: formOwner,
      });
      assert.equal(resOwner.status, 201, 'Rightful owner upload must succeed on retry');
      assert.equal(fs.existsSync(path.join(uploadDir, 'file_a.txt')), true);
    });

    it('enforces connection identity on chunked upload init and allows owner retry', async () => {
      const fileName = 'chunked_a.bin';
      const fileSize = 2048;
      const fileChecksum = crypto
        .createHash('sha256')
        .update(Buffer.alloc(fileSize, 0x42))
        .digest('hex');

      // Client A creates offer
      const offerRes = await fetch(`${baseUrl}/api/transfer/offer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': tokenA,
          'X-Connection-Id': connIdA,
        },
        body: JSON.stringify({
          files: [{ name: fileName, size: fileSize, checksum: fileChecksum }],
        }),
      });
      assert.equal(offerRes.status, 201);
      const offer = (await offerRes.json()).data.offer;

      // Host approves
      const decisionRes = await fetch(`${baseUrl}/api/transfer/offer/decision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Host-Token': hostToken,
        },
        body: JSON.stringify({
          offerId: offer.offerId,
          decisions: [{ index: 0, action: 'approve' }],
        }),
      });
      assert.equal(decisionRes.status, 200);
      const grantId = (await decisionRes.json()).data.decisions[0].grantId;

      // Case 1: Missing X-Connection-Id (Session B)
      const resMissing = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': tokenB,
          'X-Transfer-Grant': grantId,
        },
        body: JSON.stringify({ fileName, fileSize, checksum: fileChecksum }),
      });
      assert.equal(resMissing.status, 403);
      assert.equal((await resMissing.json()).error.code, 'TRANSFER_GRANT_INVALID');

      // Case 1b: Owner Session A itself tries to init WITHOUT X-Connection-Id header (M3-QC-R2-01)
      const resOwnerMissing = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': tokenA,
          'X-Transfer-Grant': grantId,
        },
        body: JSON.stringify({ fileName, fileSize, checksum: fileChecksum }),
      });
      assert.equal(
        resOwnerMissing.status,
        403,
        'Owner session missing connectionId header on init must return 403'
      );
      assert.equal((await resOwnerMissing.json()).error.code, 'TRANSFER_GRANT_INVALID');

      // Case 2: Foreign connectionId (connIdB)
      const resForeign = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': tokenB,
          'X-Connection-Id': connIdB,
          'X-Transfer-Grant': grantId,
        },
        body: JSON.stringify({ fileName, fileSize, checksum: fileChecksum }),
      });
      assert.equal(resForeign.status, 403);
      assert.equal((await resForeign.json()).error.code, 'TRANSFER_GRANT_INVALID');

      // Case 3: Forged connectionId (connIdA under tokenB)
      const resForged = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': tokenB,
          'X-Connection-Id': connIdA,
          'X-Transfer-Grant': grantId,
        },
        body: JSON.stringify({ fileName, fileSize, checksum: fileChecksum }),
      });
      assert.equal(resForged.status, 403);
      const forgedCode = (await resForged.json()).error.code;
      assert.ok(['INVALID_CONNECTION_ID', 'TRANSFER_GRANT_INVALID'].includes(forgedCode));

      // Case 4: Rightful owner (Client A) succeeds
      const resOwner = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': tokenA,
          'X-Connection-Id': connIdA,
          'X-Transfer-Grant': grantId,
        },
        body: JSON.stringify({ fileName, fileSize, checksum: fileChecksum }),
      });
      assert.equal(resOwner.status, 200, 'Rightful owner must be able to init chunked session');
      const initJson = await resOwner.json();
      assert.ok(initJson.data.uploadId);
    });
  });

  describe('M3-QC-02: Chunked init validates metadata against approved grant', () => {
    it('rejects init with mismatched fileName, fileSize, or checksum, and does not fulfill grant', async () => {
      const legitName = 'approved_document.pdf';
      const legitSize = 4096;
      const legitChecksum = crypto
        .createHash('sha256')
        .update(Buffer.alloc(legitSize, 0x50))
        .digest('hex');

      // Client A creates offer
      const offerRes = await fetch(`${baseUrl}/api/transfer/offer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': tokenA,
          'X-Connection-Id': connIdA,
        },
        body: JSON.stringify({
          files: [{ name: legitName, size: legitSize, checksum: legitChecksum }],
        }),
      });
      assert.equal(offerRes.status, 201);
      const offer = (await offerRes.json()).data.offer;

      // Host approves
      const decisionRes = await fetch(`${baseUrl}/api/transfer/offer/decision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Host-Token': hostToken,
        },
        body: JSON.stringify({
          offerId: offer.offerId,
          decisions: [{ index: 0, action: 'approve' }],
        }),
      });
      assert.equal(decisionRes.status, 200);
      const grantId = (await decisionRes.json()).data.decisions[0].grantId;

      // Sub-case 1: Different fileName
      const resDiffName = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': tokenA,
          'X-Connection-Id': connIdA,
          'X-Transfer-Grant': grantId,
        },
        body: JSON.stringify({
          fileName: 'malicious_binary.exe',
          fileSize: legitSize,
          checksum: legitChecksum,
        }),
      });
      assert.equal(resDiffName.status, 403);
      assert.equal((await resDiffName.json()).error.code, 'GRANT_MISMATCH');

      // Sub-case 2: Different fileSize
      const resDiffSize = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': tokenA,
          'X-Connection-Id': connIdA,
          'X-Transfer-Grant': grantId,
        },
        body: JSON.stringify({
          fileName: legitName,
          fileSize: 99999,
          checksum: legitChecksum,
        }),
      });
      assert.equal(resDiffSize.status, 403);
      assert.equal((await resDiffSize.json()).error.code, 'GRANT_MISMATCH');

      // Sub-case 3: Different checksum
      const resDiffChecksum = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': tokenA,
          'X-Connection-Id': connIdA,
          'X-Transfer-Grant': grantId,
        },
        body: JSON.stringify({
          fileName: legitName,
          fileSize: legitSize,
          checksum: '0'.repeat(64),
        }),
      });
      assert.equal(resDiffChecksum.status, 403);
      assert.equal((await resDiffChecksum.json()).error.code, 'GRANT_MISMATCH');

      // Sub-case 4: Missing checksum when grant required checksum
      const resNoChecksum = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': tokenA,
          'X-Connection-Id': connIdA,
          'X-Transfer-Grant': grantId,
        },
        body: JSON.stringify({
          fileName: legitName,
          fileSize: legitSize,
        }),
      });
      assert.equal(resNoChecksum.status, 403);
      assert.equal((await resNoChecksum.json()).error.code, 'GRANT_MISMATCH');

      // Sub-case 5: Correct metadata succeeds and grant is consumed properly
      const resValid = await fetch(`${baseUrl}/api/upload/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': tokenA,
          'X-Connection-Id': connIdA,
          'X-Transfer-Grant': grantId,
        },
        body: JSON.stringify({
          fileName: legitName,
          fileSize: legitSize,
          checksum: legitChecksum,
        }),
      });
      assert.equal(resValid.status, 200);
      assert.ok((await resValid.json()).data.uploadId);
    });
  });

  describe('M3-QC-03: Self-scoped history, GET offer, and cancel strictly enforce server-side capability and support reconnect', () => {
    it('isolates history between sessions and rejects spoofed connectionId', async () => {
      // Session B attempts to read Session A's history using A's connectionId
      const resSpoof = await fetch(`${baseUrl}/api/transfers/history`, {
        headers: {
          'X-Session-Token': tokenB,
          'X-Connection-Id': connIdA,
        },
      });
      assert.equal(resSpoof.status, 403, 'Claiming another session connectionId must return 403');
      assert.equal((await resSpoof.json()).error.code, 'INVALID_CONNECTION_ID');

      // Session B queries history legitimately without header or with connIdB
      const resB = await fetch(`${baseUrl}/api/transfers/history`, {
        headers: {
          'X-Session-Token': tokenB,
          'X-Connection-Id': connIdB,
        },
      });
      assert.equal(resB.status, 200);
      const jsonB = await resB.json();
      assert.equal(jsonB.data.scope, 'self');
      // Session B has not completed any uploads, so entries must be empty
      assert.equal(jsonB.data.entries.length, 0);

      // Session A queries history legitimately
      const resA = await fetch(`${baseUrl}/api/transfers/history`, {
        headers: {
          'X-Session-Token': tokenA,
          'X-Connection-Id': connIdA,
        },
      });
      assert.equal(resA.status, 200);
      const jsonA = await resA.json();
      assert.equal(jsonA.data.scope, 'self');
      assert.ok(jsonA.data.entries.length >= 1);
      assert.ok(jsonA.data.entries.some((e) => e.fileName === 'file_a.txt'));
    });

    it('rejects foreign or unverified client reading or cancelling offer', async () => {
      // Client A creates an offer
      const offerRes = await fetch(`${baseUrl}/api/transfer/offer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': tokenA,
          'X-Connection-Id': connIdA,
        },
        body: JSON.stringify({
          files: [{ name: 'private_notes.txt', size: 100 }],
        }),
      });
      assert.equal(offerRes.status, 201);
      const offerId = (await offerRes.json()).data.offer.offerId;

      // Session B tries to GET offer with connIdA (spoof) -> 403
      const getSpoof = await fetch(`${baseUrl}/api/transfer/offer/${offerId}`, {
        headers: {
          'X-Session-Token': tokenB,
          'X-Connection-Id': connIdA,
        },
      });
      assert.equal(getSpoof.status, 403);
      assert.equal((await getSpoof.json()).error.code, 'INVALID_CONNECTION_ID');

      // Session B tries to GET offer with its own connIdB -> 403 OFFER_FORBIDDEN
      const getForeign = await fetch(`${baseUrl}/api/transfer/offer/${offerId}`, {
        headers: {
          'X-Session-Token': tokenB,
          'X-Connection-Id': connIdB,
        },
      });
      assert.equal(getForeign.status, 403);
      assert.equal((await getForeign.json()).error.code, 'OFFER_FORBIDDEN');

      // Session B tries to cancel offer with connIdB -> 403 OFFER_FORBIDDEN
      const cancelForeign = await fetch(`${baseUrl}/api/transfer/offer/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': tokenB,
          'X-Connection-Id': connIdB,
        },
        body: JSON.stringify({ offerId }),
      });
      assert.equal(cancelForeign.status, 403);
      assert.equal((await cancelForeign.json()).error.code, 'OFFER_FORBIDDEN');

      // Rightful owner Client A can read the offer
      const getOwner = await fetch(`${baseUrl}/api/transfer/offer/${offerId}`, {
        headers: {
          'X-Session-Token': tokenA,
          'X-Connection-Id': connIdA,
        },
      });
      assert.equal(getOwner.status, 200);
      assert.equal((await getOwner.json()).data.offer.offerId, offerId);
    });

    it('preserves history access and offer management across WebSocket reconnect', async () => {
      // 1. Client A terminates its first WebSocket
      wsA.terminate();

      // 2. Client A opens a new WebSocket with the same session tokenA
      const addr = serverInstance.server.address();
      const wsResA2 = await connectWs(addr.port, tokenA, 'Client A Reconnected Phone', 'ios');
      const wsA2 = wsResA2.ws;
      const connIdA2 = wsResA2.connId;
      assert.notEqual(connIdA2, connIdA);

      try {
        // 3. Client A queries history via connIdA2 or session mapping
        const resHist = await fetch(`${baseUrl}/api/transfers/history`, {
          headers: {
            'X-Session-Token': tokenA,
            'X-Connection-Id': connIdA2,
          },
        });
        assert.equal(resHist.status, 200);
        const jsonHist = await resHist.json();
        // Client A must still see its previous uploads
        assert.ok(jsonHist.data.entries.some((e) => e.fileName === 'file_a.txt'));

        // 4. Create an offer with connIdA2 and verify cancel works
        const offerRes = await fetch(`${baseUrl}/api/transfer/offer`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': tokenA,
            'X-Connection-Id': connIdA2,
          },
          body: JSON.stringify({
            files: [{ name: 'reconnect_offer.txt', size: 50 }],
          }),
        });
        assert.equal(offerRes.status, 201);
        const newOfferId = (await offerRes.json()).data.offer.offerId;

        // Cancel offer works under new connection ID
        const cancelRes = await fetch(`${baseUrl}/api/transfer/offer/cancel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': tokenA,
            'X-Connection-Id': connIdA2,
          },
          body: JSON.stringify({ offerId: newOfferId }),
        });
        assert.equal(cancelRes.status, 200);
        assert.equal((await cancelRes.json()).data.state, 'cancelled');
      } finally {
        wsA2.terminate();
      }
    });
  });

  describe('M3-QC-04: Host decision idempotency and atomic batch validation', () => {
    it('rejects duplicate index and maintains atomic state without partial mutation', async () => {
      // Create fresh offer with 3 files
      const offerRes = await fetch(`${baseUrl}/api/transfer/offer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': tokenB,
          'X-Connection-Id': connIdB,
        },
        body: JSON.stringify({
          files: [
            { name: 'file0.txt', size: 10 },
            { name: 'file1.txt', size: 20 },
            { name: 'file2.txt', size: 30 },
          ],
        }),
      });
      assert.equal(offerRes.status, 201);
      const offerId = (await offerRes.json()).data.offer.offerId;

      // 1. Duplicate index in the same request
      const dupRes = await fetch(`${baseUrl}/api/transfer/offer/decision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Host-Token': hostToken,
        },
        body: JSON.stringify({
          offerId,
          decisions: [
            { index: 0, action: 'approve' },
            { index: 0, action: 'reject' },
          ],
        }),
      });
      assert.equal(dupRes.status, 400);
      assert.equal((await dupRes.json()).error.code, 'INVALID_INPUT');

      // Verify no state changed on offer
      const checkOffer1 = serverInstance.runtime.offerService.getOffer(offerId);
      assert.equal(checkOffer1.files[0].decision, 'pending');

      // 2. Partial batch with an out-of-range index
      const invalidBatchRes = await fetch(`${baseUrl}/api/transfer/offer/decision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Host-Token': hostToken,
        },
        body: JSON.stringify({
          offerId,
          decisions: [
            { index: 0, action: 'approve' },
            { index: 99, action: 'approve' },
          ],
        }),
      });
      assert.equal(invalidBatchRes.status, 400);
      assert.equal((await invalidBatchRes.json()).error.code, 'INVALID_INPUT');

      // Verify atomicity: file 0 was NOT approved
      const checkOffer2 = serverInstance.runtime.offerService.getOffer(offerId);
      assert.equal(checkOffer2.files[0].decision, 'pending');

      // 3. Approve file 0 legitimately
      const approveRes1 = await fetch(`${baseUrl}/api/transfer/offer/decision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Host-Token': hostToken,
        },
        body: JSON.stringify({
          offerId,
          decisions: [{ index: 0, action: 'approve' }],
        }),
      });
      assert.equal(approveRes1.status, 200);
      const grant0 = (await approveRes1.json()).data.decisions[0].grantId;
      assert.ok(grant0);

      // 4. Attempt to approve or reject file 0 again -> 409 OFFER_CONFLICT
      const reDecideRes = await fetch(`${baseUrl}/api/transfer/offer/decision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Host-Token': hostToken,
        },
        body: JSON.stringify({
          offerId,
          decisions: [{ index: 0, action: 'approve' }],
        }),
      });
      assert.equal(reDecideRes.status, 409);
      assert.equal((await reDecideRes.json()).error.code, 'OFFER_CONFLICT');

      // Check that only 1 grant exists for file 0
      const allGrants = serverInstance.runtime.offerService.getGrantsForOffer(offerId);
      assert.equal(allGrants.filter((g) => g.index === 0).length, 1);

      // 5. Complete remaining decisions
      const finishRes = await fetch(`${baseUrl}/api/transfer/offer/decision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Host-Token': hostToken,
        },
        body: JSON.stringify({
          offerId,
          decisions: [
            { index: 1, action: 'approve' },
            { index: 2, action: 'reject' },
          ],
        }),
      });
      assert.equal(finishRes.status, 200);
      const finishedOffer = serverInstance.runtime.offerService.getOffer(offerId);
      assert.equal(finishedOffer.state, 'decided');
      assert.equal(finishedOffer.files[1].decision, 'approved');
      assert.equal(finishedOffer.files[2].decision, 'rejected');
    });
  });

  describe('M3-QC-R2-02: Chunk session authorization post-init', () => {
    it('rejects foreign client on all four chunk routes (status, chunk, cancel, complete) and allows owner to complete transfer including after reconnect', async () => {
      const origChunkSize = serverInstance.runtime.config.chunkSize;
      // Use 1024 bytes chunk size for test isolation
      serverInstance.runtime.config.chunkSize = 1024;

      let wsA2 = null;
      try {
        const fileName = 'chunk_auth_test.bin';
        const chunk0 = Buffer.alloc(1024, 0x33);
        const chunk1 = Buffer.alloc(1024, 0x44);
        const fullBuffer = Buffer.concat([chunk0, chunk1]);
        const fileSize = fullBuffer.length;
        const fileChecksum = crypto.createHash('sha256').update(fullBuffer).digest('hex');

        // 1. Client A creates offer
        const offerRes = await fetch(`${baseUrl}/api/transfer/offer`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': tokenA,
            'X-Connection-Id': connIdA,
          },
          body: JSON.stringify({
            files: [{ name: fileName, size: fileSize, checksum: fileChecksum }],
          }),
        });
        assert.equal(offerRes.status, 201);
        const offer = (await offerRes.json()).data.offer;

        // 2. Host approves file
        const decisionRes = await fetch(`${baseUrl}/api/transfer/offer/decision`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Host-Token': hostToken,
          },
          body: JSON.stringify({
            offerId: offer.offerId,
            decisions: [{ index: 0, action: 'approve' }],
          }),
        });
        assert.equal(decisionRes.status, 200);
        const grantId = (await decisionRes.json()).data.decisions[0].grantId;
        assert.ok(grantId);

        // 3. Client A inits chunked session
        const initRes = await fetch(`${baseUrl}/api/upload/init`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': tokenA,
            'X-Connection-Id': connIdA,
            'X-Transfer-Grant': grantId,
          },
          body: JSON.stringify({ fileName, fileSize, checksum: fileChecksum }),
        });
        assert.equal(initRes.status, 200);
        const uploadId = (await initRes.json()).data.uploadId;
        assert.ok(uploadId);

        // 4a. Client B tries GET /api/upload/status/:uploadId -> 403 UPLOAD_FORBIDDEN
        const statusResB = await fetch(`${baseUrl}/api/upload/status/${uploadId}`, {
          headers: {
            'X-Session-Token': tokenB,
            'X-Connection-Id': connIdB,
          },
        });
        assert.equal(statusResB.status, 403, 'Client B status must be forbidden');
        assert.equal((await statusResB.json()).error.code, 'UPLOAD_FORBIDDEN');

        // 4b. Client B tries POST /api/upload/chunk -> 403 UPLOAD_FORBIDDEN
        const formChunkB = new FormData();
        formChunkB.append('uploadId', uploadId);
        formChunkB.append('chunkIndex', '0');
        formChunkB.append('chunk', new Blob([chunk0]), 'chunk_0');
        const chunkResB = await fetch(`${baseUrl}/api/upload/chunk`, {
          method: 'POST',
          headers: {
            'X-Session-Token': tokenB,
            'X-Connection-Id': connIdB,
          },
          body: formChunkB,
        });
        assert.equal(chunkResB.status, 403, 'Client B chunk upload must be forbidden');
        assert.equal((await chunkResB.json()).error.code, 'UPLOAD_FORBIDDEN');

        // 4c. Client B tries POST /api/upload/cancel -> 403 UPLOAD_FORBIDDEN
        const cancelResB = await fetch(`${baseUrl}/api/upload/cancel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': tokenB,
            'X-Connection-Id': connIdB,
          },
          body: JSON.stringify({ uploadId }),
        });
        assert.equal(cancelResB.status, 403, 'Client B cancel must be forbidden');
        assert.equal((await cancelResB.json()).error.code, 'UPLOAD_FORBIDDEN');

        // 4d. Client B tries POST /api/upload/complete -> 403 UPLOAD_FORBIDDEN
        const completeResB = await fetch(`${baseUrl}/api/upload/complete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': tokenB,
            'X-Connection-Id': connIdB,
          },
          body: JSON.stringify({ uploadId }),
        });
        assert.equal(completeResB.status, 403, 'Client B complete must be forbidden');
        assert.equal((await completeResB.json()).error.code, 'UPLOAD_FORBIDDEN');

        // 5. Host capability verification: Host CAN inspect session status
        const hostStatusRes = await fetch(`${baseUrl}/api/upload/status/${uploadId}`, {
          headers: {
            'X-Host-Token': hostToken,
          },
        });
        assert.equal(hostStatusRes.status, 200, 'Host can inspect chunk session status');

        // 6. Owner Client A checks status -> 200, verified 0 chunks received
        const statusResA = await fetch(`${baseUrl}/api/upload/status/${uploadId}`, {
          headers: {
            'X-Session-Token': tokenA,
            'X-Connection-Id': connIdA,
          },
        });
        assert.equal(statusResA.status, 200);
        const statusDataA = (await statusResA.json()).data;
        assert.equal(
          statusDataA.receivedChunks.length,
          0,
          'No chunks received because foreign upload was rejected'
        );

        // 7. Owner Client A uploads chunk 0
        const formChunkA0 = new FormData();
        formChunkA0.append('uploadId', uploadId);
        formChunkA0.append('chunkIndex', '0');
        formChunkA0.append('chunk', new Blob([chunk0]), 'chunk_0');
        const chunkResA0 = await fetch(`${baseUrl}/api/upload/chunk`, {
          method: 'POST',
          headers: {
            'X-Session-Token': tokenA,
            'X-Connection-Id': connIdA,
          },
          body: formChunkA0,
        });
        assert.equal(chunkResA0.status, 200);

        // 8. Reconnect support: Client A connects a new WebSocket socket with same tokenA
        const port = serverInstance.server.address().port;
        const reconnected = await connectWs(port, tokenA, 'Client A Reconnected Phone', 'ios');
        wsA2 = reconnected.ws;
        const connIdA2 = reconnected.connId;
        assert.ok(connIdA2);

        // 9. Client A uploads chunk 1 using reconnected connection
        const formChunkA1 = new FormData();
        formChunkA1.append('uploadId', uploadId);
        formChunkA1.append('chunkIndex', '1');
        formChunkA1.append('chunk', new Blob([chunk1]), 'chunk_1');
        const chunkResA1 = await fetch(`${baseUrl}/api/upload/chunk`, {
          method: 'POST',
          headers: {
            'X-Session-Token': tokenA,
            'X-Connection-Id': connIdA2,
          },
          body: formChunkA1,
        });
        assert.equal(chunkResA1.status, 200);

        // 10. Client A completes the upload using reconnected connection
        const completeResA = await fetch(`${baseUrl}/api/upload/complete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': tokenA,
            'X-Connection-Id': connIdA2,
          },
          body: JSON.stringify({ uploadId }),
        });
        assert.equal(completeResA.status, 200, 'Owner completes upload');
        const completeData = (await completeResA.json()).data;
        assert.equal(completeData.fileName, fileName);

        // Verify assembled file exists in uploadDir with identical bytes
        const finalFilePath = path.join(uploadDir, fileName);
        assert.equal(fs.existsSync(finalFilePath), true);
        const savedBytes = await fs.promises.readFile(finalFilePath);
        assert.deepEqual(savedBytes, fullBuffer);

        // 11. Foreign Client B attempts POST /api/upload/complete on completed outcome -> 403 UPLOAD_FORBIDDEN
        const reCompleteResB = await fetch(`${baseUrl}/api/upload/complete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': tokenB,
            'X-Connection-Id': connIdB,
          },
          body: JSON.stringify({ uploadId }),
        });
        assert.equal(
          reCompleteResB.status,
          403,
          'Foreign client cannot complete completed session'
        );
        assert.equal((await reCompleteResB.json()).error.code, 'UPLOAD_FORBIDDEN');
      } finally {
        if (wsA2 && wsA2.readyState === WebSocket.OPEN) wsA2.terminate();
        serverInstance.runtime.config.chunkSize = origChunkSize;
      }
    });
  });

  describe('Settings write probe', () => {
    it('validates uploadDir write capability on PATCH /api/settings', async () => {
      const validSubDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'utrans-settings-test-')
      );
      try {
        const resValid = await fetch(`${baseUrl}/api/settings`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-Host-Token': hostToken,
          },
          body: JSON.stringify({ uploadDir: validSubDir }),
        });
        assert.equal(resValid.status, 200);
        const jsonValid = await resValid.json();
        assert.equal(path.resolve(jsonValid.data.uploadDir), path.resolve(validSubDir));
        assert.equal(fs.existsSync(validSubDir), true);
      } finally {
        await fs.promises.rm(validSubDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });
});
