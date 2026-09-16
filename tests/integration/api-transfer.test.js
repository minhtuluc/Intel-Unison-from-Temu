import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRuntime } from '../../src/runtime.js';
import { createServer } from '../../src/server.js';
import { approveUpload } from '../helpers/consent.js';

describe('Integration: API Transfer (Download & Upload)', () => {
  let server;
  let baseUrl;
  let runtime;
  let root;
  let testDir;
  let downloadSourceFile;
  let testFileHash = '';
  const fileContent = '0123456789ABCDEFGHIJabcdefghij!@#$%^&*()'; // 40 bytes

  before(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-transfer-'));
    testDir = path.join(root, 'fixtures');
    downloadSourceFile = path.join(testDir, 'source_file.dat');
    await fs.promises.mkdir(testDir, { recursive: true });

    runtime = createRuntime({
      tempDir: path.join(root, 'temp'),
      uploadDir: path.join(root, 'received'),
    });
    await fs.promises.mkdir(runtime.config.uploadDir, { recursive: true });
    await fs.promises.writeFile(downloadSourceFile, fileContent);

    testFileHash = crypto.createHash('sha256').update(fileContent).digest('hex');

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
    runtime.shareManager.clear();
    await runtime.pendingUploadManager.cleanup();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  describe('GET /api/download/:fileId', () => {
    it('should stream download full file with correct headers and intact checksum', async () => {
      const meta = await runtime.shareManager.addFile(downloadSourceFile);

      const res = await fetch(`${baseUrl}/api/download/${meta.id}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
      assert.equal(res.headers.get('content-length'), String(fileContent.length));

      const downloadedText = await res.text();
      assert.equal(downloadedText, fileContent);

      const downloadedHash = crypto.createHash('sha256').update(downloadedText).digest('hex');
      assert.equal(downloadedHash, testFileHash);
    });

    it('should support Range header for resume & seek (206 Partial Content)', async () => {
      const meta = await runtime.shareManager.addFile(downloadSourceFile);

      // Request bytes 10-19 (10 bytes: 'ABCDEFGHIJ')
      const res = await fetch(`${baseUrl}/api/download/${meta.id}`, {
        headers: { Range: 'bytes=10-19' },
      });

      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), `bytes 10-19/${fileContent.length}`);
      assert.equal(res.headers.get('content-length'), '10');

      const chunkText = await res.text();
      assert.equal(chunkText, 'ABCDEFGHIJ');
    });

    it('should support suffix Range header bytes=-10', async () => {
      const meta = await runtime.shareManager.addFile(downloadSourceFile);

      // Last 10 bytes of 40-byte file: index 30 to 39
      const res = await fetch(`${baseUrl}/api/download/${meta.id}`, {
        headers: { Range: 'bytes=-10' },
      });

      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), `bytes 30-39/${fileContent.length}`);
      assert.equal(res.headers.get('content-length'), '10');
      const text = await res.text();
      assert.equal(text, '!@#$%^&*()');
    });

    it('should support open-ended Range header bytes=30-', async () => {
      const meta = await runtime.shareManager.addFile(downloadSourceFile);

      const res = await fetch(`${baseUrl}/api/download/${meta.id}`, {
        headers: { Range: 'bytes=30-' },
      });

      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), `bytes 30-39/${fileContent.length}`);
      assert.equal(res.headers.get('content-length'), '10');
      const text = await res.text();
      assert.equal(text, '!@#$%^&*()');
    });

    it('should clamp end to EOF when requested end >= fileSize', async () => {
      const meta = await runtime.shareManager.addFile(downloadSourceFile);

      const res = await fetch(`${baseUrl}/api/download/${meta.id}`, {
        headers: { Range: 'bytes=30-1000' },
      });

      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), `bytes 30-39/${fileContent.length}`);
      assert.equal(res.headers.get('content-length'), '10');
      const text = await res.text();
      assert.equal(text, '!@#$%^&*()');
    });

    it('should return 416 for invalid range values or inverted ranges', async () => {
      const meta = await runtime.shareManager.addFile(downloadSourceFile);

      const res1 = await fetch(`${baseUrl}/api/download/${meta.id}`, {
        headers: { Range: 'bytes=500-600' },
      });
      assert.equal(res1.status, 416);
      assert.equal(res1.headers.get('content-range'), `bytes */${fileContent.length}`);

      const res2 = await fetch(`${baseUrl}/api/download/${meta.id}`, {
        headers: { Range: 'bytes=30-10' },
      });
      assert.equal(res2.status, 416);
    });

    it('should fallback to 200 full content for malformed or non-bytes range', async () => {
      const meta = await runtime.shareManager.addFile(downloadSourceFile);

      const res = await fetch(`${baseUrl}/api/download/${meta.id}`, {
        headers: { Range: 'characters=0-10' },
      });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), fileContent);
    });
  });

  describe('POST /api/upload (Simple Upload)', () => {
    it('should receive file and write directly to uploadDir', async () => {
      const uploadText = 'Quick mobile photo upload payload';
      const grantHeader = await approveUpload(baseUrl, {
        name: 'mobile_upload.txt',
        data: uploadText,
        mimeType: 'text/plain',
        hostToken: runtime.hostAuth.token,
      });

      const formData = new FormData();
      formData.append('files', new Blob([uploadText], { type: 'text/plain' }), 'mobile_upload.txt');

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        body: formData,
        headers: { 'X-Transfer-Grant': grantHeader },
      });

      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.ok(body.data.uploaded[0].name.startsWith('mobile_upload'));

      // UT-015: responses never disclose host paths.
      assert.equal(body.data.uploaded[0].path, undefined);

      // Consent happened at offer time, so this file is saved rather than queued.
      assert.equal(body.data.pending.length, 0);
      const saved = await fs.promises.readFile(
        path.join(runtime.config.uploadDir, body.data.uploaded[0].savedAs),
        'utf8'
      );
      assert.equal(saved, uploadText);
    });
  });

  describe('POST /api/upload/init -> chunk -> complete (Chunked Upload Protocol)', () => {
    it('should complete full chunked upload cycle and merge on disk', async () => {
      const originalChunkSize = runtime.config.chunkSize;
      runtime.config.chunkSize = 20; // 20 bytes per chunk so 38 bytes creates 2 chunks

      try {
        const testChunk1 = Buffer.from('Part1_Payload_Data__'); // 20 bytes (chunk 0)
        const testChunk2 = Buffer.from('Part2_Payload_Data'); // 18 bytes (chunk 1 - terminal)
        const totalSize = testChunk1.length + testChunk2.length;
        const totalChecksum = crypto
          .createHash('sha256')
          .update(Buffer.concat([testChunk1, testChunk2]))
          .digest('hex');

        // 1. Init — the host consents to the declared name/size before any chunk moves.
        const grantHeader = await approveUpload(baseUrl, {
          name: 'video_transfer.mp4',
          data: Buffer.concat([testChunk1, testChunk2]),
          mimeType: 'video/mp4',
          checksum: totalChecksum,
          hostToken: runtime.hostAuth.token,
        });

        const initRes = await fetch(`${baseUrl}/api/upload/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Transfer-Grant': grantHeader },
          body: JSON.stringify({
            fileName: 'video_transfer.mp4',
            fileSize: totalSize,
            mimeType: 'video/mp4',
            checksum: totalChecksum,
          }),
        });

        assert.equal(initRes.status, 200);
        const initBody = await initRes.json();
        const uploadId = initBody.data.uploadId;
        const uploadToken = initBody.data.uploadToken;
        assert.ok(uploadId);
        assert.equal(initBody.data.totalChunks, 2);

        // 2. Upload Chunk 0
        const formChunk0 = new FormData();
        formChunk0.append('uploadId', uploadId);
        formChunk0.append('chunkIndex', '0');
        formChunk0.append('chunk', new Blob([testChunk1]), 'chunk_0');

        const chunk0Res = await fetch(`${baseUrl}/api/upload/chunk`, {
          method: 'POST',
          headers: { 'X-Upload-Id': uploadId, 'X-Upload-Token': uploadToken },
          body: formChunk0,
        });
        assert.equal(chunk0Res.status, 200);

        // 3. Upload Chunk 1
        const formChunk1 = new FormData();
        formChunk1.append('uploadId', uploadId);
        formChunk1.append('chunkIndex', '1');
        formChunk1.append('chunk', new Blob([testChunk2]), 'chunk_1');

        const chunk1Res = await fetch(`${baseUrl}/api/upload/chunk`, {
          method: 'POST',
          headers: { 'X-Upload-Id': uploadId, 'X-Upload-Token': uploadToken },
          body: formChunk1,
        });
        assert.equal(chunk1Res.status, 200);

        // 4. Status Check
        const statusRes = await fetch(`${baseUrl}/api/upload/status/${uploadId}`, {
          headers: { 'X-Upload-Token': uploadToken },
        });
        assert.equal(statusRes.status, 200);
        const statusBody = await statusRes.json();
        assert.equal(statusBody.data.receivedChunks.length, 2);

        // 5. Complete
        const completeRes = await fetch(`${baseUrl}/api/upload/complete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Upload-Token': uploadToken,
          },
          body: JSON.stringify({ uploadId }),
        });

        assert.equal(completeRes.status, 200);
        const completeBody = await completeRes.json();
        assert.equal(completeBody.success, true);
        // UT-015: the merged file path stays server-side.
        assert.equal(completeBody.data.filePath, undefined);

        // Consent was given up front, so completion saves to the receive dir.
        const mergedPath = path.join(runtime.config.uploadDir, completeBody.data.savedAs);
        assert.ok(fs.existsSync(mergedPath), `merged file exists at ${mergedPath}`);

        const mergedContent = await fs.promises.readFile(mergedPath);
        const expectedContent = Buffer.concat([testChunk1, testChunk2]);
        assert.deepEqual(mergedContent, expectedContent);
      } finally {
        runtime.config.chunkSize = originalChunkSize;
      }
    });
  });
});
