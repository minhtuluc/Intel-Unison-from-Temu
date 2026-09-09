/**
 * WebSocket Event Handlers
 * Handles device registration, pings, and transfer event broadcasts.
 */

export function handleWsMessage(_ws, _message, _context) {
  // To be implemented in Phase 3
}

export function broadcastEvent(_wss, event, data) {
  const payload = JSON.stringify({
    event,
    data,
    timestamp: new Date().toISOString(),
  });

  for (const client of _wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(payload);
    }
  }
}
