import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../src/runtime.js';
import { createServer } from '../../src/server.js';
import { validatePath } from '../../src/middleware/security.js';
import { approveUpload, offerBatch } from '../helpers/consent.js';

describe('Security: Penetration Test Cases (SEC-01 to SEC-07)', () => {
  let server;
  let baseUrl;
  let app;
  let runtime;
  let root;

  before(async () => {
    // Sandboxed runtime: this suite must not write into the repo or the host's
    // real Downloads directory.
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-security-test-'));
    runtime = createRuntime({
      tempDir: path.join(root, 'temp'),
      uploadDir: path.join(root, 'received'),
    });
    app = createServer(runtime);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    runtime.shareManager.clear();
    await runtime.pendingUploadManager.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('SEC-01: should block path traversal on download (/api/download/../../etc/passwd)', async () => {
    const res = await fetch(`${baseUrl}/api/download/${encodeURIComponent('../../../etc/passwd')}`);
    assert.ok([400, 403, 404].includes(res.status), `Expected 400/403/404 but got ${res.status}`);
  });

  it('SEC-02: should block Windows path traversal (..\\..\\Windows\\win.ini)', async () => {
    const res = await fetch(
      `${baseUrl}/api/download/${encodeURIComponent('..\\..\\Windows\\win.ini')}`
    );
    assert.ok([400, 403, 404].includes(res.status), `Expected 400/403/404 but got ${res.status}`);
  });

  it('SEC-03: should reject POST /api/share with null bytes and require host authority', async () => {
    const clientRes = await fetch(`${baseUrl}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['test\0malicious.txt'] }),
    });
    assert.equal(clientRes.status, 403);

    const res = await fetch(`${baseUrl}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Host-Token': app.locals.hostAuth.token,
      },
      body: JSON.stringify({ paths: ['test\0malicious.txt'] }),
    });

    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, 'ACCESS_DENIED');
  });

  it('SEC-04: should sanitize malicious uploaded filename (../../evil.js)', async () => {
    const payload = 'console.log("evil")';
    const grantHeader = await approveUpload(baseUrl, {
      name: '../../../evil.js',
      data: payload,
      hostToken: app.locals.hostAuth.token,
    });

    const formData = new FormData();
    formData.append('files', new Blob([payload]), '../../../evil.js');

    const res = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      body: formData,
      headers: { 'X-Transfer-Grant': grantHeader },
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    const uploadedName = body.data.uploaded[0].name;

    assert.equal(uploadedName.includes('..'), false);
    assert.equal(uploadedName.includes('/'), false);
    assert.equal(uploadedName.includes('\\'), false);
  });

  it('SEC-05: should reject oversized upload in /api/upload/init with 413 Payload Too Large', async () => {
    // Size policy stays enforced at init, so the offer only has to be consented to.
    const oversized = 100 * 1024 * 1024 * 1024; // 100GB > 10GB max
    const { grantHeader } = await offerBatch(baseUrl, {
      files: [{ name: 'overflow.bin', size: oversized }],
      hostToken: app.locals.hostAuth.token,
    });

    const res = await fetch(`${baseUrl}/api/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Transfer-Grant': grantHeader },
      body: JSON.stringify({
        fileName: 'overflow.bin',
        fileSize: oversized,
      }),
    });

    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error.code, 'FILE_TOO_LARGE');
  });

  it('SEC-06: validatePath middleware blocks path traversal and null bytes', () => {
    const allowed = [runtime.config.tempDir];

    assert.throws(() => validatePath('../../../etc/passwd', allowed), { code: 'ACCESS_DENIED' });

    assert.throws(() => validatePath('C:\\Windows\\System32\\calc.exe', allowed), {
      code: 'ACCESS_DENIED',
    });

    assert.throws(() => validatePath('file\0test.txt', allowed), { code: 'ACCESS_DENIED' });

    const validTempFile = path.join(runtime.config.tempDir, 'valid.txt');
    assert.equal(validatePath(validTempFile, allowed), validTempFile);
  });
});
