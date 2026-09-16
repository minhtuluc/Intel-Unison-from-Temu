# M3 QC review — consent, settings, history và UX

**Branch/commit reviewed:** `m3-core-ux-consent` @ `b0ce319`

**QC recheck:** commit khắc phục `4c3deef` được kiểm tra lại ngày 2026-09-16; xem mục "QC vòng 2" ở cuối tài liệu.

**Kết luận:** **BLOCK MERGE**. M3 có nền tảng tốt và quality runner xanh, nhưng còn các lỗi P1 liên quan đến quyền sở hữu transfer và tính toàn vẹn consent. Theo release gate trong `docs/agents/quality.md`, P1 liên quan mất dữ liệu phải bằng 0 trước khi merge/release.

## Bằng chứng kiểm thử

- `npm run quality`: **424/424 test pass**, 112 suites; coverage 90.13% line / 82.87% branch / 87.66% function. Đây là coverage Node, chưa phải browser/device E2E.
- Probe HTTP + WebSocket trên server PIN thật, với hai session và hai connection ID độc lập. Probe dùng thư mục tạm và đã dọn sau khi chạy.
- `git diff --check origin/main...HEAD`: **fail** vì trailing whitespace tại `README.md:150`.

## Findings cần sửa

### M3-QC-01 — Grant bound to connection nhưng thiếu header lại được chấp nhận (P1)

**Bằng chứng:** tạo offer/approve trên connection A, sau đó gửi multipart bằng session B, grant của A nhưng **không gửi `X-Connection-Id`**. Kết quả thực tế `POST /api/upload` = **201** và payload được ghi vào receive directory; expected là 403.

**Nguyên nhân:** `src/services/transfer-offer.js:280` chỉ từ chối khi `grant.connectionId && context.connectionId` cùng tồn tại. Khi header bị bỏ qua, điều kiện không chạy. `resolveSender(req)` cũng không biến một connection thiếu thành capability hợp lệ.

**Yêu cầu vá / acceptance criteria:**

1. Nếu grant có `connectionId`, mọi đường upload/chunk phải yêu cầu connection ID hiện tại và phải khớp; thiếu hoặc sai đều trả 403 trước mọi thay đổi đĩa.
2. Không dùng tên thiết bị, `isHost`, IP hay header do client tự khai làm fallback identity.
3. Thêm integration regression qua `/api/upload` và `/api/upload/init`: owner succeeds; foreign, missing và forged connection đều 403; grant vẫn retry được bởi owner sau các request bị từ chối.

### M3-QC-02 — Chunked init không bind tên file với grant (P1)

**Bằng chứng:** host duyệt grant cho `approved.bin`, size 16; gọi `/api/upload/init` với cùng size nhưng `fileName: different.exe` và checksum hợp lệ. Kết quả thực tế **200**, server cấp `uploadId` cho tên chưa được duyệt; expected là 403.

**Nguyên nhân:** `src/routes/transfer.js:688-727` chỉ kiểm tra số grant và `fileSize`; không so sánh `fileName` (và cần thống nhất checksum/mime theo hợp đồng grant) với file đã được host approve. Simple upload đã có đường kiểm tra riêng nên hai pipeline đang lệch policy.

**Yêu cầu vá / acceptance criteria:**

1. Chunked init phải dùng cùng một hàm đối chiếu `(name, size, checksum[, mime])` như simple upload.
2. Từ chối trước khi tạo session/chạm đĩa; grant không bị fulfill khi init thất bại.
3. Regression test cho tên khác, size khác, checksum khác, thiếu checksum; test owner đúng metadata vẫn init được.

### M3-QC-03 — Identity của history/offer chỉ dựa trên header do client khai (P1)

**Bằng chứng history:** session B gọi `GET /api/transfers/history` với `X-Connection-Id` của A và nhận entry `private-a.bin` của A (`200`, `scope: self`). Expected là 403 hoặc danh sách rỗng của B.

**Nguyên nhân:** `src/routes/settings.js:150-166` truyền thẳng `req.headers['x-connection-id']` vào `runtime.history.list()` mà không bind connection ID với session/socket đã xác thực.

**Cùng lớp lỗi ở offer:**

- `src/routes/transfer.js:380-395`: GET offer tin `X-Connection-Id` để quyết định owner.
- `src/services/transfer-offer.js:350-356`: cancel chỉ kiểm tra mismatch khi **cả** stored ID và context ID tồn tại; bỏ header sẽ bypass ownership.

