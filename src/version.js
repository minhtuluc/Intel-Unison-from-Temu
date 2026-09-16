/**
 * The single source of truth for the app version.
 *
 * `package.json` is the only place it is written; the service worker cache name,
 * the shell it serves and `/api/info` all derive from it. UT-016 exists because the
 * cache name used to be edited by hand, so a frontend fix could ship while installed
 * clients kept serving the previous shell.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PACKAGE_PATH = fileURLToPath(new URL('../package.json', import.meta.url));

function readVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const APP_VERSION = readVersion();

/** Cache namespace for the offline shell; changes whenever the version does. */
export function shellCacheName(version = APP_VERSION) {
  return `utrans-shell-${version}`;
}
