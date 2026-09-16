/**
 * UniversalTrans Client Utilities
 */

/**
 * Debounces a function call by the specified delay in milliseconds.
 * @param {Function} fn
 * @param {number} delay
 * @returns {Function}
 */
export function debounce(fn, delay = 300) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fn.apply(this, args);
    }, delay);
  };
}

/**
 * Turns an arbitrary thrown or rejected value into something a person can read.
 * A bare object would otherwise render as "[object Object]", which says nothing.
 * @param {unknown} reason
 * @returns {string}
 */
export function describeReason(reason) {
  if (reason === null || reason === undefined) return 'Unknown error';
  if (typeof reason === 'string') return reason;
  if (typeof reason === 'number' || typeof reason === 'boolean') return String(reason);
  if (typeof reason.message === 'string' && reason.message) return reason.message;
  try {
    const json = JSON.stringify(reason);
    if (json && json !== '{}') return json;
  } catch {
    // Circular or otherwise unserializable; fall through to the type tag.
  }
  const tag = Object.prototype.toString.call(reason);
  return tag === '[object Object]' ? 'Unknown error' : tag;
}

/**
 * Formats a byte number into human-readable string.
 * @param {number} bytes
 * @returns {string} e.g. "4.3 MB"
 */
export function formatFileSize(bytes) {
  if (typeof bytes !== 'number' || isNaN(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const clampedIndex = Math.min(i, units.length - 1);

  if (clampedIndex === 0) {
    return `${bytes} B`;
  }
  const value = bytes / Math.pow(k, clampedIndex);
  return `${parseFloat(value.toFixed(1))} ${units[clampedIndex]}`;
}

/**
 * Formats timestamp into relative human-readable string ("Just now", "5m ago").
 * @param {string|number|Date} timestamp
 * @returns {string}
 */
export function formatRelativeTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (isNaN(diffSec) || diffSec < 10) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/**
 * Copies text to the system clipboard.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback if clipboard API is unavailable
  }

  try {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const success = document.execCommand('copy');
    document.body.removeChild(input);
    return success;
  } catch {
    return false;
  }
}

/**
 * Formats seconds into human-readable ETA string ("45s", "3m 12s", "1h 5m").
 * @param {number} seconds
 * @returns {string}
 */
export function formatEta(seconds) {
  if (typeof seconds !== 'number' || isNaN(seconds) || seconds <= 0 || !isFinite(seconds)) {
    return '--';
  }
  const sec = Math.round(seconds);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hrs = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hrs}h ${remMin}m`;
}

/**
 * Pure JavaScript incremental SHA-256 implementation conforming to FIPS 180-4.
 * Computes digest incrementally with bounded RAM across streaming slices.
 */
export class IncrementalSha256 {
  static K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  constructor() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
      0x5be0cd19,
    ]);
    this.buffer = new Uint8Array(64);
    this.bufferLen = 0;
    this.totalBytes = 0;
    this.w = new Uint32Array(64);
  }

  _processBlock(block, offset) {
    const w = this.w;
    const K = IncrementalSha256.K;
    const view = new DataView(block.buffer, block.byteOffset + offset, 64);
    for (let t = 0; t < 16; t++) {
      w[t] = view.getUint32(t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      const s0 =
        (((w[t - 15] >>> 7) | (w[t - 15] << 25)) ^
          ((w[t - 15] >>> 18) | (w[t - 15] << 14)) ^
          (w[t - 15] >>> 3)) >>>
        0;
      const s1 =
        (((w[t - 2] >>> 17) | (w[t - 2] << 15)) ^
          ((w[t - 2] >>> 19) | (w[t - 2] << 13)) ^
          (w[t - 2] >>> 10)) >>>
        0;
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }

    let a = this.h[0];
    let b = this.h[1];
    let c = this.h[2];
    let d = this.h[3];
    let e = this.h[4];
    let f = this.h[5];
    let g = this.h[6];
    let h = this.h[7];

    for (let t = 0; t < 64; t++) {
      const s1 =
        (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + s1 + ch + K[t] + w[t]) >>> 0;
      const s0 =
        (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
    this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0;
    this.h[7] = (this.h[7] + h) >>> 0;
  }

  /**
   * Updates hasher state with a chunk of data.
   * @param {Uint8Array|ArrayBuffer|string} chunk
   * @returns {this}
   */
  update(chunk) {
    let data;
    if (typeof chunk === 'string') {
      data = new TextEncoder().encode(chunk);
    } else if (chunk instanceof ArrayBuffer) {
      data = new Uint8Array(chunk);
    } else if (chunk instanceof Uint8Array) {
      data = chunk;
    } else if (ArrayBuffer.isView(chunk)) {
      data = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } else {
      throw new TypeError('IncrementalSha256 update expects Uint8Array, ArrayBuffer, or string');
    }

    let offset = 0;
    let len = data.length;
    this.totalBytes += len;

    if (this.bufferLen > 0) {
      const needed = 64 - this.bufferLen;
      if (len >= needed) {
        this.buffer.set(data.subarray(0, needed), this.bufferLen);
        this._processBlock(this.buffer, 0);
        offset += needed;
        len -= needed;
        this.bufferLen = 0;
      } else {
        this.buffer.set(data, this.bufferLen);
        this.bufferLen += len;
        return this;
      }
    }

    while (len >= 64) {
      this._processBlock(data, offset);
      offset += 64;
      len -= 64;
    }

    if (len > 0) {
      this.buffer.set(data.subarray(offset), 0);
      this.bufferLen = len;
    }

    return this;
  }

  /**
   * Finalizes and returns the SHA-256 digest.
   * @param {'hex'|'binary'} [encoding='hex']
   * @returns {string|Uint8Array}
   */
  digest(encoding = 'hex') {
    const totalBits = BigInt(this.totalBytes) * 8n;
    this.buffer[this.bufferLen++] = 0x80;

    if (this.bufferLen > 56) {
      this.buffer.fill(0, this.bufferLen, 64);
      this._processBlock(this.buffer, 0);
      this.buffer.fill(0, 0, 56);
    } else {
      this.buffer.fill(0, this.bufferLen, 56);
    }

    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, 64);
    view.setBigUint64(56, totalBits, false);
    this._processBlock(this.buffer, 0);

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer, out.byteOffset, 32);
    for (let i = 0; i < 8; i++) {
      outView.setUint32(i * 4, this.h[i], false);
    }

    if (encoding === 'hex') {
      let hex = '';
      for (let i = 0; i < 32; i++) {
        hex += out[i].toString(16).padStart(2, '0');
      }
      return hex;
    }
    return out;
  }
}
