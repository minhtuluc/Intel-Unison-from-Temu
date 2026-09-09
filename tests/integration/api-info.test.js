import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/server.js';
import { config } from '../../src/config.js';

describe('Integration: API Info & Auth', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = createServer();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('GET /api/info should return server status, platform, and QR code Data URL', async () => {
    const res = await fetch(`${baseUrl}/api/info`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.data.serverName);
    assert.ok(body.data.ip);
    assert.ok(body.data.connectUrl);
    assert.ok(body.data.qrCode.startsWith('data:image/png;base64,'));
    assert.equal(typeof body.data.uptime, 'number');
  });

  it('POST /api/auth should bypass when server PIN is null', async () => {
    const originalPin = config.pin;
    config.pin = null;

    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '1234' }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.token, 'bypass');

    config.pin = originalPin;
  });

  it('POST /api/auth should enforce PIN when configured and rate limit after 5 failures', async () => {
    const originalPin = config.pin;
    config.pin = '7788';

    // 1. Correct PIN succeeds
    const successRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '7788' }),
    });
    assert.equal(successRes.status, 200);
    const successBody = await successRes.json();
    assert.ok(successBody.data.token.startsWith('utrans_'));

    // 2. 4 wrong PIN attempts -> 401
    for (let i = 0; i < 4; i++) {
      const failRes = await fetch(`${baseUrl}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '0000' }),
      });
      assert.equal(failRes.status, 401);
    }

    // 3. 5th wrong attempt triggers rate limit -> 429
    const rateLimitRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '0000' }),
    });
    assert.equal(rateLimitRes.status, 429);
    const rateLimitBody = await rateLimitRes.json();
    assert.equal(rateLimitBody.error.code, 'RATE_LIMITED');

    config.pin = originalPin;
  });
});
