# UniversalTrans — Testing Strategy

> Mục tiêu: Zero technical debt, regression-free, production-grade quality.

---

## 1. Testing Pyramid

```
         ┌─────────┐
         │  E2E    │  ← 10% (Cross-device manual testing)
         │  Tests  │
        ─┴─────────┴─
       ┌───────────────┐
       │  Integration  │  ← 30% (API + WebSocket tests)
       │    Tests      │
      ─┴───────────────┴─
     ┌───────────────────┐
     │    Unit Tests     │  ← 60% (Services, Utils, Logic)
     └───────────────────┘
```

---

## 2. Test Framework & Tools

| Tool | Purpose |
|---|---|
| **Node.js built-in test runner** (`node:test`) | Unit & integration tests — zero dependency |
| **`node:assert/strict`** | Assertions — built-in |
| **`supertest`** (devDep) | HTTP API testing |
| **Playwright** (optional, Phase 2+) | E2E browser testing |

> [!IMPORTANT]
> Dùng Node.js built-in test runner (`node:test`) thay vì Jest/Mocha. Giảm dependency, chạy nhanh hơn, built-in coverage.

### Test Commands (cross-platform, không glob shell)
```json
{
  "scripts": {
    "test": "node --test tests/unit/",
    "test:integration": "node --test tests/integration/",
    "test:all": "node --test tests/unit/ tests/integration/",
    "test:coverage": "node --test --experimental-test-coverage tests/unit/ tests/integration/",
    "test:watch": "node --test --watch tests/unit/"
  }
}
```
Coverage chuẩn duy nhất: overall >80%, critical (utils, security, share-manager, chunked-upload) >=90%.

---

## 3. Unit Tests

### 3.1 Coverage Requirements

| Module | Min Coverage | Priority |
|---|---|---|
| `src/utils/*` | 95% | 🔴 Critical |
| `src/services/share-manager.js` | 90% | 🔴 Critical |
| `src/services/chunked-upload.js` | 90% | 🔴 Critical |
| `src/middleware/security.js` | 95% | 🔴 Critical |
| `src/services/thumbnail.js` | 80% | 🟡 Medium |
| `src/services/discovery.js` | 80% | 🟡 Medium |
| `src/routes/*` | 70% | 🟢 Normal |
| `public/js/*` | 60% | 🟢 Normal |

### 3.2 Unit Test Specifications

#### `utils/network.js`
```javascript
// Tests required:
// - getLanIp() returns valid IPv4 on Windows
// - getLanIp() returns valid IPv4 on Linux
// - getLanIp() skips loopback (127.x.x.x)
// - getLanIp() skips virtual adapters (VPN, Docker)
// - getLanIp() returns null when no LAN interface
```

#### `utils/file-utils.js`
```javascript
// Tests required:
// - formatFileSize() correctly formats bytes → KB/MB/GB/TB
// - formatFileSize(0) → "0 B"
// - formatFileSize(1073741824) → "1.0 GB"
// - getFileType() detects image, video, apk, document, other
// - getFileType() handles unknown MIME types
// - sanitizeFileName() removes path separators
// - sanitizeFileName() removes null bytes
// - sanitizeFileName() truncates at 255 chars
// - sanitizeFileName() preserves unicode
```

#### `services/share-manager.js`
```javascript
// Tests required:
// - addFile() adds file to staging → returns fileId
// - addFile() rejects non-existent paths
// - addFile() rejects paths outside allowed directories (SECURITY)
// - addFile() handles duplicate adds (same file) → no error, returns same id
// - removeFile() removes file from staging
// - removeFile() with invalid id → returns false, no error
// - getFile() returns file metadata
// - getFile() with invalid id → returns null
// - listFiles() returns all staged files
// - listFiles() empty staging → returns empty array
// - clear() removes all files from staging
```

#### `services/chunked-upload.js`
```javascript
// Tests required:
// - initUpload() creates upload session → returns uploadId
// - initUpload() calculates correct totalChunks for various file sizes
// - initUpload() rejects fileSize <= 0
// - initUpload() rejects fileSize > maxFileSize
// - addChunk() saves chunk to temp directory
// - addChunk() rejects invalid chunkIndex (negative, >= totalChunks)
// - addChunk() rejects duplicate chunkIndex → error, not corrupt
// - addChunk() rejects chunk for non-existent uploadId
// - getStatus() returns received chunks and missing chunks
// - complete() merges all chunks into final file
// - complete() fails if chunks are missing
// - complete() cleans up temp chunks after success
// - cleanup() removes expired uploads (> 1 hour)
// - cleanup() does NOT remove active uploads
// - concurrent addChunk() calls are safe (no race conditions)
```

