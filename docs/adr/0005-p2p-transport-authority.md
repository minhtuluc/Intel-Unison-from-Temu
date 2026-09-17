# ADR-0005 — P2P thử nghiệm: host làm signaling, receiver giữ quyền quyết định

Status: Đề xuất cùng nhánh `m5` (2026-09-18, vòng 2 sau `REVIEW-M5-QC.md`); **chưa merge** — chờ QC.

Bổ sung cho [ADR-0001](0001-host-approval-authority.md), [ADR-0002](0002-session-runtime-authority.md), [ADR-0003](0003-consent-before-transfer.md) và [ADR-0004](0004-relay-receiver-authority.md); không thay thế. ADR-0004 quy định ai được quyết định khi người nhận không phải host. ADR này quy định điều gì xảy ra khi **byte không đi qua host nữa**, và những gì phải giữ nguyên khi điều đó xảy ra.

## Context

Sau M4, "gửi cho một thiết bị" đã đúng về quyền nhưng payload vẫn đi qua host **hai lần** (lên rồi xuống) và nằm plaintext trong `tempDir/relay` cho tới khi hết TTL. `REPORT-ROADMAP.md` (dòng M5) đặt mục tiêu thử nghiệm WebRTC DataChannel với điều kiện ra khỏi mốc: **đo traffic chứng minh payload A↔B không đi qua host**, ICE failure được báo, và relay fallback chỉ theo policy rõ.

Ràng buộc thực tế của môi trường hiện tại:

- App chạy **HTTP LAN**, không phải secure context. Theo tài liệu chuẩn (MDN), `RTCPeerConnection` và `RTCDataChannel` **không** bị đánh dấu secure-context-only, nhưng hành vi thực tế trên origin không bảo mật (đặc biệt chính sách mDNS/ICE của từng trình duyệt) **chưa được kiểm chứng** trong repo này. Đây là câu hỏi mở lớn nhất, và ADR này biến nó thành một **gate** thay vì một giả định.
- Không có STUN/TURN: chỉ có host candidate, nên P2P chỉ khả thi khi hai thiết bị cùng một subnet LAN.
- Hai đầu là browser (không có agent native), nên mọi thứ phải chạy trong tab. Hệ quả quan trọng: trên origin HTTP LAN **không có** File System Access API (đòi secure context), và `crypto.subtle` cũng không tồn tại — nên sink ở receiver chỉ có thể là bộ nhớ, và hàm băm phải là bản pure-JS đã có trong `public/js/utils.js`.

## Decision

1. **P2P thay đường byte, không thay mô hình quyền.** Offer, quyết định của receiver, grant dùng một lần và thứ tự consent giữ nguyên như ADR-0003/0004. P2P chỉ đổi cách payload từ A tới B.

2. **Host chỉ làm signaling — đây là bất biến của implementation, không phải bảo đảm mật mã.** `offer`/`answer`/`candidate` đi qua kênh WebSocket sẵn có; ứng dụng host **không** nhận, không ghi đĩa, không đọc payload P2P. Nhưng host nằm giữa đường signaling: nó phát SDP (kèm fingerprint DTLS) cho hai bên và dự án **chưa có** xác thực peer độc lập. Một host bị chiếm quyền có thể xen vào giữa. Vì vậy "host không nhận payload" là kết luận về **hành vi của app trung thực**, không phải tính chất mật mã chống host độc hại. Muốn chống được thì cần xác thực khoá ngoài băng (không thuộc phạm vi ADR này).

3. **Luật chọn transport, một chỗ và kiểm tra được:**

   ```text
   P2P  khi  (1) cả hai đầu đang online (còn identity key sống)
         và  (2) cả hai đầu có RTCPeerConnection + RTCDataChannel
         và  (3) kích thước file ≤ p2pMaxInMemoryBytes (xem quyết định 9)
         và  (4) ICE đạt 'connected' trước p2pIceTimeoutMs
   relay (M4)  khi bất kỳ điều kiện nào ở trên không đạt
   ```

   Người gửi **chỉ chọn thiết bị nhận**; không có lựa chọn "đường đi" cho người dùng. Điều kiện (3) được kiểm **trước khi gửi byte nào**: file vượt trần thì đi relay ngay, không thử P2P rồi mới thất bại.

