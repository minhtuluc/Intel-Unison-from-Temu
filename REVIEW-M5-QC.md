# Báo cáo QC M5 — nền P2P và spike HTTP LAN

Ngày rà soát: 2026-09-18  
Nhánh: `m5`  
Commit được rà soát: `24311abac4e7654a549178a4a3bd6d799c6702c9`  
Base: `origin/main` tại `e20442d07a0a5ea8e82be9f15aa2b15be9c4c8a3`

## Kết luận

**Chưa đủ điều kiện merge M5.** Commit này mới dựng ADR, giao thức và spike; chính task UT-026 vẫn `in-progress` và chưa chạy gate bắt buộc trên Android Chrome/iOS Safari. Ngoài gate chưa thực hiện, thiết kế còn ba blocker cần chốt trước khi giao UT-027/UT-028 cho agent thi công.

QC đã tự vá ba lỗi nhỏ, tách biệt: spike luôn đi network thay vì có thể bị service worker giữ bản cũ; throughput chỉ lấy ở receiver từ frame đầu tới frame cuối thay vì dùng tốc độ enqueue; và `public/spike/` được đưa vào lint/format gate. Các thay đổi này không triển khai signaling hay data plane.

## Blocker cần đội thi công phản hồi

### M5-QC-01 — P1 — `connected` bị coi là terminal nên không thể fallback sau lỗi truyền

**Vị trí:** `docs/protocol/p2p-signaling.md`, mục 2.3–2.4; `docs/adr/0005-p2p-transport-authority.md`, quyết định 7–10.

Protocol hiện quy định `connected` và `failed` đều terminal, báo cáo đầu tiên thắng. Trong khi ADR yêu cầu fallback khi lệch chunk/checksum và thừa nhận hoàn tất P2P phải do receiver báo. Một phiên có thể ICE `connected`, sau đó DataChannel đóng giữa chừng hoặc checksum sai; báo cáo `failed` lúc đó sẽ bị bỏ qua, nên sender không được chuyển sang relay. Protocol cũng không có trạng thái `completed`, vì vậy server không có sự kiện receiver-authoritative để ghi kết quả history như ADR yêu cầu.

**Yêu cầu sửa:** state machine tối thiểu phải là `connecting → connected → completed | failed`; `connected` không terminal. `completed` chỉ receiver được báo sau khi đủ byte + checksum đúng; `failed` được chấp nhận cả sau `connected` cho tới khi completed. Quy định rõ idempotency, xung đột hai phía và test cho `connected → checksum mismatch → failed → relay fallback`.

### M5-QC-02 — P1 — Signaling bind theo `relayId` nhưng consent của M4 là theo từng file

**Vị trí:** `docs/protocol/p2p-signaling.md`, mục 1 và 4; `docs/tasks/UT-027.md`; hiện trạng M4 tại `src/services/relay-transfer.js` (`files[].decision`, relay chuyển sang `decided`).

M4 không có trạng thái relay-level `accepted`: receiver quyết định từng file trong một batch. Khi mọi file đã được quyết định, relay còn chuyển từ `pending` sang `decided` và sang vùng `recent`. Đặc tả M5 lại nói tạo session sau khi “receiver chấp nhận relay”, yêu cầu “relay đang mở”, và mọi event chỉ mang `relayId`. Với batch accept một file, decline/pending file khác, implementation không có predicate chính xác để mở session và không có cách ràng buộc frame vào đúng file đã được consent.

**Yêu cầu sửa:** bind signaling/data session với tập `(relayId, fileIndex)` đã `accepted`, hoặc định nghĩa rõ một connection chở nhiều file nhưng mọi frame phải mang `fileIndex` và receiver chỉ cấp sink cho index đã accept. Chốt cách đọc relay ở `relays`/`recent`; thêm negative tests cho batch mixed accept/decline và không cho byte của file chưa accept được trao cho người dùng.

### M5-QC-03 — P1 — Chưa có chiến lược sink bounded-memory ở receiver

