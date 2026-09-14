/**
 * Application runtime.
 *
 * One runtime owns everything an app instance needs: resolved config, managers,
 * discovery registry and the two capability stores. Routes and services read it from
 * `app.locals.runtime`, so two runtimes can run side by side without shared state.
 */

import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { removeInstanceFile } from './utils/instance-file.js';
import { logger } from './utils/logger.js';
import { ShareManager } from './services/share-manager.js';
import { ChunkedUploadManager } from './services/chunked-upload.js';
import { PendingUploadService } from './services/pending-upload.js';
import { DiscoveryService } from './services/discovery.js';
import { createHostAuth } from './middleware/host-auth.js';
import { createSessionStore } from './middleware/session-auth.js';

/** Static assets live with the package, never relative to the process cwd. */
export const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

/**
 * @param {object} [options] config overrides (tempDir, uploadDir, port, pin, ...)
 */
export function createRuntime(options = {}) {
  const config = loadConfig(options);

  const runtime = {
    config,
    publicDir: options.publicDir || PUBLIC_DIR,
    shareManager: new ShareManager(),
    chunkedUploadManager: new ChunkedUploadManager(config),
    pendingUploadManager: new PendingUploadService({ config }),
    discovery: new DiscoveryService(),
    hostAuth: createHostAuth(),
    sessions: createSessionStore({ ttlMs: config.sessionTtlMs, maxSessions: config.maxSessions }),
    pinRequired: Boolean(config.pin),
    listenPort: null,
    /**
     * Records the port the HTTP listener actually bound to (matters for port 0).
     * @param {number} port
     */
    setListenPort(port) {
      runtime.listenPort = port;
    },
    /** Port shown to clients; the real listener wins over the configured default. */
    get port() {
      return runtime.listenPort ?? config.port;
    },

    /** Attaches the running HTTP/WS handles so stop() can close them. */
    attach({ server = null, wss = null } = {}) {
      runtime.server = server;
      runtime.wss = wss;
    },

    /**
     * Stops everything this runtime owns within a deadline. Never calls process.exit
     * and never leaves WebSocket clients pinning the HTTP server open.
     * @param {{ timeoutMs?: number }} [options]
     * @returns {Promise<{ stopped: boolean, timedOut: boolean }>}
     */
    stop({ timeoutMs = 5000 } = {}) {
      if (runtime.stoppingPromise) return runtime.stoppingPromise;

      runtime.stoppingPromise = (async () => {
        const deadline = Date.now() + timeoutMs;
        let timedOut = false;

        if (runtime.wss) {
          try {
            for (const client of runtime.wss.clients) client.terminate();
            runtime.wss.close();
          } catch {
            // WebSocket server already gone
          }
        }

        if (runtime.server && runtime.server.listening) {
          const server = runtime.server;
          await new Promise((resolve) => {
            const timer = setTimeout(
              () => {
                timedOut = true;
                resolve();
              },
              Math.max(0, deadline - Date.now())
            );

            server.close(() => {
              clearTimeout(timer);
              resolve();
            });

            // Idle keep-alive sockets would otherwise hold the server open.
            if (typeof server.closeAllConnections === 'function') {
              server.closeAllConnections();
            }
          });
        }

        try {
          runtime.shareManager.clear();
          await runtime.chunkedUploadManager.cleanup();
          await runtime.pendingUploadManager.cleanup();
          runtime.sessions.revokeAll();
        } catch (err) {
          logger.warn('Runtime cleanup reported an error', { error: err.message });
        }

        removeInstanceFile(runtime.port);

        return { stopped: !timedOut, timedOut };
      })();

      return runtime.stoppingPromise;
    },
  };

  return runtime;
}

/** True when the value carries runtime state rather than plain config overrides. */
export function isRuntime(value) {
  return Boolean(value && value.config && value.shareManager && value.hostAuth);
}
