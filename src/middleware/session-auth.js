/**
 * Session capability — issued by /api/auth when a PIN is configured.
 * Tokens are random, expiring and revocable; they are never derived from client data.
 */

import { randomBytes } from 'node:crypto';
import { AppError } from './error-handler.js';

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 64;
export const SESSION_COOKIE = 'utrans_session';

/**
 * Builds the session cookie. HttpOnly + SameSite=Strict: the cookie is not readable
 * by scripts and never travels on cross-site requests. Secure is not set because the
 * app is served over plain HTTP on the LAN.
 * @param {string} token
 * @param {number} maxAgeSeconds
 */
export function buildSessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function buildClearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/**
 * Reads the session cookie without pulling in a cookie-parser dependency.
 * Exported so the WebSocket upgrade path can use the same transport as browsers.
 */
export function extractSessionCookie(req) {
  return readCookie(req, SESSION_COOKIE);
}

function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (typeof header !== 'string' || header.length === 0) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/**
 * Creates an in-memory session store. Restarting the process invalidates every session.
 * @param {{ ttlMs?: number, maxSessions?: number, now?: () => number }} [options]
 */
export function createSessionStore({
  ttlMs = DEFAULT_TTL_MS,
  maxSessions = DEFAULT_MAX_SESSIONS,
  now = Date.now,
} = {}) {
  /** @type {Map<string, {token: string, ip: string, createdAt: number, expiresAt: number}>} */
  const sessions = new Map();

  function sweep() {
    const current = now();
    let removed = 0;
    for (const [token, session] of sessions) {
      if (session.expiresAt <= current) {
        sessions.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  function issue(ip = 'unknown') {
    sweep();
    while (sessions.size >= maxSessions) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (!oldest) break;
      sessions.delete(oldest[0]);
    }

    const createdAt = now();
    const session = {
      token: randomBytes(32).toString('hex'),
      ip,
      createdAt,
      expiresAt: createdAt + ttlMs,
    };
    sessions.set(session.token, session);

    return { token: session.token, expiresAt: new Date(session.expiresAt).toISOString(), ttlMs };
  }

  function verify(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= now()) {
      sessions.delete(token);
      return null;
    }
    return { ...session };
  }

  function revoke(token) {
    if (typeof token !== 'string') return false;
    return sessions.delete(token);
  }

  function revokeAll() {
    const count = sessions.size;
    sessions.clear();
    return count;
  }

  return { issue, verify, revoke, revokeAll, sweep, size: () => sessions.size };
}

/**
 * Reads a session token from X-Session-Token, the session cookie, or an
 * Authorization: Bearer header.
 * @param {import('express').Request} req
 * @returns {string|undefined}
 */
export function extractSessionToken(req) {
  const header = req.headers['x-session-token'];
  if (typeof header === 'string' && header.length > 0) return header;

  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie) return cookie;

  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim();
  }

  return undefined;
}

/**
 * Gates a router when a PIN is configured. Host capability always passes so the
 * host can never lock itself out; without a PIN the LAN behaviour is unchanged.
 */
export function requireSession(req, _res, next) {
  const locals = req.app.locals;
  const pinRequired = locals.pinRequired ?? locals.runtime?.pinRequired ?? false;
  if (!pinRequired) return next();

  if (locals.hostAuth?.verify(req, req.headers['x-host-token'])) return next();

  const sessions = locals.sessions ?? locals.runtime?.sessions;
  if (sessions?.verify(extractSessionToken(req))) return next();

  next(new AppError('UNAUTHORIZED', 401, 'A valid PIN session is required'));
}
