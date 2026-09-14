# Domain — UniversalTrans

## Mô hình hiện tại

Host là máy chạy Node/Express, giữ staging, chunk sessions và thư mục nhận. Client là browser trên điện thoại hoặc máy khác. HTTP mang dữ liệu file; WebSocket mang sự kiện điều khiển. Chưa có WebRTC DataChannel hay đường dữ liệu client↔client trực tiếp.

Client có thể upload vào staging qua `/api/share` rồi client khác download từ host: đó là trung chuyển qua host, không phải P2P và chưa phải tính năng chọn người nhận riêng.

## Từ vựng

| Thuật ngữ        | Nghĩa và invariant                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host session     | Phiên browser có capability ngẫu nhiên do tiến trình host cấp và kết nối từ chính máy host. Không suy từ thiết bị desktop.                                 |
| Client session   | Browser chưa có quyền host; hiện còn thiếu pairing/authorization toàn cục.                                                                                 |
| Host capability  | Khóa 256-bit tạo mới khi tạo app; chuyển qua fragment URL riêng, lưu sessionStorage, gửi trong X-Host-Token/WS register. Hết hiệu lực khi process restart. |
| Shared file      | File được công bố cho download từ host; có ID, metadata và đường dẫn nội bộ.                                                                               |
| Staging          | Bản tạm app quản lý khi browser gửi file để chia sẻ. Khác file nguồn CLI.                                                                                  |
| Upload session   | Tập chunk đang nhận; chưa đồng nghĩa file hoàn chỉnh hay đã được duyệt.                                                                                    |
| Pending transfer | File đã nhận vào đĩa tạm, đang chờ host duyệt để chuyển vào thư mục nhận.                                                                                  |
| Accept / Decline | Quyết định của host; accept chuyển file, decline xóa bản tạm.                                                                                              |
| Receiver         | Bên được chọn nhận trong thiết kế tương lai; hiện chỉ host nhận upload.                                                                                    |
| Relay            | Client A → host → client B, dữ liệu đi qua host.                                                                                                           |
| P2P              | Dữ liệu đi trực tiếp giữa hai client; host có thể làm signaling. Chưa triển khai.                                                                          |

## Cam kết và giới hạn

- Quyền host không đồng nghĩa đã sửa toàn bộ PIN/pairing hoặc bảo mật LAN.
- Hiện upload ghi file tạm trước khi hỏi host. Duyệt trước truyền là thay đổi core tương lai.
- Host mở từ liên kết riêng do launcher cấp; mở URL/QR client thông thường không tự nhận quyền host.
- Khóa host không phải cơ chế chống process độc hại trên cùng máy hoặc người kiểm soát phiên browser host.
- HTTP/WS hiện chưa mã hóa; việc đóng gói desktop không tự giải quyết TLS.
- Windows build là exe/installer; Linux build là AppImage/deb hoặc binary Linux, không phải exe Windows.
