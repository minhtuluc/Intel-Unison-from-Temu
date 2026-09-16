/**
 * UT-016 — capability detection for the plain-HTTP LAN case.
 *
 * The failure mode this guards against is claiming a feature works because the API
 * name exists in `navigator`, when the call would actually reject. Each case sets
 * up the environment explicitly rather than assuming a browser.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeMissingCapabilities,
  getCapabilities,
  isSecureContextOk,
  supportsServiceWorker,
  supportsWakeLock,
} from '../../public/js/capabilities.js';

const saved = {
  isSecureContext: Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext'),
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
};

/** `navigator` is a getter-only global in modern Node, so it needs defineProperty. */
function defineGlobal(key, value) {
  if (value === undefined) {
    delete globalThis[key];
    return;
  }
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

function setGlobals({ secureContext, navigator, protocol }) {
  defineGlobal('isSecureContext', secureContext);
  defineGlobal('navigator', navigator);
  defineGlobal('window', protocol === undefined ? undefined : { location: { protocol } });
}

function restoreGlobals() {
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}

describe('UT-016 capability detection', () => {
  afterEach(restoreGlobals);

  it('treats a bare Node process as neither secure nor capable', () => {
    setGlobals({});
    assert.equal(isSecureContextOk(), false);
    assert.equal(supportsServiceWorker(), false);
    assert.equal(supportsWakeLock(), false);
    assert.deepEqual(getCapabilities(), {
      secureContext: false,
      serviceWorker: false,
      wakeLock: false,
      pwaInstall: false,
    });
  });

  it('falls back to the protocol when isSecureContext is unavailable', () => {
    setGlobals({ protocol: 'https:' });
    assert.equal(isSecureContextOk(), true);
    setGlobals({ protocol: 'http:' });
    assert.equal(isSecureContextOk(), false);
  });

  it('reports a LAN origin over HTTP as insecure even though the APIs exist', () => {
    // This is the shape that used to fail silently: the property is there, the
    // call is not allowed.
    setGlobals({
      secureContext: false,
      navigator: { serviceWorker: {}, wakeLock: { request() {} } },
    });

    assert.equal(supportsServiceWorker(), false);
    assert.equal(supportsWakeLock(), false);
    assert.equal(getCapabilities().secureContext, false);
  });

  it('reports support when the context is secure and the APIs exist', () => {
    setGlobals({
      secureContext: true,
      navigator: { serviceWorker: {}, wakeLock: { request() {} } },
    });

    assert.deepEqual(getCapabilities(), {
      secureContext: true,
      serviceWorker: true,
      wakeLock: true,
      pwaInstall: true,
    });
    assert.deepEqual(describeMissingCapabilities(), []);
  });

  it('names the missing API when the context is fine but the browser is not', () => {
    setGlobals({ secureContext: true, navigator: {} });

    const missing = describeMissingCapabilities();
    assert.deepEqual(
      missing.map((entry) => entry.key),
      ['serviceWorker', 'wakeLock']
    );
    for (const entry of missing) assert.ok(entry.message.length > 0);
  });

  it('explains the secure-context cause instead of listing every feature', () => {
    setGlobals({ secureContext: false, navigator: { serviceWorker: {}, wakeLock: {} } });

    const missing = describeMissingCapabilities();
    assert.equal(missing.length, 1);
    assert.equal(missing[0].key, 'secureContext');
    assert.match(missing[0].message, /HTTP/);
  });

  it('reports only the wake lock when the worker is present but the lock is not', () => {
    setGlobals({ secureContext: true, navigator: { serviceWorker: {} } });

    const missing = describeMissingCapabilities();
    assert.deepEqual(
      missing.map((entry) => entry.key),
      ['wakeLock']
    );
  });
});
