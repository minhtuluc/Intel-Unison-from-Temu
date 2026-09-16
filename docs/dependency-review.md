# Dependency advisory review

`docs/agents/quality.md` yêu cầu mỗi lần review dependency phải ghi **ngày** và **phiên bản cụ thể**. Mỗi lượt thêm một mục mới ở dưới cùng; không sửa mục cũ.

## 2026-09-16 — Multer (UT-018)

**Bối cảnh.** `npm ci` cảnh báo `multer@1.4.5-lts.2` deprecated, kèm mô tả "impacted by a number of vulnerabilities, which have been patched in 2.x" — trong khi `npm audit --omit=dev` báo 0 advisory. Hai nguồn không mâu thuẫn: cờ deprecation do maintainer đặt trên registry, còn `audit` chỉ phản ánh advisory đã có trong GitHub Advisory Database. Vì vậy phiếu UT-018 ghi "audit 0 advisory nhưng package vẫn bị đánh dấu deprecated" là đúng cả hai vế.

**Nguồn đã kiểm.** Trang release chính thức `github.com/expressjs/multer/releases`, tra ngày 2026-09-16.

**Phiên bản tại thời điểm kiểm.**

| Gói                 | Trước       | Sau    |
| ------------------- | ----------- | ------ |
| multer              | 1.4.5-lts.2 | 2.4.0  |
| busboy (transitive) | 1.x         | ^1.6.0 |

**Phát hiện.** Chuỗi 2.x chứa các bản vá CVE mà 1.x không có: CVE-2025-47935 và CVE-2025-47944 (2.0.0); CVE-2025-48997 và CVE-2025-7338 (2.0.1–2.0.2); hai CVE ở 2.2.0; bốn CVE ở 2.3.0; CVE-2026-88932 ở 2.4.0. Điểm breaking duy nhất được công bố ở 2.0.0 là **Node tối thiểu 10.16.0** — repo yêu cầu `>=20.0.0` nên không ảnh hưởng.

**Thay đổi hành vi cần lưu ý khi nâng.**

- 2.3.0: file đúng bằng `limits.fileSize` nay được chấp nhận (trước bị từ chối). Repo kiểm tra vượt ngưỡng ở mức `maxFileSize + 1024`, nên kết quả test không đổi.
- 2.4.0: `limits` được validate lúc khởi tạo và `fileSize` không phải số nguyên bị từ chối. Cả ba chỗ đặt `limits` trong repo (`src/routes/transfer.js` hai chỗ, `src/routes/files.js` một chỗ) đều truyền số nguyên, nên an toàn.
- 2.4.0: `diskStorage` dùng được không cần options, và có thêm tùy chọn flush (fsync trước khi hoàn tất).
- Không có thay đổi chữ ký nào với `multer()`, `diskStorage` hay `memoryStorage`.

**Kết luận.** Nâng lên `multer@^2.4.0`. Sau khi nâng: `npm audit --omit=dev` báo 0 vulnerability; `npm run quality` pass toàn bộ 392 test và không phải sửa call site nào. Regression multipart đi qua `tests/integration/upload-limits.test.js`, `api-transfer.test.js`, `m2-qc-review-regression.test.js` (R6, R11) và nhánh multipart của `/api/share`.

**Chưa kiểm.** Chỉ chạy suite tự động; không chạy thật với file lớn trên thiết bị, không đo throughput.
