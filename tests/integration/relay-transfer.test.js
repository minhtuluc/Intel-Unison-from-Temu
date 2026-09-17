/**
 * Relay transfers (M4 / UT-021) — integration tests at the real HTTP + WebSocket seam.
 *
 * These run three independent clients plus a host socket against a live server:
 *   A = sender, B = receiver, C = unrelated observer.
 * The acceptance for M4 is that only B is offered the transfer, only B may decide, and
 * nobody else can act on it — including the host.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../../src/server.js';
import { connectWs, waitForEvent, waitForEventName, delay, WebSocket } from '../helpers/ws.js';

const PIN = '1234';
const DEVICE_TOKEN_A = 'a'.repeat(64);
const DEVICE_TOKEN_B = 'b'.repeat(64);
const DEVICE_TOKEN_C = 'c'.repeat(64);

const jsonHeaders = ({ sessionToken, hostToken, connectionId, deviceToken } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (sessionToken) headers['X-Session-Token'] = sessionToken;
  if (hostToken) headers['X-Host-Token'] = hostToken;
  if (connectionId) headers['X-Connection-Id'] = connectionId;
  if (deviceToken) headers['X-Device-Token'] = deviceToken;
  return headers;
};

const offerBody = (receiverDeviceId, name = 'relay.bin', size = 128) => ({
  receiverDeviceId,
  files: [{ name, size, mimeType: 'application/octet-stream' }],
});

/** Starts a server and returns everything a test needs to talk to it. */
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

