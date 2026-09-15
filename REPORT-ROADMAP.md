# UniversalTrans — báo cáo cải thiện và roadmap

Ngày: 2026-09-14. Phạm vi: repository local, Node/Express, HTTP upload/download, WS, browser UI, launcher và tests. Tài liệu này là backlog chuẩn cho agent; không phải cam kết các tính năng tương lai đã triển khai.

## 1. Trả lời về mô hình kết nối

Hiện tại là mô hình host trung tâm:

```text
Client A -- HTTP file / WS events --> HOST <-- HTTP file / WS events -- Client B
```

Host lưu file tạm và file nhận, phục vụ download. Chưa có WebRTC, signaling offer/answer/ICE hoặc kênh dữ liệu trực tiếp A↔B. Client có thể đăng file lên shared staging để người khác tải lại từ host; đó là relay, chưa có chọn receiver, quyền riêng tư hay approval theo người nhận.

Hai hướng phát triển cần phân biệt:

- Relay có receiver: host chuyển tiếp A→B, thực hiện nhanh hơn trên nền hiện tại nhưng tốn đĩa/băng thông host.
- P2P thật: host chỉ discovery/signaling, file qua WebRTC DataChannel A↔B; cần backpressure, checksum, flow control, consent, xử lý ICE failure và fallback rõ ràng.

## 2. Bản vá thực hiện cùng tài liệu

### UT-001 — chỉ host được duyệt file (P0)

Trước sửa: `src/websocket/handlers.js` gửi `upload:request` cho tất cả socket. `src/routes/transfer.js` cho mọi HTTP client đọc pending và accept/decline. Popup xuất hiện trên tất cả máy; người gửi cũng tự bấm Accept được.

Sau sửa:

- `src/middleware/host-auth.js` cấp random capability riêng cho mỗi app/process và kiểm tra kết nối từ chính máy host; kiểm tra Origin nếu có. Không tin `isHost`, OS, tên máy hay X-Forwarded-For.
- Launcher mở URL host riêng chứa khóa trong fragment. `public/js/host-session.js` chuyển khóa vào sessionStorage và xóa fragment khỏi thanh địa chỉ. QR/public URL không chứa khóa.
- Pending/decision yêu cầu X-Host-Token hợp lệ. Client không quyền nhận HTTP 403 trước thao tác đĩa.
- WS registration xác minh khóa tại server. Popup chỉ gửi cho socket host đã xác minh, không dựa trên device registry do client đặt tên.
- UI dùng danh sách chờ, đọc lại pending khi host đăng ký/reconnect và sau quyết định. Nhiều upload đến không thay popup đầu bằng file cuối.
- Service-worker cache chuyển v3 và thêm module host-session để đưa bản vá tới shell mới.
- URL launcher dùng port thực tế sau listen; lỗi listen được reject về caller. Cấu hình QR `/api/info` vẫn cần UT-005.

Kiểm thử: `tests/integration/host-authorization.test.js` dùng host + sender + observer WS và HTTP thực; giả mạo role/token không nhận popup, client accept/decline 403, host accept giữ đúng nội dung. Kiểm tra socket remote, foreign Origin và khóa mới khác khóa cũ ở authority. Suite approval hiện hữu kiểm tra host accept/decline cả simple và chunked.

Trạng thái: đã triển khai và kiểm thử Node trên Windows; browser/điện thoại thật và CI Linux chưa chạy trong phiên này. Đây chưa phải bản vá toàn bộ auth của ứng dụng.

Kết quả cuối sau vá: `npm run quality` pass trên Windows / Node 24.15.0; 143/143 test, lint và format pass; coverage mã được load: 83,49% line, 78,94% branch, 83,77% function. Có thêm unit test bootstrap host-session. Các kiểm tra này không thay thế browser E2E/thiết bị thật. `.gitattributes` cố định LF cho code/docs để checkout Windows không làm format gate lỗi vì CRLF.

### Cách vận hành sau vá

Chạy `npm start`: dùng cửa sổ browser do host launcher mở để duyệt. Điện thoại quét QR/public URL. Nếu không tự mở browser hoặc dùng noBrowser, terminal in dòng `Host approval URL (private; do not share)`; chỉ mở liên kết này trên chính máy host. Mở URL client trên host chưa đủ quyền. Restart server cần mở lại phiên host từ launcher vì khóa thay đổi. Không gửi URL riêng cho người khác hoặc chụp log chứa khóa.

