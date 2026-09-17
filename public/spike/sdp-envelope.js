const TOKEN_PREFIX = 'utrans-sdp-v1:';

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encodes SDP into one copy-safe line so chat apps cannot collapse or linkify it. */
export function encodeSdpToken(sdp) {
  if (typeof sdp !== 'string' || !sdp.startsWith('v=0')) {
    throw new TypeError('SDP phải là chuỗi bắt đầu bằng v=0');
  }
  return `${TOKEN_PREFIX}${bytesToBase64(new TextEncoder().encode(sdp))}`;
}

/** Decodes a copy-safe token. Raw SDP remains accepted for direct local use. */
export function decodeSdpToken(input) {
  const value = String(input || '').trim();
  if (!value.startsWith(TOKEN_PREFIX)) return value;

  const payload = value.slice(TOKEN_PREFIX.length).replace(/\s+/g, '');
  if (!payload) throw new TypeError('SDP token trống');
  const sdp = new TextDecoder().decode(base64ToBytes(payload));
  if (!sdp.startsWith('v=0')) throw new TypeError('SDP token không hợp lệ');
  return sdp;
}
