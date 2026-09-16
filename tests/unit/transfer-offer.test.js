/**
 * UT-012 — unit coverage for the offer/grant state machine.
 *
 * The integration suite proves the gate holds end to end; these cases pin the
 * boundary conditions that are awkward to provoke over HTTP: manifest validation,
 * grant lifecycle transitions and offer expiry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TransferOfferService,
  validateOfferFiles,
  MAX_FILES_PER_OFFER,
} from '../../src/services/transfer-offer.js';

/** @param {object} [overrides] */
function service(overrides = {}) {
  return new TransferOfferService({
    config: { offerTtlMs: 60000, uploadExpiry: 60000, ...overrides },
  });
}

const sender = { connectionId: 'conn-1', label: 'Phone', platform: 'android' };
const file = (name, size) => ({ name, size });

describe('UT-012 offer manifest validation', () => {
  it('rejects a manifest that is not a non-empty array', () => {
    for (const bad of [undefined, null, 'nope', [], 42]) {
      assert.throws(() => validateOfferFiles(bad), { code: 'INVALID_INPUT' });
    }
  });

  it('rejects a batch larger than the reviewable cap', () => {
    const tooMany = Array.from({ length: MAX_FILES_PER_OFFER + 1 }, (_, i) => file(`f${i}`, 1));
    assert.throws(() => validateOfferFiles(tooMany), { code: 'TOO_MANY_FILES' });
  });

  it('rejects malformed entries', () => {
    const cases = [
      [null],
      ['string-entry'],
      [{ name: '', size: 1 }],
      [{ name: '   ', size: 1 }],
      [{ name: 'nul\0byte', size: 1 }],
      [{ name: 'a.txt' }],
      [{ name: 'a.txt', size: 0 }],
      [{ name: 'a.txt', size: -5 }],
      [{ name: 'a.txt', size: 1.5 }],
      [{ name: 'a.txt', size: 'ten' }],
      [{ name: 'a.txt', size: 1, checksum: 'abc' }],
      [{ name: 'a.txt', size: 1, checksum: 12345 }],
    ];
    for (const manifest of cases) {
      assert.throws(
        () => validateOfferFiles(manifest),
        (err) => {
          assert.ok(['INVALID_INPUT', 'INVALID_CHECKSUM'].includes(err.code), err.code);
          return true;
        }
      );
    }
  });

  it('normalizes valid entries and lowercases the checksum', () => {
    const [entry] = validateOfferFiles([
      { name: '  report.pdf  ', size: 10, mimeType: 'application/pdf', checksum: 'A'.repeat(64) },
    ]);
    assert.equal(entry.name, 'report.pdf');
    assert.equal(entry.size, 10);
    assert.equal(entry.mimeType, 'application/pdf');
    assert.equal(entry.checksum, 'a'.repeat(64));
  });

  it('treats a missing checksum and mime type as absent rather than invalid', () => {
    const [entry] = validateOfferFiles([file('plain.bin', 4)]);
    assert.equal(entry.checksum, null);
    assert.equal(entry.mimeType, null);
  });
});

