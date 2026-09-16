/**
 * Transfer offers — host consent *before* any payload moves (UT-012).
 *
 * An offer is metadata only: name, size, mime type and checksum for each file in a
 * batch. Nothing here touches disk. The host reviews the batch and approves or
 * rejects each file individually; every approved file yields a single-use grant, and
 * a grant is the only thing that opens the upload write path.
 */

import { AppError } from '../middleware/error-handler.js';
import { generateId } from '../utils/id-generator.js';

/** Offers are held for the host to act on, then kept briefly so a reconnecting
 *  sender can still read the decision. Bounded to keep memory flat. */
const MAX_TRACKED_OFFERS = 200;

/** A single batch should stay reviewable for a human; more than this is a bulk dump. */
export const MAX_FILES_PER_OFFER = 50;

const CHECKSUM_RE = /^[a-fA-F0-9]{64}$/;

/** @param {unknown} value */
function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * Validates and normalizes the batch manifest supplied by the sender.
 * @param {unknown} files
 * @returns {Array<{name: string, size: number, mimeType: string, checksum: string|null}>}
 */
export function validateOfferFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new AppError('INVALID_INPUT', 400, 'files must be a non-empty array');
  }
  if (files.length > MAX_FILES_PER_OFFER) {
    throw new AppError(
      'TOO_MANY_FILES',
      400,
      `A single offer may contain at most ${MAX_FILES_PER_OFFER} files`
    );
  }

  return files.map((file, index) => {
    if (!file || typeof file !== 'object') {
      throw new AppError('INVALID_INPUT', 400, `files[${index}] must be an object`);
    }
    const name = typeof file.name === 'string' ? file.name.trim() : '';
    if (!name || name.includes('\0')) {
      throw new AppError('INVALID_INPUT', 400, `files[${index}].name is required`);
    }
    if (!isPositiveInteger(file.size)) {
      throw new AppError(
        'INVALID_INPUT',
        400,
        `files[${index}].size must be a positive integer (empty files cannot be offered)`
      );
    }
    if (file.checksum !== undefined && file.checksum !== null && file.checksum !== '') {
      if (typeof file.checksum !== 'string' || !CHECKSUM_RE.test(file.checksum)) {
        throw new AppError(
          'INVALID_CHECKSUM',
          400,
          `files[${index}].checksum must be 64 hex chars`
        );
      }
    }
    return {
      name,
      size: file.size,
      mimeType: typeof file.mimeType === 'string' && file.mimeType ? file.mimeType : null,
      checksum: file.checksum ? String(file.checksum).toLowerCase() : null,
    };
  });
}

export class TransferOfferService {
  /**
   * @param {{ config: object, onExpire?: Function }} options
   */
  constructor({ config, onExpire = null }) {
    this.config = config;
    this.onExpire = onExpire;
    /** @type {Map<string, object>} */
    this.offers = new Map();
    /** @type {Map<string, object>} */
    this.grants = new Map();
    /** Terminal offers kept for readback; insertion order gives FIFO eviction. */
    this.recent = new Map();
  }

  /** Grants must outlive the transfer they authorize, so they track uploadExpiry. */
  get grantTtlMs() {
    const configured = Number(this.config?.uploadExpiry);
    return Number.isFinite(configured) && configured > 0 ? configured : 60 * 60 * 1000;
  }

  get offerTtlMs() {
    const configured = Number(this.config?.offerTtlMs);
    return Number.isFinite(configured) && configured > 0 ? configured : 2 * 60 * 1000;
  }

  /**
   * Registers a batch awaiting host consent.
   * @param {{ files: object[], sender: object, trusted?: boolean }} input
   * @returns {{ offer: object, grants: object[], autoApproved: boolean }}
   */
  createOffer({ files, sender, trusted = false }) {
    const normalized = validateOfferFiles(files);
    const offerId = generateId('of_');

    const offer = {
      offerId,
      state: 'pending',
      files: normalized.map((file, index) => ({
        index,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        checksum: file.checksum,
        decision: 'pending',
      })),
      sender,
      trusted: Boolean(trusted),
      createdAt: Date.now(),
      ttlMs: this.offerTtlMs,
      timeoutId: null,
    };

    this.offers.set(offerId, offer);
    this._armExpiry(offer);

    // A remembered device is consent that already happened; still recorded, never silent.
    const grants = trusted
      ? this._applyDecisions(
          offer,
          offer.files.map((f) => f.index)
        )
      : [];
    return { offer, grants, autoApproved: Boolean(trusted) };
  }

  /**
   * @param {string} offerId
   * @returns {object|null}
   */
  getOffer(offerId) {
    return this.offers.get(offerId) || this.recent.get(offerId) || null;
  }

  /** Offers still waiting on a host decision, for reconnect re-sync. */
  listPending() {
    const list = [];
    for (const offer of this.offers.values()) {
      if (offer.state === 'pending') list.push(this.sanitize(offer));
    }
    return list;
  }

