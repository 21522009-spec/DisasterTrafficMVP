import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const EVENTS_FILE = path.join(DATA_DIR, "external_events.json");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");

// small helper to avoid corruption on partial writes
async function writeAtomic(filePath, jsonObj) {
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(jsonObj, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

async function readJson(filePath, fallback) {
  try {
    const s = await fs.readFile(filePath, "utf8");
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

export async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const events = await readJson(EVENTS_FILE, { events: [] });
  const reports = await readJson(REPORTS_FILE, { reports: [] });
  if (!events?.events) await writeAtomic(EVENTS_FILE, { events: [] });
  if (!reports?.reports) await writeAtomic(REPORTS_FILE, { reports: [] });
}

export async function getAll() {
  const events = await readJson(EVENTS_FILE, { events: [] });
  const reports = await readJson(REPORTS_FILE, { reports: [] });
  return {
    externalEvents: events.events || [],
    reports: reports.reports || [],
  };
}

export async function upsertExternalEvents(incoming) {
  const cur = await readJson(EVENTS_FILE, { events: [] });
  const map = new Map((cur.events || []).map(e => [e.id, e]));

  let inserted = 0;
  for (const e of incoming) {
    if (!map.has(e.id)) inserted++;
    map.set(e.id, e);
  }

  const merged = Array.from(map.values());
  await writeAtomic(EVENTS_FILE, { events: merged });
  return { inserted, total: merged.length };
}

export async function addReport({ type, severity, description, lat, lon }) {
  const cur = await readJson(REPORTS_FILE, { reports: [] });
  const now = Date.now();

  const report = {
    id: "r_" + crypto.randomBytes(8).toString("hex"),
    type,
    severity,
    description,
    lat,
    lon,
    time: now,
  };

  const arr = cur.reports || [];
  arr.push(report);

  // simple retention: cap to last 2000
  arr.sort((a, b) => b.time - a.time);
  const capped = arr.slice(0, 2000);

  await writeAtomic(REPORTS_FILE, { reports: capped });
  return report;
}
