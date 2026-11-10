// Generates a simple low-poly airliner as a binary glTF (GLB) in memory, so the app needs no
// external model file. Sized like a Boeing 737-800 (39.5 m long, 35.8 m span). Two materials:
// `body` (fuselage, wings, engines) and `accent` (nose and tail fin), so a simple paint scheme can
// be applied.
//
// Shapes are written in (forward, left, up) metres and converted to glTF axes
// (+Y up, +Z forward, +X left), which Cesium turns into its own X-forward/Z-up frame.

function loft(stations, segments, out, map = (f, l, u) => [f, l, u]) {
  // stations: [{ f, r, u, l }] cross-sections along the forward axis
  const rings = stations.map(({ f, r, u = 0, l = 0 }) =>
    Array.from({ length: segments }, (_, k) => {
      const a = (k / segments) * Math.PI * 2;
      return map(f, l + Math.cos(a) * r, u + Math.sin(a) * r);
    }),
  );
  for (let s = 0; s < rings.length - 1; s++) {
    for (let k = 0; k < segments; k++) {
      const a = rings[s][k], b = rings[s][(k + 1) % segments], c = rings[s + 1][(k + 1) % segments], d = rings[s + 1][k];
      out.push(a, b, c, a, c, d);
    }
  }
  // End caps
  for (const [ring, reverse] of [[rings[0], true], [rings[rings.length - 1], false]]) {
    const center = ring.reduce((acc, p) => acc.map((v, i) => v + p[i] / ring.length), [0, 0, 0]);
    for (let k = 0; k < segments; k++) {
      const a = ring[k], b = ring[(k + 1) % segments];
      out.push(...(reverse ? [center, b, a] : [center, a, b]));
    }
  }
}

/** Extrude a convex outline (list of [x, y] in a plane) by `thickness` along that plane's normal. */
function slab(outline, toWorld, thickness, out) {
  const top = outline.map(([x, y]) => toWorld(x, y, thickness / 2));
  const bottom = outline.map(([x, y]) => toWorld(x, y, -thickness / 2));
  for (let i = 1; i < outline.length - 1; i++) {
    out.push(top[0], top[i], top[i + 1]);
    out.push(bottom[0], bottom[i + 1], bottom[i]);
  }
  for (let i = 0; i < outline.length; i++) {
    const j = (i + 1) % outline.length;
    out.push(top[i], bottom[i], bottom[j], top[i], bottom[j], top[j]);
  }
}

function buildParts() {
  const body = [];
  const accent = [];
  // Fuselage, nose at +forward. The nose section is a separate part for the accent colour.
  loft(
    [
      { f: 19.6, r: 0.25, u: -0.3 },
      { f: 18.2, r: 1.2, u: -0.2 },
      { f: 15.5, r: 1.95, u: 0 },
    ],
    12,
    accent,
  );
  loft(
    [
      { f: 15.5, r: 1.95, u: 0 },
      { f: -10, r: 1.95, u: 0 },
      { f: -16, r: 1.3, u: 0.6 },
      { f: -19.4, r: 0.35, u: 1.4 },
    ],
    12,
    body,
  );
  for (const side of [1, -1]) {
    // Wings (low-mounted, swept, with dihedral)
    slab(
      [[4.5, 1.6], [-3.5, 1.6], [-9.5, 17.9], [-6.8, 17.9]],
      (f, l, t) => [f, side * l, -1.0 + (l - 1.6) * 0.09 + t],
      0.45,
      body,
    );
    // Winglets
    slab([[-6.9, 17.8], [-9.4, 17.8], [-10.4, 20.0], [-9.3, 20.0]], (f, u, t) => [f, side * (17.9 + t), 0.47 + (u - 17.8)], 0.2, accent);
    // Horizontal stabiliser
    slab(
      [[-14.8, 1.0], [-18.6, 1.0], [-19.6, 6.6], [-17.8, 6.6]],
      (f, l, t) => [f, side * l, 1.2 + (l - 1.0) * 0.06 + t],
      0.3,
      body,
    );
    // Engine nacelle under each wing
    loft(
      [
        { f: 5.8, r: 0.9, l: side * 5.8, u: -2.1 },
        { f: 5.2, r: 1.05, l: side * 5.8, u: -2.1 },
        { f: 1.6, r: 0.95, l: side * 5.8, u: -2.1 },
        { f: 0.9, r: 0.55, l: side * 5.8, u: -2.1 },
      ],
      10,
      body,
    );
  }
  // Vertical fin, in the forward/up plane
  slab([[-13.6, 1.6], [-18.8, 1.6], [-20.2, 8.4], [-18.3, 8.4]], (f, u, t) => [f, t, u], 0.35, accent);
  return { body, accent };
}

