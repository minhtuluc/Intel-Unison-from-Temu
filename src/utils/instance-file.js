/**
 * Instance file — records which process owns a UniversalTrans listener.
 *
 * Launchers stop the app through this file instead of killing whatever happens to
 * hold a port, so an unrelated application on the same port is never terminated.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @param {number} port */
export function instanceFilePath(port) {
  return path.join(os.tmpdir(), `utrans-${port}.json`);
}

/**
 * @param {{ port: number, pid?: number, tempDir?: string }} info
 * @returns {string} path written
 */
export function writeInstanceFile({ port, pid = process.pid, tempDir = null }) {
  const target = instanceFilePath(port);
  const payload = { pid, port, tempDir, startedAt: new Date().toISOString() };
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return target;
}

/**
 * @param {number} port
 * @returns {{ pid: number, port: number, tempDir: string|null, startedAt: string }|null}
 */
export function readInstanceFile(port) {
  try {
    const raw = fs.readFileSync(instanceFilePath(port), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.pid !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {number} port
 * @returns {boolean} true when a file was removed
 */
export function removeInstanceFile(port) {
  try {
    fs.unlinkSync(instanceFilePath(port));
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the recorded owner process is still running.
 * @param {{ pid: number }} record
 */
export function isInstanceAlive(record) {
  if (!record || typeof record.pid !== 'number') return false;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
