# ADR-0005 — P2P thử nghiệm: host làm signaling, receiver giữ quyền quyết định

Status: Đề xuất cùng nhánh `m5` (2026-09-17); **chưa merge** — chờ QC.

Bổ sung cho [ADR-0001](0001-host-approval-authority.md), [ADR-0002](0002-session-runtime-authority.md), [ADR-0003](0003-consent-before-transfer.md) và [ADR-0004](0004-relay-receiver-authority.md); không thay thế. ADR-0004 quy định ai được quyết định khi người nhận không phải host. ADR này quy định điều gì xảy ra khi **byte không đi qua host nữa**, và những gì phải giữ nguyên khi điều đó xảy ra.

## Context

Sau M4, "gửi cho một thiết bị" đã đúng về quyền nhưng payload vẫn đi qua host **hai lần** (lên rồi xuống) và nằm plaintext trong `tempDir/relay` cho tới khi hết TTL. `REPORT-ROADMAP.md` (dòng M5) đặt mục tiêu thử nghiệm WebRTC DataChannel với điều kiện ra khỏi mốc: **đo traffic chứng minh payload A↔B không đi qua host**, ICE failure được báo, và relay fallback chỉ theo policy rõ.

Ràng buộc thực tế của môi trường hiện tại:

- App chạy **HTTP LAN**, không phải secure context. Theo tài liệu chuẩn (MDN), `RTCPeerConnection` và `RTCDataChannel` **không** bị đánh dấu secure-context-only, nhưng hành vi thực tế trên origin không bảo mật (đặc biệt chính sách mDNS/ICE của từng trình duyệt) **chưa được kiểm chứng** trong repo này. Đây là câu hỏi mở lớn nhất, và ADR này biến nó thành một **gate** thay vì một giả định.
- Không có STUN/TURN: chỉ có host candidate, nên P2P chỉ khả thi khi hai thiết bị cùng một subnet LAN.
- Hai đầu là browser (không có agent native), nên mọi thứ phải chạy trong tab.

## Decision

1. **P2P thay đường byte, không thay mô hình quyền.** Offer, quyết định của receiver, grant dùng một lần và thứ tự consent giữ nguyên như ADR-0003/0004. P2P chỉ đổi cách payload từ A tới B.

2. **Host chỉ làm signaling.** `offer`/`answer`/`candidate` đi qua kênh WebSocket sẵn có. Host **không** nhận, không ghi đĩa, không đọc payload P2P. Đây là định nghĩa "P2P" của dự án: host tham gia điều khiển, không tham gia dữ liệu.

3. **Luật chọn transport, một chỗ và kiểm tra được:**

   ```text
   P2P  khi  (1) cả hai đầu đang online (còn identity key sống)
         và  (2) cả hai đầu có RTCPeerConnection + RTCDataChannel
         và  (3) ICE đạt 'connected' trước p2pIceTimeoutMs
   relay (M4)  khi bất kỳ điều kiện nào ở trên không đạt
   ```

   Người gửi **chỉ chọn thiết bị nhận**; không có lựa chọn "đường đi" cho người dùng.

4. **Fallback tự động nhưng không im lặng.** Khi P2P không thiết lập được, hệ thống chuyển sang relay M4 và **báo rõ** cho cả hai phía (`p2p:state` với `state: 'failed'`, kèm lý do), đồng thời ghi `transport` vào history. Lý do: người dùng có quyền biết file của mình đã đi qua máy host.

5. **Signaling là chuyển tiếp có kiểm soát, không phải relay mù.** Server chỉ chuyển một `p2p:signal` khi **tất cả** điều kiện sau đúng:
   - người gửi là một trong hai bên **đã bind** của một relay đang mở (sender keys hoặc receiver keys);
   - đích đến là **đúng đối tác còn lại** của relay đó, tra qua `discovery` (device → socket sống → identity keys), không nhận key từ client;
   - receiver **đã chấp nhận** (giữ bất biến consent-trước của ADR-0003);
   - message nằm trong giới hạn size và rate của phiên.
     Signaling **không** được broadcast, không ghi vào history, không log nội dung SDP/candidate.

6. **Giới hạn bắt buộc cho kênh signaling.** `maxPayload` cho WebSocketServer, cap byte cho mỗi signal, rate limit theo socket, TTL cho mỗi phiên signaling. Lượt này bổ sung luôn các giới hạn WS còn thiếu, vì signaling biến WS từ "kênh sự kiện" thành kênh chuyển tiếp giữa các client.

