# Review M2 — Reliable transfer

## Review vòng 3 — commit `526e8ef` (2026-09-15)

### Kết luận: Request changes

Bản sửa đã đóng được R5–R9: checksum frontend chạy incremental với bộ nhớ giới hạn và có cancellation; checksum trở thành input bắt buộc; simple upload claim slot trước khi parse body và reserve quota theo byte; startup reconcile dữ liệu tạm; complete tuần tự trả cùng outcome; Service Worker đã tăng cache version. `npm run quality` pass 287/287 trên Windows local.

M2 vẫn chưa đủ điều kiện merge vì còn một lỗi ghi đè dữ liệu P1 tại đường simple upload và R10 mới chỉ chặn connection ID không tồn tại, chưa bind connection ID hợp lệ với session gửi request.

### R11 — P1 / UT-008: hai simple upload cùng tên vẫn có thể ghi đè và dùng chung temp path

Vị trí: `src/routes/transfer.js:86-103`.

`SimpleUploadQuotaStorage` chọn tên bằng vòng `existsSync()` rồi mở file với `createWriteStream(finalPath)` mặc định. Check và create là hai thao tác tách rời; nhiều request đồng thời có thể cùng thấy đường dẫn chưa tồn tại rồi cùng mở nó ở chế độ truncate/write. Mỗi request sau đó vẫn tạo một pending record riêng, dù các record có thể trỏ tới cùng file vật lý và nội dung của ít nhất một upload đã bị ghi đè.

Probe HTTP production gửi đồng thời 10 multipart request, cùng tên `same.bin` nhưng nội dung khác nhau. Cả 10 trả `201` và tạo 10 pending record, nhưng chỉ có 9 `internalPath` duy nhất và 9 file vật lý. Đây là mất dữ liệu im lặng, vi phạm trực tiếp acceptance UT-008 “cùng tên đồng thời không ghi đè”.

Yêu cầu sửa: reserve tên/file nguyên tử bằng exclusive create (`wx`) và retry suffix khi nhận `EEXIST`, hoặc dùng primitive `reserveWritableFile` dùng chung với chunked upload. Chỉ tạo pending record sau khi stream của chính request đã hoàn tất trên file handle mà request đó sở hữu. Regression phải chạy nhiều request HTTP đồng thời cùng tên, nội dung phân biệt, rồi xác nhận số pending = số path duy nhất = số file và hash từng file khớp đúng một payload đầu vào.

### R12 — P2 / UT-004: client cùng IP có thể mạo danh connection ID của session khác

Vị trí: `src/routes/transfer.js:24-58`; regression hiện tại tại `tests/integration/m2-qc-review-regression.test.js:1228-1264`.

Frontend gửi capability qua `X-Session-Token`, nhưng `resolveSender()` chỉ đọc Bearer token hoặc cookie. Điều kiện mismatch còn yêu cầu `reqToken` phải tồn tại, nên request có `X-Session-Token` hợp lệ của B và `X-Connection-Id` hợp lệ của A vẫn được chấp nhận nếu hai socket cùng IP. Upload bị ghi nhận là của A; terminal event sau accept/decline sẽ route sang A thay vì B.

Probe production tạo hai PIN session và hai WebSocket connection riêng trên cùng loopback, rồi upload bằng session B nhưng header connection ID của A. Kết quả thực tế là `201`, trong khi policy phải reject `403` (hoặc server phải bỏ correlation giả và gắn đúng connection B).

Regression R10 hiện chỉ thử ID giả không tồn tại. Test sanitize broadcast cũng assert `je.data?.connectionId`, trong khi schema thật là `je.data.device`; assertion đó không bảo vệ đúng field dù implementation hiện đã chủ động tạo `safeDevice`.

