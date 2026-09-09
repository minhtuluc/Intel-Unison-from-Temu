# UniversalTrans ⚡

<p align="center">
  <img src="public/favicon.svg" alt="UniversalTrans Logo" width="96" height="96" />
</p>

<p align="center">
  <strong>AirDrop-style bidirectional file transfer between PC (Windows, Linux) and mobile devices (Android, iOS, iPadOS) over local Wi-Fi.</strong><br>
  <em>100% LAN point-to-point • Zero cloud dependencies • Max Wi-Fi 5/6 throughput • Production-grade reliability.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen" alt="Node Version" />
  <img src="https://img.shields.io/badge/tests-139%20passed-success" alt="Tests" />
  <img src="https://img.shields.io/badge/coverage-83.34%25-blue" alt="Coverage" />
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

- ⚡ **Tốc độ tối đa mạng nội bộ (Point-to-Point LAN)**: Truyền dữ liệu trực tiếp qua Wi-Fi nội bộ (Wi-Fi 5 / Wi-Fi 6), không gửi dữ liệu ra ngoài Internet, không qua bên thứ ba, không bị bóp băng thông.
- 📱 **Tương thích toàn diện đa nền tảng**:
  - **PC Host**: Windows 10/11, Linux (Ubuntu, Debian, Fedora, Arch...).
  - **Thiết bị di động**: Android (Chrome PWA), iPhone & iPad (Safari Standalone PWA).
- 🔒 **Bảo vệ an toàn PC (PC Upload Approval Flow)**: Khi điện thoại gửi file lên, PC **luôn luôn** hiển thị popup xác nhận `Accept` / `Decline` trước khi lưu vào ổ cứng. Tự động dọn dẹp file tạm sau 5 phút (TTL) nếu không có phản hồi.
- 🛡️ **Tự động chống ghi đè (Anti-collision Rename)**: Tự động đổi tên `file_(1).ext` nếu file đã tồn tại trên PC.
- 📂 **Hỗ trợ tệp tin siêu lớn (10GB+)**: Cơ chế phân mảnh tệp **Chunked Upload 10MB** kèm Pause / Resume / Retry tự động với exponential backoff khi mạng chập chờn.
- 🖐️ **Kéo thả thư mục đệ quy & Dán ảnh Clipboard**: Hỗ trợ kéo thả cả thư mục (kể cả sub-folder lồng nhau) từ PC hoặc bấm **`Ctrl+V`** để chia sẻ ảnh chụp màn hình ngay tức thì.
- 💡 **Screen Wake Lock & Tab Guard**: Tự động giữ sáng màn hình thiết bị khi đang truyền file và cảnh báo chống đóng tab dở dang (`beforeunload`).
- 🎨 **Giao diện hiện đại Dark Glassmorphism**: Không dùng framework nặng, 100% Vanilla JS & Vanilla CSS hiệu năng cao, siêu mượt mà.

---

## 🖥️ Bật / Tắt 1-Click từ Desktop (Windows Shortcuts)

Dự án đã tích hợp sẵn script tạo phím tắt tiện lợi ngay trên màn hình Desktop:

```bash
# Tạo phím tắt ngoài Desktop
npm run setup:shortcuts
```

Sau khi chạy, ngoài màn hình Desktop sẽ xuất hiện 2 phím tắt:

- 🟢 **`UniversalTrans - Bat.lnk`**: Nhấp đúp để **BẬT** server. Tự động dọn dẹp port 8080 nếu có tiến trình cũ treo, mở server trên port 8080, in mã QR to rõ và tự động mở trình duyệt web.
- 🔴 **`UniversalTrans - Tat.lnk`**: Nhấp đúp để **TẮT** sạch toàn bộ tiến trình UniversalTrans đang chạy trên port 8080 chỉ trong 1 giây.

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
5. **Xác nhận trên PC (PC Approval Modal)**:
   - Trên màn hình máy tính sẽ bật lên hộp thoại thông báo nổi:  
     _“Thiết bị [Tên máy] muốn gửi tệp: file_name.ext (Dung lượng)”_
   - Bấm **Accept File**: File được lưu an toàn vào thư mục `Downloads\UniversalTrans` của máy tính.
   - Bấm **Decline**: Hủy nhận và xóa file tạm ngay lập tức.

### 3. Cài đặt PWA như Ứng dụng gốc

- **Android (Chrome / Edge)**: Bấm nút **Install App** ở góc trên thanh Header ➔ Chọn **Cài đặt**.
- **iPhone / iPad (Safari)**: Bấm nút **Install App** (hoặc nút **Chia sẻ / Share** hình ô vuông mũi tên lên của Safari) ➔ Cuộn xuống chọn **Thêm vào MH chính (Add to Home Screen)**.

---

## 🛡️ Cơ chế kiến trúc & An toàn dữ liệu

| Cơ chế                          | Chi tiết kỹ thuật                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Staging Area**                | Lưu danh sách tệp đang chia sẻ trên RAM (`share-manager.js`), không quét tự động ổ cứng người dùng.                      |
| **Streaming Range 206**         | Hỗ trợ HTTP Range Header cho phép tua video trực tuyến và tải file mượt mà trên iOS Safari không sợ tràn RAM.            |
| **PC Confirmation & 5-min TTL** | File tải lên được đưa vào vùng tạm `temp/pending`. Tự động xóa sau 5 phút nếu PC không duyệt.                            |
| **Anti-Traversal Protection**   | Chặn toàn bộ ký tự traversal `..`, `\0` null-bytes, kiểm tra quyền truy cập đĩa cứng an toàn.                            |
| **Security Headers**            | Trang bị `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, tắt `x-powered-by`.                           |
| **Offline Shell Cache**         | Service Worker `utrans-shell-v2` cache sẵn giao diện; đường truyền dữ liệu `/api/*` và `/ws` luôn đi thẳng qua mạng LAN. |

---

## 🛠️ Lệnh phát triển & Kiểm thử

Dự án được xây dựng theo chuẩn **Quality Gates** nghiêm ngặt với 100% test passing:

```bash
# Chạy toàn bộ 139 automated tests (Unit + Integration + Security)
npm run test:all

# Đo độ phủ mã nguồn (Target >80%, thực tế: 83.34%)
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
