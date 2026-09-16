/**
 * Serves the offline-shell service worker with its cache name injected.
 *
 * The cache name has to change with the app version, otherwise an already-installed
 * client keeps serving the previous shell after a fix ships. Deriving it here keeps
 * `package.json` as the only place a version is written, and keeps the repo free of
 * a build step.
 */

import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION, shellCacheName } from '../version.js';
import { logger } from '../utils/logger.js';

/** Marker in `public/sw.js` that this route replaces. */
export const CACHE_PLACEHOLDER = '__SHELL_CACHE_NAME__';

/**
 * @param {{ publicDir: string }} options
 * @returns {import('express').RequestHandler}
 */
export function createServiceWorkerHandler({ publicDir }) {
  let builtTemplate = null;
  let builtKey = null;

  return function serveServiceWorker(_req, res, next) {
    const sourcePath = path.join(publicDir, 'sw.js');

    let stat;
    try {
      stat = fs.statSync(sourcePath);
    } catch {
      // No worker on disk: let static handling decide (404).
      return next();
    }

    const buildKey = `${APP_VERSION}:${stat.mtimeMs}`;
    if (!builtTemplate || builtKey !== buildKey) {
      try {
        const template = fs.readFileSync(sourcePath, 'utf8');
        if (!template.includes(CACHE_PLACEHOLDER)) {
          throw new Error(`sw.js is missing the ${CACHE_PLACEHOLDER} placeholder`);
        }
        builtTemplate = template.replaceAll(CACHE_PLACEHOLDER, shellCacheName());
        builtKey = buildKey;
      } catch (err) {
        // Serving a worker with an unsubstituted placeholder would cache a shell
        // under a nonsense name, so fall back rather than send something broken.
        logger.warn('Service worker could not be built; serving the file unchanged', {
          error: err.message,
        });
        return next();
      }
    }

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    // The worker must never be cached, or an old shell can outlive a release.
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(builtTemplate);
  };
}
