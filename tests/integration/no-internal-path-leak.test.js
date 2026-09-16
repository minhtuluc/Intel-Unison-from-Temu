/**
 * UT-015 — responses must not disclose host filesystem paths, and device identity
 * must be issued by the server rather than accepted from client payloads.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { createRuntime } from '../../src/runtime.js';
import { createServer } from '../../src/server.js';
import { approveUpload } from '../helpers/consent.js';
import { setupWebSocket } from '../../src/websocket/index.js';

describe('UT-015: no internal paths and no client-asserted identity', () => {
  let app, server, base, wss, root, hostToken, runtime;
  const sockets = [];

  before(async () => {
    // Canonical root: on Windows the temp directory can be reached through an 8.3
    // short name, and the assertions below must not silently weaken.
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-no-leak-')));
    runtime = createRuntime({
      tempDir: path.join(root, 'temp'),
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
    runtime.shareManager.clear();
    await runtime.pendingUploadManager.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  function assertNoHostPath(payload, label) {
    const text = JSON.stringify(payload);
    assert.equal(text.includes(root), false, `${label} leaks the temp/upload root`);
    assert.equal(
      text.includes(root.replace(/\\/g, '/')),
      false,
      `${label} leaks the temp/upload root with forward slashes`
    );
    assert.equal(text.includes(runtime.config.uploadDir), false, `${label} leaks the upload dir`);
    assert.equal(text.includes(runtime.config.tempDir), false, `${label} leaks the temp dir`);
    assert.equal(
      /"(path|filePath|tempPath)"\s*:/.test(text),
      false,
      `${label} exposes an internal path field`
    );
  }

  it('omits internal paths from upload, complete and decision responses', async () => {
    const payload = 'simple-upload-body';
    const grantHeader = await approveUpload(base, {
      name: 'leak-check.txt',
      data: payload,
      hostToken,
    });

    const form = new FormData();
    form.append('files', new Blob([payload]), 'leak-check.txt');
    const upload = await fetch(`${base}/api/upload`, {
      method: 'POST',
      body: form,
      headers: { 'X-Transfer-Grant': grantHeader },
    });
    assert.equal(upload.status, 201);
    const uploadBody = await upload.json();
    assertNoHostPath(uploadBody, 'POST /api/upload');
    assert.equal(uploadBody.data.uploaded[0].path, undefined);

    // Consent precedes the transfer, so this file is already saved, not queued.
    const savedPath = path.join(runtime.config.uploadDir, uploadBody.data.uploaded[0].savedAs);
    assert.equal(await fs.readFile(savedPath, 'utf8'), payload);

    // The host's own upload still uses pending + decision; that path must not leak either.
    const hostForm = new FormData();
    hostForm.append('files', new Blob(['host-body']), 'host-pending.txt');
    const hostUpload = await fetch(`${base}/api/upload`, {
      method: 'POST',
      body: hostForm,
      headers: { 'X-Host-Token': hostToken },
    });
    assert.equal(hostUpload.status, 201);
    const hostBody = await hostUpload.json();
    assertNoHostPath(hostBody, 'host POST /api/upload');
    assertNoHostPath(hostBody.data.pending[0], 'pending record');
    const transferId = hostBody.data.pending[0].transferId;
    assert.ok(transferId);

    const decision = await fetch(`${base}/api/upload/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Host-Token': hostToken },
      body: JSON.stringify({ transferId, action: 'accept' }),
    });
    assert.equal(decision.status, 200);
    const decisionBody = await decision.json();
    assertNoHostPath(decisionBody, 'POST /api/upload/decision');
    assert.equal(decisionBody.data.fileName, 'host-pending.txt');
  });

  it('omits internal paths from the chunked upload flow', async () => {
    const checksum = crypto.createHash('sha256').update('12345678').digest('hex');
    const grantHeader = await approveUpload(base, {
      name: 'chunked-leak.bin',
      data: '12345678',
      checksum,
      hostToken,
    });

    const init = await fetch(`${base}/api/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Transfer-Grant': grantHeader },
      body: JSON.stringify({ fileName: 'chunked-leak.bin', fileSize: 8, checksum }),
    });
    const { uploadId } = (await init.json()).data;

    const chunk = new FormData();
    chunk.append('uploadId', uploadId);
    chunk.append('chunkIndex', '0');
    chunk.append('chunk', new Blob(['12345678']), 'chunk_0');
    const chunkRes = await fetch(`${base}/api/upload/chunk`, { method: 'POST', body: chunk });
    assert.equal(chunkRes.status, 200);
    assertNoHostPath(await chunkRes.json(), 'POST /api/upload/chunk');

    const complete = await fetch(`${base}/api/upload/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    assert.equal(complete.status, 200);
    assertNoHostPath(await complete.json(), 'POST /api/upload/complete');

    const status = await fetch(`${base}/api/upload/status/${uploadId}`);
    if (status.status === 200) {
      assertNoHostPath(await status.json(), 'GET /api/upload/status');
    }
  });

  it('issues server-side device identity instead of trusting claimed ids', async () => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws');
    sockets.push(ws);
    await once(ws, 'open');

    const registered = once(ws, 'message');
    ws.send(
      JSON.stringify({
        event: 'client:register',
        data: {
          deviceId: 'host', // claim to be the host device id
          deviceName: 'Definitely The Host',
          platform: 'windows',
          isHost: true,
        },
      })
    );
    const registration = JSON.parse((await registered)[0].toString()).data;

    assert.notEqual(registration.device.id, 'host');
    assert.match(registration.device.id, /^[0-9a-f-]{36}$/);
    assert.equal(registration.device.label, 'Definitely The Host');
    assert.equal(registration.device.labelUntrusted, true);
    assert.equal(registration.device.isHost, false);
    assert.equal(registration.deviceId, undefined, 'claimed deviceId is not echoed as identity');
  });
});
