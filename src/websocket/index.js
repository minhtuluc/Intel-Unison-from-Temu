/**
 * WebSocket Server Setup
 * Initializes ws server attached to HTTP server.
 */

import { WebSocketServer } from 'ws';
import { logger } from '../utils/logger.js';
import { handleWsMessage, broadcastEvent } from './handlers.js';
import { discoveryService } from '../services/discovery.js';

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws._remoteIp = req.socket.remoteAddress;

    logger.info('WebSocket client connected', { ip: ws._remoteIp });

    ws.on('pong', () => {
      ws.isAlive = true;
      if (ws.deviceId) {
        discoveryService.touch(ws.deviceId);
      }
    });

    ws.on('message', (message) => {
      handleWsMessage(wss, ws, message);
    });

    ws.on('close', () => {
      if (ws.deviceId) {
        const device = discoveryService.getDevice(ws.deviceId);
        discoveryService.removeDevice(ws.deviceId);
        broadcastEvent(wss, 'device:leave', {
          deviceId: ws.deviceId,
          deviceName: device?.deviceName || 'Unknown Device',
        });
        logger.info('WebSocket client left', { deviceId: ws.deviceId });
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
        logger.info('Terminating unresponsive WebSocket client', { deviceId: ws.deviceId });
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
