# Giao thức signaling P2P (M5)

Trạng thái: đề xuất cùng nhánh `m5` (2026-09-17); **chưa merge** — chờ QC. Quyết định nền: [ADR-0005](../adr/0005-p2p-transport-authority.md).

Signaling đi trên **kênh WebSocket sẵn có** (`/ws`). Host chỉ chuyển tiếp; payload P2P không đi qua host.

## 1. Vòng đời một phiên signaling

Một phiên signaling chỉ tồn tại **sau khi receiver đã chấp nhận** một relay (M4). Nó được gắn với `relayId` — không có định danh mới nào do client tự đặt.

```text
A tạo relay tới B            (M4: POST /api/relay/offer)
B accept                     (M4: POST /api/relay/decision)
        │
        ▼
  [session: created]  ← server bind hai bên bằng identity key đã lưu trong relay
        │
   A gửi offer ──────────────► B
   B gửi answer ◄─────────────
   hai bên trao candidate
        │
        ├─ ICE connected  → [connected] → payload đi trực tiếp A↔B
        ├─ ICE fail/timeout → [failed]  → A chuyển sang relay M4 (tự động)
        └─ quá p2pSessionTtlMs → [expired] → mọi signal sau đó bị từ chối
```

## 2. Event

### 2.1 `p2p:signal` — client → server

```json
{
  "event": "p2p:signal",
  "data": {
    "relayId": "rl_AbC123",
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

Đích đến **không** do client khai: server suy ra đối tác còn lại của `relayId`. Client cố tình khai `targetDeviceId` sẽ bị bỏ qua (trường này không tồn tại trong schema — thêm vào là lỗi `P2P_INVALID_SIGNAL`).

### 2.2 `p2p:signal` — server → đối tác

```json
{
  "event": "p2p:signal",
  "data": {
    "relayId": "rl_AbC123",
    "fromDeviceId": "<server-issued device id>",
    "fromRole": "sender",
    "signal": { "kind": "offer", "sdp": "..." }
  }
}
```

Chỉ socket của **đối tác** nhận được. Host, observer và mọi socket khác không nhận.

### 2.3 `p2p:state` — client → server (báo cáo)

```json
{ "event": "p2p:state", "data": { "relayId": "rl_AbC123", "state": "connected" } }
```

`state` ∈ `connecting` | `connected` | `failed`. `reason` (tùy chọn) là chuỗi ngắn do client đặt, **không** chứa SDP.

### 2.4 `p2p:state` — server → hai bên (thông báo)

```json
{
  "event": "p2p:state",
  "data": {
    "relayId": "rl_AbC123",
    "state": "failed",
    "reason": "ICE_TIMEOUT",
    "reporter": "sender"
  }
}
```

Gửi cho **cả hai** bên. `connected` và `failed` là trạng thái cuối: báo cáo đầu tiên thắng, các báo cáo sau bị bỏ qua (idempotent).

### 2.5 `p2p:error` — server → người gửi

```json
{ "event": "p2p:error", "data": { "relayId": "rl_AbC123", "code": "P2P_RATE_LIMITED" } }
```

Chỉ gửi cho bên vừa gây lỗi; **không** tiết lộ lý do cho bên kia (tránh dò trạng thái).

## 3. Mã lỗi

| Code                   | Nghĩa                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `P2P_DISABLED`         | `p2pEnabled` đang tắt.                                                                     |
| `P2P_INVALID_SIGNAL`   | Payload sai schema, `kind` lạ, có trường đích do client khai, hoặc SDP/candidate sai kiểu. |
| `P2P_NO_SESSION`       | `relayId` không tồn tại, không phải relay đang mở, hoặc đã hết `p2pSessionTtlMs`.          |
| `P2P_NOT_ACCEPTED`     | Receiver chưa chấp nhận relay này.                                                         |
| `P2P_FORBIDDEN`        | Người gửi không phải một trong hai bên đã bind của relay.                                  |
| `P2P_SIGNAL_TOO_LARGE` | Message vượt `p2pMaxSignalBytes`.                                                          |
| `P2P_RATE_LIMITED`     | Vượt `p2pSignalRatePerMin` cho socket này.                                                 |
| `P2P_TARGET_OFFLINE`   | Đối tác không còn socket sống; phiên chuyển `failed` lý do `TARGET_OFFLINE`.               |

## 4. Ràng buộc server phải giữ

1. **Hai bên đã bind.** Người gửi phải giao với `sender.keys` hoặc `receiver.keys` của relay (identity key do server suy ra, không phải `X-Connection-Id`).
2. **Đích là đối tác còn lại.** Tra qua `discovery`, không nhận từ client.
3. **Consent trước.** Không chuyển signal khi relay chưa `accepted`.
4. **Giới hạn.** `p2pMaxSignalBytes`, `p2pSignalRatePerMin`, `p2pSessionTtlMs`; vượt → `p2p:error`, không chuyển tiếp.
5. **Không rò.** Signal không broadcast, không vào history, không log nội dung; chỉ đối tác nhận.
6. **Socket phải đã xác thực** (`isAuthorized()`), nếu không thì bỏ qua.

## 5. Giới hạn mặc định

| Key                   | Mặc định | Ghi chú                                                          |
| --------------------- | -------- | ---------------------------------------------------------------- |
| `p2pEnabled`          | `false`  | Bật/tắt toàn bộ signaling; khi tắt, đường M4 chạy y nguyên.      |
| `p2pIceTimeoutMs`     | `10000`  | Hết hạn mà chưa `connected` → fallback relay.                    |
| `p2pSessionTtlMs`     | `300000` | Sau đó mọi signal của relay này bị từ chối.                      |
| `p2pMaxSignalBytes`   | `65536`  | Một SDP thực tế vài KB; cap để chặn lạm dụng.                    |
| `p2pSignalRatePerMin` | `120`    | Theo socket.                                                     |
| `p2pMaxFrameBytes`    | `65536`  | Giới hạn interop an toàn cho một message SCTP (xem ADR-0005 §7). |

Tất cả là env `UTRANS_P2P_*`, **đóng băng** trong vòng đời tiến trình (chỉ `uploadDir` đổi được lúc chạy — ADR-0003 §9).

## 6. Không thuộc phạm vi

- Định tuyến nhiều peer, mesh, chuyển tiếp giữa hai cặp khác nhau.
- Resume/khôi phục phiên signaling sau khi socket đóng: đơn giản là fallback relay.
- Trao đổi khoá hay bí mật ngoài SDP/candidate của WebRTC.