describe('UT-012 offer lifecycle', () => {
  it('starts pending and issues no grants until the host decides', () => {
    const offers = service();
    const { offer, grants, autoApproved } = offers.createOffer({
      files: [file('a.txt', 5)],
      sender,
    });

    assert.equal(autoApproved, false);
    assert.deepEqual(grants, []);
    assert.equal(offer.state, 'pending');
    assert.equal(offer.files[0].decision, 'pending');
    assert.equal(offers.listPending().length, 1);
  });

  it('issues one grant per approved file and closes the offer once fully decided', () => {
    const offers = service();
    const { offer } = offers.createOffer({
      files: [file('a.txt', 5), file('b.txt', 6)],
      sender,
    });

    const { grants } = offers.decide(offer.offerId, [
      { index: 0, action: 'approve' },
      { index: 1, action: 'reject' },
    ]);

    assert.equal(grants.length, 1);
    assert.equal(grants[0].name, 'a.txt');
    assert.equal(offers.getOffer(offer.offerId).state, 'decided');
    assert.deepEqual(offers.listPending(), []);
  });

  it('keeps the offer open while any file is still undecided', () => {
    const offers = service();
    const { offer } = offers.createOffer({
      files: [file('a.txt', 5), file('b.txt', 6)],
      sender,
    });

    offers.decide(offer.offerId, [{ index: 0, action: 'approve' }]);
    assert.equal(offers.getOffer(offer.offerId).state, 'pending');

    offers.decide(offer.offerId, [{ index: 1, action: 'approve' }]);
    assert.equal(offers.getOffer(offer.offerId).state, 'decided');
    assert.equal(offers.getGrantsForOffer(offer.offerId).length, 2);
  });

  it('rejects decisions for an unknown offer, index or action', () => {
    const offers = service();
    assert.throws(() => offers.decide('of_missing', [{ index: 0, action: 'approve' }]), {
      code: 'OFFER_NOT_FOUND',
    });

    const { offer } = offers.createOffer({ files: [file('a.txt', 5)], sender });
    assert.throws(() => offers.decide(offer.offerId, [{ index: 9, action: 'approve' }]), {
      code: 'INVALID_INPUT',
    });
    assert.throws(() => offers.decide(offer.offerId, [{ index: 0, action: 'maybe' }]), {
      code: 'INVALID_INPUT',
    });
    assert.throws(() => offers.decide(offer.offerId, []), { code: 'INVALID_INPUT' });
  });

  it('refuses a second decision once the offer is closed', () => {
    const offers = service();
    const { offer } = offers.createOffer({ files: [file('a.txt', 5)], sender });
    offers.decide(offer.offerId, [{ index: 0, action: 'approve' }]);
    assert.throws(() => offers.decide(offer.offerId, [{ index: 0, action: 'approve' }]), {
      code: 'OFFER_CLOSED',
    });
  });

  it('rejects duplicate indices in the same decision batch (M3-QC-04)', () => {
    const offers = service();
    const { offer } = offers.createOffer({ files: [file('a.txt', 5), file('b.txt', 6)], sender });
    assert.throws(
      () =>
        offers.decide(offer.offerId, [
          { index: 0, action: 'approve' },
          { index: 0, action: 'reject' },
        ]),
      { code: 'INVALID_INPUT' }
    );
    // State remains untouched
    assert.equal(offer.files[0].decision, 'pending');
    assert.equal(offers.getGrantsForOffer(offer.offerId).length, 0);
  });

  it('rejects decisions on files already decided and keeps batch atomic (M3-QC-04)', () => {
    const offers = service();
    const { offer } = offers.createOffer({
      files: [file('a.txt', 5), file('b.txt', 6), file('c.txt', 7)],
      sender,
    });
    // First decision: approve index 0
    offers.decide(offer.offerId, [{ index: 0, action: 'approve' }]);
    assert.equal(offer.files[0].decision, 'approved');
    assert.equal(offer.state, 'pending'); // still pending because index 1 and 2 are pending

    // Attempting to approve index 0 again while offer is pending throws 409
    assert.throws(() => offers.decide(offer.offerId, [{ index: 0, action: 'approve' }]), {
      code: 'OFFER_CONFLICT',
    });

    // Atomic batch test: attempting to approve index 1 along with invalid index 0
    assert.throws(
      () =>
        offers.decide(offer.offerId, [
          { index: 1, action: 'approve' },
          { index: 0, action: 'approve' },
        ]),
      { code: 'OFFER_CONFLICT' }
    );
    // Index 1 must still be pending because the batch failed atomically
    assert.equal(offer.files[1].decision, 'pending');
    // Only 1 grant issued from the first request
    assert.equal(offers.getGrantsForOffer(offer.offerId).length, 1);
  });

  it('auto-approves every file for a trusted device', () => {
    const offers = service();
    const { autoApproved, grants } = offers.createOffer({
      files: [file('a.txt', 5), file('b.txt', 6)],
      sender,
      trusted: true,
    });

    assert.equal(autoApproved, true);
    assert.equal(grants.length, 2);
    assert.equal(offers.getOffer(grants[0].offerId).state, 'decided');
  });

  it('lets the sender cancel, and refuses a cancel from another connection', () => {
    const offers = service();
    const { offer } = offers.createOffer({ files: [file('a.txt', 5)], sender });

    assert.throws(() => offers.cancelOffer(offer.offerId, { connectionId: 'someone-else' }), {
      code: 'OFFER_FORBIDDEN',
    });

    const cancelled = offers.cancelOffer(offer.offerId, { connectionId: 'conn-1' });
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(offers.getOffer(offer.offerId).files[0].decision, 'cancelled');
  });

  it('reports an unknown offer as not found rather than silent success', () => {
    const offers = service();
    assert.throws(() => offers.cancelOffer('of_nope'), { code: 'OFFER_NOT_FOUND' });
    assert.equal(offers.getOffer('of_nope'), null);
  });
});

