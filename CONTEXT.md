# Domain — UniversalTrans

## Mô hình hiện tại

Host là máy chạy Node/Express, giữ staging, chunk sessions và thư mục nhận. Client là browser trên điện thoại hoặc máy khác. HTTP mang dữ liệu file; WebSocket mang sự kiện điều khiển. Chưa có WebRTC DataChannel hay đường dữ liệu client↔client trực tiếp.

Client có thể upload vào staging qua `/api/share` rồi client khác download từ host: đó là trung chuyển qua host, không phải P2P.

Từ M4 (nhánh `m4`, **chưa merge**), client còn có thể chọn **một thiết bị cụ thể** làm người nhận: A mở relay tới B, **chỉ B** được duyệt, file nằm ở vùng tạm riêng của host và **chỉ B** tải được. Host chở byte và có thể dừng relay, nhưng không duyệt và không đọc được file. Đây vẫn là relay qua host, chưa phải P2P.

Mỗi app instance có một **runtime** riêng (`createRuntime`) giữ config, staging, chunk sessions, pending, device registry, host capability và session store. Không có state dùng chung giữa hai instance trong cùng tiến trình.

## Từ vựng

| Thuật ngữ           | Nghĩa và invariant                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime             | Tập state của một app instance: config đã resolve, managers, discovery, host capability, session store, handle server/WS. `app.locals.runtime`.                     |
| Host session        | Phiên browser có capability ngẫu nhiên do tiến trình host cấp và kết nối từ chính máy host. Không suy từ thiết bị desktop.                                          |
| Host capability     | Khóa 256-bit tạo mới khi tạo app; chuyển qua fragment URL riêng, lưu sessionStorage, gửi trong X-Host-Token/WS register. Hết hiệu lực khi process restart.          |
| Session capability  | Token 256-bit do `/api/auth` cấp khi PIN đúng; opaque, có expiry, revoke được, mất khi restart. Gửi qua X-Session-Token, cookie `utrans_session`, hoặc WS register. |
| PIN policy          | Khi `pin` được cấu hình, mọi route dữ liệu và mọi broadcast WS yêu cầu session hoặc host capability. Khi trống, LAN mở như trước.                                   |
| Client session      | Browser chưa có quyền host; đã có session capability khi PIN bật. Chưa có pairing/authorization theo thiết bị.                                                      |
| Connection identity | `connectionId` (UUID) do server cấp cho mỗi kết nối WS; mỗi kết nối là một bản ghi thiết bị với `id` do server sinh. Nhiều tab là nhiều bản ghi.                    |
| Device label        | Tên/nền tảng client tự khai. Chỉ là nhãn hiển thị, luôn kèm `labelUntrusted: true`; không phải danh tính.                                                           |
| Shared file         | File được công bố cho download từ host; có ID, metadata và đường dẫn nội bộ. Đường dẫn nội bộ không bao giờ rời khỏi server.                                        |
| Staging             | Bản tạm app quản lý khi browser gửi file để chia sẻ. Khác file nguồn CLI.                                                                                           |
| Source path         | Đường dẫn trên máy host được đưa vào staging qua nhánh JSON của `/api/share`; hành động host-only, có thể giới hạn bằng `allowedSourceDirs`.                        |
| Upload session      | Tập chunk đang nhận; chưa đồng nghĩa file hoàn chỉnh hay đã được duyệt.                                                                                             |
| Transfer offer      | Lô file client công bố (tên/cỡ/loại, checksum tùy chọn) **trước** khi truyền. Metadata thuần, không tạo file. Host duyệt riêng từng file.                           |
| Transfer grant      | Vé dùng một lần phát cho mỗi file được duyệt. Gửi qua header `X-Transfer-Grant`, bind theo `(tên, cỡ)` và `connectionId`; là thứ duy nhất mở được đường ghi.        |
| Trusted device      | Thiết bị host đã đánh dấu tin cậy nên offer được tự duyệt, vẫn ghi lịch sử. Client giữ token 256-bit; server **chỉ lưu hash**. Thu hồi được.                        |
| Pending transfer    | File đã nhận vào đĩa tạm, đang chờ host duyệt. Chỉ còn áp dụng cho upload do **chính host** khởi tạo; file đã có consent lưu thẳng, không qua bước này.             |
| Accept / Decline    | Quyết định của host cho upload thường; với relay, quyết định tương đương là **Accept / Decline của receiver**.                                                      |
| Transfer history    | Bản ghi các kết cục giao dịch (completed/rejected/expired), lưu bền ở `dataDir`. Host thấy tất cả; client chỉ thấy giao dịch của chính connection mình.             |
| Receiver            | Thiết bị được **người gửi chọn** để nhận một relay. Danh tính do server cấp; chỉ receiver được duyệt và được tải file của mình.                                     |
| Relay               | Client A → host → client B, dữ liệu đi qua host. Từ M4: chọn được receiver, consent thuộc về receiver, file có ACL theo receiver.                                   |
| Relay transfer      | Một lô file A gửi riêng cho B. Offer là metadata thuần; B duyệt từng file; file được giữ ở `tempDir/relay` với TTL, không vào thư mục nhận của host.                |
| Client identity key | Khóa do server suy ra cho một kết nối: `conn:<connectionId>`, `dev:<sha256(deviceToken)>`, `sess:<sessionToken>`. `X-Connection-Id` không tạo ra khóa.              |
| Relay capability    | Token 256-bit phát **một lần** cho receiver khi duyệt, dùng qua `?rt=` để tải file relay khi không có session cookie. Server chỉ lưu SHA-256.                       |
| P2P                 | Dữ liệu đi trực tiếp giữa hai client; host có thể làm signaling. Chưa triển khai.                                                                                   |
| Instance file       | `os.tmpdir()/utrans-<port>.json` ghi PID đang sở hữu listener; script dừng chỉ kill đúng PID này.                                                                   |