File được upload đầy đủ vào temp trước khi duyệt; accept mới chuyển vào thư mục nhận. Muốn hỏi trước khi chiếm đĩa/băng thông cần UT-012. Thư mục nhận mặc định trùng `Downloads/UniversalTrans`, cũng đang là vị trí checkout trên máy hiện tại: nên tách thư mục dữ liệu khỏi source khi cấu hình/runtime được sửa và khi đóng gói.

### UT-002 / UT-003 / UT-005 / UT-010 / UT-015 — lô M1 (2026-09-14, sau UT-001)

Năm mục P0/P1 của M1 đã triển khai trong cùng lượt với UT-001, chạy trên Node 22.23.1 / Linux. Quyết định và hệ quả: `docs/adr/0002-session-runtime-authority.md`.

- UT-003: nhánh JSON `POST /api/share` yêu cầu host capability; `validatePath` chạy trước mọi truy cập đĩa khi có `allowedSourceDirs` (mặc định rỗng), kiểm tra cả realpath nên symlink trỏ ra ngoài bị từ chối; null-byte bị chặn kể cả với host. Kiểm thử: `tests/integration/share-path-authorization.test.js` (6 ca, gồm multipart vẫn mở cho client).
- UT-002: `src/middleware/session-auth.js` cấp token opaque có expiry/revoke; PIN bật thì mọi route dữ liệu và broadcast WS yêu cầu session hoặc host capability; cookie `utrans_session` (HttpOnly, SameSite=Strict) cho URL media; bỏ token deterministic cũ. Kiểm thử: `tests/unit/session-auth.test.js`, `tests/integration/session-authorization.test.js`, cổng PIN frontend `public/js/api.js` + `tests/unit/api-client.test.js`.
- UT-015: không còn `path`/`filePath` trong response; danh tính do server cấp theo `connectionId`, tên client khai chỉ là `label` với `labelUntrusted: true`. Kiểm thử: `tests/integration/no-internal-path-leak.test.js`, `tests/unit/discovery.test.js`.
- UT-005: `src/runtime.js` gom config/managers/discovery/host capability/session store; route và service đọc `app.locals.runtime`; bỏ singleton `config`; static phục vụ theo package; `/api/info` báo port listener thật (đúng cả port 0). Kiểm thử: `tests/integration/runtime-isolation.test.js`. Toàn bộ test cũ đã chuyển sang runtime riêng, không còn sửa config toàn cục hay ghi vào `temp/` của repo.
- UT-010: `runtime.stop({timeoutMs})` terminate WS rồi đóng HTTP trong deadline, không `process.exit`, không đăng ký signal; `bin/utrans.js` sở hữu SIGINT/SIGTERM; `PORT_IN_USE` báo rõ; file instance `os.tmpdir()/utrans-<port>.json` để script dừng đúng PID. Kiểm thử: `tests/integration/lifecycle.test.js`; smoke thật: SIGTERM khi có WS mở → thoát trong ~100ms, exit code 0, xoá file instance.

Phát hiện thêm khi kiểm chứng và đã sửa trong lượt này: `/api/shared` trả `304` theo ETag nên browser hiển thị danh sách file cũ/rỗng sau khi đổi trạng thái — nay mọi response `/api` là `no-store` và bỏ `If-None-Match` (`tests/integration/api-cache.test.js`).

Review độc lập trên diff M1 phát hiện 7 vấn đề trong chính bản vá này (1 bypass P0 qua content-type, 1 đường phóng đại RAM ở chunk upload, rò rỉ registry, config session sai kiểu, giới hạn multipart bỏ qua runtime, WS bỏ qua cookie phiên, script Windows có thể kill nhầm PID). Tất cả đã sửa kèm test hồi quy; chi tiết ở mục "Sửa đổi sau review" trong ADR-0002.

Bằng chứng gate cuối lượt M1: sau khi khắc phục các lỗi review vòng 1 và vòng 2 (R1–R7), `npm run quality` pass trên Node / Linux và Windows — 207/207 automated tests pass, lint và format sạch, coverage 93,68% line / 88,60% branch / 93,49% function. Kiểm chứng browser thủ công bằng headless Chrome (CDP): cổng PIN hiện khi bật PIN, sai PIN báo lỗi và không lưu token, đúng PIN mở được danh sách file đã stage, bốn view render không lỗi console. Đã thêm regression test suite tại seam HTTP/WS thật khóa chặt R1–R7, timeout/never-settling child process handling, và junction fallback cho Windows. Toàn bộ 4 jobs CI (Ubuntu/Windows × Node 22/Node 24) đã pass 100% và PR #1 đã được merge chính thức vào `main` (commit `64cff86`). Giới hạn còn lại: chưa test trên điện thoại thật, chưa có TLS.

