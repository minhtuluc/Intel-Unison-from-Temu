import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/server.js';

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

  it('POST /api/auth should bypass when no PIN is configured for the app', async () => {
    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '1234' }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.token, 'bypass');
  });
});

describe('Integration: PIN session issuance', () => {
  let app, server, baseUrl, pinToken;

  before(async () => {
    app = createServer({ pin: '7788' });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.locals.sessions.revokeAll();
  });

  it('issues an opaque, expiring session for the correct PIN', async () => {
    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '7788' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    pinToken = body.data.token;

    assert.match(pinToken, /^[a-f0-9]{64}$/);
    assert.equal(pinToken.includes('utrans_'), false);
    assert.ok(Date.parse(body.data.expiresAt) > Date.now());
    assert.equal(body.data.expiresIn > 0, true);
  });

  it('rate limits after 5 failed attempts', async () => {
    for (let i = 0; i < 4; i++) {
      const failRes = await fetch(`${baseUrl}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '0000' }),
      });
      assert.equal(failRes.status, 401);
    }

    const rateLimitRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '0000' }),
    });
    assert.equal(rateLimitRes.status, 429);
    const rateLimitBody = await rateLimitRes.json();
    assert.equal(rateLimitBody.error.code, 'RATE_LIMITED');
  });

  it('gates data routes with the issued session', async () => {
    assert.equal((await fetch(`${baseUrl}/api/shared`)).status, 401);

    const gated = await fetch(`${baseUrl}/api/shared`, {
      headers: { 'X-Session-Token': pinToken },
    });
    assert.equal(gated.status, 200);
  });
});
