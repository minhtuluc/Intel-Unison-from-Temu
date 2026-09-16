/**
 * Transfer grant gate (UT-012).
 *
 * Sits in front of every route that can write payload to disk, so an upload is
 * refused *before* bytes move unless the host already approved that exact file.
 * Multer writes during multipart parsing, which is why the grant travels in a
 * header (X-Transfer-Grant) rather than a body field: a body field would only be
 * readable after the payload had already landed.
 *
 * A request may carry several comma-separated grants, one per file, because the
 * simple-upload endpoint accepts a batch. Each grant is bound to one approved
 * (name, size) pair and can be spent exactly once.
 */

import path from 'node:path';
import { AppError } from './error-handler.js';
import { extractSessionToken } from './session-auth.js';
import { sanitizeFileName } from '../utils/file-utils.js';
import { resolveSender } from '../utils/connection-identity.js';

export const GRANT_HEADER = 'x-transfer-grant';

/**
 * Compares names the way they reach disk, so a hostile `../../evil.js` and a plain
 * `evil.js` are recognized as the same file rather than slipping past the check.
 * @param {unknown} name
 */
function normalizeName(name) {
  const flat = String(name ?? '').replace(/\\/g, '/');
  return sanitizeFileName(path.basename(flat));
}

/** Mirrors the per-offer file cap; guards against absurd header sizes. */
const MAX_GRANTS_PER_REQUEST = 50;

/**
 * True when the request carries verified host authority. The host consents with
 * itself, so host-originated uploads need no grant. This is a real capability
 * check, not the client-declared `isHost` flag.
 * @param {import('express').Request} req
 */
function isHostRequest(req) {
  const hostAuth = req.app.locals.hostAuth || req.app.locals.runtime?.hostAuth;
  if (!hostAuth) return false;
  return Boolean(hostAuth.verify(req, req.headers['x-host-token']));
}

/**
 * @param {{ required?: boolean }} [options]
 * @returns {import('express').RequestHandler}
 */
export function requireTransferGrant({ required = true } = {}) {
  return function transferGrantGate(req, res, next) {
    if (isHostRequest(req)) {
      req.transferGrantBypassed = true;
      return next();
    }

    const rawHeader = req.headers[GRANT_HEADER];
    const grantIds = Array.isArray(rawHeader)
      ? rawHeader.flatMap((value) => String(value).split(','))
      : String(rawHeader ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);

    if (grantIds.length === 0) {
      if (!required) return next();
      return next(
        new AppError(
          'TRANSFER_GRANT_REQUIRED',
          428,
          'Host approval is required before uploading. Request a transfer offer first.'
        )
      );
    }
    if (grantIds.length > MAX_GRANTS_PER_REQUEST) {
      return next(
        new AppError(
          'TOO_MANY_GRANTS',
          400,
          `At most ${MAX_GRANTS_PER_REQUEST} grants may be spent in one request`
        )
      );
    }

    const offerService = req.app.locals.runtime?.offerService;
    if (!offerService) {
      return next(new AppError('TRANSFER_GRANT_UNAVAILABLE', 500, 'Transfer consent unavailable'));
    }

    // Verify sender attribution and session binding (M3-QC-01)
    let connectionId = null;
    try {
      const sender = resolveSender(req);
      connectionId = sender.connectionId;
    } catch (err) {
      return next(err);
    }

    const sessions = req.app.locals.sessions || req.app.locals.runtime?.sessions;
    const reqToken = extractSessionToken(req);

    const grants = [];
    try {
      for (const grantId of grantIds) {
        grants.push(
          offerService.beginGrant(grantId, {
            connectionId,
            isSessionOwner: (grantConnId) =>
              Boolean(reqToken && sessions?.hasConnection?.(reqToken, grantConnId)),
          })
        );
      }
    } catch (err) {
      // Do not leave the already-claimed grants stuck in `in_use`.
      for (const grant of grants) offerService.releaseGrant(grant.grantId);
      return next(err);
    }

    req.transferGrants = grants;

    let settled = false;
    const settle = (fulfilled) => {
      if (settled) return;
      settled = true;
      for (const grant of grants) {
        if (fulfilled) offerService.fulfillGrant(grant.grantId);
        else offerService.releaseGrant(grant.grantId);
      }
    };

    res.on('finish', () => {
      // 4xx/5xx means the attempt did not land; hand the grants back for a retry.
      settle(res.statusCode < 400);
    });
    res.on('close', () => {
      if (!res.writableEnded) settle(false);
    });

    next();
  };
}

/**
 * Binds the files Multer actually parsed or chunked init declared to the grants the host
 * approved. The gate runs before parsing/session creation, so this check is what ties
 * consent to real bytes: name, size and checksum must match what was approved (M3-QC-02).
 * @param {import('express').Request} req
 * @param {Array<{originalname?: string, fileName?: string, name?: string, size?: number, fileSize?: number, checksum?: string}>} files
 * @throws {AppError}
 */
export function assertGrantsMatchFiles(req, files) {
  const grants = req.transferGrants;
  if (!grants || grants.length === 0) return;

  if (!Array.isArray(files) || files.length === 0) {
    throw new AppError('NO_FILES_UPLOADED', 400, 'No files provided in upload');
  }
  if (files.length !== grants.length) {
    throw new AppError(
      'GRANT_FILE_COUNT_MISMATCH',
      403,
      `Request carries ${files.length} file(s) but ${grants.length} were approved`
    );
  }

  // Match on the approved identity rather than position, so multipart ordering
  // cannot be used to smuggle a different file past the host's decision.
  const unmatched = [...grants];
  for (const file of files) {
    const fileName = file.originalname || file.fileName || file.name;
    const fileSize = Number(file.size ?? file.fileSize);
    const checksum = file.checksum;

    const index = unmatched.findIndex((grant) => {
      if (grant.size !== fileSize) return false;
      if (!fileName || normalizeName(grant.name) !== normalizeName(fileName)) return false;
      if (grant.checksum) {
        if (!checksum || String(checksum).toLowerCase() !== String(grant.checksum).toLowerCase()) {
          return false;
        }
      }
      return true;
    });
    if (index === -1) {
      throw new AppError(
        'GRANT_MISMATCH',
        403,
        `File "${fileName || 'unnamed'}" (${fileSize} bytes) does not match approved metadata`
      );
    }
    unmatched.splice(index, 1);
  }
}
