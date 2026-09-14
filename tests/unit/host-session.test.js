import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { initializeHostSession, hostHeaders } from '../../public/js/host-session.js';

const previousWindow = globalThis.window;
const previousStorage = globalThis.sessionStorage;
let storage, replacedUrl;
beforeEach(() => {
  storage = new Map();
  replacedUrl = null;
  globalThis.sessionStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
  };
  globalThis.window = {
    location: { hash: '#host-token=private-capability', pathname: '/', search: '' },
    history: {
      replaceState: (_state, _title, url) => {
        replacedUrl = url;
      },
    },
  };
});
afterEach(() => {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  if (previousStorage === undefined) delete globalThis.sessionStorage;
  else globalThis.sessionStorage = previousStorage;
});

it('captures host capability per tab and removes it from the navigable URL', () => {
  initializeHostSession();
  assert.equal(replacedUrl, '/#files');
  assert.equal(hostHeaders()['X-Host-Token'], 'private-capability');
  globalThis.window.location.hash = '#files';
  initializeHostSession();
  assert.equal(hostHeaders()['X-Host-Token'], 'private-capability');
});

it('a guest opening a public route gains no capability', () => {
  globalThis.window.location.hash = '#upload';
  initializeHostSession();
  assert.equal(hostHeaders()['X-Host-Token'], '');
  assert.equal(replacedUrl, null);
});
