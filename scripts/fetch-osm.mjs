// Downloads a snapshot of OpenStreetMap airport data for ENGM into public/data/,
// so the app loads instantly and works without hitting Overpass every time.
// Usage: npm run fetch-osm
import { writeFile, mkdir } from "node:fs/promises";
import { fetchOverpass, parseOverpass, summarize, AIRPORT } from "../src/osm.js";

const out = new URL("../public/data/engm-osm.json", import.meta.url);

console.log(`Fetching OSM data for ${AIRPORT.name} (${AIRPORT.icao}) ...`);
const json = await fetchOverpass();
const counts = summarize(parseOverpass(json));
await mkdir(new URL(".", out), { recursive: true });
await writeFile(out, JSON.stringify({ fetched: new Date().toISOString(), ...json }));
console.log(`Saved ${json.elements.length} elements to ${out.pathname}`);
console.table(counts);
