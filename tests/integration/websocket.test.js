import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../../src/server.js';
import { shareManager } from '../../src/services/share-manager.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('WebSocket Server Integration Tests', () => {
  let serverInstance;
  let baseUrl;
  let wsUrl;
  let tempDir;
  let sampleFile;

  before(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-ws-test-'));
    sampleFile = path.join(tempDir, 'test_share.txt');
    await fs.promises.writeFile(sampleFile, 'SAMPLE_DATA_FOR_WS');

    serverInstance = await startServer({
      port: 0,
      host: '127.0.0.1',
      noBrowser: true,
      tempDir,
      uploadDir: path.join(tempDir, 'uploads'),
    });

    const addr = serverInstance.server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
    wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
  });

  after(async () => {
    if (serverInstance?.wss) {
      for (const client of serverInstance.wss.clients) {
        client.terminate();
      }
      serverInstance.wss.close();
    }
    if (serverInstance?.server) {
      await new Promise((resolve) => serverInstance.server.close(resolve));
    }
    shareManager.clear();
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('should accept WebSocket connection and handle client:register', async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const registeredPromise = new Promise((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === 'client:registered') {
          resolve(msg.data);
        }
      });
    });

    ws.send(
      JSON.stringify({
        event: 'client:register',
        data: {
          deviceId: 'dev_test_alpha',
          deviceName: 'Pixel 8 Pro',
          platform: 'android',
        },
      })
    );

    const data = await registeredPromise;
    assert.equal(data.deviceId, 'dev_test_alpha');
    assert.equal(data.device.deviceName, 'Pixel 8 Pro');
    assert.ok(Array.isArray(data.devices));
    assert.ok(data.devices.some((d) => d.deviceId === 'dev_test_alpha'));

    ws.close();
  });

  it('should respond to client:ping with server:pong', async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise((resolve) => ws.on('open', resolve));

    const pongPromise = new Promise((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === 'server:pong') {
          resolve(msg.data);
        }
      });
    });

    ws.send(JSON.stringify({ event: 'client:ping' }));

    const pongData = await pongPromise;
    assert.ok(pongData.timestamp);
    assert.ok(typeof pongData.onlineDevices === 'number');

    ws.close();
  });

  it('should broadcast device:join and device:leave to other clients', async () => {
    const wsClient1 = new WebSocket(wsUrl);
    await new Promise((resolve) => wsClient1.on('open', resolve));

    // Register client 1
    wsClient1.send(
      JSON.stringify({
        event: 'client:register',
        data: { deviceId: 'dev_client_1', deviceName: 'Laptop', platform: 'windows' },
      })
    );

    // Prepare client 1 to listen for client 2's join and leave
    let joinPromiseResolve;
    const joinPromise = new Promise((resolve) => {
      joinPromiseResolve = resolve;
    });

    let leavePromiseResolve;
    const leavePromise = new Promise((resolve) => {
      leavePromiseResolve = resolve;
    });

    wsClient1.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'device:join' && msg.data.device.deviceId === 'dev_client_2') {
        joinPromiseResolve(msg.data);
      }
      if (msg.event === 'device:leave' && msg.data.deviceId === 'dev_client_2') {
        leavePromiseResolve(msg.data);
      }
    });

    // Connect client 2
    const wsClient2 = new WebSocket(wsUrl);
    await new Promise((resolve) => wsClient2.on('open', resolve));

    wsClient2.send(
      JSON.stringify({
        event: 'client:register',
        data: { deviceId: 'dev_client_2', deviceName: 'iPhone 15', platform: 'ios' },
      })
    );

    const joinData = await joinPromise;
    assert.equal(joinData.device.deviceId, 'dev_client_2');
    assert.equal(joinData.device.deviceName, 'iPhone 15');

    // Close client 2 and verify leave broadcast
    wsClient2.close();
    const leaveData = await leavePromise;
    assert.equal(leaveData.deviceId, 'dev_client_2');

    wsClient1.close();
  });

  it('should broadcast share:update when files are staged via POST /api/share', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.on('open', resolve));

    const shareUpdatePromise = new Promise((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === 'share:update') {
          resolve(msg.data);
        }
      });
    });

    // Stage a file via JSON paths
    const res = await fetch(`${baseUrl}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [sampleFile] }),
    });

    assert.equal(res.status, 201);

    const updateData = await shareUpdatePromise;
    assert.ok(Array.isArray(updateData.files));
    assert.ok(updateData.files.some((f) => f.name === 'test_share.txt'));

    ws.close();
  });
});
