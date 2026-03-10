# Disaster + Traffic Alert MVP (Node.js + MapLibre + Socket.IO)

Mục tiêu: MVP website hiển thị **cảnh báo thiên tai** (USGS Earthquakes + NASA EONET) + **báo cáo kẹt đường cộng đồng** (crowdsourced), và **realtime** cập nhật cho tất cả người xem.

> Lưu ý: Layer **Traffic Flow** (giống Google Maps) cần API key bên thứ 3 (ví dụ TomTom). MVP này hỗ trợ **tùy chọn**.

---

## 1) Yêu cầu môi trường

- Node.js >= 18 (khuyến nghị 20+)
- Windows / macOS / Linux đều chạy được

## 2) Chạy nhanh

```bash
cd DisasterTrafficMVP
npm install
npm run dev
```

Mở: http://localhost:3000

## 3) Bật lớp Traffic (tuỳ chọn)

1. Tạo tài khoản và lấy API key tại TomTom Developer.
2. Tạo file `.env` (cùng cấp với `server.js`) dựa trên `.env.example`:

```bash
TOMTOM_KEY=YOUR_KEY_HERE
PORT=3000
```

Bật toggle **Traffic Flow** trên web.

## 4) Demo luồng nghiệp vụ cốt lõi (Seminar)

1. Người dùng mở map -> thấy các điểm sự kiện thiên tai.
2. Người dùng bật/tắt layer (Earthquakes / EONET / Reports / Traffic).
3. Người dùng bấm **Add report** -> click lên map -> gửi báo cáo kẹt đường/lũ/sạt lở...
4. Tất cả client đang mở trang sẽ thấy report mới realtime.

## 5) Cấu trúc thư mục

- `server.js` : Express + API + Socket.IO + job ingest dữ liệu
- `store.js` : lưu dữ liệu JSON đơn giản (MVP)
- `public/` : frontend tĩnh (MapLibre)
- `docs/` : nội dung seminar + sơ đồ (Mermaid)

## 6) Gợi ý khi chuyển sang production

- Thay OSM public tiles bằng provider có SLA (MapTiler/Mapbox) hoặc self-host tiles.
- Thay JSON store bằng PostgreSQL + PostGIS (đã có đề xuất schema ở `docs/DB_SCHEMA.sql`).
- Thêm auth, rate-limit, moderation cho report.

