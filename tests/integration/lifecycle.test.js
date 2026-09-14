/**
 * UT-010 — lifecycle: stop within a deadline with sockets open, no signal handlers
 * inside the server module, clear port-in-use failure, and instance-file ownership.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createRuntime } from '../../src/runtime.js';
import { createServer, startServer } from '../../src/server.js';
import { setupWebSocket } from '../../src/websocket/index.js';
import {
  instanceFilePath,
  isInstanceAlive,
  readInstanceFile,
  removeInstanceFile,
  writeInstanceFile,
} from '../../src/utils/instance-file.js';

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

describe('UT-010: runtime lifecycle', () => {
  it('stops within the deadline while a WebSocket client is open', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-lifecycle-'));
    const runtime = createRuntime({
      tempDir: path.join(root, 'temp'),
      uploadDir: path.join(root, 'received'),
      port: 0,
    });
    const app = createServer(runtime);
    const server = await listen(app);
    runtime.setListenPort(server.address().port);

    const wss = setupWebSocket(server, {
      hostAuth: app.locals.hostAuth,
      sessions: app.locals.sessions,
      pinRequired: app.locals.pinRequired,
      discovery: runtime.discovery,
    });
    app.set('wss', wss);
    runtime.attach({ server, wss });

    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ event: 'client:register', data: { deviceName: 'lifecycle' } }));
    await once(ws, 'message');

    const started = Date.now();
    const result = await runtime.stop({ timeoutMs: 3000 });
    const elapsed = Date.now() - started;

    assert.equal(result.timedOut, false);
    assert.equal(result.stopped, true);
    assert.ok(elapsed < 3000, `stop took ${elapsed}ms`);
    assert.equal(server.listening, false);

    // The server terminates the socket; the client learns asynchronously.
    if (ws.readyState === WebSocket.OPEN) {
      await Promise.race([once(ws, 'close'), new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    assert.equal(ws.readyState, WebSocket.CLOSED);

    // Calling stop twice must be safe and idempotent.
    const second = await runtime.stop({ timeoutMs: 1000 });
    assert.equal(second.stopped, true);

    await fs.rm(root, { recursive: true, force: true });
  });

  it('never installs process signal handlers from the server module', async () => {
    const before = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    };

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-signals-'));
    const instance = await startServer({
      port: 0,
      host: '127.0.0.1',
      noBrowser: true,
      tempDir: path.join(root, 'temp'),
      uploadDir: path.join(root, 'received'),
    });

    assert.equal(process.listenerCount('SIGINT'), before.SIGINT);
    assert.equal(process.listenerCount('SIGTERM'), before.SIGTERM);

    const stopped = await instance.runtime.stop({ timeoutMs: 3000 });
    assert.equal(stopped.timedOut, false);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports a clear PORT_IN_USE error instead of crashing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-port-'));
    const first = await startServer({
      port: 0,
      host: '127.0.0.1',
      noBrowser: true,
      tempDir: path.join(root, 'temp'),
      uploadDir: path.join(root, 'received'),
    });
    const takenPort = first.runtime.port;

    await assert.rejects(
      startServer({
        port: takenPort,
        host: '127.0.0.1',
        noBrowser: true,
        tempDir: path.join(root, 'temp2'),
        uploadDir: path.join(root, 'received2'),
      }),
      (err) => err.code === 'PORT_IN_USE' && err.statusCode === 409
    );

    await first.runtime.stop({ timeoutMs: 3000 });
    await fs.rm(root, { recursive: true, force: true });
  });

  it('records the owning pid so a launcher can stop exactly this instance', async () => {
    const port = 65001;
    removeInstanceFile(port);
    assert.equal(readInstanceFile(port), null);

    const written = writeInstanceFile({ port, pid: process.pid, tempDir: '/tmp/utrans-recorded' });
    assert.equal(written, instanceFilePath(port));

    const record = readInstanceFile(port);
    assert.equal(record.port, port);
    assert.equal(record.pid, process.pid);
    assert.equal(record.tempDir, '/tmp/utrans-recorded');
    assert.ok(Date.parse(record.startedAt) > 0);
    assert.equal(isInstanceAlive(record), true, 'the current process is alive');
    assert.equal(isInstanceAlive({ pid: 999999999 }), false);
    assert.equal(isInstanceAlive(null), false);

    assert.equal(removeInstanceFile(port), true);
    assert.equal(removeInstanceFile(port), false);
    assert.equal(readInstanceFile(port), null);
  });
});
