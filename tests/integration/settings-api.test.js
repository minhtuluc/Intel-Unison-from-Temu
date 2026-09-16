/**
 * M3 — settings, quota and history surfaces.
 *
 * The receive directory becomes mutable at runtime here, which is the one place
 * ADR-0002's "config is frozen" rule is deliberately relaxed, so the cases below
 * pin both what may change and what a client is allowed to see.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../../src/server.js';
import { approveUpload, offerBatch } from '../helpers/consent.js';

describe('M3 settings, quota and history', () => {
  let root;
  let serverInstance;
  let base;
  let runtime;
  let hostToken;
  let hostHeaders;
  const sockets = [];

  before(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-settings-'));
    serverInstance = await startServer({
      port: 0,
      host: '127.0.0.1',
      noBrowser: true,
      tempDir: path.join(root, 'temp'),
      uploadDir: path.join(root, 'received'),
      dataDir: path.join(root, 'data'),
      storageQuota: 4096,
    });
    runtime = serverInstance.runtime;
    base = `http://127.0.0.1:${serverInstance.server.address().port}`;
    hostToken = serverInstance.app.locals.hostAuth.token;
    hostHeaders = { 'X-Host-Token': hostToken };
  });

  after(async () => {
    for (const socket of sockets) socket.terminate();
    if (serverInstance?.wss) {
      for (const client of serverInstance.wss.clients) client.terminate();
      serverInstance.wss.close();
    }
    if (serverInstance?.server) {
      await new Promise((resolve) => serverInstance.server.close(resolve));
    }
    // stop() flushes the history write and clears its pending timer; skipping it
    // lets a debounced write land after the directory is removed.
    await runtime.stop();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  describe('GET /api/settings', () => {
    it('refuses clients and reports the paths to the host', async () => {
      assert.equal((await fetch(`${base}/api/settings`)).status, 403);

      const res = await fetch(`${base}/api/settings`, { headers: hostHeaders });
      assert.equal(res.status, 200);
      const { data } = await res.json();
      assert.equal(data.uploadDir, runtime.config.uploadDir);
      assert.equal(data.maxFileSize, runtime.config.maxFileSize);
      assert.equal(data.storageQuota, 4096);
    });
  });

  describe('PATCH /api/settings', () => {
    const patch = (body, headers = hostHeaders) =>
      fetch(`${base}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

    it('requires host authority', async () => {
      const res = await patch({ uploadDir: path.join(root, 'nope') }, {});
      assert.equal(res.status, 403);
    });

    it('accepts an absolute directory and creates it', async () => {
      const target = path.join(root, 'new-received');
      const res = await patch({ uploadDir: target });

      assert.equal(res.status, 200);
      assert.equal((await res.json()).data.uploadDir, target);
      assert.equal(runtime.config.uploadDir, target);
      assert.ok(fs.existsSync(target), 'the directory is created eagerly');
    });

    it('delivers the next consented file into the new directory', async () => {
      const target = path.join(root, 'new-received');
      const payload = 'delivered to the new place';

      const grantHeader = await approveUpload(base, {
        name: 'after-move.txt',
        data: payload,
        hostToken,
      });

      const form = new FormData();
      form.append('files', new Blob([payload]), 'after-move.txt');
      const res = await fetch(`${base}/api/upload`, {
        method: 'POST',
        body: form,
        headers: { 'X-Transfer-Grant': grantHeader },
      });
      assert.equal(res.status, 201);
      assert.equal(
        await fs.promises.readFile(path.join(target, 'after-move.txt'), 'utf8'),
        payload
      );
    });

    it('rejects a relative path, a missing field and unknown keys', async () => {
      for (const body of [
        { uploadDir: 'relative/dir' },
        {},
        { uploadDir: path.join(root, 'x'), maxFileSize: 1 },
      ]) {
        const res = await patch(body);
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      }
    });

    it('refuses a receive directory inside temp, which cleanup would delete', async () => {
      const res = await patch({ uploadDir: path.join(runtime.config.tempDir, 'received') });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, 'INVALID_UPLOAD_DIR');
      assert.notEqual(runtime.config.uploadDir, path.join(runtime.config.tempDir, 'received'));
    });

    it('refuses a receive directory that would contain temp', async () => {
      const res = await patch({ uploadDir: path.dirname(runtime.config.tempDir) });
      assert.equal(res.status, 400);
    });

    it('refuses a path that cannot be created', async () => {
      const filePath = path.join(root, 'not-a-dir');
      await fs.promises.writeFile(filePath, 'x', 'utf8');
      const res = await patch({ uploadDir: path.join(filePath, 'child') });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, 'INVALID_UPLOAD_DIR');
    });
  });

  describe('GET /api/quota', () => {
    it('reports usage as numbers and never as host paths', async () => {
      const res = await fetch(`${base}/api/quota`);
      assert.equal(res.status, 200);
      const { data } = await res.json();

      assert.equal(data.limitBytes, 4096);
      assert.equal(typeof data.usedBytes, 'number');
      assert.equal(typeof data.availableBytes, 'number');

      const raw = JSON.stringify(data);
      assert.equal(raw.includes(root), false, 'quota must not disclose host paths');
    });
  });

  describe('GET /api/transfers/history', () => {
    /** The server only accepts connection ids it issued, so register real sockets. */
    async function connect(label) {
      const ws = new WebSocket(`ws://127.0.0.1:${serverInstance.server.address().port}/ws`);
      sockets.push(ws);
      const events = [];
      ws.on('message', (raw) => events.push(JSON.parse(raw)));
      await new Promise((resolve) => ws.on('open', resolve));
      ws.send(
        JSON.stringify({
          event: 'client:register',
          data: { deviceName: label, platform: 'android' },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      return events.find((e) => e.event === 'client:registered').data.connectionId;
    }

    it('records a rejected offer so the decline is not invisible', async () => {
      const name = 'declined-by-host.bin';
      const result = await offerBatch(base, {
        files: [{ name, size: 5 }],
        approve: [],
        hostToken,
      });
      assert.equal(result.decisions[0].decision, 'rejected');

      const history = await fetch(`${base}/api/transfers/history`, { headers: hostHeaders });
      assert.equal(history.status, 200);
      const { data } = await history.json();
      const entry = data.entries.find((item) => item.fileName === name);
      assert.ok(entry, 'the rejected file appears in history');
      assert.equal(entry.status, 'rejected');
      assert.equal(entry.reason, 'REJECTED_BY_PC');
      assert.equal(data.scope, 'host');
    });

    it('shows a client only its own transfers', async () => {
      const ownerId = await connect('History Owner');
      const strangerId = await connect('History Stranger');
      assert.notEqual(ownerId, strangerId);

      const mine = 'mine-only.bin';
      await offerBatch(base, {
        files: [{ name: mine, size: 4 }],
        approve: [],
        connectionId: ownerId,
        hostToken,
      });

      const own = await fetch(`${base}/api/transfers/history`, {
        headers: { 'X-Connection-Id': ownerId },
      });
      const ownData = (await own.json()).data;
      assert.equal(ownData.scope, 'self');
      assert.ok(ownData.entries.some((entry) => entry.fileName === mine));
      assert.equal(
        ownData.entries.every((entry) => entry.connectionId === ownerId),
        true,
        'a client never sees another connection entries'
      );

      const stranger = await fetch(`${base}/api/transfers/history`, {
        headers: { 'X-Connection-Id': strangerId },
      });
      const strangerData = (await stranger.json()).data;
      assert.equal(
        strangerData.entries.some((entry) => entry.fileName === mine),
        false,
        'another connection must not see this transfer'
      );

      const host = await fetch(`${base}/api/transfers/history`, { headers: hostHeaders });
      assert.ok(
        (await host.json()).data.entries.some((entry) => entry.fileName === mine),
        'the host sees every transfer'
      );
    });

    it('never exposes host paths in history entries', async () => {
      const res = await fetch(`${base}/api/transfers/history`, { headers: hostHeaders });
      const raw = await res.text();
      assert.equal(raw.includes(runtime.config.uploadDir), false);
      assert.equal(raw.includes(runtime.config.tempDir), false);
    });
  });
});