describe('UT-012 grant redemption', () => {
  function approvedGrant(offers, name = 'a.txt', size = 5) {
    const { offer } = offers.createOffer({ files: [file(name, size)], sender });
    const { grants } = offers.decide(offer.offerId, [{ index: 0, action: 'approve' }]);
    return grants[0];
  }

  it('walks a grant from issued to in_use to fulfilled', () => {
    const offers = service();
    const grant = approvedGrant(offers);

    assert.equal(grant.status, 'issued');
    assert.equal(offers.beginGrant(grant.grantId, { connectionId: 'conn-1' }).status, 'in_use');
    offers.fulfillGrant(grant.grantId);
    assert.equal(offers.getGrant(grant.grantId).status, 'fulfilled');
    assert.throws(() => offers.beginGrant(grant.grantId, { connectionId: 'conn-1' }), {
      code: 'TRANSFER_GRANT_USED',
    });
  });

  it('returns a grant to issued after a failed attempt so a retry can work', () => {
    const offers = service();
    const grant = approvedGrant(offers);

    offers.beginGrant(grant.grantId, { connectionId: 'conn-1' });
    offers.releaseGrant(grant.grantId);
    assert.equal(offers.getGrant(grant.grantId).status, 'issued');
    assert.equal(offers.beginGrant(grant.grantId, { connectionId: 'conn-1' }).status, 'in_use');
  });

  it('refuses a missing, unknown or concurrently spent grant', () => {
    const offers = service();
    assert.throws(() => offers.beginGrant(''), { code: 'TRANSFER_GRANT_REQUIRED' });
    assert.throws(() => offers.beginGrant('gr_unknown'), { code: 'TRANSFER_GRANT_INVALID' });

    const grant = approvedGrant(offers);
    offers.beginGrant(grant.grantId, { connectionId: 'conn-1' });
    assert.throws(() => offers.beginGrant(grant.grantId, { connectionId: 'conn-1' }), {
      code: 'TRANSFER_GRANT_BUSY',
    });
  });

  it('refuses a grant presented by a different or missing connection', () => {
    const offers = service();
    const grant = approvedGrant(offers);
    assert.throws(() => offers.beginGrant(grant.grantId, { connectionId: 'other' }), {
      code: 'TRANSFER_GRANT_INVALID',
    });
    assert.throws(() => offers.beginGrant(grant.grantId), {
      code: 'TRANSFER_GRANT_INVALID',
    });
  });

  it('treats an expired grant as invalid and sweeps it away', () => {
    const offers = service({ uploadExpiry: 5 });
    const grant = approvedGrant(offers);
    grant.expiresAt = Date.now() - 1;

    assert.throws(() => offers.beginGrant(grant.grantId, { connectionId: 'conn-1' }), {
      code: 'TRANSFER_GRANT_EXPIRED',
    });
    assert.equal(offers.getGrant(grant.grantId), null);
    assert.equal(offers.sweepGrants(), 0, 'the expired grant was already dropped');
  });

  it('sweeps only the grants past their TTL', () => {
    const offers = service();
    const live = approvedGrant(offers, 'live.txt');
    const stale = approvedGrant(offers, 'stale.txt');
    stale.expiresAt = Date.now() - 1;

    assert.equal(offers.sweepGrants(), 1);
    assert.ok(offers.getGrant(live.grantId));
    assert.equal(offers.getGrant(stale.grantId), null);
  });

  it('reports release and fulfill for unknown grants without throwing', () => {
    const offers = service();
    assert.doesNotThrow(() => offers.releaseGrant('gr_nope'));
    assert.doesNotThrow(() => offers.fulfillGrant('gr_nope'));
  });
});

