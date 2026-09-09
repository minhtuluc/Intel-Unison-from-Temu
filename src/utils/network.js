/**
 * Network Utilities
 * Handles LAN IP address detection and LAN IP validation.
 */

import os from 'node:os';

// Common patterns for virtual, container, or VPN network interfaces
const VIRTUAL_INTERFACE_REGEX =
  /(loopback|virtual|vethernet|docker|bridge|vmnet|vbox|wsl|tailscale|wireguard|tap|tun|dummy)/i;

/**
 * Detects the primary LAN IPv4 address of the local machine.
 * Skips loopback, internal, and known virtual/VPN adapters.
 * @param {object} [customInterfaces] - Optional injected interfaces for testing
 * @returns {string|null} Local IPv4 address, or null if none found
 */
export function getLanIp(customInterfaces = null) {
  const interfaces = customInterfaces || os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs || VIRTUAL_INTERFACE_REGEX.test(name)) {
      continue;
    }

    for (const addr of addrs) {
      // Must be IPv4, non-internal, and not loopback
      if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('127.')) {
        candidates.push({ name, address: addr.address });
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // Prioritize typical home/office private LAN ranges (192.168.x.x, then 10.x.x.x, then 172.16-31.x.x)
  const prioritized = candidates.sort((a, b) => {
    const scoreA = getIpPriorityScore(a.address);
    const scoreB = getIpPriorityScore(b.address);
    return scoreB - scoreA;
  });

  return prioritized[0].address;
}

/**
 * Assigns priority score to IP ranges:
 * 192.168.x.x -> 3
 * 10.x.x.x -> 2
 * 172.16-31.x.x -> 1
 * other -> 0
 */
function getIpPriorityScore(ip) {
  if (ip.startsWith('192.168.')) return 3;
  if (ip.startsWith('10.')) return 2;
  const parts = ip.split('.').map(Number);
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return 1;
  return 0;
}

/**
 * Checks whether an IP address belongs to RFC 1918 private subnets or loopback.
 * @param {string} ip
 * @returns {boolean}
 */
export function isLanIp(ip) {
  if (!ip || typeof ip !== 'string') return false;

  // IPv6 localhost or IPv4 localhost
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.')) {
    return true;
  }

  // IPv4 mapped IPv6 (e.g. ::ffff:192.168.1.5)
  const cleanIp = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  const parts = cleanIp.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }

  // 10.0.0.0/8
  if (parts[0] === 10) return true;

  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;

  // Link-local 169.254.0.0/16
  if (parts[0] === 169 && parts[1] === 254) return true;

  return false;
}
