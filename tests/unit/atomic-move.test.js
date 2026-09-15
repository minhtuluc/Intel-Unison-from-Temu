import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reserveWritableFile, atomicMove } from '../../src/utils/file-utils.js';

describe('Atomic Collision & Move Utilities (Unit)', () => {
  let rootDir;
  let targetDir;

  beforeEach(async () => {
    rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-atomic-test-'));
    targetDir = path.join(rootDir, 'destination');
    await fs.promises.mkdir(targetDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  describe('reserveWritableFile()', () => {
    it('should create and reserve a file with the desired name when no collision exists', async () => {
      const { fileName, filePath, fileHandle } = await reserveWritableFile(
        targetDir,
        'my_file.txt'
      );
      await fileHandle.close();

      assert.equal(fileName, 'my_file.txt');
      assert.equal(filePath, path.join(targetDir, 'my_file.txt'));
      assert.ok(fs.existsSync(filePath));
    });

    it('should resolve collisions by incrementing _(counter) when file already exists', async () => {
      // Create existing file
      await fs.promises.writeFile(path.join(targetDir, 'document.pdf'), 'ORIGINAL');

      const res1 = await reserveWritableFile(targetDir, 'document.pdf');
      await res1.fileHandle.close();
      assert.equal(res1.fileName, 'document_(1).pdf');

      const res2 = await reserveWritableFile(targetDir, 'document.pdf');
      await res2.fileHandle.close();
      assert.equal(res2.fileName, 'document_(2).pdf');
    });

    it('should handle 10 concurrent reservations for the exact same name with ZERO race collisions', async () => {
      const DESIRED = 'concurrent_test.dat';

      // Launch 10 simultaneous reservations
      const promises = Array.from({ length: 10 }, () => reserveWritableFile(targetDir, DESIRED));
      const results = await Promise.all(promises);

      // Close all handles
      for (const res of results) {
        await res.fileHandle.close();
      }

      const fileNames = results.map((r) => r.fileName);
      const uniqueNames = new Set(fileNames);

      // Every single file must have a unique name
      assert.equal(
        uniqueNames.size,
        10,
        'All 10 reservations must result in distinct unique filenames'
      );
      assert.ok(fileNames.includes('concurrent_test.dat'));
      for (let i = 1; i <= 9; i++) {
        assert.ok(fileNames.includes(`concurrent_test_(${i}).dat`));
      }
    });
  });

  describe('atomicMove()', () => {
    it('should move a source file to destination cleanly', async () => {
      const srcFile = path.join(rootDir, 'source.txt');
      await fs.promises.writeFile(srcFile, 'SOURCE_DATA');

      const { fileName, filePath } = await atomicMove(srcFile, targetDir, 'moved.txt');
      assert.equal(fileName, 'moved.txt');
      assert.ok(fs.existsSync(filePath));
      assert.equal(fs.existsSync(srcFile), false, 'Source file must be moved');

      const content = await fs.promises.readFile(filePath, 'utf8');
      assert.equal(content, 'SOURCE_DATA');
    });

    it('should resolve collision safely when destination already exists', async () => {
      await fs.promises.writeFile(path.join(targetDir, 'report.docx'), 'EXISTING_REPORT');

      const srcFile = path.join(rootDir, 'new_report.docx');
      await fs.promises.writeFile(srcFile, 'NEW_REPORT_DATA');

      const { fileName, filePath } = await atomicMove(srcFile, targetDir, 'report.docx');
      assert.equal(fileName, 'report_(1).docx');
      assert.ok(fs.existsSync(filePath));

      const origContent = await fs.promises.readFile(path.join(targetDir, 'report.docx'), 'utf8');
      assert.equal(origContent, 'EXISTING_REPORT');

      const newContent = await fs.promises.readFile(filePath, 'utf8');
      assert.equal(newContent, 'NEW_REPORT_DATA');
    });

    it('should handle concurrent atomic moves with same target name without overwrites', async () => {
      const DESIRED = 'shared_target.bin';
      const count = 5;
      const srcFiles = [];

      for (let i = 0; i < count; i++) {
        const src = path.join(rootDir, `src_${i}.bin`);
        await fs.promises.writeFile(src, `PAYLOAD_${i}`);
        srcFiles.push(src);
      }

      const results = await Promise.all(srcFiles.map((src) => atomicMove(src, targetDir, DESIRED)));

      const names = results.map((r) => r.fileName);
      assert.equal(
        new Set(names).size,
        count,
        'All moved files must have unique destination names'
      );

      for (const res of results) {
        assert.ok(fs.existsSync(res.filePath));
      }
    });

    it('should clean up reserved placeholder file if move fails', async () => {
      const nonExistentSrc = path.join(rootDir, 'missing_source.dat');

      await assert.rejects(async () => {
        await atomicMove(nonExistentSrc, targetDir, 'ghost.dat');
      });

      assert.equal(
        fs.existsSync(path.join(targetDir, 'ghost.dat')),
        false,
        'Placeholder must be removed on failure'
      );
    });
  });
});
