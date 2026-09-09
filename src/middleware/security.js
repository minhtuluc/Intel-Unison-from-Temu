/**
 * Security Middleware
 * Path traversal checks, PIN verification, and LAN origin validation.
 */

import path from 'node:path';
import { AppError } from './error-handler.js';

/**
 * Validates that requestedPath is contained within one of allowedDirs.
 * @param {string} requestedPath
 * @param {string[]} allowedDirs
 * @returns {string} resolved absolute path
 */
export function validatePath(requestedPath, allowedDirs = []) {
  if (!requestedPath || typeof requestedPath !== 'string') {
    throw new AppError('INVALID_PATH', 400, 'File path must be a non-empty string');
  }

  // Block null bytes
  if (requestedPath.includes('\0')) {
    throw new AppError('ACCESS_DENIED', 403, 'Path contains null bytes');
  }

  const resolved = path.resolve(requestedPath);
  const isAllowed = allowedDirs.some((dir) => {
    const resolvedDir = path.resolve(dir);
    return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep);
  });

  if (!isAllowed) {
    throw new AppError('ACCESS_DENIED', 403, 'Path is outside of allowed directories');
  }

  return resolved;
}
