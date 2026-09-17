/**
 * Shared WebSocket test harness.
 *
 * Registers a real client against a real server and keeps every event it receives, so a
 * test can assert not only what a peer got but what it did *not* get — which is the whole
 * point of the routing assertions around relay transfers.
 */

import WebSocket from 'ws';

/**
 * @param {number} port
 * @param {{ sessionToken?: string|null, deviceName?: string, platform?: string,
 *           deviceToken?: string|null, hostToken?: string|null }} [options]
 * @returns {Promise<{ ws: WebSocket, connId: string, device: object, connectionId: string,
 *                     events: object[] }>}
 */
export function connectWs(port, options = {}) {
  const {
    sessionToken = null,
    deviceName = 'Test device',
    platform = 'web',
    deviceToken = null,
    hostToken = null,
  } = options;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    /** Every message the server sent this socket, in order. */
    const events = [];
    let settled = false;

    ws.on('open', () => {
      const data = { deviceName, platform };
      if (sessionToken) data.sessionToken = sessionToken;
      if (deviceToken) data.deviceToken = deviceToken;
      if (hostToken) data.hostToken = hostToken;
      ws.send(JSON.stringify({ event: 'client:register', data }));
    });

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      events.push(message);
      if (settled) return;

      if (message.event === 'client:registered') {
        settled = true;
        resolve({
          ws,
          connId: message.data.connectionId,
          connectionId: message.data.connectionId,
          device: message.data.device,
          events,
        });
      } else if (message.event === 'client:rejected') {
        settled = true;
        reject(new Error(`WebSocket registration rejected: ${JSON.stringify(message.data)}`));
      }
    });

    ws.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * Waits until a collected event satisfies the predicate.
 * @param {object[]} events
 * @param {(message: object) => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<object>}
 */
export function waitForEvent(events, predicate, timeoutMs = 3000) {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() >= deadline) {
        return reject(
          new Error(
            `Timed out waiting for event. Received: ${JSON.stringify(events.map((e) => e.event))}`
          )
        );
      }
      setTimeout(poll, 15);
    };
    poll();
  });
}

/** Waits for one event with the given name. */
export function waitForEventName(events, eventName, timeoutMs = 3000) {
  return waitForEvent(events, (message) => message.event === eventName, timeoutMs);
}

/** @param {number} ms */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Closes a socket and resolves once the server side has observed the close, so the
 * following assertions do not race the disconnect handler.
 * @param {WebSocket} ws
 */
export function closeWs(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on('close', resolve);
    ws.close();
  });
}

export { WebSocket };
