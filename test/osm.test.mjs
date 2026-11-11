import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLength,
  buildingHeights,
  assembleRings,
  classify,
  runwayEnds,
  parseOverpass,
  buildOverpassQuery,
  summarize,
  fetchOverpass,
  findByTag,
} from "../src/osm.js";

test("parseLength handles metres, units and feet", () => {
  assert.equal(parseLength("45"), 45);
  assert.equal(parseLength("45 m"), 45);
  assert.equal(parseLength("12,5"), 12.5);
  assert.ok(Math.abs(parseLength("100 ft") - 30.48) < 1e-9);
  assert.equal(parseLength("wide"), undefined);
  assert.equal(parseLength(undefined), undefined);
});

test("buildingHeights prefers height, then levels, then defaults", () => {
  assert.deepEqual(buildingHeights({ height: "30" }, "other"), { height: 30, minHeight: 0 });
  assert.deepEqual(buildingHeights({ "building:levels": "4" }, "other"), { height: 14, minHeight: 0 });
  assert.equal(buildingHeights({}, "terminal").height, 22);
  assert.equal(buildingHeights({}, "hangar").height, 18);
  assert.equal(buildingHeights({ min_height: "5", height: "10" }, "other").minHeight, 5);
});

test("classify maps aeroway and building tags to layers", () => {
  assert.equal(classify({ aeroway: "runway" }), "runway");
  assert.equal(classify({ aeroway: "taxilane" }), "taxiway");
  assert.equal(classify({ aeroway: "terminal", building: "yes" }), "building");
  assert.equal(classify({ aeroway: "parking_position" }), "stand");
  assert.equal(classify({ building: "no" }), undefined);
  assert.equal(classify({ highway: "service" }), undefined);
});

test("assembleRings stitches split and reversed segments", () => {
  const rings = assembleRings([
    [[0, 0], [1, 0]],
    [[1, 1], [1, 0]], // reversed
    [[1, 1], [0, 1], [0, 0]],
  ]);
  assert.equal(rings.length, 1);
  assert.deepEqual(rings[0][0], rings[0][rings[0].length - 1]);
  assert.equal(rings[0].length, 5);
});

test("runwayEnds puts runway 01's threshold at the southern end", () => {
  const south = [11.07, 60.17];
  const north = [11.072, 60.2];
  // Way drawn south -> north
  let ends = runwayEnds([south, north], "01L/19R");
  assert.equal(ends[0].designator, "01L");
  assert.deepEqual(ends[0].position, south);
  assert.ok(ends[0].heading < 20);
  // Same runway drawn north -> south
  ends = runwayEnds([north, south], "01L/19R");
  const e01 = ends.find((e) => e.designator === "01L");
  const e19 = ends.find((e) => e.designator === "19R");
  assert.deepEqual(e01.position, south);
  assert.deepEqual(e19.position, north);
  assert.ok(Math.abs(e19.heading - 180) < 20);
});

test("overpass query contains the bbox", () => {
  assert.match(buildOverpassQuery([1, 2, 3, 4]), /\(1,2,3,4\)/);
});

test("parseOverpass builds features for every layer type", () => {
  const sq = (x, y, d = 0.001) => [
    { lon: x, lat: y }, { lon: x + d, lat: y }, { lon: x + d, lat: y + d }, { lon: x, lat: y + d }, { lon: x, lat: y },
  ];
  const json = {
    elements: [
      { type: "way", id: 1, tags: { aeroway: "runway", ref: "01L/19R", width: "60" }, geometry: [{ lon: 11.07, lat: 60.17 }, { lon: 11.072, lat: 60.2 }] },
      { type: "way", id: 2, tags: { aeroway: "taxiway", ref: "A" }, geometry: [{ lon: 11.08, lat: 60.18 }, { lon: 11.08, lat: 60.19 }] },
      { type: "way", id: 3, tags: { aeroway: "apron" }, geometry: sq(11.09, 60.19, 0.01) },
      { type: "way", id: 4, tags: { aeroway: "terminal", building: "yes", name: "Terminal", height: "25" }, geometry: sq(11.1, 60.19) },
      { type: "node", id: 5, lon: 11.1, lat: 60.195, tags: { aeroway: "gate", ref: "D4" } },
      { type: "node", id: 6, lon: 11.101, lat: 60.195, tags: { aeroway: "parking_position", ref: "40" } },
      {
        type: "relation", id: 7, tags: { type: "multipolygon", building: "hangar" },
        members: [
          { type: "way", role: "outer", geometry: sq(11.05, 60.18, 0.002).slice(0, 3) },
          { type: "way", role: "outer", geometry: sq(11.05, 60.18, 0.002).slice(2) },
          { type: "way", role: "inner", geometry: sq(11.0505, 60.1805, 0.0005) },
        ],
      },
      { type: "way", id: 8, tags: { highway: "service" }, geometry: sq(11, 60) },
    ],
  };
  const layers = parseOverpass(json);
  assert.deepEqual(summarize(layers), { runway: 1, taxiway: 1, apron: 1, building: 2, gate: 1, stand: 1, aerodrome: 0, poi: 0 });
  const rwy = layers.runway[0];
  assert.equal(rwy.geometry.type, "LineString");
  assert.equal(rwy.width, 60);
  assert.equal(rwy.ends.length, 2);
  assert.equal(layers.taxiway[0].width, 23);
  const terminal = layers.building.find((b) => b.kind === "terminal");
  assert.equal(terminal.height, 25);
  assert.ok(terminal.area > 1000);
  const hangar = layers.building.find((b) => b.kind === "hangar");
  assert.equal(hangar.geometry.holes.length, 1);
  assert.equal(hangar.height, 18);
});

