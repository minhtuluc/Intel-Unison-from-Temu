/**
 * Relay transfers — a file sent by one client *to another client*, carried through the
 * host (UT-021).
 *
 * This is the M4 counterpart of `TransferOfferService`, and the difference is who holds
 * the authority: the **receiver** decides, not the host. The host only carries the bytes
 * and can cancel/revoke; it can neither accept on the receiver's behalf nor download the
 * result. Everything the sender/receiver are recognized by is server-derived (identity
 * keys, see utils/client-identity.js) — never a client-declared id.
 *
 * Like the M3 offer, an offer here is metadata only: no byte moves until the receiver
 * accepts, and acceptance is what issues the single-use grants that open the write path.
 *
 * Grant semantics are intentionally identical to `TransferOfferService`
 * (`issued -> in_use -> fulfilled`, bound to the sender's connection). A parameterized
 * regression test runs the same rejection matrix against both services so the two
 * implementations cannot drift apart.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../middleware/error-handler.js';
import { generateId } from '../utils/id-generator.js';
import { validateOfferFiles } from './transfer-offer.js';
import { logger } from '../utils/logger.js';

/** Closed relays are kept briefly so a reconnecting peer can still read the outcome. */
const MAX_TRACKED_RELAYS = 200;

/** 256-bit token the receiver presents to download its own relay files (no-PIN mode). */
const RELAY_TOKEN_BYTES = 32;
const TOKEN_RE = /^[a-f0-9]{64}$/i;

/** @param {string} token */
export function hashRelayToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Constant-time comparison of a presented relay token against a stored hash.
 * @param {unknown} presented
 * @param {string|null|undefined} storedHash
 */
