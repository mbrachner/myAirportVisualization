import { fetchOverpass, parseOverpass } from "./osm.js";

const SNAPSHOT_URL = "./data/engm-osm.json";
const CACHE_KEY = "engm-osm-cache-v1";
const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return undefined;
    const cached = JSON.parse(raw);
    if (Date.now() - cached.savedAt > CACHE_MAX_AGE_MS) return undefined;
    return cached.json;
  } catch {
    return undefined;
  }
}

function writeCache(json) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), json }));
  } catch {
    // Quota exceeded or storage blocked: caching is only a convenience.
  }
}

/**
 * Load airport data. Order: bundled snapshot (npm run fetch-osm) -> browser cache -> live Overpass.
 * Pass { live: true } to skip the snapshot and cache.
 */
export async function loadAirportData({ live = false } = {}) {
  if (!live) {
    // __HAS_OSM_SNAPSHOT__ is set at build time (vite.config.js), so we don't request a missing file.
    if (__HAS_OSM_SNAPSHOT__) {
      try {
        const res = await fetch(SNAPSHOT_URL);
        if (res.ok && res.headers.get("content-type")?.includes("json")) {
          const json = await res.json();
          return { layers: parseOverpass(json), source: `snapshot (${json.fetched?.slice(0, 10) ?? "unknown date"})` };
        }
      } catch {
        // Snapshot unreadable; fall through.
      }
    }
    const cached = readCache();
    if (cached) return { layers: parseOverpass(cached), source: "browser cache" };
  }
  const json = await fetchOverpass();
  writeCache(json);
  return { layers: parseOverpass(json), source: "live OpenStreetMap (Overpass)" };
}
