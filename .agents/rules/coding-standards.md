# UniversalTrans — Coding Standards & Agent Rules

> Mọi coding agent làm việc trên project này **BẮT BUỘC** tuân thủ toàn bộ quy tắc dưới đây.

---

## 1. Nguyên tắc cốt lõi

### 1.1 Think Before Code
- **KHÔNG** viết code ngay khi nhận task. Đọc hiểu context, xác định scope, kiểm tra file liên quan trước.
- Mỗi thay đổi phải trả lời được: "Thay đổi này giải quyết vấn đề gì? Có side effect nào không?"

### 1.2 Simplicity First
- Ưu tiên giải pháp đơn giản, dễ hiểu. Tránh over-engineering.
- Nếu có thể dùng thư viện chuẩn (built-in Node.js), KHÔNG thêm dependency mới.
- Mỗi function làm đúng 1 việc. Nếu function > 50 dòng, cần tách.

### 1.3 Surgical Changes
- Chỉ thay đổi những gì cần thiết. KHÔNG refactor code không liên quan.
- KHÔNG xóa comment, docstring, hoặc code hiện có trừ khi được yêu cầu rõ ràng.
- Mỗi commit/change phải atomic — có thể revert độc lập.

### 1.4 Security by Default
- **NEVER** trust user input. Validate và sanitize mọi input.
- Path traversal protection: mọi file path phải được resolve và check within allowed directories.
- Bind server chỉ trên LAN interface, KHÔNG bind `0.0.0.0` production.
- KHÔNG log sensitive data (PIN, full file paths).

---

## 2. Project Structure

```
UniversalTrans/
├── .agents/                  # Agent rules (this directory)
│   └── rules/
├── docs/                     # Documentation
│   ├── ROADMAP.md
│   ├── TECHNICAL_SPEC.md
│   ├── TESTING.md
│   └── ARCHITECTURE.md
├── src/                      # Server source code
│   ├── server.js             # Express server entry point
│   ├── config.js             # Configuration management
│   ├── routes/               # API route handlers
│   │   ├── files.js          # File browsing & sharing
│   │   ├── transfer.js       # Upload/download endpoints
│   │   └── info.js           # Server info & QR
│   ├── services/             # Business logic
│   │   ├── discovery.js      # LAN device discovery
│   │   ├── chunked-upload.js # Chunked upload manager
│   │   ├── thumbnail.js      # Image thumbnail generation
│   │   └── share-manager.js  # Staging area management
│   ├── middleware/            # Express middleware
│   │   ├── security.js       # Path validation, PIN check
│   │   ├── error-handler.js  # Centralized error handling
│   │   └── logger.js         # Request logging
│   ├── utils/                # Utility functions
│   │   ├── network.js        # LAN IP detection
│   │   ├── file-utils.js     # File type, size formatting
│   │   └── id-generator.js   # Unique ID generation
│   └── websocket/            # WebSocket handlers
│       ├── index.js          # WS server setup
│       └── handlers.js       # Event handlers
├── public/                   # Frontend (served statically)
│   ├── index.html
│   ├── css/
│   │   ├── variables.css     # CSS custom properties (design tokens)
│   │   ├── base.css          # Reset, typography, global styles
│   │   ├── components.css    # Component styles
│   │   ├── layout.css        # Layout & responsive
│   │   └── animations.css    # Transitions & animations
│   ├── js/
│   │   ├── app.js            # Main app entry
│   │   ├── connection.js     # WebSocket connection manager
│   │   ├── file-browser.js   # File browsing UI
│   │   ├── drop-zone.js      # Drag & drop handling
│   │   ├── transfer.js       # Transfer engine (chunked)
│   │   ├── ui.js             # UI rendering utilities
│   │   └── utils.js          # Client-side utilities
│   ├── icons/                # PWA icons
│   ├── manifest.json         # PWA manifest
│   └── sw.js                 # Service worker
├── tests/                    # Test files
│   ├── unit/                 # Unit tests
│   ├── integration/          # Integration tests
│   └── fixtures/             # Test data
├── scripts/                  # Build & utility scripts
├── package.json
├── .eslintrc.json            # Linting config
├── .prettierrc               # Formatting config
└── README.md
```

### Quy tắc cấu trúc
- **KHÔNG** đặt business logic trong route handlers. Route chỉ parse request → gọi service → trả response.
- **KHÔNG** đặt file ngoài cấu trúc trên mà không update document.
- Mỗi module export rõ ràng. Dùng named exports, tránh default export.
- File utility KHÔNG được import từ route hoặc service. Dependency flow: `routes → services → utils`.

