/**
 * Trusted devices — consent remembered across sessions.
 *
 * A device the host has explicitly trusted may send files without a fresh prompt.
 * The device proves itself with a 256-bit token it generates and keeps locally; the
 * server stores only a SHA-256 hash, never the token itself, so a leaked data file
 * cannot be replayed as a device. Store lives in `dataDir` because trust must
 * survive a restart — unlike staging, none of this is disposable.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../middleware/error-handler.js';
import { generateId } from '../utils/id-generator.js';
import { logger } from '../utils/logger.js';

const TOKEN_RE = /^[a-f0-9]{64}$/i;
const STORE_FILE = 'trusted-devices.json';
const MAX_TRUSTED_DEVICES = 100;

/**
 * Hashes a device token. Exported so an offer can carry the hash of the device
 * that made it — the host approves a device without ever seeing its secret.
 * @param {string} token
 */
export function hashDeviceToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export class TrustedDeviceService {
  /**
   * @param {{ config: object }} options
   */
  constructor({ config }) {
    this.config = config;
    this.filePath = path.join(config.dataDir, STORE_FILE);
    /** @type {Array<{id: string, tokenHash: string, label: string, platform: string, trustedAt: number, lastSeenAt: number|null}>} */
    this.devices = [];
    this._load();
  }

  /** @private Reads the store; a missing or corrupt file starts empty rather than crashing. */
  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.devices)) {
        this.devices = parsed.devices.filter(
          (entry) => entry && typeof entry.tokenHash === 'string' && typeof entry.id === 'string'
        );
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Trusted device store could not be read; starting empty', {
          error: err.message,
        });
      }
      this.devices = [];
    }
  }

  /** @private Atomic write; the store holds credential hashes so it stays owner-only. */
  async _persist() {
    const payload = JSON.stringify({ version: 1, devices: this.devices }, null, 2);
    const dir = path.dirname(this.filePath);
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tmpPath, this.filePath);
    } catch (err) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
      logger.warn('Trusted device store could not be written', { error: err.message });
      throw new AppError('TRUST_STORE_WRITE_FAILED', 500, 'Could not persist trusted devices');
    }
  }

  /**
   * Constant-time lookup by device-supplied token.
   * @param {string|undefined} token
   * @returns {object|null} the matching record, with `lastSeenAt` refreshed
   */
  find(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const candidate = Buffer.from(hashDeviceToken(token), 'hex');
    for (const device of this.devices) {
      const stored = Buffer.from(device.tokenHash, 'hex');
      if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
        device.lastSeenAt = Date.now();
        return device;
      }
    }
    return null;
  }

  /**
   * @param {string|undefined} token
   * @returns {boolean}
   */
  isTrusted(token) {
    return this.find(token) !== null;
  }

  /**
   * Remembers a device. Re-trusting the same token refreshes its label instead of
   * adding a duplicate row.
   * @param {{ token: string, label?: string, platform?: string }} input
   * @returns {Promise<object>} sanitized record
   */
  async trust({ token, label = 'Unknown device', platform = 'unknown' }) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
      throw new AppError('INVALID_DEVICE_TOKEN', 400, 'Device token must be 64 hex characters');
    }
    return await this.trustByHash({ tokenHash: hashDeviceToken(token), label, platform });
  }

  /**
   * Remembers a device from an already-hashed token, which is how the host trusts a
   * device it is answering an offer from: the host never holds the device's secret.
   * @param {{ tokenHash: string, label?: string, platform?: string }} input
   * @returns {Promise<object>} sanitized record
   */
  async trustByHash({ tokenHash, label = 'Unknown device', platform = 'unknown' }) {
    if (typeof tokenHash !== 'string' || !TOKEN_RE.test(tokenHash)) {
      throw new AppError(
        'INVALID_DEVICE_TOKEN',
        400,
        'Device token hash must be 64 hex characters'
      );
    }
    const existing = this.devices.find((d) => d.tokenHash === tokenHash);
    if (existing) {
      const previous = {
        label: existing.label,
        platform: existing.platform,
        trustedAt: existing.trustedAt,
      };
      existing.label = label;
      existing.platform = platform;
      existing.trustedAt = Date.now();
      try {
        await this._persist();
      } catch (err) {
        // Trust is a durable promise: if it cannot be written, it must not be claimed.
        Object.assign(existing, previous);
        throw err;
      }
      return this.sanitize(existing);
    }

    if (this.devices.length >= MAX_TRUSTED_DEVICES) {
      throw new AppError(
        'TOO_MANY_TRUSTED_DEVICES',
        409,
        `At most ${MAX_TRUSTED_DEVICES} devices can be trusted; revoke one first`
      );
    }

    const record = {
      id: generateId('td_'),
      tokenHash,
      label,
      platform,
      trustedAt: Date.now(),
      lastSeenAt: null,
    };
    this.devices.push(record);
    try {
      await this._persist();
    } catch (err) {
      this.devices.pop();
      throw err;
    }
    return this.sanitize(record);
  }

  /**
   * @param {string} id
   * @returns {Promise<{id: string, revoked: boolean}>}
   */
  async revoke(id) {
    const index = this.devices.findIndex((d) => d.id === id);
    if (index === -1) return { id, revoked: false };
    const [removed] = this.devices.splice(index, 1);
    try {
      await this._persist();
    } catch (err) {
      // A revocation that was not written did not happen.
      this.devices.splice(index, 0, removed);
      throw err;
    }
    return { id, revoked: true };
  }

  /** @returns {Array<object>} records without token hashes */
  list() {
    return this.devices.map((device) => this.sanitize(device));
  }

  /**
   * @param {object} record
   * @returns {object} record with the credential hash removed
   */
  sanitize(record) {
    return {
      id: record.id,
      label: record.label,
      platform: record.platform,
      trustedAt: record.trustedAt,
      lastSeenAt: record.lastSeenAt,
    };
  }
}
