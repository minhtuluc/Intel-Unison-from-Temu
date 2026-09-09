# UniversalTrans — Architecture Decision Records

> Ghi nhận các quyết định kiến trúc quan trọng và lý do đằng sau chúng.

---

## ADR-001: Node.js + Express cho Server

### Context
Cần server chạy trên cả Windows và Linux, xử lý file I/O hiệu quả, hỗ trợ WebSocket.

### Decision
Dùng **Node.js ≥ 18 LTS** với **Express** framework.

### Rationale
- **Cross-platform**: Node.js chạy identical trên Windows và Linux.
- **Streaming I/O**: Node.js stream API tối ưu cho file transfer (non-blocking, low memory).
- **WebSocket native**: Package `ws` là production-grade, battle-tested.
- **Ecosystem**: Express là framework HTTP phổ biến nhất, dễ tìm giải pháp.
- **No compile step**: JavaScript chạy trực tiếp, không cần build.

### Alternatives Considered
| Alternative | Rejected Because |
|---|---|
| Python (Flask/FastAPI) | Slower file I/O, GIL bottleneck cho concurrent transfers |
| Go | Better performance nhưng overengineered cho personal tool, build step cần cho mỗi OS |
| Rust (Actix) | Quá phức tạp, compile time cao, overkill cho use case |
| Deno | Ecosystem nhỏ hơn, permission model phức tạp cho file access |

---

## ADR-002: PWA thay vì Native Mobile App

### Context
Cần support Android + iOS + iPadOS mà không có Mac cho native iOS development.

### Decision
Dùng **Progressive Web App** (PWA), truy cập qua browser trên tất cả mobile devices.

### Rationale
- **No Mac required**: iOS app native cần Mac + Xcode. PWA chạy trong Safari.
- **Zero install**: Mở browser → dùng ngay. Optional "Add to Home Screen".
- **Single codebase**: Một bộ HTML/CSS/JS serve cho tất cả devices.
- **Sufficient API**: `<input type="file">`, download, WebSocket — đủ cho file transfer.

### Tradeoffs
- **Không browse được file system mobile từ PC**: Browser security sandbox. Acceptable — user chọn file chủ động.
- **iOS PWA limitations**: Service Worker cache hạn chế, không có push notifications. Acceptable — app chạy online trên LAN.
- **Không có background transfer**: Browser phải mở trong foreground. Acceptable — transfers are intentional.

---

## ADR-003: Hub Model thay vì Mesh P2P

### Context
7 devices cần transfer file lẫn nhau. Có thể dùng P2P mesh (WebRTC) hoặc centralized hub.

### Decision
Dùng **Hub model**: 1 PC chạy server, các devices connect vào qua QR/manual IP. Không UDP discovery ở MVP (dời sang Phase 5 Multi-Hub).

### Rationale
- **Speed**: HTTP streaming đạt ~100% bandwidth WiFi. WebRTC data channel có overhead và unreliable cho large files.
- **Simplicity**: 1 server, N clients. Không cần NAT traversal, STUN/TURN.
- **Reliability**: HTTP + Range headers = reliable resume. WebRTC data channel dễ drop.
- **iOS compatibility**: WebRTC trên iOS Safari có nhiều bug. HTTP hoạt động hoàn hảo.

### Tradeoffs
- **Device ↔ Device transfer đi qua Hub**: Transfer giữa 2 phones phải upload lên PC rồi download. Trên cùng WLAN, latency acceptable.
- **PC phải online**: Phải có ít nhất 1 PC chạy server. Acceptable — user xác nhận luôn có PC online.

---

## ADR-004: Staging Area thay vì File System Browsing

### Context
User muốn chọn file cụ thể để share, không muốn expose toàn bộ thư mục.

### Decision
Dùng **staging area** (drop zone): user kéo thả file vào app → file sẵn sàng share.

