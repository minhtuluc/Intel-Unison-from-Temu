/**
 * UniversalTrans Configuration Management
 * Handles environment variables, defaults, path resolution, and validation.
 */

import os from 'node:os';
import path from 'node:path';
import { AppError } from './middleware/error-handler.js';

export const DEFAULT_CONFIG = {
  port: 3456,
  uploadDir: path.join(os.homedir(), 'Downloads', 'UniversalTrans'),
  tempDir: path.join(process.cwd(), 'temp'),
  chunkSize: 10 * 1024 * 1024, // 10MB
  maxFileSize: 10 * 1024 * 1024 * 1024, // 10GB
  maxConcurrentTransfers: 5,
  maxConnectedDevices: 20,
  uploadExpiry: 60 * 60 * 1000, // 1 hour
  thumbnailSize: 200,
  thumbnailQuality: 80,
  pin: null,
  autoOpenBrowser: true,
  logLevel: 'info',
};

/**
 * Resolves path strings, expanding '~' to the user's home directory.
 * @param {string} inputPath
 * @returns {string}
 */
export function resolvePath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') return '';
  if (inputPath.startsWith('~')) {
    return path.join(os.homedir(), inputPath.slice(1));
  }
  return path.resolve(inputPath);
}

/**
 * Validates a configuration object.
 * @param {object} cfg
 * @throws {AppError}
 */
export function validateConfig(cfg) {
  const port = Number(cfg.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new AppError(
      'CONFIG_INVALID',
      500,
      `Invalid port: ${cfg.port}. Must be between 1024 and 65535.`
    );
  }

  const chunkSize = Number(cfg.chunkSize);
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    throw new AppError(
      'CONFIG_INVALID',
      500,
      `Invalid chunkSize: ${cfg.chunkSize}. Must be greater than 0.`
    );
  }

  const maxFileSize = Number(cfg.maxFileSize);
  if (!Number.isFinite(maxFileSize) || maxFileSize <= 0) {
    throw new AppError(
      'CONFIG_INVALID',
      500,
      `Invalid maxFileSize: ${cfg.maxFileSize}. Must be greater than 0.`
    );
  }

  if (chunkSize > maxFileSize) {
    throw new AppError(
      'CONFIG_INVALID',
      500,
      `chunkSize (${chunkSize}) cannot exceed maxFileSize (${maxFileSize}).`
    );
  }

  const maxConcurrent = Number(cfg.maxConcurrentTransfers);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new AppError('CONFIG_INVALID', 500, 'maxConcurrentTransfers must be an integer >= 1.');
  }

  const maxDevices = Number(cfg.maxConnectedDevices);
  if (!Number.isInteger(maxDevices) || maxDevices < 1) {
    throw new AppError('CONFIG_INVALID', 500, 'maxConnectedDevices must be an integer >= 1.');
  }

  if (cfg.pin !== null && cfg.pin !== undefined) {
    const pinStr = String(cfg.pin);
    if (!/^\d{4,6}$/.test(pinStr)) {
      throw new AppError('CONFIG_INVALID', 500, 'PIN must be 4 to 6 numeric digits.');
    }
  }

  return true;
}

/**
 * Loads configuration by merging defaults, environment variables, and custom overrides.
 * @param {object} [overrides={}]
 * @returns {typeof DEFAULT_CONFIG}
 */
export function loadConfig(overrides = {}) {
  const env = process.env;

  const rawConfig = {
    port: env.UTRANS_PORT ? parseInt(env.UTRANS_PORT, 10) : DEFAULT_CONFIG.port,
    uploadDir: env.UTRANS_UPLOAD_DIR
      ? resolvePath(env.UTRANS_UPLOAD_DIR)
      : DEFAULT_CONFIG.uploadDir,
    tempDir: env.UTRANS_TEMP_DIR ? resolvePath(env.UTRANS_TEMP_DIR) : DEFAULT_CONFIG.tempDir,
    chunkSize: env.UTRANS_CHUNK_SIZE
      ? parseInt(env.UTRANS_CHUNK_SIZE, 10)
      : DEFAULT_CONFIG.chunkSize,
    maxFileSize: env.UTRANS_MAX_FILE_SIZE
      ? parseInt(env.UTRANS_MAX_FILE_SIZE, 10)
      : DEFAULT_CONFIG.maxFileSize,
    maxConcurrentTransfers: env.UTRANS_MAX_CONCURRENT
      ? parseInt(env.UTRANS_MAX_CONCURRENT, 10)
      : DEFAULT_CONFIG.maxConcurrentTransfers,
    maxConnectedDevices: env.UTRANS_MAX_DEVICES
      ? parseInt(env.UTRANS_MAX_DEVICES, 10)
      : DEFAULT_CONFIG.maxConnectedDevices,
    uploadExpiry: env.UTRANS_UPLOAD_EXPIRY
      ? parseInt(env.UTRANS_UPLOAD_EXPIRY, 10)
      : DEFAULT_CONFIG.uploadExpiry,
    thumbnailSize: DEFAULT_CONFIG.thumbnailSize,
    thumbnailQuality: DEFAULT_CONFIG.thumbnailQuality,
    pin: env.UTRANS_PIN ? env.UTRANS_PIN.trim() : DEFAULT_CONFIG.pin,
    autoOpenBrowser:
      env.UTRANS_AUTO_OPEN !== undefined
        ? env.UTRANS_AUTO_OPEN === 'true'
        : DEFAULT_CONFIG.autoOpenBrowser,
    logLevel: env.UTRANS_LOG_LEVEL || DEFAULT_CONFIG.logLevel,
    ...overrides,
  };

  // Ensure paths are properly resolved
  if (rawConfig.uploadDir) rawConfig.uploadDir = resolvePath(rawConfig.uploadDir);
  if (rawConfig.tempDir) rawConfig.tempDir = resolvePath(rawConfig.tempDir);

  validateConfig(rawConfig);
  return rawConfig;
}

export const config = loadConfig();
