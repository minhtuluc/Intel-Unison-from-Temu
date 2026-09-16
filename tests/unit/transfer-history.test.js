/**
 * M3 — durable transfer history.
 *
 * Outcomes used to disappear on restart and had no endpoint at all. These cases pin
 * the two properties that matter: it survives the process, and it never shows one
 * connection another connection's activity.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TransferHistoryService } from '../../src/services/transfer-history.js';

const sender = (connectionId, label = 'Phone') => ({ connectionId, label, platform: 'android' });

describe('M3 transfer history', () => {
  let root;

  before(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utrans-history-'));
  });

  after(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  let dataDir;
  let history;

  beforeEach(async () => {
    dataDir = await fs.promises.mkdtemp(path.join(root, 'data-'));
    history = new TransferHistoryService({ config: { dataDir } });
  });

  it('starts empty and lists nothing when no store exists', () => {
    assert.deepEqual(history.list({ isHost: true }), []);
  });

  it('keeps the newest entry first and stamps it', () => {
    history.record({ status: 'completed', fileName: 'a.bin', size: 10, sender: sender('c1') });
    history.record({ status: 'rejected', fileName: 'b.bin', size: 20, sender: sender('c1') });

    const entries = history.list({ isHost: true });
    assert.equal(entries.length, 2);
    assert.equal(entries[0].fileName, 'b.bin');
    assert.equal(entries[1].fileName, 'a.bin');
    assert.ok(entries[0].timestamp > 0);
  });

  it('marks the display label untrusted and keeps server-observed identity', () => {
    history.record({ status: 'completed', fileName: 'x.bin', sender: sender('c1', 'Kitchen') });

    const [entry] = history.list({ isHost: true });
    assert.equal(entry.connectionId, 'c1');
    assert.equal(entry.label, 'Kitchen');
    assert.equal(entry.labelUntrusted, true);
  });

  it('ignores an entry with no status rather than storing a blank row', () => {
    history.record(null);
    history.record({ fileName: 'no-status.bin' });
    history.record({ status: 42 });
    assert.deepEqual(history.list({ isHost: true }), []);
  });

  it('caps how many entries it keeps', () => {
    const capped = new TransferHistoryService({ config: { dataDir }, limit: 5 });
    for (let index = 0; index < 12; index++) {
      capped.record({ status: 'completed', fileName: `f${index}.bin`, sender: sender('c1') });
    }

    const entries = capped.list({ isHost: true });
    assert.equal(entries.length, 5);
    assert.equal(entries[0].fileName, 'f11.bin');
    capped.clear();
  });

  it('shows the host everything and a client only its own connection', () => {
    history.record({ status: 'completed', fileName: 'mine.bin', sender: sender('c1') });
    history.record({ status: 'completed', fileName: 'theirs.bin', sender: sender('c2') });
    history.record({ status: 'completed', fileName: 'anonymous.bin', sender: {} });

    assert.equal(history.list({ isHost: true }).length, 3);

    const mine = history.list({ connectionId: 'c1' });
    assert.deepEqual(
      mine.map((entry) => entry.fileName),
      ['mine.bin']
    );

    const stranger = history.list({ connectionId: 'c3' });
    assert.deepEqual(stranger, []);

    // An entry with no connection belongs to nobody; it must not leak to a client.
    const withNoId = history.list({ connectionId: null });
    assert.deepEqual(withNoId, []);
  });

  it('honours a requested limit without exceeding the hard cap', () => {
    for (let index = 0; index < 8; index++) {
      history.record({ status: 'completed', fileName: `f${index}.bin`, sender: sender('c1') });
    }
    assert.equal(history.list({ isHost: true, limit: 3 }).length, 3);
    assert.equal(history.list({ isHost: true, limit: 10_000 }).length, 8);
    // A missing or non-positive limit falls back to the default rather than
    // silently returning nothing the caller asked for by accident.
    assert.equal(history.list({ isHost: true, limit: 0 }).length, 8);
  });

  it('survives a restart', async () => {
    history.record({ status: 'completed', fileName: 'persisted.bin', sender: sender('c1') });
    await history.flush();

    const reloaded = new TransferHistoryService({ config: { dataDir } });
    const entries = reloaded.list({ isHost: true });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].fileName, 'persisted.bin');
    assert.equal(entries[0].connectionId, 'c1');
  });

  it('flush writes immediately without waiting for the debounce', async () => {
    history.record({
      status: 'expired',
      reason: 'TIMEOUT',
      fileName: 'now.bin',
      sender: sender('c1'),
    });
    await history.flush();

    const raw = await fs.promises.readFile(history.filePath, 'utf8');
    assert.ok(raw.includes('now.bin'));
  });

  it('starts empty instead of crashing on a corrupt store', async () => {
    await fs.promises.writeFile(history.filePath, '{ not json', 'utf8');
    const recovered = new TransferHistoryService({ config: { dataDir } });
    assert.deepEqual(recovered.list({ isHost: true }), []);
  });

  it('drops entries that are missing a status when loading', async () => {
    await fs.promises.writeFile(
      history.filePath,
      JSON.stringify({
        entries: [{ status: 'completed', fileName: 'ok.bin' }, { fileName: 'bad.bin' }],
      }),
      'utf8'
    );
    const recovered = new TransferHistoryService({ config: { dataDir } });
    assert.equal(recovered.list({ isHost: true }).length, 1);
  });

  it('clear empties the list and cancels a pending write', async () => {
    history.record({ status: 'completed', fileName: 'gone.bin', sender: sender('c1') });
    history.clear();
    await history.flush();

    assert.deepEqual(history.list({ isHost: true }), []);
    const raw = await fs.promises.readFile(history.filePath, 'utf8');
    assert.equal(raw.includes('gone.bin'), false);
  });

  it('does not write to the developer home directory when dataDir is set', () => {
    assert.equal(history.filePath.startsWith(dataDir), true);
  });

  it('never throws when the store cannot be written', async () => {
    const blocked = path.join(root, 'blocked');
    await fs.promises.writeFile(blocked, 'not a directory', 'utf8');
    const failing = new TransferHistoryService({ config: { dataDir: blocked } });

    assert.doesNotThrow(() =>
      failing.record({ status: 'completed', fileName: 'x.bin', sender: sender('c1') })
    );
    // An observer failure must not take the transfer down with it.
    await assert.doesNotReject(failing.flush());
    assert.equal(failing.list({ isHost: true }).length, 1);
  });
});
