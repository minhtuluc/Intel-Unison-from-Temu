/**
 * Download authorization (UT-022).
 *
 * Public staged files stay readable by any authenticated client, exactly as before. A
 * relayed file is different: it was addressed to one receiver, so only that receiver may
 * fetch it. The host is deliberately *not* on the list — it carries the bytes but is not
 * a party to the transfer, and M4 exists precisely to keep those roles apart.
 *
 * Two proofs are accepted:
 *   1. an identity key the caller can verify (a PIN session, or its device token), or
 *   2. the single-use download capability handed to the receiver when it accepted.
 * Proof 2 exists because `<a download>` and `<img src>` cannot carry custom headers, and
 * without a PIN there is no session cookie to fall back on.
 */

import { AppError } from './error-handler.js';
import { identityKeysFromRequest, intersects } from '../utils/client-identity.js';
import { relayTokenMatches } from '../services/relay-transfer.js';

/**
 * @param {import('express').Request} req
 * @param {object} record internal share-manager record
 * @returns {boolean}
 */
export function authorizeDownload(req, record) {
  const acl = record?.acl;
  if (!acl || acl.mode !== 'receiver') return true;

  const presented = req.query?.rt ?? req.headers['x-relay-token'];
  if (relayTokenMatches(presented, acl.receiverTokenHash)) return true;

  const { keys } = identityKeysFromRequest(req);
  return intersects(keys, acl.receiverKeys || []);
}

/**
 * @param {import('express').Request} req
 * @param {object} record
 * @throws {AppError} 403 when the caller is not the addressed receiver
 */
export function assertDownloadAllowed(req, record) {
  if (authorizeDownload(req, record)) return;
  throw new AppError('DOWNLOAD_FORBIDDEN', 403, 'This file was sent to another receiver');
}
