import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  DEVICE_TOKEN_RE,
  deviceTokenKey,
  identityKeysForSocket,
  identityKeysFromRequest,
  intersects,
} from '../../src/utils/client-identity.js';
import { createSessionStore } from '../../src/middleware/session-auth.js';

const DEVICE_TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);

/** Minimal Express-like request for identity resolution. */
function fakeRequest({ headers = {}, sessions = null } = {}) {
  return {
    app: { locals: { sessions: sessions || createSessionStore() } },
    headers,
  };
}

describe('Client identity keys (UT-020)', () => {
  it('derives the device key from the SHA-256 of the token, never the raw token', () => {
    const expected = `dev:${createHash('sha256').update(DEVICE_TOKEN).digest('hex')}`;
    assert.equal(deviceTokenKey(DEVICE_TOKEN), expected);
    assert.equal(deviceTokenKey(DEVICE_TOKEN.toUpperCase()), expected);
    assert.ok(!deviceTokenKey(DEVICE_TOKEN).includes(DEVICE_TOKEN));
  });

  it('rejects malformed device tokens instead of collapsing them into a shared key', () => {
    assert.equal(deviceTokenKey(undefined), null);
    assert.equal(deviceTokenKey(null), null);
    assert.equal(deviceTokenKey(''), null);
    assert.equal(deviceTokenKey('not-a-token'), null);
    assert.equal(deviceTokenKey('a'.repeat(63)), null);
    assert.equal(deviceTokenKey('z'.repeat(64)), null);
    assert.equal(deviceTokenKey(12345), null);
    assert.equal(DEVICE_TOKEN_RE.test(DEVICE_TOKEN), true);
  });

  it('builds socket keys from the connection, the device token and the session', () => {
    const keys = identityKeysForSocket({
      connectionId: 'conn-1',
      sessionToken: 's'.repeat(64),
      deviceToken: DEVICE_TOKEN,
    });

    assert.deepEqual(keys, ['conn:conn-1', deviceTokenKey(DEVICE_TOKEN), `sess:${'s'.repeat(64)}`]);
  });

  it('omits keys that have no verified source', () => {
    assert.deepEqual(identityKeysForSocket({}), []);
    assert.deepEqual(identityKeysForSocket({ connectionId: 'conn-2' }), ['conn:conn-2']);
    assert.deepEqual(identityKeysForSocket({ deviceToken: 'bogus' }), []);
  });

  it('accepts only a session that really resolves, and only a well-formed device token', () => {
    const sessions = createSessionStore();
    const issued = sessions.issue('127.0.0.1');

    const valid = identityKeysFromRequest({
      app: { locals: { sessions } },
      headers: { 'x-session-token': issued.token, 'x-device-token': DEVICE_TOKEN },
    });
    assert.deepEqual(valid.keys, [`sess:${issued.token}`, deviceTokenKey(DEVICE_TOKEN)]);
    assert.equal(valid.sessionToken, issued.token);
    assert.equal(valid.deviceTokenHash, createHash('sha256').update(DEVICE_TOKEN).digest('hex'));

    const forged = identityKeysFromRequest({
      app: { locals: { sessions } },
      headers: { 'x-session-token': 'f'.repeat(64), 'x-device-token': 'bogus' },
    });
    assert.deepEqual(forged.keys, []);
    assert.equal(forged.sessionToken, null);
    assert.equal(forged.deviceTokenHash, null);
  });

  it('lets a revoked session key stop resolving immediately', () => {
    const sessions = createSessionStore();
    const issued = sessions.issue('127.0.0.1');
    const req = { app: { locals: { sessions } }, headers: { 'x-session-token': issued.token } };

    assert.equal(identityKeysFromRequest(req).keys.length, 1);
    sessions.revoke(issued.token);
    assert.deepEqual(identityKeysFromRequest(req).keys, []);
  });

  it('never derives a key from X-Connection-Id', () => {
    // Accepting a client-declared connection id here would let one device borrow
    // another live socket's identity.
    const keys = identityKeysFromRequest(
      fakeRequest({ headers: { 'x-connection-id': 'conn-of-someone-else' } })
    );
    assert.deepEqual(keys.keys, []);
  });

  it('intersects key sets', () => {
    assert.equal(intersects(['a', 'b'], ['c', 'b']), true);
    assert.equal(intersects(['a'], ['b']), false);
    assert.equal(intersects([], ['a']), false);
    assert.equal(intersects(null, ['a']), false);
    assert.equal(intersects(['a'], null), false);
  });

  it('does not confuse two different device tokens', () => {
    assert.equal(intersects([deviceTokenKey(DEVICE_TOKEN)], [deviceTokenKey(OTHER_TOKEN)]), false);
    assert.equal(intersects([deviceTokenKey(DEVICE_TOKEN)], [deviceTokenKey(DEVICE_TOKEN)]), true);
  });
});
