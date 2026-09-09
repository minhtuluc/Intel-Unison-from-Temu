/**
 * LAN Device Discovery Service
 * Tracks connected WebSocket clients and local network devices.
 */

export class DiscoveryService {
  constructor() {
    this.devices = new Map();
  }

  addDevice(deviceId, info) {
    this.devices.set(deviceId, { ...info, joinedAt: Date.now() });
  }

  removeDevice(deviceId) {
    this.devices.delete(deviceId);
  }

  getDevices() {
    return Array.from(this.devices.values());
  }
}

export const discoveryService = new DiscoveryService();
