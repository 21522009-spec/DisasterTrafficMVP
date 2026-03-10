import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { ensureStore, getAll, upsertExternalEvents, addReport } from "./store.js";

dotenv.config();

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

// 
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function isFiniteNumber(x) { return typeof x === "number" && Number.isFinite(x); }

function normalizeBboxQuery(q) {
  // bbox=minLon,minLat,maxLon,maxLat
  if (!q) return null;
  const parts = String(q).split(",").map(s => parseFloat(s.trim()));
  if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) return null;
  const [minLon, minLat, maxLon, maxLat] = parts;
  return {
    minLon: clamp(minLon, -180, 180),
    minLat: clamp(minLat, -85, 85),
    maxLon: clamp(maxLon, -180, 180),
    maxLat: clamp(maxLat, -85, 85),
  };
}

function withinBbox(lon, lat, bbox) {
  if (!bbox) return true;
  return lon >= bbox.minLon && lon <= bbox.maxLon && lat >= bbox.minLat && lat <= bbox.maxLat;
}

// API
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, serverTime: new Date().toISOString() });
});

app.get("/api/events", async (req, res) => {
  const source = (req.query.source || "all").toString(); // usgs | eonet | all
  const bbox = normalizeBboxQuery(req.query.bbox);
  const max = clamp(parseInt(req.query.limit || "200", 10), 1, 2000);

  const all = await getAll();

  const filtered = all.externalEvents
    .filter(e => (source === "all" ? true : e.source === source))
    .filter(e => withinBbox(e.lon, e.lat, bbox))
    .sort((a, b) => b.time - a.time)
    .slice(0, max);

  res.json({ events: filtered });
});

app.get("/api/reports", async (req, res) => {
  const bbox = normalizeBboxQuery(req.query.bbox);
  const max = clamp(parseInt(req.query.limit || "200", 10), 1, 2000);
  const all = await getAll();

  const filtered = all.reports
    .filter(r => withinBbox(r.lon, r.lat, bbox))
    .sort((a, b) => b.time - a.time)
    .slice(0, max);

  res.json({ reports: filtered });
});

app.post("/api/reports", async (req, res) => {
  const { type, severity, description, lat, lon } = req.body || {};
  const allowed = new Set(["traffic_jam", "flood", "landslide", "storm", "fire", "other"]);

  if (!allowed.has(type)) return res.status(400).json({ error: "Invalid type" });
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) return res.status(400).json({ error: "Invalid coordinates" });

  const sev = clamp(parseInt(severity ?? 3, 10), 1, 5);
  const desc = typeof description === "string" ? description.slice(0, 300) : "";

  const report = await addReport({
    type,
    severity: sev,
    description: desc,
    lat: clamp(lat, -85, 85),
    lon: clamp(lon, -180, 180),
  });

  // phát hiện báo cáo mới đến tất cả các client đã kết nối qua Socket.IO
  io.emit("report:new", report);

  res.status(201).json({ report });
});

// --- Optional: proxy TomTom traffic tiles (to avoid exposing key in client)
app.get("/tiles/traffic/flow/:style/:z/:x/:y.png", async (req, res) => {
  if (!TOMTOM_KEY) return res.status(400).send("TOMTOM_KEY not configured");
  const { style, z, x, y } = req.params;

  // TomTom Orbis Maps - Raster Flow Tiles (Traffic Flow):
  // https://api.tomtom.com/maps/orbis/traffic/tile/flow/{zoom}/{x}/{y}.png?apiVersion=1&key=...&style=light&tileSize=256
  const url = new URL(`https://api.tomtom.com/maps/orbis/traffic/tile/flow/${z}/${x}/${y}.png`);
  url.searchParams.set("apiVersion", "1");
  url.searchParams.set("key", TOMTOM_KEY);
  url.searchParams.set("style", style);
  url.searchParams.set("tileSize", "256");

  const r = await fetch(url, { headers: { "User-Agent": "DisasterTrafficMVP/0.1 (+seminar)" } });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return res.status(r.status).send(txt || "TomTom error");
  }

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=30"); // short cache
  const buf = Buffer.from(await r.arrayBuffer());
  res.send(buf);
});

