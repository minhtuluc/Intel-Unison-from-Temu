# Backlog local

Nguồn sự thật: `REPORT-ROADMAP.md`, ID UT-001… Mọi task phải dẫn ID, dependency, acceptance criteria và trạng thái.

Git remote là GitHub nhưng chưa tạo issue online. Được phép chia task chi tiết vào `docs/tasks/UT-xxx.md` khi cần; giữ roadmap là index. Không tạo hai nguồn trạng thái khác nhau. Không đánh dấu done chỉ vì có code hoặc unit test; ghi phạm vi đã kiểm chứng.

Template task:

```markdown
# UT-xxx — tên

Status: ready-for-agent
Depends on:
Owner / file ownership:
Problem and evidence:
In scope / out of scope:
Acceptance criteria:
Regression scenario:
Verification commands and actual results:
Remaining risks and handoff:
```
