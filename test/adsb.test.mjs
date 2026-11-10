import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAircraft, parseResponse, heightAboveEllipsoid, providerList, fillUrl, AdsbPoller, isEmergencySquawk } from "../src/adsb.js";
import { createAircraftGlb } from "../src/aircraftModel.js";

const NOW = 1_700_000_000_000;

test("parseAircraft normalises an airborne readsb record", () => {
  const ac = parseAircraft(
    { hex: "4AC9F1", flight: "SAS4417 ", r: "SE-ROM", t: "A20N", lat: 60.25, lon: 11.08, alt_baro: 3500, alt_geom: 3650, gs: 160.4, track: 194.2, baro_rate: -704, squawk: "2771", seen_pos: 1.5 },
    NOW,
  );
  assert.equal(ac.hex, "4ac9f1");
  assert.equal(ac.callsign, "SAS4417");
  assert.equal(ac.onGround, false);
  assert.equal(ac.altBaroFt, 3500);
  assert.equal(ac.altGeomFt, 3650);
  assert.equal(ac.trackDeg, 194.2);
  assert.equal(ac.verticalRateFpm, -704);
  assert.equal(ac.observedAt, NOW - 1500);
});

test("parseAircraft handles aircraft on the ground and missing fields", () => {
  const ac = parseAircraft({ hex: "478f3a", alt_baro: "ground", lat: 60.19, lon: 11.1, true_heading: 10 }, NOW);
  assert.equal(ac.onGround, true);
  assert.equal(ac.altBaroFt, undefined);
  assert.equal(ac.trackDeg, 10);
  assert.equal(ac.callsign, "");
  assert.equal(parseAircraft({ hex: "abc" }, NOW), undefined, "no position -> skipped");
});

test("parseResponse accepts both `ac` and `aircraft` arrays", () => {
  assert.equal(parseResponse({ ac: [{ hex: "a", lat: 1, lon: 2 }, { hex: "b" }] }).length, 1);
  assert.equal(parseResponse({ aircraft: [{ hex: "a", lat: 1, lon: 2 }] }).length, 1);
  assert.equal(parseResponse(null).length, 0);
});

test("heightAboveEllipsoid prefers GNSS altitude and adds the geoid to baro altitude", () => {
  assert.ok(Math.abs(heightAboveEllipsoid({ altGeomFt: 1000, altBaroFt: 900 }, 38) - 304.8) < 1e-9);
  assert.ok(Math.abs(heightAboveEllipsoid({ altBaroFt: 1000 }, 38) - 342.8) < 1e-9);
  assert.equal(heightAboveEllipsoid({ onGround: true }, 38), undefined);
});

test("providerList puts the proxy first and dev proxies before public APIs", () => {
  const list = providerList({ proxyUrl: "https://p.example.dev/", dev: true });
  assert.equal(list[0].url, "https://p.example.dev/point/{lat}/{lon}/{radius}");
  assert.match(list[1].url, /^\/adsb-dev\//);
  assert.equal(fillUrl(list[0].url, { lat: 60.1939, lon: 11.1004, radius: 40 }), "https://p.example.dev/point/60.1939/11.1004/40");
  assert.equal(providerList({}).length, 3);
});

test("AdsbPoller falls back to the next provider and remembers the working one", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith("https://bad")) throw new TypeError("Failed to fetch");
    return { ok: true, json: async () => ({ ac: [{ hex: "abc", lat: 60, lon: 11 }] }) };
  };
  let got;
  const poller = new AdsbPoller({
    providers: [{ name: "bad", url: "https://bad/{lat}/{lon}/{radius}" }, { name: "good", url: "https://good/{lat}/{lon}/{radius}" }],
    center: { lat: 60, lon: 11 },
    fetchImpl,
    onData: (list, name) => (got = { list, name }),
  });
  assert.equal(await poller.pollOnce(), true);
  assert.equal(got.name, "good");
  assert.equal(got.list.length, 1);
  calls.length = 0;
  await poller.pollOnce();
  assert.equal(calls.length, 1, "second poll goes straight to the working provider");
  assert.match(calls[0], /^https:\/\/good/);
});

test("AdsbPoller reports an error when every provider fails", async () => {
  let error;
  const poller = new AdsbPoller({
    providers: [{ name: "a", url: "https://a/{lat}/{lon}/{radius}" }],
    center: { lat: 60, lon: 11 },
    fetchImpl: async () => ({ ok: false, status: 429 }),
    onError: (m) => (error = m),
  });
  assert.equal(await poller.pollOnce(), false);
  assert.match(error, /HTTP 429/);
});

test("emergency squawks are recognised", () => {
  assert.ok(isEmergencySquawk("7700"));
  assert.ok(!isEmergencySquawk("2000"));
});

test("generated aircraft model is a valid GLB with sensible dimensions", () => {
  const glb = createAircraftGlb();
  const view = new DataView(glb);
  assert.equal(view.getUint32(0, true), 0x46546c67, "magic");
  assert.equal(view.getUint32(4, true), 2, "version");
  assert.equal(view.getUint32(8, true), glb.byteLength, "length");
  const jsonLen = view.getUint32(12, true);
  assert.equal(jsonLen % 4, 0);
  const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLen)));
  const pos = gltf.accessors[0];
  assert.equal(pos.count % 3, 0, "whole triangles");
  // glTF axes: x = left (span), y = up, z = forward (length)
  const span = pos.max[0] - pos.min[0];
  const length = pos.max[2] - pos.min[2];
  assert.ok(span > 30 && span < 40, `span ${span}`);
  assert.ok(length > 35 && length < 45, `length ${length}`);
  const binLen = view.getUint32(20 + jsonLen, true);
  assert.ok(binLen >= gltf.buffers[0].byteLength);
});