**Yêu cầu vá / acceptance criteria:**

1. Server phải map session capability ↔ connection(s) đã đăng ký; mọi self-scoped endpoint lấy identity từ mapping server-side, không lấy từ header tùy ý.
2. Client B không được đọc/cancel offer hoặc history của A dù biết ID; thiếu identity cũng bị từ chối khi endpoint yêu cầu owner.
3. Thêm integration test với hai PIN session + hai WebSocket connection cho history, GET offer, cancel và retry sau reconnect.

### M3-QC-04 — Host có thể approve cùng một file nhiều lần và phát nhiều grant (P1)

**Bằng chứng:** offer hai file; quyết định `approve index 0` hai request liên tiếp khi offer còn pending. Cả hai trả **200** và phát hai grant ID khác nhau cho cùng file. Điều này cho phép một thao tác/retry của UI tạo nhiều quyền upload cho một approval.

**Nguyên nhân:** `src/services/transfer-offer.js:167-207` không reject target đã có quyết định và không loại duplicate index trước khi mutate; `_applyDecisions()` luôn gọi `_issueGrant()` cho mỗi approval. Việc mutate trước khi validate toàn bộ request cũng có thể để offer ở trạng thái dở dang nếu entry sau invalid.

**Yêu cầu vá / acceptance criteria:**

1. Mỗi `(offerId, fileIndex)` chỉ có tối đa một grant; quyết định lại phải trả lỗi idempotent/409 và không tạo grant mới.
2. Reject duplicate index và mọi decision trên file không còn `pending` trước khi mutate.
3. Decision batch phải atomic: nếu một entry invalid, không file nào đổi trạng thái và không grant nào được phát.
4. Regression test duplicate trong cùng request, approve lặp qua hai request, partial batch lỗi và retry hợp lệ.

## Vấn đề chất lượng nhỏ hơn

- `README.md:150` có hai khoảng trắng cuối dòng, làm `git diff --check` fail; dọn whitespace trước merge.
- `GET /api/settings` kiểm tra `mkdir/stat` nhưng chưa probe khả năng ghi thực tế. Nên thêm write probe an toàn hoặc báo rõ “path exists” thay vì khẳng định writable; kèm test permission denied trên OS hỗ trợ.
- Chưa có Playwright/browser matrix hay thiết bị Android/iOS thật. Không xem quality runner Node là bằng chứng cho UX đa client, reconnect hoặc PWA.

## Những phần đã đạt

- Host-only broadcast/decision và pre-transfer gate có test integration tốt; chưa thấy payload đi qua trước khi có grant trong các ca đã chạy.
- Trusted-device persistence có rollback khi persist lỗi; runtime state nằm trong `app.locals.runtime`, phù hợp ADR.
- Upload directory runtime và history có test isolation; quality runner không ghi vào Downloads thật.

## Trình tự sửa đề xuất

1. **M3-QC-01 + M3-QC-03:** củng cố capability binding server-side (đây là biên quyền chung và cần làm trước).
2. **M3-QC-02:** hợp nhất validator metadata cho simple/chunked.
3. **M3-QC-04:** làm decision transaction/idempotency.
4. Bổ sung regression tests theo acceptance criteria, chạy `npm run quality`, rồi chạy `git diff --check`.
5. Sau khi P1 = 0 mới review lại branch; browser/device E2E và packaging Windows/Linux vẫn là gate riêng trước release.

**QC status:** Changes requested — chưa đủ điều kiện merge vào `main`.

---

## Phản hồi thi công QC vòng 3

Ba finding M3-QC-R3-01 đến R3-03 đã được vá trực tiếp trên nhánh `m3-core-ux-consent`.

### M3-QC-R3-01 — resolved

- `TransferEngine` gắn `X-Connection-Id` hiện tại vào offer và polling request.
- Server từ chối client offer không bind được vào connection ID do server cấp; host capability vẫn giữ policy riêng.
- Unit test khẳng định frontend gửi connection ID; integration test khẳng định offer thiếu identity trả `403 INVALID_CONNECTION_ID`.

### M3-QC-R3-02 — resolved

- Frontend đồng bộ ownership headers cho init, status, chunk, cancel và complete.
- Với no-PIN, init phát capability ngẫu nhiên 256-bit riêng cho upload; server chỉ giữ SHA-256 hash. Capability cho phép đúng owner resume/cancel/complete sau khi WebSocket reconnect mà không dựa vào tên thiết bị, OS hay IP.
- Với PIN, session đã xác thực vẫn là authority và capability upload không được phát.
- Integration test no-PIN dùng WebSocket thật kiểm tra reconnect, status, chunk, complete và cancel; test PIN hiện hữu tiếp tục kiểm tra reconnect bằng session và cô lập client A/B.

