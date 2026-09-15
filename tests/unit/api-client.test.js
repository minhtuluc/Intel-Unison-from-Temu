import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_STORAGE_KEY, UNAUTHORIZED_EVENT, createApiClient } from '../../public/js/api.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    has: (key) => map.has(key),
  };
}

function recordingFetch(status = 200) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { status, ok: status < 400 };
  };
  return { fetchImpl, calls };
}

describe('API client: session header and unauthorized signalling', () => {
  it('sends no session header when the client has no token', async () => {
    const storage = memoryStorage();
    const { fetchImpl, calls } = recordingFetch();
    const client = createApiClient({ storage, fetchImpl });

    await client.apiFetch('/api/shared');

    assert.equal(calls[0].options.headers.get('X-Session-Token'), null);
    assert.equal(client.getToken(), '');
  });

  it('attaches the stored session token to every request', async () => {
    const storage = memoryStorage({ [SESSION_STORAGE_KEY]: 'c'.repeat(64) });
    const { fetchImpl, calls } = recordingFetch();
    const client = createApiClient({ storage, fetchImpl });

    await client.apiFetch('/api/upload/init', { method: 'POST' });

    assert.equal(calls[0].options.headers.get('X-Session-Token'), 'c'.repeat(64));
    assert.equal(calls[0].options.method, 'POST');
  });

  it('preserves caller headers while adding the session header', async () => {
    const storage = memoryStorage({ [SESSION_STORAGE_KEY]: 'd'.repeat(64) });
    const { fetchImpl, calls } = recordingFetch();
    const client = createApiClient({ storage, fetchImpl });

    await client.apiFetch('/api/upload/pending', { headers: { 'X-Host-Token': 'host-token' } });

    assert.equal(calls[0].options.headers.get('X-Host-Token'), 'host-token');
    assert.equal(calls[0].options.headers.get('X-Session-Token'), 'd'.repeat(64));
  });

  it('signals unauthorized once until authentication succeeds again', async () => {
    const storage = memoryStorage({ [SESSION_STORAGE_KEY]: 'e'.repeat(64) });
    let status = 401;
    const fetchImpl = async () => ({ status, ok: status < 400 });
    const signals = [];
    const client = createApiClient({ storage, fetchImpl, onUnauthorized: () => signals.push(1) });

    await client.apiFetch('/api/shared');
    await client.apiFetch('/api/shared');
    assert.equal(signals.length, 1);

    status = 200;
    await client.apiFetch('/api/shared');
    status = 401;
    await client.apiFetch('/api/shared');
    assert.equal(signals.length, 2);
  });

  it('stores and clears the session token', () => {
    const storage = memoryStorage();
    const client = createApiClient({ storage, fetchImpl: async () => ({ status: 200 }) });

    client.setToken('f'.repeat(64));
    assert.equal(storage.getItem(SESSION_STORAGE_KEY), 'f'.repeat(64));
    assert.equal(client.getToken(), 'f'.repeat(64));

    client.clearToken();
    assert.equal(storage.getItem(SESSION_STORAGE_KEY), null);
    assert.equal(client.getToken(), '');
  });

  it('stores, retrieves and clears host token', () => {
    const storage = memoryStorage();
    const client = createApiClient({ storage, fetchImpl: async () => ({ status: 200 }) });

    client.setHostToken('h'.repeat(64));
    assert.equal(client.getHostToken(), 'h'.repeat(64));

    client.clearHostToken();
    assert.equal(client.getHostToken(), '');
  });

  it('attaches host token on same-origin requests', async () => {
    const storage = memoryStorage({ utrans_host_token: 'h'.repeat(64) });
    const { fetchImpl, calls } = recordingFetch();
    const client = createApiClient({ storage, fetchImpl });

    await client.apiFetch('/api/shared');
    assert.equal(calls[0].options.headers.get('X-Host-Token'), 'h'.repeat(64));
  });

  it('does not attach host token on cross-origin requests', async () => {
    const storage = memoryStorage({ utrans_host_token: 'h'.repeat(64) });
    const { fetchImpl, calls } = recordingFetch();
    const client = createApiClient({ storage, fetchImpl });

    await client.apiFetch('https://external-service.com/api', {});
    assert.equal(calls[0].options.headers.get('X-Host-Token'), null);
  });

  it('exposes the event name the app listens on', () => {
    assert.equal(UNAUTHORIZED_EVENT, 'utrans:unauthorized');
  });
});
