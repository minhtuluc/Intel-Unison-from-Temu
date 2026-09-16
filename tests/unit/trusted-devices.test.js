/**
 * UT-012 — unit coverage for the remembered-device store.
 *
 * Trust outlives the process, so the cases that matter here are the ones a happy
 * path hides: a corrupt store, an unwritable data directory, and the fact that the
 * device secret itself is never persisted.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TrustedDeviceService, hashDeviceToken } from '../../src/services/trusted-devices.js';

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

describe('UT-012 trusted device store', () => {
  let root;

  before(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-trust-'));
  });

  after(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  let dataDir;
  let service;

  beforeEach(async () => {
    dataDir = await fs.promises.mkdtemp(path.join(root, 'data-'));
    service = new TrustedDeviceService({ config: { dataDir } });
  });

  it('starts empty when no store exists yet', () => {
    assert.deepEqual(service.list(), []);
    assert.equal(service.isTrusted(TOKEN_A), false);
  });

  it('remembers a device and proves it by token, not by name', async () => {
    const record = await service.trust({ token: TOKEN_A, label: 'Kitchen phone' });

    assert.ok(record.id.startsWith('td_'));
    assert.equal(record.label, 'Kitchen phone');
    assert.equal(service.isTrusted(TOKEN_A), true);
    assert.equal(service.isTrusted(TOKEN_B), false);
    assert.equal(service.isTrusted('not-a-token'), false);
    assert.equal(service.isTrusted(undefined), false);
  });

  it('never writes the device secret to disk', async () => {
    await service.trust({ token: TOKEN_A, label: 'Phone' });

    const raw = await fs.promises.readFile(service.filePath, 'utf8');
    assert.equal(raw.includes(TOKEN_A), false, 'the raw token must never be persisted');
    assert.ok(raw.includes(hashDeviceToken(TOKEN_A)), 'only the hash is stored');
  });

  it('survives a restart and rejects a token that was never trusted', async () => {
    await service.trust({ token: TOKEN_A, label: 'Phone' });

    const reloaded = new TrustedDeviceService({ config: { dataDir } });
    assert.equal(reloaded.isTrusted(TOKEN_A), true);
    assert.equal(reloaded.isTrusted(TOKEN_B), false);
    assert.equal(reloaded.list().length, 1);
  });

  it('refreshes an existing device instead of adding a duplicate row', async () => {
    const first = await service.trust({ token: TOKEN_A, label: 'Old name' });
    const second = await service.trust({ token: TOKEN_A, label: 'New name', platform: 'ios' });

    assert.equal(second.id, first.id);
    assert.equal(second.label, 'New name');
    assert.equal(second.platform, 'ios');
    assert.equal(service.list().length, 1);
  });

  it('trusts from a precomputed hash, which is how an offer carries a device', async () => {
    const record = await service.trustByHash({
      tokenHash: hashDeviceToken(TOKEN_B),
      label: 'From offer',
    });

    assert.ok(record.id);
    assert.equal(service.isTrusted(TOKEN_B), true);
  });

  it('rejects malformed tokens and hashes', async () => {
    for (const token of ['', 'short', 'g'.repeat(64), 12345, null, undefined]) {
      await assert.rejects(service.trust({ token }), { code: 'INVALID_DEVICE_TOKEN' });
    }
    for (const tokenHash of ['', 'nope', 42]) {
      await assert.rejects(service.trustByHash({ tokenHash }), { code: 'INVALID_DEVICE_TOKEN' });
    }
    assert.deepEqual(service.list(), []);
  });

  it('revokes a device and reports an unknown id without inventing success', async () => {
    const record = await service.trust({ token: TOKEN_A });

    assert.deepEqual(await service.revoke(record.id), { id: record.id, revoked: true });
    assert.equal(service.isTrusted(TOKEN_A), false);
    assert.deepEqual(await service.revoke(record.id), { id: record.id, revoked: false });
    assert.deepEqual(await service.revoke('td_missing'), { id: 'td_missing', revoked: false });
  });

  it('caps the number of remembered devices', async () => {
    // Fill to the cap, then confirm the next device is refused rather than silently dropped.
    for (let index = 0; index < 100; index++) {
      await service.trustByHash({
        tokenHash: hashDeviceToken(index.toString(16).padStart(64, '0')),
      });
    }
    await assert.rejects(service.trustByHash({ tokenHash: hashDeviceToken('f'.repeat(64)) }), {
      code: 'TOO_MANY_TRUSTED_DEVICES',
    });
  });

  it('starts empty instead of crashing when the store is corrupt', async () => {
    await fs.promises.writeFile(service.filePath, '{ this is not json', 'utf8');

    const recovered = new TrustedDeviceService({ config: { dataDir } });
    assert.deepEqual(recovered.list(), []);
  });

  it('ignores store entries that are missing their identifying fields', async () => {
    await fs.promises.writeFile(
      service.filePath,
      JSON.stringify({ devices: [{ id: 'td_ok', tokenHash: TOKEN_A }, { nope: true }, null] }),
      'utf8'
    );

    const recovered = new TrustedDeviceService({ config: { dataDir } });
    assert.equal(recovered.list().length, 1);
  });

  it('reports a clear failure when the store cannot be written', async () => {
    // A file where the directory should be makes both mkdir and write fail.
    const blocked = path.join(root, 'blocked');
    await fs.promises.writeFile(blocked, 'not a directory', 'utf8');

    const failing = new TrustedDeviceService({ config: { dataDir: blocked } });
    await assert.rejects(failing.trust({ token: TOKEN_A }), {
      code: 'TRUST_STORE_WRITE_FAILED',
    });
    assert.deepEqual(failing.list(), []);
  });

  it('tracks when a trusted device was last seen', async () => {
    const record = await service.trust({ token: TOKEN_A });
    assert.equal(record.lastSeenAt, null);

    const found = service.find(TOKEN_A);
    assert.ok(found.lastSeenAt, 'a lookup records the sighting');
    assert.equal(service.list()[0].lastSeenAt, found.lastSeenAt);
  });
});
