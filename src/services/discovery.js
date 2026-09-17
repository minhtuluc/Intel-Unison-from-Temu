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
    /** @type {Map<string, Set<string>>} identity key -> connectionIds currently presenting it */
    this.identityIndex = new Map();
    this.maxConnectedDevices = Number(options.maxConnectedDevices || 20);
  }

  /**
   * Registers a connection, creating its own device record.
   * @param {string} connectionId
   * @param {{ label?: string, platform?: string, ip?: string, isHost?: boolean, identityKeys?: string[] }} [info]
   */
  addConnection(connectionId, info = {}) {
    const now = Date.now();

    // Re-registering on the same socket must not orphan the previous record.
    const existingId = this.connections.get(connectionId);
    const existing = existingId ? this.devices.get(existingId) : null;
    if (existing) {
      // Identity keys are server-derived (see utils/client-identity.js); re-registering
      // the same socket replaces its previous index entries rather than stacking them.
      this.updateIdentityKeys(connectionId, info.identityKeys);
      existing.label = info.label || existing.label;
      existing.platform = info.platform || existing.platform;
      existing.ip = info.ip || existing.ip;
      existing.isHost = Boolean(info.isHost);
      existing.lastSeen = now;
      return { ...existing };
    }

    if (!info.isHost && this.devices.size >= this.maxConnectedDevices) {
      // Rejected registration must leave no identity behind: cap the device count first.
      this.updateIdentityKeys(connectionId, []);
      throw new AppError(
        'TOO_MANY_DEVICES',
        429,
        `Maximum connected devices (${this.maxConnectedDevices}) reached`
      );
    }

    this.updateIdentityKeys(connectionId, info.identityKeys);

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
    this._unindexIdentity(connectionId);
    const deviceId = this.connections.get(connectionId);
    if (!deviceId) return false;
    this.connections.delete(connectionId);
    this.devices.delete(deviceId);
    return true;
  }

  /**
   * Connection IDs of live sockets presenting any of the given identity keys.
   * This is how a relay offer reaches its receiver even after a reconnect.
   * @param {Iterable<string>} keys
   * @returns {Set<string>}
   */
  getConnectionIdsForKeys(keys = []) {
    const matched = new Set();
    for (const key of keys) {
      const connectionIds = this.identityIndex.get(key);
      if (!connectionIds) continue;
      for (const connectionId of connectionIds) matched.add(connectionId);
    }
    return matched;
  }

  getDevices() {
    return Array.from(this.devices.values()).map(({ connectionId: _c, ...device }) => ({
      ...device,
    }));
  }

  clear() {
    this.devices.clear();
    this.connections.clear();
    this.identityIndex.clear();
  }

  /**
   * Replaces the identity keys a connection is indexed under. Used when a credential
   * lapses (e.g. a revoked session) without the socket having closed yet.
   * @param {string} connectionId
   * @param {Iterable<string>} keys
   */
  updateIdentityKeys(connectionId, keys = []) {
    this._unindexIdentity(connectionId);
    this._indexIdentity(connectionId, Array.isArray(keys) ? keys : Array.from(keys || []));
  }

  /** @private */
  _indexIdentity(connectionId, keys = []) {
    if (!connectionId || !Array.isArray(keys)) return;
    for (const key of keys) {
      if (typeof key !== 'string' || !key) continue;
      let connectionIds = this.identityIndex.get(key);
      if (!connectionIds) {
        connectionIds = new Set();
        this.identityIndex.set(key, connectionIds);
      }
      connectionIds.add(connectionId);
    }
  }

  /** @private */
  _unindexIdentity(connectionId) {
    if (!connectionId) return;
    for (const [key, connectionIds] of this.identityIndex) {
      connectionIds.delete(connectionId);
      if (connectionIds.size === 0) this.identityIndex.delete(key);
    }
  }
}
