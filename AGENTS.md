# UniversalTrans — hướng dẫn agent

Đọc theo thứ tự: `CONTEXT.md` → `REPORT-ROADMAP.md` → `docs/agents/quality.md` → ADR liên quan trong `docs/adr/`.

## Agent skills

### Issue tracker

Backlog hiện nằm trong `REPORT-ROADMAP.md`; dùng ID UT-xxx. Xem `docs/agents/issue-tracker.md`. Không tự tạo issue/PR hoặc push bên ngoài chỉ vì nhận nhiệm vụ sửa local.

### Triage labels

Dùng trạng thái local trong `docs/agents/triage-labels.md`. Không ngụ ý label đã được tạo trên GitHub.

### Domain docs

Single-context: `CONTEXT.md` và `docs/adr/`. Xem `docs/agents/domain.md`.

## Quy tắc thi công

- Chọn một ID, đọc acceptance criteria và dependency trước khi sửa. Ghi phạm vi file và điều kiện pass.
- Đối với lỗi: tạo kiểm thử hồi quy tại interface thực tế; ghi bằng chứng trước/sau. Không chỉ test bản sao của logic production.
- Không coi client `isHost`, tên thiết bị, OS, IP gửi trong payload hoặc `X-Forwarded-For` là quyền host.
- `upload:request` và danh sách pending chỉ tới host đã xác thực; accept/decline phải bị chặn từ server trước mọi thay đổi đĩa.
- Không truyền khóa host vào QR, API info, metadata thiết bị hoặc broadcast. Không lưu khóa trong Git hay báo cáo test.
- File nguồn được chia sẻ và file tạm do app tạo là hai loại ownership khác nhau: unshare không được xóa file nguồn.
- Dữ liệu test phải nằm trong thư mục tạm riêng. Không dùng Downloads thật làm fixture hoặc xóa thư mục chung của user.
- Không giảm coverage, bỏ test, thêm skip hoặc nuốt lỗi để làm CI xanh.
- Chạy `npm run quality` trước bàn giao. Không báo Linux/browser/device đã kiểm thử nếu chỉ chạy Node trên Windows.
- Giữ thay đổi của user; không reset/clean worktree. Không cài shortcut hoặc chạy script kill port khi kiểm thử.
- Agent được giao việc chỉ sửa phạm vi thống nhất; nếu chạy song song, mỗi agent cần ownership file riêng, báo xung đột cho agent chính. Tài liệu này không tự yêu cầu spawn agent.
- Bàn giao: ID, thay đổi hành vi, file, test + kết quả, giới hạn chưa kiểm chứng, trạng thái backlog.

## Definition of Done

Theo `docs/agents/quality.md`. Build/package không đồng nghĩa release; artifact Windows/Linux cần smoke test trên OS tương ứng và được người dùng cho phép trước khi xuất bản.
