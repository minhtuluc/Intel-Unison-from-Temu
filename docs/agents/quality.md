# Quality system

## Lệnh bàn giao

`npm ci` rồi `npm run quality` trên Node 22 hoặc 24. Lượt M1 sau khi hoàn thành sửa các lỗi review vòng 1 và vòng 2 (R1–R7): 207 automated tests pass, coverage 93,59% line / 88,53% branch / 93,49% function — tách biệt automated test Node với kiểm thử browser E2E và thiết bị thật. Runner thực thi lint, format và toàn bộ test với coverage thresholds; bước lỗi trả exit code khác 0. Test nhận UTRANS_UPLOAD_DIR/UTRANS_TEMP_DIR riêng để tránh ghi vào Downloads của người dùng. Không dùng runner này để bật ứng dụng thật.

CI: `.github/workflows/quality.yml`, Windows và Ubuntu × Node 22/24, timeout 15 phút, chỉ quyền đọc repo. Workflow được tạo local; kết quả CI chỉ có sau khi push. Người quản trị cần bật branch protection yêu cầu tất cả job Quality thành công; file YAML không tự bật branch protection.

## Gates hiện thực thi

| Gate       | Điều kiện                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| Lint       | ESLint src, tests, bin, browser JS, service worker, quality runner không lỗi.                                              |
| Format     | Prettier kiểm tra các vùng code/docs/CI được khai báo trong runner.                                                        |
| Regression | Unit + integration pass; timeout mỗi test 30 giây để lỗi WS không treo vô hạn.                                             |
| Coverage   | Tổng mã được instrument ≥80% lines, ≥65% branches, ≥75% functions.                                                         |
| Isolation  | Runner tạo vùng nhận/tạm riêng, dọn sau khi các child process kết thúc. Test cũ tự tạo temp tương đối vẫn phải tự cleanup. |

Coverage Node chỉ phản ánh file thực sự được load và có thể không tính module UI chưa import. Không gọi chỉ số này là coverage toàn sản phẩm. Không hạ ngưỡng để merge; nâng dần sau khi có test browser. E2E chưa được cài trong lượt này.

## Ma trận test bắt buộc theo thay đổi

| Khu vực       | Ca cần khóa                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authorization | Host + sender + observer; giả isHost, sai/thiếu khóa, foreign Origin, remote socket, restart khóa cũ; API và WS đều phải chặn.                                     |
| Approval      | Simple/chunked; client accept/decline 403 không thay đổi file; host accept checksum đúng; host decline xóa temp; reconnect đọc lại pending.                        |
| Transfer      | 0 B, nhỏ hơn/bằng/lớn hơn chunk, nhiều file hơn concurrency; pause khi XHR chạy, cancel lúc retry/backoff/merge; complete retry không nhân đôi.                    |
| Disk          | Cùng tên đồng thời, disk full, permission denied, EXDEV, restart, TTL; không mất file đã có.                                                                       |
| Runtime       | CWD khác, custom port/port 0, QR đúng, đổi NIC, port occupied, SIGINT với WS còn mở.                                                                               |
| Frontend      | 3 browser context độc lập; chỉ host popup; batch approval không mất mục; reload, WS disconnect/reconnect, toast đúng nội dung; cổng PIN chỉ hiện khi host bật PIN. |
| Packaging     | Máy sạch không Node, standard user, Unicode/spaces path, install/start/quit/update/uninstall giữ dữ liệu.                                                          |

## Trạng thái tự động hóa UI (2026-09-14)

Chưa có E2E tự động trong repo (không cài Playwright). Lượt M1 đã kiểm chứng thủ công bằng headless Chrome qua CDP trên Linux: cổng PIN hiện khi `pinRequired`, sai PIN hiện lỗi và không lưu token, đúng PIN đóng cổng và liệt kê được file đã stage, không có lỗi console; bốn view render được với danh tính do server cấp. Kết quả này không thay thế test trên điện thoại thật.

## Browser và thiết bị thật — chưa tự động hóa

Trước release: host Windows + client Android Chrome + iOS Safari; sau đó host Ubuntu. Gửi từ A và xác nhận B không nhận popup; gọi decision bằng B trả 403; host duyệt từng file; thử batch ≥4, mất mạng, tắt màn hình, đóng/mở tab, hết dung lượng. Ghi OS/browser/version, kích thước, checksum, thời gian, peak RAM/temp disk. Không tuyên bố throughput Wi-Fi tối đa từ một unit test.

## Hợp đồng agent và reviewer

1. Agent implement lấy ID, mô tả triệu chứng bằng fixture nhỏ, chỉ sửa file đã nhận.
2. Với hành vi quan trọng, test đi qua interface mà người dùng sử dụng; tránh test sao chép logic hoặc mock mất lỗi.
3. Reviewer đọc cả các điều kiện từ chối, sự kiện WS và side effect đĩa; chạy negative test riêng nếu auth/state đổi.
4. Agent tích hợp chạy quality trên trạng thái cuối cùng, kiểm tra diff, cập nhật roadmap.
5. Bàn giao chứa bằng chứng; test chưa chạy phải ghi rõ. Không commit/push/release nếu chưa được yêu cầu.

## Release gates tương lai

P0 = 0; P1 liên quan mất dữ liệu = 0; checksum multi-GB đúng; recovery và quota pass; browser E2E và máy sạch cả hai OS pass. Dependency advisory review có ngày và phiên bản cụ thể. Thử rollback/update không mất file. Artifact có SHA-256, giấy phép/SBOM, release notes và provenance. Không để private host URL trong CI artifact hoặc log được công bố.
