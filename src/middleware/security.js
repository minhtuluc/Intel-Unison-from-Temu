/**
 * Security Middleware
 * Path traversal checks, PIN verification, and LAN origin validation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './error-handler.js';

/** Real path when the entry exists, otherwise the resolved path unchanged. */
function realPathOrResolved(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** Collects the lexical path plus its symlink-resolved form (and the parent's). */
function candidatePaths(requestedPath) {
  const resolved = path.resolve(requestedPath);
  const candidates = new Set([
    resolved,
    realPathOrResolved(resolved),
    realPathOrResolved(path.dirname(resolved)),
  ]);
  return [...candidates];
}

/**
 * Structural checks that must run before any filesystem access.
 * @param {string} requestedPath
 * @returns {string} resolved absolute path
 */
export function assertPathShape(requestedPath) {
  if (!requestedPath || typeof requestedPath !== 'string') {
    throw new AppError('INVALID_PATH', 400, 'File path must be a non-empty string');
  }

  // Block null bytes
  if (requestedPath.includes('\0')) {
    throw new AppError('ACCESS_DENIED', 403, 'Path contains null bytes');
  }

  return path.resolve(requestedPath);
}

/**
 * Validates that requestedPath is contained within one of allowedDirs.
 * Symlinked paths are resolved so a link inside the allowlist cannot point out of it.
 * @param {string} requestedPath
 * @param {string[]} allowedDirs
 * @returns {string} resolved absolute path
 */
export function validatePath(requestedPath, allowedDirs = []) {
  const resolved = assertPathShape(requestedPath);
  const candidates = candidatePaths(requestedPath);

  // Every candidate (lexical path, symlink target, parent directory target) must
  // stay inside the allowlist; a link inside the allowlist cannot escape through it.
  const isAllowed = allowedDirs.some((dir) => {
    const roots = [path.resolve(dir), realPathOrResolved(path.resolve(dir))];
    return candidates.every((candidate) =>
      roots.some((root) => candidate === root || candidate.startsWith(root + path.sep))
    );
  });

  if (!isAllowed) {
    throw new AppError('ACCESS_DENIED', 403, 'Path is outside of allowed directories');
  }

  return resolved;
}