## 3. Bằng chứng và giới hạn audit

Baseline trước vá: 139/139 test pass, ESLint pass, Node coverage 83.34% line; `public/js/transfer.js` chỉ 43.28%. Coverage không bao gồm đầy đủ UI không được load. Suite xanh vẫn bỏ sót authorization và lỗi orchestration.

Đã tái hiện trước vá: bật PIN nhưng stage/download tệp fixture không token vẫn thành công; port 0 quảng bá sai URL; task awaiting_approval chiếm slot và chặn task kế tiếp. Đã đọc trực tiếp code để xác định các vấn đề còn lại bên dưới; mục ghi “cần tái hiện” không được trình bày như kết quả benchmark hay race đã chứng minh.

## 4. Backlog lỗi cần vá

| ID     | Priority / status    | Hiện trạng, nguồn                                                                                                                                              | Acceptance criteria và kiểm thử cần có                                                                                                                                                                               |
| ------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UT-002 | P0 / done (M1)       | PIN chỉ tạo token, không được enforce ở share/download/upload/WS; `routes/info.js`, `server.js`.                                                               | Session ngẫu nhiên có expiry/revoke; policy guest rõ; mọi route/WS được kiểm tra theo policy; test thiếu/sai/hết hạn token và reconnect. Không đánh đồng với host capability.                                        |
| UT-003 | P0 / done (M1)       | JSON `/api/share` nhận đường dẫn tùy ý, `validatePath` không được gọi ở luồng này; peer có thể công bố file host đọc được.                                     | Chỉ local host có quyền stage đường dẫn nguồn; từ chối client trước stat/read; test absolute path, symlink, traversal, giả headers và đường dẫn ngoài allowlist nếu có.                                              |
| UT-004 | P1 / ready-for-agent | Pending chiếm active slot, hết TTL chỉ xóa server mà client không nhận terminal status; modal và task phụ thuộc WS một lần.                                    | Tách uploading/pending; batch > concurrency tiếp tục; expiry phát terminal event; reconnect query status, không kẹt khi mất complete event. Test event đến trước HTTP response.                                      |
| UT-005 | P1 / done (M1)       | `createServer` merge config nhưng router/singleton dùng global; `/api/info` port/QR không phản ánh listener; static public phụ thuộc CWD.                      | Một runtime truyền cho routes/managers; port override/0, upload/temp dirs, public assets đúng từ CWD khác. Không sửa global config trong integration tests.                                                          |
| UT-006 | P1 / ready-for-agent | Chunk TTL chỉ cleanup khi shutdown; orphan sau crash không có recovery; staging unshare/clear chỉ xóa Map, không xóa bản tạm.                                  | Sweep định kỳ và khi startup; cancel server-side; ownership file rõ; temp được dọn có giới hạn mà file nguồn CLI còn nguyên; test restart, TTL và unshare.                                                           |
| UT-007 | P1 / ready-for-agent | Chunk manager không đối chiếu byte count thực tế; max session/devices/concurrency config chưa enforce.                                                         | Validate integer index/size, exact chunk length và tổng bytes; checksum; quota tổng temp, session/device và request limits; stream hoặc bound RAM; test sai chunk, oversized, duplicate, DoS có kiểm soát.           |
| UT-008 | P1 / needs-triage    | Collision dùng exists rồi write/rename; accept xóa record trước move, lỗi đĩa mất khả năng retry. `pending-upload.js`, `chunked-upload.js`. Race cần tái hiện. | Atomic reservation/exclusive creation; accept transactional; lỗi move giữ trạng thái retry; đồng thời cùng tên không ghi đè; test EXDEV, EACCES/ENOSPC, hai request complete/accept.                                 |
| UT-009 | P1 / ready-for-agent | pause abort chunk bị vòng retry xử lý như lỗi; cancel trong backoff có thể gửi tiếp; init/complete không abort; retry session expired không tái khởi tạo.      | Một attempt có cancellation token; pause/cancel chặn mọi retry/init/complete; resume reconcile received chunks; hết session có hành vi rõ; kiểm thử fake clock + HTTP/XHR thực tại seam.                             |
| UT-010 | P1 / done (M1)       | `wss.close()` không đóng ngay socket; server.close callback mới terminate WS, có thể treo shutdown. Batch start/stop taskkill mọi process giữ 8080.            | Stop có deadline, close WS rồi HTTP, cleanup; quản lý đúng PID/instance của app; không kill ứng dụng khác; port occupied báo lỗi; test với WS mở.                                                                    |
| UT-011 | P2 / ready-for-agent | showToast nhận object nhưng nhiều caller app/drop-zone dùng hai đối số string; notification trống/sai loại.                                                    | Chuẩn hóa call signature; test rendered message/type cả lỗi và thành công; lint/type check phát hiện sai hợp đồng.                                                                                                   |
| UT-012 | P1 / needs-info      | Hỏi host sau khi upload hết; không có preflight consent.                                                                                                       | Thiết kế offer gồm name/size/type, host accept mới cấp upload session; reject không ghi payload; mất host/timeout chấm dứt; tránh consent và complete trùng. Chốt UX batch và chế độ trusted devices trước thi công. |
| UT-013 | P2 / ready-for-agent | Range parser chỉ start-end; suffix range và end vượt EOF bị xử lý chưa chuẩn.                                                                                  | Test bytes=-N, N-, end vượt EOF, empty file, malformed/multi-range; hỗ trợ hoặc từ chối theo hợp đồng HTTP; stream hủy khi client ngắt.                                                                              |
| UT-014 | P2 / needs-triage    | Tên Unicode/reserved Windows/trailing dot/255 byte, prefix staging không được sanitize đầy đủ.                                                                 | Test Windows CON/NUL/COM1, dấu chấm cuối, tên Unicode dài theo bytes, hai tên sau sanitize trùng; lưu bằng ID nội bộ, metadata giữ tên hợp lệ.                                                                       |
| UT-015 | P2 / done (M1)       | API trả path nội bộ ở upload/complete/decision; registry tin deviceId trùng, một tab đóng có thể xóa máy vẫn online.                                           | Response không lộ đường dẫn; session identity do server quản lý; ref count nhiều tab hoặc connection ID; test spoof IDs và reconnect.                                                                                |
| UT-016 | P2 / ready-for-agent | Cache name thủ công, thiếu release/version update; PWA và Wake Lock trên HTTP LAN có hạn chế secure context.                                                   | Build version cache, update prompt khi không truyền; feature detection; UI nói rõ capability thiếu; browser E2E cache cũ→mới; xác minh HTTPS LAN trước cam kết install/wake-lock.                                    |
| UT-017 | P2 / ready-for-agent | errorHandler biến JSON parse/Multer errors thành 500 và không xét headersSent.                                                                                 | Map lỗi client về 400/413, lỗi stream sau headers destroy/next thích hợp; không double-send; test malformed JSON, oversized multipart, stream failure.                                                               |
| UT-018 | P2 / needs-triage    | npm ci báo Multer 1.x deprecated dù audit 0 advisory; README khẳng định production-grade/10GB+/Wi-Fi throughput chưa có bằng chứng tải thật.                   | Kiểm tra advisory bằng nguồn upstream tại ngày thi công; migration Multer được regression multipart; cập nhật README theo measurement, maxFileSize mặc định 10 GiB, không ghi 10GB+ vô giới hạn.                     |

