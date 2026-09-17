# Giao thức signaling P2P (M5)

Trạng thái: đề xuất cùng nhánh `m5` (2026-09-18, vòng 2 sau `REVIEW-M5-QC.md`); **chưa merge** — chờ QC. Quyết định nền: [ADR-0005](../adr/0005-p2p-transport-authority.md).

Signaling đi trên **kênh WebSocket sẵn có** (`/ws`). Host chỉ chuyển tiếp; payload P2P không đi qua host.

## 1. Phiên signaling gắn với **từng file đã được chấp nhận**, không phải cả relay

M4 quyết định **theo từng file** trong một batch: receiver có thể accept file 0 và decline file 1. Relay không có trạng thái "accepted" ở cấp lô; khi mọi file đã được quyết định, relay chuyển `pending → decided` và được đưa vào vùng `recent` (bounded) của `RelayTransferService`.

Vì vậy một phiên signaling được định danh bằng **tập `(relayId, fileIndex)` đã `accepted`**, không phải bằng `relayId` đơn thuần:

```text
receiver accept file 0 và 2 của relay rl_AbC
        │
        ▼
[session rl_AbC] acceptedIndexes = [0, 2]
   - chỉ hai index này được mở sink ở receiver
   - frame mang fileIndex ngoài tập này bị từ chối
```

Hệ quả bắt buộc:

1. **Mọi frame mang `fileIndex`.** Một DataChannel có thể chở nhiều file, nhưng không có frame nào "vô danh".
2. **Receiver chỉ mở sink cho index đã accept.** Byte của file bị decline hoặc chưa quyết định **không** được ghi vào đâu cả.
3. **Tra relay phải đọc cả `relays` và `recent`.** Sau khi receiver quyết định, relay thường đã nằm ở `recent` (đúng lúc signaling bắt đầu), nên dùng `relayService.getRelay(relayId)` — không tự đọc riêng `relays`.
4. **Phiên giữ bản sao của mình.** Session lưu `acceptedIndexes`, `senderKeys`, `receiverKeys` tại thời điểm tạo, để không phụ thuộc việc relay còn nằm trong vùng tracked hay đã bị đẩy khỏi `recent`.

## 2. Vòng đời phiên

```text
   receiver accept (index 0, 2)
            │
            ▼
      [connecting] ── ICE fail / timeout ──────────────┐
            │                                          │
     ICE connected, cả hai báo                         │
            ▼                                          │
       [connected] ── checksum mismatch / DC đóng ─────┤
            │                                          ▼
   receiver báo đủ byte + checksum đúng           [failed]
            ▼
       [completed]                        (sender chuyển relay M4)
```

### 2.1 Luật trạng thái (chống race)

| Luật                              | Nội dung                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Không terminal**                | `connecting` và `connected` đều không terminal. Một phiên `connected` vẫn có thể `failed` (DataChannel đóng giữa chừng, checksum sai, hết hạn im lặng).                                                                                                                                   |
| **Ai báo gì**                     | `connecting`/`connected`/`failed`: **một trong hai bên**. `completed`: **chỉ receiver**, và chỉ sau khi đã nhận đủ byte + checksum khớp.                                                                                                                                                  |
| **`failed` hợp lệ khi nào**       | Bất kỳ lúc nào **trước** `completed`. Sau `completed`, mọi báo cáo `failed` bị từ chối (`P2P_SESSION_CLOSED`).                                                                                                                                                                            |
| **Idempotent**                    | Báo lại đúng trạng thái hiện tại là no-op: không phát event thứ hai.                                                                                                                                                                                                                      |
| **Race `failed` rồi `completed`** | `completed` thắng. Server chuyển phiên sang `completed` với cờ `recoveredAfterFailure: true` và thông báo lại cho cả hai. Sender **phải huỷ fallback relay** nó đã bắt đầu (huỷ task/offer của chính nó); nếu file relay đã lên đĩa host thì gọi `relay:revoke` để không tồn tại hai bản. |
| **Race `completed` rồi `failed`** | `failed` bị từ chối; phiên giữ `completed`.                                                                                                                                                                                                                                               |
| **Hết `p2pSessionTtlMs`**         | Phiên chuyển `failed` lý do `SESSION_EXPIRED` nếu chưa terminal.                                                                                                                                                                                                                          |

`completed` là tín hiệu **do receiver cung cấp**, không phải server quan sát được. Đây là điểm yếu đã ghi trong ADR-0005 (mục Consequences): server chỉ có thể trao quyền cho receiver, không thể tự kiểm chứng.

## 3. Event

### 3.1 `p2p:signal` — client → server

```json
{
  "event": "p2p:signal",
  "data": {
    "relayId": "rl_AbC123",
    "fileIndex": 0,
    "signal": {
      "kind": "offer",
      "sdp": "v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\n..."
    }
  }
}
```

`signal.kind` là `offer`, `answer` hoặc `candidate`. Với `candidate`:

```json
{
  "kind": "candidate",
  "candidate": { "candidate": "candidate:...", "sdpMid": "0", "sdpMLineIndex": 0 }
}
```

`fileIndex` phải nằm trong `acceptedIndexes`. Đích đến **không** do client khai: server suy ra đối tác còn lại của relay. Thêm trường `targetDeviceId` là lỗi `P2P_INVALID_SIGNAL`.

`offer`/`answer` chỉ cần gửi một lần cho mỗi phiên (một DataChannel dùng chung cho mọi index đã accept); `candidate` trao đổi tự do trong giới hạn rate.

### 3.2 `p2p:signal` — server → đối tác

