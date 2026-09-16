/**
 * Regression tests for findings R1-R5 documented in REVIEW-M1.md.
 * Verifies WebSocket session revocation, XHR chunk upload lifecycle,
 * host session exchange and data access, simple upload maxFileSize enforcement,
 * and shutdown deadline covering cleanup tasks.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { createRuntime } from '../../src/runtime.js';
import { createServer } from '../../src/server.js';
import { setupWebSocket } from '../../src/websocket/index.js';
import { broadcastEvent } from '../../src/websocket/handlers.js';
import { TransferEngine } from '../../public/js/transfer.js';

describe('M1 Review Regression: R1 to R5', () => {
  let root, runtime, app, server, base, hostToken, wss;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-m1-regression-'));
    runtime = createRuntime({
      pin: '7788',
      tempDir: path.join(root, 'temp'),
      uploadDir: path.join(root, 'received'),
      chunkSize: 32,
      maxFileSize: 64, // Small limit to test R4
    });

    app = createServer(runtime);
    hostToken = app.locals.hostAuth.token;
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    runtime.setListenPort(server.address().port);
    base = `http://127.0.0.1:${runtime.port}`;

    wss = setupWebSocket(server, {
      hostAuth: app.locals.hostAuth,
      sessions: app.locals.sessions,
      pinRequired: app.locals.pinRequired,
      discovery: runtime.discovery,
    });
    runtime.attach({ server, wss });
  });

  after(async () => {
    if (runtime) {
      await runtime.stop({ timeoutMs: 500 });
    }
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  /* ==========================================================================
     R1: Session revoke / expiry terminates WS authorization
     ========================================================================== */
  describe('R1: WebSocket session validity after revocation/expiry', () => {
    it('closes or deauthorizes WS client after revoke-all; rejects re-registration', async () => {
      // 1. Client logs in with PIN to receive valid session
      const authRes = await fetch(`${base}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '7788' }),
      });
      assert.equal(authRes.status, 200);
      const authJson = await authRes.json();
      const clientSessionToken = authJson.data.token;
      assert.ok(clientSessionToken);

      // 2. Client connects to WebSocket
      const clientWs = new WebSocket(`ws://127.0.0.1:${runtime.port}/ws`);
      await once(clientWs, 'open');

      const clientMessages = [];
      clientWs.on('message', (raw) => {
        clientMessages.push(JSON.parse(raw.toString()));
      });

      // Register client with session token
      clientWs.send(
        JSON.stringify({
          event: 'client:register',
          data: {
            deviceName: 'Client-Device',
            platform: 'android',
            sessionToken: clientSessionToken,
          },
        })
      );

      // Wait for registration confirmation
      await new Promise((resolve) => {
        const check = () => {
          if (clientMessages.some((m) => m.event === 'client:registered')) resolve();
          else setTimeout(check, 10);
        };
        check();
      });

      // 3. Host connects to WebSocket
      const hostWs = new WebSocket(`ws://127.0.0.1:${runtime.port}/ws`);
      await once(hostWs, 'open');
      const hostMessages = [];
      hostWs.on('message', (raw) => {
        hostMessages.push(JSON.parse(raw.toString()));
      });

      hostWs.send(
        JSON.stringify({
          event: 'client:register',
          data: { deviceName: 'Host-Device', platform: 'windows', hostToken },
        })
      );

      await new Promise((resolve) => {
        const check = () => {
          if (hostMessages.some((m) => m.event === 'client:registered')) resolve();
          else setTimeout(check, 10);
        };
        check();
      });

      // 4. Host calls revoke-all
      const revokeRes = await fetch(`${base}/api/auth/revoke-all`, {
        method: 'POST',
        headers: { 'X-Host-Token': hostToken },
      });
      assert.equal(revokeRes.status, 200);

      // 5. Verify client socket receives no protected event after revocation
      // Wait for revoke notification to take effect
      await new Promise((resolve) => setTimeout(resolve, 50));

      const clientMessagesCountBeforeBroadcast = clientMessages.length;
      broadcastEvent(wss, 'share:update', { testFile: 'protected.txt' });

      // Allow message dispatch
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Client should not have received the protected event
      const clientReceivedShareUpdate = clientMessages
        .slice(clientMessagesCountBeforeBroadcast)
        .some((m) => m.event === 'share:update');
      assert.equal(
        clientReceivedShareUpdate,
        false,
        'Revoked client must not receive share:update'
      );

      // Host socket should still receive share:update
      const hostReceivedShareUpdate = hostMessages.some((m) => m.event === 'share:update');
      assert.equal(hostReceivedShareUpdate, true, 'Host socket must still receive share:update');

      // 6. Attempting to register on a new WS with the revoked token is rejected
      const secondWs = new WebSocket(`ws://127.0.0.1:${runtime.port}/ws`);
      await once(secondWs, 'open');
      const secondMessages = [];
      secondWs.on('message', (raw) => secondMessages.push(JSON.parse(raw.toString())));

      secondWs.send(
        JSON.stringify({
          event: 'client:register',
          data: { deviceName: 'Client-2', sessionToken: clientSessionToken },
        })
      );

      await new Promise((resolve) => {
        const check = () => {
          if (secondMessages.some((m) => m.event === 'client:rejected')) resolve();
          else setTimeout(check, 10);
        };
        check();
      });

      assert.ok(
        secondMessages.some((m) => m.event === 'client:rejected'),
        'Reconnecting with revoked token must be rejected'
      );

      try {
        clientWs.close();
      } catch {
        // ignore
      }
      try {
        hostWs.close();
      } catch {
        // ignore
      }
      try {
        secondWs.close();
      } catch {
        // ignore
      }
    });
  });

  /* ==========================================================================
     R2: XMLHttpRequest chunk upload call order
     ========================================================================== */
  describe('R2: XMLHttpRequest lifecycle in chunk upload', () => {
    it('calls open before setRequestHeader when session token is present', async () => {
      const callLog = [];
      let state = 'UNSENT';

      class MockXHR {
        constructor() {
          this.upload = {};
          this.status = 200;
          this.responseText = JSON.stringify({ success: true });
        }

        open(method, url) {
          callLog.push(`open:${method}:${url}`);
          state = 'OPENED';
        }

        setRequestHeader(key, value) {
          if (state !== 'OPENED') {
            throw new Error(
              "InvalidStateError: Failed to execute 'setRequestHeader' on 'XMLHttpRequest': The object's state must be OPENED."
            );
          }
          callLog.push(`setRequestHeader:${key}=${value}`);
        }

        send(_body) {
          callLog.push('send');
          setTimeout(() => {
            if (this.onload) this.onload();
          }, 0);
        }
      }

      // Save global XMLHttpRequest and sessionStorage
      const prevXHR = globalThis.XMLHttpRequest;
      const prevSessionStorage = globalThis.sessionStorage;

      globalThis.XMLHttpRequest = MockXHR;
      globalThis.sessionStorage = {
        getItem: (k) => (k === 'utrans_session_token' ? 'test-session-token' : null),
        setItem: () => {},
        removeItem: () => {},
      };

      try {
        const engine = new TransferEngine();
        engine.connectionId = 'conn-test-123';
        const fakeBlob = new Blob(['0123456789']);
        const fakeTask = {
          uploadId: 'up-123',
          uploadToken: 'upload-secret-123',
          speedSamples: [],
          xhr: null,
        };

        await engine._uploadChunkWithProgress(fakeTask, 0, fakeBlob);

        // Verify that open was called before setRequestHeader
        const openIdx = callLog.findIndex((c) => c.startsWith('open:'));
        const headerIdx = callLog.findIndex((c) =>
          c.startsWith('setRequestHeader:X-Session-Token')
        );
        const sendIdx = callLog.findIndex((c) => c === 'send');

        assert.ok(openIdx !== -1, 'xhr.open must be called');
        assert.ok(headerIdx !== -1, 'xhr.setRequestHeader must be called');
        assert.ok(
          callLog.includes('setRequestHeader:X-Upload-Id=up-123'),
          'chunk request must expose upload id before the multipart parser runs'
        );
        assert.ok(
          callLog.includes('setRequestHeader:X-Connection-Id=conn-test-123'),
          'chunk request must carry the server-issued connection id'
        );
        assert.ok(
          callLog.includes('setRequestHeader:X-Upload-Token=upload-secret-123'),
          'chunk request must carry the resumable upload capability'
        );
        assert.ok(sendIdx !== -1, 'xhr.send must be called');
        assert.ok(openIdx < headerIdx, 'xhr.open must be called before xhr.setRequestHeader');
        assert.ok(headerIdx < sendIdx, 'xhr.setRequestHeader must be called before xhr.send');
      } finally {
        globalThis.XMLHttpRequest = prevXHR;
        globalThis.sessionStorage = prevSessionStorage;
      }
    });
  });

  /* ==========================================================================
     R3: Frontend host capability & host-session exchange
     ========================================================================== */
  describe('R3: Host capability for data APIs and media/download session', () => {
    it('allows host to exchange host token for session cookie via /api/auth/host-session', async () => {
      // 1. Remote client attempt without host token gets 403
      const clientRes = await fetch(`${base}/api/auth/host-session`, { method: 'POST' });
      assert.equal(clientRes.status, 403);

      // 2. Host with X-Host-Token succeeds and receives cookie
      const hostRes = await fetch(`${base}/api/auth/host-session`, {
        method: 'POST',
        headers: { 'X-Host-Token': hostToken },
      });
      assert.equal(hostRes.status, 200);
      const json = await hostRes.json();
      assert.equal(json.success, true);
      assert.ok(json.data.token);

      const cookieHeader = hostRes.headers.get('set-cookie');
      assert.ok(cookieHeader && cookieHeader.includes('utrans_session='));
      assert.ok(cookieHeader.includes('HttpOnly'));
      assert.ok(cookieHeader.includes('SameSite=Strict'));

      // 3. Host can access /api/shared directly with X-Host-Token
      const sharedWithHost = await fetch(`${base}/api/shared`, {
        headers: { 'X-Host-Token': hostToken },
      });
      assert.equal(sharedWithHost.status, 200);

      // 4. Unauthenticated request to /api/shared is blocked 401
      const unauthRes = await fetch(`${base}/api/shared`);
      assert.equal(unauthRes.status, 401);

      // 5. Request with the issued session cookie (tab 2 scenario) passes 200
      const cookieValue = cookieHeader.split(';')[0];
      const sharedWithCookie = await fetch(`${base}/api/shared`, {
        headers: { Cookie: cookieValue },
      });
      assert.equal(sharedWithCookie.status, 200);
    });
  });

  /* ==========================================================================
     R4: Simple upload respects runtime maxFileSize and returns 413
     ========================================================================== */
  describe('R4: Simple upload enforces runtime maxFileSize', () => {
    it('returns 413 and cleans pending files when upload exceeds runtime limit', async () => {
      // runtime was created with maxFileSize: 64 bytes
      const boundary = '----TestBoundary' + Date.now();
      const largePayload = Buffer.alloc(128, 'x'); // 128 bytes > 64 bytes limit

      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="too-large.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`
        ),
        largePayload,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const res = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'X-Host-Token': hostToken,
        },
        body,
      });

      assert.equal(res.status, 413);
      const json = await res.json();
      assert.equal(json.error?.code, 'FILE_TOO_LARGE');

      // Verify no dangling files remain in pending directory
      const pendingDir = path.join(runtime.config.tempDir, 'pending');
      let entries = [];
      try {
        entries = await fs.readdir(pendingDir);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      assert.equal(entries.length, 0, 'Pending directory must remain clean after 413');
    });

    it('fails verification if pending directory contains lingering files', async () => {
      const lingeringDir = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-lingering-'));
      await fs.writeFile(path.join(lingeringDir, 'dangling.bin'), 'leftover');

      const verifyClean = async (dir) => {
        let entries = [];
        try {
          entries = await fs.readdir(dir);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        assert.equal(entries.length, 0, 'Pending directory must remain clean');
      };

      await assert.rejects(
        async () => verifyClean(lingeringDir),
        (err) => err instanceof assert.AssertionError
      );

      await fs.rm(lingeringDir, { recursive: true, force: true });
    });

    it('accepts file within runtime maxFileSize', async () => {
      const boundary = '----TestBoundarySmall' + Date.now();
      const smallPayload = Buffer.alloc(32, 'a'); // 32 bytes <= 64 bytes limit

      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="small.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`
        ),
        smallPayload,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const res = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'X-Host-Token': hostToken,
        },
        body,
      });

      assert.equal(res.status, 201);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.uploaded.length, 1);
    });
  });

  /* ==========================================================================
     R5: Shutdown deadline covers cleanup timeout
     ========================================================================== */
  describe('R5: Shutdown deadline covers full cleanup lifecycle', () => {
    it('enforces deadline when cleanup hangs and returns timedOut: true without stalling', async () => {
      const slowRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-slow-stop-'));
      const slowRuntime = createRuntime({
        tempDir: path.join(slowRoot, 'temp'),
        uploadDir: path.join(slowRoot, 'received'),
      });
      const slowApp = createServer(slowRuntime);
      const slowServer = slowApp.listen(0, '127.0.0.1');
      await once(slowServer, 'listening');
      slowRuntime.setListenPort(slowServer.address().port);
      slowRuntime.attach({ server: slowServer });

      // Inject simulated slow cleanup into chunkedUploadManager
      slowRuntime.chunkedUploadManager.cleanup = () =>
        new Promise((resolve) => setTimeout(resolve, 200));

      const startTime = Date.now();
      const result = await slowRuntime.stop({ timeoutMs: 30 });
      const elapsed = Date.now() - startTime;

      assert.equal(
        result.timedOut,
        true,
        'Must report timedOut: true when cleanup exceeds deadline'
      );
      assert.equal(result.stopped, false, 'Must report stopped: false when timed out');
      assert.ok(elapsed < 150, `Stop must resolve within finite bound; elapsed: ${elapsed}ms`);

      await fs.rm(slowRoot, { recursive: true, force: true });
    });

    it('continues independent cleanup and reports stopped: false when a task rejects', async () => {
      const errRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-err-stop-'));
      const errRuntime = createRuntime({
        tempDir: path.join(errRoot, 'temp'),
        uploadDir: path.join(errRoot, 'received'),
      });
      const errApp = createServer(errRuntime);
      const errServer = errApp.listen(0, '127.0.0.1');
      await once(errServer, 'listening');
      errRuntime.setListenPort(errServer.address().port);
      errRuntime.attach({ server: errServer });

      // Issue a session to verify sessions.revokeAll is executed even if chunked cleanup rejects
      errRuntime.sessions.issue();
      assert.equal(errRuntime.sessions.size(), 1);

      let pendingCleaned = false;
      errRuntime.pendingUploadManager.cleanup = async () => {
        pendingCleaned = true;
      };

      // Simulated immediate rejection
      const simulatedError = new Error('EACCES: permission denied');
      errRuntime.chunkedUploadManager.cleanup = async () => {
        throw simulatedError;
      };

      const result = await errRuntime.stop({ timeoutMs: 100 });
      assert.equal(result.timedOut, false);
      assert.equal(result.stopped, false, 'Must not report stopped: true when cleanup rejects');
      assert.ok(result.error, 'Must report the cleanup error');
      assert.equal(pendingCleaned, true, 'Pending upload manager must still be cleaned up');
      assert.equal(errRuntime.sessions.size(), 0, 'Sessions must still be revoked');

      // Repeated stop must be idempotent and preserve status
      const repeatResult = await errRuntime.stop({ timeoutMs: 100 });
      assert.equal(repeatResult.stopped, false);
      assert.equal(repeatResult.timedOut, false);

      await fs.rm(errRoot, { recursive: true, force: true });
    });

    it('handles never-resolving cleanup in a child process without hanging or code 13', async () => {
      const script = `
        import { createRuntime } from './src/runtime.js';
        import { createServer } from './src/server.js';
        import os from 'node:os';
        import fs from 'node:fs/promises';
        import path from 'node:path';
        import { once } from 'node:events';

        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-hang-test-'));
        const runtime = createRuntime({
          tempDir: path.join(root, 'temp'),
          uploadDir: path.join(root, 'received'),
        });
        const app = createServer(runtime);
        const server = app.listen(0, '127.0.0.1');
        await once(server, 'listening');
        runtime.setListenPort(server.address().port);
        runtime.attach({ server });

        // Never-resolving cleanup
        runtime.chunkedUploadManager.cleanup = () => new Promise(() => {});

        const res = await runtime.stop({ timeoutMs: 40 });
        console.log('STOP_RESULT:' + JSON.stringify(res));
        await fs.rm(root, { recursive: true, force: true });
        process.exit(0);
      `;

      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(),
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      const [exitCode] = await once(child, 'exit');
      assert.equal(exitCode, 0, `Child process should exit code 0, stderr: ${stderr}`);
      assert.ok(stdout.includes('STOP_RESULT:{"stopped":false,"timedOut":true}'));
    });
  });
});