describe('Relay transfers — receiver-only consent (UT-021)', () => {
  let ctx;
  let hostToken;
  let tokenA;
  let tokenB;
  let tokenC;
  let clientA;
  let clientB;
  let clientC;
  let hostSocket;

  before(async () => {
    ctx = await bootServer('utrans-relay-test-', {
      pin: PIN,
      offerTtlMs: 30000,
      relayTtlMs: 30000,
    });
    hostToken = ctx.serverInstance.app.locals.hostAuth.token;

    const auth = async () => {
      const res = await fetch(`${ctx.baseUrl}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: PIN }),
      });
      assert.equal(res.status, 200);
      return (await res.json()).data.token;
    };
    tokenA = await auth();
    tokenB = await auth();
    tokenC = await auth();

    clientA = await connectWs(ctx.port, {
      sessionToken: tokenA,
      deviceName: 'Sender laptop',
      platform: 'linux',
    });
    clientB = await connectWs(ctx.port, {
      sessionToken: tokenB,
      deviceName: 'Receiver phone',
      platform: 'android',
      deviceToken: DEVICE_TOKEN_B,
    });
    clientC = await connectWs(ctx.port, {
      sessionToken: tokenC,
      deviceName: 'Observer phone',
      platform: 'ios',
    });
    hostSocket = await connectWs(ctx.port, {
      hostToken,
      deviceName: 'Host machine',
      platform: 'windows',
    });
  });

  after(async () => {
    await shutdown({
      ...ctx,
      clients: [clientA, clientB, clientC, hostSocket],
    });
  });

  /** Sender A opens a relay to B and returns the relay id. */
  async function openRelay(fileName) {
    const res = await fetch(`${ctx.baseUrl}/api/relay/offer`, {
      method: 'POST',
      headers: jsonHeaders({ sessionToken: tokenA, connectionId: clientA.connId }),
      body: JSON.stringify(offerBody(clientB.device.id, fileName)),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    return body.data.relay;
  }

  /** Receiver B decides one file. */
  function decideB(relayId, action, extra = {}) {
    return fetch(`${ctx.baseUrl}/api/relay/decision`, {
      method: 'POST',
      headers: jsonHeaders({
        sessionToken: tokenB,
        connectionId: clientB.connId,
        deviceToken: DEVICE_TOKEN_B,
        ...extra,
      }),
      body: JSON.stringify({ relayId, decisions: [{ index: 0, action }] }),
    });
  }

  it('offers the transfer to the chosen receiver only, and never to the host', async () => {
    const relay = await openRelay('to-b.bin');
    assert.match(relay.relayId, /^rl_/);
    assert.equal(relay.state, 'pending');
    // The receiver is identified by server state, not by anything the sender claimed.
    assert.equal(relay.receiver.deviceId, clientB.device.id);
    assert.equal(relay.receiver.labelUntrusted, true);
    assert.equal(relay.sender.labelUntrusted, true);

    const received = await waitForEventName(clientB.events, 'relay:offer');
    assert.equal(received.data.relay.relayId, relay.relayId);

    assert.equal(clientA.events.filter((e) => e.event === 'relay:offer').length, 0);
    assert.equal(clientC.events.filter((e) => e.event === 'relay:offer').length, 0);
    assert.equal(hostSocket.events.filter((e) => e.event === 'relay:offer').length, 0);

    // The host is told a relay exists for its management view — it is not asked to decide.
    const hostUpdate = await waitForEventName(hostSocket.events, 'relay:update');
    assert.equal(hostUpdate.data.relay.relayId, relay.relayId);
  });

  it('never exposes a download token or a grant in what is broadcast or readable', async () => {
    const relay = await openRelay('no-leak.bin');
    await waitForEventName(clientB.events, 'relay:offer');

    for (const client of [clientA, clientB, clientC, hostSocket]) {
      for (const event of client.events) {
        const text = JSON.stringify(event);
        assert.ok(!text.includes('relayToken'), `token leaked in ${event.event}`);
        assert.ok(!text.includes('grantId'), `grant leaked in ${event.event}`);
      }
    }

    const read = await fetch(`${ctx.baseUrl}/api/relay/offer/${relay.relayId}`, {
      headers: jsonHeaders({ sessionToken: tokenA, connectionId: clientA.connId }),
    });
    const readBody = await read.json();
    assert.equal(read.status, 200);
    assert.ok(!JSON.stringify(readBody).includes('relayToken'));
    assert.ok(!JSON.stringify(readBody).includes(ctx.tempDir), 'internal path leaked');
  });

  it('refuses to relay to a device that is not connected', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/relay/offer`, {
      method: 'POST',
      headers: jsonHeaders({ sessionToken: tokenA, connectionId: clientA.connId }),
      body: JSON.stringify(offerBody('11111111-2222-3333-4444-555555555555')),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'RECEIVER_OFFLINE');
  });

  it('refuses a relay addressed to the sender itself', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/relay/offer`, {
      method: 'POST',
      headers: jsonHeaders({ sessionToken: tokenA, connectionId: clientA.connId }),
      body: JSON.stringify(offerBody(clientA.device.id, 'self.bin')),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'RELAY_SELF');
  });

  it('lets only the receiver decide — not an observer, not the host', async () => {
    const relay = await openRelay('decide.bin');

    const observer = await fetch(`${ctx.baseUrl}/api/relay/decision`, {
      method: 'POST',
      headers: jsonHeaders({ sessionToken: tokenC, connectionId: clientC.connId }),
      body: JSON.stringify({ relayId: relay.relayId, decisions: [{ index: 0, action: 'accept' }] }),
    });
    assert.equal(observer.status, 403);
    assert.equal((await observer.json()).error.code, 'RELAY_FORBIDDEN');

    // The host carries the bytes but has no consent authority here.
    const hostDecision = await fetch(`${ctx.baseUrl}/api/relay/decision`, {
      method: 'POST',
      headers: jsonHeaders({ hostToken }),
      body: JSON.stringify({ relayId: relay.relayId, decisions: [{ index: 0, action: 'accept' }] }),
    });
    assert.equal(hostDecision.status, 403);
    assert.equal((await hostDecision.json()).error.code, 'RELAY_FORBIDDEN');

    const receiver = await decideB(relay.relayId, 'accept');
    const receiverBody = await receiver.json();
    assert.equal(receiver.status, 200, JSON.stringify(receiverBody));
    assert.equal(receiverBody.data.files[0].decision, 'accepted');
    assert.match(receiverBody.data.files[0].grantId, /^gr_/);
    // The download capability is handed over exactly once, in this response.
    assert.match(receiverBody.data.files[0].relayToken, /^[a-f0-9]{64}$/);

    // A declined file issues no grant and no token.
    const declined = await openRelay('declined.bin');
    const declinedRes = await decideB(declined.relayId, 'decline');
    const declinedBody = await declinedRes.json();
    assert.equal(declinedRes.status, 200);
    assert.equal(declinedBody.data.files[0].decision, 'declined');
    assert.equal(declinedBody.data.files[0].grantId, null);
    assert.equal(declinedBody.data.files[0].relayToken, null);
  });

  it('does not let a peer decide twice or revive a closed relay', async () => {
    const relay = await openRelay('double.bin');
    assert.equal((await decideB(relay.relayId, 'accept')).status, 200);

    const second = await decideB(relay.relayId, 'accept');
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.code, 'RELAY_CLOSED');
  });

  it('hides another peer’s relay from a third party', async () => {
    const relay = await openRelay('private.bin');

    const observer = await fetch(`${ctx.baseUrl}/api/relay/offer/${relay.relayId}`, {
      headers: jsonHeaders({ sessionToken: tokenC, connectionId: clientC.connId }),
    });
    assert.equal(observer.status, 403);

    const receiver = await fetch(`${ctx.baseUrl}/api/relay/offer/${relay.relayId}`, {
      headers: jsonHeaders({ sessionToken: tokenB, connectionId: clientB.connId }),
    });
    assert.equal(receiver.status, 200);
  });

  it('binds the relay grant to the sender connection, so nobody else can spend it', async () => {
    const relay = await openRelay('grant-bound.bin');
    const decision = await decideB(relay.relayId, 'accept');
    const grantId = (await decision.json()).data.files[0].grantId;

    // C holds a valid session and its own connection, but not this grant.
    const res = await fetch(`${ctx.baseUrl}/api/upload/init`, {
      method: 'POST',
      headers: {
        ...jsonHeaders({ sessionToken: tokenC, connectionId: clientC.connId }),
        'X-Transfer-Grant': grantId,
      },
      body: JSON.stringify({
        fileName: 'grant-bound.bin',
        fileSize: 128,
        mimeType: 'application/octet-stream',
        checksum: 'a'.repeat(64),
      }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'TRANSFER_GRANT_INVALID');
  });

  it('lets the sender cancel its own relay and refuses a third party', async () => {
    const relay = await openRelay('cancel.bin');

    const observer = await fetch(`${ctx.baseUrl}/api/relay/offer/cancel`, {
      method: 'POST',
      headers: jsonHeaders({ sessionToken: tokenC, connectionId: clientC.connId }),
      body: JSON.stringify({ relayId: relay.relayId }),
    });
    assert.equal(observer.status, 403);

    const sender = await fetch(`${ctx.baseUrl}/api/relay/offer/cancel`, {
      method: 'POST',
      headers: jsonHeaders({ sessionToken: tokenA, connectionId: clientA.connId }),
      body: JSON.stringify({ relayId: relay.relayId }),
    });
    assert.equal(sender.status, 200);
    assert.equal((await sender.json()).data.relay.state, 'cancelled');
  });

  it('never lets the sender, an observer or the host see the receiver’s download capability', async () => {
    const relay = await openRelay('capability.bin');
    const decision = await decideB(relay.relayId, 'accept');
    const decisionBody = await decision.json();
    const token = decisionBody.data.files[0].relayToken;
    const grantId = decisionBody.data.files[0].grantId;
    assert.match(token, /^[a-f0-9]{64}$/);

    // The sender must still learn what it may upload...
    const senderEvent = await waitForEvent(
      clientA.events,
      (event) => event.event === 'relay:decision' && event.data?.relayId === relay.relayId
    );
    assert.equal(senderEvent.data.files[0].grantId, grantId);
    assert.equal(senderEvent.data.files[0].relayToken, undefined);
    await delay(60);

    // ...but the capability is the receiver's alone, everywhere (M4-QC-01).
    for (const [who, client] of [
      ['sender', clientA],
      ['observer', clientC],
      ['host', hostSocket],
      ['receiver', clientB],
    ]) {
      const leaked = client.events.filter((event) => JSON.stringify(event).includes(token));
      assert.equal(leaked.length, 0, `${who} must never receive the raw download capability`);
      const named = client.events.filter((event) => JSON.stringify(event).includes('relayToken'));
      assert.equal(named.length, 0, `${who} must not even see a relayToken field`);
    }
  });

  it('does not grant readback to a peer that only claims another connection id', async () => {
    const relay = await openRelay('readback.bin');

    // C presents its own session but A's connection id (M4-QC-02).
    const spoof = await fetch(`${ctx.baseUrl}/api/relay/offer/${relay.relayId}`, {
      headers: jsonHeaders({ sessionToken: tokenC, connectionId: clientA.connId }),
    });
    assert.equal(spoof.status, 403);

    // The two real parties still read it.
    const asSender = await fetch(`${ctx.baseUrl}/api/relay/offer/${relay.relayId}`, {
      headers: jsonHeaders({ sessionToken: tokenA, connectionId: clientA.connId }),
    });
    assert.equal(asSender.status, 200);

    const asReceiver = await fetch(`${ctx.baseUrl}/api/relay/offer/${relay.relayId}`, {
      headers: jsonHeaders({ sessionToken: tokenB, connectionId: clientB.connId }),
    });
    assert.equal(asReceiver.status, 200);
  });

  it('keeps a reconnected receiver able to decide, as a brand-new connection', async () => {
    const relay = await openRelay('reconnect.bin');

    clientB.ws.terminate();
    await delay(60);
    const reconnected = await connectWs(ctx.port, {
      sessionToken: tokenB,
      deviceName: 'Receiver phone (reconnected)',
      platform: 'android',
      deviceToken: DEVICE_TOKEN_B,
    });
    assert.notEqual(reconnected.connId, clientB.connId);
    clientB = reconnected;

    const res = await fetch(`${ctx.baseUrl}/api/relay/decision`, {
      method: 'POST',
      headers: jsonHeaders({
        sessionToken: tokenB,
        connectionId: clientB.connId,
        deviceToken: DEVICE_TOKEN_B,
      }),
      body: JSON.stringify({ relayId: relay.relayId, decisions: [{ index: 0, action: 'accept' }] }),
    });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  });

  it('lists sent and incoming relays only to their own parties', async () => {
    const sent = await fetch(`${ctx.baseUrl}/api/relay/sent`, {
      headers: jsonHeaders({ sessionToken: tokenA, connectionId: clientA.connId }),
    });
    assert.equal(sent.status, 200);
    assert.ok((await sent.json()).data.relays.length > 0);

    const incoming = await fetch(`${ctx.baseUrl}/api/relay/incoming`, {
      headers: jsonHeaders({ sessionToken: tokenB, connectionId: clientB.connId }),
    });
    assert.equal(incoming.status, 200);
    assert.ok(Array.isArray((await incoming.json()).data.files));

    const observerIncoming = await fetch(`${ctx.baseUrl}/api/relay/incoming`, {
      headers: jsonHeaders({ sessionToken: tokenC, connectionId: clientC.connId }),
    });
    assert.equal(observerIncoming.status, 200);
    assert.deepEqual((await observerIncoming.json()).data.files, []);
  });

  it('lets the host see what is in flight and stop it, but never decide or download', async () => {
    const active = await fetch(`${ctx.baseUrl}/api/relay/active`, {
      headers: jsonHeaders({ hostToken }),
    });
    assert.equal(active.status, 200);
    const activeBody = await active.json();
    assert.ok(Array.isArray(activeBody.data.relays));
    assert.ok(!JSON.stringify(activeBody).includes('relayToken'));

    const nonHost = await fetch(`${ctx.baseUrl}/api/relay/active`, {
      headers: jsonHeaders({ sessionToken: tokenC, connectionId: clientC.connId }),
    });
    assert.equal(nonHost.status, 403);

    const relay = await openRelay('host-revoke.bin');
    const revoke = await fetch(`${ctx.baseUrl}/api/relay/revoke`, {
      method: 'POST',
      headers: jsonHeaders({ hostToken }),
      body: JSON.stringify({ relayId: relay.relayId }),
    });
    assert.equal(revoke.status, 200);

    const after = await fetch(`${ctx.baseUrl}/api/relay/offer/${relay.relayId}`, {
      headers: jsonHeaders({ hostToken }),
    });
    assert.equal((await after.json()).data.relay.state, 'cancelled');
  });

  it('requires a verified connection for the sender side of the API', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/relay/offer`, {
      method: 'POST',
      headers: jsonHeaders({ sessionToken: tokenA }),
      body: JSON.stringify(offerBody(clientB.device.id, 'no-conn.bin')),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'INVALID_CONNECTION_ID');
  });
});

describe('Relay transfers — an unanswered offer ends loudly and writes nothing (UT-021)', () => {
  let ctx;
  let tokenA;
  let tokenB;
  let clientA;
  let clientB;

  before(async () => {
    ctx = await bootServer('utrans-relay-expiry-', { pin: PIN, offerTtlMs: 400 });
    const auth = async () => {
      const res = await fetch(`${ctx.baseUrl}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: PIN }),
      });
      return (await res.json()).data.token;
    };
    tokenA = await auth();
    tokenB = await auth();
    clientA = await connectWs(ctx.port, { sessionToken: tokenA, deviceName: 'Sender' });
    clientB = await connectWs(ctx.port, { sessionToken: tokenB, deviceName: 'Receiver' });
  });

  after(async () => {
    await shutdown({ ...ctx, clients: [clientA, clientB] });
  });

  it('tells both peers when the receiver never answers, and leaves no bytes behind', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/relay/offer`, {
      method: 'POST',
      headers: jsonHeaders({ sessionToken: tokenA, connectionId: clientA.connId }),
      body: JSON.stringify(offerBody(clientB.device.id, 'ignored.bin', 64)),
    });
    const relayId = (await res.json()).data.relay.relayId;

    const senderEvent = await waitForEventName(clientA.events, 'relay:offer:expired', 2500);
    assert.equal(senderEvent.data.relayId, relayId);
    assert.equal(senderEvent.data.reason, 'TIMEOUT');
    await waitForEventName(clientB.events, 'relay:offer:expired', 2500);

    const entries = await fs.promises.readdir(path.join(ctx.tempDir, 'relay')).catch(() => []);
    assert.deepEqual(entries, []);

    // The offer is closed, so a late decision cannot revive it.
    const late = await fetch(`${ctx.baseUrl}/api/relay/decision`, {
      method: 'POST',
      headers: jsonHeaders({ sessionToken: tokenB, connectionId: clientB.connId }),
      body: JSON.stringify({ relayId, decisions: [{ index: 0, action: 'accept' }] }),
    });
    assert.equal(late.status, 409);
    assert.equal((await late.json()).error.code, 'RELAY_CLOSED');
  });
});

describe('Relay transfers — durable identity without a PIN (UT-020 + UT-021)', () => {
  let ctx;
  let clientA;
  let clientB;
  let clientC;

  before(async () => {
    // No PIN: there is no session to lean on, so the device token is the only durable
    // identity a receiver can present. That is exactly the M4 requirement.
    ctx = await bootServer('utrans-relay-nopin-', { offerTtlMs: 30000 });
    clientA = await connectWs(ctx.port, {
      deviceName: 'Sender',
      platform: 'linux',
      deviceToken: DEVICE_TOKEN_A,
    });
    clientB = await connectWs(ctx.port, {
      deviceName: 'Receiver',
      platform: 'android',
      deviceToken: DEVICE_TOKEN_B,
    });
    clientC = await connectWs(ctx.port, {
      deviceName: 'Observer',
      platform: 'ios',
      deviceToken: DEVICE_TOKEN_C,
    });
  });

  after(async () => {
    await shutdown({ ...ctx, clients: [clientA, clientB, clientC] });
  });

  it('does not treat a claimed sender connection id as no-PIN readback authority', async () => {
    const offer = await fetch(`${ctx.baseUrl}/api/relay/offer`, {
      method: 'POST',
      headers: jsonHeaders({ connectionId: clientA.connId, deviceToken: DEVICE_TOKEN_A }),
      body: JSON.stringify(offerBody(clientB.device.id, 'nopin-readback.bin')),
    });
    const relay = (await offer.json()).data.relay;
    assert.equal(offer.status, 201);

    const spoofed = await fetch(`${ctx.baseUrl}/api/relay/offer/${relay.relayId}`, {
      headers: jsonHeaders({ connectionId: clientA.connId, deviceToken: DEVICE_TOKEN_C }),
    });
    assert.equal(spoofed.status, 403);

    const sender = await fetch(`${ctx.baseUrl}/api/relay/offer/${relay.relayId}`, {
      headers: jsonHeaders({ connectionId: clientA.connId, deviceToken: DEVICE_TOKEN_A }),
    });
    assert.equal(sender.status, 200);
  });

  it('still recognizes and authorizes the receiver after a reconnect', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/relay/offer`, {
      method: 'POST',
      headers: jsonHeaders({ connectionId: clientA.connId, deviceToken: DEVICE_TOKEN_A }),
      body: JSON.stringify(offerBody(clientB.device.id, 'nopin.bin')),
    });
    const relay = (await res.json()).data.relay;
    assert.equal(res.status, 201);

    clientB.ws.terminate();
    await delay(60);
    const reconnected = await connectWs(ctx.port, {
      deviceName: 'Receiver (reconnected)',
      platform: 'android',
      deviceToken: DEVICE_TOKEN_B,
    });
    assert.notEqual(reconnected.connId, clientB.connId);
    clientB = reconnected;

    // The observer has no device token, so it cannot borrow the receiver's identity.
    const observer = await fetch(`${ctx.baseUrl}/api/relay/decision`, {
      method: 'POST',
      headers: jsonHeaders({ connectionId: clientC.connId }),
      body: JSON.stringify({ relayId: relay.relayId, decisions: [{ index: 0, action: 'accept' }] }),
    });
    assert.equal(observer.status, 403);

    const receiver = await fetch(`${ctx.baseUrl}/api/relay/decision`, {
      method: 'POST',
      headers: jsonHeaders({ connectionId: clientB.connId, deviceToken: DEVICE_TOKEN_B }),
      body: JSON.stringify({ relayId: relay.relayId, decisions: [{ index: 0, action: 'accept' }] }),
    });
    assert.equal(receiver.status, 200, JSON.stringify(await receiver.clone().json()));
  });
});
