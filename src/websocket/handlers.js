/**
 * WebSocket Event Handlers
 * Handles device registration, pings, and transfer event broadcasts.
 */

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
      const { deviceName, platform, hostToken, sessionToken } = data || {};

      const session = ws.verifySession?.(sessionToken);
      ws.isHost = Boolean(ws.verifyHost?.(hostToken));
      ws.authorized = Boolean(ws.isHost || session || !ws.pinRequired);

      if (!ws.authorized) {
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              event: 'client:rejected',
              data: { reason: 'UNAUTHORIZED' },
              timestamp: new Date().toISOString(),
            })
          );
        }
        logger.warn('Rejected WebSocket registration without valid capability', {
          remoteIp: ws._remoteIp,
        });
        return;
      }

      // Identity is the connection, not the payload. Claimed name/platform are
      // stored as untrusted display labels only.
      const deviceRecord = ws.discovery.addConnection(ws.connectionId, {
        label: deviceName,
        platform,
        ip: ws._remoteIp || '127.0.0.1',
        isHost: ws.isHost,
      });

      // Send registered ack to current client with all current devices
      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            event: 'client:registered',
            data: {
              device: deviceRecord,
              devices: ws.discovery.getDevices(),
            },
            timestamp: new Date().toISOString(),
          })
        );
      }

      // Broadcast device:join to other clients
      broadcastEvent(wss, 'device:join', { device: deviceRecord }, ws);
      logger.info('Device registered via WebSocket', {
        deviceId: deviceRecord.id,
        label: deviceRecord.label,
        platform: deviceRecord.platform,
      });
      break;
    }

    case 'client:ping': {
      ws.discovery.touchConnection(ws.connectionId);
      ws.isAlive = true;
      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            event: 'server:pong',
            data: {
              timestamp: Date.now(),
              onlineDevices: ws.discovery.getDevices().length,
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
    // Unauthenticated sockets receive nothing while a PIN policy is active.
    if (client.authorized === false) continue;
    if (event === 'upload:request' && !client.isHost) continue;
    if (client !== excludeWs && client.readyState === 1 /* OPEN */) {
      try {
        client.send(payload);
      } catch (err) {
        logger.warn('Failed to send WebSocket message', { error: err.message });
      }
    }
  }
}
