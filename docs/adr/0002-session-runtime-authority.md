# ADR-0002 — session capability, runtime ownership và lifecycle

Status: Accepted (thực thi backlog M1, 2026-09-14).

Bổ sung cho [ADR-0001](0001-host-approval-authority.md); không thay thế. ADR-0001 quy định host capability cho hành động của host. ADR này quy định quyền của client, phạm vi state của một app instance, và ai sở hữu vòng đời tiến trình.

## Context

Sau ADR-0001, quyền host đã đúng nhưng chỉ chặn endpoint duyệt file:

- `POST /api/share` (nhánh JSON `{paths}`) cho phép mọi client công bố đường dẫn trên máy host; `validatePath` không nằm trên đường chạy thật.
- PIN chỉ sinh token, không được enforce ở bất kỳ route hay WebSocket nào; token lại deterministic (`utrans_<base64(ip:now)>`), không có expiry và không revoke được.
- Response trả đường dẫn nội bộ của host (`uploaded[].path`, `filePath`), và danh tính thiết bị do client tự khai (`deviceId`, `deviceName`) nên có thể mạo danh trong danh sách thiết bị và trong hộp thoại duyệt.
- Config là singleton đọc lúc import; tempDir phụ thuộc `process.cwd()`; `/api/info` báo port cấu hình thay vì port listener thật.
- Lifecycle: `setupWebSocket` terminate socket trong `server.on('close')`, mà event đó chỉ bắn sau khi hết connection — WS đang mở giữ server sống nên shutdown treo; signal handler nằm trong module server nên bị đăng ký lặp.

## Decision

1. **Stage đường dẫn nguồn là hành động host.** Nhánh JSON của `POST /api/share` luôn yêu cầu host capability; nhánh multipart (browser upload vào staging) vẫn dành cho client. `validatePath` chạy trước mọi truy cập đĩa khi allowlist được cấu hình; khi không cấu hình thì vẫn kiểm tra hình dạng path (null byte, kiểu dữ liệu). Allowlist nguồn là `allowedSourceDirs` (env `UTRANS_ALLOWED_SOURCE_DIRS`), mặc định rỗng = chỉ host authority. Kiểm tra allowlist dùng cả đường dẫn lexical và realpath (kể cả realpath của thư mục cha) nên symlink trỏ ra ngoài bị từ chối.
2. **Session capability cho client.** `createSessionStore()` cấp token `randomBytes(32)` dạng hex, opaque, có `expiresAt` (mặc định 24h), revoke từng cái hoặc toàn bộ; store nằm trong RAM của runtime nên restart vô hiệu hóa tất cả. Không dùng giá trị suy ra từ IP/thời gian.
3. **PIN là policy toàn cục, tắt mặc định.** Khi `pin` được cấu hình, mọi route dữ liệu (`/api/shared`, `/api/share`, `/api/download/*`, `/api/thumbnail/*`, `/api/upload*`) yêu cầu session hợp lệ **hoặc** host capability. `/api/health`, `/api/info`, `/api/auth` vẫn công khai; `/api/info` chỉ tiết lộ `pinRequired: true/false`. Khi PIN trống, hành vi LAN mở như trước (không phá UX mặc định).
4. **Cookie phiên cho URL media.** `<img>`, `<video>` và `<a download>` không gắn được header, nên `/api/auth` cũng đặt cookie `utrans_session` (HttpOnly, SameSite=Strict, Max-Age theo TTL). Không đặt `Secure` vì app chạy HTTP trên LAN. Logout và revoke-all xoá cookie. Header `X-Session-Token` và `Authorization: Bearer` vẫn được chấp nhận cho client không phải browser.
5. **WebSocket theo cùng policy.** Khi PIN bật, socket chỉ nhận broadcast sau khi `client:register` kèm session hoặc host capability hợp lệ; socket chưa xác thực nhận `client:rejected` và không nhận `share:update`, `device:join`, `upload:request`.
6. **Danh tính do server cấp.** Mỗi kết nối WS có `connectionId` (UUID) và một bản ghi thiết bị riêng với `id` do server sinh; tên/nền tảng client khai chỉ là `label` kèm `labelUntrusted: true`. Nhiều tab = nhiều bản ghi; đóng một tab không xoá thiết bị khác. Attribution của upload HTTP dùng IP do server quan sát cộng label không tin cậy. Response không bao giờ chứa đường dẫn nội bộ.
7. **Một runtime cho một app.** `createRuntime(options)` sở hữu config đã resolve, managers, discovery registry, host capability và session store. `createServer(runtime)` gắn runtime vào `app.locals.runtime`; route/service đọc từ đó, không đọc singleton. `src/config.js` chỉ còn hàm thuần (`loadConfig`, `validateConfig`, `DEFAULT_CONFIG`), không export instance. Static phục vụ từ thư mục package (`import.meta.url`), không theo `process.cwd()`. `/api/info` báo port listener thật sau khi bind (đúng cả với `port: 0`).
8. **Lifecycle thuộc về caller.** `startServer` không đăng ký signal handler và không gọi `process.exit`; nó trả `runtime` có `stop({timeoutMs})`: terminate WS client → `wss.close()` → `server.close()` (kèm `closeAllConnections`) → cleanup managers → xoá file instance, tất cả trong deadline. `bin/utrans.js` sở hữu SIGINT/SIGTERM. Tiến trình app ghi file instance `os.tmpdir()/utrans-<port>.json`; script dừng chỉ kill đúng PID đó, không kill theo port. `EADDRINUSE` trả `PORT_IN_USE` với thông báo rõ và exit code 1.

