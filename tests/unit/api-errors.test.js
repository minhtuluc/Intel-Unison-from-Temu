/**
 * M3 — server error codes turned into something a sender can act on.
 *
 * Before this, every refused upload read "Upload failed with status 507": true, and
 * useless. Each mapped code must produce wording, and an unknown code must fall back
 * rather than print a bare identifier at the user.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeError, readApiError } from '../../public/js/utils.js';

describe('M3 API error wording', () => {
  it('explains the codes a sender can actually hit', () => {
    const codes = [
      'STORAGE_QUOTA_EXCEEDED',
      'TOO_MANY_TRANSFERS',
      'TOO_MANY_SESSIONS',
      'FILE_TOO_LARGE',
      'CHUNK_TOO_LARGE',
      'CHECKSUM_MISMATCH',
      'FILE_CORRUPTED',
      'TRANSFER_GRANT_REQUIRED',
      'TRANSFER_GRANT_INVALID',
      'TRANSFER_GRANT_USED',
      'TRANSFER_GRANT_BUSY',
      'TRANSFER_GRANT_EXPIRED',
      'GRANT_MISMATCH',
      'OFFER_NOT_FOUND',
      'OFFER_CLOSED',
      'UPLOAD_EXPIRED',
      'TOO_MANY_TRUSTED_DEVICES',
      'INVALID_UPLOAD_DIR',
      'HOST_REQUIRED',
      'ACCESS_DENIED',
    ];

    for (const code of codes) {
      const message = describeError(code);
      assert.ok(message.length > 15, `${code} has usable wording`);
      assert.equal(message.includes(code), false, `${code} does not leak the raw code`);
    }
  });

  it('falls back to the server message, then to a generic one', () => {
    assert.equal(describeError('SOMETHING_NEW', 'Server said no'), 'Server said no');
    assert.equal(describeError('SOMETHING_NEW'), 'Something went wrong.');
    assert.equal(describeError(undefined, 'Server said no'), 'Server said no');
    assert.equal(describeError(''), 'Something went wrong.');
  });

  it('prefers the mapped wording over a terse server message', () => {
    // A host that fills up should not produce "507" as the whole explanation.
    assert.notEqual(
      describeError('STORAGE_QUOTA_EXCEEDED', 'Storage quota exceeded: required 100, available 0'),
      'Storage quota exceeded: required 100, available 0'
    );
  });
});

describe('M3 reading an error body', () => {
  it('extracts the code and mapped message', () => {
    const result = readApiError({ error: { code: 'FILE_TOO_LARGE', message: 'too big' } }, 413);
    assert.equal(result.code, 'FILE_TOO_LARGE');
    assert.match(result.message, /bigger than the host accepts/);
  });

  it('still says something when the body is empty or not JSON', () => {
    const empty = readApiError({}, 500);
    assert.equal(empty.code, '');
    assert.match(empty.message, /500/);

    const nothing = readApiError(undefined, 502);
    assert.match(nothing.message, /502/);
  });

  it('uses the server message for an unmapped code', () => {
    const result = readApiError(
      { error: { code: 'NEW_CODE', message: 'Something specific' } },
      400
    );
    assert.equal(result.message, 'Something specific');
  });
});
