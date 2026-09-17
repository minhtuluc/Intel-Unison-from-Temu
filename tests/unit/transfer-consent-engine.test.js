/**
 * UT-012 — the sender side of host consent.
 *
 * These cases stub `fetch` rather than the engine, so the real request shapes,
 * header handling and decision mapping are what gets exercised. The property that
 * matters: a task must not reach the upload path until a grant comes back.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TransferEngine } from '../../public/js/transfer.js';

const realFetch = globalThis.fetch;

/** @param {object} body */
function offerResponse(body, status = 201) {
  return { ok: status < 400, status, json: async () => body };
}

function decision(index, decision, grantId) {
  return { index, name: `f${index}.bin`, size: 10, decision, grantId };
}

describe('UT-012 TransferEngine consent', () => {
  let engine;
  let calls;
  let respond;

  beforeEach(() => {
    calls = [];
    respond = () => offerResponse({ success: true, data: {} });
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url, options });
      return respond(url, options);
    };

    engine = new TransferEngine({ maxConcurrent: 3, chunkSize: 10 * 1024 * 1024 });
    // Uploads themselves are out of scope here; the consent handshake is the subject.
    engine._startUpload = async () => {};
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    engine.dispose();
  });

  const file = (name, size) => ({ name, size, type: 'application/octet-stream' });

  it('announces the batch instead of uploading it', async () => {
    respond = () =>
      offerResponse({
        success: true,
        data: {
          offer: { offerId: 'of_1', state: 'pending' },
          autoApproved: false,
          decisions: [decision(0, 'pending', null)],
        },
      });

    const [task] = engine.addFiles([file('a.bin', 10)]);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/transfer/offer');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      files: [{ name: 'a.bin', size: 10, mimeType: 'application/octet-stream' }],
    });

    // Waiting on the host: no upload, no queue slot, no bytes.
    assert.equal(task.status, 'awaiting_consent');
    assert.equal(engine.queue.length, 0);
    assert.equal(engine.activeTransfers.size, 0);
  });

  it('binds the offer request to the server-issued connection identity', async () => {
    engine.connectionId = 'conn_sender_1';
    respond = () =>
      offerResponse({
        success: true,
        data: {
          offer: { offerId: 'of_bound', state: 'pending' },
          autoApproved: false,
          decisions: [decision(0, 'pending', null)],
        },
      });

    engine.addFiles([file('bound.bin', 10)]);
    await new Promise((resolve) => setImmediate(resolve));

    const headers = new Headers(calls[0].options.headers);
    assert.equal(headers.get('X-Connection-Id'), 'conn_sender_1');
  });

  it('queues an approved file with the grant the host issued', async () => {
    respond = () =>
      offerResponse({
        success: true,
        data: {
          offer: { offerId: 'of_1', state: 'decided' },
          autoApproved: false,
          decisions: [decision(0, 'approved', 'gr_abc')],
        },
      });

    const [task] = engine.addFiles([file('a.bin', 10)]);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(task.grantId, 'gr_abc');
    assert.equal(task.offerId, 'of_1');
    assert.notEqual(task.status, 'awaiting_consent');
    assert.equal(engine.consentPending.length, 0);
  });

  it('starts the upload immediately when the device is trusted', async () => {
    respond = () =>
      offerResponse({
        success: true,
        data: {
          offer: { offerId: 'of_1', state: 'decided' },
          autoApproved: true,
          decisions: [decision(0, 'approved', 'gr_trusted')],
        },
      });

    const [task] = engine.addFiles([file('a.bin', 10)]);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(task.grantId, 'gr_trusted');
    assert.equal(task.status, 'uploading');
  });

  it('marks a declined file without ever uploading it', async () => {
    respond = () =>
      offerResponse({
        success: true,
        data: {
          offer: { offerId: 'of_1', state: 'decided' },
          autoApproved: false,
          decisions: [decision(0, 'rejected', null)],
        },
      });

    const [task] = engine.addFiles([file('a.bin', 10)]);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(task.status, 'rejected');
    assert.equal(task.error, 'Declined by the PC user');
    assert.equal(engine.failedTransfers.includes(task), true);
    assert.equal(engine.queue.length, 0);
    assert.equal(engine.consentPending.length, 0);
    // Only the offer was ever sent; no upload request was made.
    assert.equal(calls.length, 1);
  });

  it('decides each file of a batch independently', async () => {
    respond = () =>
      offerResponse({
        success: true,
        data: {
          offer: { offerId: 'of_1', state: 'decided' },
          autoApproved: false,
          decisions: [decision(0, 'approved', 'gr_0'), decision(1, 'rejected', null)],
        },
      });

    const tasks = engine.addFiles([file('keep.bin', 10), file('drop.bin', 10)]);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(tasks[0].grantId, 'gr_0');
    assert.equal(tasks[1].status, 'rejected');
  });

  it('applies a decision delivered over the WebSocket', async () => {
    respond = () =>
      offerResponse({
        success: true,
        data: {
          offer: { offerId: 'of_9', state: 'pending' },
          autoApproved: false,
          decisions: [decision(0, 'pending', null)],
        },
      });

    const [task] = engine.addFiles([file('a.bin', 10)]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(task.status, 'awaiting_consent');

    engine.handleWebSocketEvent('transfer:offer:decision', {
      offerId: 'of_9',
      decisions: [decision(0, 'approved', 'gr_ws')],
    });

    assert.equal(task.grantId, 'gr_ws');
    assert.notEqual(task.status, 'awaiting_consent');
  });

  it('fails a task whose offer expires', async () => {
    respond = () =>
      offerResponse({
        success: true,
        data: {
          offer: { offerId: 'of_9', state: 'pending' },
          autoApproved: false,
          decisions: [decision(0, 'pending', null)],
        },
      });

    const [task] = engine.addFiles([file('a.bin', 10)]);
    await new Promise((resolve) => setImmediate(resolve));

    engine.handleWebSocketEvent('transfer:offer:expired', { offerId: 'of_9' });

    assert.equal(task.status, 'error');
    assert.equal(task.error, 'Approval timed out');
    assert.equal(engine.consentPending.length, 0);
  });

  it('reports a failed handshake instead of uploading without consent', async () => {
    respond = () => offerResponse({ success: false, error: { message: 'nope' } }, 500);

    const [task] = engine.addFiles([file('a.bin', 10)]);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(task.status, 'error');
    assert.match(task.error, /Could not ask the host/);
    assert.equal(engine.queue.length, 0);
  });

  it('ignores a decision for an offer it knows nothing about', () => {
    assert.doesNotThrow(() => {
      engine.handleWebSocketEvent('transfer:offer:decision', {
        offerId: 'of_unknown',
        decisions: [decision(0, 'approved', 'gr_x')],
      });
    });
  });

  it('lets a cancelled consent-pending file stop waiting', async () => {
    respond = () =>
      offerResponse({
        success: true,
        data: {
          offer: { offerId: 'of_9', state: 'pending' },
          autoApproved: false,
          decisions: [decision(0, 'pending', null)],
        },
      });

    const [task] = engine.addFiles([file('a.bin', 10)]);
    await new Promise((resolve) => setImmediate(resolve));

    engine.cancel(task.id);

    assert.equal(task.status, 'cancelled');
    assert.equal(engine.consentPending.length, 0);
  });

  it('asks the host again when retrying a file that holds no grant', async () => {
    respond = () =>
      offerResponse({
        success: true,
        data: {
          offer: { offerId: 'of_1', state: 'decided' },
          autoApproved: false,
          decisions: [decision(0, 'rejected', null)],
        },
      });

    const [task] = engine.addFiles([file('a.bin', 10)]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(task.status, 'rejected');

    respond = () =>
      offerResponse({
        success: true,
        data: {
          offer: { offerId: 'of_2', state: 'decided' },
          autoApproved: false,
          decisions: [decision(0, 'approved', 'gr_retry')],
        },
      });

    await engine.retry(task.id);

    assert.equal(calls.filter((c) => c.url === '/api/transfer/offer').length, 2);
    assert.equal(task.grantId, 'gr_retry');
    assert.equal(task.error, null);
  });

  it('exposes consent-pending files as active work so the UI can show them', () => {
    respond = () =>
      offerResponse({
        success: true,
        data: {
          offer: { offerId: 'of_1', state: 'pending' },
          autoApproved: false,
          decisions: [decision(0, 'pending', null)],
        },
      });

    const [task] = engine.addFiles([file('a.bin', 10)]);
    const status = engine.getStatus();

    assert.equal(status.awaitingConsent.length, 1);
    assert.equal(status.active.includes(task), true);
  });
});

