# Claude Usage & Net Speed Widget (Windows 10/11)

Widget nhỏ, không viền, nằm trên nền desktop, hiển thị:

| Khối | Nội dung | Nguồn dữ liệu | Chu kỳ |
|---|---|---|---|
| Giới hạn gói Pro/Max | % phiên 5 giờ, % tuần (tất cả model, Opus, Sonnet nếu có), giờ reset và thời gian còn lại | Endpoint OAuth mà Claude Code dùng cho lệnh `/usage` | 120 giây |
| Claude Code | Token hôm nay, số lượt, token output, token 5 giờ qua, phân theo Opus/Sonnet/Haiku | Log cục bộ `%USERPROFILE%\.claude\projects\**\*.jsonl` | 30 giây |
| Internet | Tốc độ ↓ download / ↑ upload (đơn vị kB/s, 1 kB = 1000 byte) + biểu đồ 60 giây | `psutil` (bộ đếm byte của card mạng) | 1 giây |

Thanh % đổi màu: xanh < 60%, vàng 60–85%, đỏ ≥ 85%.

## Yêu cầu
1. Python 3.9+ cho Windows (https://www.python.org/downloads/windows/), khi cài tích **Add python.exe to PATH**.
2. **Claude Code CLI** đã đăng nhập bằng tài khoản Pro/Max: chạy `login.bat`: tự tìm Claude Code (kể cả bản kèm trong Claude Desktop bản thường hoặc Microsoft Store), nếu không có thì cài bằng trình cài chính thức, rồi chạy `claude auth login --claudeai`. Lưu ý: dùng Claude Code bên trong ứng dụng Claude Desktop/Cowork **không** lưu token cho widget; phải đăng nhập CLI một lần. Khi token hết hạn, widget tự gọi ẩn `claude auth status` để Claude Code làm mới (tối đa 1 lần/10 phút). Widget tự tìm token theo thứ tự: **Windows Credential Manager** (nơi Claude Code bản mới lưu, mục `Claude Code-credentials`), sau đó file `%USERPROFILE%\.claude\.credentials.json` (bản cũ).

## Cài đặt
1. Tải thư mục `desktop-widget` về máy (ví dụ `D:\Tools\desktop-widget`).
2. Nhấp đúp `install.bat`: cài `psutil`, bật tự khởi động cùng Windows, chạy widget.
3. Kéo thả widget đến vị trí mong muốn; vị trí được lưu lại.

Chạy thủ công: `run_widget.bat`. Gỡ tự khởi động: `uninstall.bat`.

Nếu widget báo không tìm thấy token: chạy `diagnose.bat`. Công cụ liệt kê các mục Claude trong Credential Manager, in **cấu trúc** file credentials (chỉ tên khóa, kiểu, độ dài; đã che toàn bộ giá trị) và thử gọi API. Kết quả an toàn để chụp gửi hỗ trợ.

## Thao tác
- Kéo chuột trái: di chuyển widget.
- Chuột phải: Làm mới ngay, Luôn nổi trên cùng, Độ trong suốt (100/92/80/65%), Thoát.
- Cấu hình lưu tại `%APPDATA%\ClaudeWidget\config.json`.

## Đóng gói thành .exe (tùy chọn)
Chạy `build_exe.bat` → `dist\ClaudeWidget.exe` (không cần Python trên máy đích). Để tự khởi động bản exe: Win+R → `shell:startup` → tạo shortcut tới file exe trong thư mục đó.

## Hiển thị sắc nét
Widget khai báo Per-Monitor DPI Aware với Windows và tự nhân kích thước theo hệ số Scale (125%, 150%, 200%…), nên chữ và nét vẽ không bị Windows phóng ảnh gây mờ/rỗ.

## Lưu ý quan trọng
- Endpoint `api.anthropic.com/api/oauth/usage` **không phải API công khai có tài liệu**; Anthropic có thể thay đổi bất kỳ lúc nào. Khi đó khối giới hạn gói sẽ báo lỗi, hai khối còn lại vẫn chạy.
- Widget **chỉ đọc** token, không tự làm mới (để tránh làm hỏng phiên đăng nhập của Claude Code). Nếu báo "Token hết hạn", chỉ cần mở Claude Code một lần.
- Usage trên claude.ai (web/desktop app) và Claude Code dùng chung hạn mức gói, nên % giới hạn phản ánh tổng. Khối "Claude Code" chỉ đếm token từ log của chính máy này.
- Tốc độ mạng là tổng các card vật lý; đã loại loopback, Hyper-V (vEthernet), VMware, VirtualBox, Docker, WSL, Bluetooth. Sửa `EXCLUDED_NIC_PREFIX` trong `claude_widget.py` nếu cần.
- Token chỉ được gửi tới `api.anthropic.com`, không đi đâu khác.
