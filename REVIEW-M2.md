# Review M2 — Reliable transfer

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
