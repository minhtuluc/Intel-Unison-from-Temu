/**
 * UT-002 — when a PIN is configured, every data route and WebSocket broadcast
 * requires either a valid session capability or host capability.
 * When no PIN is configured the previous open-LAN behaviour is preserved.
 */
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

const PIN = '4321';

function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => server);
}

async function listFilesRecursive(dir) {
  try {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

describe('UT-002: PIN policy gates every data route and WebSocket', () => {
  let app, server, base, wss, root, hostToken, pinToken, runtime;
  const sockets = [];

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-session-auth-'));
    runtime = createRuntime({
      pin: PIN,
      tempDir: path.join(root, 'temp'),
      uploadDir: path.join(root, 'received'),
    });
    app = createServer(runtime);
    hostToken = app.locals.hostAuth.token;
    server = await listen(app);
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
    await app.locals.sessions.revokeAll();
    runtime.shareManager.clear();
    await runtime.pendingUploadManager.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  const hostHeaders = () => ({ 'Content-Type': 'application/json', 'X-Host-Token': hostToken });
  const sessionHeaders = () => ({
    'Content-Type': 'application/json',
    'X-Session-Token': pinToken,
  });

  it('does not leak the PIN through public discovery endpoints', async () => {
    const res = await fetch(`${base}/api/info`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.pinRequired, true);
    assert.equal(JSON.stringify(body).includes(PIN), false);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  });

  it('rejects wrong, missing and expired-looking credentials on public and data routes', async () => {
    const wrongPin = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '0000' }),
    });
    assert.equal(wrongPin.status, 401);

    for (const url of ['/api/shared', '/api/upload/pending', '/api/upload/status/x']) {
      const res = await fetch(`${base}${url}`);
      assert.ok([401, 403].includes(res.status), `${url} -> ${res.status}`);
    }
    const forged = await fetch(`${base}/api/shared`, {
      headers: { 'X-Session-Token': 'a'.repeat(64) },
    });
    assert.equal(forged.status, 401);
  });

  it('issues a session for the correct PIN and accepts it on every data route', async () => {
    const auth = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: PIN }),
    });
    assert.equal(auth.status, 200);
    const authBody = await auth.json();
    pinToken = authBody.data.token;
    assert.match(pinToken, /^[a-f0-9]{64}$/);
    assert.ok(authBody.data.expiresAt);

    // Stage a fixture as the host, then read it back with the session token.
    const fixture = path.join(root, 'fixture.txt');
    await fs.writeFile(fixture, 'session-gated-payload');
    const staged = await fetch(`${base}/api/share`, {
      method: 'POST',
      headers: hostHeaders(),
      body: JSON.stringify({ paths: [fixture] }),
    });
    assert.equal(staged.status, 201);

    const shared = await fetch(`${base}/api/shared`, { headers: sessionHeaders() });
    assert.equal(shared.status, 200);
    const fileId = (await shared.json()).data.files[0].id;

    const download = await fetch(`${base}/api/download/${fileId}`, { headers: sessionHeaders() });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'session-gated-payload');

    const init = await fetch(`${base}/api/upload/init`, {
      method: 'POST',
      headers: sessionHeaders(),
      body: JSON.stringify({ fileName: 'big.bin', fileSize: 1024 }),
    });
    assert.equal(init.status, 200);

    // The host capability keeps working on gated routes.
    const hostRead = await fetch(`${base}/api/upload/pending`, { headers: hostHeaders() });
    assert.equal(hostRead.status, 200);
  });

  it('rejects upload attempts without a session and writes nothing to disk', async () => {
    const chunksDir = path.join(runtime.config.tempDir, 'chunks');
    const pendingDir = path.join(runtime.config.tempDir, 'pending');
    const stagingDir = path.join(runtime.config.tempDir, 'staging');
    const before = {
      chunks: await listFilesRecursive(chunksDir),
      pending: await listFilesRecursive(pendingDir),
      staging: await listFilesRecursive(stagingDir),
    };

    const form = new FormData();
    form.append('files', new Blob(['unauthenticated-payload']), 'intruder.txt');
    const upload = await fetch(`${base}/api/upload`, { method: 'POST', body: form });
    assert.equal(upload.status, 401);

    const share = await fetch(`${base}/api/share`, { method: 'POST', body: form });
    assert.equal(share.status, 401);

    const init = await fetch(`${base}/api/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'big.bin', fileSize: 1024 }),
    });
    assert.equal(init.status, 401);

    assert.deepEqual(await listFilesRecursive(chunksDir), before.chunks);
    assert.deepEqual(await listFilesRecursive(pendingDir), before.pending);
    assert.deepEqual(
      await listFilesRecursive(stagingDir),
      before.staging,
      'multipart staging must not run before the session guard'
    );
  });

  it('gates WebSocket broadcasts until the socket authenticates', async () => {
    const open = async () => {
      const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws');
      sockets.push(ws);
      const events = [];
      ws.on('message', (raw) => events.push(JSON.parse(raw)));
      await once(ws, 'open');
      return { ws, events };
    };

    const anonymous = await open();
    anonymous.ws.send(
      JSON.stringify({ event: 'client:register', data: { deviceId: 'anon', isHost: true } })
    );
    const forged = await open();
    forged.ws.send(
      JSON.stringify({
        event: 'client:register',
        data: { deviceId: 'forged', hostToken: 'f'.repeat(64), isHost: true },
      })
    );
    const member = await open();
    member.ws.send(
      JSON.stringify({
        event: 'client:register',
        data: { deviceId: 'member', sessionToken: pinToken },
      })
    );
    const host = await open();
    host.ws.send(
      JSON.stringify({ event: 'client:register', data: { deviceId: 'host', hostToken } })
    );

    // Trigger one broadcast and wait for it to reach every socket.
    for (const peer of [anonymous, forged, member, host]) {
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

    const broadcastForm = new FormData();
    broadcastForm.append('files', new Blob(['broadcast']), 'broadcast.txt');
    await fetch(`${base}/api/share`, {
      method: 'POST',
      headers: { 'X-Session-Token': pinToken },
      body: broadcastForm,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(
      anonymous.events.some((e) => e.event === 'client:rejected'),
      true
    );
    assert.equal(
      forged.events.some((e) => e.event === 'client:rejected'),
      true
    );
    for (const peer of [anonymous, forged]) {
      assert.equal(
        peer.events.some((e) => e.event === 'share:update'),
        false
      );
      assert.equal(
        peer.events.some((e) => e.event === 'device:join'),
        false
      );
    }
    assert.equal(
      member.events.some((e) => e.event === 'share:update'),
      true
    );
    assert.equal(
      host.events.some((e) => e.event === 'share:update'),
      true
    );
    // The host registered last, so only previously authenticated peers saw it join.
    assert.equal(
      member.events.some((e) => e.event === 'device:join'),
      true
    );
  });

  it('accepts the session cookie on the WebSocket handshake for additional tabs', async () => {
    const auth = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: PIN }),
    });
    const cookie = (auth.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^utrans_session=[a-f0-9]{64}$/);

    const wsUrl = base.replace('http:', 'ws:') + '/ws';
    const cookieOnly = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
    sockets.push(cookieOnly);
    const events = [];
    cookieOnly.on('message', (raw) => events.push(JSON.parse(raw)));
    await once(cookieOnly, 'open');
    cookieOnly.send(
      JSON.stringify({ event: 'client:register', data: { deviceName: 'second tab' } })
    );
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(
      events.some((e) => e.event === 'client:registered'),
      true,
      'a tab holding the session cookie must register without re-entering the PIN'
    );
    assert.equal(
      events.some((e) => e.event === 'client:rejected'),
      false
    );

    const forged = new WebSocket(wsUrl, {
      headers: { Cookie: `utrans_session=${'c'.repeat(64)}` },
    });
    sockets.push(forged);
    const forgedEvents = [];
    forged.on('message', (raw) => forgedEvents.push(JSON.parse(raw)));
    await once(forged, 'open');
    forged.send(JSON.stringify({ event: 'client:register', data: { deviceName: 'forged tab' } }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      forgedEvents.some((e) => e.event === 'client:rejected'),
      true
    );
  });

  it('accepts the session cookie so browser media and download URLs work', async () => {
    // <img>, <video> and <a download> cannot set custom headers; the cookie is the
    // only way those requests can carry the session.
    const cookieHeaders = {
      Cookie: `utrans_session=${pinToken}`,
    };

    const auth = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: PIN }),
    });
    const setCookie = auth.headers.get('set-cookie') || '';
    const cookieToken = setCookie.match(/utrans_session=([a-f0-9]{64})/)?.[1];
    assert.ok(cookieToken);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.notEqual(cookieToken, PIN);

    const shared = await fetch(`${base}/api/shared`, { headers: cookieHeaders });
    assert.equal(shared.status, 200);
    const fileId = (await shared.json()).data.files[0].id;
    const download = await fetch(`${base}/api/download/${fileId}`, { headers: cookieHeaders });
    assert.equal(download.status, 200);

    // A forged cookie is rejected.
    const forgedCookie = await fetch(`${base}/api/shared`, {
      headers: { Cookie: `utrans_session=${'b'.repeat(64)}` },
    });
    assert.equal(forgedCookie.status, 401);
  });

  it('revokes sessions at logout and blocks host-only revocation for clients', async () => {
    const clientRevoke = await fetch(`${base}/api/auth/revoke-all`, {
      method: 'POST',
      headers: sessionHeaders(),
    });
    assert.ok([401, 403].includes(clientRevoke.status));

    const logout = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: sessionHeaders(),
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') || '', /utrans_session=;/);
    assert.equal((await fetch(`${base}/api/shared`, { headers: sessionHeaders() })).status, 401);
  });

  it('lets the host revoke every session at once', async () => {
    const auth = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: PIN }),
    });
    const token = (await auth.json()).data.token;
    assert.equal(
      (await fetch(`${base}/api/shared`, { headers: { 'X-Session-Token': token } })).status,
      200
    );

    const revokeAll = await fetch(`${base}/api/auth/revoke-all`, {
      method: 'POST',
      headers: hostHeaders(),
    });
    assert.equal(revokeAll.status, 200);
    assert.equal(
      (await fetch(`${base}/api/shared`, { headers: { 'X-Session-Token': token } })).status,
      401
    );
  });
});

describe('UT-002: without a PIN the LAN behaviour is unchanged', () => {
  let app, server, base, root, runtime;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-no-pin-'));
    runtime = createRuntime({
      pin: null,
      tempDir: path.join(root, 'temp'),
      uploadDir: path.join(root, 'received'),
    });
    app = createServer(runtime);
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    runtime.shareManager.clear();
    await runtime.pendingUploadManager.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('serves discovery and data routes without any token when no PIN is set', async () => {
    const info = await (await fetch(`${base}/api/info`)).json();
    assert.equal(info.data.pinRequired, false);
    assert.equal((await fetch(`${base}/api/shared`)).status, 200);

    const form = new FormData();
    form.append('files', new Blob(['open-lan']), 'open.txt');
    const res = await fetch(`${base}/api/upload`, { method: 'POST', body: form });
    assert.equal(res.status, 201);
  });
});
