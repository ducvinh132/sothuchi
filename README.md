# Sổ Thu Chi (PWA) – quản lý chi tiêu cá nhân

Web app chạy offline, cài lên Màn hình chính iPhone như app thật. Dữ liệu lưu ngay trong iPhone (IndexedDB), không gửi đi đâu.

## Đưa lên GitHub Pages (làm trên trình duyệt, không cần Xcode)
1. Giải nén file zip. Vào github.com > New repository. Đặt tên (VD: `sothuchi`), chọn **Public** (gói miễn phí chỉ bật Pages cho repo public), bấm Create.
2. Trong repo vừa tạo: "uploading an existing file". Kéo thả TOÀN BỘ nội dung thư mục (index.html, sw.js, manifest.webmanifest, README.md và 3 thư mục css, js, icons) vào, rồi bấm Commit changes.
3. Settings > Pages > Build and deployment > Source: "Deploy from a branch" > Branch: `main`, thư mục `/ (root)` > Save.
4. Chờ 1–2 phút, địa chỉ app là: `https://<tên-github-của-bạn>.github.io/sothuchi/`

## Cài lên iPhone
1. Mở địa chỉ trên bằng **Safari** (không dùng Chrome).
2. Nút Chia sẻ > "Thêm vào Màn hình chính" > Thêm.
3. Từ đây **luôn mở app bằng biểu tượng trên Màn hình chính**. Không nhập dữ liệu trong tab Safari: iOS tách riêng kho dữ liệu của tab Safari và của app trên Màn hình chính.
4. Vào Khác > Cài đặt để đặt mã PIN, tiền tệ, tỷ giá.

## Sao lưu (rất quan trọng)
Dữ liệu chỉ nằm trên iPhone. Xóa app hoặc xóa dữ liệu website thì mất. Vào Khác > Sao lưu / Nhập CSV > "Sao lưu đầy đủ (JSON)", chọn "Lưu vào Tệp" (iCloud Drive). Nên làm mỗi tuần. App sẽ nhắc sau 14 ngày.

## Cập nhật phiên bản
Thay các file mới trong repo, và đổi số phiên bản `CACHE` ở đầu file `sw.js` (VD `sothuchi-v2`) để iPhone tải bản mới.

## Ghi chú
- Mã PIN chỉ khóa giao diện, không mã hóa dữ liệu. Quên PIN thì phải xóa dữ liệu và khôi phục từ file JSON.
- CSV tương thích với bản iOS native (cùng định dạng cột).
