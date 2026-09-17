# ADR-0004 — relay tới một người nhận, quyền quyết định thuộc receiver

Status: Accepted — đã merge vào `main` qua PR #4 (nhánh `m4`, 2026-09-17), sau hai vòng QC (`REVIEW-M4-QC.md`).

Bổ sung cho [ADR-0001](0001-host-approval-authority.md), [ADR-0002](0002-session-runtime-authority.md) và [ADR-0003](0003-consent-before-transfer.md); không thay thế. ADR-0001 quy định **ai** được duyệt (host); ADR-0003 quy định **thời điểm** consent (trước khi một byte chạm đĩa). ADR này quy định điều gì xảy ra khi **người nhận không phải host**: ai được chọn người nhận, ai có quyền đồng ý, file nằm ở đâu, và ai được tải nó.

## Context

Sau M3, consent đã đúng thời điểm nhưng vẫn chỉ có **một** người duyệt: host. Mọi upload đều là client → host, và `/api/download/:fileId` phục vụ file đã stage cho **bất kỳ** client nào đã xác thực (`src/routes/transfer.js` trước M4). `CONTEXT.md` ghi rõ "chưa phải tính năng chọn người nhận riêng".

Hệ quả cụ thể của trạng thái cũ:

- Không có cách nào để A gửi riêng cho B; muốn chia sẻ thì phải công bố cho cả LAN.
- File B cần nằm lẫn trong dữ liệu của host (thư mục nhận), hoặc nằm trong staging chung mà ai cũng tải được.
- Host buộc phải là người duyệt thay B, tức B nhận file mình chưa từng đồng ý — trái với tinh thần M3.
- `connectionId` là danh tính **theo từng socket**: reconnect tạo danh tính mới, nên không thể "gửi cho một thiết bị" một cách ổn định.

## Decision

1. **Relay là A → host → B; host chỉ chở byte.** Đường dữ liệu không đổi (HTTP + WS), không có WebRTC. Host giữ bản tạm, phục vụ download, và có quyền **dừng** một relay, nhưng không phải một bên của consent.

2. **Chỉ receiver quyết định.** `POST /api/relay/decision` chỉ chấp nhận request mang identity key khớp tập khóa của receiver đã bind lúc tạo offer. **Không có nhánh bypass cho host** — host mang capability hợp lệ vẫn nhận `403 RELAY_FORBIDDEN`, và host không có endpoint tải file relay. Đây là điểm khác biệt cốt lõi so với M3, nơi host là người duyệt.

3. **Danh tính client do server suy ra (identity keys).** Mỗi kết nối WS được index dưới một tập khóa:

   ```text
   conn:<connectionId>        luôn có, yếu: chết khi reconnect
   dev:<sha256(deviceToken)>  khi client trình X-Device-Token hợp lệ
   sess:<sessionToken>        khi session verify được (chỉ khi PIN bật)
   ```

   Server chỉ lưu **hash** của device token; raw token không rời client. `X-Connection-Id` **không** tạo ra key nào — nhận nó ở đây sẽ cho phép một client mượn danh tính của socket khác.

4. **Receiver được bind bằng tập khóa tại thời điểm tạo offer**, không phải bằng `connectionId` đơn lẻ. Nhờ vậy receiver reconnect (connectionId mới) vẫn nhận được offer và vẫn tải được file, miễn còn giữ `dev:` hoặc `sess:`. Đây là lý do `deviceToken` được thêm vào payload `client:register`.

5. **Receiver phải đang online** thì offer mới được tạo (`409 RECEIVER_OFFLINE`); không xếp hàng cho thiết bị vắng mặt. Offer không được trả lời sẽ hết hạn theo `offerTtlMs` và **không ghi byte nào**, phát `relay:offer:expired` cho cả hai phía.

6. **Grant relay dùng một lần, cùng hợp đồng với M3.** Bind `(tên, cỡ, checksum?)` + `connectionId` của **người gửi**, cộng thêm `relayId` và receiver keys; state machine `issued → in_use → fulfilled`, thất bại trả về `issued`. Hai service (`TransferOfferService`, `RelayTransferService`) triển khai độc lập cùng hợp đồng, và một **test tham số hóa chạy cùng ma trận từ chối trên cả hai** để chúng không lệch nhau. Middleware `requireTransferGrant` hỏi runtime service nào sở hữu grant id, nên đường ghi chỉ có một cửa.

