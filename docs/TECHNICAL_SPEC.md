# UniversalTrans — Technical Specification

> Version: 1.0 | Last Updated: 2026-09-09

---

## 1. System Overview

**UniversalTrans** là ứng dụng truyền file 2 chiều giữa các thiết bị trên cùng mạng WLAN, hoạt động theo mô hình AirDrop-like: on-demand, ephemeral, zero-config.

### 1.1 Supported Platforms
| Platform | Role | Runtime |
|---|---|---|
| Windows 10/11 | Server + Client | Node.js ≥ 18 LTS |
| Linux (Ubuntu/Debian) | Server + Client | Node.js ≥ 18 LTS |
| Android 10+ | Client | Chrome 90+ (PWA) |
| iOS 15+ | Client | Safari 15+ (PWA) |
| iPadOS 15+ | Client | Safari 15+ (PWA) |

### 1.2 System Requirements
| Requirement | Minimum | Recommended |
|---|---|---|
| Node.js | 18.x LTS | 20.x LTS |
| RAM (server) | 256MB available | 512MB |
| Disk (server) | Space for temp chunks | SSD recommended |
| Network | WiFi 4 (802.11n) | WiFi 5/6 (802.11ac/ax) |
| Browser | Chrome 90 / Safari 15 | Latest stable |

---

## 2. Architecture

### 2.1 Component Diagram

```
┌─────────────────────────────────────────────────────┐
│                   PC (Server)                        │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ Express   │  │WebSocket │  │  Share Manager   │   │
│  │ HTTP      │◄─┤ Server   │  │  (Staging Area)  │   │
│  │ Server    │  │ (ws)     │  └────────┬─────────┘   │
│  └─────┬─────┘  └────┬─────┘           │             │
│        │              │                 │             │
│  ┌─────┴──────────────┴─────────────────┴──────────┐ │
│  │              Service Layer                       │ │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────────┐    │ │
│  │  │Chunked  │ │Thumbnail │ │  QR/Info      │    │ │
│  │  │Transfer │ │Generator │ │  (no UDP MVP) │    │ │
│  │  └─────────┘ └──────────┘ └───────────────┘    │ │
│  └──────────────────┬──────────────────────────────┘ │
│                     │                                │
│  ┌──────────────────┴──────────────────────────────┐ │
│  │           File System Access                     │ │
│  │  Staging Area │ Upload Dir │ Temp Chunks         │ │
│  └──────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
            ▲              ▲
            │   WLAN       │
     HTTP/WS│         HTTP/WS
            │              │
    ┌───────┴───┐   ┌──────┴────┐
    │  Android  │   │  iPhone   │
    │  Chrome   │   │  Safari   │
    │  PWA      │   │  PWA      │
    └───────────┘   └───────────┘
```

### 2.2 Data Flow

#### Upload (Device → PC)
```
1. Client: POST /api/upload/init { fileName, fileSize, mimeType }
2. Server: Validate → Create uploadId → Return { uploadId, chunkSize, totalChunks }
3. Client: For each chunk:
   a. POST /api/upload/chunk { uploadId, chunkIndex, blob }
   b. Server: Write chunk to temp → WS broadcast progress
4. Client: POST /api/upload/complete { uploadId }
5. Server: Merge chunks → Move to uploadDir → WS broadcast complete
6. Server: Cleanup temp chunks
```

#### Download (PC → Device)
```
1. Client: GET /api/shared → List of shared files
2. Client: GET /api/download/:fileId (direct link, không blob URL cho file >500MB iOS)
   - Server: Check Range header, fs.createReadStream({start,end}) → pipe, headers
     Content-Type/Disposition/Length, Accept-Ranges, 206 khi resume
   - Progress: CLIENT tự tính (XHR/fetch onprogress). Server KHÔNG broadcast download progress
   - Video preview: dùng cùng endpoint qua <video src="/api/download/:id">
3. Client: Save to Downloads (browser native)
```

