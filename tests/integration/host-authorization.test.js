import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createRuntime } from '../../src/runtime.js';
import { createServer } from '../../src/server.js';
import { setupWebSocket } from '../../src/websocket/index.js';
import { createHostAuth } from '../../src/middleware/host-auth.js';

describe('Host authorization at HTTP and WebSocket interfaces', () => {
  let app, server, wss, base, root, hostToken, runtime;
  const sockets = [];
  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-host-auth-'));
    runtime = createRuntime({
      tempDir: root,
      uploadDir: path.join(root, 'received'),
    });
    app = createServer(runtime);
    hostToken = app.locals.hostAuth.token;
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    wss = setupWebSocket(server, {
      hostAuth: app.locals.hostAuth,
      sessions: app.locals.sessions,
      pinRequired: app.locals.pinRequired,
      discovery: app.locals.runtime.discovery,
    });
    app.set('wss', wss);
  });
  after(async () => {
    for (const socket of sockets) socket.terminate();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    await runtime.pendingUploadManager.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function connect(deviceId, token, isHost = false) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws');
    sockets.push(ws);
    const events = [];
    ws.on('message', (raw) => events.push(JSON.parse(raw)));
    await once(ws, 'open');
    const registered = once(ws, 'message');
    ws.send(
      JSON.stringify({ event: 'client:register', data: { deviceId, hostToken: token, isHost } })
    );
    const [raw] = await registered;
    return { ws, events, registration: JSON.parse(raw).data };
  }

  it('denies guessed credentials, spoofed headers, remote addresses and foreign origins', () => {
    const auth = createHostAuth();
    const request = {
      socket: { remoteAddress: '192.168.1.8', localAddress: '192.168.1.2' },
      headers: {},
    };
    assert.equal(auth.verify(request, auth.token), false);
    request.socket.remoteAddress = '::ffff:127.0.0.1';
    assert.equal(auth.verify(request, auth.token), true);
    assert.equal(auth.verify(request, 'x'.repeat(64)), false);
    assert.equal(auth.verify(request, 'é'.repeat(64)), false);
    request.headers = { host: 'localhost:8080', origin: 'https://untrusted.example' };
    assert.equal(auth.verify(request, auth.token), false);
    assert.notEqual(auth.token, createHostAuth().token);
  });

  it('only authenticated host receives requests; clients cannot accept or decline', async () => {
    const host = await connect('host', hostToken);
    const sender = await connect('sender', undefined, true);
    const other = await connect('other', 'fake-token', true);
    assert.equal(host.registration.device.isHost, true);
    assert.equal(sender.registration.device.isHost, false);
    assert.equal(other.registration.device.isHost, false);

    const proofBody = 'host-only-proof';
    const senderConnectionId = sender.registration.connectionId;

    // A client upload now begins as an offer: nothing reaches disk until the host agrees.
    const offerRes = await fetch(`${base}/api/transfer/offer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connection-Id': senderConnectionId },
      body: JSON.stringify({ files: [{ name: 'proof.txt', size: proofBody.length }] }),
    });
    assert.equal(offerRes.status, 201);
    const offerId = (await offerRes.json()).data.offer.offerId;

    // Ping barriers ensure earlier approval events have traversed every socket.
    for (const peer of [host, sender, other]) {
      await new Promise((resolve) => {
        const listener = (raw) => {
          if (JSON.parse(raw).event === 'server:pong') {
            peer.ws.off('message', listener);
            resolve();
          }
        };
        peer.ws.on('message', listener);
        peer.ws.send(JSON.stringify({ event: 'client:ping' }));
      });
    }
    assert.equal(host.events.filter((e) => e.event === 'transfer:offer').length, 1);
    for (const peer of [sender, other]) {
      assert.equal(
        peer.events.some((e) => e.event === 'transfer:offer'),
        false
      );
      assert.equal(JSON.stringify(peer.events).includes(hostToken), false);
    }

    // Clients can neither list nor decide offers, whatever they claim to be.
    assert.equal((await fetch(`${base}/api/transfer/offers`)).status, 403);
    for (const action of ['approve', 'reject']) {
      const response = await fetch(`${base}/api/transfer/offer/decision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Host-Token': 'wrong',
          'X-Forwarded-For': '127.0.0.1',
        },
        body: JSON.stringify({
          offerId,
          decisions: [{ index: 0, action }],
          isHost: true,
        }),
      });
      assert.equal(response.status, 403);
      assert.equal(runtime.offerService.getOffer(offerId).state, 'pending');
    }

    const headers = { 'Content-Type': 'application/json', 'X-Host-Token': hostToken };
    const missingToken = await fetch(`${base}/api/transfer/offer/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offerId, decisions: [{ index: 0, action: 'approve' }] }),
    });
    assert.equal(missingToken.status, 403);
    const foreignOrigin = await fetch(`${base}/api/transfer/offer/decision`, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://untrusted.example' },
      body: JSON.stringify({ offerId, decisions: [{ index: 0, action: 'approve' }] }),
    });
    assert.equal(foreignOrigin.status, 403);
    const info = await (await fetch(`${base}/api/info`)).text();
    assert.equal(info.includes(hostToken), false);

    const openOffers = await fetch(`${base}/api/transfer/offers`, { headers });
    assert.equal(openOffers.status, 200);
    assert.equal((await openOffers.json()).data.length, 1);

    // The host's approval is what issues the grant the sender spends to upload.
    const approved = await fetch(`${base}/api/transfer/offer/decision`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ offerId, decisions: [{ index: 0, action: 'approve' }] }),
    });
    assert.equal(approved.status, 200);
    const grantId = (await approved.json()).data.decisions[0].grantId;
    assert.ok(grantId);

    const form = new FormData();
    form.append('files', new Blob([proofBody]), 'proof.txt');
    const upload = await fetch(`${base}/api/upload`, {
      method: 'POST',
      body: form,
      headers: { 'X-Transfer-Grant': grantId, 'X-Connection-Id': senderConnectionId },
    });
    assert.equal(upload.status, 201);
    assert.equal(
      await fs.readFile(path.join(runtime.config.uploadDir, 'proof.txt'), 'utf8'),
      proofBody
    );
  });
});