Yêu cầu sửa: dùng cùng helper lấy session token chuẩn của middleware (`X-Session-Token`, cookie, Bearer nếu được hỗ trợ), bắt buộc capability của HTTP request khớp capability đã bind vào socket khi PIN bật, và fail closed nếu một phía thiếu token. Thêm test hai session/two WS thật: B gửi connection ID của A phải bị reject và A không nhận terminal event. Sửa assertion broadcast thành `je.data?.device?.connectionId`.

### Bằng chứng vòng 3

- Commit review: `526e8ef`; diff so với báo cáo vòng 2 gồm 21 file, +1.198/-123 dòng.
- `npm run quality`: lint/format pass; 287/287 test pass, 86 suite, không fail/cancel/skip/todo. Coverage: 88,20% line / 79,69% branch / 84,84% function.
- `git diff --check c855a55..526e8ef`: pass.
- Probe bổ sung dùng HTTP, multipart, PIN session và WebSocket production; fixture nằm trong temp riêng và đã cleanup. Same-name concurrency: 10 response `201`, 10 pending, 9 unique path/file. Cross-session spoof: hai session/connection khác nhau, response `201` thay vì `403`.
- Chưa xác minh: GitHub Actions của commit này, Linux local, browser/device thật, payload nhiều GiB, peak RAM/thời gian hash thực tế, ENOSPC/EACCES thật và installer.

### Điều kiện review vòng 4

Sửa R11 và R12 trên cùng nhánh, bổ sung regression tại HTTP/WS production seam và giữ toàn bộ regression R1–R10. Không merge M2 chỉ dựa vào 287 test hiện tại.

---

## Review vòng 2 — commit `8f6607d` (2026-09-15)

### Kết luận: Request changes

Bản trả bài đã giải quyết phần cốt lõi của R1, R3 và R4: hai complete đồng thời không còn tạo hai file; accept/decline có state claim; timeout chỉ phát một terminal event; buffer frontend có cap/TTL. `npm run quality` pass 274/274 trên Windows local.

M2 vẫn chưa đủ điều kiện merge. R2 mới hoàn thành một phần và bản sửa tạo/để lộ thêm bốn blocker P1. Các phát hiện dưới đây là trạng thái hiện tại; R1–R4 cũ được giữ bên dưới làm lịch sử.

### R5 — P1 / UT-007, UT-009: checksum frontend phá cam kết file nhiều GiB và không bắt buộc

Vị trí: `public/js/transfer.js:15-26,273-299`.

`computeFileSha256()` gọi `await file.arrayBuffer()` rồi mới hash. Với nhánh chunked (100 MiB đến 10 GiB), browser phải cấp phát toàn bộ file trong RAM trước khi gửi byte đầu tiên. Điều này phủ định thiết kế chunk/stream và có thể treo hoặc crash tab từ chính kích thước ứng dụng quảng bá hỗ trợ. Hash cũng không nhận cancellation token; pause/cancel vẫn phải chờ đọc/hash xong mới thoát.

Khi Web Crypto không có hoặc digest lỗi, hàm trả `null`; server vẫn tạo session và complete chỉ kiểm tra size. Vì vậy integrity vẫn là optional, không phải hợp đồng bắt buộc như acceptance UT-007.

Yêu cầu sửa: không materialize toàn file. Chọn cơ chế hash incremental có RAM bound hoặc tính digest theo chunk với một whole-file verification tương thích browser; định nghĩa rõ fallback khi capability thiếu và không âm thầm bỏ integrity. Pause/cancel phải ngắt công việc trước init. Regression cần browser seam production với file giả lập lớn chứng minh không gọi `arrayBuffer()` trên toàn file, peak memory bound, checksum đúng/sai và capability thiếu.

### R6 — P1 / UT-007: giới hạn concurrent không áp dụng cho simple upload; quota mất dấu dữ liệu trên đĩa

Vị trí: `src/routes/transfer.js:81-132,259-308`, `src/runtime.js:28-54,77-83`, `src/services/storage-quota.js`.

