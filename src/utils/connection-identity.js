/**
 * Connection and Sender Identity Verification
 *
 * Enforces server-side binding between HTTP requests, session tokens,
 * and active WebSocket connections. Client-declared headers (like X-Connection-Id,
 * X-Device-Name) are untrusted unless verified against server-observed state.
 */

import { AppError } from '../middleware/error-handler.js';
import { extractSessionToken } from '../middleware/session-auth.js';

/**
 * Resolves all connection IDs registered under the caller's session.
 * @param {import('express').Request} req
 * @returns {string[]}
 */
export function getSessionConnectionIds(req) {
  const wss = req.app.get('wss') || req.app.locals.runtime?.wss;
  const sessions = req.app.locals.sessions || req.app.locals.runtime?.sessions;
  const isPinRequired = req.app.locals.pinRequired ?? req.app.locals.runtime?.pinRequired ?? false;
  const reqToken = extractSessionToken(req);
  const rawReqIp = req.ip || req.socket?.remoteAddress || 'unknown';
  const cleanReqIp = rawReqIp.replace(/^::ffff:/, '');

  const matched = new Set();

  if (reqToken && sessions?.getConnections) {
    for (const id of sessions.getConnections(reqToken)) {
      matched.add(id);
    }
  }

  if (wss && wss.clients) {
    for (const client of wss.clients) {
      if (!client.connectionId) continue;
      if (isPinRequired || client.sessionToken || reqToken) {
        if (reqToken && client.sessionToken === reqToken) {
          matched.add(client.connectionId);
        }
      } else {
        // PIN disabled and no session tokens: match by IP
        const clientIp = (client._remoteIp || '').replace(/^::ffff:/, '');
        if (clientIp && cleanReqIp && cleanReqIp !== 'unknown' && clientIp === cleanReqIp) {
          matched.add(client.connectionId);
        }
      }
    }
  }
  return Array.from(matched);
}

/**
 * Resolves and strictly validates sender attribution from request headers/body against
 * observed connection state and session capability.
 *
 * @param {import('express').Request} req
 * @param {{ required?: boolean }} [options]
 * @returns {{ connectionId: string|null, ip: string, label: string, labelUntrusted: boolean, platform: string, isHost: boolean }}
 * @throws {AppError} 403 INVALID_CONNECTION_ID if connectionId is missing (when required),
 *                    spoofed, or belongs to a different session/IP.
 */
export function resolveSender(req, { required = false } = {}) {
  const hostAuth = req.app.locals.hostAuth || req.app.locals.runtime?.hostAuth;
  const hostToken = req.headers['x-host-token'];
  const isHostReq = Boolean(hostToken && hostAuth?.verify(req, hostToken));

  const connectionId = req.headers['x-connection-id'] || req.body?.connectionId || null;
  const rawReqIp = req.ip || req.socket?.remoteAddress || 'unknown';
  const cleanReqIp = rawReqIp.replace(/^::ffff:/, '');

  if (!connectionId) {
    if (required && !isHostReq) {
      throw new AppError('INVALID_CONNECTION_ID', 403, 'A valid connection ID is required');
    }
    return {
      connectionId: null,
      ip: rawReqIp,
      label: req.headers['x-device-name'] || req.body?.deviceName || 'Unknown device',
      labelUntrusted: true,
      platform: req.headers['x-platform'] || req.body?.platform || 'unknown',
      isHost: isHostReq,
    };
  }

  const wss = req.app.get('wss') || req.app.locals.runtime?.wss;
  const sessions = req.app.locals.sessions || req.app.locals.runtime?.sessions;
  const reqToken = extractSessionToken(req);

  if (wss && wss.clients) {
    let matchedClient = null;
    for (const client of wss.clients) {
      if (client.connectionId === connectionId) {
        matchedClient = client;
        break;
      }
    }
    if (!matchedClient) {
      // If not currently in active clients, check if connection was registered by this verified session
      if (reqToken && sessions?.hasConnection?.(reqToken, connectionId)) {
        return {
          connectionId,
          ip: rawReqIp,
          label: req.headers['x-device-name'] || req.body?.deviceName || 'Unknown device',
          labelUntrusted: true,
          platform: req.headers['x-platform'] || req.body?.platform || 'unknown',
          isHost: isHostReq,
          sessionToken: reqToken || null,
        };
      }
      throw new AppError('INVALID_CONNECTION_ID', 403, 'Connection ID not found or expired');
    }

    const clientIp = (matchedClient._remoteIp || '').replace(/^::ffff:/, '');
    if (clientIp && cleanReqIp && cleanReqIp !== 'unknown' && clientIp !== cleanReqIp) {
      throw new AppError('INVALID_CONNECTION_ID', 403, 'Connection ID does not match sender IP');
    }

    // If PIN is required (or socket is bound to a session), verify that session matches
    const isPinRequired =
      req.app.locals.pinRequired ?? req.app.locals.runtime?.pinRequired ?? false;

    if (!isHostReq && (isPinRequired || matchedClient.sessionToken)) {
      if (!reqToken || !matchedClient.sessionToken || matchedClient.sessionToken !== reqToken) {
        throw new AppError(
          'INVALID_CONNECTION_ID',
          403,
          'Connection ID belongs to a different session'
        );
      }
      sessions?.addConnection?.(reqToken, connectionId);
    }
  }

  return {
    connectionId,
    ip: rawReqIp,
    label: req.headers['x-device-name'] || req.body?.deviceName || 'Unknown device',
    labelUntrusted: true,
    platform: req.headers['x-platform'] || req.body?.platform || 'unknown',
    isHost: isHostReq,
    sessionToken: reqToken || null,
  };
}
