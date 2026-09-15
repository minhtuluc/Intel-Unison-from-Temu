/**
 * LAN Device Discovery Service
 *
 * Identity is issued by the server: one registry record per WebSocket connection,
 * keyed by a server-generated id. Anything the client claims (device id, name,
 * platform) is stored as an untrusted display label only.
 */

import { randomUUID } from 'node:crypto';
import { AppError } from '../middleware/error-handler.js';

export class DiscoveryService {
  constructor(options = {}) {
    /** @type {Map<string, object>} deviceId -> device record */
    this.devices = new Map();
    /** @type {Map<string, string>} connectionId -> deviceId */
    this.connections = new Map();
    this.maxConnectedDevices = Number(options.maxConnectedDevices || 20);
  }

  /**
   * Registers a connection, creating its own device record.
   * @param {string} connectionId
   * @param {{ label?: string, platform?: string, ip?: string, isHost?: boolean }} [info]
   */
  addConnection(connectionId, info = {}) {
    const now = Date.now();

    // Re-registering on the same socket must not orphan the previous record.
    const existingId = this.connections.get(connectionId);
    const existing = existingId ? this.devices.get(existingId) : null;
    if (existing) {
      existing.label = info.label || existing.label;
      existing.platform = info.platform || existing.platform;
      existing.ip = info.ip || existing.ip;
      existing.isHost = Boolean(info.isHost);
      existing.lastSeen = now;
      return { ...existing };
    }

    if (!info.isHost && this.devices.size >= this.maxConnectedDevices) {
      throw new AppError(
        'TOO_MANY_DEVICES',
        429,
        `Maximum connected devices (${this.maxConnectedDevices}) reached`
      );
    }

    const device = {
      id: randomUUID(),
      connectionId,
      label: info.label || 'Unknown Device',
      labelUntrusted: true,
      platform: info.platform || 'unknown',
      ip: info.ip || '127.0.0.1',
      isHost: Boolean(info.isHost),
      joinedAt: now,
      lastSeen: now,
    };

    this.devices.set(device.id, device);
    this.connections.set(connectionId, device.id);

    return { ...device };
  }

  getDevice(deviceId) {
    const device = this.devices.get(deviceId);
    return device ? { ...device } : null;
  }

  getDeviceByConnection(connectionId) {
    const deviceId = this.connections.get(connectionId);
    return deviceId ? this.getDevice(deviceId) : null;
  }

  touchConnection(connectionId) {
    const deviceId = this.connections.get(connectionId);
    if (!deviceId) return false;
    const device = this.devices.get(deviceId);
    if (!device) return false;
    device.lastSeen = Date.now();
    return true;
  }

  removeConnection(connectionId) {
    const deviceId = this.connections.get(connectionId);
    if (!deviceId) return false;
    this.connections.delete(connectionId);
    this.devices.delete(deviceId);
    return true;
  }

  getDevices() {
    return Array.from(this.devices.values()).map((device) => ({ ...device }));
  }

  clear() {
    this.devices.clear();
    this.connections.clear();
  }
}