**Vị trí:** `docs/adr/0005-p2p-transport-authority.md`, quyết định 7–10; `docs/tasks/UT-028.md`; ma trận 1 GiB trong `docs/benchmarks/p2p-traffic-protocol.md`.

Thiết kế nói receiver kiểm SHA-256 trước khi “trao file”, nhưng chưa định nghĩa byte được ghi ở đâu trong lúc nhận. Nếu ghép toàn bộ DataChannel chunks thành một `Blob`, test 1 GiB có thể giữ xấp xỉ toàn bộ file trong RAM và không đạt mục tiêu bounded-memory. Đây cũng là chỗ phải bảo đảm file checksum sai/cancel không bị lộ như file hoàn chỉnh.

**Yêu cầu sửa:** UT-028 phải có receiver sink policy trước khi viết transport: streaming sink có giới hạn RAM khi capability hỗ trợ; nếu không có sink phù hợp cho kích thước file thì fallback relay **trước khi truyền P2P** hoặc áp giới hạn P2P được công bố rõ. Hash phải cập nhật cùng stream; chỉ finalize sau checksum đúng; cancel/mismatch phải đóng và dọn partial sink. Thêm test peak buffered bytes theo frame/window, không chỉ test sender backpressure.

## Cần chỉnh trước khi phát hành

### M5-QC-04 — P2 — Cần ghi đúng giới hạn tin cậy của DTLS/signaling

**Vị trí:** `docs/adr/0005-p2p-transport-authority.md`, quyết định 2 và 12; `CONTEXT.md` phần cam kết M5.

WebRTC mã hóa payload trên đường truyền, nhưng fingerprint/SDP đi qua signaling do host kiểm soát và dự án chưa có xác thực peer độc lập. Vì vậy đây không phải bảo đảm mật mã rằng một host bị chiếm quyền không thể xen giữa. Tài liệu nên nói rõ “host app trung thực không nhận payload” là invariant implementation; chưa phải end-to-end identity/authentication chống host độc hại.

## Bản vá nhỏ QC đã thực hiện

- `public/sw.js`: `/spike/` bypass service-worker cache để mỗi phép đo tải đúng instrument hiện tại.
- `tests/unit/pwa.test.js`: gọi trực tiếp fetch handler của service worker và khóa hành vi network-only.
- `public/spike/p2p.js`: receiver bắt đầu đồng hồ ở frame đầu; sender chỉ báo thời gian enqueue, không gắn nhãn throughput.
- `scripts/quality.js` và `package.json`: đưa `public/spike/` vào ESLint/Prettier gate. Trước sửa, cả hai file spike đều fail `prettier --check` nhưng `npm run quality` vẫn xanh vì không quét thư mục này.

## Những phần đã ổn

- Commit không giả vờ đã triển khai P2P; UT-026/027/028 và giới hạn chưa kiểm chứng được ghi rõ.
- Host chỉ được thiết kế làm signaling; không có payload/file P2P trong temp/quota.
- Đích signaling do server suy ra, không nhận target từ client; có size/rate/TTL và yêu cầu auth.
- Giao thức đo dùng quan sát server-side, không kết luận P2P chỉ từ UI hoặc tốc độ.
- Không nhồi STUN/TURN/TLS vào cùng lượt khi chưa có bằng chứng gate.

## Điều kiện QC vòng sau

1. Chốt và cập nhật protocol cho ba blocker P1 ở trên.
2. Chạy UT-026 trên Windows Chrome ↔ Android Chrome và Windows Chrome ↔ iOS Safari, ghi report môi trường/kết quả thật; nếu một gate không đạt thì mở UT-029 và chưa làm UT-027/028.
3. Chỉ sau gate `go` mới thi công signaling/data plane; negative tests phải đi qua HTTP/WS/DataChannel seam tương ứng.
4. GitHub Actions Ubuntu/Windows × Node 22/24 xanh trên head mới; không coi Node test là bằng chứng browser/device.
