# UniversalTrans

> **AirDrop-style bidirectional file transfer between PC (Windows, Linux) and mobile devices (Android, iOS, iPadOS) over local Wi-Fi.**  
> _Zero internet required • 100% LAN point-to-point • Production-grade reliability • No cloud dependencies._

---

## 🚀 Tính năng nổi bật (Highlights)

- ⚡ **Tốc độ tối đa mạng nội bộ (Point-to-Point LAN)**: Truyền trực tiếp qua Wi-Fi 5 / Wi-Fi 6, không thông qua server trung gian hay internet, không bị bóp băng thông.
- 📱 **Tương thích toàn diện đa nền tảng**:
  - **PC Host**: Windows 10/11, Linux (Ubuntu, Debian, Fedora, Arch...).
  - **Thiết bị di động**: Android (Google Chrome PWA), iPhone & iPad (Safari Standalone PWA).
- 🔒 **Bảo vệ an toàn PC (PC Confirmation)**: PC **luôn luôn** được hỏi xác nhận `Accept` / `Decline` trước khi lưu bất kỳ file nào từ điện thoại gửi lên. Tự động dọn dẹp file rác sau 5 phút nếu không có phản hồi.
- 🛡️ **Tự động chống ghi đè (Auto-rename)**: Tự động đổi tên `file_(1).ext` nếu file đã tồn tại trên PC.
- 📂 **Hỗ trợ tệp tin siêu lớn (Lên tới 10GB+)**: Cơ chế phân mảnh (Chunked Upload 10MB) với khả năng Pause / Resume / Retry tự động khi mạng chập chờn.
- 🖐️ **Kéo thả thư mục đệ quy & Dán ảnh Clipboard**: Hỗ trợ kéo thả cả folder từ PC hoặc bấm **`Ctrl+V`** để chia sẻ ảnh chụp màn hình ngay tức thì.
- 💡 **Screen Wake Lock & Tab Guard**: Giữ màn hình điện thoại luôn sáng khi đang truyền file nặng và cảnh báo khi người dùng vô tình đóng tab.
- 🎨 **Giao diện hiện đại Dark Glassmorphism**: Thiết kế tối ưu theo chuẩn Responsive Web App, mượt mà trên cả máy tính lẫn điện thoại.

---

## 📦 Cài đặt (Installation)

Yêu cầu máy tính đã cài đặt **Node.js (>= 18.0.0)**.

```bash
# Clone repository
git clone https://github.com/minhtuluc/Intel-Unison-from-Temu.git
cd Intel-Unison-from-Temu

# Cài đặt dependencies (rất nhẹ, không phụ thuộc thư viện native nặng)
npm install

# (Tùy chọn) Cài đặt lệnh CLI 'utrans' dùng trên toàn hệ thống
npm install -g .
```

---

## 📖 Hướng dẫn sử dụng chi tiết (User Guide)

### 1. Khởi động trên Máy tính (PC Host)

Mở Terminal / PowerShell tại thư mục dự án và chạy:

```bash
# Cách 1: Sử dụng npm
npm start

# Cách 2: Nếu đã link / install CLI global
utrans
```

- Ngay khi chạy, server sẽ tự động phát hiện địa chỉ IP mạng nội bộ (ví dụ: `http://192.168.1.15:3456`).
- Một **mã QR to rõ** sẽ được in trực tiếp trong Terminal.
- Trình duyệt web của máy tính sẽ **tự động mở** trang giao diện quản lý.

#### 💡 Mẹo dòng lệnh hữu ích:

```bash
# Khởi động và chia sẻ sẵn file/thư mục ngay lập tức:
utrans video.mp4 "C:\Users\tumin\Pictures"

# Đổi cổng port nếu cổng 3456 bị trùng:
utrans -p 8080
```

---

### 2. Kết nối từ Điện thoại (Android / iPhone / iPad)

