import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateRoutes, airportPositions, apexHeight, arcPoint, distance, flightSeconds, parseJsonStat, splitCsvLine } from "../src/traffic.js";

const R = 6371000;
const ecef = (lat, lon) => {
  const φ = (lat * Math.PI) / 180;
  const λ = (lon * Math.PI) / 180;
  return [R * Math.cos(φ) * Math.cos(λ), R * Math.cos(φ) * Math.sin(λ), R * Math.sin(φ)];
};
const len = (v) => Math.hypot(...v);

test("parseJsonStat flattens row-major values and skips nulls", () => {
  const rows = parseJsonStat({
    id: ["From", "Tid"],
    size: [2, 2],
    dimension: {
      From: { category: { index: { ENGM: 0, ENBR: 1 } } },
      Tid: { category: { index: ["2026M01", "2026M02"] } },
    },
    value: [1, 2, null, 4],
  });
  assert.deepEqual(rows, [
    { value: 1, From: "ENGM", Tid: "2026M01" },
    { value: 2, From: "ENGM", Tid: "2026M02" },
    { value: 4, From: "ENBR", Tid: "2026M02" },
  ]);
});

test("aggregateRoutes sums months per direction and drops self-routes", () => {
  const row = (f, t, c, v) => ({ FraLufthavn: f, TilLufthavn: t, ContentsCode: c, value: v });
  const routes = aggregateRoutes(
    [row("ENGM", "ENBR", "Flybevegelser", 2), row("ENGM", "ENBR", "Flybevegelser", 3), row("ENGM", "ENBR", "Seter", 500), row("ENGM", "ENGM", "Seter", 9)],
    [{ FraLufthavn: "ENBR", TilLufthavn: "ENGM", value: 70 }],
  );
  assert.deepEqual(routes, [
    { from: "ENGM", to: "ENBR", flights: 5, seats: 500, passengers: 0 },
    { from: "ENBR", to: "ENGM", flights: 0, seats: 0, passengers: 70 },
  ]);
});

test("airportPositions reads OurAirports CSV with quoted fields", () => {
  const csv = [
    '"id","ident","type","name","latitude_deg","longitude_deg","gps_code","icao_code"',
    '1,"ENGM","large_airport","Oslo, Gardermoen",60.1939,11.1004,"ENGM","ENGM"',
    '2,"XX","small_airport","Other",1,2,"",""',
  ].join("\n");
  assert.deepEqual(splitCsvLine('a,"b, c","d ""e"""'), ["a", "b, c", 'd "e"']);
  assert.deepEqual(airportPositions(csv, ["ENGM"]), { ENGM: { lat: 60.1939, lon: 11.1004 } });
});

test("ballistic arc starts and ends on the airports and peaks at the apex mid-route", () => {
  const osl = { lat: 60.1939, lon: 11.1004 };
  const bgo = { lat: 60.2934, lon: 5.2181 };
  const d = distance(osl, bgo);
  assert.ok(Math.abs(d - 326_000) < 5_000, `Oslo–Bergen is ~326 km, got ${d}`);
  const apex = apexHeight(d);
  const A = ecef(osl.lat, osl.lon);
  const B = ecef(bgo.lat, bgo.lon);
  const start = arcPoint(A, B, apex, 0);
  const end = arcPoint(A, B, apex, 1);
  assert.ok(len(start.map((v, i) => v - A[i])) < 1e-6);
  assert.ok(len(end.map((v, i) => v - B[i])) < 1e-6);
  const heights = [0.1, 0.25, 0.5, 0.75, 0.9].map((t) => len(arcPoint(A, B, apex, t)) - R);
  // Projectile parabola: 4·apex·t·(1 − t), plus the small radial part of the sideways bulge.
  heights.forEach((h, i) => {
    const t = [0.1, 0.25, 0.5, 0.75, 0.9][i];
    assert.ok(Math.abs(h - 4 * apex * t * (1 - t)) < apex * 0.05, `height at t=${t}: ${h}`);
  });
  assert.ok(Math.abs(heights[0] - heights[4]) < 1 && Math.abs(heights[1] - heights[3]) < 1, "symmetric");
});

test("opposite directions bulge to opposite sides", () => {
  const A = ecef(60.19, 11.1);
  const B = ecef(63.46, 10.92); // Trondheim, roughly north
  const apex = apexHeight(distance({ lat: 60.19, lon: 11.1 }, { lat: 63.46, lon: 10.92 }));
  const there = arcPoint(A, B, apex, 0.5);
  const back = arcPoint(B, A, apex, 0.5);
  const toEast = (p) => -Math.sin((11 * Math.PI) / 180) * p[0] + Math.cos((11 * Math.PI) / 180) * p[1];
  assert.ok(toEast(there) > toEast(back), "northbound flies on the east (right) side");
});

test("flight time grows with the square root of the apex", () => {
  assert.ok(Math.abs(flightSeconds(4 * 40_000) / flightSeconds(40_000) - 2) < 1e-9);
});
