import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ShareManager } from '../../src/services/share-manager.js';

describe('ShareManager Service', () => {
  let shareManager;
  const testDir = path.resolve('temp/test_share_manager');
  const fileA = path.join(testDir, 'sample_a.txt');
  const fileB = path.join(testDir, 'sample_b.jpg');
  const subDir = path.join(testDir, 'subfolder');
  const fileC = path.join(subDir, 'sample_c.mp4');

  beforeEach(async () => {
    await fs.promises.mkdir(subDir, { recursive: true });
    await fs.promises.writeFile(fileA, 'Content of sample A');
    await fs.promises.writeFile(fileB, 'Fake JPEG image data');
    await fs.promises.writeFile(fileC, 'Fake MP4 video stream data');
    shareManager = new ShareManager();
  });

  afterEach(async () => {
    shareManager.clear();
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  describe('addFile()', () => {
    it('should add a file and return public metadata without exposing full path', async () => {
      const meta = await shareManager.addFile(fileA);

      assert.ok(meta.id.startsWith('f_'));
      assert.equal(meta.name, 'sample_a.txt');
      assert.equal(meta.type, 'document');
      assert.equal(meta.path, undefined, 'Public metadata must not leak server filesystem path');
      assert.ok(meta.size > 0);
    });

    it('should return the existing fileId for duplicate adds (deduplication)', async () => {
      const first = await shareManager.addFile(fileA);
      const second = await shareManager.addFile(fileA);

      assert.equal(first.id, second.id);
      assert.equal(shareManager.listFiles().fileCount, 1);
    });

    it('should reject non-existent file path with 404', async () => {
      await assert.rejects(() => shareManager.addFile(path.join(testDir, 'non_existent.txt')), {
        code: 'FILE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('should reject null bytes in file path with 403', async () => {
      await assert.rejects(() => shareManager.addFile('evil\0path.txt'), {
        code: 'ACCESS_DENIED',
        statusCode: 403,
      });
    });

    it('should reject directories when calling addFile directly', async () => {
      await assert.rejects(() => shareManager.addFile(subDir), {
        code: 'IS_DIRECTORY',
        statusCode: 400,
      });
    });
  });

  describe('addFiles()', () => {
    it('should add multiple individual files', async () => {
      const added = await shareManager.addFiles([fileA, fileB]);

      assert.equal(added.length, 2);
      assert.equal(shareManager.listFiles().fileCount, 2);
    });

    it('should recursively discover and add all files inside a directory', async () => {
      const added = await shareManager.addFiles([testDir]);

      // Should add fileA, fileB, and fileC from subfolder
      assert.equal(added.length, 3);
      assert.equal(shareManager.listFiles().fileCount, 3);

      const names = added.map((f) => f.name);
      assert.ok(names.includes('sample_a.txt'));
      assert.ok(names.includes('sample_b.jpg'));
      assert.ok(names.includes('sample_c.mp4'));
    });
  });

  describe('getFile() & removeFile()', () => {
    it('should retrieve internal file record with full path for download streaming', async () => {
      const meta = await shareManager.addFile(fileB);
      const internal = shareManager.getFile(meta.id);

      assert.ok(internal);
      assert.equal(internal.id, meta.id);
      assert.equal(internal.path, path.resolve(fileB));
    });

    it('should return null when getting non-existent fileId', () => {
      assert.equal(shareManager.getFile('f_non_existent'), null);
    });

    it('should remove file from staging and return true', async () => {
      const meta = await shareManager.addFile(fileA);
      const removed = shareManager.removeFile(meta.id);

      assert.equal(removed, true);
      assert.equal(shareManager.getFile(meta.id), null);
      assert.equal(shareManager.listFiles().fileCount, 0);
    });

    it('should return false when removing non-existent fileId', () => {
      assert.equal(shareManager.removeFile('f_non_existent'), false);
    });
  });

  describe('listFiles() & clear()', () => {
    it('should list all staged files and calculate correct total size', async () => {
      await shareManager.addFile(fileA);
      await shareManager.addFile(fileB);

      const list = shareManager.listFiles();
      assert.equal(list.fileCount, 2);
      assert.equal(list.files.length, 2);
      assert.ok(list.totalSize > 0);
      assert.ok(list.totalSizeFormatted);
    });

    it('should clear staging area completely', async () => {
      await shareManager.addFile(fileA);
      shareManager.clear();

      const list = shareManager.listFiles();
      assert.equal(list.fileCount, 0);
      assert.equal(list.totalSize, 0);
    });
  });
});
