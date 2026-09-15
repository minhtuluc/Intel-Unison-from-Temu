import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from '../../src/middleware/session-auth.js';

describe('Session store: server-issued, expiring, revocable capabilities', () => {
  it('issues opaque 256-bit tokens that verify back to their session', () => {
    const store = createSessionStore({ ttlMs: 60000 });
    const issued = store.issue('192.168.1.9');

    assert.match(issued.token, /^[a-f0-9]{64}$/);
    assert.ok(Date.parse(issued.expiresAt) > Date.now());

    const session = store.verify(issued.token);
    assert.equal(session.token, issued.token);
    assert.equal(session.ip, '192.168.1.9');
  });

  it('never repeats a token and never accepts a forged one', () => {
    const store = createSessionStore();
    const first = store.issue('10.0.0.1');
    const second = store.issue('10.0.0.1');

    assert.notEqual(first.token, second.token);
    assert.equal(store.verify('f'.repeat(64)), null);
    assert.equal(store.verify('bypass'), null);
    assert.equal(store.verify(undefined), null);
    assert.equal(store.verify(12345), null);
  });

  it('expires sessions against the injected clock and sweeps them', () => {
    let clock = 1_000_000;
    const store = createSessionStore({ ttlMs: 1000, now: () => clock });
    const { token } = store.issue('10.0.0.2');

    clock += 999;
    assert.ok(store.verify(token));

    clock += 2;
    assert.equal(store.verify(token), null);
    assert.equal(store.size(), 0);

    const other = store.issue('10.0.0.3');
    clock += 5000;
    assert.equal(store.sweep(), 1);
    assert.equal(store.verify(other.token), null);
  });

  it('revokes a single session and all sessions', () => {
    const store = createSessionStore();
    const a = store.issue('10.0.0.4');
    const b = store.issue('10.0.0.5');

    assert.equal(store.revoke(a.token), true);
    assert.equal(store.verify(a.token), null);
    assert.ok(store.verify(b.token));
    assert.equal(store.revoke(a.token), false);

    assert.equal(store.revokeAll(), 1);
    assert.equal(store.verify(b.token), null);
    assert.equal(store.size(), 0);
  });

  it('bounds the store by evicting the oldest session first', () => {
    let clock = 5_000_000;
    const store = createSessionStore({ maxSessions: 2, now: () => clock });
    const oldest = store.issue('10.0.0.6');
    clock += 10;
    const middle = store.issue('10.0.0.7');
    clock += 10;
    const newest = store.issue('10.0.0.8');

    assert.equal(store.size(), 2);
    assert.equal(store.verify(oldest.token), null);
    assert.ok(store.verify(middle.token));
    assert.ok(store.verify(newest.token));
  });
});