#### `middleware/security.js`
```javascript
// Tests required:
// - validatePath() allows paths within shared directories
// - validatePath() BLOCKS path traversal (../ attacks)
// - validatePath() BLOCKS absolute paths outside allowed dirs
// - validatePath() BLOCKS null bytes in paths
// - validatePath() handles Windows-style paths (backslash)
// - validatePath() handles symlinks (resolve real path)
// - validatePin() accepts valid 4-6 digit PINs
// - validatePin() rejects non-numeric PINs
// - validatePin() rate limits after 5 attempts
// - validatePin() locks out for 5 minutes after rate limit
```

### 3.3 Unit Test Template
```javascript
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

describe('ShareManager', () => {
  let shareManager;

  beforeEach(() => {
    shareManager = new ShareManager({ /* test config */ });
  });

  describe('addFile()', () => {
    it('should add file to staging and return fileId', async () => {
      const result = await shareManager.addFile('/path/to/test.jpg');
      assert.ok(result.id, 'Should return a file ID');
      assert.equal(result.name, 'test.jpg');
    });

    it('should reject paths outside allowed directories', async () => {
      await assert.rejects(
        () => shareManager.addFile('/etc/passwd'),
        { code: 'ACCESS_DENIED' }
      );
    });
  });
});
```

---

## 4. Integration Tests

### 4.1 API Integration Tests

```javascript
// Tests required for each endpoint:

// GET /api/info
// - Returns server info with correct fields
// - Returns valid QR code data

// GET /api/shared
// - Returns empty list when nothing shared
// - Returns correct files after sharing
// - File metadata matches actual file

// POST /api/share
// - Adds file to staging → appears in GET /api/shared
// - Rejects non-existent paths → 404
// - Rejects path traversal → 403

// DELETE /api/share/:fileId
// - Removes file from staging
// - Returns 404 for non-existent fileId

// GET /api/download/:fileId
// - Downloads correct file content
// - Sets correct Content-Type header
// - Sets correct Content-Disposition header
// - Supports Range header (resume download)
// - Returns 206 for partial content
// - Returns 404 for non-existent fileId

// POST /api/upload (simple)
// - Uploads file → saves to uploadDir
// - Returns correct metadata
// - Handles multiple files
// - Rejects files exceeding size limit → 413

// POST /api/upload/init → chunk → complete (chunked)
// - Full cycle: init → upload all chunks → complete → file exists
// - Resume: init → upload partial → disconnect → status → resume → complete
// - Handles out-of-order chunks
// - Rejects expired uploads → 410
// - Cleans up temp after complete

// GET /api/thumbnail/:fileId
// - Returns WebP thumbnail for images
// - Returns 404 for non-image files
// - Caches and returns cached thumbnail on second request
```

### 4.2 WebSocket Integration Tests

```javascript
// Tests required:
// - Client connects → receives device list
// - Client connects → other clients receive device:join event
// - Client disconnects → other clients receive device:leave
// - Share file → all clients receive share:update
// - Upload progress → all clients receive transfer:progress
// - Heartbeat: client sends ping → server responds pong
// - Heartbeat timeout: no ping for 90s → server disconnects client
// - Reconnect: client reconnects → receives current state
```

### 4.3 Integration Test Template
```javascript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

describe('API Integration', () => {
  let server, baseUrl;

  before(async () => {
    server = await createServer({ port: 0 }); // Random port
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await server.close();
  });

  it('GET /api/info returns server information', async () => {
    const res = await fetch(`${baseUrl}/api/info`);
    assert.equal(res.status, 200);
    
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.data.ip);
    assert.ok(body.data.port);
    assert.ok(body.data.qrCode);
  });
});
```

---

## 5. Performance Tests

### 5.1 Transfer Speed Benchmarks
```javascript
// Benchmark suite — run manually, not in CI
// Tests:
// - Upload 10MB file → measure time → assert < 2 seconds
// - Upload 100MB file → measure time → assert < 5 seconds  
// - Upload 1GB file (chunked) → measure time → assert < 45 seconds
// - Download 1GB file → measure time → assert < 45 seconds
// - 3 concurrent uploads 100MB each → measure total → assert < 15 seconds
// - Memory usage during 1GB transfer → assert < 256MB
```

### 5.2 Stress Tests
```javascript
// Tests:
// - 10 concurrent WebSocket connections → all receive events
// - 20 connected devices → server responsive (< 100ms API response)
// - 5 concurrent file transfers → all complete successfully
// - Rapid connect/disconnect (50 times in 10s) → no memory leak
// - Upload 5GB file → server RAM stays < 256MB
```

---

## 6. Security Tests

### 6.1 Penetration Test Cases

