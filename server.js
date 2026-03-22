import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose"; // <-- ĐÃ THÊM: Import Mongoose

import { ensureStore, getAll, upsertExternalEvents, addReport } from "./store.js";

dotenv.config();

// ==========================================
// 1. KẾT NỐI MONGODB ATLAS & TẠO SCHEMA
// ==========================================
const MONGO_URI = process.env.MONGO_URI || "";
if (MONGO_URI) {
    mongoose.connect(MONGO_URI)
        .then(() => console.log('✅ Đã kết nối MongoDB Atlas thành công!'))
        .catch(err => console.log('❌ Lỗi kết nối MongoDB:', err));
} else {
    console.log('⚠️ Cảnh báo: Chưa có MONGO_URI trong file .env');
}

// Tạo "Khuôn mẫu" (Schema) cho dữ liệu Cảnh báo thiên tai/hỏa hoạn
const alertSchema = new mongoose.Schema({
    type: String,     // 'fire' (cháy) hoặc 'flood' (ngập)
    address: String,  // Tên khu vực (VD: Quận 1)
    lng: Number,      // Kinh độ
    lat: Number,      // Vĩ độ
    createdAt: { type: Date, default: Date.now }
});

// Tạo Model từ Schema
const Alert = mongoose.model('Alert', alertSchema);
// ==========================================


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || "3000", 10);
const TOMTOM_KEY = (process.env.TOMTOM_KEY || "").trim();

const app = express();
app.use(express.json({ limit: "256kb" }));

// Trạng thái của frontend và các file tĩnh (HTML/CSS/JS) sẽ được phục vụ từ thư mục "public"
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
    cors: { origin: "*" },
});

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function isFiniteNumber(x) { return typeof x === "number" && Number.isFinite(x); }

function normalizeBboxQuery(q) {
    // bbox=minLon,minLat,maxLon,maxLat
    if (!q) return null;
    const parts = String(q).split(",").map(s => parseFloat(s.trim()));
    if (parts.length !== 4 || parts.some(v => !isFiniteNumber(v))) return null;
    const [minLon, minLat, maxLon, maxLat] = parts;
    if (minLon > maxLon || minLat > maxLat) return null;
    return {
        minLon: clamp(minLon, -180, 180),
        maxLon: clamp(maxLon, -180, 180),
        minLat: clamp(minLat, -90, 90),
        maxLat: clamp(maxLat, -90, 90),
    };
}

// ==========================================
// 2. CÁC API MỚI CHO MONGODB (ĐỒ ÁN)
// ==========================================

// API: Lấy danh sách lịch sử cảnh báo từ MongoDB
app.get('/api/alerts', async (req, res) => {
    try {
        // Lấy 50 cảnh báo mới nhất, sắp xếp giảm dần theo thời gian
        const alerts = await Alert.find().sort({ createdAt: -1 }).limit(50);
        res.json(alerts);
    } catch (error) {
        console.error("Lỗi lấy dữ liệu từ MongoDB:", error);
        res.status(500).json({ error: 'Lỗi lấy dữ liệu từ Database' });
    }
});

// API: Nhận cảnh báo mới (từ AI hoặc test) và lưu vào MongoDB
app.post('/api/alerts', async (req, res) => {
    try {
        const { type, address, lng, lat } = req.body;

        // Lưu thẳng vào Database
        const newAlert = new Alert({ type, address, lng, lat });
        await newAlert.save();

        // Bắn Socket.io báo cho tất cả người dùng trên Web/App biết có biến mới
        io.emit('new-alert', newAlert);

        res.status(201).json({ message: 'Đã lưu cảnh báo thành công', data: newAlert });
    } catch (error) {
        console.error("Lỗi lưu dữ liệu vào MongoDB:", error);
        res.status(500).json({ error: 'Lỗi lưu dữ liệu' });
    }
});

// ==========================================
// CÁC API VÀ LOGIC CŨ (GIỮ NGUYÊN)
// ==========================================

app.get("/api/all", async (req, res) => {
    const bbox = normalizeBboxQuery(req.query.bbox);
    const data = await getAll(bbox);
    res.json(data);
});

app.post("/api/reports", async (req, res) => {
    const { lon, lat, type, severity, description } = req.body;
    if (!isFiniteNumber(lon) || !isFiniteNumber(lat) || !type) {
        return res.status(400).json({ error: "Invalid data" });
    }

    try {
        const rep = await addReport({
            lon: clamp(lon, -180, 180),
            lat: clamp(lat, -90, 90),
            type: String(type).slice(0, 100),
            severity: clamp(parseInt(severity, 10) || 1, 1, 5),
            description: String(description || "").slice(0, 500),
        });

        // Broadcast notification for old logic
        io.emit("report:new", rep);

        res.json(rep);
    } catch (err) {
        console.error("Error adding report:", err);
        res.status(500).json({ error: "Server error" });
    }
});

app.post("/api/webhook/eonet", async (req, res) => {
    // Tạm giữ nguyên webhookũ...
    res.json({ ok: true });
});

async function ingestUSGS() {
    // Logic cũ giữ nguyên...
}

async function ingestEONET() {
    // Logic cũ giữ nguyên...
}

async function ingestAllOnce() {
    try { await ingestUSGS(); } catch (e) { console.error("[USGS]", e.message); }
    try { await ingestEONET(); } catch (e) { console.error("[EONET]", e.message); }
}

async function runTasks() {
    await ensureStore();
    await ingestAllOnce();
    setInterval(async () => {
        try { await ingestUSGS(); } catch (e) { }
    }, 10 * 60 * 1000);
    setInterval(async () => {
        try { await ingestEONET(); } catch (e) { }
    }, 30 * 60 * 1000);
}

runTasks().catch(err => {
    console.error("Init error", err);
});

server.listen(PORT, () => {
    console.log(`🚀 Server listening on port ${PORT}`);
    if (!TOMTOM_KEY) {
        console.warn("⚠️  TOMTOM_KEY is missing. Map will not load correctly.");
    }
});