  /**
   * Applies host decisions. Files not mentioned keep their current decision, so a
   * host may approve a subset now and revisit the rest while the offer is open.
   * @param {string} offerId
   * @param {Array<{index: number, action: 'approve'|'reject'}>} decisions
   * @returns {{ offer: object, grants: object[] }}
   */
  decide(offerId, decisions) {
    // Reads through getOffer so a host acting on an already-closed offer gets a
    // precise "closed" answer instead of a misleading "not found".
    const offer = this.getOffer(offerId);
    if (!offer) {
      throw new AppError('OFFER_NOT_FOUND', 404, `Offer ${offerId} not found`);
    }
    if (offer.state !== 'pending') {
      throw new AppError('OFFER_CLOSED', 409, `Offer ${offerId} is ${offer.state}`);
    }
    if (!Array.isArray(decisions) || decisions.length === 0) {
      throw new AppError('INVALID_INPUT', 400, 'decisions must be a non-empty array');
    }
    // Atomic validation across all entries before mutating any state (M3-QC-04)
    const seenIndices = new Set();
    const planned = [];

    for (const decision of decisions) {
      const index = Number(decision?.index);
      if (!Number.isInteger(index) || index < 0) {
        throw new AppError('INVALID_INPUT', 400, `Invalid file index: ${decision?.index}`);
      }
      if (seenIndices.has(index)) {
        throw new AppError('INVALID_INPUT', 400, `Duplicate index ${index} in decisions batch`);
      }
      seenIndices.add(index);

      const target = offer.files.find((f) => f.index === index);
      if (!target) {
        throw new AppError(
          'INVALID_INPUT',
          400,
          `decisions index ${decision?.index} is not in offer`
        );
      }
      const action = decision?.action;
      if (action !== 'approve' && action !== 'reject') {
        throw new AppError('INVALID_INPUT', 400, 'action must be "approve" or "reject"');
      }
      if (target.decision !== 'pending') {
        throw new AppError(
          'OFFER_CONFLICT',
          409,
          `File index ${index} has already been decided (${target.decision})`
        );
      }
      planned.push({ target, action, index });
    }

    // Apply mutations only after all checks have succeeded
    const approvals = [];
    for (const { target, action, index } of planned) {
      target.decision = action === 'approve' ? 'approved' : 'rejected';
      if (action === 'approve') approvals.push(index);
    }

    const grants = this._applyDecisions(offer, approvals);
    return { offer, grants };
  }

  /**
   * Issues grants for approved files and closes the offer once every file is decided.
   * @private
   */
  _applyDecisions(offer, approvedIndexes) {
    const grants = approvedIndexes.map((index) => {
      // The decision must be recorded here, not only in decide(): a trusted device
      // reaches this path without one, and an unrecorded approval would leave the
      // offer looking pending to the host forever.
      const file = offer.files.find((f) => f.index === index);
      if (file) file.decision = 'approved';
      return this._issueGrant(offer, index);
    });
    if (offer.files.every((file) => file.decision !== 'pending')) {
      offer.state = 'decided';
      this._closeOffer(offer, 'decided');
    }
    return grants;
  }

  /** @private */
  _issueGrant(offer, index) {
    // Ensure at most one grant per (offerId, fileIndex) (M3-QC-04)
    for (const existing of this.grants.values()) {
      if (existing.offerId === offer.offerId && existing.fileIndex === index) {
        return existing;
      }
    }
    const file = offer.files.find((f) => f.index === index);
    const grantId = generateId('gr_', 24);
    const grant = {
      grantId,
      offerId: offer.offerId,
      fileIndex: index,
      connectionId: offer.sender?.connectionId || null,
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
      checksum: file.checksum,
      status: 'issued', // issued -> in_use -> fulfilled
      createdAt: Date.now(),
      expiresAt: Date.now() + this.grantTtlMs,
    };
    this.grants.set(grantId, grant);
    return grant;
  }

