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
