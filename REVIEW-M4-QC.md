# Báo cáo QC M4 — relay tới thiết bị nhận được chọn

Ngày rà soát: 2026-09-17  
Nhánh: `m4`  
Commit được rà soát: `e6d4560c16ac5750111c8b949cf37dce37ada9ed`  
Base: `origin/main` tại thời điểm M4 được tạo

## Kết luận

**Chưa đủ điều kiện merge.** Hướng kiến trúc A → host relay → B và mô hình “receiver quyết định” là đúng, nhưng còn bốn lỗi có thể tái hiện tại interface HTTP/WebSocket thật. Trong đó có một lỗi làm lộ capability tải file của receiver cho sender, và một lỗi cho phép client mượn `X-Connection-Id` của client khác để vượt ACL readback.

`npm run quality` và GitHub Actions vẫn xanh vì các test hiện tại chưa đặt assertion tại đúng ranh giới sau khi receiver quyết định, sau khi file được lưu, sau khi tải hoàn tất và sau khi chunked upload hoàn tất.

## Kết quả gate hiện tại

- `npm ci`: pass, 0 vulnerability.
- `npm run quality`: pass trên Windows, Node `v24.15.0`.
- GitHub Actions workflow `Quality`: pass cho commit `e6d4560` trên matrix Ubuntu/Windows × Node 22/24 ([run 35175828773](https://github.com/minhtuluc/Intel-Unison-from-Temu/actions/runs/35175828773)).
- Probe QC tạm thời đã được chạy trên server thật rồi gỡ khỏi worktree; không để lại test đỏ hoặc sửa production trong commit báo cáo này.
- Chưa smoke test trình duyệt thật, thiết bị thật hoặc artifact đóng gói.

## Lỗi bắt buộc vá

### M4-QC-01 — P0 — Capability tải của receiver bị broadcast cho sender

**Vị trí:** `src/routes/relay.js:198-213`.

`POST /api/relay/decision` tạo chung một `payload` chứa `files[].relayToken`, gửi payload đó về HTTP cho receiver, rồi dùng nguyên payload để phát `relay:decision` tới sender. Như vậy sender nhận raw capability và có thể tải file vốn chỉ thuộc receiver. Điều này trái ADR-0004, UT-021 và comment ngay trong route (“Never broadcast”).

**Bằng chứng tái hiện:** bổ sung assertion tạm tại test integration “lets only the receiver decide” để đọc sự kiện `relay:decision` của sender sau khi B Accept. Test thất bại với:

```text
receiver download capability must never be broadcast to the sender
```

**Yêu cầu vá:** tách hai DTO:

- response HTTP cho receiver được chứa `files[].relayToken`;
- sự kiện WS cho sender chỉ chứa quyết định và grant cần để upload, tuyệt đối không có token tải;
- host update/readback/list/log cũng không được chứa raw token.

**Regression test bắt buộc:** sau Accept, duyệt toàn bộ event của sender/observer/host và khẳng định không có chuỗi `relayToken` hoặc giá trị raw token; receiver response vẫn nhận token đúng một lần.

### M4-QC-02 — P1 — Readback tin `X-Connection-Id` do client tự khai

**Vị trí:** `src/routes/relay.js:143-151`.

`GET /api/relay/offer/:relayId` so sánh trực tiếp header `X-Connection-Id` với `relay.sender.connectionId`. Route không gọi `resolveSender`, trong khi ADR-0004 và `client-identity.js` quy định header này không tạo quyền. Client C có session hợp lệ chỉ cần khai connection ID của A là được xem relay của A, gồm cả các `grantId` sau quyết định.

**Bằng chứng tái hiện:** C gọi readback bằng session của C nhưng header mang connection ID của A. Kết quả thực tế `200`; kỳ vọng `403`.

```text
an unrelated peer must not gain readback access by claiming the sender connection id
200 !== 403
```

**Yêu cầu vá:** dùng danh tính đã được server xác minh. Với nhánh sender, gọi `resolveSender(req, { required: true })` rồi xác minh connection/session ownership như route `/api/relay/sent`; hoặc chỉ cho phép giao của các identity key bền vững đã bind. Không dùng trực tiếp `req.headers['x-connection-id']` hay giá trị trong body làm authority.

**Regression test bắt buộc:** A, B, C có session/socket độc lập; C giả connection ID của A vẫn nhận `403 RELAY_FORBIDDEN`; A và B hợp lệ vẫn đọc được; host chỉ được đọc metadata theo chính sách đã ghi.

### M4-QC-03 — P1 — Chunked relay không còn được tính quota sau complete

**Vị trí:** `src/services/chunked-upload.js:264-385`, `src/routes/transfer.js:1000-1075`.

`ChunkedUploadManager.complete()` luôn release reservation của `session.fileSize`. Với relay, file hoàn chỉnh vẫn nằm trong thư mục temp relay và được attach vào relay service, nhưng không có bước chuyển ownership reservation hoặc reserve lại. Kết quả là quota báo thấp hơn dung lượng thật trên đĩa; thao tác revoke/TTL sau đó còn release thêm lần nữa và có thể làm sai số của các file khác.

**Bằng chứng tái hiện:** tại test integration chunked relay, file 21 byte vẫn tồn tại và tải được sau complete nhưng:

```text
completed relay bytes must remain charged to quota while they remain on disk
actual allocatedBytes: 0
expected allocatedBytes: 21
```

**Yêu cầu vá:** chuyển reservation từ chunk session sang stored relay một cách nguyên tử; không release rồi reserve lại sau khi file đã nằm trên đĩa vì reserve mới có thể thất bại. Mọi nhánh lỗi phải có đúng một owner chịu trách nhiệm release.

**Regression test bắt buộc:** ghi baseline quota → init chunked relay → complete → quota bằng baseline + file size → revoke hoặc TTL → quota trở lại đúng baseline. Thêm case lỗi giữa move và attach để chứng minh không leak file/quota và không double-release.

### M4-QC-04 — P1 — Sự kiện `relay:stored` và `relay:downloaded` không được nối vào luồng production

**Vị trí:** `src/services/relay-transfer.js:279-303`, `src/services/relay-transfer.js:362-368`, `src/routes/transfer.js:586-656`.

Service có `_notifyStored()` và `markDownloaded()`, nhưng:

- `attachStoredFile()` không phát `relay:stored` sau khi lưu record;
- download route không gọi `markDownloaded()` sau khi stream hoàn tất;
- test unit gọi thẳng method nên không phát hiện thiếu wiring ở route thật.

Hậu quả: receiver đã Accept có thể mở Incoming trước khi sender upload xong nhưng không được refresh khi file sẵn sàng; sender/receiver/host không nhận trạng thái tải hoàn tất như ADR-0004 cam kết.

**Bằng chứng tái hiện:** hai probe integration độc lập đều thất bại:

```text
receiver must be notified after the relay bytes are stored
receiver must be notified after a full relay download
```

**Yêu cầu vá:** phát `relay:stored` sau khi record và file đã được attach thành công. Chỉ gọi `markDownloaded(fileId)` khi response `200` toàn bộ file kết thúc thành công; không coi `206`, stream lỗi hoặc client đóng sớm là tải hoàn tất.

**Regression test bắt buộc:** kiểm tra event tại HTTP + WS seam cho simple upload và chunked upload; full `200` phát đúng một `downloaded`, range `206` và abort không phát `downloaded`.

## Cần chỉnh trước khi phát hành

### M4-QC-05 — P2 — Nội dung UI tuyên bố quá mức về khả năng đọc của host

**Vị trí:** `public/js/relay-inbox.js:163`, `public/js/app.js:1419`.

UI ghi “The host cannot read them” / “never read”. ACL của ứng dụng có thể chặn vai host qua HTTP, nhưng owner của máy host hoặc process có quyền filesystem vẫn đọc được file plaintext trong temp relay. ADR-0004 cũng chỉ bảo đảm không có bypass trong app, không phải mã hóa đầu-cuối.

**Yêu cầu chỉnh:** dùng câu chính xác như “The host app does not expose a download action for relayed files” và ghi rõ relay chưa phải end-to-end encryption. Nếu mục tiêu thật sự là host không thể đọc nội dung, cần một milestone riêng cho mã hóa phía client với khóa chỉ A/B giữ.

## Những phần đã ổn trong phạm vi rà soát

- Offer relay chỉ được gửi tới receiver được chọn; host nhận metadata management thay vì prompt quyết định.
- Receiver authority được kiểm tra server-side ở decision route; observer và host không thể Accept/Decline.
- File relay nằm ngoài host upload directory và không xuất hiện trong `/api/shared`.
- Download ACL chặn observer/host và hỗ trợ receiver device token hoặc per-file capability.
- Grant upload đã bind sender, có TTL và single-use.
- Runtime state tiếp tục nằm trong `app.locals.runtime`; test dùng thư mục temp riêng.
- Host có thể revoke dữ liệu đang relay mà không có API download bypass.

## Thứ tự bàn giao đề xuất

1. Vá M4-QC-01 trước vì đang lộ quyền tải trực tiếp.
2. Vá M4-QC-02 và thêm test spoof identity.
3. Vá ownership quota M4-QC-03 cùng test complete/revoke/TTL.
4. Nối lifecycle events M4-QC-04 và kiểm tra full/range/abort.
5. Chỉnh wording M4-QC-05.
6. Chạy `npm run quality`, xác nhận matrix Ubuntu/Windows × Node 22/24 xanh, rồi QC lại các probe ở trên trước khi merge.

## Điều kiện QC chấp nhận vòng sau

- Không còn raw `relayToken` trong bất kỳ WS broadcast, readback, host list hoặc log nào.
- Header/body connection ID tự khai không cấp quyền readback.
- Quota phản ánh đúng byte relay trên đĩa cho cả simple và chunked paths, không double-release.
- `stored` và `downloaded` được phát đúng thời điểm, đúng đối tượng, đúng một lần.
- Full suite và GitHub Actions matrix xanh mà không skip, giảm coverage hay nới lỏng assertion.
- Đội thi công ghi rõ file thay đổi, test mới, kết quả và giới hạn chưa smoke-test trên thiết bị thật.
