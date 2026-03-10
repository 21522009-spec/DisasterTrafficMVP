/* global maplibregl, io */
const statusEl = document.getElementById("status");
const toastEl = document.getElementById("toast");

const toggleUSGS = document.getElementById("toggle-usgs");
const toggleEONET = document.getElementById("toggle-eonet");
const toggleReports = document.getElementById("toggle-reports");
const toggleTraffic = document.getElementById("toggle-traffic");

const btnRefresh = document.getElementById("btn-refresh");
const btnAddReport = document.getElementById("btn-add-report");

const btnSubscribe = document.getElementById("btn-subscribe");
const btnClearSubscribe = document.getElementById("btn-clear-subscribe");
const subStatusEl = document.getElementById("sub-status");

let subscribeMode = false;
let subscribePoints = []; // [ [lon,lat], [lon,lat] ]
let subscribedBbox = loadSubscribedBbox(); // {minLon,minLat,maxLon,maxLat}

function setStatus(msg) { statusEl.textContent = msg; }
function showToast(msg, ms = 5000) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.add("hidden"), ms);
}

function loadSubscribedBbox() {
  try { return JSON.parse(localStorage.getItem("sub_bbox") || "null"); } catch { return null; }
}
function saveSubscribedBbox(bbox) {
  if (!bbox) localStorage.removeItem("sub_bbox");
  else localStorage.setItem("sub_bbox", JSON.stringify(bbox));
}
function bboxFromTwoPoints(a, b) {
  const minLon = Math.min(a[0], b[0]);
  const maxLon = Math.max(a[0], b[0]);
  const minLat = Math.min(a[1], b[1]);
  const maxLat = Math.max(a[1], b[1]);
  return { minLon, minLat, maxLon, maxLat };
}
function withinBbox(lon, lat, bbox) {
  if (!bbox) return false;
  return lon >= bbox.minLon && lon <= bbox.maxLon && lat >= bbox.minLat && lat <= bbox.maxLat;
}

function updateSubStatus() {
  if (!subscribedBbox) subStatusEl.textContent = "Not subscribed.";
  else subStatusEl.textContent = `Subscribed bbox: [${subscribedBbox.minLon.toFixed(3)}, ${subscribedBbox.minLat.toFixed(3)}] → [${subscribedBbox.maxLon.toFixed(3)}, ${subscribedBbox.maxLat.toFixed(3)}]`;
}
updateSubStatus();

// --- Map init (MapLibre + OSM raster style)
const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      "osm-raster": {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 19,
        attribution: "© OpenStreetMap contributors",
      },
    },
    layers: [
      { id: "osm-raster-layer", type: "raster", source: "osm-raster" },
    ],
    id: "blank",
  },
  center: [106.7, 10.78], // HCMC-ish
  zoom: 5,
});

map.addControl(new maplibregl.NavigationControl(), "top-right");

const emptyFC = { type: "FeatureCollection", features: [] };

let cacheEvents = [];
let cacheReports = [];

function eventsToGeoJSON(srcFilter) {
  const feats = cacheEvents
    .filter(e => srcFilter === "all" ? true : e.source === srcFilter)
    .map(e => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [e.lon, e.lat] },
      properties: {
        id: e.id,
        source: e.source,
        title: e.title,
        url: e.url,
        time: e.time,
        mag: e?.meta?.mag ?? null,
        categories: e?.meta?.categories ? JSON.stringify(e.meta.categories) : "",
      }
    }));
  return { type: "FeatureCollection", features: feats };
}

function reportsToGeoJSON() {
  const feats = cacheReports.map(r => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [r.lon, r.lat] },
    properties: {
      id: r.id,
      type: r.type,
      severity: r.severity,
      description: r.description || "",
      time: r.time,
    }
  }));
  return { type: "FeatureCollection", features: feats };
}

function setLayerVisible(layerId, visible) {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
}

