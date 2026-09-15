/**
 * File Utilities
 * Formatting file sizes, detecting file types/categories, and sanitizing file names.
 */

import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';

const FILE_TYPE_MAP = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif', 'tiff', 'avif'],
  video: ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'ts'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus'],
  apk: ['apk', 'xapk', 'apks'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'rtf', 'epub'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
};

/**
 * Formats a byte number into a human-readable string.
 * @param {number} bytes
 * @returns {string} e.g. "4.3 MB"
 */
export function formatFileSize(bytes) {
  if (typeof bytes !== 'number' || isNaN(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const clampedIndex = Math.min(i, units.length - 1);

  if (clampedIndex === 0) {
    return `${bytes} B`;
  }

  const value = bytes / Math.pow(k, clampedIndex);
  return `${parseFloat(value.toFixed(1))} ${units[clampedIndex]}`;
}

/**
 * Categorizes a file into image, video, audio, apk, document, archive, or other.
 * @param {string} fileName
 * @param {string} [mimeType]
 * @returns {'image'|'video'|'audio'|'apk'|'document'|'archive'|'other'}
 */
export function getFileType(fileName, mimeType = null) {
  const ext = path
    .extname(fileName || '')
    .slice(1)
    .toLowerCase();

  // Check explicit extension categories first (APK is special)
  if (FILE_TYPE_MAP.apk.includes(ext)) {
    return 'apk';
  }

  // Check MIME type if provided or lookup from extension
  const detectedMime = mimeType || mime.lookup(fileName) || '';

  if (detectedMime.startsWith('image/') || FILE_TYPE_MAP.image.includes(ext)) {
    return 'image';
  }
  if (detectedMime.startsWith('video/') || FILE_TYPE_MAP.video.includes(ext)) {
    return 'video';
  }
  if (detectedMime.startsWith('audio/') || FILE_TYPE_MAP.audio.includes(ext)) {
    return 'audio';
  }
  if (
    FILE_TYPE_MAP.document.includes(ext) ||
    detectedMime.includes('pdf') ||
    detectedMime.includes('document')
  ) {
    return 'document';
  }
  if (
    FILE_TYPE_MAP.archive.includes(ext) ||
    detectedMime.includes('zip') ||
    detectedMime.includes('tar') ||
    detectedMime.includes('compressed')
  ) {
    return 'archive';
  }

  return 'other';
}
const WINDOWS_RESERVED_REGEX = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * Sanitizes a file name for safe storage on all operating systems.
 * - Removes null bytes, path separators, forbidden filesystem characters
 * - Strips directory traversal (e.g. ../)
 * - Strips leading/trailing dots and whitespace (Windows compatibility)
 * - Prevents Windows reserved device names (CON, NUL, AUX, PRN, COM1-9, LPT1-9)
 * - Limits max length to 255 bytes in UTF-8 while preserving extension intact
 * - Preserves Unicode characters (Vietnamese, CJK, etc.)
 * @param {string} name
 * @returns {string} Safe file name
 */
export function sanitizeFileName(name) {
  if (!name || typeof name !== 'string') {
    return 'unnamed_file';
  }

  // 1. Remove null bytes and control characters
  // eslint-disable-next-line no-control-regex
  let clean = name.replace(/[\x00-\x1f\x80-\x9f]/g, '');

  // 2. Take only basename (strip directory traversal and path separators)
  clean = clean.split(/[\\/]/).pop() || '';

  // 3. Remove Windows/POSIX reserved characters: < > : " / \ | ? *
  clean = clean.replace(/[<>:"/\\|?*]/g, '_');

  // 4. Strip leading and trailing dots and spaces (Windows restriction)
  clean = clean
    .trim()
    .replace(/^\.+/, '')
    .replace(/[.\s]+$/, '');

  // 5. If clean name is empty, provide fallback
  if (!clean) {
    return 'unnamed_file';
  }

  // 6. Check Windows reserved device names (CON, NUL, AUX, PRN, COM1-9, LPT1-9)
  // In Windows, reserved device names apply whether there is an extension or multiple extensions,
  // e.g. CON, CON.txt, NUL.tar.gz are all reserved.
  const dotIndex = clean.indexOf('.');
  const rootName = dotIndex === -1 ? clean : clean.slice(0, dotIndex);
  if (WINDOWS_RESERVED_REGEX.test(rootName)) {
    clean = `_${clean}`;
  }

  // 7. Truncate to max 255 bytes (UTF-8), preserving extension
  const MAX_BYTES = 255;
  if (Buffer.byteLength(clean, 'utf8') > MAX_BYTES) {
    const ext = path.extname(clean);
    let base = path.basename(clean, ext);
    const extBytes = Buffer.byteLength(ext, 'utf8');
    const maxBaseBytes = Math.max(1, MAX_BYTES - extBytes);
    while (Buffer.byteLength(base, 'utf8') > maxBaseBytes && base.length > 0) {
      base = base.slice(0, -1);
    }
    clean = base + ext;
  }

  return clean || 'unnamed_file';
}

/**
 * Parses HTTP Range header according to RFC 9110.
 * Supports "bytes=start-end", "bytes=start-", "bytes=-suffix".
 * Clamps end to EOF.
 * @param {string} rangeHeader
 * @param {number} fileSize
 * @returns {{ satisfiable: boolean, start?: number, end?: number, contentLength?: number } | null}
 */
export function parseRange(rangeHeader, fileSize) {
  if (!rangeHeader || typeof rangeHeader !== 'string' || !rangeHeader.startsWith('bytes=')) {
    return null;
  }

  if (fileSize <= 0) {
    return { satisfiable: false };
  }

  const spec = rangeHeader.slice(6).trim();
  if (spec.includes(',')) {
    // Multi-range is not supported in this version
    return { satisfiable: false };
  }

  const dashIndex = spec.indexOf('-');
  if (dashIndex === -1) {
    return { satisfiable: false };
  }

  const startStr = spec.slice(0, dashIndex).trim();
  const endStr = spec.slice(dashIndex + 1).trim();

  let start;
  let end;

  if (startStr === '') {
    // Suffix range: bytes=-N
    if (endStr === '') return { satisfiable: false };
    const suffix = parseInt(endStr, 10);
    if (isNaN(suffix) || suffix <= 0) return { satisfiable: false };
    if (suffix >= fileSize) {
      start = 0;
      end = fileSize - 1;
    } else {
      start = fileSize - suffix;
      end = fileSize - 1;
    }
  } else {
    start = parseInt(startStr, 10);
    if (isNaN(start) || start < 0 || start >= fileSize) return { satisfiable: false };

    if (endStr === '') {
      // Open-ended: bytes=N-
      end = fileSize - 1;
    } else {
      end = parseInt(endStr, 10);
      if (isNaN(end) || end < start) return { satisfiable: false };
      // Clamp end to EOF per RFC 9110
      if (end >= fileSize) {
        end = fileSize - 1;
      }
    }
  }

  return {
    satisfiable: true,
    start,
    end,
    contentLength: end - start + 1,
  };
}

/**
 * Atomically reserves a non-colliding file path in targetDir using exclusive creation (O_CREAT | O_EXCL).
 * If desiredName exists, increments (1), (2), etc.
 * Returns { fileName, filePath, fileHandle } with an open FileHandle that the caller can write into or close.
 * @param {string} targetDir
 * @param {string} desiredName
 * @returns {Promise<{ fileName: string, filePath: string, fileHandle: import('node:fs/promises').FileHandle }>}
 */
export async function reserveWritableFile(targetDir, desiredName) {
  await fs.promises.mkdir(targetDir, { recursive: true });
  const cleanName = sanitizeFileName(desiredName);
  const ext = path.extname(cleanName);
  const base = path.basename(cleanName, ext);

  let counter = 0;
  while (true) {
    const candidateName = counter === 0 ? cleanName : `${base}_(${counter})${ext}`;
    const candidatePath = path.join(targetDir, candidateName);

    try {
      const fileHandle = await fs.promises.open(candidatePath, 'wx');
      return { fileName: candidateName, filePath: candidatePath, fileHandle };
    } catch (err) {
      if (err.code === 'EEXIST') {
        counter++;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Atomically moves a file from src into targetDir under desiredName (or non-colliding copy).
 * Handles cross-device moves (EXDEV) and cleans up reserved placeholder on failure.
 * @param {string} src
 * @param {string} targetDir
 * @param {string} desiredName
 * @returns {Promise<{ fileName: string, filePath: string }>}
 */
export async function atomicMove(src, targetDir, desiredName) {
  const { fileName, filePath, fileHandle } = await reserveWritableFile(targetDir, desiredName);
  await fileHandle.close();

  try {
    try {
      await fs.promises.rename(src, filePath);
    } catch (err) {
      if (err.code === 'EXDEV') {
        await fs.promises.copyFile(src, filePath);
        await fs.promises.unlink(src);
      } else {
        throw err;
      }
    }
    return { fileName, filePath };
  } catch (err) {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}