4. **Fallback tự động nhưng không im lặng.** Khi P2P không thiết lập được hoặc thất bại giữa chừng, hệ thống chuyển sang relay M4 và **báo rõ** cho cả hai phía (`p2p:state` với `state: 'failed'`, kèm lý do), đồng thời ghi `transport` vào history. Lý do: người dùng có quyền biết file của mình đã đi qua máy host.

5. **Signaling là chuyển tiếp có kiểm soát, không phải relay mù.** Server chỉ chuyển một `p2p:signal` khi **tất cả** điều kiện sau đúng:
   - người gửi là một trong hai bên **đã bind** của relay (sender keys hoặc receiver keys);
   - `fileIndex` nằm trong **tập index receiver đã accept** — M4 quyết định theo từng file, không có "accepted" ở cấp lô, nên một file bị decline không được mở đường cho byte nào;
   - đích đến là **đúng đối tác còn lại** của relay đó, tra qua `discovery`, không nhận key từ client;
   - message nằm trong giới hạn size và rate của phiên.
     Signaling **không** được broadcast, không ghi vào history, không log nội dung SDP/candidate.

6. **Giới hạn bắt buộc cho kênh signaling.** `maxPayload` cho WebSocketServer, cap byte cho mỗi signal, rate limit theo socket, TTL cho mỗi phiên signaling. Lượt này bổ sung luôn các giới hạn WS còn thiếu, vì signaling biến WS từ "kênh sự kiện" thành kênh chuyển tiếp giữa các client.

7. **Framing trên DataChannel, mỗi frame mang `fileIndex`.** DataChannel ở chế độ **ordered + reliable**. Mỗi frame là một message nhị phân có header (version, kind, `fileIndex`, chunk index, length) và payload. Frame quá `p2pMaxFrameBytes` bị từ chối; `fileIndex` ngoài tập đã accept bị từ chối; thiếu/lệch chunk index làm hỏng tính toàn vẹn và kết thúc bằng fallback.

8. **Backpressure theo `bufferedAmount`.** Vòng gửi chỉ đẩy frame khi `bufferedAmount` dưới ngưỡng (`bufferedamountlow`), và tiến độ hiển thị đo theo byte **đã gửi thật**, không phải byte đã xếp hàng.

9. **Sink ở receiver có trần bộ nhớ, và trần đó chặn cả việc thử P2P.** Trên HTTP LAN không có File System Access nên byte nhận được chỉ có thể nằm trong RAM cho tới khi tạo `Blob` để người dùng lưu. Vì vậy:
   - Receiver **không** ghép toàn bộ file trong RAM một cách mù quáng; nó dùng streaming sink với bộ nhớ bị chặn theo `p2pMaxInMemoryBytes`.
   - File vượt trần → **không thử P2P**, đi relay (quyết định 3, điều kiện 3). Trần này là công khai, không phải giới hạn ẩn.
   - Hàm băm được cập nhật **theo từng chunk khi nhận**, không phải sau khi ghép xong.
   - Chỉ **finalize** (trao file cho người dùng) sau khi checksum khớp. Cancel hoặc mismatch phải đóng sink, giải phóng buffer và không để lại dấu vết file dở.
   - Nếu sau này app chạy trên secure context (xem quyết định 13) thì File System Access có thể thay sink bộ nhớ và nâng trần — khi đó sửa ADR này.

10. **Toàn vẹn kiểm ở phía nhận.** SHA-256 toàn file (bản pure-JS đã có, không phụ thuộc transport và không cần `crypto.subtle`) được tính ở sender và **xác minh ở receiver trước khi** file được trao cho người dùng. Sai checksum → huỷ, không có file rác, và fallback.

11. **`completed` là tín hiệu của receiver, và phiên không kết thúc ở `connected`.** Máy trạng thái phiên là `connecting → connected → completed | failed`. `connected` **không** terminal: DataChannel có thể đóng giữa chừng hoặc checksum sai sau khi đã connected, và khi đó `failed` phải được chấp nhận để sender còn chuyển sang relay. `completed` chỉ receiver được báo, chỉ sau khi đủ byte + checksum khớp. Chi tiết luật race và idempotency: `docs/protocol/p2p-signaling.md` §2.1.

12. **P2P không tạo dấu vết trên đĩa host.** Không file trong `tempDir/pending` hay `tempDir/relay`, không thay đổi `quotaTracker.allocatedBytes`, và transport thắng được ghi vào history với `source: 'p2p'` + `transport` để phân biệt với đường relay.