// Optional traffic layer: TomTom raster tiles via backend proxy
function ensureTrafficLayer() {
  if (map.getSource("tomtom-traffic-flow")) return;

  map.addSource("tomtom-traffic-flow", {
    type: "raster",
    tiles: ["/tiles/traffic/flow/light/{z}/{x}/{y}.png"],
    tileSize: 256,
    minzoom: 0,
    maxzoom: 22,
  });
  map.addLayer({
    id: "tomtom-traffic-flow-layer",
    type: "raster",
    source: "tomtom-traffic-flow",
    paint: { "raster-opacity": 0.85 },
  });
  setLayerVisible("tomtom-traffic-flow-layer", false);
}

map.on("load", async () => {
  // Nguồn dữ liệu: tạo trống trước, sẽ cập nhật sau khi fetch
  map.addSource("events-usgs", { type: "geojson", data: emptyFC });
  map.addSource("events-eonet", { type: "geojson", data: emptyFC });
  map.addSource("reports", { type: "geojson", data: emptyFC });

  map.addLayer({
    id: "events-usgs-layer",
    type: "circle",
    source: "events-usgs",
    paint: {
      "circle-radius": [
        "case",
        [">", ["to-number", ["get", "mag"]], 6], 10,
        [">", ["to-number", ["get", "mag"]], 4], 7,
        5
      ],
      "circle-opacity": 0.85,
      "circle-stroke-width": 1,
      "circle-stroke-color": "#111827",
    },
  });

  map.addLayer({
    id: "events-eonet-layer",
    type: "circle",
    source: "events-eonet",
    paint: {
      "circle-radius": 6,
      "circle-opacity": 0.75,
      "circle-stroke-width": 1,
      "circle-stroke-color": "#111827",
    },
  });

  map.addLayer({
    id: "reports-layer",
    type: "circle",
    source: "reports",
    paint: {
      "circle-radius": ["+", 4, ["*", 1.2, ["to-number", ["get", "severity"]]]],
      "circle-opacity": 0.8,
      "circle-stroke-width": 1,
      "circle-stroke-color": "#111827",
    },
  });

  // Các màu cơ bản để dễ phân biệt: USGS xanh dương, EONET hồng, Report xanh lá
  map.setPaintProperty("events-usgs-layer", "circle-color", "#60a5fa");   // xanh dương
  map.setPaintProperty("events-eonet-layer", "circle-color", "#fb7185"); // hồng
  map.setPaintProperty("reports-layer", "circle-color", "#34d399");      // xanh lá

  // Popups
  const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true });

  function onFeatureClick(e, kind) {
    const f = e.features?.[0];
    if (!f) return;
    const p = f.properties || {};
    const time = p.time ? new Date(Number(p.time)).toLocaleString() : "";
    const title = p.title || p.type || kind;

    const desc = p.description ? `<div style="margin-top:6px">${escapeHtml(p.description)}</div>` : "";
    const link = p.url ? `<div style="margin-top:6px"><a href="${p.url}" target="_blank" rel="noreferrer">Open source</a></div>` : "";

    popup
      .setLngLat(e.lngLat)
      .setHTML(`<div style="font-weight:700">${escapeHtml(title)}</div>
                <div style="margin-top:6px"><span class="badge">${kind}</span> <span style="color:#6b7280">${escapeHtml(time)}</span></div>
                ${desc}
                ${link}`)
      .addTo(map);
  }

  map.on("click", "events-usgs-layer", (e) => onFeatureClick(e, "USGS"));
  map.on("click", "events-eonet-layer", (e) => onFeatureClick(e, "EONET"));
  map.on("click", "reports-layer", (e) => onFeatureClick(e, "REPORT"));

  // Chế độ subscribe: người dùng click 2 điểm để tạo bbox, lưu vào localStorage, vẽ lên map, và sẽ được thông báo khi có report mới trong bbox đó.
  map.on("click", (e) => {
    if (!subscribeMode) return;
    subscribePoints.push([e.lngLat.lng, e.lngLat.lat]);
    showToast(`Subscribe: picked ${subscribePoints.length}/2 points`);

    if (subscribePoints.length === 2) {
      subscribedBbox = bboxFromTwoPoints(subscribePoints[0], subscribePoints[1]);
      saveSubscribedBbox(subscribedBbox);
      subscribeMode = false;
      subscribePoints = [];
      updateSubStatus();
      drawSubscribeBbox();
      showToast("Subscribed area saved ✅");
    }
  });

  await refreshAll();
  drawSubscribeBbox();
  setStatus("Ready.");
});

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// --- Subscribe bbox rendering
function drawSubscribeBbox() {
  if (!map.isStyleLoaded()) return;

  const srcId = "sub-bbox";
  const layerId = "sub-bbox-layer";
  if (!subscribedBbox) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(srcId)) map.removeSource(srcId);
    return;
  }

  const b = subscribedBbox;
  const poly = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[
          [b.minLon, b.minLat],
          [b.maxLon, b.minLat],
          [b.maxLon, b.maxLat],
          [b.minLon, b.maxLat],
          [b.minLon, b.minLat],
        ]]
      },
      properties: {}
    }]
  };

  if (!map.getSource(srcId)) map.addSource(srcId, { type: "geojson", data: poly });
  else map.getSource(srcId).setData(poly);

  if (!map.getLayer(layerId)) {
    map.addLayer({
      id: layerId,
      type: "line",
      source: srcId,
      paint: { "line-width": 2, "line-opacity": 0.9, "line-color": "#111827" }
    });
  }
}

