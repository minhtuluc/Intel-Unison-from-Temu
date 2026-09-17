/**
 * Relay storage and download ACL (M4 / UT-022) — integration tests at the real seam.
 *
 * These run without a PIN on purpose: with no session to lean on, the only durable proof
 * a receiver can present is its device token, or the single-use capability it was handed
 * when it accepted. That is the case the M4 ACL has to get right.
 *
 * A = sender, B = receiver, C = unrelated observer, host = carries the bytes but is not a
 * party to the transfer.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { startServer } from '../../src/server.js';
import { connectWs, waitForEventName, WebSocket } from '../helpers/ws.js';

const DEVICE_TOKEN_B = 'b'.repeat(64);
const PAYLOAD = Buffer.from('relay payload bytes for the receiver only\n');

const headers = ({ connectionId, deviceToken, hostToken } = {}) => {
  const result = {};
  if (connectionId) result['X-Connection-Id'] = connectionId;
  if (deviceToken) result['X-Device-Token'] = deviceToken;
  if (hostToken) result['X-Host-Token'] = hostToken;
  return result;
};

const jsonHeaders = (extra = {}) => ({ 'Content-Type': 'application/json', ...extra });

async function bootServer(prefix, overrides = {}) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  const serverInstance = await startServer({
    port: 0,
    host: '127.0.0.1',
    noBrowser: true,
    tempDir,
    uploadDir: path.join(tempDir, 'uploads'),
    dataDir: path.join(tempDir, 'data'),
    ...overrides,
  });
  const port = serverInstance.server.address().port;
  return { tempDir, serverInstance, port, baseUrl: `http://127.0.0.1:${port}` };
}

async function shutdown({ tempDir, serverInstance, clients = [] }) {
  for (const client of clients) {
    if (client?.ws && client.ws.readyState === WebSocket.OPEN) client.ws.terminate();
  }
  await serverInstance?.runtime?.history?.flush?.().catch(() => {});
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
}

/** Opens a relay to `receiverDeviceId` and returns the receiver's grant + token. */
async function relayAndAccept(ctx, { clientA, clientB, name, size }) {
  const offerRes = await fetch(`${ctx.baseUrl}/api/relay/offer`, {
    method: 'POST',
    headers: jsonHeaders(headers({ connectionId: clientA.connId })),
    body: JSON.stringify({
      receiverDeviceId: clientB.device.id,
      files: [{ name, size, mimeType: 'application/octet-stream' }],
    }),
  });
  assert.equal(offerRes.status, 201, JSON.stringify(await offerRes.clone().json()));
  const relayId = (await offerRes.json()).data.relay.relayId;

  const decisionRes = await fetch(`${ctx.baseUrl}/api/relay/decision`, {
    method: 'POST',
    headers: jsonHeaders(headers({ connectionId: clientB.connId, deviceToken: DEVICE_TOKEN_B })),
    body: JSON.stringify({ relayId, decisions: [{ index: 0, action: 'accept' }] }),
  });
  assert.equal(decisionRes.status, 200, JSON.stringify(await decisionRes.clone().json()));
  const file = (await decisionRes.json()).data.files[0];
  return { relayId, grantId: file.grantId, relayToken: file.relayToken };
}

