// Pure helpers for the domestic traffic view: SSB JSON-stat parsing, route aggregation and the
// ballistic arc maths. No Cesium imports so they can be unit tested in Node.

/**
 * Flatten a JSON-stat 2.0 dataset into rows like { FraLufthavn: "ENGM", Tid: "2026M01", value: 123 }.
 * Values are stored row-major over `id`/`size`; null and missing cells are skipped.
 */
export function parseJsonStat(ds) {
  const { id, size, dimension, value } = ds;
  const keys = id.map((d) => {
    const index = dimension[d].category.index;
    const list = Array.isArray(index) ? index : Object.keys(index).sort((a, b) => index[a] - index[b]);
    return list;
  });
  const rows = [];
  const n = size.reduce((a, b) => a * b, 1);
  const get = Array.isArray(value) ? (i) => value[i] : (i) => value[String(i)];
  for (let i = 0; i < n; i++) {
    const v = get(i);
    if (v === null || v === undefined) continue;
    const row = { value: v };
    let rest = i;
    for (let d = id.length - 1; d >= 0; d--) {
      row[id[d]] = keys[d][rest % size[d]];
      rest = Math.floor(rest / size[d]);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Sum the monthly rows into directed routes { from, to, flights, seats, passengers }.
 * A route is kept if it had any flights in the recent period or passengers in the reference year.
 */
export function aggregateRoutes(recentRows, passengerRows = []) {
  const routes = new Map();
  const route = (from, to) => {
    const key = `${from}-${to}`;
    if (!routes.has(key)) routes.set(key, { from, to, flights: 0, seats: 0, passengers: 0 });
    return routes.get(key);
  };
  for (const r of recentRows) {
    if (r.FraLufthavn === r.TilLufthavn || !r.value) continue;
    const field = r.ContentsCode === "Flybevegelser" ? "flights" : r.ContentsCode === "Seter" ? "seats" : undefined;
    if (field) route(r.FraLufthavn, r.TilLufthavn)[field] += r.value;
  }
  for (const r of passengerRows) {
    if (r.FraLufthavn === r.TilLufthavn || !r.value) continue;
    route(r.FraLufthavn, r.TilLufthavn).passengers += r.value;
  }
  return [...routes.values()].filter((r) => r.flights > 0 || r.passengers > 0);
}

const R = 6371008.8; // mean Earth radius, m
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres between { lat, lon } points. */
export function distance(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Shape of the arcs, shared by the shader (trafficLayer.js) and the CPU mirror below. */
export const ARC = {
  apexRatio: 0.12, // apex height as a fraction of the route distance
  minApex: 8000, // m, so short hops still lift off visibly
  side: 0.25, // sideways bulge (to the right of travel) as a fraction of the height
  timeScale: 0.018, // s per √m of apex: like a fall time, T = 2·√(2h/g), scaled to be watchable
};

export const apexHeight = (d) => Math.max(ARC.minApex, ARC.apexRatio * d);
/** Seconds for one particle to fly the route: ballistic flight time grows with √apex. */
export const flightSeconds = (apex) => ARC.timeScale * Math.sqrt(apex);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Point at parameter t ∈ [0, 1] on the ballistic arc between Earth-centred positions A and B
 * (metres). Mirrors the vertex shader in trafficLayer.js exactly:
 *   - ground track: the chord A→B pushed back out to the surface (radius interpolated A→B)
 *   - height: projectile parabola h = 4·apex·t·(1 − t), so with t advancing at a constant rate the
 *     horizontal speed is constant and the vertical speed is zero at the apex, as in real
 *     ballistic flight
 *   - sideways: `side`·h to the right of travel, separating the two directions of a route.
 */
export function arcPoint(A, B, apex, t, { heightScale = 1, side = ARC.side } = {}) {
  const chord = [0, 1, 2].map((i) => A[i] + (B[i] - A[i]) * t);
  const r = len(chord);
  const up = chord.map((v) => v / r);
  const surface = len(A) + (len(B) - len(A)) * t;
  const h = 4 * apex * t * (1 - t) * heightScale;
  const right = cross(sub(B, A), up);
  const rl = len(right) || 1;
  return [0, 1, 2].map((i) => up[i] * (surface + h) + (right[i] / rl) * side * h);
}

/** Split one CSV line, honouring double-quoted fields with "" escapes. */
export function splitCsvLine(line) {
  const out = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") out.push(field), (field = "");
    else field += c;
  }
  out.push(field);
  return out;
}

/** Positions { ICAO: { lat, lon } } for the wanted ICAO codes from OurAirports' airports.csv. */
export function airportPositions(csv, wanted) {
  const want = new Set(wanted);
  const lines = csv.split(/\r?\n/);
  const header = splitCsvLine(lines[0]);
  const col = (name) => header.indexOf(name);
  const [ident, icao, gps, lat, lon] = ["ident", "icao_code", "gps_code", "latitude_deg", "longitude_deg"].map(col);
  const positions = {};
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const f = splitCsvLine(line);
    const code = [f[icao], f[gps], f[ident]].find((c) => want.has(c));
    if (!code || positions[code]) continue;
    positions[code] = { lat: +Number(f[lat]).toFixed(5), lon: +Number(f[lon]).toFixed(5) };
  }
  return positions;
}
