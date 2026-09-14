import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../../src/server.js';
import { setupWebSocket } from '../../src/websocket/index.js';
import { createHostAuth } from '../../src/middleware/host-auth.js';
import { config } from '../../src/config.js';
import { pendingUploadManager } from '../../src/services/pending-upload.js';

describe('Host authorization at HTTP and WebSocket interfaces', () => {
  let app, server, wss, base, root, hostToken;
  const sockets = [];
  const original = { tempDir: config.tempDir, uploadDir: config.uploadDir };
  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-host-auth-'));
    config.tempDir = root;
    config.uploadDir = path.join(root, 'received');
    app = createServer();
    hostToken = app.locals.hostAuth.token;
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    wss = setupWebSocket(server, app.locals.hostAuth);
    app.set('wss', wss);
  });
  after(async () => {
    for (const socket of sockets) socket.terminate();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    await pendingUploadManager.cleanup();
    Object.assign(config, original);
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

    const form = new FormData();
    form.append('files', new Blob(['host-only-proof']), 'proof.txt');
    const upload = await fetch(`${base}/api/upload`, { method: 'POST', body: form });
    assert.equal(upload.status, 201);
    const transferId = (await upload.json()).data.pending[0].transferId;

    // Ping barriers ensure earlier upload events have traversed every socket.
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
    assert.equal(host.events.filter((e) => e.event === 'upload:request').length, 1);
    for (const peer of [sender, other]) {
      assert.equal(
        peer.events.some((e) => e.event === 'upload:request'),
        false
      );
      assert.equal(JSON.stringify(peer.events).includes(hostToken), false);
    }

    assert.equal((await fetch(`${base}/api/upload/pending`)).status, 403);
    for (const action of ['accept', 'decline']) {
      const response = await fetch(`${base}/api/upload/decision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Host-Token': 'wrong',
          'X-Forwarded-For': '127.0.0.1',
        },
        body: JSON.stringify({ transferId, action, isHost: true }),
      });
      assert.equal(response.status, 403);
      assert.ok(pendingUploadManager.getPending(transferId));
    }
    const headers = { 'Content-Type': 'application/json', 'X-Host-Token': hostToken };
    const missingToken = await fetch(`${base}/api/upload/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transferId, action: 'accept' }),
    });
    assert.equal(missingToken.status, 403);
    const foreignOrigin = await fetch(`${base}/api/upload/decision`, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://untrusted.example' },
      body: JSON.stringify({ transferId, action: 'accept' }),
    });
    assert.equal(foreignOrigin.status, 403);
    const info = await (await fetch(`${base}/api/info`)).text();
    assert.equal(info.includes(hostToken), false);
    const pending = await fetch(`${base}/api/upload/pending`, { headers });
    assert.equal(pending.status, 200);
    const accepted = await fetch(`${base}/api/upload/decision`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ transferId, action: 'accept' }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(
      await fs.readFile(path.join(config.uploadDir, 'proof.txt'), 'utf8'),
      'host-only-proof'
    );
  });
});
