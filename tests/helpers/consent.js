/**
 * Test helper for the UT-012 pre-transfer consent handshake.
 *
 * This deliberately performs the real HTTP exchange rather than stubbing the gate.
 * The whole point of these tests is to prove the host gates the write path, so any
 * shortcut that skipped the handshake would make them prove nothing about it.
 */

import assert from 'node:assert/strict';

/**
 * @param {Buffer|string} data
 * @returns {number}
 */
export function payloadSize(data) {
  return Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
}

/** @param {object} [auth] */
function jsonHeaders({ hostToken, sessionToken, connectionId, deviceToken } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (hostToken) headers['X-Host-Token'] = hostToken;
  if (sessionToken) headers['X-Session-Token'] = sessionToken;
  if (connectionId) headers['X-Connection-Id'] = connectionId;
  if (deviceToken) headers['X-Device-Token'] = deviceToken;
  return headers;
}

/**
 * Opens an offer without deciding it — for tests about the gate itself.
 * @param {string} base
 * @param {Array<{name: string, size: number, mimeType?: string, checksum?: string}>} files
 * @param {object} [auth]
 */
export async function requestOffer(base, files, auth = {}) {
  const res = await fetch(`${base}/api/transfer/offer`, {
    method: 'POST',
    headers: jsonHeaders(auth),
    body: JSON.stringify({ files }),
  });
  const body = await res.json();
  return { res, body };
}

/**
 * Has the host decide an open offer.
 * @param {string} base
 * @param {{offerId: string, decisions: Array<{index: number, action: string}>, hostToken?: string, trustDevice?: boolean}} input
 */
export async function decideOffer(base, { offerId, decisions, hostToken, trustDevice = false }) {
  const res = await fetch(`${base}/api/transfer/offer/decision`, {
    method: 'POST',
    headers: jsonHeaders({ hostToken }),
    body: JSON.stringify({ offerId, decisions, trustDevice }),
  });
  const body = await res.json();
  return { res, body };
}

/**
 * Runs offer → host decision for a batch and returns the grants to spend.
 * @param {string} base
 * @param {{files: Array<{name: string, size: number, mimeType?: string, checksum?: string}>, approve?: 'all'|number[], trustDevice?: boolean} & object} input
 * @returns {Promise<{offerId: string, decisions: object[], grantIds: string[], grantHeader: string}>}
 */
export async function offerBatch(base, { files, approve = 'all', trustDevice = false, ...auth }) {
  const { res: offerRes, body: offerBody } = await requestOffer(base, files, auth);
  assert.equal(offerRes.status, 201, `offer request failed: ${JSON.stringify(offerBody)}`);

  const { offer, autoApproved, decisions: initialDecisions } = offerBody.data;
  let decisions = initialDecisions;

  if (!autoApproved) {
    const wanted = initialDecisions.map((decision) => ({
      index: decision.index,
      action:
        approve === 'all' || (Array.isArray(approve) && approve.includes(decision.index))
          ? 'approve'
          : 'reject',
    }));
    const { res: decisionRes, body: decisionBody } = await decideOffer(base, {
      offerId: offer.offerId,
      decisions: wanted,
      hostToken: auth.hostToken,
      trustDevice,
    });
    assert.equal(decisionRes.status, 200, `decision failed: ${JSON.stringify(decisionBody)}`);
    decisions = decisionBody.data.decisions;
  }

  const grantIds = decisions.filter((decision) => decision.grantId).map((d) => d.grantId);
  return {
    offerId: offer.offerId,
    decisions,
    grantIds,
    grantHeader: grantIds.join(','),
  };
}

/**
 * Common case: one approved file, returns the header value ready to send.
 * @param {string} base
 * @param {{name: string, data: Buffer|string, mimeType?: string, checksum?: string} & object} input
 * @returns {Promise<string>}
 */
export async function approveUpload(base, { name, data, mimeType, checksum, ...auth }) {
  const { grantHeader } = await offerBatch(base, {
    files: [{ name, size: payloadSize(data), mimeType, checksum }],
    ...auth,
  });
  return grantHeader;
}

/**
 * Same as approveUpload for a batch, preserving the order of the input list so the
 * returned grants line up with the files a caller is about to send.
 * @param {string} base
 * @param {Array<{name: string, data: Buffer|string, mimeType?: string, checksum?: string}>} files
 * @param {object} [options]
 * @returns {Promise<{grantHeader: string, grantIds: string[], decisions: object[], offerId: string}>}
 */
export async function approveUploads(base, files, options = {}) {
  return await offerBatch(base, {
    files: files.map((file) => ({
      name: file.name,
      size: payloadSize(file.data),
      mimeType: file.mimeType,
      checksum: file.checksum,
    })),
    ...options,
  });
}

/**
 * Headers for a multipart upload that spends the given grants.
 * @param {string} grantHeader
 * @param {object} [extra]
 */
export function grantHeaders(grantHeader, extra = {}) {
  return { 'X-Transfer-Grant': grantHeader, ...extra };
}