export function relayTokenMatches(presented, storedHash) {
  if (typeof presented !== 'string' || !TOKEN_RE.test(presented)) return false;
  if (typeof storedHash !== 'string' || !TOKEN_RE.test(storedHash)) return false;
  const a = Buffer.from(hashRelayToken(presented.toLowerCase()), 'hex');
  const b = Buffer.from(storedHash.toLowerCase(), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class RelayTransferService {
  /**
   * @param {{ config: object, shareManager?: object|null, quotaTracker?: object|null }} options
   */
  constructor({ config, shareManager = null, quotaTracker = null }) {
    this.config = config;
    this.shareManager = shareManager;
    this.quotaTracker = quotaTracker;

    /** @type {Map<string, object>} relayId -> open relay */
    this.relays = new Map();
    /** @type {Map<string, object>} relayId -> closed relay (bounded readback) */
    this.recent = new Map();
    /** @type {Map<string, object>} grantId -> grant */
    this.grants = new Map();
    /** @type {Map<string, object>} fileId -> stored relay file awaiting the receiver */
    this.storedFiles = new Map();

    /** Fired when an open relay offer reaches its deadline. */
    this.onOfferExpire = null;
    /** Fired for stored-file lifecycle transitions: expired | revoked | downloaded. */
    this.onStoredEvent = null;
  }

  /** An offer the receiver never answered is abandoned; same window as the host flow. */
  get offerTtlMs() {
    const configured = Number(this.config?.offerTtlMs);
    return Number.isFinite(configured) && configured > 0 ? configured : 2 * 60 * 1000;
  }

  /** How long a stored relay file waits for the receiver before it is deleted. */
  get relayTtlMs() {
    const configured = Number(this.config?.relayTtlMs);
    return Number.isFinite(configured) && configured > 0 ? configured : 60 * 60 * 1000;
  }

  /** Grants must outlive the transfer they authorize, so they track uploadExpiry. */
  get grantTtlMs() {
    const configured = Number(this.config?.uploadExpiry);
    return Number.isFinite(configured) && configured > 0 ? configured : 60 * 60 * 1000;
  }

  /**
   * Registers a batch the sender wants delivered to a specific receiver.
   * @param {{ files: object[], sender: object, receiver: { keys: string[], deviceId: string, label?: string, platform?: string } }} input
   * @returns {{ relay: object, files: object[] }}
   */
  createOffer({ files, sender, receiver }) {
    const normalized = validateOfferFiles(files);
    if (!receiver || !Array.isArray(receiver.keys) || receiver.keys.length === 0) {
      throw new AppError(
        'RECEIVER_REQUIRED',
        400,
        'A relay transfer requires a verified receiver identity'
      );
    }

    const relayId = generateId('rl_');
    const relay = {
      relayId,
      state: 'pending',
      files: normalized.map((file, index) => ({
        index,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        checksum: file.checksum,
        decision: 'pending',
        grantId: null,
        fileId: null,
      })),
      // The sender's identity keys are captured here so a reconnecting sender is still
      // recognized as the owner of this relay (the connectionId alone is not durable).
      sender: { ...sender, keys: Array.isArray(sender?.keys) ? [...sender.keys] : [] },
      receiver: {
        keys: [...receiver.keys],
        deviceId: receiver.deviceId || null,
        label: receiver.label || 'Unknown device',
        labelUntrusted: true,
        platform: receiver.platform || 'unknown',
      },
      createdAt: Date.now(),
      ttlMs: this.offerTtlMs,
      timeoutId: null,
    };

    this.relays.set(relayId, relay);
    this._armOfferExpiry(relay);
    return { relay, files: relay.files };
  }

  /** @param {string} relayId */
  getRelay(relayId) {
    return this.relays.get(relayId) || this.recent.get(relayId) || null;
  }

  /** Relays addressed to any of these keys that are still awaiting a decision. */
  listPendingFor(keys = []) {
    const list = [];
    for (const relay of this.relays.values()) {
      if (relay.state !== 'pending') continue;
      if (!this._matchesReceiver(relay, keys)) continue;
      list.push(this.sanitize(relay));
    }
    return list;
  }

  /**
   * @param {{ connectionId?: string|null, keys?: string[] }} actor
   */
  listSentFor(actor = {}) {
    const list = [];
    for (const relay of [...this.relays.values(), ...this.recent.values()]) {
      if (!this._matchesSender(relay, actor)) continue;
      list.push(this.sanitize(relay));
    }
    return list.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Applies the receiver's decisions. Only the bound receiver may call this: the host
   * has no bypass here, which is the whole point of M4.
   * @param {string} relayId
   * @param {Array<{index: number, action: 'accept'|'decline'}>} decisions
   * @param {{ keys?: string[] }} actor
   * @returns {{ relay: object, decisions: object[], tokens: Record<number, string> }}
   */
  decide(relayId, decisions, actor = {}) {
    const relay = this.getRelay(relayId);
    if (!relay) {
      throw new AppError('RELAY_NOT_FOUND', 404, `Relay ${relayId} not found`);
    }
    // Authorization first: a foreign actor must not learn whether the relay is still open.
    if (!this._matchesReceiver(relay, actor.keys)) {
      throw new AppError('RELAY_FORBIDDEN', 403, 'Relay belongs to another receiver');
    }
    if (relay.state !== 'pending') {
      throw new AppError('RELAY_CLOSED', 409, `Relay ${relayId} is ${relay.state}`);
    }
    if (!Array.isArray(decisions) || decisions.length === 0) {
      throw new AppError('INVALID_INPUT', 400, 'decisions must be a non-empty array');
    }

    // Validate the whole batch before mutating anything (same atomicity rule as M3-QC-04).
    const seen = new Set();
    const planned = [];
    for (const decision of decisions) {
      const index = Number(decision?.index);
      if (!Number.isInteger(index) || index < 0) {
        throw new AppError('INVALID_INPUT', 400, `Invalid file index: ${decision?.index}`);
      }
      if (seen.has(index)) {
        throw new AppError('INVALID_INPUT', 400, `Duplicate index ${index} in decisions batch`);
      }
      seen.add(index);

      const target = relay.files.find((f) => f.index === index);
      if (!target) {
        throw new AppError('INVALID_INPUT', 400, `decisions index ${index} is not in relay`);
      }
      const action = decision?.action;
      if (action !== 'accept' && action !== 'decline') {
        throw new AppError('INVALID_INPUT', 400, 'action must be "accept" or "decline"');
      }
      if (target.decision !== 'pending') {
        throw new AppError(
          'RELAY_CONFLICT',
          409,
          `File index ${index} has already been decided (${target.decision})`
        );
      }
      planned.push({ target, action, index });
    }

    const tokens = {};
    const applied = [];
    for (const { target, action, index } of planned) {
      target.decision = action === 'accept' ? 'accepted' : 'declined';
      if (action === 'decline') {
        applied.push({ index, decision: 'declined', grantId: null });
        continue;
      }
      const grant = this._issueGrant(relay, index);
      target.grantId = grant.grantId;
      // The download capability is returned exactly once, here; only its hash is kept.
      const raw = randomBytes(RELAY_TOKEN_BYTES).toString('hex');
      target.receiverTokenHash = hashRelayToken(raw);
      tokens[index] = raw;
      applied.push({ index, decision: 'accepted', grantId: grant.grantId });
    }

    if (relay.files.every((file) => file.decision !== 'pending')) {
      relay.state = 'decided';
      this._closeRelay(relay, 'decided');
    }

    return { relay, decisions: applied, tokens };
  }

  /**
   * Sender (or host) abandons a relay before/after it is stored.
   * @param {string} relayId
   * @param {{ keys?: string[], connectionId?: string|null, isHost?: boolean }} actor
   */
  cancelOffer(relayId, actor = {}) {
    const relay = this.relays.get(relayId);
    if (!relay) {
      throw new AppError('RELAY_NOT_FOUND', 404, `Relay ${relayId} not found`);
    }
    if (!actor.isHost && !this._matchesSender(relay, actor)) {
      throw new AppError('RELAY_FORBIDDEN', 403, 'Relay belongs to another sender');
    }

    for (const file of relay.files) {
      if (file.decision === 'pending') file.decision = 'cancelled';
    }
    relay.state = 'cancelled';
    // Anything already stored belongs to this relay; cancelling removes it.
    this._discardStoredFor(relayId, 'CANCELLED');
    this._closeRelay(relay, 'cancelled');
    return this.sanitize(relay);
  }

  /**
   * Registers a file that has landed in the relay staging area. Arms its TTL, so an
   * undownloaded file is cleaned up instead of squatting on the host's disk forever.
   * @param {{ relayId: string, fileIndex: number, fileId: string, size: number, name: string, mimeType?: string }} input
   */
  attachStoredFile({ relayId, fileIndex, fileId, size, name, mimeType = null }) {
    const relay = this.relays.get(relayId) || this.recent.get(relayId) || null;
    const file = relay?.files.find((f) => f.index === Number(fileIndex)) || null;
    if (file) {
      file.fileId = fileId;
      file.storedAt = Date.now();
    }

    const record = {
      fileId,
      relayId,
      fileIndex: Number(fileIndex),
      size: Number(size) || 0,
      name,
      mimeType,
      state: 'stored',
      storedAt: Date.now(),
      expiresAt: Date.now() + this.relayTtlMs,
      timeoutId: null,
    };
    record.timeoutId = setTimeout(() => this._expireStored(fileId, 'TIMEOUT'), this.relayTtlMs);
    if (record.timeoutId.unref) record.timeoutId.unref();

    this.storedFiles.set(fileId, record);
    // Both peers learn the bytes are ready; the receiver needs this to refresh its inbox
    // after it already accepted (M4-QC-04).
    this._notifyStored('stored', record, 'STORED');
    return this.sanitizeStoredFile(record);
  }

  /**
   * ACL for a stored relay file: only the bound receiver, or a holder of that file's
   * download token, may fetch it. The host is deliberately not on this list.
   * @param {string} relayId
   * @param {number} fileIndex
   */
  getFileAcl(relayId, fileIndex) {
    const relay = this.relays.get(relayId) || this.recent.get(relayId) || null;
    const file = relay?.files.find((f) => f.index === Number(fileIndex)) || null;
    if (!relay || !file) return null;
    return {
      mode: 'receiver',
      relayId,
      receiverKeys: [...relay.receiver.keys],
      receiverTokenHash: file.receiverTokenHash || null,
    };
  }

  /** Stored relay files addressed to any of these keys. */
  listStoredFor(keys = []) {
    const list = [];
    for (const record of this.storedFiles.values()) {
      const relay = this.relays.get(record.relayId) || this.recent.get(record.relayId) || null;
      if (!relay || !this._matchesReceiver(relay, keys)) continue;
      list.push(this.sanitizeStoredFile(record));
    }
    return list.sort((a, b) => b.storedAt - a.storedAt);
  }

  /** Host-facing view: metadata only, never a download handle. */
  listStoredAll() {
    return Array.from(this.storedFiles.values())
      .map((record) => this.sanitizeStoredFile(record))
      .sort((a, b) => b.storedAt - a.storedAt);
  }

  /**
   * Host management view of everything in flight. The host carries the bytes and may
   * cancel, but it is not a party to the consent and has no download handle here.
   */
  listActive() {
    return {
      relays: Array.from(this.relays.values()).map((relay) => this.sanitize(relay)),
      stored: this.listStoredAll(),
    };
  }

  /**
   * @param {string} fileId
   * @returns {object|null} the internal record (with path-free public view)
   */
  getStoredFile(fileId) {
    return this.storedFiles.get(fileId) || null;
  }

  /** Records that a receiver completed a full download; the file stays until its TTL. */
  markDownloaded(fileId) {
    const record = this.storedFiles.get(fileId);
    if (!record || record.state === 'downloaded') return null;
    record.state = 'downloaded';
    record.downloadedAt = Date.now();
    this._notifyStored('downloaded', record, 'DOWNLOADED');
    return this.sanitizeStoredFile(record);
  }

  /** Host/emergency removal of one stored file. */
  revokeFile(fileId) {
    const record = this.storedFiles.get(fileId);
    if (!record) return false;
    this._expireStored(fileId, 'REVOKED');
    return true;
  }

  /** Host/emergency removal of everything a relay left behind. */
  revokeRelay(relayId) {
    const removed = this._discardStoredFor(relayId, 'REVOKED');
    const relay = this.relays.get(relayId);
    if (relay && relay.state === 'pending') {
      for (const file of relay.files) {
        if (file.decision === 'pending') file.decision = 'cancelled';
      }
      relay.state = 'cancelled';
      this._closeRelay(relay, 'cancelled');
    }
    return removed;
  }

  /**
   * Receiver-facing view. Never contains the download token, internal paths, or grants.
   * @param {object} relay
   */
  sanitize(relay) {
    return {
      relayId: relay.relayId,
      state: relay.state,
      createdAt: relay.createdAt,
      sender: relay.sender
        ? {
            connectionId: relay.sender.connectionId || null,
            label: relay.sender.label,
            labelUntrusted: true,
            platform: relay.sender.platform,
          }
        : null,
      receiver: {
        deviceId: relay.receiver?.deviceId || null,
        label: relay.receiver?.label,
        labelUntrusted: true,
        platform: relay.receiver?.platform,
      },
      files: relay.files.map((file) => ({
        index: file.index,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        checksum: file.checksum,
        decision: file.decision,
        fileId: file.fileId || null,
      })),
    };
  }

  /**
   * Receiver-facing view of a stored file. `hasToken` tells the client to append the
   * `?rt=` capability it kept from the decision response.
   * @param {object} record
   */
  sanitizeStoredFile(record) {
    const relay = this.relays.get(record.relayId) || this.recent.get(record.relayId) || null;
    return {
      fileId: record.fileId,
      relayId: record.relayId,
      fileIndex: record.fileIndex,
      name: record.name,
      size: record.size,
      mimeType: record.mimeType,
      state: record.state,
      storedAt: record.storedAt,
      expiresAt: record.expiresAt,
      hasToken: Boolean(relay?.files.find((f) => f.index === record.fileIndex)?.receiverTokenHash),
      sender: relay?.sender
        ? {
            label: relay.sender.label,
            labelUntrusted: true,
            platform: relay.sender.platform,
          }
        : null,
    };
  }

  // ---- grants (same contract as TransferOfferService, reused by the shared middleware) ----

  /** @param {string} grantId */
  hasGrant(grantId) {
    return this.grants.has(grantId);
  }

  /**
   * Validates a relay grant and takes it into `in_use`.
   * @param {string} grantId
   * @param {{ connectionId?: string|null, isSessionOwner?: (connectionId: string) => boolean }} [context]
   */
  beginGrant(grantId, context = {}) {
    if (typeof grantId !== 'string' || !grantId) {
      throw new AppError('TRANSFER_GRANT_REQUIRED', 428, 'Receiver approval is required first');
    }
    const grant = this.grants.get(grantId);
    if (!grant) {
      throw new AppError(
        'TRANSFER_GRANT_INVALID',
        403,
        'Transfer grant is unknown, expired or already used'
      );
    }
    if (Date.now() > grant.expiresAt) {
      this.grants.delete(grantId);
      throw new AppError('TRANSFER_GRANT_EXPIRED', 403, 'Transfer grant has expired');
    }
    if (grant.status === 'fulfilled') {
      throw new AppError('TRANSFER_GRANT_USED', 403, 'Transfer grant has already been used');
    }
    if (grant.status === 'in_use') {
      throw new AppError('TRANSFER_GRANT_BUSY', 409, 'Transfer grant is already in use');
    }
    if (grant.connectionId) {
      if (!context.connectionId) {
        throw new AppError(
          'TRANSFER_GRANT_INVALID',
          403,
          'Transfer grant requires verified connection ID'
        );
      }
      const matchConn = grant.connectionId === context.connectionId;
      const matchSessionConn =
        typeof context.isSessionOwner === 'function' && context.isSessionOwner(grant.connectionId);
      if (!matchConn && !matchSessionConn) {
        throw new AppError(
          'TRANSFER_GRANT_INVALID',
          403,
          'Transfer grant belongs to another connection'
        );
      }
    }

    grant.status = 'in_use';
    grant.inUseAt = Date.now();
    return grant;
  }

  /** @param {string} grantId */
  releaseGrant(grantId) {
    const grant = this.grants.get(grantId);
    if (grant && grant.status === 'in_use') {
      grant.status = 'issued';
      grant.inUseAt = null;
    }
  }

  /** @param {string} grantId */
  fulfillGrant(grantId) {
    const grant = this.grants.get(grantId);
    if (grant) {
      grant.status = 'fulfilled';
      grant.fulfilledAt = Date.now();
    }
  }

  /** @param {string} grantId */
  getGrant(grantId) {
    return this.grants.get(grantId) || null;
  }

  /** Drops grants past their TTL. Called by the periodic sweep. */
  sweepGrants() {
    const now = Date.now();
    let dropped = 0;
    for (const [grantId, grant] of this.grants) {
      if (now > grant.expiresAt) {
        this.grants.delete(grantId);
        dropped++;
      }
    }
    return dropped;
  }

  /** Releases every timer held by the instance. */
  cleanup() {
    for (const relay of this.relays.values()) {
      if (relay.timeoutId) clearTimeout(relay.timeoutId);
    }
    for (const record of this.storedFiles.values()) {
      if (record.timeoutId) clearTimeout(record.timeoutId);
    }
    this.relays.clear();
    this.recent.clear();
    this.grants.clear();
    this.storedFiles.clear();
  }

  // ---- internals ----

  /** @private */
  _issueGrant(relay, index) {
    const file = relay.files.find((f) => f.index === index);
    const grantId = generateId('gr_', 24);
    const grant = {
      grantId,
      relayId: relay.relayId,
      fileIndex: index,
      connectionId: relay.sender?.connectionId || null,
      receiverKeys: [...relay.receiver.keys],
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
      checksum: file.checksum,
      status: 'issued',
      createdAt: Date.now(),
      expiresAt: Date.now() + this.grantTtlMs,
    };
    this.grants.set(grantId, grant);
    return grant;
  }

  /** @private */
  _armOfferExpiry(relay) {
    relay.timeoutId = setTimeout(() => {
      if (relay.state !== 'pending') return;
      for (const file of relay.files) {
        if (file.decision === 'pending') file.decision = 'expired';
      }
      relay.state = 'expired';
      this._closeRelay(relay, 'expired');
      if (typeof this.onOfferExpire === 'function') {
        try {
          this.onOfferExpire({
            relayId: relay.relayId,
            sender: relay.sender,
            receiver: relay.receiver,
          });
        } catch (err) {
          logger.warn('Relay offer expiry observer failed', { error: err.message });
        }
      }
    }, relay.ttlMs);
    if (relay.timeoutId.unref) relay.timeoutId.unref();
  }

  /** @private */
  _closeRelay(relay, state) {
    if (relay.timeoutId) {
      clearTimeout(relay.timeoutId);
      relay.timeoutId = null;
    }
    relay.closedAt = Date.now();
    this.relays.delete(relay.relayId);
    this.recent.set(relay.relayId, { ...relay, state });
    while (this.recent.size > MAX_TRACKED_RELAYS) {
      const oldest = this.recent.keys().next().value;
      this.recent.delete(oldest);
    }
  }

  /** @private Deletes the stored file, releases its quota and reports the transition. */
  _expireStored(fileId, reason) {
    const record = this.storedFiles.get(fileId);
    if (!record) return false;
    if (record.timeoutId) {
      clearTimeout(record.timeoutId);
      record.timeoutId = null;
    }
    this.storedFiles.delete(fileId);
    record.state = reason === 'REVOKED' ? 'revoked' : 'expired';

    if (this.shareManager) {
      try {
        this.shareManager.removeFile(fileId);
      } catch (err) {
        logger.warn('Relay file could not be removed from staging', { error: err.message, fileId });
      }
    }
    if (this.quotaTracker && record.size > 0) {
      try {
        this.quotaTracker.release(record.size);
      } catch (err) {
        logger.warn('Relay file quota could not be released', { error: err.message, fileId });
      }
    }
    this._notifyStored(record.state, record, reason);
    return true;
  }

  /** @private */
  _discardStoredFor(relayId, reason) {
    let removed = 0;
    for (const record of [...this.storedFiles.values()]) {
      if (record.relayId !== relayId) continue;
      if (this._expireStored(record.fileId, reason)) removed++;
    }
    return removed;
  }

  /** @private */
  _notifyStored(state, record, reason) {
    if (typeof this.onStoredEvent !== 'function') return;
    const relay = this.relays.get(record.relayId) || this.recent.get(record.relayId) || null;
    try {
      this.onStoredEvent({
        state,
        reason,
        relayId: record.relayId,
        fileIndex: record.fileIndex,
        fileId: record.fileId,
        fileName: record.name,
        size: record.size,
        sender: relay?.sender || null,
        receiver: relay?.receiver || null,
      });
    } catch (err) {
      logger.warn('Relay stored-file observer failed', { error: err.message });
    }
  }

  /** @private */
  _matchesReceiver(relay, keys = []) {
    if (!Array.isArray(keys) || keys.length === 0) return false;
    const wanted = new Set(relay.receiver?.keys || []);
    return keys.some((key) => wanted.has(key));
  }

  /** @private */
  _matchesSender(relay, actor = {}) {
    if (actor.connectionId && relay.sender?.connectionId === actor.connectionId) return true;
    const wanted = new Set(actor.keys || []);
    if (wanted.size === 0) return false;
    // The sender's own socket keys were captured on the offer; a reconnect re-derives them.
    return relay.sender?.keys ? relay.sender.keys.some((key) => wanted.has(key)) : false;
  }
}
