# UniversalTrans ⚡

## Trạng thái thực tế và cách vận hành

Chỉ phiên host đã xác thực được xem danh sách chờ và Accept/Decline. Chạy `npm start` và dùng browser do launcher mở; QR/public URL dành cho client. Khi không tự mở browser, dùng liên kết `Host approval URL` riêng được in ở terminal trên máy host. Không chia sẻ liên kết riêng này. Sau restart cần mở lại phiên host.

Nếu đặt `UTRANS_PIN` (4-6 chữ số), host yêu cầu PIN: client phải nhập PIN trong cổng kết nối trước khi xem, tải hay gửi file. PIN trống giữ hành vi LAN mở như trước. Phiên PIN có expiry, thu hồi được (`POST /api/auth/logout`), và mất khi restart. Chi tiết quyết định: [ADR-0002](docs/adr/0002-session-runtime-authority.md).

Stage đường dẫn nguồn (nhánh JSON của `POST /api/share`, dùng cho CLI) là hành động host-only; đặt `UTRANS_ALLOWED_SOURCE_DIRS` để giới hạn thêm thư mục nguồn.

Mô hình hiện tại truyền qua host, chưa có P2P trực tiếp giữa client. Xem [báo cáo và roadmap](REPORT-ROADMAP.md), [quy chuẩn agent](AGENTS.md) và [quality system](docs/agents/quality.md). Chạy `npm run quality` trên Node 22/24 để kiểm tra lint, format, test và coverage.

