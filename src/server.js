/**
 * UniversalTrans — Express Server Entry Point
 * Handles HTTP server lifecycle, static asset serving, and graceful shutdown.
 */

import express from 'express';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { errorHandler } from './middleware/error-handler.js';

/**
 * Creates and configures the Express application instance.
 * @param {object} [customConfig]
 * @returns {express.Application}
 */
export function createServer(_customConfig = {}) {
  const app = express();

  // Basic middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Serve static frontend
  app.use(express.static('public'));

  // Health check endpoint
  app.get('/api/health', (_req, res) => {
    res.json({ success: true, status: 'ok', timestamp: new Date().toISOString() });
  });

  // Global error handler
  app.use(errorHandler);

  return app;
}

/**
 * Starts the UniversalTrans server.
 * @param {object} [options]
 * @returns {Promise<{ server: import('http').Server, app: express.Application }>}
 */
export async function startServer(options = {}) {
  const app = createServer(options);
  const port = options.port || config.port;
  const host = options.host || config.host || '127.0.0.1';

  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      logger.info('UniversalTrans server started', { host, port });
      resolve({ server, app });
    });
  });
}
