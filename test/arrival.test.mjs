import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOverpass } from "../src/osm.js";
import { planArrival, buildProfile, sampleProfile } from "../src/routing.js";
import { createAircraftGlb } from "../src/aircraftModel.js";

const P = (lon, lat) => ({ lon, lat });
// Runway 01L/19R drawn south -> north with exit nodes shared with taxiways.
const RWY = [P(11.0700, 60.1700), P(11.0703, 60.1850), P(11.0705, 60.1950), P(11.0707, 60.2020)];
const EXIT_EARLY = RWY[1]; // ~1.7 km from threshold
const EXIT_LATE = RWY[2]; // ~2.8 km from threshold
const TWY_A = [P(11.0760, 60.1820), P(11.0760, 60.1960)]; // parallel taxiway
const STAND_LINE = [P(11.0790, 60.1900), P(11.0820, 60.1900)];

function fixture({ withGate = true, connected = true } = {}) {
  const els = [
    { type: "way", id: 1, tags: { aeroway: "runway", ref: "01L/19R" }, geometry: RWY },
    { type: "way", id: 2, tags: { aeroway: "taxiway", ref: "A" }, geometry: [TWY_A[0], P(11.0760, 60.1900), TWY_A[1]] },
    { type: "node", id: 9, lon: 11.0826, lat: 60.1900, tags: { aeroway: withGate ? "gate" : "windsock", ref: "A12" } },
    { type: "way", id: 10, tags: { aeroway: "parking_position", ref: "12" }, geometry: STAND_LINE },
    // a different stand that must not be used as a shortcut
    { type: "way", id: 11, tags: { aeroway: "parking_position", ref: "14" }, geometry: [P(11.0760, 60.1880), P(11.0790, 60.1900)] },
  ];
  if (connected) {
    els.push(
      { type: "way", id: 3, tags: { aeroway: "taxiway", ref: "C1" }, geometry: [EXIT_EARLY, P(11.0760, 60.1820)] },
      { type: "way", id: 4, tags: { aeroway: "taxiway", ref: "C3" }, geometry: [EXIT_LATE, P(11.0760, 60.1960)] },
      { type: "way", id: 5, tags: { aeroway: "taxiway", ref: "K" }, geometry: [P(11.0760, 60.1900), STAND_LINE[0]] },
    );
  }
  return parseOverpass({ elements: els });
}

test("planArrival lands on 01L, exits at a connected taxiway and ends at the gate's stand", () => {
  const plan = planArrival(fixture(), { runway: "01L", gate: "A12" });
  assert.equal(plan.runway, "01L");
  assert.equal(plan.gate, "A12");
  assert.equal(plan.stand, "12");
  assert.deepEqual(plan.warnings, []);
  const v = plan.vertices;
  // Approach comes from the south (runway 01 heading ~north) and descends to the runway.
  assert.equal(v[0].phase, "approach");
  assert.ok(v[0].lonLat[1] < 60.17, "starts south of the threshold");
  assert.ok(v[0].agl > 400 && v[0].agl < 500, `glide path start height ${v[0].agl}`);
  assert.ok(v.some((p) => p.phase === "rollout"));
  // Ends at the stand lead-in end nearest the gate
  assert.deepEqual(v.at(-1).lonLat, [11.082, 60.19]);
  // Taxi route uses the network, never the other stand's lead-in
  assert.ok(plan.taxiways.includes("A") && plan.taxiways.includes("K"), plan.taxiways.join(","));
  assert.ok(!v.some((p) => p.ref === "stand 14"));
});

test("planArrival explains missing runway or gate", () => {
  assert.throws(() => planArrival(fixture(), { runway: "01R", gate: "A12" }), /Runway 01R not found.*01L, 19R/);
  assert.throws(() => planArrival(fixture({ withGate: false }), { runway: "01L", gate: "B7" }), /Gate B7 not found/);
});