`parseSimpleUpload` kiểm tra `getActiveTransferCount()` trước Multer, nhưng `inFlightSimpleUploads` chỉ tăng sau khi Multer đã ghi xong file và chuyển sang route handler. Nhiều request cùng lúc đều thấy count bằng 0 và đi qua. Probe HTTP production với `maxConcurrentTransfers: 1` gửi hai multipart song song: cả hai trả 201 và tạo hai pending record.

Quota tracker luôn khởi động với `allocatedBytes = 0`; startup sweep chạy nền và không thống kê file pending/chunk còn mới sau crash. Probe tạo orphan pending 900 byte, khởi động với quota 1.000 byte rồi init thêm 900 byte: server vẫn trả 200 và tracker chỉ báo 900, trong khi đĩa đã có 1.800 byte. Preflight simple upload cũng chỉ nhìn Content-Length, không reserve nguyên tử; hai request đồng thời hoặc transfer-encoding không có length có thể ghi file trước khi `createPending` mới reserve, và đường lỗi không dọn toàn bộ file/record đã tạo một phần.

Yêu cầu sửa: claim/release slot trước khi bắt đầu parse body, bao phủ cả simple/chunk request và mọi exit path. Khởi động phải scan/reconcile ownership và byte thực tế trước khi nhận upload mới, hoặc dọn cách ly đồng bộ theo policy; quota reservation cho multipart phải nguyên tử và cleanup transaction khi một file trong batch thất bại. Test raw HTTP body chậm song song, request không Content-Length, hai request tranh quota, batch fail giữa chừng và restart với orphan còn mới.

### R7 — P1 / UT-008, UT-009: complete chỉ chống đồng thời, chưa chịu được retry sau mất response

Vị trí: `src/services/chunked-upload.js:237-365`, `src/routes/transfer.js:432-469`.

Sau complete thành công, chunk session bị xóa và mapping từ `uploadId` sang pending outcome không được lưu. Cùng request retry tuần tự trả 410 `UPLOAD_EXPIRED`, không trả lại kết quả cũ hoặc một conflict có trạng thái đủ để client reconcile. Probe HTTP production: complete lần đầu 200, retry ngay sau đó 410, pending count vẫn 1.

Nếu response 200 đầu tiên bị mất, task giữ `uploadId`; retry tiếp tục nhận 410. Luồng resume hiện coi 410 là session hết hạn và re-init từ đầu, có thể tải lại toàn bộ payload và tạo pending thứ hai. Ngoài ra `session.status = completed` được đặt trước `rm(sessionDir)`; nếu cleanup chunk lỗi, complete throw sau khi file cuối đã tồn tại nhưng route chưa tạo pending, còn retry bị chặn bởi trạng thái completed.

Yêu cầu sửa: commit kết quả complete và pending record như một transaction/idempotency record keyed bởi uploadId; retry phải trả cùng transferId/outcome mà không ghép/tải lại. Cleanup chunk sau commit phải best-effort/recoverable, không biến file đã hoàn tất thành orphan vô chủ. Regression cần response-drop/retry tuần tự, complete thành công + cleanup EACCES, restart/reconcile và khẳng định đúng một payload/pending.

### R8 — P1 / frontend delivery: Service Worker vẫn giữ cache M1

Vị trí: `public/sw.js:6,55-70`; thay đổi mới ở `public/js/app.js` và `public/js/transfer.js`.

M2 thay đổi hai module frontend nhưng `public/sw.js` có cùng Git blob với `origin/main` và vẫn dùng `utrans-shell-v5`. Fetch shell là cache-first. Client đã chạy M1 không nhận worker mới để install, nên reload tiếp tục dùng app/transfer cũ: không nhận maxConcurrent từ server, không gửi correlation mới và không chạy checksum mới.

Yêu cầu sửa: bump/version asset cache hoặc dùng cơ chế build revision tương đương; regression cài/cache M1 rồi triển khai M2 trên cùng origin và chứng minh module M2 được kích hoạt qua flow update/reload được hỗ trợ. Browser origin sạch không chứng minh upgrade.

