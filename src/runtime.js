/**
 * Application runtime.
 *
 * One runtime owns everything an app instance needs: resolved config, managers,
 * discovery registry and the two capability stores. Routes and services read it from
 * `app.locals.runtime`, so two runtimes can run side by side without shared state.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { removeInstanceFile } from './utils/instance-file.js';
import { logger } from './utils/logger.js';
import { ShareManager } from './services/share-manager.js';
import { ChunkedUploadManager } from './services/chunked-upload.js';
import { PendingUploadService } from './services/pending-upload.js';
import { DiscoveryService } from './services/discovery.js';
import { StorageQuotaTracker } from './services/storage-quota.js';
import { TransferOfferService } from './services/transfer-offer.js';
import { TrustedDeviceService } from './services/trusted-devices.js';
import { createHostAuth } from './middleware/host-auth.js';
import { createSessionStore } from './middleware/session-auth.js';
import { sendTransferTerminalEvent } from './websocket/handlers.js';

/** Static assets live with the package, never relative to the process cwd. */
export const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

/**
 * @param {object} [options] config overrides (tempDir, uploadDir, port, pin, ...)
 */
export function createRuntime(options = {}) {
  const config = loadConfig(options);
  const quotaTracker = new StorageQuotaTracker(config.storageQuota);
  config.quotaTracker = quotaTracker;

  // Reconcile existing disk usage from chunks and pending directories
  const chunksDir = path.join(config.tempDir, 'chunks');
  const pendingDir = path.join(config.tempDir, 'pending');
  quotaTracker.reconcileFromDiskSync([chunksDir, pendingDir]);

  const runtime = {
    config,
    publicDir: options.publicDir || PUBLIC_DIR,
    quotaTracker,
    shareManager: new ShareManager(),
    chunkedUploadManager: new ChunkedUploadManager(config),
    pendingUploadManager: new PendingUploadService({ config, quotaTracker }),
    trustedDevices: new TrustedDeviceService({ config }),
    offerService: new TransferOfferService({ config }),
    discovery: new DiscoveryService({ maxConnectedDevices: config.maxConnectedDevices }),
    hostAuth: createHostAuth(),
    sessions: createSessionStore({ ttlMs: config.sessionTtlMs, maxSessions: config.maxSessions }),
    pinRequired: Boolean(config.pin),
    listenPort: null,
    inFlightSimpleUploads: 0,
    getActiveTransferCount() {
      let chunkCount = 0;
      for (const session of runtime.chunkedUploadManager.sessions.values()) {
        if (session.status === 'uploading' || session.status === 'completing') {
          chunkCount++;
        }
      }
      return chunkCount + runtime.inFlightSimpleUploads;
    },
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
     * Sweeps expired sessions and orphaned temp files across all managers.
     * @param {{ olderThanMs?: number }} [options]
     */
    async sweepAll({ olderThanMs } = {}) {
      await Promise.allSettled([
        runtime.chunkedUploadManager.cleanup(),
        runtime.chunkedUploadManager.sweepOrphans(olderThanMs),
        runtime.pendingUploadManager.sweepOrphans(olderThanMs),
        runtime.shareManager.sweepOrphans(runtime.config.tempDir, olderThanMs),
      ]);
      runtime.offerService.sweepGrants();
    },

    /**
     * Re-scans disk for chunks and pending uploads to align quota allocation.
     * @returns {Promise<number>}
     */
    async reconcileDiskQuota() {
      const chunks = path.join(runtime.config.tempDir, 'chunks');
      const pending = path.join(runtime.config.tempDir, 'pending');
      return await quotaTracker.reconcileFromDisk([chunks, pending]);
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
        if (runtime.sweepInterval) {
          clearInterval(runtime.sweepInterval);
          runtime.sweepInterval = null;
        }

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

        let cleanupError = null;
        const runCleanupTask = async (name, fn) => {
          try {
            await fn();
          } catch (err) {
            cleanupError = cleanupError || err;
            logger.warn(`Runtime cleanup task "${name}" reported an error`, { error: err.message });
          }
        };

        const performCleanup = async () => {
          await Promise.allSettled([
            runCleanupTask('shareManager', () => runtime.shareManager.clear()),
            runCleanupTask('chunkedUploadManager', () => runtime.chunkedUploadManager.cleanup()),
            runCleanupTask('pendingUploadManager', () => runtime.pendingUploadManager.cleanup()),
            runCleanupTask('offerService', () => runtime.offerService.cleanup()),
            runCleanupTask('sessions', () => runtime.sessions.revokeAll()),
          ]);
        };

        let cleanupTimer = null;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          timedOut = true;
        } else {
          try {
            await Promise.race([
              performCleanup(),
              new Promise((_, reject) => {
                cleanupTimer = setTimeout(() => {
                  timedOut = true;
                  reject(new Error('Cleanup timed out'));
                }, remainingMs);
              }),
            ]);
          } catch {
            if (Date.now() >= deadline) {
              timedOut = true;
            }
          } finally {
            if (cleanupTimer) {
              clearTimeout(cleanupTimer);
              cleanupTimer = null;
            }
          }
        }

        if (Date.now() >= deadline) {
          timedOut = true;
        }

        removeInstanceFile(runtime.port);

        const stopped = !timedOut && !cleanupError;
        return { stopped, timedOut, error: cleanupError || undefined };
      })();

      return runtime.stoppingPromise;
    },
  };

  // Background periodic sweeper for orphaned temp files
  const sweepInterval = setInterval(
    () => {
      runtime.sweepAll().catch(() => {});
    },
    5 * 60 * 1000
  );
  if (sweepInterval.unref) sweepInterval.unref();
  runtime.sweepInterval = sweepInterval;

  // Run startup sweep in background
  runtime.sweepAll().catch(() => {});

  // An offer the host never answered must end loudly: the sender is blocked on it.
  runtime.offerService.onExpire = ({ offerId, sender }) => {
    const wss = runtime.wss || runtime.app?.get('wss');
    if (wss) {
      sendTransferTerminalEvent(
        wss,
        'transfer:offer:expired',
        {
          offerId,
          reason: 'TIMEOUT',
        },
        sender
      );
    }
  };

  runtime.pendingUploadManager.onTimeout = ({ transferId, sender }) => {
    const wss = runtime.wss || runtime.app?.get('wss');
    if (wss) {
      sendTransferTerminalEvent(
        wss,
        'transfer:expired',
        {
          transferId,
          reason: 'TIMEOUT',
        },
        sender
      );
    }
  };

  return runtime;
}

/** True when the value carries runtime state rather than plain config overrides. */
export function isRuntime(value) {
  return Boolean(value && value.config && value.shareManager && value.hostAuth);
}
