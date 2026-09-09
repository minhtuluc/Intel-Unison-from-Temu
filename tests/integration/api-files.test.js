import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../../src/server.js';
import { shareManager } from '../../src/services/share-manager.js';

describe('Integration: API Files & Sharing', () => {
  let server;
  let baseUrl;
  const testDir = path.resolve('temp/test_api_files');
  const file1 = path.join(testDir, 'document.pdf');
  const file2 = path.join(testDir, 'photo.png');

  before(async () => {
    await fs.promises.mkdir(testDir, { recursive: true });
    await fs.promises.writeFile(file1, 'PDF dummy content');
    await fs.promises.writeFile(file2, 'PNG dummy content');

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
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    shareManager.clear();
  });

  it('GET /api/shared should return empty list initially', async () => {
    const res = await fetch(`${baseUrl}/api/shared`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.data.files, []);
    assert.equal(body.data.fileCount, 0);
  });

  it('POST /api/share (Local JSON mode) should stage files from disk', async () => {
    const res = await fetch(`${baseUrl}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [file1, file2] }),
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.shared.length, 2);

    // Verify GET /api/shared now contains these files
    const listRes = await fetch(`${baseUrl}/api/shared`);
    const listBody = await listRes.json();
    assert.equal(listBody.data.fileCount, 2);
  });

  it('POST /api/share (Browser multipart mode) should stage uploaded files', async () => {
    const formData = new FormData();
    const blob = new Blob(['Browser dropped file content'], { type: 'text/plain' });
    formData.append('files', blob, 'dropped_note.txt');

    const res = await fetch(`${baseUrl}/api/share`, {
      method: 'POST',
      body: formData,
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.shared[0].name, 'dropped_note.txt');

    // Staged files count should be 1
    const listRes = await fetch(`${baseUrl}/api/shared`);
    const listBody = await listRes.json();
    assert.equal(listBody.data.fileCount, 1);
  });

  it('DELETE /api/share/:fileId should unstage a file', async () => {
    const meta = await shareManager.addFile(file1);

    const deleteRes = await fetch(`${baseUrl}/api/share/${meta.id}`, {
      method: 'DELETE',
    });
    assert.equal(deleteRes.status, 200);
    const deleteBody = await deleteRes.json();
    assert.equal(deleteBody.data.removed, meta.id);

    // Should return 404 on deleting again
    const deleteAgain = await fetch(`${baseUrl}/api/share/${meta.id}`, {
      method: 'DELETE',
    });
    assert.equal(deleteAgain.status, 404);
  });
});
