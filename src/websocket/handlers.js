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
      ws.sessionToken = session ? (typeof session === 'object' ? session.token : session) : null;
      ws.authorized = Boolean(ws.isHost || session || !ws.pinRequired);

      if (ws.sessionToken) {
        ws.sessions?.addConnection?.(ws.sessionToken, ws.connectionId);
      }

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
      let deviceRecord;
      try {
        deviceRecord = ws.discovery.addConnection(ws.connectionId, {
          label: deviceName,
          platform,
          ip: ws._remoteIp || '127.0.0.1',
          isHost: ws.isHost,
        });
      } catch (err) {
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              event: 'client:rejected',
              data: { reason: err.code || 'REGISTRATION_FAILED', message: err.message },
              timestamp: new Date().toISOString(),
            })
          );
        }
        logger.warn('Failed to register WebSocket client', {
          error: err.message,
          ip: ws._remoteIp,
        });
        try {
          ws.close(1008, err.message);
        } catch {
          // ignore error if socket is already closed or destroyed
        }
        return;
      }

      // Send registered ack to current client with all current devices
      const { connectionId: _c, ...safeDevice } = deviceRecord;
      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            event: 'client:registered',
            data: {
              device: safeDevice,
              devices: ws.discovery.getDevices(),
              connectionId: ws.connectionId,
            },
            timestamp: new Date().toISOString(),
          })
        );
      }

      // Broadcast device:join to other clients (never exposing connectionId)
      broadcastEvent(wss, 'device:join', { device: safeDevice }, ws);
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

/**
 * Events that describe a host-only decision. Clients must never receive these:
 * seeing another device's pending approval is itself an information leak.
 */
const HOST_ONLY_EVENTS = new Set(['upload:request', 'transfer:offer']);

export function broadcastEvent(wss, event, data, filterOrExclude = null) {
  if (!wss || !wss.clients) return;

  const payload = JSON.stringify({
    event,
    data,
    timestamp: new Date().toISOString(),
  });

  for (const client of wss.clients) {
    // Unauthenticated sockets receive nothing while a PIN policy is active.
    if (typeof client.isAuthorized === 'function') {
      if (!client.isAuthorized()) continue;
    } else if (client.authorized === false) {
      continue;
    }
    if (HOST_ONLY_EVENTS.has(event) && !client.isHost) continue;

    // Filter check
    if (typeof filterOrExclude === 'function') {
      if (!filterOrExclude(client)) continue;
    } else if (filterOrExclude && client === filterOrExclude) {
      continue;
    }

    if (client.readyState === 1 /* OPEN */) {
      try {
        client.send(payload);
      } catch (err) {
        logger.warn('Failed to send WebSocket message', { error: err.message });
      }
    }
  }
}

/**
 * Sends terminal transfer outcome events only to the host and the specific sender socket.
 * Other connected clients will never receive terminal transfer events of unrelated transfers.
 * @param {object} wss
 * @param {string} event
 * @param {object} data
 * @param {object} [sender]
 */
export function sendTransferTerminalEvent(wss, event, data, sender = null) {
  broadcastEvent(wss, event, data, (client) => {
    if (client.isHost) return true;
    const hasSenderInfo = sender && (sender.connectionId || (sender.ip && sender.ip !== 'unknown'));
    if (!hasSenderInfo) return true;
    if (sender?.connectionId && client.connectionId === sender.connectionId) {
      return true;
    }
    return false;
  });
}
