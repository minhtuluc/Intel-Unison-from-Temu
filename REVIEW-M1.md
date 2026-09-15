# Review M1 — chưa đủ điều kiện merge

Ngày review: 2026-09-15. Reviewer kiểm tra nhánh `origin/m1-auth-runtime`, commit `1d64c07196006e54feb56e0c36ce494e49946ae2`, so với `origin/main` tại `cd5d5be`. Phạm vi: UT-002, UT-003, UT-005, UT-010, UT-015; 54 file thay đổi. Không sửa production, không merge/push trong lượt review.

## Kết luận

**Request changes.** Có 3 lỗi P1 đã xác nhận trong quyền phiên và frontend; thêm 2 thiếu sót P2 trong giới hạn runtime và deadline shutdown. CI xanh chưa đủ chứng minh M1 hoàn tất. Đề nghị mở lại UT-002, UT-005, UT-010 cho tới khi các ca dưới đây được khóa bằng regression test.

## R1 — P1 / UT-002: thu hồi hoặc hết hạn session không cắt quyền WebSocket

Vị trí: `src/websocket/index.js:29-30`, `src/websocket/handlers.js:23-25,111` và các route logout/revoke-all.

Quyền được chốt vào boolean `ws.authorized` lúc register; broadcast không kiểm tra lại session. Riêng cookie được đổi thành boolean `cookieSession` ngay tại handshake nên đăng ký lại cũng không kiểm tra expiry/revoke của cookie gốc.

Bằng chứng HTTP/WS thật:

1. Bật PIN; đăng nhập, mở WS bằng cookie, register thành công.
2. Host gọi `/api/auth/revoke-all`: HTTP 200.
3. Token cũ gọi `/api/shared`: HTTP 401, nhưng WS cũ vẫn nhận `share:update` mới.
4. Register lại trên cùng WS với cookie đã thu hồi vẫn nhận `client:registered`.

Hệ quả: người đã bị thu hồi phiên vẫn xem metadata file và hoạt động mạng; expiry và eviction của session có cùng lỗ hổng ở socket đã authorized. Không phải bằng chứng client nhận được quyền host hoặc tải payload sau revoke.

Yêu cầu sửa: lưu tham chiếu credential/session thật, kiểm tra hiệu lực khi xử lý message và phát sự kiện; vô hiệu hóa/đóng socket khi logout, revoke-all, expiry hoặc eviction. Host capability phải tiếp tục hoạt động độc lập.

Điều kiện pass: với header-token lẫn cookie, WS đang mở không nhận sự kiện bảo vệ sau revoke/expiry/eviction; re-register và reconnect với token cũ bị từ chối. Kiểm thử qua HTTP và WS thực, không chỉ unit test session store.

## R2 — P1 / UT-002: gửi chunk thất bại khi có token PIN

Vị trí: `public/js/transfer.js:349-352`.

`_uploadChunkWithProgress` gọi `xhr.setRequestHeader()` trước `xhr.open()`. Khi token trong sessionStorage không rỗng, XMLHttpRequest thật ném lỗi ngay, trước khi gửi request.

Bằng chứng browser Windows: harness import chính `TransferEngine` từ nhánh M1 và gọi phương thức gửi chunk với Blob 3 byte, dùng XMLHttpRequest thật. Kết quả:

```text
InvalidStateError: Failed to execute 'setRequestHeader' on 'XMLHttpRequest': The object's state must be OPENED.
```

Trong ứng dụng, file từ 100 MiB trở lên đi qua nhánh chunk, nên client vừa nhập PIN không gửi được file lớn. Fixture nhỏ chứng minh lỗi API browser, chưa phải kiểm thử payload 100 MiB đầu-cuối.

Yêu cầu sửa: `open` trước, thiết lập header sau, cuối cùng mới `send`. Rà soát việc truyền quyền ở cả simple upload và chunk.

Điều kiện pass: browser đăng nhập PIN gửi file ≥100 MiB, các chunk thật đến server, complete tạo pending, host duyệt và checksum đúng; giữ thêm regression tại seam XMLHttpRequest để phát hiện sai thứ tự gọi.

## R3 — P1 / UT-002: frontend host không dùng capability cho API dữ liệu

Vị trí: `public/js/api.js:29-36`, `public/js/app.js:68-69`, các caller trong file-browser/drop-zone/transfer.

API client chung chỉ gắn X-Session-Token, trong khi host token chỉ được gắn riêng cho pending/decision và WS registration. Bootstrap lại mở modal PIN nếu thiếu session token, kể cả đang giữ host capability hợp lệ.

Bằng chứng:

- Mở app bằng bootstrap host riêng trên browser sạch khi bật PIN: vẫn hiện `Host PIN required`.
- API client thật gọi `/api/shared` khi không có PIN session trả 401; cùng request có X-Host-Token hợp lệ trả 200.
- Server cho phép host capability đúng theo policy; lỗi nằm ở kết nối frontend với policy đó.

Yêu cầu sửa: đưa quyền host vào các request dữ liệu cùng origin; xử lý media/download URL cần cookie hoặc cơ chế phù hợp riêng, tránh đưa secret lên URL công khai. Chỉ mở cổng PIN khi thực sự thiếu quyền cần thiết, không chỉ dựa vào sessionStorage của PIN.