#### Share (PC adds file to staging)
```
1. PC Browser: Drag file vào drop zone (browser sandbox: không đọc được absolute path)
2. Client JS: Đọc File object → POST /api/share dạng multipart (upload content → staging)
   Chỉ CLI/Electron local mới được POST /api/share JSON {paths:[]} với absolute path
3. Server: ShareManager validate → WS broadcast share:update
4. All clients: Nhận file list mới
```

---

## 3. API Specification

### 3.1 Server Info

#### `GET /api/info`
```json
// Response 200
{
  "success": true,
  "data": {
    "serverName": "DESKTOP-ABC123",
    "platform": "win32",
    "version": "1.0.0",
    "ip": "192.168.1.100",
    "port": 3456,
    "qrCode": "data:image/png;base64,...",
    "connectedDevices": 3,
    "uptime": 3600
  }
}
```

### 3.2 Shared Files

#### `GET /api/shared`
```json
// Response 200
{
  "success": true,
  "data": {
    "files": [
      {
        "id": "f_abc123",
        "name": "photo.jpg",
        "size": 4521984,
        "sizeFormatted": "4.3 MB",
        "mimeType": "image/jpeg",
        "type": "image",
        "sharedAt": "2026-09-09T22:00:00Z",
        "hasThumbnail": true
      }
    ],
    "totalSize": 15728640,
    "totalSizeFormatted": "15 MB",
    "fileCount": 3
  }
}
```

#### `POST /api/share`
PC adds file to staging — dual mode:
- Browser drop-zone: `multipart/form-data` với `files` (khuyến nghị MVP, vì browser không cho absolute path)
- Local only (CLI/Electron): JSON `{ "paths": ["C:\\Users\\user\\Desktop\\photo.jpg"] }`
```json
// Request (local mode)
{ "paths": ["C:\\Users\\user\\Desktop\\photo.jpg", "C:\\Users\\user\\Videos\\clip.mp4"] }

// Response 201
{
  "success": true,
  "data": {
    "shared": [
      { "id": "f_abc123", "name": "photo.jpg", "size": 4521984 },
      { "id": "f_def456", "name": "clip.mp4", "size": 1572864000 }
    ]
  }
}
```

#### `DELETE /api/share/:fileId`
Remove file from staging (does NOT delete the actual file). Không dùng `DELETE /api/unshare`.

#### `POST /api/auth`
PIN verify (khi `pin != null`): `{pin:"1234"}` → `{token}`. Dùng `Authorization: Bearer <token>` cho các API sau. Rate-limit 5/phút, lockout 5 phút.
```json
// Response 200
{ "success": true, "data": { "removed": "f_abc123" } }
```

### 3.3 File Transfer

#### `GET /api/download/:fileId`
Stream download with resume support.
```
Headers:
  Range: bytes=1048576-  (optional, for resume)

Response Headers:
  Content-Type: video/mp4
  Content-Length: 1572864000
  Content-Disposition: attachment; filename="clip.mp4"
  Accept-Ranges: bytes
  Content-Range: bytes 1048576-1572864000/1572864000  (if range request)
```

#### `GET /api/thumbnail/:fileId`
```
Response: WebP image 200x200, quality 80%
Cache-Control: public, max-age=3600
```

### 3.4 Chunked Upload

#### `POST /api/upload/init`
```json
// Request
{
  "fileName": "large_video.mp4",
  "fileSize": 5368709120,
  "mimeType": "video/mp4"
}

// Response 200
{
  "success": true,
  "data": {
    "uploadId": "up_xyz789",
    "chunkSize": 10485760,
    "totalChunks": 512,
    "expiresAt": "2026-09-10T22:00:00Z"
  }
}
```

