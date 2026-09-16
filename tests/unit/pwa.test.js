import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createServer } from '../../src/server.js';
import { APP_VERSION } from '../../src/version.js';

describe('PWA & Static Assets (Unit)', () => {
  const publicDir = path.resolve('public');

  describe('Web App Manifest', () => {
    const manifestPath = path.join(publicDir, 'manifest.json');

    it('should exist and be valid JSON', () => {
      assert.ok(fs.existsSync(manifestPath), 'manifest.json exists');
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(raw);

      assert.ok(manifest.name.includes('UniversalTrans'));
      assert.equal(manifest.short_name, 'UniversalTrans');
      assert.ok(manifest.start_url.startsWith('/'));
      assert.equal(manifest.display, 'standalone');
      assert.equal(manifest.theme_color, '#0a0e1a');
      assert.equal(manifest.background_color, '#0a0e1a');
    });

    it('should declare 192x192 and 512x512 icons', () => {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.ok(Array.isArray(manifest.icons), 'icons is array');
      assert.ok(manifest.icons.length >= 2, 'has at least 2 icons');

      const icon192 = manifest.icons.find((i) => i.sizes === '192x192');
      const icon512 = manifest.icons.find((i) => i.sizes === '512x512');

      assert.ok(icon192, 'has 192x192 icon');
      assert.ok(icon512, 'has 512x512 icon');
      assert.equal(icon192.src, '/icons/icon-192.png');
      assert.equal(icon512.src, '/icons/icon-512.png');
    });
  });

  describe('Icon and Asset Files', () => {
    it('should have valid PNG icon files on disk', () => {
      const icon192 = path.join(publicDir, 'icons', 'icon-192.png');
      const icon512 = path.join(publicDir, 'icons', 'icon-512.png');

      assert.ok(fs.existsSync(icon192), 'icon-192.png exists');
      assert.ok(fs.existsSync(icon512), 'icon-512.png exists');

      const stat192 = fs.statSync(icon192);
      const stat512 = fs.statSync(icon512);

      assert.ok(stat192.size > 100, `icon-192.png has valid size (${stat192.size} bytes)`);
      assert.ok(stat512.size > 100, `icon-512.png has valid size (${stat512.size} bytes)`);

      // Verify PNG magic bytes (0x89 0x50 0x4E 0x47)
      const buf192 = fs.readFileSync(icon192);
      assert.equal(buf192[0], 0x89);
      assert.equal(buf192[1], 0x50);
      assert.equal(buf192[2], 0x4e);
      assert.equal(buf192[3], 0x47);
    });

    it('should have a valid SVG favicon', () => {
      const favSvg = path.join(publicDir, 'favicon.svg');
      assert.ok(fs.existsSync(favSvg), 'favicon.svg exists');
      const content = fs.readFileSync(favSvg, 'utf8');
      assert.ok(content.includes('<svg'), 'contains svg element');
      assert.ok(content.includes('</svg>'), 'contains closing svg element');
    });
  });

  describe('Service Worker (sw.js)', () => {
    const swPath = path.join(publicDir, 'sw.js');

    it('should exist and define shell caching logic', () => {
      assert.ok(fs.existsSync(swPath), 'sw.js exists');
      const swCode = fs.readFileSync(swPath, 'utf8');

      assert.ok(swCode.includes('CACHE_NAME'), 'defines CACHE_NAME');
      assert.ok(swCode.includes('install'), 'listens to install');
      assert.ok(swCode.includes('activate'), 'listens to activate');
      assert.ok(swCode.includes('fetch'), 'listens to fetch');
      assert.ok(swCode.includes('/api'), 'handles or bypasses api routes');
      assert.ok(swCode.includes('/ws'), 'handles or bypasses ws routes');
    });

    it('caches the session-aware api client in the shell', () => {
      const swCode = fs.readFileSync(swPath, 'utf8');
      assert.ok(swCode.includes("'/js/api.js'"), 'api.js is part of the cached shell');
      assert.ok(swCode.includes("'/js/capabilities.js'"), 'capabilities.js is part of the shell');
    });

    it('takes its cache name from the server rather than a hand-edited literal', () => {
      const swCode = fs.readFileSync(swPath, 'utf8');
      // The source carries a placeholder; the route substitutes a version-derived
      // name so a release cannot ship a frontend fix behind a stale shell.
      assert.ok(
        swCode.includes("const CACHE_NAME = '__SHELL_CACHE_NAME__'"),
        'sw.js declares the cache name placeholder'
      );
      assert.equal(
        /utrans-shell-v\d+/.test(swCode),
        false,
        'no hand-maintained version literal remains in sw.js'
      );
    });

    it('waits for the page to ask before activating an update', () => {
      const swCode = fs.readFileSync(swPath, 'utf8');
      assert.ok(
        swCode.includes('SKIP_WAITING'),
        'the worker honours an explicit skip-waiting message'
      );
      assert.equal(
        (swCode.match(/self\.skipWaiting\(\)/g) || []).length,
        1,
        'skipWaiting is called exactly once, from the message handler'
      );
      assert.match(
        swCode,
        /addEventListener\('message'[\s\S]*?self\.skipWaiting\(\)/,
        'activation waits for the page to ask, so an update cannot swap assets mid-transfer'
      );
    });
  });

  describe('Security and Cache Headers', () => {
    const app = createServer();

    it('should set X-Content-Type-Options and X-Frame-Options on all responses', async () => {
      const res = await request(app).get('/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
    });

    it('should set no-cache headers for sw.js', async () => {
      const res = await request(app).get('/sw.js');
      assert.equal(res.status, 200);
      assert.ok(
        res.headers['cache-control']?.includes('no-cache'),
        `Expected no-cache, got: ${res.headers['cache-control']}`
      );
    });

    it('serves sw.js with the cache name derived from the app version (UT-016)', async () => {
      const res = await request(app).get('/sw.js');
      assert.equal(res.status, 200);

      const served = res.text;
      const expected = `utrans-shell-${APP_VERSION}`;
      assert.ok(served.includes(`const CACHE_NAME = '${expected}'`), `expected ${expected}`);
      assert.equal(
        served.includes('__SHELL_CACHE_NAME__'),
        false,
        'the placeholder must not reach the browser'
      );
      // The served shell must match what /api/info reports, or a client cannot tell
      // which version it is running.
      const info = await request(app).get('/api/info');
      assert.equal(info.body.data.version, APP_VERSION);
    });

    it('should set 1-hour cache-control for static assets like css and icons', async () => {
      const resCss = await request(app).get('/css/variables.css');
      assert.equal(resCss.status, 200);
      assert.ok(
        resCss.headers['cache-control']?.includes('max-age=3600'),
        `Expected max-age=3600, got: ${resCss.headers['cache-control']}`
      );

      const resIcon = await request(app).get('/icons/icon-192.png');
      assert.equal(resIcon.status, 200);
      assert.ok(
        resIcon.headers['cache-control']?.includes('max-age=3600'),
        `Expected max-age=3600, got: ${resIcon.headers['cache-control']}`
      );
    });
  });
});
