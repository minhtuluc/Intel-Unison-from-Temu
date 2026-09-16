/**
 * Transfer history.
 *
 * Outcomes used to live only in a per-manager ring buffer that vanished on restart
 * and had no endpoint to list it, so "what happened to my file?" had no answer once
 * the modal closed. Entries are kept in memory for reading and mirrored to
 * `dataDir` so they survive a restart; `tempDir` would be wrong because this is not
 * disposable staging.
 *
 * Sender attribution is the server-observed identity, and the display label stays
 * explicitly untrusted — the same rule the device registry follows.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

const STORE_FILE = 'transfer-history.json';
const DEFAULT_LIMIT = 500;
const MAX_LIST = 200;

/** Write coalescing: history is written often and read rarely. */
const PERSIST_DELAY_MS = 250;

export class TransferHistoryService {
  /**
   * @param {{ config: object, limit?: number }} options
   */
  constructor({ config, limit = DEFAULT_LIMIT }) {
    this.config = config;
    this.limit = limit;
    this.filePath = path.join(config.dataDir, STORE_FILE);
    /** @type {Array<object>} newest first */
    this.entries = [];
    this._persistTimer = null;
    this._load();
  }

  /** @private A missing or corrupt store starts empty rather than crashing the app. */
  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(parsed?.entries)) {
        this.entries = parsed.entries.filter((entry) => entry && typeof entry.status === 'string');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Transfer history could not be read; starting empty', { error: err.message });
      }
      this.entries = [];
    }
  }

  /** @private Coalesced, atomic write. */
  _schedulePersist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persist().catch(() => {});
    }, PERSIST_DELAY_MS);
    if (this._persistTimer.unref) this._persistTimer.unref();
  }

  /** @private */
  async _persist() {
    const payload = JSON.stringify({ version: 1, entries: this.entries }, null, 2);
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tmpPath, this.filePath);
    } catch (err) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
      logger.warn('Transfer history could not be written', { error: err.message });
    }
  }

  /**
   * Records one terminal outcome. Never throws: history is an observer, and a
   * failure to record must not fail the transfer that just succeeded.
   * @param {{ status: string, fileName?: string, size?: number, reason?: string, source?: string, sender?: object }} entry
   */
  record(entry) {
    if (!entry || typeof entry.status !== 'string') return;

    const sender = entry.sender || {};
    this.entries.unshift({
      status: entry.status,
      fileName: entry.fileName || null,
      size: Number.isFinite(entry.size) ? entry.size : null,
      reason: entry.reason || null,
      source: entry.source || 'upload',
      connectionId: sender.connectionId || null,
      label: sender.label || 'Unknown device',
      labelUntrusted: true,
      platform: sender.platform || 'unknown',
      timestamp: Date.now(),
    });

    if (this.entries.length > this.limit) {
      this.entries.length = this.limit;
    }
    this._schedulePersist();
  }

  /**
   * The host sees the whole history; a client sees only what it sent. Filtering by
   * connection is what stops one phone from reading another phone's activity.
   * @param {{ connectionId?: string|null, isHost?: boolean, limit?: number }} [options]
   */
  list({ connectionId = null, isHost = false, limit = MAX_LIST } = {}) {
    const capped = Math.min(Math.max(Number(limit) || MAX_LIST, 1), MAX_LIST);
    const visible = isHost
      ? this.entries
      : this.entries.filter((entry) => entry.connectionId && entry.connectionId === connectionId);
    return visible.slice(0, capped);
  }

  /** Forces any pending write; used on shutdown. */
  async flush() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    await this._persist();
  }

  clear() {
    this.entries = [];
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
  }
}
