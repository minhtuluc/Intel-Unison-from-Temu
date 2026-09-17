# Báo cáo QC M4 — relay tới thiết bị nhận được chọn

Ngày rà soát: 2026-09-17  
Nhánh: `m4`  
Commit được rà soát: `e6d4560c16ac5750111c8b949cf37dce37ada9ed`  
Commit vá tái kiểm tra: `091cf1677512891a63611e7b4aace15f6482e500`
Base: `origin/main` tại thời điểm M4 được tạo

## Kết luận

**Hai blocker vòng 2 đã được QC tự vá trong thay đổi đi cùng báo cáo này.** M4-QC-R2-01 không còn fallback từ identity key sang connection ID + IP; M4-QC-R2-02 giữ terminal outcome riêng cho relay attach failure nên retry không thể rơi xuống host pending. Phạm vi nhỏ được khóa bằng hai regression integration đúng seam, không chạy lại các suite không liên quan theo quy ước QC mới.

### Bản vá trực tiếp của QC cho vòng 2

- M4-QC-R2-01: readback sender chỉ chấp nhận durable identity key đã bind. No-PIN C dùng device token riêng nhưng khai connection ID của A nhận `403`; A dùng token của A nhận `200`.
- M4-QC-R2-02: attach failure ghi `relayFailed` terminal outcome trước cleanup. Retry cùng upload ID/token nhận `409 RELAY_STORE_FAILED`, không tạo pending record hay host prompt.
- Regression mục tiêu: `2/2` pass bằng `node --test --test-name-pattern="claimed sender connection id|leaves no file or quota" tests/integration/relay-transfer.test.js tests/integration/relay-acl.test.js`.
- Không chạy lại full suite trong lượt tự vá nhỏ này. Full gate gần nhất trước patch là `515/515` pass; CI của commit mới là nguồn kiểm tra rộng sau khi push.

## Tái kiểm tra commit `091cf16` — vòng 2

### Trạng thái các finding vòng 1

| Finding  | Trạng thái    | Bằng chứng                                                                                                               |
| -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| M4-QC-01 | Đã đóng       | Sender WS chỉ nhận decision/grant; raw relay token chỉ còn trong HTTP response của receiver. Regression event test pass. |
| M4-QC-02 | Đóng một phần | Spoof bị chặn khi PIN bật, nhưng vẫn qua được ở no-PIN/same-IP; xem M4-QC-R2-01.                                         |
| M4-QC-03 | Đã đóng       | Chunked relay giữ reservation khi file còn trên đĩa; revoke trả quota đúng baseline.                                     |
| M4-QC-04 | Đã đóng       | `stored` được phát sau attach; full `200` phát đúng một `downloaded`; range không đánh dấu hoàn tất.                     |
| M4-QC-05 | Đã đóng       | UI/tài liệu đã mô tả đúng đây là ACL trong app, không phải mã hóa đầu-cuối.                                              |

### M4-QC-R2-01 — P1 — No-PIN vẫn cho mượn connection ID của sender

**Vị trí:** `src/routes/relay.js:152-158`, qua fallback `resolveSender()`.

Nhánh sửa ưu tiên identity key, nhưng khi không giao nhau lại gọi `resolveSender`. Khi PIN tắt, `resolveSender` xác minh connection ID chủ yếu bằng IP. Hai client/tab cùng IP có thể gửi `X-Connection-Id` của A và được coi là A, trái invariant “X-Connection-Id không tạo quyền”. Test mới chỉ khóa trường hợp PIN bật nên bỏ sót nhánh này.

**Bằng chứng probe integration:** server no-PIN có A, B, C cùng kết nối thật; A tạo relay, request khác khai connection ID của A đọc lại relay:

```text
without a PIN, an unrelated same-IP peer must not borrow the sender connection id
actual: 200
expected: 403
```

**Yêu cầu vá:** readback phải dựa vào giao của identity key đã bind, không fallback sang connection header + IP. Shipped browser đã có device token; caller không có durable proof thì không được readback. Nếu cần hỗ trợ client không có device token, phải cấp capability server-generated riêng thay vì tin connection ID tự khai.

**Regression test bắt buộc:** thêm no-PIN A/B/C, C có socket/device token riêng nhưng khai connection ID của A vẫn nhận `403`; A với device token của A nhận `200`.

### M4-QC-R2-02 — P1 — Retry sau attach failure đổi relay thành upload thường

**Vị trí:** `src/services/chunked-upload.js:414`, `src/routes/transfer.js:1064-1118`.

`complete()` ghi generic `completionResult` trước khi route đăng ký file relay. Nếu `storeRelayFile()` lỗi, catch xóa file và release quota nhưng giữ generic completed outcome. Request complete lặp lại không còn session nên mất `relayGrant`; route đi xuống nhánh thường, tạo pending record cho host và trả `200`, dù file relay đã bị xóa. Việc này vừa báo thành công giả, vừa vượt ranh giới “relay không trở thành file nhận của host”.

**Bằng chứng probe integration:** gây lỗi `shareManager.addFile` sau merge; request đầu trả `500`, retry cùng upload ID/token trả:

```text
HTTP 200
pending.fileName = relay-attach-failure.bin
```

**Yêu cầu vá:** completion outcome phải giữ loại ownership (`relay`) từ trước hoặc chỉ được publish sau khi attach thành công. Failure phải để lại trạng thái retry/tombstone nhất quán; tuyệt đối không rơi xuống `createPending`. Nếu đã xóa byte thì retry phải trả lỗi ổn định và yêu cầu sender mở relay mới; nếu cam kết retry thật thì phải giữ file + quota an toàn cho lần attach lại.

**Regression test bắt buộc:** inject lỗi sau merge, retry complete cùng upload ID; không trả `200`, không tạo pending/host prompt, không còn file/quota rác, không sinh bản thứ hai.

### Gate vòng 2

- Regression M4 hiện có: `46/46` pass.
- `npm run quality`: `515/515` pass trên Windows, Node `v24.15.0`; lint/format/coverage pass, coverage tổng `90.61%` line / `81.21%` branch / `89.50%` function.
- GitHub Actions `Quality` cho `091cf16`: pass trên matrix Ubuntu/Windows × Node 22/24 ([run 35177233019](https://github.com/minhtuluc/Intel-Unison-from-Temu/actions/runs/35177233019)).
- Hai probe R2 đã chạy trên HTTP/WS thật rồi được gỡ; nhánh không bị để lại test đỏ.
- Chưa smoke test trình duyệt thật, thiết bị thật hoặc artifact đóng gói.

## Kết quả gate hiện tại

- `npm ci`: pass, 0 vulnerability.
- `npm run quality`: pass trên Windows, Node `v24.15.0`.
- GitHub Actions workflow `Quality`: pass cho commit `e6d4560` trên matrix Ubuntu/Windows × Node 22/24 ([run 35175828773](https://github.com/minhtuluc/Intel-Unison-from-Temu/actions/runs/35175828773)).
- Probe QC tạm thời đã được chạy trên server thật rồi gỡ khỏi worktree; không để lại test đỏ hoặc sửa production trong commit báo cáo này.
- Chưa smoke test trình duyệt thật, thiết bị thật hoặc artifact đóng gói.

## Phát hiện vòng 1 — giữ lại làm tham chiếu

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