7. **Framing trên DataChannel.** DataChannel ở chế độ **ordered + reliable**. Mỗi frame là một message nhị phân có header (version, kind, chunk index, length) và payload; frame quá `p2pMaxFrameBytes` bị từ chối; thiếu/lệch chunk index làm hỏng tính toàn vẹn và kết thúc bằng fallback.

8. **Backpressure theo `bufferedAmount`.** Vòng gửi chỉ đẩy frame khi `bufferedAmount` dưới ngưỡng (`bufferedamountlow`), và tiến độ hiển thị đo theo byte **đã gửi thật**, không phải byte đã xếp hàng.

9. **Toàn vẹn kiểm ở phía nhận.** SHA-256 toàn file (hàm đã có sẵn, không phụ thuộc transport) được tính ở sender và **xác minh ở receiver trước khi** file được trao cho người dùng. Sai checksum → huỷ, không có file rác, và fallback.

10. **P2P không tạo dấu vết trên đĩa host.** Không file trong `tempDir/pending` hay `tempDir/relay`, không thay đổi `quotaTracker.allocatedBytes`, và transport thắng được ghi vào history với `source: 'p2p'` + `transport` để phân biệt với đường relay.

11. **Không STUN/TURN trong lượt này.** Chỉ host candidate. Hệ quả được chấp nhận: hai thiết bị khác subnet/NAT sẽ không P2P được — đó là việc của relay fallback, không phải lỗi.

12. **DTLS là của WebRTC, TLS LAN thì chưa có.** Payload P2P được mã hoá bởi DTLS của WebRTC; **signaling thì không** — SDP và candidate đi trên WS plaintext trong LAN. ADR này không hứa bảo mật đầu-cuối cho toàn hệ thống.

13. **Gate thực nghiệm trước khi thi công data plane.** Một trang spike độc lập (trao đổi SDP thủ công, không cần server) phải chứng minh trên **thiết bị thật** rằng ICE + DataChannel hoạt động trên HTTP LAN. Nếu không, dừng: mở mốc riêng cho TLS LAN và **không** xây signaling/data plane trên giả định sai.

14. **Config mới, đóng băng như các key khác** (giữ ADR-0003 §9: chỉ `uploadDir` đổi được lúc chạy): `p2pEnabled`, `p2pIceTimeoutMs`, `p2pSessionTtlMs`, `p2pMaxSignalBytes`, `p2pSignalRatePerMin`, `p2pMaxFrameBytes`.

## Consequences

- Lần đầu tiên có một đường dữ liệu **không** đi qua host. Điều đó làm nhẹ host (không đĩa, không quota, không băng thông hai chiều) nhưng cũng làm mất khả năng quan sát của host: host không còn biết nội dung hay kích thước thật của thứ đã đi qua.
- "Đã giao" không còn là một sự kiện host quan sát được (M4 định nghĩa nó bằng một response `200` hoàn tất từ host). Với P2P, tín hiệu đó phải đến từ receiver — nên **receiver phải báo hoàn tất**, và báo cáo đó là dữ liệu do client cung cấp, không phải bằng chứng host kiểm chứng được. Ghi nhận đây là điểm yếu của mô hình và ghi vào history kèm `transport`.
- Fallback tự động làm đường relay trở thành đường dự phòng thường trực: nó phải luôn sẵn sàng, nghĩa là **không** được gỡ M4 khi thêm M5.
- WS trở thành bề mặt tấn công rộng hơn: trước đây client chỉ nói chuyện với server, nay server chuyển tiếp nội dung giữa hai client. Giảm thiểu bằng §5 và §6, nhưng đây là đánh đổi đã biết.
- Nếu spike thất bại, giá trị của mốc này vẫn còn: ADR, luật chọn transport, giới hạn WS và bộ test cho signaling đều dùng được khi P2P chạy trên TLS.
- Trải nghiệm người dùng không đổi về cơ bản (vẫn chọn thiết bị nhận), nhưng thông báo fallback là thứ mới và bắt buộc.

## Không thuộc phạm vi ADR này

- TLS/provisioning chứng chỉ trên LAN (mở thành mốc riêng nếu gate yêu cầu).
- STUN/TURN, xuyên NAT, P2P khác subnet.
- Mesh nhiều peer, nhiều receiver cho một file, gửi tiếp (resume) qua một kết nối P2P mới.
- Media stream (chỉ DataChannel), thumbnail/preview qua P2P.
- Lưu payload vào history (history vẫn chỉ là metadata).