#### `POST /api/upload/chunk`
```
Content-Type: multipart/form-data

Fields:
  uploadId: "up_xyz789"
  chunkIndex: 42
  chunk: <binary data, max 10MB>

// Response 200
{
  "success": true,
  "data": {
    "chunkIndex": 42,
    "receivedChunks": 43,
    "totalChunks": 512,
    "progress": 8.4
  }
}
```

#### `GET /api/upload/status/:uploadId`
For resume after reconnection.
```json
// Response 200
{
  "success": true,
  "data": {
    "uploadId": "up_xyz789",
    "fileName": "large_video.mp4",
    "totalChunks": 512,
    "receivedChunks": [0, 1, 2, ..., 134],
    "nextChunk": 135,
    "progress": 26.4,
    "expiresAt": "2026-09-10T22:00:00Z"
  }
}
```

#### `POST /api/upload/complete`
```json
// Request
{ "uploadId": "up_xyz789" }

// Response 200
{
  "success": true,
  "data": {
    "fileName": "large_video.mp4",
    "filePath": "~/Downloads/UniversalTrans/large_video.mp4",
    "size": 5368709120,
    "duration": 45.2,
    "averageSpeed": "118.7 MB/s"
  }
}
```

### 3.5 Simple Upload (files < 100MB)
#### `POST /api/upload`
```
Content-Type: multipart/form-data
Field: files (multiple)

// Response 201
{
  "success": true,
  "data": {
    "uploaded": [
      { "name": "screenshot.png", "size": 245760, "path": "~/Downloads/UniversalTrans/screenshot.png" }
    ]
  }
}
```

---

## 4. WebSocket Protocol

### 4.1 Connection
```
URL: ws://<server-ip>:3456/ws
```

### 4.2 Message Format
```json
{
  "event": "transfer:progress",
  "data": { ... },
  "timestamp": "2026-09-09T22:00:00Z"
}
```

### 4.3 Events

| Event | Direction | Payload |
|---|---|---|
| `device:join` | S→C | `{ deviceId, deviceName, platform, ip }` |
| `device:leave` | S→C | `{ deviceId }` |
| `share:update` | S→C | `{ files: [...], totalSize, fileCount }` |
| `transfer:progress` | S→C | Chỉ upload `{ transferId, fileId, fileName, progress, speed, eta }`. Download do client tự tính, không broadcast |
| `transfer:complete` | S→C | `{ transferId, fileId, fileName, size, duration, speed }` |
| `transfer:error` | S→C | `{ transferId, fileId, error, retryable }` |
| `client:register` | C→S | `{ deviceName, platform, userAgent }` |
| `client:ping` | C→S | `{}` |
| `server:pong` | S→C | `{ uptime, connectedDevices }` |

### 4.4 Heartbeat
- Client sends `client:ping` every 30 seconds.
- Server responds with `server:pong`.
- If no ping received for 90 seconds, server considers device disconnected.

---

## 5. Performance Requirements

### 5.1 Transfer Speed
| Metric | Target | Minimum |
|---|---|---|
| Small file (< 10MB) | < 1 second | < 3 seconds |
| Medium file (100MB) | < 3 seconds (WiFi 6) | < 10 seconds |
| Large file (1GB) | < 20 seconds (WiFi 6) | < 45 seconds |
| Very large file (5GB) | < 100 seconds (WiFi 6) | < 5 minutes |

### 5.2 Resource Usage
| Metric | Limit |
|---|---|
| Server RAM | < 256MB (excluding OS cache) |
| Server CPU | < 30% sustained during transfer |
| Temp disk (chunks) | Auto-cleanup after 1 hour |
| Max concurrent transfers | 5 |
| Max connected devices | 20 |

### 5.3 Startup Time
| Metric | Target |
|---|---|
| Server startup | < 2 seconds |
| QR code display | < 3 seconds |
| First page load (client) | < 1 second (LAN) |
| WebSocket connection | < 500ms |

---

## 6. Security Specification

