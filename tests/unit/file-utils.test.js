import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatFileSize,
  getFileType,
  sanitizeFileName,
  parseRange,
} from '../../src/utils/file-utils.js';

describe('File Utilities', () => {
  describe('formatFileSize()', () => {
    it('should format 0 and falsy values as 0 B', () => {
      assert.equal(formatFileSize(0), '0 B');
      assert.equal(formatFileSize(-100), '0 B');
      assert.equal(formatFileSize(null), '0 B');
      assert.equal(formatFileSize(NaN), '0 B');
    });

    it('should format byte values', () => {
      assert.equal(formatFileSize(500), '500 B');
      assert.equal(formatFileSize(1023), '1023 B');
    });

    it('should format KB values', () => {
      assert.equal(formatFileSize(1024), '1 KB');
      assert.equal(formatFileSize(1536), '1.5 KB');
      assert.equal(formatFileSize(102400), '100 KB');
    });

    it('should format MB values', () => {
      assert.equal(formatFileSize(1048576), '1 MB');
      assert.equal(formatFileSize(4521984), '4.3 MB');
    });

    it('should format GB values', () => {
      assert.equal(formatFileSize(1073741824), '1 GB');
      assert.equal(formatFileSize(5368709120), '5 GB');
    });

    it('should format TB values', () => {
      assert.equal(formatFileSize(1099511627776), '1 TB');
    });
  });

  describe('getFileType()', () => {
    it('should detect image types', () => {
      assert.equal(getFileType('photo.jpg'), 'image');
      assert.equal(getFileType('picture.PNG'), 'image');
      assert.equal(getFileType('animation.gif'), 'image');
      assert.equal(getFileType('art.webp'), 'image');
      assert.equal(getFileType('ios.heic'), 'image');
    });

    it('should detect video types', () => {
      assert.equal(getFileType('movie.mp4'), 'video');
      assert.equal(getFileType('clip.mkv'), 'video');
      assert.equal(getFileType('stream.webm'), 'video');
      assert.equal(getFileType('recording.mov'), 'video');
    });

    it('should detect audio types', () => {
      assert.equal(getFileType('song.mp3'), 'audio');
      assert.equal(getFileType('track.flac'), 'audio');
      assert.equal(getFileType('podcast.m4a'), 'audio');
    });

    it('should detect APK files', () => {
      assert.equal(getFileType('app-release.apk'), 'apk');
      assert.equal(getFileType('bundle.xapk'), 'apk');
    });

    it('should detect documents', () => {
      assert.equal(getFileType('doc.pdf'), 'document');
      assert.equal(getFileType('sheet.xlsx'), 'document');
      assert.equal(getFileType('notes.txt'), 'document');
      assert.equal(getFileType('spec.md'), 'document');
    });

    it('should detect archives', () => {
      assert.equal(getFileType('backup.zip'), 'archive');
      assert.equal(getFileType('archive.tar.gz'), 'archive');
      assert.equal(getFileType('data.7z'), 'archive');
    });

    it('should return other for unknown or extensionless files', () => {
      assert.equal(getFileType('unknown_file.xyz123'), 'other');
      assert.equal(getFileType('LICENSE'), 'other');
    });
  });

  describe('sanitizeFileName()', () => {
    it('should strip path traversal sequences', () => {
      assert.equal(sanitizeFileName('../../../etc/passwd'), 'passwd');
      assert.equal(sanitizeFileName('..\\..\\Windows\\System32\\calc.exe'), 'calc.exe');
      assert.equal(sanitizeFileName('folder/subfolder/file.jpg'), 'file.jpg');
    });

    it('should strip null bytes and control characters', () => {
      assert.equal(sanitizeFileName('test\0.jpg'), 'test.jpg');
      assert.equal(sanitizeFileName('secret\x1f.pdf'), 'secret.pdf');
    });

    it('should replace Windows/POSIX reserved characters', () => {
      assert.equal(sanitizeFileName('bad<name>:test"file|?.txt'), 'bad_name__test_file__.txt');
    });

    it('should preserve unicode filenames and spaces', () => {
      assert.equal(sanitizeFileName('Ảnh chụp 2026.jpg'), 'Ảnh chụp 2026.jpg');
      assert.equal(sanitizeFileName('日本語ドキュメント.pdf'), '日本語ドキュメント.pdf');
      assert.equal(sanitizeFileName('Report Q1 (Final).docx'), 'Report Q1 (Final).docx');
    });

    it('should truncate excessively long names while keeping extension', () => {
      const longBase = 'a'.repeat(300);
      const sanitized = sanitizeFileName(`${longBase}.mp4`);
      assert.ok(sanitized.length <= 255);
      assert.ok(sanitized.endsWith('.mp4'));
    });

    it('should truncate multi-byte UTF-8 names so byte length <= 255', () => {
      // Each Vietnamese character here is 3 bytes in UTF-8
      const multiByteBase = 'Tiếng_Việt_'.repeat(30);
      const sanitized = sanitizeFileName(`${multiByteBase}.docx`);
      assert.ok(Buffer.byteLength(sanitized, 'utf8') <= 255);
      assert.ok(sanitized.endsWith('.docx'));
    });

    it('should prefix Windows reserved device names', () => {
      assert.equal(sanitizeFileName('CON.txt'), '_CON.txt');
      assert.equal(sanitizeFileName('aux.log'), '_aux.log');
      assert.equal(sanitizeFileName('PRN'), '_PRN');
      assert.equal(sanitizeFileName('NUL.tar.gz'), '_NUL.tar.gz');
      assert.equal(sanitizeFileName('com1.zip'), '_com1.zip');
      assert.equal(sanitizeFileName('lpt9.bin'), '_lpt9.bin');
    });

    it('should strip trailing dots and spaces', () => {
      assert.equal(sanitizeFileName('document.txt...'), 'document.txt');
      assert.equal(sanitizeFileName('invoice.pdf   '), 'invoice.pdf');
      assert.equal(sanitizeFileName('my.file . . '), 'my.file');
    });

    it('should provide fallback for empty or completely stripped names', () => {
      assert.equal(sanitizeFileName(''), 'unnamed_file');
      assert.equal(sanitizeFileName(null), 'unnamed_file');
      assert.equal(sanitizeFileName('///'), 'unnamed_file');
      assert.equal(sanitizeFileName('...'), 'unnamed_file');
      assert.equal(sanitizeFileName('   '), 'unnamed_file');
    });
  });

  describe('parseRange()', () => {
    const FILE_SIZE = 1000;

    it('should parse valid explicit range bytes=start-end', () => {
      const parsed = parseRange('bytes=100-199', FILE_SIZE);
      assert.deepEqual(parsed, {
        satisfiable: true,
        start: 100,
        end: 199,
        contentLength: 100,
      });
    });

    it('should parse open-ended range bytes=start-', () => {
      const parsed = parseRange('bytes=500-', FILE_SIZE);
      assert.deepEqual(parsed, {
        satisfiable: true,
        start: 500,
        end: 999,
        contentLength: 500,
      });
    });

    it('should parse suffix range bytes=-suffix', () => {
      const parsed = parseRange('bytes=-200', FILE_SIZE);
      assert.deepEqual(parsed, {
        satisfiable: true,
        start: 800,
        end: 999,
        contentLength: 200,
      });
    });

    it('should clamp suffix range when suffix >= fileSize', () => {
      const parsed = parseRange('bytes=-1500', FILE_SIZE);
      assert.deepEqual(parsed, {
        satisfiable: true,
        start: 0,
        end: 999,
        contentLength: 1000,
      });
    });

    it('should clamp end when end >= fileSize per RFC 9110', () => {
      const parsed = parseRange('bytes=800-2000', FILE_SIZE);
      assert.deepEqual(parsed, {
        satisfiable: true,
        start: 800,
        end: 999,
        contentLength: 200,
      });
    });

    it('should return satisfiable: false when start >= fileSize', () => {
      const parsed = parseRange('bytes=1000-1200', FILE_SIZE);
      assert.deepEqual(parsed, { satisfiable: false });
    });

    it('should return satisfiable: false when end < start', () => {
      const parsed = parseRange('bytes=500-400', FILE_SIZE);
      assert.deepEqual(parsed, { satisfiable: false });
    });

    it('should return satisfiable: false for empty files (fileSize === 0)', () => {
      const parsed = parseRange('bytes=0-0', 0);
      assert.deepEqual(parsed, { satisfiable: false });
    });

    it('should return satisfiable: false for multi-range', () => {
      const parsed = parseRange('bytes=0-10, 20-30', FILE_SIZE);
      assert.deepEqual(parsed, { satisfiable: false });
    });

    it('should return null for non-bytes or missing range header', () => {
      assert.equal(parseRange(null, FILE_SIZE), null);
      assert.equal(parseRange('', FILE_SIZE), null);
      assert.equal(parseRange('items=0-10', FILE_SIZE), null);
      assert.equal(parseRange(undefined, FILE_SIZE), null);
    });
  });
});
