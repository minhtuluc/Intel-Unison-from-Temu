import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DiscoveryService } from '../../src/services/discovery.js';

describe('Device registry: server-issued identity keyed by connection', () => {
  it('tracks one entry per connection and keeps a peer online while a tab remains', () => {
    const discovery = new DiscoveryService();

    const first = discovery.addConnection('conn-1', { label: 'Pixel 8', platform: 'android' });
    const second = discovery.addConnection('conn-2', { label: 'Pixel 8', platform: 'android' });

    assert.equal(discovery.getDevices().length, 2);
    assert.notEqual(first.id, second.id);

    discovery.removeConnection('conn-1');
    assert.equal(discovery.getDevices().length, 1);
    assert.equal(discovery.getDevice(second.id)?.label, 'Pixel 8');

    discovery.removeConnection('conn-2');
    assert.equal(discovery.getDevices().length, 0);
  });

  it('keeps identity server-issued and marks client labels untrusted', () => {
    const discovery = new DiscoveryService();
    const device = discovery.addConnection('conn-3', {
      label: 'Laptop',
      platform: 'windows',
      ip: '192.168.1.20',
      isHost: true,
    });

    assert.match(device.id, /^[0-9a-f-]{36}$/);
    assert.equal(device.label, 'Laptop');
    assert.equal(device.labelUntrusted, true);
    assert.equal(device.isHost, true);
    assert.equal(device.connectionId, 'conn-3');
    assert.equal(device.ip, '192.168.1.20');
  });

  it('refreshes lastSeen and reports unknown connections safely', () => {
    const discovery = new DiscoveryService();
    const device = discovery.addConnection('conn-4', { label: 'Tablet' });
    const originalSeen = device.lastSeen;

    assert.equal(discovery.touchConnection('conn-4'), true);
    assert.ok(discovery.getDevice(device.id).lastSeen >= originalSeen);

    assert.equal(discovery.touchConnection('missing'), false);
    assert.equal(discovery.removeConnection('missing'), false);
    assert.equal(discovery.getDevice('missing'), null);
  });

  it('keeps one record per connection when a socket registers repeatedly', () => {
    const discovery = new DiscoveryService();

    const first = discovery.addConnection('conn-7', { label: 'First label' });
    const second = discovery.addConnection('conn-7', { label: 'Renamed' });
    const third = discovery.addConnection('conn-7', { label: 'Renamed again' });

    assert.equal(discovery.getDevices().length, 1);
    assert.equal(first.id, second.id);
    assert.equal(second.id, third.id);
    assert.equal(discovery.getDevice(first.id).label, 'Renamed again');

    discovery.removeConnection('conn-7');
    assert.equal(discovery.getDevices().length, 0);
  });

  it('clears every device', () => {
    const discovery = new DiscoveryService();
    discovery.addConnection('conn-5', { label: 'A' });
    discovery.addConnection('conn-6', { label: 'B' });

    discovery.clear();
    assert.deepEqual(discovery.getDevices(), []);
  });
});

describe('Device registry: identity key index (UT-020)', () => {
  it('resolves every live connection sharing an identity key', () => {
    const discovery = new DiscoveryService();
    discovery.addConnection('conn-a', { identityKeys: ['conn:conn-a', 'dev:abc', 'sess:t1'] });
    discovery.addConnection('conn-b', { identityKeys: ['conn:conn-b', 'dev:abc'] });
    discovery.addConnection('conn-c', { identityKeys: ['conn:conn-c'] });

    assert.deepEqual([...discovery.getConnectionIdsForKeys(['dev:abc'])].sort(), [
      'conn-a',
      'conn-b',
    ]);
    assert.deepEqual([...discovery.getConnectionIdsForKeys(['sess:t1'])], ['conn-a']);
    assert.equal(discovery.getConnectionIdsForKeys(['dev:missing']).size, 0);
    assert.equal(discovery.getConnectionIdsForKeys([]).size, 0);
  });

  it('replaces keys on re-registration and drops them on disconnect', () => {
    const discovery = new DiscoveryService();
    discovery.addConnection('conn-a', { identityKeys: ['dev:abc'] });
    discovery.addConnection('conn-a', { identityKeys: ['conn:conn-a'] });

    assert.equal(discovery.getConnectionIdsForKeys(['dev:abc']).size, 0);
    assert.deepEqual([...discovery.getConnectionIdsForKeys(['conn:conn-a'])], ['conn-a']);

    discovery.removeConnection('conn-a');
    assert.equal(discovery.getConnectionIdsForKeys(['conn:conn-a']).size, 0);
  });

  it('drops a lapsed credential without touching the durable keys', () => {
    const discovery = new DiscoveryService();
    discovery.addConnection('conn-a', { identityKeys: ['conn:conn-a', 'dev:abc', 'sess:t1'] });

    discovery.updateIdentityKeys('conn-a', ['conn:conn-a', 'dev:abc']);

    assert.equal(discovery.getConnectionIdsForKeys(['sess:t1']).size, 0);
    assert.deepEqual([...discovery.getConnectionIdsForKeys(['dev:abc'])], ['conn-a']);
  });

  it('leaves no identity behind when the device cap rejects a registration', () => {
    const discovery = new DiscoveryService({ maxConnectedDevices: 1 });
    discovery.addConnection('conn-1', { identityKeys: ['dev:one'] });

    assert.throws(
      () => discovery.addConnection('conn-2', { identityKeys: ['dev:two'] }),
      /Maximum connected devices/
    );
    assert.equal(discovery.getConnectionIdsForKeys(['dev:two']).size, 0);
    assert.deepEqual([...discovery.getConnectionIdsForKeys(['dev:one'])], ['conn-1']);
  });

  it('clears the identity index with the devices', () => {
    const discovery = new DiscoveryService();
    discovery.addConnection('conn-a', { identityKeys: ['dev:abc'] });

    discovery.clear();
    assert.equal(discovery.getConnectionIdsForKeys(['dev:abc']).size, 0);
    assert.equal(discovery.identityIndex.size, 0);
  });
});
