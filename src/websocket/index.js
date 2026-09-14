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
    // Browsers cannot set headers on a WebSocket handshake, so the HttpOnly session
    // cookie is accepted as well: a second tab must not be locked out by the PIN gate.
    const cookieSession = sessions?.verify(extractSessionCookie(req)) ? true : false;
    ws.verifySession = (token) => Boolean(sessions?.verify(token) || cookieSession);

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