Điều kiện pass: browser host mới mở từ launcher, chưa từng nhập PIN, đọc shared list, stage/upload và duyệt được; URL media/download được kiểm thử; client URL thông thường vẫn bị chặn. Thêm ca tab client thứ hai có cookie hợp lệ để không ép nhập PIN lại chỉ vì thiếu sessionStorage.

## R4 — P2 / UT-005: simple upload bỏ qua maxFileSize của runtime

Vị trí: `src/routes/transfer.js:64-67`.

Multer simple upload vẫn cố định 100 MiB; staging và chunk đã chuyển sang config runtime. Khi host đặt maxFileSize thấp hơn 100 MiB, `/api/upload` vẫn nhận quá giới hạn.

Bằng chứng HTTP thật: runtime hợp lệ có chunkSize=8, maxFileSize=16; gửi file 32 byte vào `/api/upload` nhận HTTP 201 và tạo pending.

Yêu cầu sửa: transport limit theo `min(runtime.config.maxFileSize, giới hạn simple upload)`, trả 413 có cấu trúc, không giữ pending/file dư khi bị từ chối.

Điều kiện pass: hai runtime có limit khác nhau; test dưới/bằng/vượt ngưỡng trên `/api/upload`, `/api/share` và init/chunk theo hợp đồng tương ứng. Không đánh đồng việc này với quota tổng đĩa của UT-007.

## R5 — P2 / UT-010: deadline chỉ bao phủ đóng HTTP, không bao phủ cleanup

Vị trí: `src/runtime.js:103-114`.

Sau khi đóng HTTP, `stop()` await các cleanup không có deadline. Nếu filesystem chậm/treo thì CLI await vô hạn; nếu cleanup chậm nhưng kết thúc, hàm vẫn có thể trả `timedOut:false` dù quá timeout.

Bằng chứng fault injection tại seam cleanup của runtime thật: cleanup mất 160 ms, gọi `stop({timeoutMs:20})` mất 171 ms và trả `{stopped:true,timedOut:false}`. Đây là kiểm chứng lifecycle bằng dependency chậm giả lập; chưa tái hiện ổ đĩa thật bị treo.

Yêu cầu sửa: deadline áp dụng toàn vòng đời shutdown và trạng thái trả về phản ánh đúng cleanup timeout/lỗi; caller có đường kết thúc hữu hạn. Tránh báo thành công trong khi tác vụ đĩa vẫn đang chạy mà không được quản lý.

Điều kiện pass: HTTP/WS đang mở, cleanup chậm/reject/không resolve, stop lặp lại; tất cả kết thúc trong sai số cho phép và không báo thành công giả.

## Bằng chứng kiểm thử và CI

- `npm ci`: thành công.
- `git diff --check origin/main...HEAD`: thành công.
- Windows local, Node v24.15.0: lint và format pass. `npm run quality` **không pass**, kể cả thử ngoài sandbox: before hook tại `tests/integration/share-path-authorization.test.js:30` tạo file symlink gặp EPERM; 7 ca UT-003 bị hủy theo suite. Không tắt/skip test hoặc đổi quyền Windows trong lượt review.
- Cần ghi rõ điều kiện tạo symlink trên Windows hoặc thiết kế fixture link/junction phù hợp vẫn kiểm tra escape qua filesystem thật. Tách setup để lỗi fixture không hủy cả các negative auth test không cần symlink; cleanup phải chịu được setup chưa hoàn tất.
- [GitHub Actions tại đúng commit được review](https://github.com/minhtuluc/Intel-Unison-from-Temu/actions/runs/34874700343): cả Ubuntu/Windows × Node 22/24 đều success. Phân biệt CI runner có quyền tạo symlink với máy Windows local hiện tại.
- Probe bổ sung: HTTP/WS thật tái hiện R1, API client thật + browser UI tái hiện R3, HTTP thật tái hiện R4, fault injection tái hiện R5; XMLHttpRequest trong browser thật tái hiện R2.
- Chưa thực hiện: gửi file lớn đầu-cuối, Android/iOS, Linux local, chạy batch start/stop Windows hoặc kiểm thử đóng gói. Không chạy script kill port/process.

## Bàn giao sửa và review lại

1. Sửa R1–R3 trước; thêm integration/browser regression còn thiếu.
2. Hoàn thành R4–R5 hoặc thống nhất lại phạm vi/acceptance của M1 trước khi đánh dấu done.
3. Làm rõ prerequisite test Windows, chạy quality đầy đủ và CI matrix ở commit mới.
4. Cập nhật roadmap và bằng chứng: `docs/agents/quality.md` còn ghi 181 test, roadmap ghi 195; ghi số thực tế và tách automated/browser/device.
5. Gửi reviewer commit mới để kiểm tra lại. **Không merge bản 1d64c07 dựa riêng vào CI xanh.**

Checkout review local nằm ở `.review-m1/`. Hai harness chưa commit: `review-probes.mjs` (chạy `node review-probes.mjs`) và `review-browser.mjs` (chạy server fixture loopback, mở `/review-xhr` hoặc `/review-host`; nhập một dòng vào stdin để dừng và dọn fixture). `/review-host` là endpoint riêng của harness để mở phiên test, tuyệt đối không đưa vào production. Chúng không thuộc thay đổi production và không được push cùng bản sửa.
