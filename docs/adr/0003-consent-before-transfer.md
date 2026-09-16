# ADR-0003 — consent trước khi truyền, thiết bị tin cậy và cấu hình đổi lúc chạy

Status: Đề xuất cùng nhánh `m3-core-ux-consent` (2026-09-16); **chưa merge** — chờ QC.

Bổ sung cho [ADR-0001](0001-host-approval-authority.md) và [ADR-0002](0002-session-runtime-authority.md); không thay thế. ADR-0001 quy định ai được duyệt; ADR-0002 quy định quyền của client, phạm vi state một instance và vòng đời tiến trình. ADR này quy định **thời điểm** consent, cách một consent được bind vào đúng dữ liệu, và phạm vi cấu hình được phép đổi khi đang chạy.

## Context

Sau M2, quyền duyệt đã đúng nhưng **quá muộn**: toàn bộ payload được ghi xuống `temp/pending` trước, rồi host mới được hỏi. `REPORT-ROADMAP.md:46` ghi "File được upload đầy đủ vào temp trước khi duyệt... Muốn hỏi trước khi chiếm đĩa/băng thông cần UT-012"; `docs/adr/0002` dòng 53 xác nhận chưa có consent trước truyền, quota đĩa hay pairing theo thiết bị.

Hệ quả cụ thể của trạng thái cũ:

- Một client trong LAN chiếm được đĩa và băng thông của host mà host chưa từng đồng ý.
- Sau khi host duyệt, không có chỗ nào trả lời được "file này đã đi đâu" sau khi modal đóng hoặc app restart.
- Mọi thiết bị đều bị hỏi lại từ đầu mỗi lần gửi, kể cả thiết bị host đã tin.
- Thư mục nhận chỉ đổi được bằng biến môi trường và khởi động lại.
- Cache service worker đổi tên bằng tay, nên bản vá frontend có thể không tới được client đã cài.

## Decision

1. **Consent trước khi một byte nào chạm đĩa.** Client gửi `POST /api/transfer/offer` mô tả lô (tên, cỡ, loại, checksum tùy chọn). Offer là metadata thuần, không tạo file. Host duyệt **từng file** trong lô qua `POST /api/transfer/offer/decision` (`requireHost`). File bị từ chối không bao giờ rời khỏi thiết bị.

2. **Grant dùng một lần là thứ mở khoá đường ghi.** Mỗi file được duyệt sinh một grant. Hai đường ghi payload — `POST /api/upload` và `POST /api/upload/init` — đều nằm sau middleware `requireTransferGrant`, chạy **trước** Multer. Đây là ràng buộc kỹ thuật quyết định: Multer ghi đĩa trong lúc parse multipart, nên grant phải đi bằng header `X-Transfer-Grant`; nếu để trong body thì gate chỉ chạy sau khi payload đã nằm trên đĩa, tức là vô nghĩa.

3. **Grant bind chặt.** Grant gắn với `(tên, cỡ)` đã được duyệt và với `connectionId` của người gửi. Sau khi Multer parse xong, `assertGrantsMatchFiles` đối chiếu tên (đã chuẩn hoá qua basename + sanitize) và cỡ thực tế với grant; lệch một trong hai thì request bị từ chối và file tạm bị dọn. Nhờ vậy grant của `report.pdf` không tiêu được cho file khác, và một lô không thể chở nhiều file hơn số đã duyệt. Grant chuyển `issued → in_use → fulfilled`; thất bại thì trả về `issued` để lần thử lại hoạt động, còn lần dùng thứ hai sau khi thành công bị từ chối.

4. **Host authority bỏ qua consent.** Host không tự duyệt chính mình. Upload do host khởi tạo vẫn đi qua `pending` + accept như M2. Cơ chế kiểm tra là host capability đã xác minh (`X-Host-Token`), không phải cờ `isHost` do client khai.

5. **Bỏ lần hỏi trùng.** Với một file đã có consent, `complete`/upload xong thì file được lưu thẳng vào thư mục nhận, không hỏi lại. AC của UT-012 gọi đây là "tránh consent và complete trùng"; hỏi lần hai cho cùng một quyết định là nhiễu chứ không phải kiểm soát.

6. **Thiết bị tin cậy, thu hồi được.** Client sinh token 256-bit và giữ ở `localStorage`; server **chỉ lưu SHA-256 hash**, không bao giờ lưu token thô. Host đánh dấu tin cậy từ chính hộp thoại duyệt (server đã có hash của thiết bị trong offer, nên host không cần biết secret của thiết bị). Thu hồi qua `DELETE /api/devices/trusted/:id`. Thiết bị tin cậy được duyệt tự động nhưng **vẫn ghi vào lịch sử**, không im lặng.