---

## 3. Coding Conventions

### 3.1 JavaScript/Node.js
```javascript
// ✅ DO: Async/await, không callback hell
async function downloadFile(fileId) {
  const file = await shareManager.getFile(fileId);
  if (!file) throw new AppError('FILE_NOT_FOUND', 404);
  return file;
}

// ❌ DON'T: Callback pattern
function downloadFile(fileId, callback) {
  shareManager.getFile(fileId, (err, file) => { ... });
}
```

- **ES Modules**: Dùng `import/export` syntax (type: "module" trong package.json).
- **Async/Await**: Mọi async operation dùng async/await. KHÔNG dùng raw callbacks.
- **Error handling**: Mọi async function phải có try/catch hoặc error propagation rõ ràng.
- **Const by default**: Dùng `const`. Chỉ dùng `let` khi cần reassign. KHÔNG bao giờ dùng `var`.
- **Template literals**: Dùng backtick cho string interpolation, không dùng `+` concatenation.
- **Destructuring**: Dùng destructuring cho object và array params.
- **Naming**:
  - Variables/functions: `camelCase`
  - Constants: `UPPER_SNAKE_CASE`
  - Classes: `PascalCase`
  - Files: `kebab-case.js`
  - Event names: `noun:verb` (e.g., `transfer:progress`)

### 3.2 Error Handling Pattern
```javascript
// Tạo custom error class — MỌI error đều dùng class này
class AppError extends Error {
  constructor(code, statusCode, message, details = {}) {
    super(message);
    this.code = code;           // Machine-readable: 'FILE_NOT_FOUND'
    this.statusCode = statusCode; // HTTP status: 404
    this.details = details;      // Additional context
    this.isOperational = true;   // Distinguishes from programming errors
  }
}

// Route handler pattern — luôn có error boundary
router.get('/api/download/:fileId', async (req, res, next) => {
  try {
    // logic
  } catch (error) {
    next(error); // Forward to centralized error handler
  }
});
```

### 3.3 Frontend (Vanilla JS)
- **No framework**: Vanilla JS only. KHÔNG thêm React, Vue, Angular.
- **DOM manipulation**: Dùng `document.createElement()` + template literals cho complex HTML. KHÔNG dùng `innerHTML` với user data (XSS risk).
- **Event delegation**: Attach event listeners lên parent containers, dùng event delegation cho dynamic elements.
- **CSS Classes**: Toggle UI states bằng CSS classes, KHÔNG inline styles qua JS.
- **Module pattern**: Mỗi file JS là 1 module với API rõ ràng (IIFE hoặc ES module).

### 3.4 CSS
- **Custom Properties**: Mọi magic values (colors, spacing, fonts) phải là CSS variables trong `variables.css`.
- **BEM-like naming**: `.component__element--modifier` (e.g., `.file-card__name--truncated`).
- **Mobile-first**: Viết styles cho mobile trước, dùng `min-width` media queries cho desktop.
- **No !important**: Tuyệt đối KHÔNG dùng `!important` trừ utility classes.
- **Logical properties**: Ưu tiên `margin-inline`, `padding-block` cho i18n readiness.

---

## 4. API Design Rules

### 4.1 REST Conventions
- Response format nhất quán:
```json
// Success
{ "success": true, "data": { ... } }

// Error  
{ "success": false, "error": { "code": "FILE_NOT_FOUND", "message": "..." } }

// Paginated
{ "success": true, "data": [...], "pagination": { "total": 100, "page": 1, "limit": 20 } }
```

### 4.2 HTTP Status Codes
| Code | Usage |
|---|---|
| 200 | Success (GET, DELETE) |
| 201 | Created (POST upload) |
| 206 | Partial Content (range/chunk download) |
| 400 | Bad Request (invalid params) |
| 401 | Unauthorized (wrong PIN) |
| 404 | Not Found |
| 413 | Payload Too Large |
| 500 | Internal Server Error |

### 4.3 Rate Limiting
- KHÔNG áp rate limiting cho file transfer endpoints (speed priority).
- Rate limit cho auth endpoints (PIN): 5 attempts/minute.

---

## 5. Performance Rules

