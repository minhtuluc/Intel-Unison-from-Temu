/**
 * RelayTransferService unit tests (M4 / UT-021, UT-022).
 *
 * The grant matrix is deliberately run against *both* consent services — the M3 host
 * offer service and the M4 relay service — because they implement the same single-use
 * grant contract independently, and a divergence there would be a security regression.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RelayTransferService,
  hashRelayToken,
  relayTokenMatches,
} from '../../src/services/relay-transfer.js';
import { TransferOfferService } from '../../src/services/transfer-offer.js';

const CONFIG = { offerTtlMs: 60000, uploadExpiry: 60000, relayTtlMs: 60000 };

const sender = () => ({
  connectionId: 'conn-sender',
  label: 'Sender',
  platform: 'linux',
  keys: ['conn:conn-sender'],
});

const receiver = () => ({
  keys: ['conn:conn-receiver', `dev:${'a'.repeat(64)}`],
  deviceId: 'dev-1',
  label: 'Receiver',
  platform: 'android',
});

const FILES = [{ name: 'a.bin', size: 10, mimeType: 'application/octet-stream' }];

function makeService(overrides = {}) {
  const removed = [];
  const released = [];
  const events = [];
  const service = new RelayTransferService({
    config: { ...CONFIG, ...overrides },
    shareManager: { removeFile: (fileId) => removed.push(fileId) },
    quotaTracker: { release: (bytes) => released.push(bytes) },
  });
  service.onStoredEvent = (event) => events.push(event);
  return { service, removed, released, events };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('RelayTransferService: offers and receiver-only decisions (UT-021)', () => {
  it('requires a verified receiver identity to open a relay', () => {
    const { service } = makeService();
    assert.throws(
      () => service.createOffer({ files: FILES, sender: sender() }),
      /receiver identity/
    );
    assert.throws(
      () => service.createOffer({ files: FILES, sender: sender(), receiver: { keys: [] } }),
      /receiver identity/
    );
  });

  it('stores the receiver as an untrusted label and keeps the sender keys', () => {
    const { service } = makeService();
    const { relay } = service.createOffer({ files: FILES, sender: sender(), receiver: receiver() });

    assert.equal(relay.state, 'pending');
    assert.equal(relay.files[0].decision, 'pending');
    const view = service.sanitize(relay);
    assert.equal(view.receiver.labelUntrusted, true);
    assert.equal(view.sender.labelUntrusted, true);
    assert.ok(!('keys' in view.receiver), 'identity keys are not part of the client view');
    assert.ok(!JSON.stringify(view).includes('receiverTokenHash'));
  });

  it('refuses a decision from anyone but the bound receiver', () => {
    const { service } = makeService();
    const { relay } = service.createOffer({ files: FILES, sender: sender(), receiver: receiver() });

    assert.throws(
      () => service.decide(relay.relayId, [{ index: 0, action: 'accept' }], { keys: [] }),
      /another receiver/
    );
    assert.throws(
      () =>
        service.decide(relay.relayId, [{ index: 0, action: 'accept' }], {
          keys: ['conn:someone-else'],
        }),
      /another receiver/
    );
    assert.equal(relay.state, 'pending', 'a refused decision must not change the relay');
  });

  it('validates the whole batch before applying any of it', () => {
    const { service } = makeService();
    const files = [
      { name: 'a.bin', size: 10 },
      { name: 'b.bin', size: 20 },
    ];
    const { relay } = service.createOffer({ files, sender: sender(), receiver: receiver() });
    const keys = receiver().keys;

    assert.throws(
      () =>
        service.decide(
          relay.relayId,
          [
            { index: 0, action: 'accept' },
            { index: 0, action: 'accept' },
          ],
          {
            keys,
          }
        ),
      /Duplicate index/
    );
    assert.throws(
      () => service.decide(relay.relayId, [{ index: 9, action: 'accept' }], { keys }),
      /not in relay/
    );
    assert.throws(
      () => service.decide(relay.relayId, [{ index: 0, action: 'maybe' }], { keys }),
      /accept" or "decline/
    );

    assert.deepEqual(
      relay.files.map((f) => f.decision),
      ['pending', 'pending'],
      'a rejected batch must leave every file untouched'
    );
  });

  it('issues one grant and one single-use token per accepted file', () => {
    const { service } = makeService();
    const files = [
      { name: 'a.bin', size: 10 },
      { name: 'b.bin', size: 20 },
    ];
    const { relay } = service.createOffer({ files, sender: sender(), receiver: receiver() });

    const result = service.decide(
      relay.relayId,
      [
        { index: 0, action: 'accept' },
        { index: 1, action: 'decline' },
      ],
      { keys: receiver().keys }
    );

    assert.match(result.tokens[0], /^[a-f0-9]{64}$/);
    assert.equal(result.tokens[1], undefined);
    assert.equal(result.decisions[1].grantId, null);

    // Only the hash is retained, and it is the hash of the token handed out.
    const acl = service.getFileAcl(relay.relayId, 0);
    assert.equal(acl.mode, 'receiver');
    assert.equal(acl.receiverTokenHash, hashRelayToken(result.tokens[0]));
    assert.ok(!JSON.stringify(acl).includes(result.tokens[0]));
  });

  it('closes the relay once every file is decided and refuses a second decision', () => {
    const { service } = makeService();
    const { relay } = service.createOffer({ files: FILES, sender: sender(), receiver: receiver() });
    service.decide(relay.relayId, [{ index: 0, action: 'accept' }], { keys: receiver().keys });

    assert.equal(service.getRelay(relay.relayId).state, 'decided');
    assert.equal(service.listPendingFor(receiver().keys).length, 0);

    assert.throws(
      () =>
        service.decide(relay.relayId, [{ index: 0, action: 'accept' }], { keys: receiver().keys }),
      /RELAY_CLOSED|decided/
    );
  });

  it('expires an unanswered offer to both peers and writes nothing', () => {
    const { service } = makeService({ offerTtlMs: 20 });
    const expired = [];
    service.onOfferExpire = (event) => expired.push(event);

    const { relay } = service.createOffer({ files: FILES, sender: sender(), receiver: receiver() });
    return delay(60).then(() => {
      assert.equal(expired.length, 1);
      assert.equal(expired[0].relayId, relay.relayId);
      assert.equal(service.getRelay(relay.relayId).state, 'expired');
      assert.equal(service.storedFiles.size, 0);
    });
  });

  it('lets the sender cancel and refuses a foreign cancel', () => {
    const { service } = makeService();
    const { relay } = service.createOffer({ files: FILES, sender: sender(), receiver: receiver() });

    assert.throws(
      () => service.cancelOffer(relay.relayId, { keys: ['conn:someone-else'] }),
      /another sender/
    );
    const cancelled = service.cancelOffer(relay.relayId, { connectionId: 'conn-sender' });
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.files[0].decision, 'cancelled');
  });
});

describe('RelayTransferService: stored files, TTL and quota (UT-022)', () => {
  it('arms a TTL per stored file and cleans up disk and quota when it fires', async () => {
    const { service, removed, released, events } = makeService({ relayTtlMs: 30 });
    const { relay } = service.createOffer({ files: FILES, sender: sender(), receiver: receiver() });
    service.decide(relay.relayId, [{ index: 0, action: 'accept' }], { keys: receiver().keys });

    service.attachStoredFile({
      relayId: relay.relayId,
      fileIndex: 0,
      fileId: 'f_1',
      size: 10,
      name: 'a.bin',
    });
    assert.equal(service.getStoredFile('f_1').state, 'stored');

    await delay(80);
    assert.equal(service.getStoredFile('f_1'), null);
    assert.deepEqual(removed, ['f_1']);
    assert.deepEqual(released, [10]);
    assert.equal(events.at(-1).state, 'expired');
    assert.equal(events.at(-1).reason, 'TIMEOUT');
  });

  it('marks a completed download without deleting the file', () => {
    const { service, removed, events } = makeService();
    const { relay } = service.createOffer({ files: FILES, sender: sender(), receiver: receiver() });
    service.decide(relay.relayId, [{ index: 0, action: 'accept' }], { keys: receiver().keys });
    service.attachStoredFile({
      relayId: relay.relayId,
      fileIndex: 0,
      fileId: 'f_2',
      size: 10,
      name: 'a.bin',
    });

    const marked = service.markDownloaded('f_2');
    assert.equal(marked.state, 'downloaded');
    assert.equal(service.getStoredFile('f_2').state, 'downloaded');
    assert.deepEqual(removed, [], 'a downloaded file stays until its TTL');
    assert.equal(events.at(-1).state, 'downloaded');
    // A second call is a no-op, not a second event.
    service.markDownloaded('f_2');
    assert.equal(events.filter((e) => e.state === 'downloaded').length, 1);
  });

  it('only lists a stored file to its own receiver', () => {
    const { service } = makeService();
    const { relay } = service.createOffer({ files: FILES, sender: sender(), receiver: receiver() });
    service.decide(relay.relayId, [{ index: 0, action: 'accept' }], { keys: receiver().keys });
    service.attachStoredFile({
      relayId: relay.relayId,
      fileIndex: 0,
      fileId: 'f_3',
      size: 10,
      name: 'a.bin',
    });

    assert.equal(service.listStoredFor(receiver().keys).length, 1);
    assert.equal(service.listStoredFor(['conn:someone-else']).length, 0);
    assert.equal(service.listStoredFor([]).length, 0);

    const listed = service.listStoredFor(receiver().keys)[0];
    assert.equal(listed.hasToken, true, 'the client is told to use its capability');
    assert.ok(!('receiverTokenHash' in listed));
  });

  it('revokes every file a relay left behind', () => {
    const { service, removed, released } = makeService();
    const { relay } = service.createOffer({ files: FILES, sender: sender(), receiver: receiver() });
    service.decide(relay.relayId, [{ index: 0, action: 'accept' }], { keys: receiver().keys });
    service.attachStoredFile({
      relayId: relay.relayId,
      fileIndex: 0,
      fileId: 'f_4',
      size: 10,
      name: 'a.bin',
    });

    assert.equal(service.revokeRelay(relay.relayId), 1);
    assert.deepEqual(removed, ['f_4']);
    assert.deepEqual(released, [10]);
  });

  it('releases every timer on cleanup', async () => {
    const { service, removed } = makeService({ relayTtlMs: 30 });
    const { relay } = service.createOffer({ files: FILES, sender: sender(), receiver: receiver() });
    service.attachStoredFile({
      relayId: relay.relayId,
      fileIndex: 0,
      fileId: 'f_5',
      size: 10,
      name: 'a.bin',
    });

    service.cleanup();
    await delay(80);
    assert.deepEqual(removed, [], 'a cleared timer must not fire after cleanup');
  });
});

describe('Single-use grant contract: both consent services behave identically (UT-021)', () => {
  /** Issues one grant from each service, so the same matrix can run against both. */
  function grantsFromBothServices() {
    const offerService = new TransferOfferService({ config: CONFIG });
    const { offer } = offerService.createOffer({ files: FILES, sender: sender() });
    const { grants: offerGrants } = offerService.decide(offer.offerId, [
      { index: 0, action: 'approve' },
    ]);

    const { service: relayService } = makeService();
    const { relay } = relayService.createOffer({
      files: FILES,
      sender: sender(),
      receiver: receiver(),
    });
    const { relay: decided, decisions } = relayService.decide(
      relay.relayId,
      [{ index: 0, action: 'accept' }],
      { keys: receiver().keys }
    );

    return [
      { name: 'host offer service', service: offerService, grantId: offerGrants[0].grantId },
      { name: 'relay service', service: relayService, grantId: decisions[0].grantId, decided },
    ];
  }

  it('accepts a grant exactly once, from the bound connection', () => {
    for (const { name, service, grantId } of grantsFromBothServices()) {
      const grant = service.beginGrant(grantId, { connectionId: 'conn-sender' });
      assert.equal(grant.status, 'in_use', name);
      service.fulfillGrant(grantId);
      assert.throws(
        () => service.beginGrant(grantId, { connectionId: 'conn-sender' }),
        /already been used/,
        name
      );
    }
  });

  it('refuses an unknown grant, a foreign connection and a busy grant', () => {
    for (const { name, service, grantId } of grantsFromBothServices()) {
      assert.throws(
        () => service.beginGrant('gr_nope', { connectionId: 'conn-sender' }),
        /unknown/,
        name
      );
      assert.throws(
        () => service.beginGrant(grantId, { connectionId: 'conn-other' }),
        /another connection/,
        name
      );
      service.beginGrant(grantId, { connectionId: 'conn-sender' });
      assert.throws(
        () => service.beginGrant(grantId, { connectionId: 'conn-sender' }),
        /already in use/,
        name
      );
      service.releaseGrant(grantId);
      assert.equal(service.getGrant(grantId).status, 'issued', `${name}: released back to issued`);
    }
  });

  it('refuses an expired grant and reports ownership consistently', () => {
    for (const { name, service, grantId } of grantsFromBothServices()) {
      assert.equal(service.hasGrant(grantId), true, name);
      assert.equal(service.hasGrant('gr_nope'), false, name);

      service.getGrant(grantId).expiresAt = Date.now() - 1;
      assert.throws(
        () => service.beginGrant(grantId, { connectionId: 'conn-sender' }),
        /has expired/,
        name
      );
      assert.equal(service.hasGrant(grantId), false, `${name}: expired grant is dropped`);
      assert.equal(service.sweepGrants(), 0, `${name}: sweep is idempotent`);
    }
  });
});

describe('Relay download capability (UT-022)', () => {
  it('matches only the exact token, in constant-time comparison', () => {
    const token = 'c'.repeat(64);
    const hash = hashRelayToken(token);

    assert.equal(relayTokenMatches(token, hash), true);
    assert.equal(relayTokenMatches(token.toUpperCase(), hash), true);
    assert.equal(relayTokenMatches('d'.repeat(64), hash), false);
    assert.equal(relayTokenMatches('short', hash), false);
    assert.equal(relayTokenMatches(undefined, hash), false);
    assert.equal(relayTokenMatches(token, null), false);
    assert.equal(relayTokenMatches(token, 'not-a-hash'), false);
    assert.equal(relayTokenMatches([token], hash), false, 'an array query param is not a token');
  });
});
