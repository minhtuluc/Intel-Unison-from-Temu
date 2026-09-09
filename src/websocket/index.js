/**
 * WebSocket Server Setup
 * Initializes ws server attached to HTTP server.
 */

import { WebSocketServer } from 'ws';
import { logger } from '../utils/logger.js';

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    logger.info('WebSocket client connected', { ip: req.socket.remoteAddress });

    ws.on('message', (_message) => {
      // Event handling
    });

    ws.on('close', () => {
      logger.info('WebSocket client disconnected');
    });
  });

  return wss;
}