describe('Relay file storage and download ACL (UT-022)', () => {
  let ctx;
  let clientA;
  let clientB;
  let clientC;
  let hostToken;

  before(async () => {
    ctx = await bootServer('utrans-relay-acl-', { relayTtlMs: 30000 });
    hostToken = ctx.serverInstance.app.locals.hostAuth.token;
    clientA = await connectWs(ctx.port, { deviceName: 'Sender', platform: 'linux' });
    clientB = await connectWs(ctx.port, {
      deviceName: 'Receiver',
      platform: 'android',
      deviceToken: DEVICE_TOKEN_B,
    });
    clientC = await connectWs(ctx.port, { deviceName: 'Observer', platform: 'ios' });
  });

  after(async () => {
    await shutdown({ ...ctx, clients: [clientA, clientB, clientC] });
  });

  /** Full flow for one file; returns the stored file id. */
  async function sendRelayFile(name) {
    const { grantId, relayToken } = await relayAndAccept(ctx, {
      clientA,
      clientB,
      name,
      size: PAYLOAD.length,
    });

    const form = new FormData();
    form.append('files', new Blob([PAYLOAD], { type: 'application/octet-stream' }), name);
    const uploadRes = await fetch(`${ctx.baseUrl}/api/upload`, {
      method: 'POST',
      headers: { ...headers({ connectionId: clientA.connId }), 'X-Transfer-Grant': grantId },
      body: form,
    });
    const uploadBody = await uploadRes.json();
    assert.equal(uploadRes.status, 201, JSON.stringify(uploadBody));
    assert.equal(uploadBody.data.uploaded[0].status, 'relayed');
    return { fileId: uploadBody.data.uploaded[0].fileId, relayToken, name };
  }

  it('stores the file in the relay area, never in the host receive dir or the share list', async () => {
    const { fileId } = await sendRelayFile('relay-a.bin');

    const relayEntries = await fs.promises.readdir(path.join(ctx.tempDir, 'relay'));
    assert.equal(relayEntries.length, 1);

    const received = await fs.promises.readdir(path.join(ctx.tempDir, 'uploads')).catch(() => []);
    assert.deepEqual(received, [], 'a relayed file must not land in the host receive dir');

    const shared = await fetch(`${ctx.baseUrl}/api/shared`, {
      headers: headers({ connectionId: clientC.connId }),
    });
    const sharedBody = await shared.json();
    assert.equal(sharedBody.data.fileCount, 0, 'a relayed file must not appear in /api/shared');
    assert.ok(!sharedBody.data.files.some((f) => f.id === fileId));
  });

  it('lets the receiver download with the capability it was given, byte-for-byte', async () => {
    const { fileId, relayToken } = await sendRelayFile('relay-b.bin');

    const res = await fetch(`${ctx.baseUrl}/api/download/${fileId}?rt=${relayToken}`);
    assert.equal(res.status, 200);
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(body, PAYLOAD);
  });

  it('lets the receiver download by device token, with no capability in the URL', async () => {
    const { fileId } = await sendRelayFile('relay-c.bin');

    const res = await fetch(`${ctx.baseUrl}/api/download/${fileId}`, {
      headers: headers({ deviceToken: DEVICE_TOKEN_B }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PAYLOAD);
  });

  it('serves range requests so a receiver can resume and preview', async () => {
    const { fileId, relayToken } = await sendRelayFile('relay-range.bin');

    const res = await fetch(`${ctx.baseUrl}/api/download/${fileId}?rt=${relayToken}`, {
      headers: { Range: 'bytes=0-3' },
    });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes 0-3/${PAYLOAD.length}`);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PAYLOAD.subarray(0, 4));
  });

  it('refuses everyone who is not the addressed receiver — including the host', async () => {
    const { fileId, relayToken } = await sendRelayFile('relay-private.bin');

    const observer = await fetch(`${ctx.baseUrl}/api/download/${fileId}`, {
      headers: headers({ connectionId: clientC.connId }),
    });
    assert.equal(observer.status, 403);
    assert.equal((await observer.json()).error.code, 'DOWNLOAD_FORBIDDEN');

    const host = await fetch(`${ctx.baseUrl}/api/download/${fileId}`, {
      headers: headers({ hostToken }),
    });
    assert.equal(host.status, 403, 'the host carries the file but may not read it');

    const wrongToken = await fetch(`${ctx.baseUrl}/api/download/${fileId}?rt=${'f'.repeat(64)}`);
    assert.equal(wrongToken.status, 403);

    // A different device token is not a skeleton key either.
    const otherDevice = await fetch(`${ctx.baseUrl}/api/download/${fileId}`, {
      headers: headers({ deviceToken: 'd'.repeat(64) }),
    });
    assert.equal(otherDevice.status, 403);

    // ...while the real receiver still gets through.
    const receiver = await fetch(`${ctx.baseUrl}/api/download/${fileId}?rt=${relayToken}`);
    assert.equal(receiver.status, 200);
  });

  it('lists the file to its receiver only', async () => {
    const { fileId, relayToken } = await sendRelayFile('relay-listed.bin');

    const mine = await fetch(`${ctx.baseUrl}/api/relay/incoming`, {
      headers: headers({ deviceToken: DEVICE_TOKEN_B, connectionId: clientB.connId }),
    });
    assert.equal(mine.status, 200);
    const mineBody = await mine.json();
    const entry = mineBody.data.files.find((f) => f.fileId === fileId);
    assert.ok(entry, 'the receiver must see its own relayed file');
    assert.equal(entry.hasToken, true);
    assert.equal(entry.name, 'relay-listed.bin');
    assert.ok(!JSON.stringify(mineBody).includes(relayToken), 'raw token must not be listed');

    const theirs = await fetch(`${ctx.baseUrl}/api/relay/incoming`, {
      headers: headers({ connectionId: clientC.connId }),
    });
    assert.deepEqual((await theirs.json()).data.files, []);
  });

  it('relays a chunked upload the same way, and only the receiver can fetch it', async () => {
    const name = 'relay-chunked.bin';
    // Small enough to be a single chunk (the configured chunk size is megabytes), which
    // keeps the assertion about routing and ACL rather than about chunk arithmetic.
    const total = Buffer.from('chunked relay payload');
    const checksum = crypto.createHash('sha256').update(total).digest('hex');

    const { grantId, relayToken } = await relayAndAccept(ctx, {
      clientA,
      clientB,
      name,
      size: total.length,
    });

    const initRes = await fetch(`${ctx.baseUrl}/api/upload/init`, {
      method: 'POST',
      headers: jsonHeaders({
        ...headers({ connectionId: clientA.connId }),
        'X-Transfer-Grant': grantId,
      }),
      body: JSON.stringify({
        fileName: name,
        fileSize: total.length,
        mimeType: 'application/octet-stream',
        checksum,
      }),
    });
    const initBody = await initRes.json();
    assert.equal(initRes.status, 200, JSON.stringify(initBody));
    const { uploadId, uploadToken, totalChunks } = initBody.data;
    assert.equal(totalChunks, 1);

    const form = new FormData();
    form.append('uploadId', uploadId);
    form.append('chunkIndex', '0');
    form.append('chunk', new Blob([total]), 'chunk_0');
    const chunkRes = await fetch(`${ctx.baseUrl}/api/upload/chunk`, {
      method: 'POST',
      headers: { 'X-Upload-Id': uploadId, 'X-Upload-Token': uploadToken },
      body: form,
    });
    assert.equal(chunkRes.status, 200, JSON.stringify(await chunkRes.clone().json()));

    const completeRes = await fetch(`${ctx.baseUrl}/api/upload/complete`, {
      method: 'POST',
      headers: jsonHeaders({ 'X-Upload-Token': uploadToken }),
      body: JSON.stringify({ uploadId }),
    });
    const completeBody = await completeRes.json();
    assert.equal(completeRes.status, 200, JSON.stringify(completeBody));
    assert.match(completeBody.data.relayId, /^rl_/);
    const fileId = completeBody.data.fileId;

    const receiver = await fetch(`${ctx.baseUrl}/api/download/${fileId}?rt=${relayToken}`);
    assert.equal(receiver.status, 200);
    assert.deepEqual(Buffer.from(await receiver.arrayBuffer()), total);

    const observer = await fetch(`${ctx.baseUrl}/api/download/${fileId}`, {
      headers: headers({ connectionId: clientC.connId }),
    });
    assert.equal(observer.status, 403);
  });

  it('lets the host delete what it is carrying, without ever reading it', async () => {
    const { fileId } = await sendRelayFile('relay-revoked.bin');
    const relayDir = path.join(ctx.tempDir, 'relay');
    const before = await fs.promises.readdir(relayDir);
    assert.ok(before.includes('relay-revoked.bin'));

    const revoke = await fetch(`${ctx.baseUrl}/api/relay/revoke`, {
      method: 'POST',
      headers: jsonHeaders(headers({ hostToken })),
      body: JSON.stringify({ fileId }),
    });
    assert.equal(revoke.status, 200);
    assert.equal((await revoke.json()).data.removed, 1);

    const after = await fetch(`${ctx.baseUrl}/api/download/${fileId}`, {
      headers: headers({ deviceToken: DEVICE_TOKEN_B }),
    });
    assert.equal(after.status, 404);

    const remaining = await fs.promises.readdir(relayDir);
    assert.ok(
      !remaining.includes('relay-revoked.bin'),
      'revoked bytes must leave the disk while other relays stay untouched'
    );
    assert.equal(remaining.length, before.length - 1, 'exactly one file was removed');
  });
});

describe('Relay file TTL (UT-022)', () => {
  let ctx;
  let clientA;
  let clientB;

  before(async () => {
    ctx = await bootServer('utrans-relay-ttl-', { relayTtlMs: 400 });
    clientA = await connectWs(ctx.port, { deviceName: 'Sender', platform: 'linux' });
    clientB = await connectWs(ctx.port, {
      deviceName: 'Receiver',
      platform: 'android',
      deviceToken: DEVICE_TOKEN_B,
    });
  });

  after(async () => {
    await shutdown({ ...ctx, clients: [clientA, clientB] });
  });

  it('deletes an undownloaded relay file after its TTL and releases its quota', async () => {
    const name = 'relay-ttl.bin';
    const { grantId } = await relayAndAccept(ctx, {
      clientA,
      clientB,
      name,
      size: PAYLOAD.length,
    });

    const form = new FormData();
    form.append('files', new Blob([PAYLOAD]), name);
    const uploadRes = await fetch(`${ctx.baseUrl}/api/upload`, {
      method: 'POST',
      headers: { ...headers({ connectionId: clientA.connId }), 'X-Transfer-Grant': grantId },
      body: form,
    });
    assert.equal(uploadRes.status, 201);
    const allocatedAfterUpload = ctx.serverInstance.runtime.quotaTracker.allocatedBytes;
    assert.ok(allocatedAfterUpload >= PAYLOAD.length);

    const senderEvent = await waitForEventName(clientA.events, 'relay:expired', 3000);
    assert.equal(senderEvent.data.reason, 'TIMEOUT');
    await waitForEventName(clientB.events, 'relay:expired', 3000);

    const entries = await fs.promises.readdir(path.join(ctx.tempDir, 'relay'));
    assert.deepEqual(entries, []);
    assert.equal(
      ctx.serverInstance.runtime.quotaTracker.allocatedBytes,
      allocatedAfterUpload - PAYLOAD.length,
      'the deleted file must give its quota back'
    );
  });
});
