/**
 * UniversalTrans — Express Server Entry Point
 * Production-grade HTTP server with LAN-binding, CORS, graceful shutdown,
 * QR code terminal rendering, and automatic browser opening.
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import open from 'open';
import qrcode from 'qrcode';
import { config as appConfig } from './config.js';
import { getLanIp, isLanIp } from './utils/network.js';
import { logger } from './utils/logger.js';
import { requestLogger } from './middleware/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { infoRouter } from './routes/info.js';
import { filesRouter } from './routes/files.js';
import { transferRouter } from './routes/transfer.js';
import { shareManager } from './services/share-manager.js';
import { chunkedUploadManager } from './services/chunked-upload.js';

/**
 * Creates and configures the Express application instance.
 * @param {object} [customConfig]
 * @returns {express.Application}
 */
export function createServer(customConfig = {}) {
  const app = express();
  const _cfg = { ...appConfig, ...customConfig };

  // Security: hide framework banner
  app.disable('x-powered-by');

  // CORS Middleware: Allow LAN origins & localhost
  app.use((req, res, next) => {
    const origin = req.headers.origin || '';
    const ip = req.ip || req.socket.remoteAddress || '';

    // Allow if origin is LAN or request is LAN
    if (!origin || isLanIp(origin.replace(/^https?:\/\//, '').split(':')[0]) || isLanIp(ip)) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Content-Range, Content-Length, Content-Disposition, Accept-Ranges'
      );
    }

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // Request logging
  app.use(requestLogger);

  // Body parsing (limits reasonable for JSON payloads)
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Serve static assets from public/
  const publicDir = path.resolve('public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  // Health check endpoint
  app.get('/api/health', (_req, res) => {
    res.json({
      success: true,
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    });
  });

  // Mount API routers
  app.use(infoRouter);
  app.use(filesRouter);
  app.use(transferRouter);

  // Centralized error handler
  app.use(errorHandler);

  return app;
}

/**
 * Starts the UniversalTrans server on the detected LAN address.
 * @param {object} [options]
 * @returns {Promise<{ server: import('http').Server, app: express.Application, url: string }>}
 */
export async function startServer(options = {}) {
  const cfg = { ...appConfig, ...options };
  const app = createServer(cfg);

  // Determine host: bind LAN IP by default, allow localhost
  const lanIp = getLanIp();
  const host = options.host || (options.localOnly ? '127.0.0.1' : lanIp || '127.0.0.1');
  const port = options.port || cfg.port;
  const url = `http://${host}:${port}`;

  // Ensure directories exist
  await fs.promises.mkdir(cfg.uploadDir, { recursive: true });
  await fs.promises.mkdir(cfg.tempDir, { recursive: true });

  // Share initial paths if provided via CLI
  if (options.initialPaths && options.initialPaths.length > 0) {
    logger.info('Staging initial files from command line', { count: options.initialPaths.length });
    await shareManager.addFiles(options.initialPaths);
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, async (err) => {
      if (err) return reject(err);

      logger.info(`UniversalTrans server running at ${url}`);

      // Render QR in terminal for instant mobile scan
      try {
        const qrTerminal = await qrcode.toString(url, { type: 'terminal', small: true });
        console.log('\n--- SCAN WITH PHONE TO CONNECT ---');
        console.log(qrTerminal);
        console.log(`Web URL: ${url}`);
        console.log('----------------------------------\n');
      } catch {
        console.log(`Connect URL: ${url}`);
      }

      // Auto-open browser on PC if configured
      if (cfg.autoOpenBrowser && !options.noBrowser) {
        try {
          await open(url);
        } catch {
          // Ignore if open browser fails (e.g. in headless environment)
        }
      }

      // Setup graceful shutdown handlers
      const shutdown = async (signal) => {
        logger.info(`Received ${signal}, shutting down gracefully...`);
        server.close(async () => {
          try {
            shareManager.clear();
            await chunkedUploadManager.cleanup();
          } catch {
            // Ignore cleanup errors during shutdown
          }
          logger.info('UniversalTrans shutdown complete');
          process.exit(0);
        });
      };

      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));

      resolve({ server, app, url });
    });
  });
}
