/**
 * ID Generator
 * Generates URL-safe unique IDs using nanoid.
 */

import { nanoid } from 'nanoid';

/**
 * Generates a unique identifier with an optional prefix.
 * @param {string} [prefix=''] - e.g. 'f_', 'up_', 'dev_'
 * @param {number} [size=12] - Length of random nanoid suffix
 * @returns {string} e.g. "f_V1StGXR8_Z5j"
 */
export function generateId(prefix = '', size = 12) {
  return `${prefix}${nanoid(size)}`;
}

/**
 * Generates an ID for staged files.
 * @returns {string} e.g. "f_abc123456"
 */
export function generateFileId() {
  return generateId('f_');
}

/**
 * Generates an ID for chunked upload sessions.
 * @returns {string} e.g. "up_abc123456"
 */
export function generateUploadId() {
  return generateId('up_');
}

/**
 * Generates an ID for connected devices.
 * @returns {string} e.g. "dev_abc123456"
 */
export function generateDeviceId() {
  return generateId('dev_');
}
