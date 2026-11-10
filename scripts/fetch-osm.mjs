// Downloads a snapshot of OpenStreetMap airport data for ENGM into public/data/,
// so the app loads instantly and works without hitting Overpass every time.
// Usage: npm run fetch-osm
//
// Overpass servers refuse anonymous scripts (HTTP 406), so this sends a User-Agent naming the
// application. Set OSM_USER_AGENT to add contact details (e.g. a URL), and OSM_REFERER to the site's
// address. If every server fails, any existing snapshot is left untouched.
import { writeFile, mkdir } from "node:fs/promises";
import { fetchOverpass, parseOverpass, summarize, AIRPORT } from "../src/osm.js";

const out = new URL("../public/data/engm-osm.json", import.meta.url);

console.log(`Fetching OSM data for ${AIRPORT.name} (${AIRPORT.icao}) ...`);
const headers = {
  "User-Agent": process.env.OSM_USER_AGENT || "oslo-airport-3d/0.1 (CesiumJS airport visualization; OSM snapshot script)",
};
if (process.env.OSM_REFERER) headers.Referer = process.env.OSM_REFERER;
// Three servers x 100 s worst case, plus one retry round for busy ones, stays under the
// workflow's step timeout.
const json = await fetchOverpass({ headers, retries: 1, timeoutMs: 100_000, log: console.log });
const counts = summarize(parseOverpass(json));
await mkdir(new URL(".", out), { recursive: true });
await writeFile(out, JSON.stringify({ fetched: new Date().toISOString(), ...json }));
console.log(`Saved ${json.elements.length} elements to ${out.pathname}`);
console.table(counts);
