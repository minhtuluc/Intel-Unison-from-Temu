/**
 * UniversalTrans Configuration Management
 * Handles environment variables, defaults, path resolution, and validation.
 */

import os from 'node:os';
import path from 'node:path';
import { AppError } from './middleware/error-handler.js';

export const DEFAULT_CONFIG = {
  port: 8080,
  uploadDir: path.join(os.homedir(), 'Downloads', 'UniversalTrans'),
  tempDir: path.join(process.cwd(), 'temp'),
  chunkSize: 10 * 1024 * 1024, // 10MB
  maxFileSize: 10 * 1024 * 1024 * 1024, // 10GB
  // Empty array = host authority is the only gate for source paths.
  // Non-empty = every staged source path must live inside one of these roots.
  allowedSourceDirs: [],
  maxConcurrentTransfers: 5,
  maxUploadSessions: 10,
  maxConnectedDevices: 20,
  storageQuota: 20 * 1024 * 1024 * 1024, // 20GB default storage quota
  uploadExpiry: 60 * 60 * 1000, // 1 hour
  thumbnailSize: 200,
  thumbnailQuality: 80,
  pin: null,
  sessionTtlMs: 24 * 60 * 60 * 1000, // PIN session lifetime
  maxSessions: 64,
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
  // 0 means "let the OS pick a free port" and is used by tests and launchers.
  if (!Number.isInteger(port) || port < 0 || (port > 0 && port < 1024) || port > 65535) {
    throw new AppError(
      'CONFIG_INVALID',
      500,
      `Invalid port: ${cfg.port}. Must be 0 (ephemeral) or between 1024 and 65535.`
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

  const maxUploadSessions = Number(cfg.maxUploadSessions ?? DEFAULT_CONFIG.maxUploadSessions);
  if (!Number.isInteger(maxUploadSessions) || maxUploadSessions < 1) {
    throw new AppError('CONFIG_INVALID', 500, 'maxUploadSessions must be an integer >= 1.');
  }

  const maxDevices = Number(cfg.maxConnectedDevices);
  if (!Number.isInteger(maxDevices) || maxDevices < 1) {
    throw new AppError('CONFIG_INVALID', 500, 'maxConnectedDevices must be an integer >= 1.');
  }

  const storageQuota = Number(cfg.storageQuota ?? DEFAULT_CONFIG.storageQuota);
  if (!Number.isFinite(storageQuota) || storageQuota <= 0) {
    throw new AppError('CONFIG_INVALID', 500, 'storageQuota must be greater than 0.');
  }

  const sessionTtlMs = Number(cfg.sessionTtlMs);
  if (!Number.isInteger(sessionTtlMs) || sessionTtlMs <= 0) {
    throw new AppError(
      'CONFIG_INVALID',
      500,
      `Invalid sessionTtlMs: ${cfg.sessionTtlMs}. Must be a positive integer.`
    );
  }

  const maxSessions = Number(cfg.maxSessions);
  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new AppError(
      'CONFIG_INVALID',
      500,
      `Invalid maxSessions: ${cfg.maxSessions}. Must be an integer >= 1.`
    );
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
    maxUploadSessions: env.UTRANS_MAX_UPLOAD_SESSIONS
      ? parseInt(env.UTRANS_MAX_UPLOAD_SESSIONS, 10)
      : DEFAULT_CONFIG.maxUploadSessions,
    maxConnectedDevices: env.UTRANS_MAX_DEVICES
      ? parseInt(env.UTRANS_MAX_DEVICES, 10)
      : DEFAULT_CONFIG.maxConnectedDevices,
    storageQuota: env.UTRANS_STORAGE_QUOTA
      ? parseInt(env.UTRANS_STORAGE_QUOTA, 10)
      : DEFAULT_CONFIG.storageQuota,
    uploadExpiry: env.UTRANS_UPLOAD_EXPIRY
      ? parseInt(env.UTRANS_UPLOAD_EXPIRY, 10)
      : DEFAULT_CONFIG.uploadExpiry,
    thumbnailSize: DEFAULT_CONFIG.thumbnailSize,
    thumbnailQuality: DEFAULT_CONFIG.thumbnailQuality,
    pin: env.UTRANS_PIN ? env.UTRANS_PIN.trim() : DEFAULT_CONFIG.pin,
    sessionTtlMs: env.UTRANS_SESSION_TTL_MS
      ? parseInt(env.UTRANS_SESSION_TTL_MS, 10)
      : DEFAULT_CONFIG.sessionTtlMs,
    maxSessions: env.UTRANS_MAX_SESSIONS
      ? parseInt(env.UTRANS_MAX_SESSIONS, 10)
      : DEFAULT_CONFIG.maxSessions,
    autoOpenBrowser:
      env.UTRANS_AUTO_OPEN !== undefined
        ? env.UTRANS_AUTO_OPEN === 'true'
        : DEFAULT_CONFIG.autoOpenBrowser,
    logLevel: env.UTRANS_LOG_LEVEL || DEFAULT_CONFIG.logLevel,
    allowedSourceDirs: env.UTRANS_ALLOWED_SOURCE_DIRS
      ? env.UTRANS_ALLOWED_SOURCE_DIRS.split(path.delimiter)
          .map((dir) => dir.trim())
          .filter(Boolean)
          .map((dir) => resolvePath(dir))
      : DEFAULT_CONFIG.allowedSourceDirs,
    ...overrides,
  };

  // Ensure paths are properly resolved
  if (rawConfig.uploadDir) rawConfig.uploadDir = resolvePath(rawConfig.uploadDir);
  if (rawConfig.tempDir) rawConfig.tempDir = resolvePath(rawConfig.tempDir);
  if (!Array.isArray(rawConfig.allowedSourceDirs)) {
    throw new AppError('CONFIG_INVALID', 500, 'allowedSourceDirs must be an array of paths.');
  }
  rawConfig.allowedSourceDirs = rawConfig.allowedSourceDirs
    .filter((dir) => typeof dir === 'string' && dir.length > 0)
    .map((dir) => resolvePath(dir));

  validateConfig(rawConfig);
  return rawConfig;
}
