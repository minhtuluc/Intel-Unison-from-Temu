/**
 * UniversalTrans — Express Server Entry Point
 * LAN-bound HTTP server with CORS, QR rendering in the terminal and optional
 * browser opening. Lifecycle (signals, exit codes) belongs to bin/utrans.js.
 */

import express from 'express';
import fs from 'node:fs';
import open from 'open';
import qrcode from 'qrcode';
import { createRuntime, isRuntime } from './runtime.js';
import { AppError } from './middleware/error-handler.js';
import { getLanIp, isLanIp } from './utils/network.js';
import { logger } from './utils/logger.js';
import { requestLogger } from './middleware/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { infoRouter } from './routes/info.js';
import { filesRouter } from './routes/files.js';
import { transferRouter } from './routes/transfer.js';
import { setupWebSocket } from './websocket/index.js';
import { requireSession } from './middleware/session-auth.js';

/**
 * Creates and configures the Express application instance.
 * Accepts an existing runtime, or plain config overrides that build one.
 * @param {object} [runtimeOrOptions]
 * @returns {express.Application}
 */
export function createServer(runtimeOrOptions = {}) {
  const app = express();
  const runtime = isRuntime(runtimeOrOptions) ? runtimeOrOptions : createRuntime(runtimeOrOptions);

  app.locals.runtime = runtime;
  app.locals.hostAuth = runtime.hostAuth;
  app.locals.sessions = runtime.sessions;
  app.locals.pinRequired = runtime.pinRequired;

  // Security: hide framework banner and set defensive headers
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

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

  // API responses describe live state (staged files, pending approvals). A cached
  // 304 would leave clients showing a stale or empty list after the state changed.
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers['if-none-match']) {
      delete req.headers['if-none-match'];
    }
    next();
  });

  // Request logging
  app.use(requestLogger);

  // Body parsing (limits reasonable for JSON payloads)
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Serve static assets from public/ (resolved against the package, not the cwd)
  const publicDir = runtime.publicDir;
  if (fs.existsSync(publicDir)) {
    app.use(
      express.static(publicDir, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          } else if (filePath.match(/\.(png|svg|ico|css|js|woff2?)$/)) {
            res.setHeader('Cache-Control', 'public, max-age=3600');
          }
        },
      })
    );
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

  // Mount API routers. Discovery and PIN exchange stay public; data routes are
  // gated whenever a PIN is configured (see session-auth.js).
  app.use(infoRouter);
  app.use(requireSession, filesRouter);
  app.use(requireSession, transferRouter);

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
  // Launch options (host, noBrowser, initialPaths) are not runtime config; keep them
  // separate so the runtime config only carries app settings.
  const { host: requestedHost, localOnly, noBrowser, initialPaths, ...configOverrides } = options;
  const runtime = isRuntime(options) ? options : createRuntime(configOverrides);
  const cfg = runtime.config;
  const app = createServer(runtime);

  // Determine host: bind LAN IP by default, allow localhost
  const lanIp = getLanIp();
  const host = requestedHost || (localOnly ? '127.0.0.1' : lanIp || '127.0.0.1');
  const port = configOverrides.port ?? cfg.port;
  let url;

  // Ensure directories exist
  await fs.promises.mkdir(cfg.uploadDir, { recursive: true });
  await fs.promises.mkdir(cfg.tempDir, { recursive: true });

  // Share initial paths if provided via CLI
  if (initialPaths && initialPaths.length > 0) {
    logger.info('Staging initial files from command line', { count: initialPaths.length });
    await runtime.shareManager.addFiles(initialPaths);
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, async (err) => {
      if (err) return reject(err);

      runtime.setListenPort(server.address().port);
      url = `http://${host}:${runtime.port}`;
      const hostUrl = `${url}/#host-token=${app.locals.hostAuth.token}`;
      const wss = setupWebSocket(server, {
        hostAuth: app.locals.hostAuth,
        sessions: app.locals.sessions,
        pinRequired: app.locals.pinRequired,
        discovery: runtime.discovery,
      });
      app.set('wss', wss);

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
      if (noBrowser || !cfg.autoOpenBrowser) {
        console.log(`Host approval URL (private; do not share): ${hostUrl}`);
      }

      // Auto-open browser on PC if configured
      if (cfg.autoOpenBrowser && !noBrowser) {
        try {
          await open(hostUrl);
        } catch {
          console.log(`Host approval URL (private; do not share): ${hostUrl}`);
        }
      }

      // Lifecycle belongs to the caller (bin/utrans.js): startServer never installs
      // signal handlers and never calls process.exit.
      runtime.attach({ server, wss });

      resolve({ server, app, url, wss, runtime });
    });
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        reject(
          new AppError(
            'PORT_IN_USE',
            409,
            `Port ${port} is already in use by another process. Stop it or choose another port.`
          )
        );
        return;
      }
      reject(err);
    });
  });
}
