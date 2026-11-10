// Fetching and parsing OpenStreetMap data for Oslo Airport Gardermoen (ENGM).
// This module has no Cesium dependency so it can be unit-tested in Node.

export const AIRPORT = {
  name: "Oslo Airport Gardermoen",
  iata: "OSL",
  icao: "ENGM",
  lon: 11.1004,
  lat: 60.1939,
  // Field elevation 681 ft above mean sea level.
  elevationMsl: 208,
  // south, west, north, east
  bbox: [60.165, 11.03, 60.235, 11.14],
};

export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

export function buildOverpassQuery(bbox = AIRPORT.bbox) {
  const b = bbox.join(",");
  return `[out:json][timeout:90];
(
  nwr["aeroway"](${b});
  way["building"](${b});
  relation["building"](${b});
);
out geom;`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch raw Overpass JSON, trying each endpoint in turn.
 *
 * Overpass servers require clients to identify themselves: outside a browser, pass a descriptive
 * `headers["User-Agent"]` (library defaults are answered with HTTP 406). Browsers send their own
 * User-Agent and Referer, which is enough. `retries` extra rounds are made only for busy servers
 * (429/503/504), waiting `Retry-After` or `retryDelayMs`; a 406 is never retried.
 */
export async function fetchOverpass({
  bbox = AIRPORT.bbox,
  endpoints = OVERPASS_ENDPOINTS,
  fetchImpl = (...args) => fetch(...args),
  headers = {},
  retries = 0,
  retryDelayMs = 30_000,
  timeoutMs = 120_000,
  log = () => {},
} = {}) {
  const query = buildOverpassQuery(bbox);
  const errors = [];
  let pending = [...endpoints];
  for (let round = 0; round <= retries && pending.length; round++) {
    const busy = [];
    let wait = 0;
    for (const url of pending) {
      // A server that accepts the request but never answers must not block the others.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        log(`Querying ${url} ...`);
        const res = await fetchImpl(url, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...headers },
          body: "data=" + encodeURIComponent(query),
        });
        if (!res.ok) {
          if ([429, 503, 504].includes(res.status)) {
            busy.push(url);
            wait = Math.max(wait, (parseInt(res.headers?.get?.("Retry-After"), 10) || 0) * 1000);
          }
          throw new Error(`HTTP ${res.status}${res.status === 406 ? " (request refused: check the User-Agent)" : ""}`);
        }
        const json = await res.json();
        if (!Array.isArray(json.elements)) throw new Error("unexpected response");
        return json;
      } catch (err) {
        const cause = err.cause?.code ?? err.cause?.message;
        const message =
          err.name === "AbortError" ? `no answer within ${Math.round(timeoutMs / 1000)} s` : cause ? `${err.message} (${cause})` : err.message;
        log(`  failed: ${message}`);
        errors.push(`${url}: ${message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    pending = busy;
    if (pending.length && round < retries) {
      const ms = Math.min(Math.max(wait, retryDelayMs), 120_000);
      log(`Overpass busy, retrying ${pending.length} server(s) in ${Math.round(ms / 1000)} s ...`);
      await sleep(ms);
    }
  }
  throw new Error("All Overpass endpoints failed:\n" + errors.join("\n"));
}

// ---------------------------------------------------------------------------
// Parsing

/** Parse an OSM length such as "45", "45 m", "12.5m" or "30'" into metres. */
export function parseLength(value) {
  if (value == null) return undefined;
  const s = String(value).trim().replace(",", ".");
  const ft = s.match(/^([\d.]+)\s*(ft|')$/i);
  if (ft) return parseFloat(ft[1]) * 0.3048;
  const m = s.match(/^([\d.]+)\s*(m)?$/i);
  return m ? parseFloat(m[1]) : undefined;
}

const DEFAULT_WIDTH = { runway: 45, taxiway: 23, taxilane: 15, stopway: 45 };
const LEVEL_HEIGHT = 3.5;

export function buildingHeights(tags, kind) {
  let height = parseLength(tags.height);
  const levels = parseFloat(tags["building:levels"]);
  if (height === undefined && Number.isFinite(levels)) {
    height = levels * LEVEL_HEIGHT + (parseLength(tags["roof:height"]) ?? 0);
  }
  if (height === undefined) {
    height = kind === "terminal" ? 22 : kind === "hangar" ? 18 : 9;
  }
  let minHeight = parseLength(tags.min_height);
  const minLevel = parseFloat(tags["building:min_level"]);
  if (minHeight === undefined && Number.isFinite(minLevel)) minHeight = minLevel * LEVEL_HEIGHT;
  return { height, minHeight: minHeight ?? 0 };
}

function isClosed(coords) {
  if (coords.length < 4) return false;
  const a = coords[0];
  const b = coords[coords.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

const toCoords = (geometry) => (geometry ?? []).filter(Boolean).map((p) => [p.lon, p.lat]);

/** Stitch multipolygon member ways into closed rings. */
export function assembleRings(segments) {
  const pending = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const rings = [];
  const same = (p, q) => p[0] === q[0] && p[1] === q[1];
  while (pending.length) {
    let ring = pending.shift();
    let progress = true;
    while (!isClosed(ring) && progress) {
      progress = false;
      const end = ring[ring.length - 1];
      for (let i = 0; i < pending.length; i++) {
        const seg = pending[i];
        if (same(seg[0], end)) ring = ring.concat(seg.slice(1));
        else if (same(seg[seg.length - 1], end)) ring = ring.concat(seg.slice().reverse().slice(1));
        else continue;
        pending.splice(i, 1);
        progress = true;
        break;
      }
    }
    if (isClosed(ring)) rings.push(ring);
  }
  return rings;
}

/** Point-in-polygon test (ray casting), used to attach inner rings to outers. */
function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function relationPolygons(el) {
  const members = el.members ?? [];
  const outers = assembleRings(members.filter((m) => m.type === "way" && m.role !== "inner").map((m) => toCoords(m.geometry)));
  const inners = assembleRings(members.filter((m) => m.type === "way" && m.role === "inner").map((m) => toCoords(m.geometry)));
  return outers.map((outer) => ({
    outer,
    holes: inners.filter((inner) => pointInRing(inner[0], outer)),
  }));
}

/** Decide which layer an OSM element belongs to. Returns undefined to skip it. */
export function classify(tags) {
  const aeroway = tags.aeroway;
  if (aeroway === "runway") return "runway";
  if (aeroway === "taxiway" || aeroway === "taxilane") return "taxiway";
  if (aeroway === "stopway") return "taxiway";
  if (aeroway === "apron") return "apron";
  if (aeroway === "aerodrome") return "aerodrome";
  if (aeroway === "gate") return "gate";
  if (aeroway === "parking_position") return "stand";
  if (aeroway === "helipad") return "apron";
  if (aeroway === "terminal" || tags.building === "terminal") return "building";
  if (aeroway === "hangar" || tags.building === "hangar") return "building";
  if (aeroway === "tower" || aeroway === "control_tower") return "building";
  if (tags.building && tags.building !== "no") return "building";
  if (aeroway === "windsock") return "poi";
  return undefined;
}

function buildingKind(tags) {
  if (tags.aeroway === "terminal" || tags.building === "terminal") return "terminal";
  if (tags.aeroway === "hangar" || tags.building === "hangar") return "hangar";
  if (tags.aeroway === "tower" || tags.aeroway === "control_tower" || tags["man_made"] === "tower") return "tower";
  return "other";
}

/** Planar centroid of a ring in lon/lat, good enough at airport scale. */
export function ringCentroid(ring) {
  let x = 0;
  let y = 0;
  const n = ring.length - (isClosed(ring) ? 1 : 0);
  for (let i = 0; i < n; i++) {
    x += ring[i][0];
    y += ring[i][1];
  }
  return [x / n, y / n];
}

/** Approximate ring area in m² (equirectangular projection). */
export function ringArea(ring) {
  const lat0 = (ringCentroid(ring)[1] * Math.PI) / 180;
  const kx = 111320 * Math.cos(lat0);
  const ky = 110540;
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * kx * ring[i + 1][1] * ky - ring[i + 1][0] * kx * ring[i][1] * ky;
  }
  return Math.abs(a / 2);
}

/** Initial bearing in degrees from point a to b ([lon, lat]). */
export function bearing(a, b) {
  const toRad = Math.PI / 180;
  const [lon1, lat1, lon2, lat2] = [a[0] * toRad, a[1] * toRad, b[0] * toRad, b[1] * toRad];
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return ((Math.atan2(y, x) / toRad) + 360) % 360;
}

const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/**
 * Work out the two thresholds of a runway line from its ref (e.g. "01L/19R").
 * The threshold of runway "01" is the end you take off from heading ~010°,
 * i.e. the southern end.
 */
export function runwayEnds(coords, ref) {
  if (!ref || coords.length < 2) return [];
  const parts = ref.split("/").map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) return [];
  const first = coords[0];
  const last = coords[coords.length - 1];
  const heading = bearing(first, last);
  const designatorHeading = (p) => (parseInt(p, 10) % 36) * 10;
  // If the way runs in the direction of parts[0], parts[0]'s threshold is at the first node.
  const forward = angleDiff(heading, designatorHeading(parts[0])) < angleDiff(heading, designatorHeading(parts[1]));
  const [aName, bName] = forward ? parts : [parts[1], parts[0]];
  // Whichever designator sits at the first node, its departure heading is first -> last.
  return [
    { designator: aName, position: first, heading, opposite: last },
    { designator: bName, position: last, heading: bearing(last, first), opposite: first },
  ];
}

/**
 * Turn raw Overpass JSON into a flat list of features grouped by layer:
 * { runway: [], taxiway: [], apron: [], building: [], gate: [], stand: [], aerodrome: [], poi: [] }
 */
export function parseOverpass(json) {
  const layers = { runway: [], taxiway: [], apron: [], building: [], gate: [], stand: [], aerodrome: [], poi: [] };
  for (const el of json.elements ?? []) {
    const tags = el.tags ?? {};
    const layer = classify(tags);
    if (!layer) continue;
    const base = { id: `${el.type}/${el.id}`, layer, tags, name: tags.name ?? tags.ref };

    if (el.type === "node") {
      if (el.lon == null) continue;
      layers[layer].push({ ...base, geometry: { type: "Point", coordinates: [el.lon, el.lat] } });
      continue;
    }

    let polygons = [];
    let line;
    if (el.type === "way") {
      const coords = toCoords(el.geometry);
      if (coords.length < 2) continue;
      const lineLike = (layer === "runway" || layer === "taxiway") && tags.area !== "yes";
      if (isClosed(coords) && !lineLike) polygons = [{ outer: coords, holes: [] }];
      else line = coords;
    } else if (el.type === "relation") {
      polygons = relationPolygons(el);
      if (!polygons.length) continue;
    } else {
      continue;
    }

    if (line) {
      const feature = { ...base, geometry: { type: "LineString", coordinates: line } };
      if (layer === "runway" || layer === "taxiway") {
        feature.width = parseLength(tags.width) ?? DEFAULT_WIDTH[tags.aeroway] ?? 20;
      }
      if (layer === "runway") feature.ends = runwayEnds(line, tags.ref);
      if (layer === "stand" || layer === "gate") {
        // Stand drawn as a lead-in line: use its end point as the label position.
        feature.labelPosition = line[line.length - 1];
      }
      layers[layer].push(feature);
      continue;
    }

    for (const [i, poly] of polygons.entries()) {
      const feature = {
        ...base,
        id: polygons.length > 1 ? `${base.id}#${i}` : base.id,
        geometry: { type: "Polygon", outer: poly.outer, holes: poly.holes },
        area: ringArea(poly.outer),
        centroid: ringCentroid(poly.outer),
      };
      if (layer === "building") {
        feature.kind = buildingKind(tags);
        Object.assign(feature, buildingHeights(tags, feature.kind));
      }
      layers[layer].push(feature);
    }
  }
  return layers;
}

/** Feature counts per layer, for the status bar. */
export function summarize(layers) {
  return Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, v.length]));
}