1. Đảm bảo điện thoại và máy tính **đang kết nối chung một mạng Wi-Fi** (hoặc PC phát Hotspot cho điện thoại).
2. **Quét mã QR**:
   - Dùng ứng dụng **Camera** mặc định trên điện thoại quét mã QR hiển thị trên Terminal máy tính (hoặc bấm biểu tượng **QR** ở góc trên thanh Header của web máy tính để phóng to).
   - Hoặc mở trình duyệt trên điện thoại và gõ trực tiếp địa chỉ hiển thị (ví dụ `http://192.168.1.15:3456`).
3. Trạng thái kết nối sẽ chuyển sang chấm xanh **Online** kèm độ trễ mạng (ví dụ `2ms`). Danh sách thiết bị kết nối sẽ hiện tại tab **Devices**.

---

### 3. Gửi file từ Máy tính sang Điện thoại

1. Trên màn hình máy tính, bạn chỉ cần:
   - **Kéo thả** bất kỳ tệp hoặc toàn bộ thư mục vào cửa sổ trình duyệt (toàn màn hình sẽ hiện vùng thả sáng neon).
   - Hoặc chụp ảnh màn hình rồi bấm **`Ctrl + V`** trực tiếp trong trình duyệt.
2. Trên điện thoại:
   - Danh sách tệp sẽ xuất hiện **ngay lập tức** (thời gian thực qua WebSocket) tại tab **Files**.
   - Bấm vào tệp ảnh để xem trước (Preview zoom), hoặc bấm **Download** để tải về máy với tốc độ tối đa của router Wi-Fi.

---

### 4. Gửi file từ Điện thoại sang Máy tính

1. Trên giao diện điện thoại, chuyển sang tab **Upload** ở thanh điều hướng dưới đáy.
2. Chọn tệp muốn gửi:
   - Bấm **Browse Files**: Chọn nhiều ảnh, video, tệp tin từ bộ nhớ máy.
   - Bấm **Camera**: Chụp ảnh hoặc quay video để gửi trực tiếp.
3. Bấm **Start Upload (X files)**:
   - Màn hình chuyển sang tab **Transfers** hiển thị thanh tiến trình, tốc độ (MB/s) và thời gian còn lại (ETA).
   - Màn hình điện thoại sẽ tự động được giữ sáng (Screen Wake Lock) để quá trình truyền không bị ngắt quãng.
4. **Xác nhận trên Máy tính (PC Approval)**:
   - Trên màn hình máy tính sẽ lập tức xuất hiện hộp thoại thông báo nổi:  
     _“Pixel 8 Pro muốn gửi tệp: video_4k.mp4 (450 MB)”_
   - Người dùng PC bấm **Accept** để chấp nhận lưu vào thư mục `Downloads` của UniversalTrans (mặc định tại thư mục chạy app hoặc đường dẫn cấu hình).
   - Hoặc bấm **Decline** để từ chối (tệp tạm sẽ bị xóa vật lý ngay lập tức).

---

### 5. Cài đặt thành Ứng dụng PWA (Dùng như App gốc không cần nhập URL)

- **Trên Android (Chrome/Edge)**: Bấm vào nút **Install App** ở góc trên thanh Header ➔ Chọn **Cài đặt**. Ứng dụng sẽ xuất hiện trên màn hình chính và khay ứng dụng.
- **Trên iPhone / iPad (Safari)**: Bấm nút **Install App** hoặc nút **Chia sẻ (Share)** hình ô vuông mũi tên lên trên thanh công cụ của Safari ➔ Cuộn xuống chọn **Thêm vào MH chính (Add to Home Screen)** ➔ Bấm **Thêm (Add)**.

---

## 🛠️ Lệnh phát triển & Kiểm thử (Development & Testing)

```bash
# Chạy toàn bộ 139 automated tests
npm run test:all

# Kiểm tra độ phủ mã nguồn (Code coverage > 83%)
npm run test:coverage

# Kiểm tra cú pháp chuẩn ESLint
npm run lint

# Định dạng code với Prettier
npm run format

# Chạy server ở chế độ tự động reload (Nodemon)
npm run dev
```

---

## 📜 Giấy phép (License)

Phát hành theo giấy phép **MIT License**. Tự do sử dụng, chỉnh sửa và phân phối cho mục đích cá nhân và thương mại.