### R9 — P2 / UT-007: checksum input không validate và gây 500 muộn

Vị trí: `src/services/chunked-upload.js:30-98,278-335`.

Init nhận mọi kiểu/chuỗi checksum và đã reserve quota/tạo session. Với JSON `checksum: 123`, init trả 200, chunk trả 200; complete gọi `session.expectedChecksum.toLowerCase()` và trả 500 `SERVER_ERROR`. Chuỗi không phải SHA-256 hex cũng chỉ bị phát hiện muộn như mismatch sau khi đã ghi toàn bộ payload.

Yêu cầu sửa: checksum phải là đúng 64 ký tự hex (và bắt buộc theo policy đã chốt), reject 400 trước reserve/mkdir. Regression gồm null/undefined, number/object, độ dài sai, ký tự sai, upper/lowercase và digest hợp lệ.

### R10 — P2 / UT-004: terminal routing dùng connection ID do HTTP client tự khai

Vị trí: `src/routes/transfer.js:18-30`, `src/services/pending-upload.js:77-94`, `src/websocket/handlers.js:151-186`.

Server đưa `connectionId` vào device list rồi tin trực tiếp `X-Connection-Id`/body của request upload để chọn socket nhận terminal event. Regression mới cũng tự đặt header này, nên chỉ chứng minh routing theo payload khai báo, không chứng minh sender identity do server quản lý. Client có thể chọn connection ID của tab/máy khác và làm terminal notification xuất hiện sai nơi; fallback theo IP còn phát cho mọi tab cùng IP.

Yêu cầu sửa: coi header chỉ là correlation hint và bind nó với credential/session + connection mà server quan sát, hoặc cấp transfer capability riêng không thể mạo danh. Không dùng field client gửi như authority. Test client B gửi connection ID của A và phải bị reject/không route sang A; reconnect cần ownership transfer rõ ràng.

### Bằng chứng vòng 2

- Commit review: `8f6607d`; diff so với báo cáo vòng 1 gồm 15 file, +1.379/-108 dòng.
- `npm run quality`: lint/format pass; 274/274 test pass, không fail/cancel/skip. Coverage: 87,61% line / 79,60% branch / 83,85% function.
- `git diff --check 8a8c486..8f6607d`: pass.
- Probe bổ sung dùng HTTP route và service production, fixture temp riêng: simple concurrency `[201,201]` khi limit = 1; orphan 900 + reservation 900 qua quota 1.000 vẫn init 200; complete tuần tự `[200,410]`; checksum number `[init 200, complete 500]`.
- Chưa xác minh: GitHub Actions của commit này, Linux local, browser/device thật, peak RAM file lớn, lỗi đĩa ENOSPC/EACCES thật và installer.

### Điều kiện review vòng 3

Sửa R5–R10 trên cùng nhánh và giữ regression R1–R4. UT-007 tiếp tục `in-progress`; không merge M2 dựa riêng vào 274 test hiện tại. Test mới phải đi qua browser/HTTP/WS production seam và kiểm tra side effect đĩa, không chỉ assert biến nội bộ.

---

## Lịch sử — review vòng 1

Ngày review: 2026-09-15. Phạm vi: `origin/m2-reliable-transfer` tại commit `f71ca38`, so với `origin/main` tại `6c4008e`; các mục UT-004, UT-006, UT-007, UT-008, UT-009, UT-013, UT-014 và UT-017.

## Kết luận: Request changes

Quality gate hiện xanh nhưng chưa đủ điều kiện merge. Có ba lỗi P1 đã tái hiện ở interface production và một lỗi P2 về định tuyến/trạng thái WebSocket. Ngoài ra UT-007 được đánh dấu `done` dù phần quota, giới hạn thiết bị/request và integrity bắt buộc chưa được triển khai.

Không sửa production trong lượt review này. Agent thi công cần sửa trên chính nhánh `m2-reliable-transfer`, bổ sung regression test rồi cập nhật báo cáo để reviewer kiểm tra lại.