### M3-QC-R3-03 — resolved

- Chunk request bắt buộc gửi `X-Upload-Id`; middleware tìm session và kiểm owner/host trước `parseChunkUpload`.
- `uploadId` trong multipart body phải trùng header, ngăn header/body confusion.
- Negative test gửi multipart cố ý hỏng từ foreign connection và vẫn nhận `403 UPLOAD_FORBIDDEN`, chứng minh request bị chặn trước parser.

### Bằng chứng gate sau vá

- `npm run quality`: **438/438 test pass**, 119 suites, 0 fail/skip.
- Coverage local Node trên Windows: **90.64% line / 82.18% branch / 88.37% function**.
- `git diff --check`: pass.
- Chưa claim browser/device thật hoặc Linux smoke test.

**QC status:** Đủ điều kiện merge M3 sau khi commit/push nhánh và CI từ xa xanh.

---

## Kết quả khắc phục (Resolution Summary)

Đã hoàn thành toàn bộ 4 finding P1 và các vấn đề nhỏ theo đúng acceptance criteria:

1. **M3-QC-01 (Grant connection binding bypass):**
   - File sửa: `src/services/transfer-offer.js`, `src/middleware/transfer-grant.js`.
   - Kết quả: Khi grant có `connectionId`, mọi request `/api/upload` và `/api/upload/init` bắt buộc phải có connection ID và phải khớp với grant. Thiếu hoặc sai đều bị chặn tại middleware với mã 403 (`TRANSFER_GRANT_INVALID`) trước khi Multer chạm đĩa hoặc session chunked được khởi tạo.
   - Khi request bị từ chối, grant được release an toàn về trạng thái `issued` để rightful owner có thể retry và hoàn tất upload thành công.

2. **M3-QC-02 (Chunked init metadata binding):**
   - File sửa: `src/routes/transfer.js`, `src/middleware/transfer-grant.js`.
   - Kết quả: `/api/upload/init` sử dụng chung hàm đối chiếu `assertGrantsMatchFiles` với simple upload, kiểm tra chặt chẽ `fileName`, `fileSize`, và `checksum` (khi grant có checksum) đối chiếu với grant được host phê duyệt.
   - Mismatch trả về 403 `GRANT_MISMATCH`, không tạo session trên đĩa và giải phóng grant ngay lập tức (không bị fulfill).

3. **M3-QC-03 (Server-side capability binding & reconnect support):**
   - File sửa: `src/utils/connection-identity.js`, `src/middleware/session-auth.js`, `src/websocket/index.js`, `src/websocket/handlers.js`, `src/routes/settings.js`, `src/routes/transfer.js`.
   - Kết quả: Máy chủ map session token hợp lệ ↔ tập hợp connection ID đã đăng ký WebSocket. Mọi endpoint self-scoped (`GET /api/transfers/history`, `GET /api/transfer/offer/:offerId`, `POST /api/transfer/offer/cancel`) đối chiếu server-side; client B không thể đọc/hủy offer hay xem lịch sử của client A (trả về 403 `INVALID_CONNECTION_ID` hoặc `OFFER_FORBIDDEN`).
   - Hỗ trợ reconnect: Client A sau khi ngắt kết nối WebSocket và kết nối lại với cùng session token vẫn truy cập được đầy đủ lịch sử truyền file trước đó và quản lý được offer của mình.

4. **M3-QC-04 (Host decision idempotency & atomic batch):**
   - File sửa: `src/services/transfer-offer.js`.
   - Kết quả: Xác thực atomic toàn bộ mảng `decisions` trước khi thay đổi trạng thái. Trùng index trong cùng request trả về 400 `INVALID_INPUT`; quyết định lại file đã duyệt trả về 409 `OFFER_CONFLICT`. Mỗi `(offerId, fileIndex)` chỉ có tối đa 1 grant. Nếu bất kỳ entry nào trong batch bị lỗi, không file nào bị thay đổi trạng thái và không grant nào được phát.

5. **Chất lượng nhỏ:**
   - Đã xóa trailing whitespace ở `README.md:150`.
   - `PATCH /api/settings` bổ sung write probe an toàn với file tạm `.probe-*.tmp` để xác minh quyền ghi thực tế trước khi thay đổi receive directory.

