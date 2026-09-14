/**
 * Review follow-up: upload limits must come from the runtime config, and an
 * oversized chunk must be refused at the transport layer (413) instead of being
 * buffered in RAM up to maxFileSize.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../src/runtime.js';
import { createServer } from '../../src/server.js';

describe('Upload limits are per runtime and enforced before buffering', () => {
  let app, server, base, root, runtime;
  const CHUNK_SIZE = 1024;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-limits-'));
    runtime = createRuntime({
      tempDir: path.join(root, 'temp'),
      uploadDir: path.join(root, 'received'),
      chunkSize: CHUNK_SIZE,
      maxFileSize: 64 * 1024,
    });
    app = createServer(runtime);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await runtime.chunkedUploadManager.cleanup();
    await runtime.pendingUploadManager.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects an oversized chunk with 413 and keeps no session data on disk', async () => {
    const init = await fetch(`${base}/api/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'big.bin', fileSize: 2048 }),
    });
    assert.equal(init.status, 200);
    const { uploadId } = (await init.json()).data;

    const oversized = new FormData();
    oversized.append('uploadId', uploadId);
    oversized.append('chunkIndex', '0');
    oversized.append('chunk', new Blob([new Uint8Array(4 * 1024 * 1024)]), 'chunk_0');

    const res = await fetch(`${base}/api/upload/chunk`, { method: 'POST', body: oversized });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, 'CHUNK_TOO_LARGE');

    const sessionDir = path.join(runtime.config.tempDir, 'chunks', uploadId);
    const written = await fs.readdir(sessionDir).catch(() => []);
    assert.deepEqual(written, [], 'no chunk file is written for a rejected body');

    // A chunk within the runtime limit still succeeds.
    const ok = new FormData();
    ok.append('uploadId', uploadId);
    ok.append('chunkIndex', '0');
    ok.append('chunk', new Blob([new Uint8Array(CHUNK_SIZE)]), 'chunk_0');
    const okRes = await fetch(`${base}/api/upload/chunk`, { method: 'POST', body: ok });
    assert.equal(okRes.status, 200);
  });

  it('applies the runtime maxFileSize to client multipart staging', async () => {
    const form = new FormData();
    form.append(
      'files',
      new Blob([new Uint8Array(runtime.config.maxFileSize + 1024)]),
      'too-big.bin'
    );

    const res = await fetch(`${base}/api/share`, { method: 'POST', body: form });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, 'FILE_TOO_LARGE');
    assert.equal(runtime.shareManager.listFiles().fileCount, 0);

    const small = new FormData();
    small.append('files', new Blob(['small enough']), 'small.txt');
    const okRes = await fetch(`${base}/api/share`, { method: 'POST', body: small });
    assert.equal(okRes.status, 201);
    assert.equal(runtime.shareManager.listFiles().fileCount, 1);

    // Same runtime ceiling applies to /api/upload, which has its own 100MB cap.
    const uploadForm = new FormData();
    uploadForm.append('files', new Blob([new Uint8Array(2048)]), 'ok.bin');
    const uploadRes = await fetch(`${base}/api/upload`, { method: 'POST', body: uploadForm });
    assert.equal(uploadRes.status, 201);
  });
});