### 5.1 File Transfer
- **Streaming only**: KHÔNG đọc toàn bộ file vào memory. Dùng `fs.createReadStream()` → pipe → response. Tắt compression cho file.
- **Memory budget**: Server logic KHÔNG vượt 256MB RAM (ngoài OS cache).
- **Concurrent transfers**: Tối đa 5 concurrent (queue nếu vượt). Download progress client-side, upload via WS.
- **Chunk size**: 10MB per chunk (>=100MB dùng chunked, <100MB đơn). Max 10GB.
- **Bind**: LAN IP mặc định, allow localhost test, cấm 0.0.0.0 prod.

### 5.2 Thumbnail
- Generate lazy (on-demand), cache kết quả.
- Max dimension: 200x200px, quality 80%, format: WebP (fallback JPEG).
- Chỉ ảnh. KHÔNG generate cho file >100MB / video. Dùng placeholder icon. Không ffmpeg MVP.

### 5.3 Frontend
- **No external CDN**: Mọi asset phải local (offline LAN operation).
- **Lazy load**: Thumbnails load khi scroll into view (IntersectionObserver).
- **Debounce**: Search/filter input debounce 300ms.
- **Virtual scroll**: Nếu file list > 100 items, implement virtual scrolling.

---

## 6. Logging & Observability

### 6.1 Log Levels
```javascript
// Dùng console có prefix, hoặc logger module
logger.info('Server started', { port: 3456, ip: '192.168.1.100' });
logger.warn('Large file upload', { size: '5.2GB', fileId: 'abc123' });
logger.error('Upload failed', { error: err.message, fileId: 'abc123' });
```

### 6.2 Log Rules
- **INFO**: Server start/stop, device connect/disconnect, transfer complete.
- **WARN**: Large file operations, slow transfers, retry attempts.
- **ERROR**: Failed transfers, unhandled errors, security violations.
- **KHÔNG log**: Full file paths (security), file contents, PIN values.
- **DO log**: File IDs, sizes, transfer durations, client IPs (LAN only).

---

## 7. Git Conventions

### 7.1 Commit Messages
```
<type>(<scope>): <description>

Types: feat, fix, refactor, docs, test, chore, perf
Scope: server, frontend, transfer, security, config

Examples:
feat(transfer): add chunked upload with resume support
fix(frontend): correct iOS Safari file download behavior
perf(server): switch to streaming for large file downloads
test(transfer): add integration tests for 1GB file upload
```

### 7.2 Branch Strategy
- `main`: Production-ready code only.
- `dev`: Development branch, merge features here.
- `feat/<name>`: Feature branches.
- `fix/<name>`: Bug fix branches.

---

## 8. Dependency Rules

### 8.1 Approved Dependencies
| Package | Purpose | Required |
|---|---|---|
| `express` | HTTP server | Yes |
| `ws` | WebSocket server | Yes |
| `multer` | File upload parsing | Yes |
| `qrcode` | QR code generation | Yes |
| `archiver` | Zip streaming (Phase 5 folder zip) | Phase 5 |
| `mime-types` | MIME type detection | Yes |
| `sharp` | Image thumbnails (optional, graceful fallback) | Yes, optional |
| `open` | Auto-open browser | Yes |
| `nanoid` | ID generation | Yes |

DevDependencies: `eslint`, `prettier`, `supertest`, `nodemon` (dev). `playwright` optional Phase 2+.
No ffmpeg MVP. No framework frontend. No `tus`/WebRTC.

### 8.2 Dependency Policy
- **KHÔNG** thêm dependency mới mà không document lý do trong commit message.
- **KHÔNG** dùng dependency cho task mà Node.js built-in có thể làm (e.g., `path`, `fs`, `os`, `crypto`).
- **KHÔNG** dùng dependency có < 1000 weekly downloads hoặc unmaintained (> 1 year no update).
- Mỗi dependency phải được pin version chính xác trong package.json.

---

## 9. Security Checklist (Mỗi PR/Change)

- [ ] Input validation: Mọi user input được validate (type, length, format).
- [ ] Path traversal: File paths resolved và checked within allowed directories.
- [ ] No eval/exec: KHÔNG dùng `eval()`, `new Function()`, hoặc `child_process.exec()` với user input.
- [ ] XSS: Frontend KHÔNG dùng `innerHTML` với data từ server/user.
- [ ] CORS: Chỉ allow origin từ LAN IPs.
- [ ] File type: Validate MIME type thực tế (magic bytes), không chỉ dựa vào extension.
- [ ] Size limits: Enforce max file size checks trước khi accept upload.
- [ ] Temp cleanup: Incomplete uploads được cleanup sau timeout.