  /**
   * Validates a grant and takes it into `in_use` so two concurrent requests cannot
   * both spend it. Callers must release() on failure or fulfil() on success.
   * @param {string} grantId
   * @param {{ connectionId?: string|null }} [context]
   * @returns {object}
   */
  beginGrant(grantId, context = {}) {
    if (typeof grantId !== 'string' || !grantId) {
      throw new AppError(
        'TRANSFER_GRANT_REQUIRED',
        428,
        'Host approval is required before uploading. Request a transfer offer first.'
      );
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
    // A grant authorizes one connection only; a stolen id or missing connection is useless elsewhere (M3-QC-01)
    if (grant.connectionId) {
      const matchConn = Boolean(
        context.connectionId && grant.connectionId === context.connectionId
      );
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

  /** Returns a grant to `issued` after a failed attempt so the sender can retry. */
  releaseGrant(grantId) {
    const grant = this.grants.get(grantId);
    if (grant && grant.status === 'in_use') {
      grant.status = 'issued';
      grant.inUseAt = null;
    }
  }

  /** Marks a grant permanently spent after a successful upload or session init. */
  fulfillGrant(grantId) {
    const grant = this.grants.get(grantId);
    if (grant) {
      grant.status = 'fulfilled';
      grant.fulfilledAt = Date.now();
    }
  }

  /**
   * @param {string} grantId
   * @returns {object|null}
   */
  getGrant(grantId) {
    return this.grants.get(grantId) || null;
  }

  /**
   * Grants issued for an offer, so a sender that missed the WebSocket decision can
   * still collect what it was allowed to upload.
   * @param {string} offerId
   * @returns {Array<{index: number, grantId: string, name: string, size: number, status: string}>}
   */
  getGrantsForOffer(offerId) {
    const list = [];
    for (const grant of this.grants.values()) {
      if (grant.offerId !== offerId) continue;
      list.push({
        index: grant.fileIndex,
        grantId: grant.grantId,
        name: grant.name,
        size: grant.size,
        status: grant.status,
      });
    }
    return list.sort((a, b) => a.index - b.index);
  }

  /**
   * Sender abandons the batch before the host acts.
   * @param {string} offerId
   * @param {{ connectionId?: string|null }} [context]
   */
  cancelOffer(offerId, context = {}) {
    const offer = this.offers.get(offerId);
    if (!offer) {
      throw new AppError('OFFER_NOT_FOUND', 404, `Offer ${offerId} not found`);
    }
    if (!context.isHost && offer.sender?.connectionId) {
      const matchConn = Boolean(
        context.connectionId && offer.sender.connectionId === context.connectionId
      );
      const matchSession = Boolean(
        context.sessionToken &&
        offer.sender.sessionToken &&
        context.sessionToken === offer.sender.sessionToken
      );
      const matchSessionConn =
        typeof context.isSessionOwner === 'function' &&
        context.isSessionOwner(offer.sender.connectionId);

      if (!matchConn && !matchSession && !matchSessionConn) {
        throw new AppError('OFFER_FORBIDDEN', 403, 'Offer belongs to another connection');
      }
    }
    for (const file of offer.files) {
      if (file.decision === 'pending') file.decision = 'cancelled';
    }
    offer.state = 'cancelled';
    this._closeOffer(offer, 'cancelled');
    return this.sanitize(offer);
  }

  /** @private */
  _armExpiry(offer) {
    offer.timeoutId = setTimeout(() => {
      if (offer.state !== 'pending') return;
      for (const file of offer.files) {
        if (file.decision === 'pending') file.decision = 'expired';
      }
      offer.state = 'expired';
      this._closeOffer(offer, 'expired');
      if (typeof this.onExpire === 'function') {
        try {
          this.onExpire({ offerId: offer.offerId, sender: offer.sender });
        } catch {
          // A failing observer must not take the timer callback down with it.
        }
      }
    }, offer.ttlMs);
    if (offer.timeoutId.unref) offer.timeoutId.unref();
  }

  /** @private Clears the timer and moves the offer into the bounded readback window. */
  _closeOffer(offer, state) {
    if (offer.timeoutId) {
      clearTimeout(offer.timeoutId);
      offer.timeoutId = null;
    }
    offer.closedAt = Date.now();
    this.offers.delete(offer.offerId);
    this.recent.set(offer.offerId, { ...offer, state });

    while (this.recent.size > MAX_TRACKED_OFFERS) {
      const oldest = this.recent.keys().next().value;
      this.recent.delete(oldest);
    }
    // Grants for the closed offer stay valid until their own TTL, so a decided
    // batch can still be uploaded after the host closes the dialog.
  }

  /**
   * Drops grants past their TTL. Called by the periodic sweep.
   * @returns {number} number of grants dropped
   */
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

  /** Releases timers held by the instance. */
  cleanup() {
    for (const offer of this.offers.values()) {
      if (offer.timeoutId) clearTimeout(offer.timeoutId);
    }
    this.offers.clear();
    this.grants.clear();
    this.recent.clear();
  }

  /**
   * Host-facing view. Sender labels stay explicitly untrusted; no paths exist here.
   * @param {object} offer
   */
  sanitize(offer) {
    return {
      offerId: offer.offerId,
      state: offer.state,
      trusted: offer.trusted,
      createdAt: offer.createdAt,
      sender: offer.sender
        ? {
            connectionId: offer.sender.connectionId || null,
            label: offer.sender.label,
            labelUntrusted: true,
            platform: offer.sender.platform,
          }
        : null,
      files: offer.files.map((file) => ({
        index: file.index,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        checksum: file.checksum,
        decision: file.decision,
      })),
    };
  }
}
