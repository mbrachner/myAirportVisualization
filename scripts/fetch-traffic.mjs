// Downloads domestic air traffic between Norwegian airports from Statistics Norway (SSB) and the
// airport positions from OpenStreetMap, and writes public/data/norway-traffic.json for the
// "Domestic traffic" view.
// Run it with NODE_USE_ENV_PROXY=1 if your network needs an HTTPS proxy.
// Usage: npm run fetch-traffic
//
// Sources (SSB open data, CC BY 4.0, https://www.ssb.no/en/statbank):
//   08511  Flights and seats between Norwegian airports, monthly. Current.
//   08509  Passengers between Norwegian airports, monthly. Discontinued after April 2022, so the
//          passenger figures are for 2019, the last full year before the pandemic.
import { writeFile, mkdir } from "node:fs/promises";
import { aggregateRoutes, airportPositions, parseJsonStat } from "../src/traffic.js";

const SSB = "https://data.ssb.no/api/v0/no/table";
const OURAIRPORTS = "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv";
const PASSENGER_YEAR = 2019;
const out = new URL("../public/data/norway-traffic.json", import.meta.url);
const userAgent = "oslo-airport-3d/0.1 (CesiumJS airport visualization; traffic snapshot script)";

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Accept: "application/json", "User-Agent": userAgent, ...init.headers } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
  return res.json();
}

const ssbQuery = (table, selection) =>
  getJson(`${SSB}/${table}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: Object.entries(selection).map(([code, values]) => ({ code, selection: { filter: "item", values } })),
      response: { format: "json-stat2" },
    }),
  });

// --- Flights and seats, last 12 months published ---------------------------------------------
const meta = await getJson(`${SSB}/08511`);
const variable = (code) => meta.variables.find((v) => v.code === code);
const months = variable("Tid").values.slice(-12);
const codes = variable("FraLufthavn").values;
console.log(`08511: flights and seats ${months[0]} – ${months.at(-1)} for ${codes.length} airports`);
const recent = parseJsonStat(
  await ssbQuery("08511", { FraLufthavn: codes, TilLufthavn: codes, ContentsCode: ["Flybevegelser", "Seter"], Tid: months }),
);

// --- Passengers, PASSENGER_YEAR --------------------------------------------------------------
const paxMonths = Array.from({ length: 12 }, (_, i) => `${PASSENGER_YEAR}M${String(i + 1).padStart(2, "0")}`);
console.log(`08509: passengers ${PASSENGER_YEAR}`);
const pax = parseJsonStat(
  await ssbQuery("08509", { FraLufthavn: codes, TilLufthavn: codes, PassasjerType: ["AVOM"], ContentsCode: ["Passasjerer"], Tid: paxMonths }),
);

const routes = aggregateRoutes(recent, pax);
const names = Object.fromEntries(variable("FraLufthavn").values.map((c, i) => [c, variable("FraLufthavn").valueTexts[i]]));

// --- Airport positions from OurAirports (public domain) --------------------------------------
const used = [...new Set(routes.flatMap((r) => [r.from, r.to]))].sort();
console.log(`Fetching positions for ${used.length} airports from OurAirports ...`);
const res = await fetch(OURAIRPORTS, { headers: { "User-Agent": userAgent } });
if (!res.ok) throw new Error(`${OURAIRPORTS}: HTTP ${res.status}; existing snapshot left untouched.`);
const positions = airportPositions(await res.text(), used);
const missing = used.filter((c) => !positions[c]);
if (missing.length) console.warn(`No position for ${missing.join(", ")}; their routes are dropped.`);

const airports = used.filter((c) => positions[c]).map((icao) => ({ icao, name: names[icao], ...positions[icao] }));
const kept = routes.filter((r) => positions[r.from] && positions[r.to]);

const data = {
  fetched: new Date().toISOString(),
  sources: {
    flightsSeats: { table: "08511", url: "https://www.ssb.no/en/statbank/table/08511", period: [months[0], months.at(-1)] },
    passengers: { table: "08509", url: "https://www.ssb.no/en/statbank/table/08509", year: PASSENGER_YEAR },
    positions: "OurAirports (public domain), https://ourairports.com/data/",
    licence: "Statistics Norway, CC BY 4.0",
  },
  airports,
  routes: kept,
};
await mkdir(new URL(".", out), { recursive: true });
await writeFile(out, JSON.stringify(data, null, 1));
console.log(`Saved ${airports.length} airports and ${kept.length} directed routes to ${out.pathname}`);
console.table(
  [...kept]
    .sort((a, b) => b.seats - a.seats)
    .slice(0, 10)
    .map((r) => ({ route: `${r.from} → ${r.to}`, flights: r.flights, seats: r.seats, [`pax ${PASSENGER_YEAR}`]: r.passengers })),
);