```json
{
  "event": "p2p:signal",
  "data": {
    "relayId": "rl_AbC123",
    "fileIndex": 0,
    "fromDeviceId": "<server-issued device id>",
    "fromRole": "sender",
    "signal": { "kind": "offer", "sdp": "..." }
  }
}
```

Chỉ socket của **đối tác** nhận được. Host, observer và mọi socket khác không nhận.

### 3.3 `p2p:state` — client → server (báo cáo)

```json
{ "event": "p2p:state", "data": { "relayId": "rl_AbC123", "state": "connected" } }
```

Với `completed`, báo kèm index đã hoàn tất (một phiên có thể có nhiều file):

```json
{
  "event": "p2p:state",
  "data": { "relayId": "rl_AbC123", "state": "completed", "fileIndex": 0 }
}
```

`state` ∈ `connecting` | `connected` | `failed` | `completed`. `reason` (tùy chọn) là chuỗi ngắn phía client, **không** chứa SDP.

### 3.4 `p2p:state` — server → hai bên (thông báo)

```json
{
  "event": "p2p:state",
  "data": {
    "relayId": "rl_AbC123",
    "state": "completed",
    "fileIndex": 0,
    "reporter": "receiver",
    "recoveredAfterFailure": false
  }
}
```

Gửi cho **cả hai** bên.

### 3.5 `p2p:error` — server → người gửi

```json
{ "event": "p2p:error", "data": { "relayId": "rl_AbC123", "code": "P2P_RATE_LIMITED" } }
```

Chỉ gửi cho bên vừa gây lỗi; **không** tiết lộ lý do cho bên kia (tránh dò trạng thái).

## 4. Mã lỗi

| Code                   | Nghĩa                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `P2P_DISABLED`         | `p2pEnabled` đang tắt.                                                                                   |
| `P2P_INVALID_SIGNAL`   | Payload sai schema, `kind` lạ, có trường đích do client khai, SDP/candidate sai kiểu, thiếu `fileIndex`. |
| `P2P_NOT_ACCEPTED`     | `fileIndex` không nằm trong tập index đã được receiver chấp nhận.                                        |
| `P2P_NO_SESSION`       | `relayId` không tồn tại, chưa có phiên, hoặc phiên đã hết `p2pSessionTtlMs`.                             |
| `P2P_FORBIDDEN`        | Người gửi không phải một trong hai bên đã bind của relay.                                                |
| `P2P_SESSION_CLOSED`   | Báo cáo không hợp lệ vì phiên đã `completed` (hoặc đã `failed` và báo cáo không phải `completed`).       |
| `P2P_SIGNAL_TOO_LARGE` | Message vượt `p2pMaxSignalBytes`.                                                                        |
| `P2P_RATE_LIMITED`     | Vượt `p2pSignalRatePerMin` cho socket này.                                                               |
| `P2P_TARGET_OFFLINE`   | Đối tác không còn socket sống; phiên chuyển `failed` lý do `TARGET_OFFLINE`.                             |

## 5. Ràng buộc server phải giữ

1. **Hai bên đã bind.** Người gửi phải giao với `sender.keys` hoặc `receiver.keys` của relay (identity key do server suy ra, không phải `X-Connection-Id`).
2. **Đích là đối tác còn lại.** Tra qua `discovery`, không nhận từ client.
3. **Consent theo từng file.** `fileIndex` phải ∈ `acceptedIndexes`; không có "consent cấp lô".
4. **Giới hạn.** `p2pMaxSignalBytes`, `p2pSignalRatePerMin`, `p2pSessionTtlMs`; vượt → `p2p:error`, không chuyển tiếp.
5. **Không rò.** Signal không broadcast, không vào history, không log nội dung; chỉ đối tác nhận.
6. **Socket phải đã xác thực** (`isAuthorized()`), nếu không thì bỏ qua.

## 6. Giới hạn mặc định

| Key                   | Mặc định            | Ghi chú                                                                                        |
| --------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `p2pEnabled`          | `false`             | Bật/tắt toàn bộ signaling; khi tắt, đường M4 chạy y nguyên.                                    |
| `p2pIceTimeoutMs`     | `10000`             | Hết hạn mà chưa `connected` → fallback relay.                                                  |
| `p2pSessionTtlMs`     | `300000`            | Sau đó phiên chưa terminal chuyển `failed` (`SESSION_EXPIRED`).                                |
| `p2pMaxSignalBytes`   | `65536`             | Một SDP thực tế vài KB; cap để chặn lạm dụng.                                                  |
| `p2pSignalRatePerMin` | `120`               | Theo socket.                                                                                   |
| `p2pMaxFrameBytes`    | `65536`             | Giới hạn interop an toàn cho một message SCTP (xem ADR-0005 quyết định 7).                     |
| `p2pMaxInMemoryBytes` | `67108864` (64 MiB) | Trần cho sink ở receiver (xem ADR-0005 quyết định 9). Vượt trần → **không** thử P2P, đi relay. |

Tất cả là env `UTRANS_P2P_*`, **đóng băng** trong vòng đời tiến trình (chỉ `uploadDir` đổi được lúc chạy — ADR-0003 §9).

## 7. Không thuộc phạm vi

- Định tuyến nhiều peer, mesh, chuyển tiếp giữa hai cặp khác nhau.
- Resume/khôi phục phiên signaling sau khi socket đóng: đơn giản là fallback relay.
- Trao đổi khoá hay bí mật ngoài SDP/candidate của WebRTC; **không** có xác thực peer độc lập (xem ADR-0005 quyết định 12).