## R1 — P1 / UT-008: hai request complete đồng thời tạo hai bản file và hai pending transfer

Vị trí: `src/services/chunked-upload.js:203-257`, `src/routes/transfer.js:393-429`.

`complete()` không khóa hoặc chuyển session sang trạng thái `completing`. Hai lời gọi cùng lấy một session, cùng reserve tên khác nhau, cùng ghép chunk và đều trả thành công. Ở route thật, mỗi kết quả tiếp tục tạo một pending record và một popup duyệt riêng cho cùng payload.

Bằng chứng trên Windows/Node production service: tạo session 8 byte gồm hai chunk rồi chạy `Promise.allSettled([complete(id), complete(id)])`. Cả hai promise fulfilled và thư mục đích chứa `x.bin` cùng `x_(1).bin`.

Yêu cầu sửa: state transition nguyên tử `uploading -> completing -> completed`; complete lặp phải idempotent hoặc trả conflict ổn định, không tạo thêm file/pending. Phối hợp `addChunk`, `cancelUpload`, expiry và sweeper với cùng state/lock. Regression phải gọi hai request `/api/upload/complete` đồng thời qua HTTP và xác nhận đúng một pending record, một file, một terminal outcome; thêm complete-vs-cancel và complete-vs-expiry.

## R2 — P1 / UT-007: các giới hạn chống đầy tài nguyên chỉ được validate config, chưa enforce

Vị trí: `src/config.js:19-26,86-112`, `src/websocket/index.js:13-106`, `src/services/chunked-upload.js:30-40`, `public/js/transfer.js:10-22`, `src/routes/info.js:55-70`.

`maxConnectedDevices` và `maxConcurrentTransfers` chỉ xuất hiện trong load/validate config; WebSocket registration, HTTP upload và runtime không đọc hai giá trị này. Frontend vẫn dùng mặc định cứng `maxConcurrent = 3`, không nhận config server. Không có quota tổng cho `temp/chunks`, `temp/pending`, multipart memory hay tổng byte đã khai báo. `maxSessions` của PIN bị tái sử dụng làm giới hạn upload session, nên hai chính sách độc lập vô tình chung một núm cấu hình.

Checksum chunk là tùy chọn và frontend không gửi checksum; complete chỉ đối chiếu kích thước. Payload khác nhưng cùng số byte vẫn được chấp nhận. `fileSize` cũng chỉ kiểm tra finite/positive, không kiểm tra integer dù acceptance yêu cầu integer size.

Hệ quả: client LAN hợp lệ có thể mở vượt số thiết bị/request dự kiến và giữ nhiều payload tạm đến `maxSessions * maxFileSize`; cấu hình khiến operator tưởng đã có bảo vệ nhưng không tác dụng. UT-007 chưa đạt acceptance và phải chuyển lại trạng thái đang sửa.

Yêu cầu sửa: tách giới hạn auth session/upload session/device/concurrent request; reserve/release quota byte nguyên tử trước khi tạo session hoặc nhận multipart; bắt buộc integrity metadata do client production gửi và kiểm tra ở server (ưu tiên whole-file SHA-256, chunk digest nếu cần resume); reject integer/size/checksum sai trước side effect. Test qua HTTP/WS thật với nhiều connection/request đồng thời, duplicate/retry, quota release sau cancel/expire/complete và process restart/orphan.

## R3 — P1 / UT-008: accept và decline có thể cùng xử lý một transfer

Vị trí: `src/services/pending-upload.js:102-200`.

`accept()` đặt `record.isAccepting`, nhưng `decline()` không kiểm tra flag này. Sau khi accept bắt đầu và yield ở `mkdir`, decline xóa record/temp file và ghi outcome `rejected`; accept sau đó thất bại `ENOENT`. Đây không phải transaction một quyết định: request đến trước không giữ được quyền sở hữu state transition và kết quả phụ thuộc timing filesystem.

