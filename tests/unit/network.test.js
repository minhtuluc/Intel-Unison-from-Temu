import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLanIp, isLanIp } from '../../src/utils/network.js';

describe('Network Utilities', () => {
  describe('getLanIp()', () => {
    it('should return a valid LAN IPv4 or null on the host machine', () => {
      const ip = getLanIp();
      if (ip !== null) {
        assert.match(ip, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
        assert.equal(ip.startsWith('127.'), false, 'Should not return loopback');
      }
    });

    it('should select LAN IP and ignore loopback & internal interfaces', () => {
      const mockInterfaces = {
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        eth0: [{ address: '192.168.1.150', family: 'IPv4', internal: false }],
      };
      const ip = getLanIp(mockInterfaces);
      assert.equal(ip, '192.168.1.150');
    });

    it('should ignore virtual, docker, and vpn interfaces', () => {
      const mockInterfaces = {
        docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
        'vEthernet (WSL)': [{ address: '172.25.160.1', family: 'IPv4', internal: false }],
        tailscale0: [{ address: '100.64.0.1', family: 'IPv4', internal: false }],
        'Wi-Fi': [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
      };
      const ip = getLanIp(mockInterfaces);
      assert.equal(ip, '192.168.1.42');
    });

    it('should return null if only loopback is available', () => {
      const mockInterfaces = {
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      };
      const ip = getLanIp(mockInterfaces);
      assert.equal(ip, null);
    });

    it('should prioritize 192.168.x.x over other private ranges', () => {
      const mockInterfaces = {
        eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
        eth1: [{ address: '192.168.0.10', family: 'IPv4', internal: false }],
      };
      const ip = getLanIp(mockInterfaces);
      assert.equal(ip, '192.168.0.10');
    });
  });

  describe('isLanIp()', () => {
    it('should identify loopback IPs as LAN/local', () => {
      assert.equal(isLanIp('127.0.0.1'), true);
      assert.equal(isLanIp('127.0.1.1'), true);
      assert.equal(isLanIp('::1'), true);
    });

    it('should identify 192.168.x.x as LAN', () => {
      assert.equal(isLanIp('192.168.1.1'), true);
      assert.equal(isLanIp('192.168.254.100'), true);
    });

    it('should identify 10.x.x.x as LAN', () => {
      assert.equal(isLanIp('10.0.0.1'), true);
      assert.equal(isLanIp('10.255.255.255'), true);
    });

    it('should identify 172.16.0.0 - 172.31.255.255 as LAN', () => {
      assert.equal(isLanIp('172.16.0.1'), true);
      assert.equal(isLanIp('172.24.1.1'), true);
      assert.equal(isLanIp('172.31.255.254'), true);
      assert.equal(isLanIp('172.15.0.1'), false);
      assert.equal(isLanIp('172.32.0.1'), false);
    });

    it('should return false for public Internet IPs', () => {
      assert.equal(isLanIp('8.8.8.8'), false);
      assert.equal(isLanIp('1.1.1.1'), false);
      assert.equal(isLanIp('142.250.190.46'), false);
    });

    it('should handle invalid or empty inputs gracefully', () => {
      assert.equal(isLanIp(''), false);
      assert.equal(isLanIp(null), false);
      assert.equal(isLanIp('invalid.ip'), false);
      assert.equal(isLanIp('999.999.999.999'), false);
    });
  });
});
