/**
 * API responses describe live server state (staged files, pending approvals).
 * They must never be served from the browser cache: a 304 after the staging list
 * changed leaves the client showing files that are gone, or missing new ones.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../src/runtime.js';
import { createServer } from '../../src/server.js';

describe('API responses are never cached by the browser', () => {
  let app, server, base, root, hostToken, runtime;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-cache-'));
    runtime = createRuntime({
      tempDir: path.join(root, 'temp'),
      uploadDir: path.join(root, 'received'),
    });
    app = createServer(runtime);
    hostToken = app.locals.hostAuth.token;
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    runtime.shareManager.clear();
    await runtime.pendingUploadManager.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('marks /api responses no-store and refuses to answer 304', async () => {
    const first = await fetch(`${base}/api/shared`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');

    const etag = first.headers.get('etag');
    if (etag) {
      const conditional = await fetch(`${base}/api/shared`, {
        headers: { 'If-None-Match': etag },
      });
      assert.equal(conditional.status, 200, 'conditional request must not return 304');
    }
  });

  it('reports the current staging list after it changes', async () => {
    const before = await (await fetch(`${base}/api/shared`)).json();

    const fixture = path.join(root, 'fresh.txt');
    await fs.writeFile(fixture, 'fresh');
    await fetch(`${base}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Host-Token': hostToken },
      body: JSON.stringify({ paths: [fixture] }),
    });

    const after = await (await fetch(`${base}/api/shared`)).json();
    assert.equal(before.data.fileCount, 0);
    assert.equal(after.data.fileCount, 1);
    assert.equal(after.data.files[0].name, 'fresh.txt');
  });
});