test("planArrival falls back to a direct path when the network is disconnected", () => {
  const plan = planArrival(fixture({ connected: false }), { runway: "01L", gate: "A12" });
  assert.match(plan.warnings.join(" "), /No taxiway route/);
  assert.equal(plan.vertices.at(-1).phase, "taxi");
});

test("planArrival joins a stand lead-in that is not connected to the taxiway", () => {
  const layers = fixture();
  // Move the stand so its start lies 40 m beside taxiway K instead of on its node.
  const stand = layers.stand.find((s) => s.tags.ref === "12");
  stand.geometry.coordinates = [[11.0800, 60.19036], [11.0820, 60.1904]];
  const plan = planArrival(layers, { runway: "01L", gate: "A12" });
  assert.deepEqual(plan.warnings, []);
  assert.ok(plan.taxiways.includes("K"), plan.taxiways.join(","));
});

test("buildProfile gives realistic speeds and stops at the stand", () => {
  const plan = planArrival(fixture(), { runway: "01L", gate: "A12" });
  const profile = buildProfile(plan);
  const kt = (ms) => ms / 0.514444;
  assert.ok(Math.abs(kt(profile[0].v) - 145) < 1, `approach speed ${kt(profile[0].v)}`);
  const touchdown = profile.find((p) => p.phase === "rollout");
  assert.ok(kt(touchdown.v) > 125 && kt(touchdown.v) < 140, `touchdown ${kt(touchdown.v)} kt`);
  const rollout = profile.filter((p) => p.phase === "rollout");
  for (let i = 1; i < rollout.length; i++) assert.ok(rollout[i].v <= rollout[i - 1].v + 1e-9, "never speeds up on the runway");
  const taxi = profile.filter((p) => p.phase === "taxi");
  assert.ok(Math.max(...taxi.map((p) => kt(p.v))) <= 15.01, "taxi speed capped at 15 kt");
  assert.equal(profile.at(-1).v, 0);
  // Times strictly increase and the whole arrival takes a few minutes
  for (let i = 1; i < profile.length; i++) assert.ok(profile[i].t >= profile[i - 1].t);
  assert.ok(profile.at(-1).t > 180 && profile.at(-1).t < 900, `duration ${profile.at(-1).t}`);
  // Heading on final is ~north (runway 01)
  assert.ok(profile[10].heading < 10 || profile[10].heading > 350, `heading ${profile[10].heading}`);
});

test("sampleProfile interpolates and clamps", () => {
  const profile = buildProfile(planArrival(fixture(), { runway: "01L", gate: "A12" }));
  const mid = sampleProfile(profile, profile.at(-1).t / 2);
  assert.ok(mid.s > 0 && mid.s < profile.at(-1).s);
  assert.deepEqual(sampleProfile(profile, -5).lonLat, profile[0].lonLat);
  assert.deepEqual(sampleProfile(profile, 1e9).lonLat, profile.at(-1).lonLat);
});

test("generated aircraft model is a valid two-material GLB with 737-like dimensions", () => {
  const glb = createAircraftGlb({ accent: [0.6, 0, 0.05, 1] });
  const view = new DataView(glb);
  assert.equal(view.getUint32(0, true), 0x46546c67, "magic");
  assert.equal(view.getUint32(8, true), glb.byteLength, "length");
  const jsonLen = view.getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLen)));
  assert.equal(gltf.meshes[0].primitives.length, 2);
  assert.deepEqual(gltf.materials[1].pbrMetallicRoughness.baseColorFactor, [0.6, 0, 0.05, 1]);
  const pos = gltf.accessors.filter((a) => a.min);
  const min = [0, 1, 2].map((i) => Math.min(...pos.map((a) => a.min[i])));
  const max = [0, 1, 2].map((i) => Math.max(...pos.map((a) => a.max[i])));
  const span = max[0] - min[0];
  const length = max[2] - min[2];
  assert.ok(span > 34 && span < 42, `span ${span}`);
  assert.ok(length > 37 && length < 42, `length ${length}`);
  assert.ok(min[1] >= -0.01, "model stands on its wheels (nothing below the origin)");
});
