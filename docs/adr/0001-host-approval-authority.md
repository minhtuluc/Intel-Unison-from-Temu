# ADR-0001 — chỉ host được duyệt upload

Status: Accepted (yêu cầu người dùng, 2026-09-14).

## Context

`upload:request` từng broadcast tới mọi socket; `/api/upload/decision` không kiểm tra quyền. Client tự khai `isHost`. Hệ quả: điện thoại tự chấp thuận file gửi lên PC.

## Decision

- Mỗi Express app tạo random capability 32 byte. Launcher mở URL riêng có fragment; browser xóa fragment bằng replaceState và giữ khóa trong sessionStorage.
- HTTP pending/decision kiểm tra capability và remoteAddress của socket thuộc chính host. Không tin proxy header.
- WS registration xác minh cùng authority; dữ liệu `isHost` của client bị bỏ qua. Chỉ socket đã xác minh nhận `upload:request`.
- QR/public URL không có capability. Server mới tạo khóa mới; host mở lại từ launcher sau restart.
- Kiểm tra Origin khi có header: phải cùng host:port với request. Client LAN không được cấp khóa bằng endpoint công khai.

## Consequences

Host có thể dùng URL LAN do launcher mở mà vẫn nhận quyền; không cần chuyển bind sang 0.0.0.0. Mở URL công khai trên PC chưa đủ cấp quyền. Reverse proxy không được coi là cấu hình host đáng tin mặc định.

Chỉ auth cho duyệt/pending trong bản vá này; pairing toàn cục, dữ liệu truyền HTTP và các route share/download vẫn là backlog. Không coi capability hiện tại là bảo vệ chống mã độc local hoặc XSS trong browser host. Desktop tương lai thay bootstrap URL bằng IPC hẹp, giữ invariant server-side.