7. **`dataDir` là nơi lưu bền.** Thêm config `dataDir` (mặc định `~/.universaltrans`, env `UTRANS_DATA_DIR`) cho trusted devices và lịch sử. Không dùng `tempDir` vì đó là vùng tạm bị dọn; cũng không ghi vào thư mục nhận để tránh lẫn dữ liệu người dùng với state của app.

8. **Lịch sử bền và lọc theo người gửi.** `GET /api/transfers/history` trả host thấy tất cả, client chỉ thấy các giao dịch có `connectionId` của chính nó. Entry không bao giờ chứa đường dẫn nội bộ; nhãn thiết bị luôn kèm `labelUntrusted: true`.

9. **Nới đúng một trường của bất biến "config frozen" (ADR-0002 mục 7).** `uploadDir` được đổi lúc chạy qua `PATCH /api/settings` (`requireHost`). Lý do: `pendingUploadManager.accept` đọc `config.uploadDir` tại thời điểm gọi, nên đổi giá trị áp dụng cho file kế tiếp mà không cần restart. Validate: đường dẫn tuyệt đối (hoặc bắt đầu bằng `~`), không nằm trong `tempDir`, không chứa `tempDir`, và phải tạo được. **Mọi trường config khác vẫn bất biến trong vòng đời tiến trình**; `PATCH` từ chối bất kỳ khoá nào khác.

10. **Số lượng và thời hạn có trần rõ ràng.** Offer tối đa 50 file và hết hạn sau `offerTtlMs` (mặc định 2 phút); grant sống theo `uploadExpiry`; lịch sử giữ 500 entry và mỗi lần đọc tối đa 200. Offer hết hạn phát `transfer:offer:expired` cho đúng socket đã gửi, không để phía gửi chờ vô hạn.

11. **Client offer phải có danh tính connection đã xác minh.** Frontend gửi `X-Connection-Id` do server cấp khi tạo và polling offer. Server từ chối client offer thiếu/sai connection ID thay vì phát grant có owner rỗng. Host capability là ngoại lệ duy nhất theo mục 4.

12. **Chunk được authorize trước parser và có capability resume cho no-PIN.** Mọi `POST /api/upload/chunk` phải gửi `X-Upload-Id`; middleware tìm session và kiểm quyền trước Multer, sau đó yêu cầu bản sao `uploadId` trong multipart body phải khớp header. Khi PIN tắt, init trả một capability upload ngẫu nhiên 256-bit và server chỉ giữ SHA-256 hash; capability này chứng minh quyền status/chunk/cancel/complete sau khi WebSocket reconnect. Khi PIN bật, session đã xác thực vẫn là authority và server không phát capability upload riêng.

## Consequences

- Host thấy tên/cỡ/loại và duyệt trước; đĩa và băng thông của host không còn bị chiếm bởi một lô chưa được đồng ý.
- Frontend phải đi qua handshake trước khi upload. Đây là thay đổi phá vỡ tương thích ở tầng API: `POST /api/upload` và `/api/upload/init` từ chối request không có grant bằng `428 TRANSFER_GRANT_REQUIRED` (trừ host). Suite hồi quy M2 đi qua đường host authority, và điều đó được ghi rõ trong chính file test để không ai đọc nhầm là lách gate.
- Trust là một quyết định **bền**, khác mọi quyền khác trong hệ thống (đều mất khi restart). Đây là lý do nó cần store riêng và một API thu hồi riêng.
- `dataDir` trở thành state thật của app: xoá nó là mất danh sách thiết bị tin cậy và lịch sử, nhưng không ảnh hưởng file đã nhận.
- Consent không thay thế TLS: kẻ nghe lén trong LAN vẫn đọc được nội dung. Đây vẫn là giới hạn đã ghi ở ADR-0002.
- Offer/decision/quota/history là các API **mới**, chưa có client ngoài browser này; chưa có versioning API.
- `X-Upload-Id` là thay đổi phá vỡ tương thích của chunk endpoint; client và server phải được nâng cấp cùng nhau. Upload capability là bearer secret chỉ tồn tại trong response init và RAM của task, không được đưa vào QR, `/api/info`, history hay broadcast.
- Chưa kiểm chứng trên điện thoại thật, chưa có HTTPS LAN, và vòng đời cache service worker chưa được kiểm trên browser thật — repo không có E2E browser.