M1 (commit `64cff86`) và M2 (PR #2, commit `047706f`) đã merge vào `main`. M3 (UT-011, UT-012, UT-016, UT-018) đang nằm trên nhánh `m3-core-ux-consent`, **chưa merge** — đang chờ QC quyết định.

Số liệu đo trên trạng thái cuối của nhánh M3, ngày 2026-09-16, Node 24.15.0 / Windows: **424 automated tests pass**, coverage **90,18% line / 82,97% branch / 87,66% function**, lint và format sạch (`npm run quality`). **Chưa** kiểm chứng: điện thoại thật (Android Chrome / iOS Safari), TLS LAN, vòng đời cache service worker trên browser thật (repo không có E2E browser), và CI chưa chạy cho nhánh này. Các tuyên bố bên dưới cần đối chiếu giới hạn còn mở trong báo cáo.

<p align="center">
  <img src="public/favicon.svg" alt="UniversalTrans Logo" width="96" height="96" />
</p>

<p align="center">
  <strong>AirDrop-style bidirectional file transfer between PC (Windows, Linux) and mobile devices (Android, iOS, iPadOS) over local Wi-Fi.</strong><br>
  <em>100% LAN qua máy host • Zero cloud dependencies • Đang hardening, xem giới hạn trong roadmap.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen" alt="Node Version" />
  <img src="https://img.shields.io/badge/tests-424%20passed-success" alt="Tests" />
  <img src="https://img.shields.io/badge/coverage-90.18%25-blue" alt="Coverage" />
  <img src="https://img.shields.io/badge/port-8080%20default-orange" alt="Port 8080" />
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" />
  <img src="https://img.shields.io/badge/pwa-standalone%20ready-purple" alt="PWA Ready" />
</p>

---

## 📑 Mục lục (Table of Contents)

1. [Tính năng nổi bật (Highlights)](#-tính-năng-nổi-bật-highlights)
2. [Bật / Tắt 1-Click từ Desktop (Windows Shortcuts)](#-bật--tắt-1-click-từ-desktop-windows-shortcuts)
3. [Cài đặt & Khởi động CLI](#-cài-đặt--khởi-động-cli)
4. [Hướng dẫn sử dụng chi tiết (Step-by-Step)](#-hướng-dẫn-sử-dụng-chi-tiết)
   - [Gửi file từ PC sang Điện thoại](#1-gửi-file-từ-máy-tính-sang-điện-thoại)
   - [Gửi file từ Điện thoại sang PC](#2-gửi-file-từ-điện-thoại-sang-máy-tính)
   - [Cài đặt PWA như Ứng dụng gốc](#3-cài-đặt-pwa-như-ứng-dụng-gốc)
5. [Cơ chế kiến trúc & An toàn dữ liệu](#-cơ-chế-kiến-trúc--an-toàn-dữ-liệu)
6. [Lệnh phát triển & Kiểm thử (Tests)](#-lệnh-phát-triển--kiểm-thử)
7. [Xử lý sự cố thường gặp (Troubleshooting)](#-xử-lý-sự-cố-thường-gặp)

---

## 🚀 Tính năng nổi bật (Highlights)

- ⚡ **Truyền qua mạng nội bộ**: Dữ liệu đi qua máy host trên Wi-Fi LAN, không đi qua cloud. Đây chưa phải truyền P2P trực tiếp giữa hai client.
- 📱 **Tương thích toàn diện đa nền tảng**:
  - **PC Host**: Windows 10/11, Linux (Ubuntu, Debian, Fedora, Arch...).
  - **Thiết bị di động**: Android (Chrome PWA), iPhone & iPad (Safari Standalone PWA).
- 🔒 **Host duyệt trước khi truyền (UT-012)**: Điện thoại công bố danh sách file (tên, cỡ, loại) trước; PC duyệt **từng file** trong lô, và **chưa một byte nào được ghi** cho tới lúc đó. File bị từ chối không bao giờ rời khỏi thiết bị. Offer không được trả lời sẽ hết hạn sau `offerTtlMs` (mặc định 2 phút) và phía gửi nhận thông báo rõ.
- 🔁 **Thiết bị tin cậy (tùy chọn)**: Host có thể đánh dấu một thiết bị là tin cậy để lần sau không phải duyệt lại. Server chỉ lưu **hash** của token thiết bị, và host thu hồi được bất cứ lúc nào.
- 🛡️ **Tự động chống ghi đè (Anti-collision Rename)**: Tự động đổi tên `file_(1).ext` nếu file đã tồn tại trên PC.
- 📂 **Tệp lớn đến giới hạn cấu hình**: Mặc định tối đa 10 GiB với chunk 10 MiB. Pause / Resume / Retry cần tiếp tục được harden theo roadmap.
- 🖐️ **Kéo thả thư mục đệ quy & Dán ảnh Clipboard**: Hỗ trợ kéo thả cả thư mục (kể cả sub-folder lồng nhau) từ PC hoặc bấm **`Ctrl+V`** để chia sẻ ảnh chụp màn hình ngay tức thì.
- 💡 **Screen Wake Lock & Tab Guard (có điều kiện)**: Wake Lock chỉ hoạt động trong secure context — trên LAN HTTP (không phải `localhost`) trình duyệt từ chối API này. Từ M3, app **nói rõ lý do** khi không giữ được wake lock, thay vì im lặng để màn hình tự tắt giữa lúc truyền. Cảnh báo chống đóng tab dở dang (`beforeunload`) vẫn chạy.
- 🎨 **Giao diện hiện đại Dark Glassmorphism**: Không dùng framework — 100% Vanilla JS & Vanilla CSS. Chưa có benchmark hiệu năng trên thiết bị thật; xem mục "Tối ưu cần đo" trong roadmap.

---

## 🖥️ Bật / Tắt 1-Click từ Desktop (Windows Shortcuts)

Dự án đã tích hợp sẵn script tạo phím tắt tiện lợi ngay trên màn hình Desktop:

```bash
# Tạo phím tắt ngoài Desktop
npm run setup:shortcuts
```

Sau khi chạy, ngoài màn hình Desktop sẽ xuất hiện 2 phím tắt:

- 🟢 **`UniversalTrans - Bat.lnk`**: Nhấp đúp để **BẬT** server trên port 8080, in QR và tự động mở trình duyệt. Nếu app đang chạy sẵn, script báo và không khởi động trùng.
- 🔴 **`UniversalTrans - Tat.lnk`**: Nhấp đúp để **TẮT** đúng tiến trình UniversalTrans. Script đọc file instance `%TEMP%\utrans-8080.json` (chứa PID do app ghi) nên không kill nhầm ứng dụng khác đang dùng port 8080. Nếu port bị chiếm bởi chương trình khác, bạn cần xử lý thủ công: `utrans -p 9090`.

---

## 📦 Cài đặt & Khởi động CLI

### 1. Yêu cầu hệ thống

- Máy tính đã cài **Node.js (>= 20.0.0)**.
- PC và thiết bị di động kết nối cùng một mạng Wi-Fi (hoặc PC bật Mobile Hotspot phát Wi-Fi cho điện thoại).

### 2. Cài đặt

```bash
# Clone repository
git clone https://github.com/minhtuluc/Intel-Unison-from-Temu.git
cd Intel-Unison-from-Temu

# Cài đặt dependencies (nhẹ, zero native compilation)
npm install

# (Tùy chọn) Cài đặt lệnh CLI 'utrans' dùng trên toàn hệ thống
npm install -g .
```

### 3. Khởi động Server (Port mặc định: 8080)

```bash
# Cách 1: Sử dụng npm script
npm start

# Cách 2: Sử dụng lệnh CLI
utrans

# Khởi động và chia sẻ sẵn file/thư mục ngay lập tức:
utrans video.mp4 "C:\Users\tumin\Pictures"

# Đổi cổng port nếu cần:
utrans -p 9090
```

---

## 📖 Hướng dẫn sử dụng chi tiết

```
+------------------+         Local Wi-Fi (LAN)         +--------------------+
|     PC Host      | <===============================> |   Mobile Device    |
| (Windows / Linux)|      HTTP Streaming (Range 206)   |  (Android / iOS)   |
|  Port: 8080      |      WebSocket Realtime (/ws)     |  PWA / Web App     |
+------------------+                                   +--------------------+
```

### 1. Gửi file từ Máy tính sang Điện thoại

1. Mở giao diện web của UniversalTrans trên máy tính (`http://localhost:8080`).
2. **Kéo thả** file hoặc toàn bộ thư mục vào cửa sổ trình duyệt (màn hình sẽ phát sáng viền neon xác nhận vùng thả).
3. Hoặc chụp màn hình và bấm **`Ctrl + V`** để dán ảnh trực tiếp từ bộ nhớ đệm.
4. Trên điện thoại: Danh sách file sẽ xuất hiện tức thì qua WebSocket trong tab **Files**. Bấm vào ảnh để xem trước hoặc bấm **Download** để tải về.

### 2. Gửi file từ Điện thoại sang Máy tính

1. Dùng camera điện thoại quét mã QR hiển thị trên màn hình máy tính (hoặc gõ địa chỉ `http://<LAN-IP>:8080`).
2. Trên điện thoại, chuyển sang tab **Upload** ở thanh dưới đáy.
3. Chọn **Browse Files** (chọn nhiều file/ảnh/video) hoặc bấm **Camera** (chụp ảnh/quay video gửi ngay).
4. Bấm **Start Upload**:
   - Màn hình điện thoại tự động được giữ sáng (Screen Wake Lock).
   - Thanh tiến độ hiển thị % hoàn thành, tốc độ MB/s và thời gian còn lại (ETA).
5. **Host duyệt trước khi truyền (UT-012)**:
   - Ngay khi chọn file, điện thoại gửi **danh sách** (tên, cỡ, loại) — chưa có dữ liệu nào được gửi.
   - Trên PC bật lên hộp thoại liệt kê từng file kèm checkbox:
     _“Thiết bị [Tên máy] muốn gửi N file(s)”_
   - Bấm **Approve Selected**: chỉ những file được tick mới được phép truyền, và chúng được lưu thẳng vào thư mục `Downloads\UniversalTrans` — không hỏi lại lần hai.
   - Bấm **Decline All**: không file nào được gửi, không byte nào được ghi.
   - Tick **Remember this device** để lần sau thiết bị đó không phải duyệt lại (thu hồi được).

### 3. Cài đặt PWA như Ứng dụng gốc

- **Android (Chrome / Edge)**: Nút **Install App** chỉ xuất hiện khi trình duyệt bắn sự kiện `beforeinstallprompt`, tức là khi trang chạy trong secure context (HTTPS hoặc `localhost`). Truy cập bằng LAN HTTP thì nút bị ẩn và bạn cần vào menu trình duyệt ➔ _Thêm vào MH chính_.
- **iPhone / iPad (Safari)**: Bấm nút **Install App** (hoặc nút **Chia sẻ / Share** hình ô vuông mũi tên lên của Safari) ➔ Cuộn xuống chọn **Thêm vào MH chính (Add to Home Screen)**.

---

## 🛡️ Cơ chế kiến trúc & An toàn dữ liệu

| Cơ chế                        | Chi tiết kỹ thuật                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Staging Area**              | Lưu danh sách tệp đang chia sẻ trên RAM (`share-manager.js`), không quét tự động ổ cứng người dùng.                                                                                                                              |
| **Streaming Range 206**       | Hỗ trợ HTTP Range Header cho phép tua video trực tuyến và tải file mượt mà trên iOS Safari không sợ tràn RAM.                                                                                                                    |
| **Consent trước truyền**      | Upload của client phải kèm grant do host cấp. Offer hết hạn sau `offerTtlMs` (mặc định 2 phút); grant dùng một lần, bind theo `(tên, cỡ)` đã duyệt và theo connection. Upload không grant bị chặn **trước khi** Multer chạm đĩa. |
| **Pending & TTL**             | Upload do chính host khởi tạo vẫn đi qua vùng tạm `temp/pending` và tự xóa sau 5 phút nếu không duyệt. File đã có consent thì không đi qua bước này.                                                                             |
| **Anti-Traversal Protection** | Chặn toàn bộ ký tự traversal `..`, `\0` null-bytes, kiểm tra quyền truy cập đĩa cứng an toàn.                                                                                                                                    |
| **Security Headers**          | Trang bị `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, tắt `x-powered-by`.                                                                                                                                   |
| **Offline Shell Cache**       | Service Worker cache sẵn giao diện; đường truyền dữ liệu `/api/*` và `/ws` luôn đi thẳng qua mạng LAN. Tên cache (`utrans-shell-<version>`) lấy từ `package.json` nên tự đổi mỗi bản phát hành.                                  |

---

## 🛠️ Lệnh phát triển & Kiểm thử

Quality gate chạy lint + format + toàn bộ test kèm ngưỡng coverage (`npm run quality`). Số liệu dưới đây là lần đo gần nhất trên Node 22/Linux:

```bash
# Chạy toàn bộ automated tests (Unit + Integration + Security)
npm run test:all

# Đo độ phủ mã nguồn (tham chiếu kết quả mới nhất từ npm run quality)
npm run test:coverage

# Kiểm tra cú pháp chuẩn ESLint (0 errors)
npm run lint

# Tự động định dạng mã nguồn theo chuẩn Prettier
npm run format

# Kiểm tra tính hợp lệ của định dạng
npx prettier --check .

# Chạy server ở chế độ phát triển (Nodemon tự reload)
npm run dev
```

---

## ❓ Xử lý sự cố thường gặp (Troubleshooting)

1. **Điện thoại không truy cập được địa chỉ IP của máy tính**:
   - Đảm bảo điện thoại và máy tính đang kết nối **chung một mạng Wi-Fi** (hoặc PC phát Mobile Hotspot).
   - Kiểm tra xem mạng Wi-Fi có bật tính năng "AP Isolation" (cách ly thiết bị khách) không.
   - Kiểm tra **Windows Firewall**: Mở PowerShell với quyền Admin và cho phép port 8080 nếu bị chặn:
     ```powershell
     New-NetFirewallRule -DisplayName "UniversalTrans Port 8080" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
     ```
2. **Cổng 8080 bị chiếm dụng bởi ứng dụng khác**:
   - Sử dụng phím tắt **`UniversalTrans - Bat`** (tự động dọn dẹp port 8080 cũ).
   - Hoặc khởi động server với port khác: `utrans -p 9090`.
3. **Màn hình điện thoại bị tắt khi truyền file nặng**:
   - UniversalTrans đã tích hợp Screen Wake Lock. Hãy chắc chắn bạn đang mở tab UniversalTrans trên trình duyệt (không chuyển sang ứng dụng khác).

---

## 📜 Giấy phép (License)

Phát hành theo giấy phép **MIT License**. Tự do sử dụng, chỉnh sửa và phân phối cho mục đích cá nhân và thương mại.