Bằng chứng production service: gọi `accept(id)` rồi ngay lập tức `decline(id)`. Decline fulfilled, accept rejected với `ENOENT: no such file or directory, rename ...`, trạng thái cuối là `rejected`.

Timeout callback cũng không claim state trước khi await xóa file, nên có cùng lớp race với accept/decline. Hai tab host, double click hoặc timeout đúng thời điểm có thể kích hoạt.

Yêu cầu sửa: một state machine/compare-and-set duy nhất cho `pending -> accepting|rejecting|expiring -> terminal`; chỉ một tác nhân được claim record, tác nhân còn lại nhận kết quả idempotent/conflict. Khi move lỗi, hoàn nguyên đúng state và đúng TTL gốc (không hard-code lại 300000 ms). Regression HTTP đồng thời cho accept-vs-decline, accept-vs-timeout, hai accept, hai decline và lỗi move.

## R4 — P2 / UT-004: terminal event của client khác bị buffer vô hạn; timeout gửi hai terminal event

Vị trí: `src/runtime.js:195-205`, `src/websocket/handlers.js:101-125`, `public/js/transfer.js:22,651-689`.

Server broadcast `transfer:complete/rejected/expired` tới mọi client đã xác thực, không chỉ sender. `TransferEngine` lưu mọi event không khớp task vào `pendingWsDecisions` mà không TTL hoặc giới hạn. Vì vậy mỗi client tích lũy terminal event của tất cả client khác suốt phiên.

Riêng timeout còn broadcast cả `transfer:rejected(TIMEOUT)` và `transfer:expired` cho cùng ID. Event đầu kết thúc task; event thứ hai không còn task để match nên bị giữ vĩnh viễn.

Bằng chứng production class: xử lý cặp timeout trên một task rồi bơm 1.000 `transfer:complete` ID lạ; map có 1.001 phần tử và vẫn giữ ID timeout đã xử lý.

Yêu cầu sửa: server phát đúng một terminal event theo hợp đồng và route event đến sender/connection sở hữu transfer. Nếu vẫn cần buffer cho race HTTP-vs-WS, buffer phải chỉ nhận ID đang trong cửa sổ upload cục bộ, có TTL/cap và xóa khi task terminal/cancel. Regression cần ít nhất hai client thật, event đến trước/sau response, reconnect và timeout.

## Bằng chứng quality

- `npm ci`: thành công; audit báo 0 vulnerability. npm vẫn cảnh báo Multer 1.x deprecated, thuộc UT-018 chứ không phải bằng chứng UT-017 lỗi.
- `npm run quality`: pass trên Windows local; lint và format pass; 259/259 test pass, không fail/cancel/skip. Coverage tổng: 87,68% line / 79,94% branch / 84,06% function.
- `git diff --check origin/main...HEAD`: pass.
- Probe bổ sung dùng trực tiếp `ChunkedUploadManager`, `PendingUploadService` và `TransferEngine` production; chưa commit harness vì các ca phải được agent chuyển thành regression test tại HTTP/WS interface thật.
- Chưa xác minh trong lượt này: GitHub Actions của commit `f71ca38`, Linux local, browser/device thật, payload nhiều GiB, ENOSPC/EACCES thật hoặc package installer.

## Điều kiện review lại

1. Sửa R1–R4 và đưa các probe thành regression test không mô phỏng bản sao logic production.
2. Mở lại UT-007 cho tới khi toàn bộ giới hạn/quota/integrity trong acceptance được enforce; nếu tách phạm vi phải tạo ID/dependency rõ ràng, không để `done` gây hiểu nhầm.
3. Chạy `npm run quality`, CI Windows/Ubuntu theo ma trận dự án và ghi đúng commit được kiểm tra.
4. Không merge M2 chỉ dựa vào 259 test hiện tại; suite đó chưa bao phủ các interleaving và policy ở trên.
