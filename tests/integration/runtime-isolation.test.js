/**
 * UT-005 — one runtime per app: config, managers and routes come from an injected
 * runtime instead of process-wide singletons, and reported state matches the listener.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../src/runtime.js';
import { createServer } from '../../src/server.js';
import { approveUpload } from '../helpers/consent.js';

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

describe('UT-005: runtime isolation', () => {
  let root, runtimeA, runtimeB, appA, appB, serverA, serverB, baseA, baseB;
  const originalCwd = process.cwd();

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-runtime-'));

    runtimeA = createRuntime({
      tempDir: path.join(root, 'a', 'temp'),
      uploadDir: path.join(root, 'a', 'received'),
      port: 0,
    });
    runtimeB = createRuntime({
      tempDir: path.join(root, 'b', 'temp'),
      uploadDir: path.join(root, 'b', 'received'),
      port: 0,
    });

    appA = createServer(runtimeA);
    appB = createServer(runtimeB);
    serverA = await listen(appA);
    serverB = await listen(appB);

    runtimeA.setListenPort(serverA.address().port);
    runtimeB.setListenPort(serverB.address().port);

    baseA = `http://127.0.0.1:${serverA.address().port}`;
    baseB = `http://127.0.0.1:${serverB.address().port}`;
  });

  after(async () => {
    process.chdir(originalCwd);
    await new Promise((resolve) => serverA.close(resolve));
    await new Promise((resolve) => serverB.close(resolve));
    await runtimeA.pendingUploadManager.cleanup();
    await runtimeB.pendingUploadManager.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps staging, temp and upload state separate per runtime', async () => {
    const fixture = path.join(root, 'shared.txt');
    await fs.writeFile(fixture, 'runtime-a-payload');

    const staged = await fetch(`${baseA}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Host-Token': runtimeA.hostAuth.token },
      body: JSON.stringify({ paths: [fixture] }),
    });
    assert.equal(staged.status, 201);
    assert.equal(runtimeA.shareManager.listFiles().fileCount, 1);
    assert.equal(runtimeB.shareManager.listFiles().fileCount, 0);

    const listedInB = await (await fetch(`${baseB}/api/shared`)).json();
    assert.equal(listedInB.data.fileCount, 0);

    const inA = await (await fetch(`${baseA}/api/shared`)).json();
    const fileId = inA.data.files[0].id;
    const download = await fetch(`${baseA}/api/download/${fileId}`);
    assert.equal(await download.text(), 'runtime-a-payload');

    // An upload received by A must land in A's upload dir only.
    const grantHeader = await approveUpload(baseA, {
      name: 'for-a.txt',
      data: 'a-receives',
      hostToken: runtimeA.hostAuth.token,
    });
    const form = new FormData();
    form.append('files', new Blob(['a-receives']), 'for-a.txt');
    const uploaded = await fetch(`${baseA}/api/upload`, {
      method: 'POST',
      body: form,
      headers: { 'X-Transfer-Grant': grantHeader },
    });
    assert.equal(uploaded.status, 201);

    const savedInA = await fs.readFile(path.join(runtimeA.config.uploadDir, 'for-a.txt'), 'utf8');
    assert.equal(savedInA, 'a-receives');
    await assert.rejects(fs.stat(path.join(runtimeB.config.uploadDir, 'for-a.txt')));
  });

  it('reports the real listener port and never the configured default', async () => {
    const info = await (await fetch(`${baseA}/api/info`)).json();
    assert.equal(info.data.port, serverA.address().port);
    assert.equal(info.data.connectUrl.includes(`:${serverA.address().port}`), true);

    const runtime = createRuntime({ port: 0 });
    const app = createServer(runtime);
    const server = await listen(app);
    runtime.setListenPort(server.address().port);
    const dynamicBase = `http://127.0.0.1:${server.address().port}`;

    const dynamicInfo = await (await fetch(`${dynamicBase}/api/info`)).json();
    assert.equal(dynamicInfo.data.port, server.address().port);

    await new Promise((resolve) => server.close(resolve));
  });

  it('serves the shell from the package directory regardless of cwd', async () => {
    process.chdir(os.tmpdir());
    const res = await fetch(`${baseA}/index.html`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('UniversalTrans'));

    const appJs = await fetch(`${baseA}/js/app.js`);
    assert.equal(appJs.status, 200);
    process.chdir(originalCwd);
  });

  it('does not import a mutable process-wide config singleton', async () => {
    const configModule = await import('../../src/config.js');
    assert.equal(configModule.config, undefined, 'config.js must not export a singleton');
    assert.equal(typeof configModule.loadConfig, 'function');
    assert.ok(configModule.DEFAULT_CONFIG);
  });
});
