import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateId,
  generateFileId,
  generateUploadId,
  generateDeviceId,
} from '../../src/utils/id-generator.js';

describe('ID Generator', () => {
  it('should generate ID with custom prefix', () => {
    const id = generateId('custom_');
    assert.ok(id.startsWith('custom_'));
    assert.ok(id.length > 7);
  });

  it('should generate file ID with f_ prefix', () => {
    const id = generateFileId();
    assert.ok(id.startsWith('f_'));
  });

  it('should generate upload ID with up_ prefix', () => {
    const id = generateUploadId();
    assert.ok(id.startsWith('up_'));
  });

  it('should generate device ID with dev_ prefix', () => {
    const id = generateDeviceId();
    assert.ok(id.startsWith('dev_'));
  });

  it('should generate unique IDs without collisions in 5000 iterations', () => {
    const set = new Set();
    const count = 5000;
    for (let i = 0; i < count; i++) {
      set.add(generateId());
    }
    assert.equal(set.size, count, 'Collisions detected in generated IDs');
  });
});