//Socket.IO thời gian thực
io.on("connection", async (socket) => {
  socket.emit("hello", { msg: "connected", serverTime: Date.now() });
});

// Ingest jobs
async function ingestUSGS() {
  // Thông báo động đất trong những ngày gần đây sử dụng API của USGS (United States Geological Survey)
  const url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson";
  const r = await fetch(url, { headers: { "User-Agent": "DisasterTrafficMVP/0.1 (+seminar)" } });
  if (!r.ok) throw new Error(`USGS fetch failed: ${r.status}`);
  const data = await r.json();
  const events = (data.features || [])
    .map(f => {
      const [lon, lat, depth] = f.geometry?.coordinates || [];
      const p = f.properties || {};
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      return {
        id: `usgs:${f.id}`,
        source: "usgs",
        title: p.title || "Earthquake",
        url: p.url || "",
        time: typeof p.time === "number" ? p.time : Date.now(),
        lon, lat,
        meta: { mag: p.mag, place: p.place, depth, tsunami: p.tsunami, type: p.type },
      };
    })
    .filter(Boolean);

  const { inserted } = await upsertExternalEvents(events);
  if (inserted > 0) io.emit("events:updated", { source: "usgs", inserted });
}

async function ingestEONET() {
  // NASA EONET v3: list open events
  const url = new URL("https://eonet.gsfc.nasa.gov/api/v3/events");
  url.searchParams.set("status", "open");
  url.searchParams.set("limit", "50");
  const r = await fetch(url, { headers: { "User-Agent": "DisasterTrafficMVP/0.1 (+seminar)" } });
  if (!r.ok) throw new Error(`EONET fetch failed: ${r.status}`);
  const data = await r.json();

  const events = (data.events || [])
    .map(e => {
      // Geometry can be Point or Polygon. For MVP: pick first Point if exists; else bbox center.
      const geoms = e.geometry || [];
      let chosen = null;

      for (const g of geoms) {
        if (g.type === "Point" && Array.isArray(g.coordinates)) {
          const [lon, lat] = g.coordinates;
          if (Number.isFinite(lon) && Number.isFinite(lat)) { chosen = { lon, lat, date: g.date }; break; }
        }
      }
      if (!chosen && geoms.length && geoms[0]?.type === "Polygon" && Array.isArray(geoms[0].coordinates)) {
        const ring = geoms[0].coordinates?.[0] || [];
        const lons = ring.map(p => p?.[0]).filter(Number.isFinite);
        const lats = ring.map(p => p?.[1]).filter(Number.isFinite);
        if (lons.length && lats.length) {
          const lon = (Math.min(...lons) + Math.max(...lons)) / 2;
          const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
          chosen = { lon, lat, date: geoms[0].date };
        }
      }
      if (!chosen) return null;

      const t = chosen.date ? Date.parse(chosen.date) : Date.now();

      return {
        id: `eonet:${e.id}`,
        source: "eonet",
        title: e.title || "EONET event",
        url: e.link || "",
        time: Number.isFinite(t) ? t : Date.now(),
        lon: chosen.lon,
        lat: chosen.lat,
        meta: {
          categories: (e.categories || []).map(c => ({ id: c.id, title: c.title })),
          sources: e.sources || [],
          closed: e.closed || null,
        },
      };
    })
    .filter(Boolean);

  const { inserted } = await upsertExternalEvents(events);
  if (inserted > 0) io.emit("events:updated", { source: "eonet", inserted });
}

async function ingestAllOnce() {
  try { await ingestUSGS(); } catch (e) { console.error("[USGS]", e.message); }
  try { await ingestEONET(); } catch (e) { console.error("[EONET]", e.message); }
}

await ensureStore();
await ingestAllOnce();

// info lấy từ USGS được reset mỗi 60 giây.
setInterval(ingestUSGS, 60_000);
// EONET chậm hơn, lấy tạm 5 phút một lần vì ít thay đổi hơn.
setInterval(ingestEONET, 300_000);

server.listen(PORT, () => {
  console.log(`Server chạy thành công,link truy cập: http://localhost:${PORT}`);
});