### 6.1 Network Security
- Server binds LAN IP mặc định; allow `127.0.0.1` cho test/dev; cấm `0.0.0.0` ở prod (override env phải warn).
- No internet access required or used. Không dùng CDN ngoài (LAN offline).
- HTTP cho LAN tin cậy. PWA lưu ý: Chrome Android cài được trên `http://192.168.*`, iOS Safari cần Add to Home Screen thủ công + SW network-first tối thiểu; optional HTTPS self-signed (mkcert) cho full PWA ở Phase 4.

### 6.2 Access Control
- Optional PIN code (4-6 digits).
- PIN check via `POST /api/auth` → returns session token.
- Session token sent as `Authorization: Bearer <token>` header.
- PIN brute-force protection: 5 attempts/minute, lockout 5 minutes.

### 6.3 File System Security
- **Allowlist model**: Only explicitly shared files/paths are accessible.
- Path traversal prevention:
  ```javascript
  // REQUIRED: Resolve and validate every file path
  const resolved = path.resolve(requestedPath);
  if (!allowedPaths.some(p => resolved.startsWith(p))) {
    throw new AppError('ACCESS_DENIED', 403);
  }
  ```
- Upload directory: Confined to `~/Downloads/UniversalTrans/`.
- Temp chunks: Confined to `<app>/temp/`.
- No server-side file deletion by default (can be enabled in config).

### 6.4 Input Validation

| Input | Validation |
|---|---|
| File name | Max 255 chars, no path separators, no null bytes |
| File size | Check against available disk space |
| Chunk index | Integer, 0 ≤ index < totalChunks |
| Upload ID | Nanoid format, exists in active uploads |
| File ID | Nanoid format, exists in share list |
| PIN | 4-6 digits only |

---

## 7. Error Handling

### 7.1 Error Codes
| Code | HTTP | Description |
|---|---|---|
| `FILE_NOT_FOUND` | 404 | Requested file/upload not found |
| `ACCESS_DENIED` | 403 | Path outside allowed directories |
| `UPLOAD_EXPIRED` | 410 | Chunked upload timed out |
| `CHUNK_INVALID` | 400 | Invalid chunk index or data |
| `DISK_FULL` | 507 | Insufficient disk space |
| `FILE_TOO_LARGE` | 413 | File exceeds max size limit |
| `RATE_LIMITED` | 429 | Too many auth attempts |
| `SERVER_ERROR` | 500 | Unexpected internal error |

### 7.2 Retry Strategy
- Upload chunk failure: Auto-retry 3 times with exponential backoff (1s, 2s, 4s).
- WebSocket disconnect: Auto-reconnect with backoff (1s, 2s, 4s, 8s, max 30s).
- Download failure: Client can resume with Range header.

---

## 8. Configuration

### 8.1 Default Configuration
```javascript
export const DEFAULT_CONFIG = {
  port: 3456,
  uploadDir: '~/Downloads/UniversalTrans',
  tempDir: '<app>/temp',
  chunkSize: 10 * 1024 * 1024,      // 10MB
  maxFileSize: 10 * 1024 * 1024 * 1024, // 10GB
  maxConcurrentTransfers: 5,
  maxConnectedDevices: 20,
  uploadExpiry: 60 * 60 * 1000,      // 1 hour
  thumbnailSize: 200,
  thumbnailQuality: 80,
  pin: null,                          // No PIN by default
  autoOpenBrowser: true,
  logLevel: 'info',
};
```

### 8.2 Environment Variables
| Variable | Default | Description |
|---|---|---|
| `UTRANS_PORT` | 3456 | Server port |
| `UTRANS_UPLOAD_DIR` | ~/Downloads/UniversalTrans | Upload destination |
| `UTRANS_PIN` | (none) | Access PIN |
| `UTRANS_LOG_LEVEL` | info | Log verbosity |
| `UTRANS_MAX_FILE_SIZE` | 10GB | Max file size |
