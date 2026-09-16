/**
 * UT-012 — host consent before any payload moves.
 *
 * The security claim is that nothing reaches disk without a host decision, so these
 * cases assert on bytes rather than on status codes alone: a grant is bound to one
 * approved (name, size) pair, belongs to one connection, and can be spent only once.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { startServer } from '../../src/server.js';
import { approveUpload, offerBatch, requestOffer, decideOffer } from '../helpers/consent.js';

/** Recursively lists every file under a directory, newest state on each call. */
async function listFilesRecursive(dir) {
  const out = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(dir);
  return out.sort();
}

describe('UT-012: transfer consent before bytes move', () => {
  let tempDir;
  let uploadDir;
  let serverInstance;
  let base;
  let runtime;
  let hostToken;
  let defaultConnectionId;
  const sockets = [];

  before(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-consent-'));
    uploadDir = path.join(tempDir, 'uploads');
    await fs.promises.mkdir(uploadDir, { recursive: true });

    serverInstance = await startServer({
      port: 0,
      host: '127.0.0.1',
      noBrowser: true,
      tempDir,
      uploadDir,
      // Trust must never write to the developer's real home directory.
      dataDir: path.join(tempDir, 'data'),
      offerTtlMs: 400,
    });
    runtime = serverInstance.runtime;
    base = `http://127.0.0.1:${serverInstance.server.address().port}`;
    hostToken = serverInstance.app.locals.hostAuth.token;

    const ws = new WebSocket(`ws://127.0.0.1:${serverInstance.server.address().port}/ws`);
    sockets.push(ws);
    const registered = new Promise((resolve) => {
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.event === 'client:registered') resolve(message.data.connectionId);
      });
    });
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(
      JSON.stringify({
        event: 'client:register',
        data: { deviceName: 'Consent Test Client', platform: 'test' },
      })
    );
    defaultConnectionId = await registered;
  });

  after(async () => {
    for (const socket of sockets) socket.terminate();
    if (serverInstance?.wss) {
      for (const client of serverInstance.wss.clients) client.terminate();
      serverInstance.wss.close();
    }
    if (serverInstance?.server) {
      await new Promise((resolve) => serverInstance.server.close(resolve));
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('refuses a simple upload with no grant and writes nothing anywhere', async () => {
    const before = {
      temp: await listFilesRecursive(tempDir),
      received: await listFilesRecursive(uploadDir),
    };

    const form = new FormData();
    form.append('files', new Blob(['unconsented payload']), 'intruder.txt');
    const res = await fetch(`${base}/api/upload`, { method: 'POST', body: form });

    assert.equal(res.status, 428);
    assert.equal((await res.json()).error.code, 'TRANSFER_GRANT_REQUIRED');
    assert.deepEqual(await listFilesRecursive(tempDir), before.temp);
    assert.deepEqual(await listFilesRecursive(uploadDir), before.received);
  });

  it('refuses a chunked session with no grant', async () => {
    const res = await fetch(`${base}/api/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'unconsented.bin',
        fileSize: 16,
        checksum: 'a'.repeat(64),
      }),
    });
    assert.equal(res.status, 428);
    assert.equal((await res.json()).error.code, 'TRANSFER_GRANT_REQUIRED');
    assert.equal(runtime.chunkedUploadManager.sessions.size, 0);
  });

  it('refuses a payload whose size differs from what the host approved', async () => {
    const grantHeader = await approveUpload(base, {
      name: 'exact-size.bin',
      data: Buffer.alloc(10),
      hostToken,
    });

    const form = new FormData();
    form.append('files', new Blob([Buffer.alloc(20, 'X')]), 'exact-size.bin');
    const res = await fetch(`${base}/api/upload`, {
      method: 'POST',
      body: form,
      headers: { 'X-Transfer-Grant': grantHeader },
    });

    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'GRANT_MISMATCH');
    assert.equal(fs.existsSync(path.join(uploadDir, 'exact-size.bin')), false);
    // The partially parsed file must not be left behind in staging.
    const staged = await listFilesRecursive(path.join(tempDir, 'pending'));
    assert.equal(
      staged.some((file) => file.includes('exact-size')),
      false
    );
  });

  it('refuses a payload whose name differs from what the host approved', async () => {
    const grantHeader = await approveUpload(base, {
      name: 'approved-name.bin',
      data: 'same-length',
      hostToken,
    });

    const form = new FormData();
    form.append('files', new Blob(['same-length']), 'different-name.bin');
    const res = await fetch(`${base}/api/upload`, {
      method: 'POST',
      body: form,
      headers: { 'X-Transfer-Grant': grantHeader },
    });

    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'GRANT_MISMATCH');
    assert.equal(fs.existsSync(path.join(uploadDir, 'different-name.bin')), false);
  });

  it('lets a grant be spent only once', async () => {
    const payload = 'single-use-payload';
    const grantHeader = await approveUpload(base, {
      name: 'single-use.txt',
      data: payload,
      hostToken,
    });

    const first = new FormData();
    first.append('files', new Blob([payload]), 'single-use.txt');
    const firstRes = await fetch(`${base}/api/upload`, {
      method: 'POST',
      body: first,
      headers: { 'X-Transfer-Grant': grantHeader },
    });
    assert.equal(firstRes.status, 201);

    const second = new FormData();
    second.append('files', new Blob([payload]), 'single-use.txt');
    const secondRes = await fetch(`${base}/api/upload`, {
      method: 'POST',
      body: second,
      headers: { 'X-Transfer-Grant': grantHeader },
    });
    assert.equal(secondRes.status, 403);
    assert.equal((await secondRes.json()).error.code, 'TRANSFER_GRANT_USED');
  });

  it('refuses a grant presented by a different connection', async () => {
    // Two real registered sockets, so the connection ids are ones the server issued.
    const connectionIds = [];
    for (const label of ['Owner', 'Thief']) {
      const ws = new WebSocket(`ws://127.0.0.1:${serverInstance.server.address().port}/ws`);
      sockets.push(ws);
      const registered = new Promise((resolve) => {
        ws.on('message', (raw) => {
          const message = JSON.parse(raw.toString());
          if (message.event === 'client:registered') resolve(message.data.connectionId);
        });
      });
      await new Promise((resolve) => ws.on('open', resolve));
      ws.send(
        JSON.stringify({
          event: 'client:register',
          data: { deviceName: `${label} Device`, platform: 'android' },
        })
      );
      connectionIds.push(await registered);
    }
    const [ownerId, thiefId] = connectionIds;
    assert.notEqual(ownerId, thiefId);

    const payload = 'connection-bound';
    const { grantHeader } = await offerBatch(base, {
      files: [{ name: 'bound.txt', size: payload.length }],
      connectionId: ownerId,
      hostToken,
    });

    // The thief presents the owner's grant while claiming to be itself.
    const form = new FormData();
    form.append('files', new Blob([payload]), 'bound.txt');
    const res = await fetch(`${base}/api/upload`, {
      method: 'POST',
      body: form,
      headers: { 'X-Transfer-Grant': grantHeader, 'X-Connection-Id': thiefId },
    });

    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'TRANSFER_GRANT_INVALID');
    assert.equal(fs.existsSync(path.join(uploadDir, 'bound.txt')), false);

    // The rightful owner can still spend it.
    const ownerForm = new FormData();
    ownerForm.append('files', new Blob([payload]), 'bound.txt');
    const ownerRes = await fetch(`${base}/api/upload`, {
      method: 'POST',
      body: ownerForm,
      headers: { 'X-Transfer-Grant': grantHeader, 'X-Connection-Id': ownerId },
    });
    assert.equal(ownerRes.status, 201);
  });

  it('resumes a no-PIN chunk session with an opaque capability and authorizes before parsing bytes', async () => {
    const payload = Buffer.from('resume-me');
    const checksum = crypto.createHash('sha256').update(payload).digest('hex');
    const { grantHeader } = await offerBatch(base, {
      files: [{ name: 'resume.bin', size: payload.length, checksum }],
      connectionId: defaultConnectionId,
      hostToken,
    });

    const init = await fetch(`${base}/api/upload/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Connection-Id': defaultConnectionId,
        'X-Transfer-Grant': grantHeader,
      },
      body: JSON.stringify({ fileName: 'resume.bin', fileSize: payload.length, checksum }),
    });
    assert.equal(init.status, 200);
    const initData = (await init.json()).data;
    assert.ok(initData.uploadId);
    assert.match(initData.uploadToken, /^[a-f0-9]{64}$/);

    const reconnect = new WebSocket(`ws://127.0.0.1:${serverInstance.server.address().port}/ws`);
    sockets.push(reconnect);
    const reconnected = new Promise((resolve) => {
      reconnect.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.event === 'client:registered') resolve(message.data.connectionId);
      });
    });
    await new Promise((resolve) => reconnect.on('open', resolve));
    reconnect.send(
      JSON.stringify({
        event: 'client:register',
        data: { deviceName: 'Reconnected Client', platform: 'test' },
      })
    );
    const reconnectId = await reconnected;
    assert.notEqual(reconnectId, defaultConnectionId);

    const denied = await fetch(`${base}/api/upload/chunk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=broken',
        'X-Connection-Id': reconnectId,
        'X-Upload-Id': initData.uploadId,
      },
      body: 'not-a-valid-multipart-body',
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'UPLOAD_FORBIDDEN');

    const status = await fetch(`${base}/api/upload/status/${initData.uploadId}`, {
      headers: {
        'X-Connection-Id': reconnectId,
        'X-Upload-Token': initData.uploadToken,
      },
    });
    assert.equal(status.status, 200);

    const chunk = new FormData();
    chunk.append('uploadId', initData.uploadId);
    chunk.append('chunkIndex', '0');
    chunk.append('chunk', new Blob([payload]), 'chunk_0');
    const chunkResponse = await fetch(`${base}/api/upload/chunk`, {
      method: 'POST',
      headers: {
        'X-Connection-Id': reconnectId,
        'X-Upload-Id': initData.uploadId,
        'X-Upload-Token': initData.uploadToken,
      },
      body: chunk,
    });
    assert.equal(chunkResponse.status, 200);

    const complete = await fetch(`${base}/api/upload/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Connection-Id': reconnectId,
        'X-Upload-Token': initData.uploadToken,
      },
      body: JSON.stringify({ uploadId: initData.uploadId }),
    });
    assert.equal(complete.status, 200);
    assert.deepEqual(await fs.promises.readFile(path.join(uploadDir, 'resume.bin')), payload);

    const cancelPayload = Buffer.from('cancel-me');
    const cancelChecksum = crypto.createHash('sha256').update(cancelPayload).digest('hex');
    const cancelGrant = await offerBatch(base, {
      files: [{ name: 'cancel.bin', size: cancelPayload.length, checksum: cancelChecksum }],
      connectionId: defaultConnectionId,
      hostToken,
    });
    const cancelInit = await fetch(`${base}/api/upload/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Connection-Id': defaultConnectionId,
        'X-Transfer-Grant': cancelGrant.grantHeader,
      },
      body: JSON.stringify({
        fileName: 'cancel.bin',
        fileSize: cancelPayload.length,
        checksum: cancelChecksum,
      }),
    });
    assert.equal(cancelInit.status, 200);
    const cancelSession = (await cancelInit.json()).data;

    const cancel = await fetch(`${base}/api/upload/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Connection-Id': reconnectId,
        'X-Upload-Token': cancelSession.uploadToken,
      },
      body: JSON.stringify({ uploadId: cancelSession.uploadId }),
    });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).data.cancelled, true);
    assert.equal(runtime.chunkedUploadManager.sessions.has(cancelSession.uploadId), false);

    const hostOwned = await fetch(`${base}/api/upload/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Host-Token': hostToken,
      },
      body: JSON.stringify({
        fileName: 'host-owned.bin',
        fileSize: payload.length,
        checksum,
      }),
    });
    assert.equal(hostOwned.status, 200);
    const hostOwnedId = (await hostOwned.json()).data.uploadId;
    const unprivilegedStatus = await fetch(`${base}/api/upload/status/${hostOwnedId}`);
    assert.equal(unprivilegedStatus.status, 403);
    assert.equal((await unprivilegedStatus.json()).error.code, 'UPLOAD_FORBIDDEN');
    await fetch(`${base}/api/upload/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Host-Token': hostToken },
      body: JSON.stringify({ uploadId: hostOwnedId }),
    });
  });

  it('ends an unanswered offer on timeout and leaves no bytes behind', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverInstance.server.address().port}/ws`);
    sockets.push(ws);
    const events = [];
    let resolveRegistration;
    const registered = new Promise((resolve) => {
      resolveRegistration = resolve;
    });
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      events.push(message);
      if (message.event === 'client:registered') resolveRegistration(message.data.connectionId);
    });
    await new Promise((resolve) => ws.on('open', resolve));

    ws.send(
      JSON.stringify({
        event: 'client:register',
        data: { deviceName: 'Timeout Sender', platform: 'android' },
      })
    );
    const connectionId = await registered;

    const { body } = await requestOffer(base, [{ name: 'never_sent.bin', size: 32 }], {
      connectionId,
    });
    const offerId = body.data.offer.offerId;

    // Deliveries are asynchronous; give the timer and socket time to settle.
    await new Promise((resolve) => setTimeout(resolve, 600));

    const expired = events.find(
      (e) => e.event === 'transfer:offer:expired' && e.data?.offerId === offerId
    );
    assert.ok(expired, 'sender must learn the offer expired rather than waiting forever');
    assert.equal(runtime.offerService.getOffer(offerId).state, 'expired');

    const received = await listFilesRecursive(uploadDir);
    assert.equal(
      received.some((file) => file.includes('never_sent')),
      false
    );
  });

  it('gives a rejected file no grant, while approving its sibling in the same batch', async () => {
    const keepBody = 'keep this one';
    const { res, body } = await requestOffer(
      base,
      [
        { name: 'reject_me.bin', size: 12 },
        { name: 'keep_me.bin', size: keepBody.length },
      ],
      { connectionId: defaultConnectionId }
    );
    assert.equal(res.status, 201);
    const offerId = body.data.offer.offerId;

    const decision = await decideOffer(base, {
      offerId,
      hostToken,
      decisions: [
        { index: 0, action: 'reject' },
        { index: 1, action: 'approve' },
      ],
    });
    assert.equal(decision.res.status, 200);

    const [rejected, approved] = decision.body.data.decisions;
    assert.equal(rejected.decision, 'rejected');
    assert.equal(rejected.grantId, null);
    assert.equal(approved.decision, 'approved');
    assert.ok(approved.grantId);

    // The rejected half can never be written, even though the batch was accepted.
    const rejectedForm = new FormData();
    rejectedForm.append('files', new Blob(['reject_me!!']), 'reject_me.bin');
    const rejectedRes = await fetch(`${base}/api/upload`, {
      method: 'POST',
      body: rejectedForm,
    });
    assert.equal(rejectedRes.status, 428);
    assert.equal(fs.existsSync(path.join(uploadDir, 'reject_me.bin')), false);

    // The approved half goes through and is saved without a second prompt.
    const approvedForm = new FormData();
    approvedForm.append('files', new Blob([keepBody]), 'keep_me.bin');
    const approvedRes = await fetch(`${base}/api/upload`, {
      method: 'POST',
      body: approvedForm,
      headers: {
        'X-Transfer-Grant': approved.grantId,
        'X-Connection-Id': defaultConnectionId,
      },
    });
    assert.equal(approvedRes.status, 201);
    assert.equal(await fs.promises.readFile(path.join(uploadDir, 'keep_me.bin'), 'utf8'), keepBody);
  });

  it('requires host authority to decide an offer', async () => {
    const { body } = await requestOffer(base, [{ name: 'gated.bin', size: 4 }], {
      connectionId: defaultConnectionId,
    });
    const offerId = body.data.offer.offerId;

    for (const headers of [
      { 'Content-Type': 'application/json' },
      { 'Content-Type': 'application/json', 'X-Host-Token': 'f'.repeat(64) },
    ]) {
      const res = await fetch(`${base}/api/transfer/offer/decision`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ offerId, decisions: [{ index: 0, action: 'approve' }] }),
      });
      assert.equal(res.status, 403);
    }
    assert.equal(runtime.offerService.getOffer(offerId).state, 'pending');
    assert.equal((await fetch(`${base}/api/transfer/offers`)).status, 403);
  });

  it('rejects an offer larger than the reviewable batch cap', async () => {
    const files = Array.from({ length: 51 }, (_, index) => ({
      name: `bulk_${index}.bin`,
      size: 1,
    }));
    const { res, body } = await requestOffer(base, files, {
      connectionId: defaultConnectionId,
    });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'TOO_MANY_FILES');
  });

  describe('trusted devices', () => {
    const deviceToken = 'c'.repeat(64);

    it('records a device only when the host asks for it, then approves it silently', async () => {
      // First offer: the host approves and remembers this device.
      const first = await requestOffer(base, [{ name: 'first.txt', size: 5 }], {
        deviceToken,
        connectionId: defaultConnectionId,
      });
      assert.equal(first.res.status, 201);
      assert.equal(first.body.data.autoApproved, false);

      const decision = await decideOffer(base, {
        offerId: first.body.data.offer.offerId,
        hostToken,
        decisions: [{ index: 0, action: 'approve' }],
        trustDevice: true,
      });
      assert.equal(decision.res.status, 200);
      assert.ok(decision.body.data.trustedDevice?.id);

      // Second offer from the same device is approved without asking the host again.
      const secondBody = 'hello';
      const second = await requestOffer(base, [{ name: 'second.txt', size: secondBody.length }], {
        deviceToken,
        connectionId: defaultConnectionId,
      });
      assert.equal(second.res.status, 201);
      assert.equal(second.body.data.autoApproved, true);
      const grant = second.body.data.decisions[0].grantId;
      assert.ok(grant, 'a trusted device receives its grant immediately');

      const form = new FormData();
      form.append('files', new Blob([secondBody]), 'second.txt');
      const res = await fetch(`${base}/api/upload`, {
        method: 'POST',
        body: form,
        headers: {
          'X-Transfer-Grant': grant,
          'X-Connection-Id': defaultConnectionId,
        },
      });
      assert.equal(res.status, 201);
    });

    it('never exposes stored token hashes and allows revocation by the host', async () => {
      // A token that was never trusted must not be auto-approved.
      const stranger = await requestOffer(base, [{ name: 'stranger.txt', size: 3 }], {
        deviceToken: 'd'.repeat(64),
        connectionId: defaultConnectionId,
      });
      assert.equal(stranger.body.data.autoApproved, false);

      const list = await fetch(`${base}/api/devices/trusted`, {
        headers: { 'X-Host-Token': hostToken },
      });
      assert.equal(list.status, 200);
      const devices = (await list.json()).data;
      assert.ok(devices.length >= 1);
      assert.equal(JSON.stringify(devices).includes(deviceToken), false);

      for (const device of devices) {
        const revoke = await fetch(`${base}/api/devices/trusted/${device.id}`, {
          method: 'DELETE',
          headers: { 'X-Host-Token': hostToken },
        });
        assert.equal(revoke.status, 200);
      }

      // Once revoked, the device goes back to needing an explicit decision.
      const afterRevoke = await requestOffer(base, [{ name: 'after.txt', size: 7 }], {
        deviceToken,
        connectionId: defaultConnectionId,
      });
      assert.equal(afterRevoke.body.data.autoApproved, false);
    });

    it('refuses to list or revoke trusted devices without host authority', async () => {
      assert.equal((await fetch(`${base}/api/devices/trusted`)).status, 403);
      const revoke = await fetch(`${base}/api/devices/trusted/td_whatever`, { method: 'DELETE' });
      assert.equal(revoke.status, 403);
    });
  });
});
