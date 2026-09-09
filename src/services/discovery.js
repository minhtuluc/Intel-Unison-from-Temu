/**
 * LAN Device Discovery Service
 * Tracks connected WebSocket clients and local network devices.
 */

export class DiscoveryService {
  constructor() {
    this.devices = new Map();
  }

  addDevice(deviceId, info) {
    const now = Date.now();
    const existing = this.devices.get(deviceId);
    const deviceRecord = {
      deviceId,
      deviceName: info.deviceName || 'Unknown Device',
      platform: info.platform || 'unknown',
      ip: info.ip || '127.0.0.1',
      isHost: Boolean(info.isHost),
      joinedAt: existing?.joinedAt || now,
      lastSeen: now,
    };
    this.devices.set(deviceId, deviceRecord);
    return deviceRecord;
  }

  getDevice(deviceId) {
    return this.devices.get(deviceId) || null;
  }

  touch(deviceId) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.lastSeen = Date.now();
      return true;
    }
    return false;
  }

  removeDevice(deviceId) {
    return this.devices.delete(deviceId);
  }

  getDevices() {
    return Array.from(this.devices.values());
  }

  clear() {
    this.devices.clear();
  }
}

export const discoveryService = new DiscoveryService();
