// Live ADS-B traffic: providers, fetching and parsing. No Cesium dependency (unit-tested in Node).
//
// All supported providers return the readsb / tar1090 "v2" JSON format:
//   { now, ac: [{ hex, flight, lat, lon, alt_baro, alt_geom, gs, track, baro_rate, ... }] }

export const FT = 0.3048;
export const KT = 0.514444;

/**
 * Endpoint templates. `{lat}`, `{lon}` and `{radius}` (nautical miles) are filled in.
 * Browsers may block direct calls to the public APIs (CORS); in that case configure a proxy
 * (VITE_ADSB_PROXY_URL, see proxy/README.md) or use `npm run dev`, which proxies them locally.
 */
export const PUBLIC_PROVIDERS = [
  { name: "adsb.lol", url: "https://api.adsb.lol/v2/point/{lat}/{lon}/{radius}" },
  { name: "airplanes.live", url: "https://api.airplanes.live/v2/point/{lat}/{lon}/{radius}" },
  { name: "adsb.fi", url: "https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{radius}" },
];

/** Same providers through the Vite dev-server proxy (see vite.config.js). */
export const DEV_PROVIDERS = [
  { name: "adsb.lol (dev proxy)", url: "/adsb-dev/adsblol/v2/point/{lat}/{lon}/{radius}" },
  { name: "airplanes.live (dev proxy)", url: "/adsb-dev/airplaneslive/v2/point/{lat}/{lon}/{radius}" },
];

export function providerList({ proxyUrl, dev } = {}) {
  const list = [];
  if (proxyUrl) list.push({ name: "ADS-B proxy", url: proxyUrl.replace(/\/+$/, "") + "/point/{lat}/{lon}/{radius}" });
  if (dev) list.push(...DEV_PROVIDERS);
  list.push(...PUBLIC_PROVIDERS);
  return list;
}

export const fillUrl = (template, { lat, lon, radius }) =>
  template.replace("{lat}", lat.toFixed(4)).replace("{lon}", lon.toFixed(4)).replace("{radius}", String(Math.round(radius)));

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Normalise one readsb aircraft record. Returns undefined for records without a position. */
export function parseAircraft(a, nowMs = Date.now()) {
  const lat = num(a.lat) ?? num(a.lastPosition?.lat);
  const lon = num(a.lon) ?? num(a.lastPosition?.lon);
  if (lat === undefined || lon === undefined || !a.hex) return undefined;
  const onGround = a.alt_baro === "ground" || a.ground === true;
  const seenPos = num(a.seen_pos) ?? num(a.lastPosition?.seen_pos) ?? num(a.seen) ?? 0;
  return {
    hex: String(a.hex).toLowerCase(),
    callsign: typeof a.flight === "string" ? a.flight.trim() : "",
    registration: a.r ?? "",
    type: a.t ?? "",
    description: a.desc ?? "",
    category: a.category ?? "",
    lat,
    lon,
    onGround,
    altBaroFt: onGround ? undefined : num(a.alt_baro),
    altGeomFt: onGround ? undefined : num(a.alt_geom),
    groundSpeedKt: num(a.gs),
    trackDeg: num(a.track) ?? num(a.true_heading) ?? num(a.mag_heading),
    verticalRateFpm: num(a.geom_rate) ?? num(a.baro_rate),
    squawk: a.squawk ?? "",
    emergency: a.emergency && a.emergency !== "none" ? a.emergency : "",
    observedAt: nowMs - seenPos * 1000,
  };
}

export function parseResponse(json, nowMs = Date.now()) {
  const list = json?.ac ?? json?.aircraft ?? [];
  return list.map((a) => parseAircraft(a, nowMs)).filter(Boolean);
}

/** Altitude above the WGS84 ellipsoid in metres. Prefers GNSS altitude; baro + geoid otherwise. */
export function heightAboveEllipsoid(ac, geoidHeight) {
  if (ac.altGeomFt !== undefined) return ac.altGeomFt * FT;
  if (ac.altBaroFt !== undefined) return ac.altBaroFt * FT + geoidHeight;
  return undefined;
}

/** True when the squawk code signals an emergency (hijack, radio failure, general emergency). */
export const isEmergencySquawk = (sq) => sq === "7500" || sq === "7600" || sq === "7700";

/**
 * Polls providers in order and remembers the first one that works.
 * `onData(aircraft[], providerName)` and `onError(message)` are called after each poll.
 */
export class AdsbPoller {
  constructor({ providers, center, radiusNm = 40, intervalMs = 5000, onData, onError, fetchImpl }) {
    this.providers = providers;
    this.center = center;
    this.radiusNm = radiusNm;
    this.intervalMs = intervalMs;
    this.onData = onData;
    this.onError = onError;
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    this.preferred = 0;
    this.timer = undefined;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.tick();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  async tick() {
    if (!this.running) return;
    // Don't use the providers' capacity while nobody is looking.
    const hidden = typeof document !== "undefined" && document.hidden;
    if (!hidden) await this.pollOnce();
    if (this.running) this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }

  async pollOnce() {
    const order = [...this.providers.keys()];
    order.unshift(...order.splice(this.preferred, 1));
    const errors = [];
    for (const i of order) {
      const p = this.providers[i];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const url = fillUrl(p.url, { ...this.center, radius: this.radiusNm });
        const res = await this.fetchImpl(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        this.preferred = i;
        this.onData?.(parseResponse(json), p.name);
        return true;
      } catch (err) {
        // A CORS refusal surfaces as a TypeError ("Failed to fetch").
        errors.push(`${p.name}: ${err.name === "TypeError" ? "blocked or unreachable" : err.message}`);
      } finally {
        clearTimeout(timeout);
      }
    }
    this.onError?.(errors.join("; "));
    return false;
  }
}