describe('UT-012 offer expiry', () => {
  it('expires an unanswered offer, notifies the observer and keeps it readable', async () => {
    const expired = [];
    const offers = new TransferOfferService({
      config: { offerTtlMs: 20, uploadExpiry: 60000 },
      onExpire: (payload) => expired.push(payload),
    });

    const { offer } = offers.createOffer({ files: [file('slow.txt', 5)], sender });
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(expired.length, 1);
    assert.equal(expired[0].offerId, offer.offerId);
    assert.equal(offers.getOffer(offer.offerId).state, 'expired');
    assert.equal(offers.getOffer(offer.offerId).files[0].decision, 'expired');
    assert.deepEqual(offers.listPending(), []);
  });

  it('does not expire an offer the host already decided', async () => {
    const expired = [];
    const offers = new TransferOfferService({
      config: { offerTtlMs: 20, uploadExpiry: 60000 },
      onExpire: (payload) => expired.push(payload),
    });

    const { offer } = offers.createOffer({ files: [file('fast.txt', 5)], sender });
    offers.decide(offer.offerId, [{ index: 0, action: 'approve' }]);
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.deepEqual(expired, []);
    assert.equal(offers.getOffer(offer.offerId).state, 'decided');
  });

  it('survives an observer that throws', async () => {
    const offers = new TransferOfferService({
      config: { offerTtlMs: 20, uploadExpiry: 60000 },
      onExpire: () => {
        throw new Error('observer blew up');
      },
    });

    const { offer } = offers.createOffer({ files: [file('boom.txt', 5)], sender });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(offers.getOffer(offer.offerId).state, 'expired');
  });
});

describe('UT-012 offer hygiene', () => {
  it('never leaks the device token hash through the host-facing view', () => {
    const offers = service();
    const { offer } = offers.createOffer({
      files: [file('a.txt', 5)],
      sender: { ...sender, deviceTokenHash: 'f'.repeat(64) },
    });

    const sanitized = offers.sanitize(offer);
    assert.equal(JSON.stringify(sanitized).includes('f'.repeat(64)), false);
    assert.equal(sanitized.sender.connectionId, 'conn-1');
    assert.equal(sanitized.sender.labelUntrusted, true);
  });

  it('evicts the oldest closed offers once the readback window fills', () => {
    const offers = service();
    const ids = [];
    for (let index = 0; index < 205; index++) {
      const { offer } = offers.createOffer({ files: [file(`f${index}.txt`, 1)], sender });
      offers.decide(offer.offerId, [{ index: 0, action: 'reject' }]);
      ids.push(offer.offerId);
    }

    assert.equal(offers.getOffer(ids[0]), null, 'oldest offer must be evicted');
    assert.ok(offers.getOffer(ids[ids.length - 1]), 'newest offer must remain readable');
    assert.equal(offers.recent.size, 200);
  });

  it('drops timers and state on cleanup', () => {
    const offers = service();
    offers.createOffer({ files: [file('a.txt', 5)], sender });
    offers.cleanup();

    assert.equal(offers.offers.size, 0);
    assert.equal(offers.grants.size, 0);
    assert.equal(offers.recent.size, 0);
  });

  it('falls back to sane TTLs when the config is unusable', () => {
    const offers = new TransferOfferService({ config: {} });
    assert.equal(offers.offerTtlMs, 2 * 60 * 1000);
    assert.equal(offers.grantTtlMs, 60 * 60 * 1000);
  });
});