### Rationale
- **Security**: Chỉ file được chủ động share mới visible. Không risk expose file nhạy cảm.
- **Simplicity**: Không cần browse toàn bộ file system → UI đơn giản hơn.
- **User control**: User biết chính xác file nào đang share, có thể remove bất kỳ lúc nào.
- **Privacy**: Khi đóng app, staging area clear → không lưu history.

### Implementation
- Server giữ in-memory Map<fileId, {absolutePath, metadata}>.
- PC browser drag-drop → upload content lên staging (không gửi absolute path vì sandbox).
- JSON `{paths:[]}` chỉ cho CLI/Electron local.
- Mobile clients thấy staged files → download direct link.
- Khi server shutdown, staging area tự clear.

---

## ADR-005: Chunked Upload Protocol cho Large Files

### Context
Files lên tới 5-7GB. Browser HTTP upload có giới hạn.

### Decision
Implement **custom chunked upload protocol** (10MB per chunk).

### Rationale
- **Browser memory**: Upload 5GB file trong 1 request → browser OOM. Chunk 10MB = safe.
- **Resume**: Mỗi chunk là 1 request. Nếu mất mạng, resume từ chunk cuối cùng.
- **Progress**: Mỗi chunk hoàn tất = progress update chính xác.
- **Server memory**: Server chỉ buffer 1 chunk (10MB) tại một thời điểm, streaming-only, RAM logic <256MB.

### Why not existing solutions?
| Alternative | Rejected Because |
|---|---|
| `tus` protocol | Thêm dependency + complexity, overengineered cho personal tool |
| WebRTC data channel | Unreliable cho large files, không support resume |
| Browser `fetch` stream | `ReadableStream` upload không supported trên tất cả browsers |

---

## ADR-006: Vanilla JS thay vì Framework

### Context
Frontend cần responsive, modern UI trên tất cả devices.

### Decision
Dùng **Vanilla JavaScript** (ES2022+) với CSS custom properties. Không dùng React/Vue/Angular.

### Rationale
- **Zero build step**: Serve trực tiếp, không cần webpack/vite/rollup.
- **Performance**: Không có framework runtime overhead. Quan trọng trên mobile.
- **Simplicity**: App có ~5 views, không cần component framework.
- **Offline-ready**: Không cần CDN cho framework files. Tất cả local.
- **Maintainability**: Ít dependency = ít breaking changes.

### Tradeoffs
- **Nhiều boilerplate hơn**: DOM manipulation verbose hơn React JSX. Acceptable — app scope nhỏ.
- **Không có reactive state**: Manual DOM updates. Acceptable — WebSocket events trigger explicit UI updates.

---

## ADR-007: On-demand Server thay vì Persistent Service

### Context
User không muốn server chạy liên tục. Chỉ cần khi transfer file.

### Decision
Server chạy **on-demand**: user launch → use → close.

### Rationale
- **Resource efficiency**: Không chiếm RAM/CPU khi không dùng.
- **Security**: Không có open port khi không cần.
- **Simplicity**: Không cần service management (systemd, Windows Service).
- **User control**: User biết chính xác khi nào server đang chạy.

### Implementation
- `npm start` → server start + open browser
- `Ctrl+C` hoặc đóng terminal → server stop
- Staging area clear on shutdown (no persistent state)
- Future: có thể wrap trong Electron cho tray icon experience

---

## ADR-008: Node.js Built-in Test Runner

### Context
Cần test framework cho unit và integration tests.

### Decision
Dùng **Node.js built-in test runner** (`node:test` + `node:assert`).

### Rationale
- **Zero dependency**: Built-in từ Node.js 18+.
- **Fast**: Không có Jest's transform overhead.
- **Coverage built-in**: `--experimental-test-coverage` flag.
- **Stable API**: Follows Node.js LTS lifecycle.
- **Consistency**: Giống coding standard "ưu tiên built-in".

### Tradeoffs
- **Ít features hơn Jest**: Không có snapshot testing, mocking helpers. Acceptable — app logic straightforward.
- **Ít ecosystem**: Ít plugins/extensions. Acceptable — chỉ cần basic assertions.
