/**
 * RelayInbox (M4 / UT-023) — the receiver's client-side half.
 *
 * The property that matters: the download capability handed out at decision time must
 * survive in this device's own storage, because the server only ever sends it once, and
 * a plain `<a download>` cannot carry a header.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, findByClass, makeElement } from '../helpers/fake-dom.js';
import { RelayInbox } from '../../public/js/relay-inbox.js';

const realFetch = globalThis.fetch;
const TOKEN = 'a'.repeat(64);

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

describe('RelayInbox (UT-023)', () => {
  let dom;
  let inbox;
  let calls;
  let respond;

  beforeEach(() => {
    dom = installFakeDom();
    globalThis.sessionStorage = memoryStorage();
    calls = [];
    respond = () => jsonResponse({ data: {} });
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url, options });
      return respond(url, options);
    };
    inbox = new RelayInbox();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete globalThis.sessionStorage;
    dom.restore();
  });

  it('keeps each file’s capability under its own relay and index', () => {
    inbox.rememberTokens('rl_1', [
      { index: 0, relayToken: TOKEN },
      { index: 1, relayToken: null },
    ]);
    inbox.rememberTokens('rl_2', [{ index: 0, relayToken: 'b'.repeat(64) }]);

    assert.equal(inbox.tokenFor('rl_1', 0), TOKEN);
    assert.equal(inbox.tokenFor('rl_1', 1), null);
    assert.equal(inbox.tokenFor('rl_2', 0), 'b'.repeat(64));
    assert.equal(inbox.tokenFor('rl_missing', 0), null);
  });

  it('puts the capability in the download URL only when it is held', () => {
    inbox.rememberTokens('rl_1', [{ index: 0, relayToken: TOKEN }]);

    assert.equal(
      inbox.downloadUrl({ relayId: 'rl_1', fileIndex: 0, fileId: 'f_1' }),
      `/api/download/f_1?rt=${TOKEN}`
    );
    assert.equal(
      inbox.downloadUrl({ relayId: 'rl_9', fileIndex: 0, fileId: 'f_2' }),
      '/api/download/f_2'
    );
  });

  it('loads the files addressed to this device', async () => {
    respond = () =>
      jsonResponse({ data: { files: [{ fileId: 'f_1', name: 'a.bin', relayId: 'rl_1' }] } });

    const files = await inbox.load();
    assert.equal(calls[0].url, '/api/relay/incoming');
    assert.equal(files.length, 1);
    assert.equal(inbox.files[0].fileId, 'f_1');
  });

  it('keeps the last known list when the refresh fails', async () => {
    respond = () => jsonResponse({ data: { files: [{ fileId: 'f_1' }] } });
    await inbox.load();

    respond = () => jsonResponse({ error: { message: 'boom' } }, 500);
    const files = await inbox.load();
    assert.equal(files.length, 1, 'a failed refresh must not empty the inbox');
    assert.equal(inbox.files[0].fileId, 'f_1');
  });

  it('posts a decision and remembers the capabilities it gets back', async () => {
    respond = () =>
      jsonResponse({
        data: {
          relayId: 'rl_1',
          files: [{ index: 0, decision: 'accepted', grantId: 'gr_1', relayToken: TOKEN }],
        },
      });

    const result = await inbox.decide('rl_1', [{ index: 0, action: 'accept' }]);

    assert.equal(calls[0].url, '/api/relay/decision');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      relayId: 'rl_1',
      decisions: [{ index: 0, action: 'accept' }],
    });
    assert.equal(result.files[0].grantId, 'gr_1');
    assert.equal(inbox.tokenFor('rl_1', 0), TOKEN);
  });

  it('surfaces a refused decision instead of pretending it worked', async () => {
    respond = () => jsonResponse({ error: { message: 'Relay belongs to another receiver' } }, 403);

    await assert.rejects(
      () => inbox.decide('rl_1', [{ index: 0, action: 'accept' }]),
      /another receiver/
    );
    assert.equal(inbox.tokenFor('rl_1', 0), null);
  });

  it('renders an empty state when nothing is waiting', () => {
    const container = makeElement('div');
    inbox.renderInto(container);

    assert.equal(container.children.length, 2);
    assert.equal(findByClass(container, 'relay-inbox-item').length, 0);
    assert.ok(container.textContent.includes('Nothing waiting'));
  });

  it('renders one downloadable row per waiting file', () => {
    inbox.rememberTokens('rl_1', [{ index: 0, relayToken: TOKEN }]);
    inbox.files = [
      {
        fileId: 'f_1',
        relayId: 'rl_1',
        fileIndex: 0,
        name: 'photo.jpg',
        size: 2048,
        storedAt: Date.now(),
        expiresAt: Date.now() + 60000,
        sender: { label: 'Sender phone' },
      },
    ];

    const container = makeElement('div');
    inbox.renderInto(container);

    const items = findByClass(container, 'relay-inbox-item');
    assert.equal(items.length, 1);

    const anchor = findByClass(container, 'btn--primary').find((el) => el.tagName === 'A');
    assert.ok(anchor, 'the row needs a download link');
    assert.equal(anchor.getAttribute('href'), `/api/download/f_1?rt=${TOKEN}`);
    assert.equal(anchor.getAttribute('download'), 'photo.jpg');
    assert.ok(container.textContent.includes('Sender phone'));
  });
});