| ID | Test | Expected Result |
|---|---|---|
| SEC-01 | `GET /api/download?path=../../etc/passwd` | 403 Access Denied |
| SEC-02 | `GET /api/download?path=C:\Windows\System32\config\SAM` | 403 Access Denied |
| SEC-03 | `POST /api/share` with path containing null bytes | 400 Bad Request |
| SEC-04 | `POST /api/upload` with filename `../../../evil.js` | Sanitized filename, saved safely |
| SEC-05 | Upload file with `.exe` extension disguised as `.jpg` | MIME type validation catches it |
| SEC-06 | 10 rapid PIN attempts | Rate limited after 5 |
| SEC-07 | WebSocket connection without registration | Disconnected after timeout |
| SEC-08 | Access from non-LAN IP (if possible to simulate) | Connection refused |
| SEC-09 | Upload exceeding maxFileSize | 413 rejected before consuming disk |
| SEC-10 | Malformed WebSocket messages | Error logged, connection not crashed |

### 6.2 Security Test Template
```javascript
describe('Security: Path Traversal', () => {
  const attacks = [
    '../../../etc/passwd',
    '..\\..\\..\\Windows\\System32\\config\\SAM',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'file%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    'test\x00.jpg',
    '....//....//etc/passwd',
  ];

  for (const attack of attacks) {
    it(`should block: ${attack}`, async () => {
      const res = await fetch(`${baseUrl}/api/download/${encodeURIComponent(attack)}`);
      assert.ok([400, 403, 404].includes(res.status),
        `Expected 400/403/404 but got ${res.status}`);
    });
  }
});
```

---

## 7. Cross-Platform Compatibility Tests

### 7.1 Manual Test Matrix

| # | Test Case | Win Chrome | Win Firefox | Linux Chrome | Android Chrome | iOS Safari | iPad Safari |
|---|---|---|---|---|---|---|---|
| 1 | Page loads correctly | | | | | | |
| 2 | File browser renders | | | | | | |
| 3 | Upload single file | | | | | | |
| 4 | Upload multiple files | | | | | | |
| 5 | Download file | | | | | | |
| 6 | Download with resume | | | | | | |
| 7 | Upload 2GB+ file | | | | | | |
| 8 | Progress bar accurate | | | | | | |
| 9 | PWA install | N/A | N/A | N/A | | | |
| 10 | Drag & drop | | | | N/A | N/A | |
| 11 | Responsive layout | | | | | | |
| 12 | QR code scan | N/A | N/A | N/A | | | |
| 13 | Device connect notification | | | | | | |
| 14 | Concurrent transfers | | | | | | |

### 7.2 Known Platform Quirks

| Platform | Quirk | Mitigation |
|---|---|---|
| iOS Safari | PWA service worker limits | Network-first strategy, minimal caching |
| iOS Safari | No `showDirectoryPicker()` | Use `<input type="file">` with `multiple` |
| iOS Safari | Download blob max ~500MB | Use direct download link, not blob URL |
| Android Chrome | Background tab throttling | Keep WebSocket alive with ping |
| Firefox | No `webkitdirectory` on mobile | Fallback to regular file picker |
| iPadOS Safari | Drag & drop only in Split View | Provide tap-to-upload fallback |

---

## 8. Test Data & Fixtures

### 8.1 Test Files
```
tests/fixtures/
├── small.jpg          (100KB - JPEG image)
├── medium.png         (5MB - PNG image)
├── sample.mp4         (50MB - MP4 video)
├── sample.apk         (20MB - Android APK)
├── unicode_名前.jpg   (100KB - Unicode filename)
├── no-extension        (1KB - No file extension)
├── empty.txt          (0B - Empty file)
└── special chars!@#.pdf (1KB - Special characters in name)
```

### 8.2 Generated Test Files
```javascript
// For large file tests, generate on-the-fly:
import { createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';

async function generateTestFile(path, sizeInMB) {
  const stream = createWriteStream(path);
  const chunkSize = 1024 * 1024; // 1MB chunks
  for (let i = 0; i < sizeInMB; i++) {
    stream.write(randomBytes(chunkSize));
  }
  stream.end();
}
```

---

## 9. CI/Pre-commit Checks

### 9.1 Pre-commit Checklist (Manual — No CI server)
```bash
# Run before every significant change:

# 1. Lint
npx eslint src/ public/js/

# 2. Unit tests
npm test

# 3. Integration tests  
npm run test:integration

# 4. Coverage check
npm run test:coverage
# Verify: overall > 80%, critical modules > 90%

# 5. Security audit
npm audit

# 6. Start server and smoke test
npm start
# Verify: QR code displays, browser opens, API responds
```

### 9.2 Definition of Done (per feature)
- [ ] Feature code written following coding standards
- [ ] Unit tests written and passing
- [ ] Integration tests written and passing (if API change)
- [ ] Security test cases added (if new endpoint/input)
- [ ] No new lint warnings
- [ ] Manual test on at least 1 mobile device
- [ ] Performance: no regression in transfer speed
- [ ] Error handling: all error paths covered
- [ ] Documentation updated (if API change)