Năm mục `done (M1)` ở trên (UT-002, UT-003, UT-005, UT-010, UT-015) đã hoàn tất nghiệm thu và chính thức merge vào `main` (commit `64cff86`). CI GitHub Actions đã chạy pass trên ma trận Ubuntu/Windows và Node 22/Node 24. Giới hạn kiểm chứng còn giữ: chưa test trên điện thoại thật, chưa có TLS LAN. Chi tiết trong mục 2 và ADR-0002.

Các vấn đề security phải được sửa trước khi mở rộng phạm vi người dùng LAN. Không giải quyết auth bằng việc ẩn nút ở frontend. Host-only approval không ngăn đường upload/stage khác chiếm ổ đĩa; quota/route policy vẫn cần làm.

## 5. Core feature roadmap

| Mốc                       | Nội dung                                                                                                                       | Dependency / điều kiện ra khỏi mốc                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 — Host approval        | UT-001, regression HTTP/WS, bootstrap host, tài liệu và gates.                                                                 | Hoàn thành: Đã merge `cd5d5be`.                                                                                                                                       |
| M1 — Quyền và runtime     | UT-002, UT-003, UT-005, UT-010, UT-015 — đã hoàn thành và merge vào `main` (commit `64cff86`).                                 | Hoàn thành: Negative auth tests pass; host/client role thực; QR/runtime đúng; lifecycle shutdown deadline an toàn; CI Ubuntu/Windows pass; giải quyết triệt để R1–R7. |
| M2 — Truyền file tin cậy  | UT-004, UT-006–009, UT-013–014, UT-017 (Mốc kế tiếp).                                                                          | Batch ≥10, checksum multi-GB, concurrent collision, timeout/cancel/restart/disk-full; không kẹt queue, không mất file nguồn.                                          |
| M3 — Core UX và consent   | UT-011, UT-012, UT-016, UT-018; settings thư mục nhận, quota, danh sách pending/history, error/retry rõ.                       | Host duyệt trước truyền theo policy đã chốt; thông báo mọi terminal state; capabilities browser được kiểm chứng trên thiết bị.                                        |
| M4 — Receiver giữa client | Thiết kế chọn receiver và routing riêng; opt-in relay; consent đúng người nhận, ACL file theo receiver.                        | Cần product decision relay trước hay P2P ngay. Test 3 clients, receiver offline, không ai khác tải/duyệt được.                                                        |
| M5 — P2P thử nghiệm       | WebRTC DataChannel và signaling host; file framing, ordered chunk IDs, bufferedAmount backpressure, progress/checksum, cancel. | M1–M3 ổn định; đo traffic chứng minh payload A↔B không đi qua host; ICE failure được báo, relay fallback chỉ theo policy rõ.                                          |
| M6 — Desktop beta         | Host app Windows/Linux: tray, start/stop, QR public, approval, settings, file picker, notification, single-instance.           | M1–M3 là bắt buộc; P2P có thể ship sau desktop, không làm chặn bản host beta.                                                                                         |
| M7 — Release              | Installer, sign/checksum/SBOM, update/rollback, clean-machine tests, support docs.                                             | Quality + browser/device + packaging matrix pass; không còn P0/P1 mất dữ liệu.                                                                                        |