## Sửa đổi sau review (2026-09-14, cùng lượt)

Review độc lập trên diff M1 tìm ra các lỗi trong chính bản vá này; đã sửa kèm test hồi quy:

1. **Gate host-only phụ thuộc content-type (P0).** `hostOnlyForSourcePaths` cũ chỉ áp `requireHost` khi `req.is('application/json')`, nhưng nhánh xử lý lại rơi vào "không phải multipart ⇒ đường dẫn nguồn". `express.urlencoded` được mount toàn cục nên body `application/x-www-form-urlencoded` (`paths[]=...`) đi lọt: client đã có session PIN stage được đường dẫn host (đã tái hiện: 201 + download nội dung). Nay mọi body không phải multipart đều yêu cầu host capability, và nhánh đường dẫn nguồn chỉ nhận `application/json` (ngược lại trả 415). Test: `tests/integration/share-path-authorization.test.js`.
2. **Giới hạn chunk nới thành 10 GiB buffer trong RAM.** `limits.fileSize` của chunk upload từng đặt bằng `maxFileSize`; multer memoryStorage buffer trước khi kiểm tra nên một request có thể chiếm tới 10 GiB. Nay giới hạn transport = `runtime.config.chunkSize + 1 MiB`, cache theo runtime, và body quá lớn trả 413 `CHUNK_TOO_LARGE` thay vì 500. Test: `tests/integration/upload-limits.test.js`.
3. **Registry rò rỉ theo mỗi lần register.** `addConnection` luôn tạo bản ghi mới cho cùng `connectionId`, bản cũ mồ côi và `/api/info` đếm sai. Nay đăng ký lại trên cùng kết nối cập nhật bản ghi hiện có. Test: `tests/unit/discovery.test.js`.
4. **`UTRANS_SESSION_TTL_MS`/`UTRANS_MAX_SESSIONS` sai kiểu làm mất expiry.** `parseInt` trả `NaN` → session không bao giờ hết hạn và không bao giờ bị dọn. Nay `validateConfig` yêu cầu số nguyên dương. Test: `tests/unit/config.test.js`.
5. **`maxFileSize` của runtime bị bỏ qua ở nhánh multipart.** Multer cho staging được tạo lúc load module với `DEFAULT_CONFIG`; nay tạo theo runtime (WeakMap) và trả 413 khi vượt. Cùng test với mục 2.
6. **WebSocket bỏ qua cookie phiên.** Tab thứ hai giữ cookie hợp lệ vẫn bị `client:rejected` rồi mở lại cổng PIN. Nay handshake đọc cookie và dùng làm session cho `client:register`. Test: `tests/integration/session-authorization.test.js`.
7. **Script dừng trên Windows có thể kill nhầm PID tái sử dụng.** `stop-server.bat`/`start-server.bat` nay đối chiếu PID trong file instance với PID đang giữ port (`netstat -ano`) trước khi `taskkill`; không khớp thì báo và chỉ xoá file instance. Chưa smoke trên Windows.
8. **Thu hồi / hết hạn session ngắt quyền và đóng kết nối WebSocket (R1, P1).** `createSessionStore` phát sự kiện thu hồi; WS server đóng socket client tương ứng với mã 1008; `broadcastEvent` kiểm tra `isAuthorized()` động trước khi phát sự kiện bảo vệ; re-register với token cũ bị từ chối `client:rejected`. Test: `tests/integration/m1-review-regression.test.js`.
9. **Lỗi thứ tự XMLHttpRequest khi gửi chunk có PIN token (R2, P1).** `public/js/transfer.js` gọi `xhr.open()` trước `xhr.setRequestHeader()`, đồng thời bổ sung truyền `X-Host-Token`/`X-Session-Token` cho cả simple upload và chunked upload.
10. **Frontend host capability cho API dữ liệu và session cookie (R3, P1).** Route `POST /api/auth/host-session` cấp session cookie cho host chính chủ kết nối từ loopback; `apiFetch` tự động gắn `X-Host-Token` cho các request cùng origin; UI chỉ mở cổng PIN khi thực sự gặp lỗi 401 hoặc bị từ chối kết nối.
11. **Simple upload tuân thủ `maxFileSize` của runtime (R4, P2).** Multer cho simple upload cache per-runtime qua WeakMap theo `min(runtime.config.maxFileSize, 100 MiB)` và trả 413 `FILE_TOO_LARGE` có cấu trúc, dọn sạch pending rác khi bị từ chối.
12. **Deadline shutdown bao phủ toàn bộ vòng đời cleanup (R5, P2).** `runtime.stop({timeoutMs})` áp dụng deadline cho cả các tác vụ dọn dẹp đĩa và session; kết thúc trong thời hạn hữu hạn và trả đúng `{ stopped: false, timedOut: true }` nếu cleanup bị chậm hoặc treo.

## Consequences

- Client trên LAN không còn xem/gửi file khi host bật PIN mà chưa xác thực; UI có cổng nhập PIN và modal duyệt hiển thị label không tin cậy.
- Host không bao giờ tự khoá mình: host capability luôn đi qua `requireSession`, và host đăng nhập lại sau restart bằng URL riêng từ launcher.
- `/api/info` vẫn công khai nên bất kỳ ai trong LAN biết được sự tồn tại, tên máy, IP, port và việc PIN có bật hay không. Đây là chủ ý cho QR/discovery, không phải kênh bí mật.
- Cookie phiên nằm trong browser host cũng như client; XSS trên origin này có thể lấy được quyền phiên. `HttpOnly` chặn đọc bằng script nhưng không chặn request same-origin, nên XSS vẫn là rủi ro được ghi nhận.
- Vẫn chưa có TLS, pairing theo thiết bị, quota đĩa hay consent trước khi truyền (UT-012). PIN chỉ là hàng rào truy cập LAN, không phải mã hoá.
- Runtime per-app cho phép chạy nhiều instance trong một tiến trình (test, spike desktop) mà không dùng chung staging hay session.
