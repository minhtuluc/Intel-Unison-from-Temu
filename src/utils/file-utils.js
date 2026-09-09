/**
 * File Utilities
 * Formatting file sizes, detecting file types/categories, and sanitizing file names.
 */

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

/**
 * Sanitizes a file name for safe storage on all operating systems.
 * - Removes null bytes, path separators, forbidden filesystem characters
 * - Strips directory traversal (e.g. ../)
 * - Limits max length to 255 characters while keeping extension intact
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

  // 4. Strip leading/trailing dots and spaces (Windows restriction)
  clean = clean.trim().replace(/^\.+/, '');

  // 5. If clean name is empty, provide fallback
  if (!clean) {
    return 'unnamed_file';
  }

  // 6. Truncate to max 255 chars, preserving extension
  const MAX_LEN = 255;
  if (clean.length > MAX_LEN) {
    const ext = path.extname(clean);
    const base = path.basename(clean, ext);
    const allowedBaseLen = Math.max(1, MAX_LEN - ext.length);
    clean = base.slice(0, allowedBaseLen) + ext;
  }

  return clean;
}