// Lấy dữ liệu từ backend, cập nhật cache và map sources. Gọi khi load trang và khi có socket thông báo update.
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function refreshAll() {
  setStatus("Loading…");
  const [evAll, rep] = await Promise.all([
    fetchJSON("/api/events?source=all&limit=800"),
    fetchJSON("/api/reports?limit=800"),
  ]);

  cacheEvents = evAll.events || [];
  cacheReports = rep.reports || [];

  if (map.getSource("events-usgs")) map.getSource("events-usgs").setData(eventsToGeoJSON("usgs"));
  if (map.getSource("events-eonet")) map.getSource("events-eonet").setData(eventsToGeoJSON("eonet"));
  if (map.getSource("reports")) map.getSource("reports").setData(reportsToGeoJSON());

  setStatus(`Events: ${cacheEvents.length} | Reports: ${cacheReports.length}`);
}

btnRefresh.addEventListener("click", () => refreshAll().catch(e => showToast("Refresh error: " + e.message)));

toggleUSGS.addEventListener("change", () => setLayerVisible("events-usgs-layer", toggleUSGS.checked));
toggleEONET.addEventListener("change", () => setLayerVisible("events-eonet-layer", toggleEONET.checked));
toggleReports.addEventListener("change", () => setLayerVisible("reports-layer", toggleReports.checked));

toggleTraffic.addEventListener("change", async () => {
  try {
    ensureTrafficLayer();
    setLayerVisible("tomtom-traffic-flow-layer", toggleTraffic.checked);

    // Trường hợp backend không cấu hình TOMTOM_KEY sẽ trả về tile rỗng, vẫn bật layer nhưng không thấy gì. Cảnh báo người dùng để tránh nhầm tưởng lỗi.
    if (toggleTraffic.checked) {
      // trigger one tile fetch by forcing repaint
      showToast("Traffic ON (nếu chưa set TOMTOM_KEY thì sẽ không hiện).", 5000);
    }
  } catch (e) {
    showToast("Traffic layer error: " + e.message);
    toggleTraffic.checked = false;
  }
});

btnSubscribe.addEventListener("click", () => {
  subscribeMode = true;
  subscribePoints = [];
  showToast("Subscribe mode: click 2 points on map.");
});

btnClearSubscribe.addEventListener("click", () => {
  subscribedBbox = null;
  saveSubscribedBbox(null);
  updateSubStatus();
  drawSubscribeBbox();
  showToast("Subscription cleared.");
});

