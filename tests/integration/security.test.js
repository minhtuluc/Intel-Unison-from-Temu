import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from '../../src/server.js';
import { validatePath } from '../../src/middleware/security.js';

describe('Security: Penetration Test Cases (SEC-01 to SEC-07)', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = createServer();
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

  it('SEC-03: should reject POST /api/share with null bytes', async () => {
    const res = await fetch(`${baseUrl}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['test\0malicious.txt'] }),
    });

    const body = await res.json();
    assert.equal(body.data.shared.length, 0);
  });

  it('SEC-04: should sanitize malicious uploaded filename (../../evil.js)', async () => {
    const formData = new FormData();
    formData.append('files', new Blob(['console.log("evil")']), '../../../evil.js');

    const res = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      body: formData,
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    const uploadedName = body.data.uploaded[0].name;

    assert.equal(uploadedName.includes('..'), false);
    assert.equal(uploadedName.includes('/'), false);
    assert.equal(uploadedName.includes('\\'), false);
  });

  it('SEC-05: should reject oversized upload in /api/upload/init with 413 Payload Too Large', async () => {
    const res = await fetch(`${baseUrl}/api/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'overflow.bin',
        fileSize: 100 * 1024 * 1024 * 1024, // 100GB > 10GB max
      }),
    });

    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error.code, 'FILE_TOO_LARGE');
  });

  it('SEC-06: validatePath middleware blocks path traversal and null bytes', () => {
    const allowed = [path.resolve('temp')];

    assert.throws(() => validatePath('../../../etc/passwd', allowed), { code: 'ACCESS_DENIED' });

    assert.throws(() => validatePath('C:\\Windows\\System32\\calc.exe', allowed), {
      code: 'ACCESS_DENIED',
    });

    assert.throws(() => validatePath('file\0test.txt', allowed), { code: 'ACCESS_DENIED' });

    const validTempFile = path.join(path.resolve('temp'), 'valid.txt');
    assert.equal(validatePath(validTempFile, allowed), validTempFile);
  });
});
