# Trạng thái local

| Trạng thái      | Điều kiện                                                                    |
| --------------- | ---------------------------------------------------------------------------- |
| needs-triage    | Cần xác minh triệu chứng, tác động hoặc phạm vi.                             |
| needs-info      | Thiếu quyết định sản phẩm hoặc môi trường tái hiện; ghi câu hỏi cụ thể.      |
| ready-for-agent | Phạm vi, dependency và tiêu chí pass đã rõ.                                  |
| ready-for-human | Cần thiết bị thật, ký số, quyền release hoặc quyết định của người phụ trách. |
| wontfix         | Có lý do được ghi lại và người dùng đồng ý.                                  |
| in-progress     | Có owner và phạm vi file; chưa qua gates.                                    |
| done            | Acceptance criteria đạt; đính kèm kết quả kiểm chứng và giới hạn.            |

Priority khác status: P0 = truy cập trái phép/mất dữ liệu nghiêm trọng; P1 = core vận hành; P2 = ổn định/UX/hiệu năng; P3 = mở rộng. Không gắn P0 cho mọi khuyết điểm.