/**
 * M4 — the same engine, but the chosen receiver decides instead of the host.
 * The property: a relay task must not upload until the receiver accepts, and the grant
 * it uploads with must be the one the receiver issued.
 */
describe('M4 TransferEngine relay consent', () => {
  let engine;
  let calls;
  let respond;

  beforeEach(() => {
    calls = [];
    respond = () => offerResponse({ success: true, data: {} });
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url, options });
      return respond(url, options);
    };

    engine = new TransferEngine({ maxConcurrent: 3, chunkSize: 10 * 1024 * 1024 });
    engine._startUpload = async () => {};
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    engine.dispose();
  });

  const file = (name, size) => ({ name, size, type: 'application/octet-stream' });

  const relayOfferResponse = (relayId = 'rl_1') =>
    offerResponse({
      success: true,
      data: { relay: { relayId, state: 'pending', receiver: { deviceId: 'dev_b' } } },
    });

  function relayDecision(index, decision, grantId) {
    return { index, name: `f${index}.bin`, size: 10, decision, grantId };
  }

  it('opens a relay with the chosen device instead of a host offer', async () => {
    respond = () => relayOfferResponse();

    const [task] = engine.addFiles([file('a.bin', 10)], { receiverDeviceId: 'dev_b' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/relay/offer');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      receiverDeviceId: 'dev_b',
      files: [{ name: 'a.bin', size: 10, mimeType: 'application/octet-stream' }],
    });
    assert.equal(task.relayId, 'rl_1');
    assert.equal(task.status, 'awaiting_consent');
    assert.equal(engine.queue.length, 0);
  });

  it('falls back to the host flow when no receiver is chosen', async () => {
    respond = () =>
      offerResponse({
        success: true,
        data: {
          offer: { offerId: 'of_1', state: 'pending' },
          autoApproved: false,
          decisions: [relayDecision(0, 'pending', null)],
        },
      });

    engine.addFiles([file('a.bin', 10)]);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls[0].url, '/api/transfer/offer');
  });

  it('queues a relay task only when the receiver accepts, with the receiver’s grant', async () => {
    respond = () => relayOfferResponse('rl_9');
    const [task] = engine.addFiles([file('a.bin', 10)], { receiverDeviceId: 'dev_b' });
    await new Promise((resolve) => setImmediate(resolve));

    engine.handleWebSocketEvent('relay:decision', {
      relayId: 'rl_9',
      files: [relayDecision(0, 'accepted', 'gr_relay')],
    });

    assert.equal(task.grantId, 'gr_relay');
    // The queue is drained immediately, so the task is already uploading (with the
    // upload itself stubbed out) rather than waiting for consent.
    assert.notEqual(task.status, 'awaiting_consent');
    assert.equal(engine.consentPending.length, 0);
    assert.equal(engine.activeTransfers.has(task.id), true);
  });

  it('rejects a relay task the receiver declined', async () => {
    respond = () => relayOfferResponse('rl_10');
    const [task] = engine.addFiles([file('a.bin', 10)], { receiverDeviceId: 'dev_b' });
    await new Promise((resolve) => setImmediate(resolve));

    engine.handleWebSocketEvent('relay:decision', {
      relayId: 'rl_10',
      files: [relayDecision(0, 'declined', null)],
    });

    assert.equal(task.grantId, null);
    assert.equal(engine.queue.length, 0);
    assert.equal(task.status, 'rejected');
  });

  it('ends a relay task when the receiver never answers', async () => {
    respond = () => relayOfferResponse('rl_11');
    const [task] = engine.addFiles([file('a.bin', 10)], { receiverDeviceId: 'dev_b' });
    await new Promise((resolve) => setImmediate(resolve));

    engine.handleWebSocketEvent('relay:offer:expired', { relayId: 'rl_11', reason: 'TIMEOUT' });

    assert.equal(task.status, 'error');
    assert.match(task.error, /did not answer/);
    assert.equal(engine.queue.length, 0);
  });

  it('reports a receiver that is offline as a failed task, not a silent hang', async () => {
    respond = () =>
      offerResponse(
        { success: false, error: { message: 'The selected receiver is not connected right now' } },
        409
      );

    const [task] = engine.addFiles([file('a.bin', 10)], { receiverDeviceId: 'dev_gone' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(task.status, 'error');
    assert.match(task.error, /not connected right now/);
    assert.equal(engine.consentPending.length, 0);
  });

  it('ignores a decision for a relay this engine never opened', () => {
    engine.handleWebSocketEvent('relay:decision', {
      relayId: 'rl_unknown',
      files: [relayDecision(0, 'accepted', 'gr_x')],
    });
    assert.equal(engine.queue.length, 0);
  });

  it('re-sends the relay when a failed task is retried', async () => {
    respond = () => relayOfferResponse('rl_12');
    const [task] = engine.addFiles([file('retry.bin', 10)], { receiverDeviceId: 'dev_b' });
    await new Promise((resolve) => setImmediate(resolve));

    engine.handleWebSocketEvent('relay:decision', {
      relayId: 'rl_12',
      files: [relayDecision(0, 'declined', null)],
    });
    assert.equal(task.status, 'rejected');

    respond = () => relayOfferResponse('rl_13');
    await engine.retry(task.id);

    assert.equal(calls.filter((c) => c.url === '/api/relay/offer').length, 2);
    assert.equal(task.relayId, 'rl_13');
    assert.equal(task.status, 'awaiting_consent');
  });
});