M4/M5 là đề xuất mở rộng, chưa được coi là yêu cầu triển khai P2P ngay. Chốt thêm: client B cần tải thủ công hay auto-save sau consent; file history metadata hay lưu payload; trust theo từng phiên hay ghi nhớ thiết bị; TLS LAN provisioning.

## 6. Tối ưu cần đo

- Thu thập baseline trước tối ưu: 1/3/5 transfer đồng thời; 10 MiB/100 MiB/1 GiB và gần giới hạn; peak RSS, temp disk, CPU, throughput, latency event loop, thời gian merge.
- Với 10 GiB, lúc merge có thể giữ cả chunks và file ghép gần 20 GiB: reserve disk trước nhận, đừng chỉ nhìn fileSize; EXDEV còn có thể thêm bản copy.
- Chunk memoryStorage giữ buffer theo số request đồng thời; áp backpressure/concurrency/quota trước tăng chunk size.
- Preview dùng full image download: tạo thumbnail có giới hạn dimensions/bytes và cache LRU; kiểm tra định dạng unsupported (HEIC) thay vì hứa preview mọi ảnh.
- Hiện drop-zone gửi một multipart lớn, không đi qua TransferEngine progress/cancel/retry: thống nhất luồng upload có mục đích share/receive sau khi state machine ổn định.
- Dùng cập nhật metadata dạng delta và DOM patch/windowed list khi benchmark với hàng nghìn file chứng minh full re-render gây chậm. Chưa cần framework mới chỉ để tối ưu.
- Duyệt folder phải giữ relative path nếu sản phẩm cam kết gửi nguyên thư mục; hiện flatten basename. Thêm manifest an toàn, directory picker và download batch/archive theo nhu cầu, kiểm tra traversal.

Không đặt mục tiêu RAM/MB/s tùy ý làm quality gate trước khi có baseline trên thiết bị thật. Định nghĩa máy, mạng, file, số lần đo và p50/p95 trong report benchmark.

## 7. Đóng gói Windows và Linux

