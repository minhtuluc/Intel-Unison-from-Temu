/**
 * Client identity keys (UT-020).
 *
 * A client is never identified by something it merely claims. These keys are derived
 * only from credentials the server can verify:
 *
 *   conn:<connectionId>        the live socket this request maps to (weak: dies on reconnect)
 *   dev:<sha256(deviceToken)>  a token the client holds locally (survives reconnect and tab reload)
 *   sess:<sessionToken>        a verified PIN session (only when a PIN is configured)
 *
 * Relay transfers bind their receiver by this key set, so a device that reconnects and
 * still presents the same device token is still recognized as the same receiver. The raw
 * device token never leaves the client: only its SHA-256 hash is used, and only in RAM.
 */

import { extractSessionToken } from '../middleware/session-auth.js';
import { hashDeviceToken } from '../services/trusted-devices.js';

/** Same token shape trusted devices accept, so one token means one device everywhere. */
export const DEVICE_TOKEN_RE = /^[a-f0-9]{64}$/i;

/**
 * Builds the durable identity key for a device token, or null when the token is absent
 * or malformed. A malformed token must never collapse into a shared key.
 *
 * Hex tokens are case-insensitive elsewhere in the system (see trusted-devices.js), so
 * the token is lower-cased before hashing: `AB..` and `ab..` must not become two
 * different devices for the same phone.
 * @param {unknown} rawToken
 * @returns {string|null}
 */
export function deviceTokenKey(rawToken) {
  if (typeof rawToken !== 'string' || !DEVICE_TOKEN_RE.test(rawToken)) return null;
  return `dev:${hashDeviceToken(rawToken.toLowerCase())}`;
}

/**
 * Identity keys a WebSocket connection is known by. Called after `client:register`,
 * once the session has been verified and the device token read from the payload.
 * @param {{ connectionId?: string|null, sessionToken?: string|null, deviceToken?: string|null }} input
 * @returns {string[]}
 */
export function identityKeysForSocket({
  connectionId = null,
  sessionToken = null,
  deviceToken = null,
} = {}) {
  const keys = [];
  if (connectionId) keys.push(`conn:${connectionId}`);

  const deviceKey = deviceTokenKey(deviceToken);
  if (deviceKey) keys.push(deviceKey);

  if (sessionToken) keys.push(`sess:${sessionToken}`);
  return keys;
}

/**
 * Identity keys for an HTTP request. Only verified material contributes a key: the
 * session token must resolve in the session store, and the device token must be
 * well-formed. `X-Connection-Id` deliberately contributes nothing — accepting it here
 * would let one client borrow another socket's identity.
 * @param {import('express').Request} req
 * @returns {{ keys: string[], sessionToken: string|null, deviceTokenHash: string|null }}
 */
export function identityKeysFromRequest(req) {
  const keys = [];

  const sessions = req.app.locals?.sessions ?? req.app.locals?.runtime?.sessions;
  const candidate = extractSessionToken(req);
  const session = candidate && sessions?.verify ? sessions.verify(candidate) : null;
  if (session) keys.push(`sess:${session.token}`);

  const deviceKey = deviceTokenKey(req.headers?.['x-device-token']);
  if (deviceKey) keys.push(deviceKey);

  return {
    keys,
    sessionToken: session ? session.token : null,
    deviceTokenHash: deviceKey ? deviceKey.slice('dev:'.length) : null,
  };
}

/**
 * True when the two key sets share at least one key.
 * @param {Iterable<string>} a
 * @param {Iterable<string>} b
 */
export function intersects(a, b) {
  if (!a || !b) return false;
  const set = new Set(a);
  for (const key of b) {
    if (set.has(key)) return true;
  }
  return false;
}
