# Giao thức đo traffic P2P (M5)

Trạng thái: chốt **trước khi đo** (2026-09-17), cùng nhánh `m5`. Theo yêu cầu `REPORT-ROADMAP.md` §6: định nghĩa máy, mạng, file, số lần đo và p50/p95 trước khi tuyên bố bất kỳ con số hiệu năng nào.

## 1. Mục đích

Điều kiện ra khỏi mốc M5 là **đo được** rằng payload A↔B không đi qua host. Tài liệu này định nghĩa phép đo đó để kết quả không phụ thuộc vào cảm nhận hay vào việc "thấy nhanh hơn".

## 2. Định nghĩa "payload không đi qua host"

Một lần truyền được coi là P2P thật khi **tất cả** các điều sau đúng trong suốt thời gian truyền:

| #   | Quan sát                                                                  | Cách kiểm                                                 |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | Không có file mới dưới `tempDir/pending`, `tempDir/relay`, `uploadDir`    | So khớp danh sách + tổng byte trước/sau                   |
| 2   | `runtime.quotaTracker.allocatedBytes` không đổi                           | Đọc trước/sau qua `GET /api/quota` hoặc trực tiếp runtime |
| 3   | Byte qua WebSocket chỉ tăng theo cỡ SDP/candidate, **không** theo cỡ file | Counter signaling của server, so với cỡ file              |
| 4   | Không có `relay:stored` / `relay:downloaded` cho transfer đó              | Vết event WS                                              |
| 5   | Có `p2p:state { state: 'connected' }` cho transfer đó                     | Vết event WS                                              |

Chỉ tiêu (1) và (2) là bằng chứng **server-side**; (3) là bằng chứng định lượng; (4)/(5) là bằng chứng định danh. Không được kết luận P2P chỉ từ (5)/tốc độ.

## 3. Môi trường đo (ghi vào báo cáo, không bỏ trống)

- **Host**: OS + phiên bản, CPU, RAM, ổ đĩa (SSD/HDD), Node version, commit đang đo.
- **Client A**: thiết bị, OS + phiên bản, browser + phiên bản.
- **Client B**: thiết bị, OS + phiên bản, browser + phiên bản.
- **Mạng**: băng tần Wi-Fi (2.4/5 GHz), router, khoảng cách tương đối, có AP isolation hay không, host nối dây hay không.
- **Subnet**: A và B cùng subnet hay khác (khác subnet thì P2P không được kỳ vọng chạy — ghi rõ là ca âm).

Mỗi cấu hình đo **3 lần**; báo cáo cả 3 và p50. Với 3 mẫu, p95 không có ý nghĩa thống kê — ghi rõ là "p50 của 3 lần", **không** gọi là p95.

## 4. Ma trận đo

| Cỡ file | Vai trò           | Số lần | Ghi chú                              |
| ------- | ----------------- | ------ | ------------------------------------ |
| 10 MiB  | P2P               | 3      | Vừa một frame lớn; kiểm framing      |
| 100 MiB | P2P               | 3      | Vượt ngưỡng chunked của app (100 MB) |
| 1 GiB   | P2P               | 3      | Kiểm backpressure dài hơi            |
| 100 MiB | Relay (đối chứng) | 3      | Cùng thiết bị, cùng mạng, để so sánh |

Đối chứng relay là bắt buộc: nếu không có nó, mọi so sánh "nhanh hơn" đều không có cơ sở.

## 5. Chỉ số thu thập

**Phía client (spike hiện ra, chép tay vào báo cáo):** thời gian tới `connected` (ms), thời gian truyền phía receiver tính từ frame đầu tới frame cuối (s), throughput phía receiver (MiB/s), số frame, số lần vòng gửi phải chờ backpressure, checksum khớp hay không, loại candidate quan sát được (host/mDNS/IP thật). Thời gian enqueue ở sender chỉ dùng để chẩn đoán backpressure, không được báo cáo là throughput end-to-end.

**Phía host (chụp trước/sau mỗi lần đo):**

```bash
# tổng byte trong các vùng tạm của app (thay <tempDir> bằng thư mục thật của lần chạy)
du -sb <tempDir>/pending <tempDir>/relay <tempDir>/uploads 2>/dev/null
# quota mà app tự báo
curl -s http://<host>:8080/api/quota
# danh sách file đang stage
curl -s http://<host>:8080/api/shared
```

Ngoài ra ghi: RSS của tiến trình host, số byte signaling server đã chuyển cho transfer đó.

## 6. Mẫu bảng kết quả

| Cỡ      | Transport | Lần  | connected (ms) | Thời gian (s) | MiB/s | Δ đĩa host (B) | Δ quota (B) | Signaling (B) | Checksum |
| ------- | --------- | ---- | -------------- | ------------- | ----- | -------------- | ----------- | ------------- | -------- |
| 10 MiB  | P2P       | 1..3 |                |               |       | **0**          | **0**       |               | khớp     |
| 100 MiB | P2P       | 1..3 |                |               |       | **0**          | **0**       |               | khớp     |
| 1 GiB   | P2P       | 1..3 |                |               |       | **0**          | **0**       |               | khớp     |
| 100 MiB | Relay     | 1..3 | —              |               |       | > 0            | > 0         | —             | khớp     |

## 7. Điều không được tuyên bố từ phép đo này

- Không tuyên bố throughput tối đa của Wi-Fi hay của WebRTC.
- Không tuyên bố p95/p99 với 3 mẫu.
- Không tuyên bố mức tiêu thụ RAM của app chỉ từ RSS của host (client không quan sát được từ host).
- Không tuyên bố P2P hoạt động ngoài LAN cùng subnet: không có STUN/TURN trong phạm vi M5.
- Không tuyên bố đã kiểm chứng trên iOS/Android nếu chưa thực sự chạy trên hai nền tảng đó (ghi rõ nền tảng nào đã chạy).