13. **Không STUN/TURN trong lượt này.** Chỉ host candidate. Hệ quả được chấp nhận: hai thiết bị khác subnet/NAT sẽ không P2P được — đó là việc của relay fallback, không phải lỗi.

14. **DTLS của WebRTC bảo vệ đường truyền, không xác thực người nhận.** Payload P2P được mã hoá giữa hai đầu; **signaling thì không** — SDP và candidate đi trên WS plaintext trong LAN, do host chuyển. ADR này không hứa bảo mật đầu-cuối, và không hứa chống được host độc hại (xem quyết định 2).

15. **Gate thực nghiệm trước khi thi công data plane.** Một trang spike độc lập (trao đổi SDP thủ công, không cần server) phải chứng minh trên **thiết bị thật** rằng ICE + DataChannel hoạt động trên HTTP LAN. Nếu không, dừng: mở mốc riêng cho TLS LAN và **không** xây signaling/data plane trên giả định sai.

16. **Config mới, đóng băng như các key khác** (giữ ADR-0003 §9: chỉ `uploadDir` đổi được lúc chạy): `p2pEnabled`, `p2pIceTimeoutMs`, `p2pSessionTtlMs`, `p2pMaxSignalBytes`, `p2pSignalRatePerMin`, `p2pMaxFrameBytes`, `p2pMaxInMemoryBytes`.

## Consequences

- Lần đầu tiên có một đường dữ liệu **không** đi qua host. Điều đó làm nhẹ host (không đĩa, không quota, không băng thông hai chiều) nhưng cũng làm mất khả năng quan sát của host: host không còn biết nội dung hay kích thước thật của thứ đã đi qua.
- "Đã giao" không còn là một sự kiện host quan sát được (M4 định nghĩa nó bằng một response `200` hoàn tất từ host). Với P2P, tín hiệu đó phải đến từ receiver — nên **receiver phải báo hoàn tất**, và báo cáo đó là dữ liệu do client cung cấp, không phải bằng chứng host kiểm chứng được. Ghi nhận đây là điểm yếu của mô hình và ghi vào history kèm `transport`.
- Vì `connected` không terminal, sender có thể đã bắt đầu fallback relay trong khi receiver vẫn kịp hoàn tất P2P. Trường hợp này được quy định là **`completed` thắng** và sender phải huỷ/ thu hồi phần relay của mình; nếu không, người nhận sẽ thấy hai bản và host giữ một bản vô ích. Đây là cái giá của việc không thể quan sát P2P từ host.
- Trần `p2pMaxInMemoryBytes` làm P2P **không** phù hợp cho file lớn trong môi trường HTTP LAN hiện tại (mặc định 64 MiB). Đó là giới hạn được công bố, không phải lỗi: file lớn đi relay, và muốn P2P cho file lớn thì cần secure context để có sink ghi thẳng ra đĩa.
- Fallback tự động làm đường relay trở thành đường dự phòng thường trực: nó phải luôn sẵn sàng, nghĩa là **không** được gỡ M4 khi thêm M5.
- WS trở thành bề mặt tấn công rộng hơn: trước đây client chỉ nói chuyện với server, nay server chuyển tiếp nội dung giữa hai client. Giảm thiểu bằng quyết định 5 và 6, nhưng đây là đánh đổi đã biết.
- Nếu spike thất bại, giá trị của mốc này vẫn còn: ADR, luật chọn transport, giới hạn WS và bộ test cho signaling đều dùng được khi P2P chạy trên TLS.
- Trải nghiệm người dùng không đổi về cơ bản (vẫn chọn thiết bị nhận), nhưng thông báo fallback là thứ mới và bắt buộc.

## Không thuộc phạm vi ADR này

- TLS/provisioning chứng chỉ trên LAN (mở thành mốc riêng nếu gate yêu cầu).
- Xác thực peer ngoài băng, chống host độc hại xen giữa.
- STUN/TURN, xuyên NAT, P2P khác subnet.
- Sink ghi thẳng ra đĩa (File System Access) — cần secure context.
- Mesh nhiều peer, nhiều receiver cho một file, gửi tiếp (resume) qua một kết nối P2P mới.
- Media stream (chỉ DataChannel), thumbnail/preview qua P2P.
- Lưu payload vào history (history vẫn chỉ là metadata).