7. **File relay nằm ở vùng tạm riêng `tempDir/relay`, không vào `uploadDir`.** Đây là dữ liệu của B, không phải của host. Mỗi file có TTL `relayTtlMs` (mặc định 1 giờ, env `UTRANS_RELAY_TTL`); hết hạn thì xoá file **và** release quota. Thư mục relay được đưa vào sweep định kỳ, sweep lúc khởi động và reconcile quota.

8. **Download có ACL.** File public giữ nguyên hành vi cũ. File relay chỉ cho qua khi người gọi chứng minh được **một trong hai**: identity key giao với receiver keys (session cookie khi PIN bật, hoặc `X-Device-Token` cho fetch/preview), hoặc capability `?rt=<token>` khớp hash của **đúng file đó**. Host không có bypass. 403 `DOWNLOAD_FORBIDDEN` cho mọi trường hợp khác.

9. **Capability tải xuống được phát một lần.** Sinh 256-bit ở `POST /api/relay/decision`, trả trong **response HTTP** cho receiver, server chỉ lưu SHA-256 vào ACL của file. Không broadcast, không vào history, không vào `/api/info`, không vào `/api/relay/incoming`. Cần cơ chế này vì `<a download>` và `<img src>` không gửi được custom header, và khi PIN tắt thì không có session cookie để định danh.

10. **Danh sách tách theo vai.** `/api/shared` **loại** file relay (không ai khác được biết nó tồn tại); `/api/relay/incoming` trả cho receiver; `/api/relay/sent` cho sender; `/api/relay/active` (host-only) trả metadata để host quản lý, **không kèm handle tải**.

11. **Sự kiện WS tách theo vai.** `relay:offer` chỉ tới receiver; `relay:decision` tới sender; `relay:stored`/`relay:expired`/`relay:downloaded` tới sender, receiver và host (kèm `senderConnectionId` để client biết mình là ai); `relay:update` tới host để refresh bảng quản lý. Relay events **không** nằm trong `HOST_ONLY_EVENTS`.

12. **Chỉ thêm một trường config.** `relayTtlMs` (env `UTRANS_RELAY_TTL`), validate như `offerTtlMs`. Bất biến "config frozen" của ADR-0002 §7 vẫn giữ: chỉ `uploadDir` đổi được lúc chạy.

## Consequences

- Lần đầu hệ thống có **hai cơ quan consent**: host (M3) và receiver (M4). Chúng dùng chung một cửa ghi và một hợp đồng grant, nhưng khác người có quyền quyết định.
- Host không còn đường tải file relay trong app. Đây là chủ ý: host là kênh vận chuyển, không phải người nhận. Muốn lấy lại quyền đó thì phải đổi mô hình bằng một ADR khác, không phải bằng một route mới.
- **Đây là ranh giới quyền trong app, không phải mã hoá.** File vẫn là plaintext trong `tempDir/relay`; chủ máy host, root/admin hoặc bất kỳ process nào có quyền đọc filesystem vẫn đọc được nội dung. Nếu mục tiêu là "chỉ B đọc được nội dung" thì cần một mốc riêng cho mã hoá phía client với khoá chỉ A và B giữ — ADR này không hứa điều đó.
- Relay **không** phải P2P: payload vẫn đi qua host hai lần (lên và xuống), và AI có quyền trên máy host vẫn đọc được file trên đĩa. ADR này không thay đổi giới hạn đó.
- Danh tính bền dựa trên `localStorage`: xoá storage của máy B làm mất khả năng nhận lại file đang chờ; sender phải gửi lại. Với PIN bật, session cũng là một khóa, nên rủi ro này thấp hơn.
- Khi PIN tắt, capability nằm trong URL (`?rt=`) nên có thể lọt vào lịch sử trình duyệt của **chính máy B**. Nó bị giới hạn bởi `relayTtlMs` và chỉ dùng được cho đúng một file.
- File relay chiếm đĩa host tới khi receiver tải hoặc hết TTL; host phải nhìn thấy được để dừng. Đây là chi phí đã được chấp nhận khi chọn relay-first thay vì P2P.
- Chưa có TLS LAN, nên mọi thứ — kể cả capability — vẫn là plaintext trong LAN.

## Không thuộc phạm vi ADR này

- Chọn nhiều receiver cùng lúc, ACL theo nhóm.
- Ghi nhớ thiết bị cho relay (auto-accept relay): hiện mọi relay đều hỏi receiver.
- P2P WebRTC, signaling, ICE fallback: vẫn thuộc M5.
- TLS/provisioning trên LAN.