// --- thêm report mới bằng form modal. Người dùng có thể click vào map để tự động điền tọa độ vào form. Gửi POST lên backend, backend sẽ lưu và broadcast qua socket cho tất cả client đang mở trang.
btnAddReport.addEventListener("click", () => openReportModal());

function openReportModal(prefill) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `
    <h3>Add community report</h3>
    <div class="grid">
      <div>
        <label class="small">Type</label>
        <select id="r-type">
          <option value="traffic_jam">traffic_jam</option>
          <option value="flood">flood</option>
          <option value="landslide">landslide</option>
          <option value="storm">storm</option>
          <option value="fire">fire</option>
          <option value="other">other</option>
        </select>
      </div>
      <div>
        <label class="small">Severity (1-5)</label>
        <input id="r-sev" type="number" min="1" max="5" value="3" />
      </div>
      <div>
        <label class="small">Latitude</label>
        <input id="r-lat" type="number" step="0.000001" placeholder="click map to fill" />
      </div>
      <div>
        <label class="small">Longitude</label>
        <input id="r-lon" type="number" step="0.000001" placeholder="click map to fill" />
      </div>
    </div>
    <div style="margin-top:10px">
      <label class="small">Description</label>
      <textarea id="r-desc" placeholder="Mô tả ngắn (tối đa 300 ký tự)"></textarea>
    </div>
    <div class="actions">
      <button id="r-cancel">Cancel</button>
      <button id="r-submit">Submit</button>
    </div>
  `;

  backdrop.appendChild(modal);
  document.querySelector(".mapwrap").appendChild(backdrop);

  const elType = modal.querySelector("#r-type");
  const elSev = modal.querySelector("#r-sev");
  const elLat = modal.querySelector("#r-lat");
  const elLon = modal.querySelector("#r-lon");
  const elDesc = modal.querySelector("#r-desc");

  if (prefill?.lat != null) elLat.value = String(prefill.lat);
  if (prefill?.lon != null) elLon.value = String(prefill.lon);

  function close() { backdrop.remove(); map.off("click", fillFromMap); }

  function fillFromMap(e) {
    elLat.value = e.lngLat.lat.toFixed(6);
    elLon.value = e.lngLat.lng.toFixed(6);
    showToast("Filled coordinates from map.");
  }

  map.on("click", fillFromMap);

  modal.querySelector("#r-cancel").addEventListener("click", close);

  modal.querySelector("#r-submit").addEventListener("click", async () => {
    const payload = {
      type: elType.value,
      severity: Number(elSev.value),
      lat: Number(elLat.value),
      lon: Number(elLon.value),
      description: elDesc.value,
    };
    try {
      const r = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      close();
      showToast("Report submitted ✅");
      await refreshAll();
    } catch (e) {
      showToast("Submit failed: " + e.message);
    }
  });
}

// --- Socket.IO realtime
const socket = io();
socket.on("hello", (data) => {
  console.log("socket hello", data);
});

socket.on("events:updated", async (info) => {
  await refreshAll();
  showToast(`New ${info.source} events (+${info.inserted})`);
  // Retention: if subscribed bbox matches any new event, notify.
});

socket.on("report:new", async (report) => {
  cacheReports = [report, ...cacheReports].slice(0, 2000);
  if (map.getSource("reports")) map.getSource("reports").setData(reportsToGeoJSON());
  showToast(`New report: ${report.type} (sev ${report.severity})`);

  if (subscribedBbox && withinBbox(report.lon, report.lat, subscribedBbox)) {
    notifyBrowser(`⚠️ Report in your subscribed area: ${report.type}`);
  }
});

// thông báo cho browser khi có report mới trong bbox đã subscribe, nếu được phép. Cần gọi sau khi load trang để request permission nếu chưa có, và gọi mỗi lần có report mới để trigger notification.
async function notifyBrowser(msg) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch {}
  }
  if (Notification.permission === "granted") {
    new Notification("Cảnh báo", { body: msg });
  }
}
