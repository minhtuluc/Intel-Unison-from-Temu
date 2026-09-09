import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, validateConfig, resolvePath, DEFAULT_CONFIG } from '../../src/config.js';

describe('Config System', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('resolvePath()', () => {
    it('should expand ~ to user home directory', () => {
      const resolved = resolvePath('~/Downloads/UniversalTrans');
      assert.equal(resolved, path.join(os.homedir(), 'Downloads', 'UniversalTrans'));
    });

    it('should resolve relative paths to absolute', () => {
      const resolved = resolvePath('temp');
      assert.equal(resolved, path.resolve('temp'));
    });

    it('should return empty string for empty input', () => {
      assert.equal(resolvePath(''), '');
      assert.equal(resolvePath(null), '');
    });
  });

  describe('validateConfig()', () => {
    it('should pass for valid config', () => {
      assert.equal(validateConfig(DEFAULT_CONFIG), true);
    });

    it('should throw for port out of range', () => {
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, port: 80 }), {
        code: 'CONFIG_INVALID',
      });
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, port: 70000 }), {
        code: 'CONFIG_INVALID',
      });
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, port: 'abc' }), {
        code: 'CONFIG_INVALID',
      });
    });

    it('should throw when chunkSize <= 0 or invalid', () => {
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, chunkSize: 0 }), {
        code: 'CONFIG_INVALID',
      });
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, chunkSize: -100 }), {
        code: 'CONFIG_INVALID',
      });
    });

    it('should throw when maxFileSize <= 0 or invalid', () => {
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, maxFileSize: 0 }), {
        code: 'CONFIG_INVALID',
      });
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, maxFileSize: -1 }), {
        code: 'CONFIG_INVALID',
      });
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, maxFileSize: NaN }), {
        code: 'CONFIG_INVALID',
      });
    });

    it('should throw when chunkSize exceeds maxFileSize', () => {
      assert.throws(
        () =>
          validateConfig({
            ...DEFAULT_CONFIG,
            chunkSize: 20 * 1024 * 1024,
            maxFileSize: 10 * 1024 * 1024,
          }),
        { code: 'CONFIG_INVALID' }
      );
    });

    it('should throw when maxConcurrentTransfers < 1', () => {
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, maxConcurrentTransfers: 0 }), {
        code: 'CONFIG_INVALID',
      });
    });

    it('should throw when maxConnectedDevices < 1', () => {
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, maxConnectedDevices: 0 }), {
        code: 'CONFIG_INVALID',
      });
    });

    it('should validate PIN format (4-6 digits)', () => {
      assert.equal(validateConfig({ ...DEFAULT_CONFIG, pin: '1234' }), true);
      assert.equal(validateConfig({ ...DEFAULT_CONFIG, pin: '123456' }), true);
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, pin: '123' }), {
        code: 'CONFIG_INVALID',
      });
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, pin: 'abcd' }), {
        code: 'CONFIG_INVALID',
      });
    });
  });

  describe('loadConfig()', () => {
    it('should load default configuration when no env vars set', () => {
      delete process.env.UTRANS_PORT;
      delete process.env.UTRANS_UPLOAD_DIR;
      delete process.env.UTRANS_PIN;

      const loaded = loadConfig();
      assert.equal(loaded.port, 8080);
      assert.equal(loaded.maxConcurrentTransfers, 5);
      assert.equal(loaded.pin, null);
    });

    it('should override configuration from environment variables', () => {
      process.env.UTRANS_PORT = '4000';
      process.env.UTRANS_PIN = '9876';
      process.env.UTRANS_LOG_LEVEL = 'debug';

      const loaded = loadConfig();
      assert.equal(loaded.port, 4000);
      assert.equal(loaded.pin, '9876');
      assert.equal(loaded.logLevel, 'debug');
    });

    it('should allow runtime overrides parameter', () => {
      const loaded = loadConfig({ port: 5050 });
      assert.equal(loaded.port, 5050);
    });
  });
});
