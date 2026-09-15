import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TransferEngine } from '../../public/js/transfer.js';
import { formatEta } from '../../public/js/utils.js';

describe('TransferEngine (Unit)', () => {
  let engine;

  beforeEach(() => {
    engine = new TransferEngine({
      maxConcurrent: 3,
      chunkSize: 10 * 1024 * 1024,
    });
  });

  it('should initialize with expected defaults', () => {
    assert.equal(engine.maxConcurrent, 3);
    assert.equal(engine.chunkSize, 10 * 1024 * 1024);
    assert.equal(engine.queue.length, 0);
    assert.equal(engine.activeTransfers.size, 0);
  });

  it('should format ETA accurately in formatEta', () => {
    assert.equal(formatEta(0), '--');
    assert.equal(formatEta(-10), '--');
    assert.equal(formatEta(NaN), '--');
    assert.equal(formatEta(30), '30s');
    assert.equal(formatEta(90), '1m 30s');
    assert.equal(formatEta(3665), '1h 1m');
  });

  it('should add files to queue and identify small vs chunked files', () => {
    const smallFile = { name: 'photo.jpg', size: 5 * 1024 * 1024, type: 'image/jpeg' };
    const largeFile = { name: 'video.mp4', size: 250 * 1024 * 1024, type: 'video/mp4' };

    // Prevent actual network dispatch in test
    engine._startUpload = async () => {};

    const tasks = engine.addFiles([smallFile, largeFile]);
    assert.equal(tasks.length, 2);

    assert.equal(tasks[0].name, 'photo.jpg');
    assert.equal(tasks[0].isChunked, false);
    assert.equal(tasks[0].totalChunks, 1);

    assert.equal(tasks[1].name, 'video.mp4');
    assert.equal(tasks[1].isChunked, true);
    assert.equal(tasks[1].totalChunks, 25);
  });

  it('should calculate rolling speed and ETA over time samples', () => {
    const task = {
      speedSamples: [],
      speed: 0,
      speedFormatted: '0 B/s',
      eta: 0,
      etaFormatted: '--',
    };

    const now = Date.now();
    // Simulate sample 1 second ago at 10MB
    task.speedSamples.push({ time: now - 1000, bytes: 10 * 1024 * 1024 });

    // Current sample now at 30MB (20MB delta in 1 second)
    engine._updateSpeedAndEta(task, 30 * 1024 * 1024, 100 * 1024 * 1024);

    assert.ok(task.speed > 0);
    // Speed should be around 20MB/s
    const speedMB = task.speed / (1024 * 1024);
    assert.ok(speedMB >= 19 && speedMB <= 21, `Expected ~20MB/s, got ${speedMB}`);

    // Remaining: 70MB at 20MB/s -> ~3.5 seconds
    assert.ok(task.eta >= 3 && task.eta <= 4);
    assert.equal(task.etaFormatted, '4s');
  });

  it('should handle cancel and pause states', () => {
    const mockFile = { name: 'doc.pdf', size: 1000, type: 'application/pdf' };
    engine._startUpload = () => new Promise(() => {}); // never resolves

    const [task] = engine.addFiles([mockFile]);
    assert.equal(task.status, 'uploading');

    engine.pause(task.id);
    assert.equal(task.status, 'paused');
    assert.equal(engine.activeTransfers.has(task.id), false);

    engine.cancel(task.id);
    assert.equal(task.status, 'cancelled');
  });

  it('should match WebSocket transfer:complete event to task', () => {
    const task = {
      id: 'task_123',
      name: 'file.txt',
      size: 50,
      status: 'awaiting_approval',
      transferId: 'up_target_456',
    };
    engine.activeTransfers.set(task.id, task);

    engine.handleWebSocketEvent('transfer:complete', { transferId: 'up_target_456' });

    assert.equal(task.status, 'completed');
    assert.equal(engine.completedTransfers.length, 1);
    assert.equal(engine.activeTransfers.has(task.id), false);
  });

  it('should match WebSocket transfer:rejected event to task', () => {
    const task = {
      id: 'task_789',
      name: 'rejected.txt',
      size: 50,
      status: 'awaiting_approval',
      transferId: 'up_rej_999',
    };
    engine.activeTransfers.set(task.id, task);

    engine.handleWebSocketEvent('transfer:rejected', { transferId: 'up_rej_999' });

    assert.equal(task.status, 'error');
    assert.equal(task.error, 'Declined by PC user');
    assert.equal(engine.failedTransfers.length, 1);
  });

  it('UT-004: should decouple active uploading slots from awaiting_approval tasks', async () => {
    const engine2 = new TransferEngine({ maxConcurrent: 2 });
    const uploadResolvers = [];

    engine2._startUpload = (task) => {
      return new Promise((resolve) => {
        uploadResolvers.push({ task, resolve });
      });
    };

    const files = [
      { name: 'f1.txt', size: 100 },
      { name: 'f2.txt', size: 100 },
      { name: 'f3.txt', size: 100 },
      { name: 'f4.txt', size: 100 },
      { name: 'f5.txt', size: 100 },
    ];

    engine2.addFiles(files);
    assert.equal(engine2.activeTransfers.size, 2);
    assert.equal(engine2.queue.length, 3);

    // Simulate f1 and f2 finishing byte upload and entering awaiting_approval
    const { task: t1, resolve: r1 } = uploadResolvers[0];
    const { task: t2, resolve: r2 } = uploadResolvers[1];

    t1.transferId = 'tx_1';
    t1.status = 'awaiting_approval';
    engine2.activeTransfers.delete(t1.id);
    engine2.awaitingTransfers.set(t1.id, t1);
    r1(t1);
    engine2._processQueue();

    t2.transferId = 'tx_2';
    t2.status = 'awaiting_approval';
    engine2.activeTransfers.delete(t2.id);
    engine2.awaitingTransfers.set(t2.id, t2);
    r2(t2);
    engine2._processQueue();

    // Now f1 & f2 are awaiting approval, and f3 & f4 should immediately be uploading!
    assert.equal(engine2.awaitingTransfers.size, 2);
    assert.equal(engine2.activeTransfers.size, 2);
    assert.equal(engine2.queue.length, 1);

    const activeNames = Array.from(engine2.activeTransfers.values()).map((t) => t.name);
    assert.deepEqual(activeNames, ['f3.txt', 'f4.txt']);

    // When f3 finishes uploading bytes and awaits approval, f5 should start uploading
    const { task: t3, resolve: r3 } = uploadResolvers[2];
    t3.transferId = 'tx_3';
    t3.status = 'awaiting_approval';
    engine2.activeTransfers.delete(t3.id);
    engine2.awaitingTransfers.set(t3.id, t3);
    r3(t3);
    engine2._processQueue();

    assert.equal(engine2.awaitingTransfers.size, 3);
    assert.equal(engine2.activeTransfers.size, 2);
    assert.equal(engine2.queue.length, 0);
    const updatedActiveNames = Array.from(engine2.activeTransfers.values()).map((t) => t.name);
    assert.deepEqual(updatedActiveNames, ['f4.txt', 'f5.txt']);
  });

  it('UT-004: should buffer WebSocket event if it arrives before HTTP response sets transferId', () => {
    // 1. WS event arrives early
    engine.handleWebSocketEvent('transfer:complete', { transferId: 'early_tx_100' });
    assert.equal(engine.pendingWsDecisions.has('early_tx_100'), true);

    // 2. HTTP response returns later and sets task.transferId
    const task = {
      id: 'task_pending_early',
      name: 'fast.png',
      size: 500,
      status: 'uploading',
    };
    engine.activeTransfers.set(task.id, task);

    // Simulate HTTP response completion handler logic
    task.transferId = 'early_tx_100';
    task.status = 'awaiting_approval';
    engine.activeTransfers.delete(task.id);
    engine.awaitingTransfers.set(task.id, task);

    if (engine.pendingWsDecisions.has(task.transferId)) {
      const { event, data } = engine.pendingWsDecisions.get(task.transferId);
      engine.pendingWsDecisions.delete(task.transferId);
      engine.handleWebSocketEvent(event, data);
    }

    assert.equal(task.status, 'completed');
    assert.equal(engine.completedTransfers.length, 1);
    assert.equal(engine.awaitingTransfers.has(task.id), false);
    assert.equal(engine.pendingWsDecisions.has('early_tx_100'), false);
  });

  it('UT-004: should handle transfer:expired and transfer:rejected TIMEOUT terminal events', () => {
    const task1 = {
      id: 't_exp_1',
      name: 'expired1.txt',
      size: 10,
      status: 'awaiting_approval',
      transferId: 'tx_exp_1',
    };
    const task2 = {
      id: 't_exp_2',
      name: 'expired2.txt',
      size: 20,
      status: 'awaiting_approval',
      transferId: 'tx_exp_2',
    };

    engine.awaitingTransfers.set(task1.id, task1);
    engine.awaitingTransfers.set(task2.id, task2);

    // transfer:expired
    engine.handleWebSocketEvent('transfer:expired', { transferId: 'tx_exp_1' });
    assert.equal(task1.status, 'error');
    assert.equal(task1.error, 'Approval timed out');
    assert.equal(engine.awaitingTransfers.has(task1.id), false);

    // transfer:rejected with reason: 'TIMEOUT'
    engine.handleWebSocketEvent('transfer:rejected', {
      transferId: 'tx_exp_2',
      reason: 'TIMEOUT',
    });
    assert.equal(task2.status, 'error');
    assert.equal(task2.error, 'Approval timed out');
    assert.equal(engine.awaitingTransfers.has(task2.id), false);
  });

  it('UT-004: should reconcile awaiting transfers against server on reconnect', async () => {
    const origFetch = globalThis.fetch;
    try {
      const task = {
        id: 't_recon',
        name: 'recon.txt',
        size: 50,
        status: 'awaiting_approval',
        transferId: 'tx_recon_99',
      };
      engine.awaitingTransfers.set(task.id, task);

      // 1. Mock server reports completed
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { status: 'completed', fileName: 'recon.txt', size: 50 },
        }),
      });

      await engine.reconcileAwaitingTransfers();
      assert.equal(task.status, 'completed');
      assert.equal(engine.awaitingTransfers.has(task.id), false);
      assert.equal(engine.completedTransfers.length, 1);

      // 2. Mock server reports 404 (expired / purged)
      const task404 = {
        id: 't_recon_404',
        name: 'lost.txt',
        size: 50,
        status: 'awaiting_approval',
        transferId: 'tx_lost_404',
      };
      engine.awaitingTransfers.set(task404.id, task404);

      globalThis.fetch = async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: { code: 'TRANSFER_NOT_FOUND' } }),
      });

      await engine.reconcileAwaitingTransfers();
      assert.equal(task404.status, 'error');
      assert.equal(task404.error, 'Approval timed out');
      assert.equal(engine.awaitingTransfers.has(task404.id), false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('UT-009: should pause and not trigger chunk retry backoff loop', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url) => {
        if (url.includes('/api/upload/init')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: { uploadId: 'up_pause_test', chunkSize: 10, totalChunks: 3 },
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      };

      const largeFile = {
        name: 'test_large.bin',
        size: 30,
        type: 'application/octet-stream',
        slice: () => new Uint8Array(10),
      };

      const task = {
        id: 't_chunk_pause',
        file: largeFile,
        name: largeFile.name,
        size: largeFile.size,
        type: largeFile.type,
        status: 'uploading',
        isChunked: true,
        uploadId: null,
        transferId: null,
        currentChunk: 0,
        totalChunks: 3,
        chunkSize: 10,
        retries: 0,
        speedSamples: [],
        xhr: null,
        abortController: null,
        backoffTimer: null,
      };

      engine.activeTransfers.set(task.id, task);

      let chunkAttempts = 0;
      engine._uploadChunkWithProgress = async () => {
        chunkAttempts++;
        // Pause while inside chunk attempt
        engine.pause(task.id);
        throw new Error('Chunk upload aborted');
      };

      await engine._uploadChunked(task);

      assert.equal(task.status, 'paused');
      // Must not retry chunk upload!
      assert.equal(chunkAttempts, 1);
      assert.equal(engine.pausedTransfers.has(task.id), true);
      assert.equal(engine.activeTransfers.has(task.id), false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('UT-009: should cancel during backoff delay and notify server', async () => {
    const origFetch = globalThis.fetch;
    let cancelCalled = false;
    let cancelPayload = null;

    try {
      globalThis.fetch = async (url, options) => {
        if (url.includes('/api/upload/cancel')) {
          cancelCalled = true;
          cancelPayload = JSON.parse(options.body);
          return { ok: true, status: 200, json: async () => ({ success: true }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      };

      const task = {
        id: 't_cancel_backoff',
        name: 'doc.zip',
        size: 1000,
        status: 'uploading',
        isChunked: true,
        uploadId: 'up_to_cancel',
        backoffTimer: setTimeout(() => {}, 10000),
        abortController: new AbortController(),
      };
      engine.activeTransfers.set(task.id, task);

      engine.cancel(task.id);

      assert.equal(task.status, 'cancelled');
      assert.equal(task.backoffTimer, null);
      assert.equal(engine.activeTransfers.has(task.id), false);
      assert.equal(cancelCalled, true);
      assert.deepEqual(cancelPayload, { uploadId: 'up_to_cancel' });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('UT-009: should re-initialize session on resume if server session expired (404/410)', async () => {
    const origFetch = globalThis.fetch;
    try {
      // Server returns 410 Gone for expired session status
      globalThis.fetch = async () => ({
        ok: false,
        status: 410,
        json: async () => ({ error: { code: 'SESSION_EXPIRED' } }),
      });

      const task = {
        id: 't_resume_expired',
        name: 'video.mkv',
        size: 200 * 1024 * 1024,
        isChunked: true,
        uploadId: 'up_expired_123',
        currentChunk: 5,
        bytesUploaded: 50 * 1024 * 1024,
        progress: 25,
        status: 'paused',
      };
      engine.pausedTransfers.set(task.id, task);

      // Prevent upload start when queued
      engine._startUpload = async () => {};

      await engine.resume(task.id);

      assert.equal(task.uploadId, null);
      assert.equal(task.currentChunk, 0);
      assert.equal(task.bytesUploaded, 0);
      assert.equal(task.progress, 0);
      assert.equal(task.status, 'uploading');
      assert.ok(engine.activeTransfers.has(task.id));
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
