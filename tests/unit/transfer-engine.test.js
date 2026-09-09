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
});
