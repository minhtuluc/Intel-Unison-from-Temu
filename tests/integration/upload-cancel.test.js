import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../src/runtime.js';
import { createServer } from '../../src/server.js';

describe('Integration: POST /api/upload/cancel (Server-side Cancel & Cleanup)', () => {
  let server;
  let baseUrl;
  let runtime;
  let root;

  before(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-cancel-'));
    runtime = createRuntime({
      tempDir: path.join(root, 'temp'),
      uploadDir: path.join(root, 'received'),
      chunkSize: 1024,
      maxFileSize: 10 * 1024 * 1024,
    });

    const app = createServer(runtime);
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
    await runtime.stop();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('cancels active chunked upload and cleans up chunk files immediately', async () => {
    // 1. Init upload
    const initRes = await fetch(`${baseUrl}/api/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'cancelling_movie.mp4',
        fileSize: 2048,
        mimeType: 'video/mp4',
      }),
    });
    assert.equal(initRes.status, 200);
    const { uploadId } = (await initRes.json()).data;

    // 2. Upload chunk 0
    const form = new FormData();
    form.append('uploadId', uploadId);
    form.append('chunkIndex', '0');
    form.append('chunk', new Blob([Buffer.alloc(1024)]), 'chunk_0');

    const chunkRes = await fetch(`${baseUrl}/api/upload/chunk`, {
      method: 'POST',
      body: form,
    });
    assert.equal(chunkRes.status, 200);

    const sessionDir = path.join(runtime.config.tempDir, 'chunks', uploadId);
    assert.ok(fs.existsSync(sessionDir), 'Session directory must exist before cancellation');

    // 3. Cancel upload
    const cancelRes = await fetch(`${baseUrl}/api/upload/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    assert.equal(cancelRes.status, 200);
    const cancelBody = await cancelRes.json();
    assert.equal(cancelBody.success, true);
    assert.equal(cancelBody.data.cancelled, true);

    // 4. Verify session folder on disk is immediately gone!
    assert.equal(
      fs.existsSync(sessionDir),
      false,
      'Session directory must be removed immediately on cancel'
    );

    // 5. Following request for status or chunk returns 410 UPLOAD_EXPIRED
    const statusRes = await fetch(`${baseUrl}/api/upload/status/${uploadId}`);
    assert.equal(statusRes.status, 410);
  });

  it('returns 400 when uploadId is missing in cancel request', async () => {
    const res = await fetch(`${baseUrl}/api/upload/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});