## Cam kết và giới hạn

- Quyền host không đồng nghĩa đã sửa toàn bộ PIN/pairing hoặc bảo mật LAN.
- Từ M4 (nhánh `m4`, chưa merge): host **không** duyệt và **không** tải được file relay. Chỉ receiver đã bind mới duyệt được (`403 RELAY_FORBIDDEN` cho mọi trường hợp khác, kể cả host capability), và file relay không xuất hiện trong `/api/shared`. Chi tiết: `docs/adr/0004-relay-receiver-authority.md`.
- File relay nằm ở `tempDir/relay`, không vào `uploadDir`; hết `relayTtlMs` thì bị xoá và quota được trả lại. Host chỉ thấy metadata qua `/api/relay/active`.
- Từ M3 (nhánh `m3-core-ux-consent`, chưa merge): client phải có consent trước khi truyền. `POST /api/upload` và `/api/upload/init` từ chối request không kèm grant bằng `428 TRANSFER_GRANT_REQUIRED`, trừ khi request mang host capability đã xác minh. Chi tiết: `docs/adr/0003-consent-before-transfer.md`.
- Trust là quyết định **bền** duy nhất trong hệ thống: nó sống qua restart ở `dataDir`, khác session và host capability đều mất khi restart. Xoá `dataDir` mất danh sách thiết bị tin cậy và lịch sử, không mất file đã nhận.
- `uploadDir` là trường config **duy nhất** đổi được lúc chạy (host-only, có validate). Mọi trường khác vẫn bất biến trong vòng đời tiến trình.
- Bật PIN làm client phải xác thực trước khi xem/gửi; tắt PIN giữ hành vi LAN mở và không có session.
- Cookie phiên là HttpOnly/SameSite=Strict nhưng không `Secure` vì app chạy HTTP trên LAN; XSS cùng origin vẫn là rủi ro được ghi nhận.
- Host mở từ liên kết riêng do launcher cấp; mở URL/QR client thông thường không tự nhận quyền host.
- Khóa host không phải cơ chế chống process độc hại trên cùng máy hoặc người kiểm soát phiên browser host.
- HTTP/WS hiện chưa mã hóa; việc đóng gói desktop không tự giải quyết TLS.
- `/api/info` là công khai theo thiết kế (QR/discovery): nó cho biết tên máy, IP, port, số thiết bị và việc PIN có bật hay không, nhưng không chứa khóa.
- Windows build là exe/installer; Linux build là AppImage/deb hoặc binary Linux, không phải exe Windows.