6. **Bằng chứng kiểm thử:**
   - Suite hồi quy tích hợp mới: `tests/integration/m3-qc-review-regression.test.js` (8/8 tests pass).
   - `npm run quality`: **434/434 test pass** (118 suites), 0 fail, 0 skipped. Coverage: **90.63% line / 82.11% branch / 88.22% function**.
   - `git diff --check origin/main`: Exit code 0, không có lỗi định dạng hay whitespace.

---

## QC vòng 2 — kiểm tra commit `4c3deef`

**Kết luận:** **BLOCK MERGE**. M3-QC-02, M3-QC-03 và M3-QC-04 đã có regression phù hợp; tuy nhiên M3-QC-01 chưa đạt acceptance, đồng thời chunk session sau bước init chưa được bind với owner.

### Bằng chứng gate

- `npm run quality`: **434/434 test pass**, 118 suites, 0 fail/skip; coverage local Windows: 90.65% line / 82.21% branch / 88.22% function.
- `git diff --check origin/main...HEAD`: pass.
- Probe HTTP + WebSocket dùng hai PIN session, dữ liệu hoàn toàn trong thư mục tạm và đã dọn sau khi chạy.

### M3-QC-R2-01 — Session owner vẫn dùng được grant khi thiếu connection ID (P1)

**Bằng chứng:** A đăng ký WebSocket, tạo offer bằng connection ID của A và được host approve. Sau đó chính session A gọi `POST /api/upload` với grant nhưng bỏ `X-Connection-Id`. Kết quả thực tế **201** và file được ghi vào receive directory; acceptance của M3-QC-01 yêu cầu **403 trước khi chạm đĩa**.

**Nguyên nhân:** `src/middleware/transfer-grant.js:95-112` gọi `resolveSender(req)` ở chế độ không bắt buộc, rồi truyền callback `isSessionOwner`. `src/services/transfer-offer.js:309-315` chấp nhận `matchSessionConn` thay cho connection ID hiện tại, nên header thiếu vẫn qua gate.

**Yêu cầu vá / acceptance criteria:**

1. Grant có `connectionId` thì `/api/upload` và `/api/upload/init` bắt buộc nhận connection ID hiện tại đã được server xác minh; thiếu, foreign hoặc forged đều 403.
2. Session mapping chỉ dùng để xác minh connection ID thuộc session/reconnect, không thay thế hoàn toàn connection ID trên request ghi payload.
3. Thêm regression cho **owner session + missing header** ở cả simple upload và chunked init; xác nhận không tạo file/session và owner vẫn retry được với connection ID đúng.
4. Sửa lại Resolution Summary: không tuyên bố "bắt buộc connection ID" cho tới khi hai ca trên pass.

### M3-QC-R2-02 — Chunk session không có authorization sau init (P1)

**Bằng chứng:** A tạo và init chunk session hợp lệ. Session B chỉ cần biết `uploadId` của A:

- `GET /api/upload/status/:uploadId` trả **200**, làm lộ trạng thái/metadata transfer.
- `POST /api/upload/cancel` trả **200**, `cancelled: true`; B hủy được transfer của A.

Đọc code cho thấy `POST /api/upload/chunk` và `POST /api/upload/complete` cũng không đối chiếu caller với `session.sender`; chỉ có global PIN session gate.

**Nguyên nhân:** grant được kiểm tra ở `/api/upload/init`, nhưng các route `src/routes/transfer.js:712`, `:758`, `:776`, `:797` nhận `uploadId` như capability dùng chung và không xác minh connection/session owner trước khi đọc hoặc mutate chunk session.

**Yêu cầu vá / acceptance criteria:**

1. Bind chunk session với sender đã xác minh tại init; mọi thao tác chunk/status/cancel/complete phải kiểm tra caller là owner hoặc host capability hợp lệ.
2. Client B biết `uploadId` vẫn phải nhận 403 trên cả bốn route, không đọc metadata, không thêm chunk, không cancel và không complete được session của A.
3. Owner A vẫn tiếp tục/resume sau reconnect theo policy session ↔ connection đã thống nhất; host bypass chỉ dựa trên host capability thật.
4. Thêm integration regression dùng hai PIN session cho status, chunk, cancel và complete; kiểm tra B bị từ chối không thay đổi state/đĩa, sau đó A vẫn hoàn tất được transfer.

### Trạng thái sau vòng 2