### Hướng đề xuất

Electron tái sử dụng UI JS và Node backend hiện có. Đây là đề xuất để spike/ADR, chưa thêm Electron dependency hoặc sinh installer trong lượt này. Phân tách lifecycle server trước: start trả runtime, stop await được, không process.exit từ module, không gắn signal handler lặp; launcher/desktop main sở hữu lifecycle.

Tauri + Node sidecar có thể được đánh giá nếu kích thước là ưu tiên, nhưng cần Rust/toolchain và quản lý sidecar. Node standalone binary phù hợp headless/tray riêng; tự đóng gói Node không tự tạo desktop approval UX. Đo kích thước/cold-start/RSS của spike rồi chốt ADR.

### Các task đóng gói

| ID      | Đầu ra                   | Tiêu chí nghiệm thu                                                                                                                                                         |
| ------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PKG-001 | Desktop shell spike      | Host mở/tray, start/stop server, QR guest, approval; close-window vs quit rõ; app single-instance; chạy từ CWD bất kỳ.                                                      |
| PKG-002 | Security desktop         | Renderer sandbox, contextIsolation, nodeIntegration off; preload IPC allowlist/schema; không load nội dung remote có Node quyền; chặn navigation/window.open bất ngờ.       |
| PKG-003 | Paths/settings           | Resources readonly theo app path; config/log/temp theo userData hoặc OS data directory; nhận file theo thư mục user chọn; migration versioned và reset không xóa file nhận. |
| PKG-004 | Windows build            | NSIS installer `.exe`, tùy chọn portable `.exe`; icons/app ID/version/license; standard user, firewall hướng dẫn rõ, Unicode path; không cần Node cài ngoài.                |
| PKG-005 | Linux build              | AppImage cho portable; deb cho Ubuntu/Debian sau beta; desktop entry/icon, tray fallback khi desktop environment thiếu hỗ trợ; binary Linux tương ứng kiến trúc.            |
| PKG-006 | Release pipeline         | Build Windows trên Windows, Linux trên Linux; lock dependencies, artifacts SHA-256, SBOM/license, release notes, retention, không chứa secret hay fixture.                  |
| PKG-007 | Update/rollback          | Thử upgrade N→N+1 và rollback không mất data/settings; download update lỗi không làm hỏng app; Windows ký số trước phát hành rộng; private keys chỉ CI secrets.             |
| PKG-008 | Clean-machine validation | VM không Node: install/start/send/accept/decline/restart/update/uninstall; dữ liệu nhận còn sau uninstall theo UX; test port occupied và LAN không Internet.                |

Không build một `.exe` rồi coi là bản Linux. Mục tiêu artifact ban đầu đề xuất Windows x64 + Linux x64; ARM64 là backlog sau khi có nhu cầu và runner/test thiết bị.

Nguồn kiểm tra ngày 2026-09-14: [Electron distribution](https://www.electronjs.org/docs/latest/tutorial/distribution-overview), [Electron sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox), [electron-builder targets](https://www.electron.build/docs/targets/). Tài liệu upstream cần được kiểm tra lại khi pin version để build; không ghi version mới nhất cố định vào roadmap.

## 8. Hệ thống chất lượng và phân công

Entry point agent: `AGENTS.md`. Domain: `CONTEXT.md`. Authority: `docs/adr/0001-host-approval-authority.md`. Quy chuẩn: `docs/agents/quality.md`. Backlog/status: `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`.

`npm run quality` là gate thực thi lint + format + all tests/coverage; CI ma trận Windows/Ubuntu, Node 22/24. PR template yêu cầu ID, acceptance, kết quả thực tế, giới hạn và rollback. Chưa bật branch protection online và chưa tạo issue GitHub.

Phân việc tương lai: agent A auth/runtime (M1), agent B lifecycle/disk sau interface M1 ổn định, agent C browser tests/core UX, agent D packaging spike sau stop/runtime API ổn định. Không cho nhiều agent cùng sửa transfer.js/server.js mà chưa thống nhất ownership. Agent chính tích hợp, chạy gates cuối và cập nhật status.

Tiêu chuẩn hoàn tất: acceptance đạt và test trên đúng seam; không chỉ “build thành công”. Cần ghi riêng automated local, CI, browser E2E, physical device và clean-machine packaging. Không tự đánh dấu các mức chưa thực hiện là pass.
