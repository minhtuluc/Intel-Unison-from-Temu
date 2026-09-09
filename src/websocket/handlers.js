/**
 * WebSocket Event Handlers
 * Handles device registration, pings, and transfer event broadcasts.
 */

import { discoveryService } from '../services/discovery.js';
import { logger } from '../utils/logger.js';

export function handleWsMessage(wss, ws, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage.toString());
  } catch (err) {
    logger.warn('Invalid WebSocket message JSON', { error: err.message });
    return;
  }

  const { event, data } = message || {};

  switch (event) {
    case 'client:register': {
      const { deviceId, deviceName, platform, isHost } = data || {};
      if (!deviceId) return;

      ws.deviceId = deviceId;
      const deviceRecord = discoveryService.addDevice(deviceId, {
        deviceName,
        platform,
        ip: ws._remoteIp || '127.0.0.1',
        isHost: Boolean(isHost),
      });

      // Send registered ack to current client with all current devices
      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            event: 'client:registered',
            data: {
              deviceId,
              device: deviceRecord,
              devices: discoveryService.getDevices(),
            },
            timestamp: new Date().toISOString(),
          })
        );
      }

      // Broadcast device:join to other clients
      broadcastEvent(wss, 'device:join', { device: deviceRecord }, ws);
      logger.info('Device registered via WebSocket', {
        deviceId,
        deviceName: deviceRecord.deviceName,
        platform: deviceRecord.platform,
      });
      break;
    }

    case 'client:ping': {
      if (ws.deviceId) {
        discoveryService.touch(ws.deviceId);
      }
      ws.isAlive = true;
      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            event: 'server:pong',
            data: {
              timestamp: Date.now(),
              onlineDevices: discoveryService.getDevices().length,
            },
            timestamp: new Date().toISOString(),
          })
        );
      }
      break;
    }

    default:
      logger.debug('Unhandled WebSocket event', { event });
      break;
  }
}

export function broadcastEvent(wss, event, data, excludeWs = null) {
  if (!wss || !wss.clients) return;

  const payload = JSON.stringify({
    event,
    data,
    timestamp: new Date().toISOString(),
  });

  for (const client of wss.clients) {
    if (client !== excludeWs && client.readyState === 1 /* OPEN */) {
      try {
        client.send(payload);
      } catch (err) {
        logger.warn('Failed to send WebSocket message', { error: err.message });
      }
    }
  }
}