// (forward, left, up) -> glTF (x = left, y = up, z = forward). The model origin is lifted to wheel
// level, so an aircraft placed on the ground stands on it instead of sinking in.
const GEAR_HEIGHT = 3.4;
const toGltf = ([f, l, u]) => [l, u + GEAR_HEIGHT, f];

/** Flat-shaded positions and normals for a triangle list. */
function attributes(tris) {
  const count = tris.length;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < count; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]].map(toGltf);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const length = Math.hypot(...n) || 1;
    n = n.map((v) => v / length);
    [a, b, c].forEach((p, k) => {
      positions.set(p, (t + k) * 3);
      normals.set(n, (t + k) * 3);
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], p[i]);
        max[i] = Math.max(max[i], p[i]);
      }
    });
  }
  return { count, positions, normals, min, max };
}

/**
 * Build the GLB and return it as an ArrayBuffer.
 * @param colors.body / colors.accent  linear RGBA base colours (0..1)
 */
export function createAircraftGlb({ body = [1, 1, 1, 1], accent = [1, 1, 1, 1] } = {}) {
  const parts = buildParts();
  const gltf = {
    asset: { version: "2.0", generator: "oslo-airport-3d" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [] }],
    materials: [],
    buffers: [{ byteLength: 0 }],
    bufferViews: [],
    accessors: [],
  };
  const chunks = [];
  let offset = 0;
  const addView = (array) => {
    gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: array.byteLength, target: 34962 });
    chunks.push(new Uint8Array(array.buffer));
    offset += array.byteLength;
    return gltf.bufferViews.length - 1;
  };
  for (const [name, color] of [["body", body], ["accent", accent]]) {
    const a = attributes(parts[name]);
    const pos = gltf.accessors.push({ bufferView: addView(a.positions), componentType: 5126, count: a.count, type: "VEC3", min: a.min, max: a.max }) - 1;
    const nor = gltf.accessors.push({ bufferView: addView(a.normals), componentType: 5126, count: a.count, type: "VEC3" }) - 1;
    const material = gltf.materials.push({ name, pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0.15, roughnessFactor: 0.5 }, doubleSided: true }) - 1;
    gltf.meshes[0].primitives.push({ attributes: { POSITION: pos, NORMAL: nor }, material, mode: 4 });
  }
  gltf.buffers[0].byteLength = offset;

  const pad = (n) => (4 - (n % 4)) % 4;
  let json = new TextEncoder().encode(JSON.stringify(gltf));
  json = Uint8Array.from([...json, ...new Array(pad(json.length)).fill(0x20)]);
  const bin = new Uint8Array(offset + pad(offset));
  let o = 0;
  for (const c of chunks) {
    bin.set(c, o);
    o += c.byteLength;
  }

  const total = 12 + 8 + json.length + 8 + bin.length;
  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, json.length, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  bytes.set(json, 20);
  const binStart = 20 + json.length;
  view.setUint32(binStart, bin.length, true);
  view.setUint32(binStart + 4, 0x004e4942, true); // "BIN\0"
  bytes.set(bin, binStart + 8);
  return out;
}

const urls = new Map();
/** Object URL for a generated model with the given colours, created once per colour scheme. */
export function aircraftModelUrl(colors = {}) {
  const k = JSON.stringify(colors);
  if (!urls.has(k)) urls.set(k, URL.createObjectURL(new Blob([createAircraftGlb(colors)], { type: "model/gltf-binary" })));
  return urls.get(k);
}
