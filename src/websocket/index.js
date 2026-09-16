/**
 * WebSocket Server Setup
 * Initializes ws server attached to HTTP server.
 */

import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { logger } from '../utils/logger.js';
import { handleWsMessage, broadcastEvent } from './handlers.js';
import { DiscoveryService } from '../services/discovery.js';
import { extractSessionCookie } from '../middleware/session-auth.js';

export function setupWebSocket(server, auth = {}) {
  const { hostAuth, sessions, pinRequired = false, discovery = new DiscoveryService() } = auth;
  const wss = new WebSocketServer({ server, path: '/ws' });

  sessions?.onRevoke?.((revokedToken) => {
    for (const client of wss.clients) {
      if (client.isHost) continue;
      if (client.sessionToken === revokedToken || client.cookieToken === revokedToken) {
        client.authorized = false;
        client.sessionToken = null;
        try {
          client.close(1008, 'Session revoked');
        } catch {
          // Ignore close error
        }
      }
    }
  });

  sessions?.onRevokeAll?.(() => {
    for (const client of wss.clients) {
      if (client.isHost) continue;
      client.authorized = false;
      client.sessionToken = null;
      try {
        client.close(1008, 'Session revoked');
      } catch {
        // Ignore close error
      }
    }
  });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.connectionId = randomUUID();
    ws.discovery = discovery;
    ws._remoteIp = req.socket.remoteAddress;
    ws.verifyHost = (token) => Boolean(hostAuth?.verify(req, token));
    ws.isHost = false;
    ws.pinRequired = Boolean(pinRequired);
    // Without a PIN every LAN client keeps the previous open behaviour.
    ws.authorized = !ws.pinRequired;
    ws.cookieToken = extractSessionCookie(req);
    ws.sessionToken = null;
    ws.sessions = sessions;
    if (ws.cookieToken) {
      sessions?.addConnection?.(ws.cookieToken, ws.connectionId);
    }

    ws.verifySession = (token) => {
      if (!sessions) return null;
      const candidate = token || ws.cookieToken;
      if (!candidate) return null;
      return sessions.verify(candidate);
    };

    ws.isAuthorized = () => {
      if (!ws.pinRequired) return true;
      if (ws.isHost) return true;
      if (!ws.authorized || !ws.sessionToken) return false;
      const session = sessions?.verify(ws.sessionToken);
      if (!session) {
        ws.authorized = false;
        ws.sessionToken = null;
        return false;
      }
      return true;
    };

    logger.info('WebSocket client connected', { ip: ws._remoteIp });

    ws.on('pong', () => {
      ws.isAlive = true;
      ws.discovery.touchConnection(ws.connectionId);
    });

    ws.on('message', (message) => {
      handleWsMessage(wss, ws, message);
    });

    ws.on('close', () => {
      const device = ws.discovery.getDeviceByConnection(ws.connectionId);
      if (device) {
        ws.discovery.removeConnection(ws.connectionId);
        broadcastEvent(wss, 'device:leave', {
          deviceId: device.id,
          label: device.label,
        });
        logger.info('WebSocket client left', { deviceId: device.id });
      } else {
        logger.info('WebSocket client disconnected');
      }
    });

    ws.on('error', (err) => {
      logger.warn('WebSocket client error', { error: err.message });
    });
  });

  // Heartbeat watchdog: ping clients every 30s, terminate if unresponsive after 90s (3 intervals)
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        logger.info('Terminating unresponsive WebSocket client', { connectionId: ws.connectionId });
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (err) {
        logger.warn('Failed to ping WebSocket client', { error: err.message });
      }
    }
  }, 30000);

  if (interval.unref) {
    interval.unref();
  }

  server.on('close', () => {
    clearInterval(interval);
    try {
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close();
    } catch {
      // ignore
    }
  });

  wss.on('close', () => {
    clearInterval(interval);
  });

  return wss;
}
