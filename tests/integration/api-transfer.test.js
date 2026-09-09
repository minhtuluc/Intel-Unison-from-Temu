import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from '../../src/server.js';
import { shareManager } from '../../src/services/share-manager.js';
import { config } from '../../src/config.js';

describe('Integration: API Transfer (Download & Upload)', () => {
  let server;
  let baseUrl;
  const testDir = path.resolve('temp/test_api_transfer');
  const downloadSourceFile = path.join(testDir, 'source_file.dat');
  let testFileHash = '';
  const fileContent = '0123456789ABCDEFGHIJabcdefghij!@#$%^&*()'; // 40 bytes

  before(async () => {
    await fs.promises.mkdir(testDir, { recursive: true });
    await fs.promises.mkdir(config.uploadDir, { recursive: true });
    await fs.promises.writeFile(downloadSourceFile, fileContent);

    testFileHash = crypto.createHash('sha256').update(fileContent).digest('hex');

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

  describe('GET /api/download/:fileId', () => {
    it('should stream download full file with correct headers and intact checksum', async () => {
      const meta = await shareManager.addFile(downloadSourceFile);

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
      const meta = await shareManager.addFile(downloadSourceFile);

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

    it('should return 416 for invalid range values', async () => {
      const meta = await shareManager.addFile(downloadSourceFile);

      const res = await fetch(`${baseUrl}/api/download/${meta.id}`, {
        headers: { Range: 'bytes=500-600' },
      });

      assert.equal(res.status, 416);
    });
  });

  describe('POST /api/upload (Simple Upload)', () => {
    it('should receive file and write directly to uploadDir', async () => {
      const formData = new FormData();
      const uploadText = 'Quick mobile photo upload payload';
      formData.append('files', new Blob([uploadText], { type: 'text/plain' }), 'mobile_upload.txt');

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        body: formData,
      });

      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.ok(body.data.uploaded[0].name.startsWith('mobile_upload'));

      const savedPath = body.data.uploaded[0].path;
      assert.ok(fs.existsSync(savedPath));
      const content = await fs.promises.readFile(savedPath, 'utf8');
      assert.equal(content, uploadText);
    });
  });

  describe('POST /api/upload/init -> chunk -> complete (Chunked Upload Protocol)', () => {
    it('should complete full chunked upload cycle and merge on disk', async () => {
      const originalChunkSize = config.chunkSize;
      config.chunkSize = 20; // 20 bytes per chunk so 38 bytes creates 2 chunks

      try {
        const testChunk1 = Buffer.from('Part1_Payload_Data_'); // 19 bytes
        const testChunk2 = Buffer.from('Part2_Payload_Data!'); // 19 bytes
        const totalSize = testChunk1.length + testChunk2.length;

        // 1. Init
        const initRes = await fetch(`${baseUrl}/api/upload/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'video_transfer.mp4',
            fileSize: totalSize,
            mimeType: 'video/mp4',
          }),
        });

        assert.equal(initRes.status, 200);
        const initBody = await initRes.json();
        const uploadId = initBody.data.uploadId;
        assert.ok(uploadId);
        assert.equal(initBody.data.totalChunks, 2);

        // 2. Upload Chunk 0
        const formChunk0 = new FormData();
        formChunk0.append('uploadId', uploadId);
        formChunk0.append('chunkIndex', '0');
        formChunk0.append('chunk', new Blob([testChunk1]), 'chunk_0');

        const chunk0Res = await fetch(`${baseUrl}/api/upload/chunk`, {
          method: 'POST',
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
          body: formChunk1,
        });
        assert.equal(chunk1Res.status, 200);

        // 4. Status Check
        const statusRes = await fetch(`${baseUrl}/api/upload/status/${uploadId}`);
        assert.equal(statusRes.status, 200);
        const statusBody = await statusRes.json();
        assert.equal(statusBody.data.receivedChunks.length, 2);

        // 5. Complete
        const completeRes = await fetch(`${baseUrl}/api/upload/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId }),
        });

        assert.equal(completeRes.status, 200);
        const completeBody = await completeRes.json();
        assert.equal(completeBody.success, true);
        assert.ok(fs.existsSync(completeBody.data.filePath));

        const mergedContent = await fs.promises.readFile(completeBody.data.filePath);
        const expectedContent = Buffer.concat([testChunk1, testChunk2]);
        assert.deepEqual(mergedContent, expectedContent);
      } finally {
        config.chunkSize = originalChunkSize;
      }
    });
  });
});
