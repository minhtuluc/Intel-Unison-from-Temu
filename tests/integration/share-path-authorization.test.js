/**
 * UT-003 — staging a host filesystem path is a host-only action.
 * The JSON branch of POST /api/share must be rejected for clients before any
 * disk access; the multipart branch stays available to clients (browser upload).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../src/runtime.js';
import { createServer } from '../../src/server.js';

describe('UT-003: source path staging requires host authority', () => {
  let app, server, base, root, hostToken, runtime;
  let allowedDir, outsideDir, outsideFile, insideFile, symlinkPath, originalAllowedSourceDirs;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-share-auth-'));
    allowedDir = path.join(root, 'allowed');
    outsideDir = path.join(root, 'outside');
    await fs.mkdir(allowedDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    outsideFile = path.join(outsideDir, 'secret.txt');
    insideFile = path.join(allowedDir, 'shareable.txt');
    await fs.writeFile(outsideFile, 'outside-allowlist');
    await fs.writeFile(insideFile, 'inside-allowlist');
    symlinkPath = path.join(allowedDir, 'link-to-secret.txt');
    try {
      await fs.symlink(outsideFile, symlinkPath);
    } catch {
      // On Windows without Developer Mode, file symlinks require elevation (EPERM).
      // Fall back to a directory junction, which Windows permits for unprivileged users.
      try {
        const linkDir = path.join(allowedDir, 'link-to-outside');
        await fs.symlink(outsideDir, linkDir, 'junction');
        symlinkPath = path.join(linkDir, 'secret.txt');
      } catch {
        symlinkPath = null;
      }
    }

    runtime = createRuntime({
      tempDir: path.join(root, 'temp'),
      uploadDir: path.join(root, 'received'),
    });
    originalAllowedSourceDirs = runtime.config.allowedSourceDirs;
    app = createServer(runtime);
    hostToken = app.locals.hostAuth.token;
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (runtime) {
      runtime.shareManager.clear();
      await runtime.pendingUploadManager.cleanup();
    }
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function shareJson(paths, headers = {}) {
    runtime.shareManager.clear();
    return fetch(`${base}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ paths }),
    });
  }

  async function stagedCount() {
    const listed = await (await fetch(`${base}/api/shared`)).json();
    return listed.data.fileCount;
  }

  it('rejects a client with no host token and stages nothing', async () => {
    const res = await shareJson([outsideFile]);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'HOST_REQUIRED');
    assert.equal(await stagedCount(), 0);
  });

  it('rejects forged authority claims (isHost, device name, X-Forwarded-For, wrong token)', async () => {
    const forged = await shareJson([outsideFile], {
      'X-Host-Token': 'wrong',
      'X-Forwarded-For': '127.0.0.1',
      'X-Device-Name': 'DESKTOP-HOST',
      isHost: 'true',
    });
    assert.equal(forged.status, 403);
    assert.equal(await stagedCount(), 0);
  });

  it('rejects null bytes even from the host, and blocks traversal for clients', async () => {
    const nullByte = await shareJson(['bad\0.txt'], { 'X-Host-Token': hostToken });
    assert.equal(nullByte.status, 403);
    assert.equal((await nullByte.json()).error.code, 'ACCESS_DENIED');

    // A client cannot reach the source-path branch at all, with or without traversal.
    const traversal = await shareJson(['../../../../etc/passwd']);
    assert.equal(traversal.status, 403);
    assert.equal(await stagedCount(), 0);
  });

  it('lets the authenticated host stage a path when no allowlist is configured', async () => {
    const res = await shareJson([outsideFile], { 'X-Host-Token': hostToken });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.shared.length, 1);
    assert.equal(body.data.shared[0].name, 'secret.txt');
    assert.equal(await stagedCount(), 1);
    runtime.shareManager.clear();
  });

  it('enforces the allowlist for every source path when one is configured', async () => {
    runtime.config.allowedSourceDirs = [allowedDir];
    const outside = await shareJson([outsideFile], { 'X-Host-Token': hostToken });
    assert.equal(outside.status, 403);
    assert.equal((await outside.json()).error.code, 'ACCESS_DENIED');

    const traversal = await shareJson([path.join(allowedDir, '..', 'outside', 'secret.txt')], {
      'X-Host-Token': hostToken,
    });
    assert.equal(traversal.status, 403);

    const viaSymlink = await shareJson([symlinkPath], { 'X-Host-Token': hostToken });
    assert.equal(viaSymlink.status, 403);

    const inside = await shareJson([insideFile], { 'X-Host-Token': hostToken });
    assert.equal(inside.status, 201);
    assert.equal(await stagedCount(), 1);
    runtime.shareManager.clear();
    runtime.config.allowedSourceDirs = originalAllowedSourceDirs;
  });

  it('does not let another content type smuggle source paths past the host gate', async () => {
    // A client with a valid PIN session (no host token) must not be able to reach
    // the source-path branch through a body format other than JSON.
    const pinRuntime = runtime.config.pin;
    runtime.config.pin = '4321';
    const auth = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '4321' }),
    });
    assert.equal(auth.status, 200);
    const { token } = (await auth.json()).data;
    const session = { 'X-Session-Token': token };

    const asUrlEncoded = await fetch(`${base}/api/share`, {
      method: 'POST',
      headers: { ...session, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'paths[]=' + encodeURIComponent(outsideFile),
    });
    assert.equal(asUrlEncoded.status, 403, 'urlencoded body must not stage host paths');

    const asText = await fetch(`${base}/api/share`, {
      method: 'POST',
      headers: { ...session, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ paths: [outsideFile] }),
    });
    assert.ok([403, 415].includes(asText.status), `text/plain -> ${asText.status}`);

    const asJson = await fetch(`${base}/api/share`, {
      method: 'POST',
      headers: { ...session, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [outsideFile] }),
    });
    assert.equal(asJson.status, 403, 'JSON body from a client must still be host-only');

    assert.equal(await stagedCount(), 0);
    runtime.config.pin = pinRuntime;
  });

  it('keeps the multipart branch available to clients without host authority', async () => {
    const form = new FormData();
    form.append('files', new Blob(['client-upload']), 'from-client.txt');
    const res = await fetch(`${base}/api/share`, { method: 'POST', body: form });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.shared[0].name, 'from-client.txt');
    runtime.shareManager.clear();
  });
});
