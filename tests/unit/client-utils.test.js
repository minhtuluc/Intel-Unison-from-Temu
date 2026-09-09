import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatFileSize, formatRelativeTime, debounce } from '../../public/js/utils.js';

describe('Client Utilities (public/js/utils.js)', () => {
  describe('formatFileSize()', () => {
    it('should return 0 B for non-numeric or zero bytes', () => {
      assert.equal(formatFileSize(0), '0 B');
      assert.equal(formatFileSize(-50), '0 B');
      assert.equal(formatFileSize(null), '0 B');
      assert.equal(formatFileSize(NaN), '0 B');
    });

    it('should format bytes, KB, MB, GB properly', () => {
      assert.equal(formatFileSize(500), '500 B');
      assert.equal(formatFileSize(2048), '2 KB');
      assert.equal(formatFileSize(5242880), '5 MB');
      assert.equal(formatFileSize(1073741824), '1 GB');
    });
  });

  describe('formatRelativeTime()', () => {
    it('should format recent timestamp as Just now', () => {
      const now = Date.now();
      assert.equal(formatRelativeTime(now), 'Just now');
      assert.equal(formatRelativeTime(now - 5000), 'Just now');
    });

    it('should format seconds ago', () => {
      const now = Date.now();
      assert.equal(formatRelativeTime(now - 30000), '30s ago');
    });

    it('should format minutes ago', () => {
      const now = Date.now();
      assert.equal(formatRelativeTime(now - 5 * 60 * 1000), '5m ago');
    });

    it('should format hours and days ago', () => {
      const now = Date.now();
      assert.equal(formatRelativeTime(now - 3 * 60 * 60 * 1000), '3h ago');
      assert.equal(formatRelativeTime(now - 2 * 24 * 60 * 60 * 1000), '2d ago');
    });
  });

  describe('debounce()', () => {
    it('should debounce multiple rapid calls into a single execution', async () => {
      let callCount = 0;
      let lastArg = '';

      const debouncedFn = debounce((val) => {
        callCount++;
        lastArg = val;
      }, 50);

      debouncedFn('call1');
      debouncedFn('call2');
      debouncedFn('call3');

      assert.equal(callCount, 0, 'Should not execute immediately');

      // Wait 100ms
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(callCount, 1, 'Should have executed exactly once');
      assert.equal(lastArg, 'call3', 'Should receive argument of last call');
    });
  });
});