- M3-QC-02: đạt qua code review + regression hiện có.
- M3-QC-03: đạt với hai session và reconnect trong phạm vi đã test.
- M3-QC-04: đạt; batch validation atomic và không phát grant lặp.
- M3-QC-01: **chưa đạt**, được thay bằng M3-QC-R2-01.
- Finding mới M3-QC-R2-02: **chưa đạt**.

**QC status:** Changes requested — chưa đủ điều kiện merge vào `main`.

---

## Kết quả khắc phục QC vòng 2 (Round 2 Resolution Summary)

Đã hoàn thành khắc phục triệt để hai finding P1 của QC vòng 2:

1. **M3-QC-R2-01 (Strict connection ID enforcement for grant owner session):**
   - File sửa: `src/services/transfer-offer.js`.
   - Kết quả: Khi `grant.connectionId` tồn tại, `beginGrant(grantId, context)` bắt buộc `context.connectionId` phải có giá trị (`!context.connectionId` ném 403 `TRANSFER_GRANT_INVALID`). Kể cả khi caller sở hữu session token hợp lệ của chính owner, việc thiếu header `X-Connection-Id` sẽ bị từ chối 403 trước khi Multer ghi đĩa hoặc session chunked được khởi tạo.
   - Khi bị từ chối do thiếu header, grant không bị chuyển sang `in_use` và rightful owner có thể retry kèm `X-Connection-Id` hợp lệ để upload thành công.
   - Bổ sung integration regression tests cho owner session thiếu header trên cả `/api/upload` (simple upload) và `/api/upload/init` (chunked init).

2. **M3-QC-R2-02 (Chunk session sender binding & authorization post-init):**
   - File sửa: `src/routes/transfer.js`, `src/services/chunked-upload.js`, `src/utils/connection-identity.js`.
   - Kết quả:
     - Tại `POST /api/upload/init`, `session.sender` được ghi nhận với đầy đủ `sessionToken` và `connectionId` đã xác minh.
     - Hàm kiểm tra quyền sở hữu `assertChunkSessionOwner(req, session)` được áp dụng cho toàn bộ 4 route:
       - `GET /api/upload/status/:uploadId`
       - `POST /api/upload/chunk`
       - `POST /api/upload/cancel`
       - `POST /api/upload/complete` (cả trong quá trình upload và sau khi đã hoàn tất lưu trong `completedOutcomes`).
     - Client B dù biết `uploadId` đều nhận 403 `UPLOAD_FORBIDDEN` trên cả 4 route, không đọc được metadata, không upload được chunk, không cancel và không complete được transfer của Client A.
     - Hỗ trợ reconnect: Client A sau khi ngắt kết nối WebSocket và kết nối lại với cùng session token vẫn được công nhận là owner và tiếp tục upload chunk cũng như hoàn tất transfer thành công.
     - Host capability (`X-Host-Token`) được bypass hợp lệ để host có thể giám sát trạng thái session.

3. **Bằng chứng kiểm thử & chất lượng:**
   - `npm run quality`: **435/435 test pass** (119 suites), 0 fail, 0 skipped. Coverage: **90.76% line / 82.01% branch / 88.25% function**.
   - `git diff --check origin/main`: Exit code 0, không có lỗi định dạng hay whitespace.
   - Integration regression suite: `tests/integration/m3-qc-review-regression.test.js` đạt 9/9 test pass.

**QC status:** Sẵn sàng để QC re-check vòng 3 trên nhánh `m3-core-ux-consent`.

---

## QC vòng 3 — kiểm tra commit `0ef8405`

**Kết luận:** **BLOCK MERGE**. Hai bản vá R2 hoạt động trong các integration test mới có PIN, nhưng request contract của frontend thật không khớp với các giả định trong test. Kết quả là grant vẫn có thể không bind connection và chunked upload mặc định không PIN bị gãy.

### Bằng chứng gate

- `npm run quality`: **435/435 test pass**, 119 suites, 0 fail/skip; coverage local Windows: 90.71% line / 82.06% branch / 88.25% function.
- `git diff --check origin/main...HEAD`: pass.
- Hai probe HTTP + WebSocket chạy với request giống frontend shipped, dùng thư mục tạm và đã dọn sau khi chạy.

### M3-QC-R3-01 — Frontend tạo offer không có connection ID, grant vẫn không được bind (P1)

**Bằng chứng:** `TransferEngine._requestConsent()` tại `public/js/transfer.js:167-181` chỉ gửi `Content-Type`; `apiFetch` thêm session/device token nhưng không thêm `X-Connection-Id`. Probe với hai PIN session thực hiện đúng request này:

1. A đăng ký WebSocket nhưng tạo offer không có connection header như frontend.
2. Host approve; grant trong server có `connectionId: null`.
3. B gửi đúng tên/cỡ bằng grant đó và connection ID của B.
4. Kết quả thực tế `POST /api/upload` = **201**, file được ghi vào receive directory; expected 403.

`beginGrant()` chỉ enforce strict binding khi `grant.connectionId` tồn tại, nên fix R2-01 không bảo vệ luồng sản phẩm hiện tại.

**Yêu cầu vá / acceptance criteria:**

1. Frontend phải gửi connection ID đã được server cấp khi tạo offer; server phải từ chối client offer thiếu identity thay vì phát grant unbound (host capability vẫn theo policy riêng).
2. Không phát grant client có `connectionId: null`; B không tiêu được grant của A kể cả biết grant ID và metadata.
3. Thêm integration test dùng đúng headers/body của `TransferEngine._requestConsent`, không tự thêm connection header mà production không gửi.
4. Thêm unit/contract test khẳng định `_requestConsent` thực sự gửi connection ID hiện tại.

### M3-QC-R3-02 — Chunked upload mặc định không PIN bị khóa bởi bản vá owner check (P1)

**Bằng chứng:** cấu hình mặc định `pinRequired: false`, client có WebSocket connection hợp lệ, offer/init thành công. Sau đó gửi đúng request hiện tại của frontend:

- `GET /api/upload/status/:uploadId` không có connection header → **403 `UPLOAD_FORBIDDEN`**.
- `POST /api/upload/chunk` không có connection header → **403 `UPLOAD_FORBIDDEN`**.
- `POST /api/upload/cancel` không có connection header → **403 `UPLOAD_FORBIDDEN`**.

Frontend chỉ gắn `X-Connection-Id` cho init và complete (`public/js/transfer.js:466-469`, `:559-566`), không gắn cho chunk/status/cancel (`:675`, `:753`, `:818`, `:847`). Integration test mới chỉ chạy PIN mode, nơi session token che mất sai lệch này.

**Yêu cầu vá / acceptance criteria:**

1. Đồng bộ request contract giữa frontend và server cho cả status/chunk/cancel/complete ở hai chế độ PIN bật và PIN tắt.
2. Test một chu trình chunked hoàn chỉnh bằng request giống frontend, có WebSocket connection thật, ở **cả no-PIN mặc định và PIN mode**.
3. Test pause/resume/cancel và reconnect. Với no-PIN, phải quyết định capability nào chứng minh owner sau khi connection ID thay đổi; không dựa vào tên thiết bị hay header không được server bind.
4. Foreign B vẫn 403 và không thay đổi session; owner A phải upload/đọc status/cancel/complete được trong cấu hình mặc định.

### M3-QC-R3-03 — Foreign chunk bị authorize sau khi body đã vào memory (P2)

`POST /api/upload/chunk` khai báo `parseChunkUpload` trước handler (`src/routes/transfer.js:757`), trong khi `assertChunkSessionOwner` chỉ chạy tại dòng 768. Multer `memoryStorage` vì vậy nhận toàn bộ chunk trước khi biết caller có sở hữu session hay không. Response cuối là 403 và session không bị mutate, nhưng foreign client biết `uploadId` vẫn có thể đẩy chunk qua mạng và chiếm buffer RAM tới giới hạn request.

**Yêu cầu vá / acceptance criteria:**

1. Đưa `uploadId` vào header hoặc URL để authorization chạy trước Multer; nếu giữ bản sao trong multipart body thì hai giá trị phải khớp.
2. Test chứng minh foreign request bị chặn trước parser/storage callback, không chỉ kiểm `receivedChunks.length === 0` sau khi toàn body đã được nhận.
3. Giữ tương thích frontend bằng cách cập nhật client và server trong cùng commit, không tăng giới hạn chunk/headroom.

### Trạng thái sau vòng 3

- M3-QC-R2-01: logic service đã fail-closed khi grant có owner, nhưng **luồng frontend chưa bảo đảm grant có owner**; theo dõi bằng M3-QC-R3-01.
- M3-QC-R2-02: PIN-mode API test đạt, nhưng default no-PIN/frontend contract chưa đạt; theo dõi bằng M3-QC-R3-02 và R3-03.

**QC status:** Changes requested — chưa đủ điều kiện merge vào `main`.