const response = (status, body = { elements: [] }, headers = {}) => ({
  ok: status === 200,
  status,
  headers: { get: (k) => headers[k] ?? null },
  json: async () => body,
});

test("fetchOverpass sends identifying headers and falls back to the next server", async () => {
  const seen = [];
  const json = await fetchOverpass({
    endpoints: ["https://a/api", "https://b/api"],
    headers: { "User-Agent": "test-app/1.0" },
    fetchImpl: async (url, init) => {
      seen.push([url, init.headers["User-Agent"], init.headers.Accept]);
      return url === "https://a/api" ? response(406) : response(200, { elements: [{ id: 1 }] });
    },
  });
  assert.equal(json.elements.length, 1);
  assert.deepEqual(seen, [["https://a/api", "test-app/1.0", "application/json"], ["https://b/api", "test-app/1.0", "application/json"]]);
});

test("fetchOverpass retries busy servers but never a 406", async () => {
  const calls = [];
  let attemptsB = 0;
  const json = await fetchOverpass({
    endpoints: ["https://a/api", "https://b/api"],
    retries: 2,
    retryDelayMs: 1,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === "https://a/api") return response(406);
      attemptsB++;
      return attemptsB < 3 ? response(429) : response(200);
    },
  });
  assert.deepEqual(json, { elements: [] });
  assert.equal(calls.filter((u) => u === "https://a/api").length, 1, "406 is not retried");
  assert.equal(attemptsB, 3);
});

test("fetchOverpass reports every failure", async () => {
  await assert.rejects(
    fetchOverpass({ endpoints: ["https://a/api"], retries: 1, retryDelayMs: 1, fetchImpl: async () => response(429) }),
    /All Overpass endpoints failed:\nhttps:\/\/a\/api: HTTP 429\nhttps:\/\/a\/api: HTTP 429/,
  );
});

test("fetchOverpass gives up on a server that never answers", async () => {
  const calls = [];
  const json = await fetchOverpass({
    endpoints: ["https://slow/api", "https://ok/api"],
    timeoutMs: 20,
    fetchImpl: (url, init) => {
      calls.push(url);
      if (url === "https://ok/api") return Promise.resolve(response(200));
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    },
  });
  assert.deepEqual(json, { elements: [] });
  assert.deepEqual(calls, ["https://slow/api", "https://ok/api"]);
});

test("findByTag finds the control tower by its building number, mapped as outline or point", () => {
  const sq = [[11.09, 60.19], [11.0901, 60.19], [11.0901, 60.1901], [11.09, 60.1901], [11.09, 60.19]].map(([lon, lat]) => ({ lon, lat }));
  const asWay = parseOverpass({ elements: [{ type: "way", id: 1, tags: { building: "yes", man_made: "tower", "ref:bygningsnr": "15344334", height: "61" }, geometry: sq }] });
  const tower = findByTag(asWay, "ref:bygningsnr", "15344334");
  assert.equal(tower.layer, "building");
  assert.equal(tower.kind, "tower");
  assert.equal(tower.height, 61);
  assert.ok(tower.centroid);

  const asNode = parseOverpass({ elements: [{ type: "node", id: 2, lon: 11.09, lat: 60.19, tags: { man_made: "tower", "ref:bygningsnr": "15344334" } }] });
  const point = findByTag(asNode, "ref:bygningsnr", "15344334");
  assert.equal(point.layer, "poi", "point towers are not drawn as buildings");
  assert.equal(point.height, 40, "towers without height get the tower default");
  assert.deepEqual(point.centroid, [11.09, 60.19]);
  assert.equal(asNode.building.length, 0);

  assert.equal(findByTag(asWay, "ref:bygningsnr", "999"), undefined);
});
