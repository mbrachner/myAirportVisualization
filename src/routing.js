// Plans a scripted arrival: final approach to a runway, landing rollout, and taxi to a gate along
// the OpenStreetMap taxiway network. Pure geometry, no Cesium dependency (unit-tested in Node).

const M_PER_DEG = 111_320;
const KT = 0.514444;

/** Local flat projection in metres around a reference point (fine at airport scale). */
function projector([lon0, lat0]) {
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  return {
    toXY: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * M_PER_DEG],
    toLonLat: ([x, y]) => [lon0 + x / kx, lat0 + y / M_PER_DEG],
  };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);
const key = ([lon, lat]) => `${lon.toFixed(7)},${lat.toFixed(7)}`;
const norm = (s) => String(s ?? "").replace(/\s+/g, "").toUpperCase();

/**
 * Undirected graph of taxiways and taxilanes (plus the target stand's lead-in line, so routes
 * never cut through other stands). Ways connect where they share OSM nodes.
 */
export function buildTaxiGraph(layers, proj, targetStand) {
  const nodes = new Map();
  const node = (c) => {
    const k = key(c);
    let n = nodes.get(k);
    if (!n) nodes.set(k, (n = { key: k, lonLat: c, xy: proj.toXY(c), edges: [] }));
    return n;
  };
  const addLine = (coords, ref) => {
    for (let i = 0; i < coords.length - 1; i++) {
      const a = node(coords[i]);
      const b = node(coords[i + 1]);
      if (a === b) continue;
      const w = len(sub(a.xy, b.xy));
      a.edges.push({ to: b, w, ref });
      b.edges.push({ to: a, w, ref });
    }
  };
  for (const f of layers.taxiway) {
    if (f.geometry.type === "LineString") addLine(f.geometry.coordinates, f.tags.ref ?? f.tags.name ?? "");
  }
  if (targetStand?.geometry.type === "LineString") {
    addLine(targetStand.geometry.coordinates, `stand ${targetStand.tags.ref ?? ""}`.trim());
  }
  return nodes;
}

/**
 * Connect `node` to the closest taxiway segment within `maxDist` metres by splitting that segment.
 * OSM stand lead-in lines are not always joined to the taxilane they start from.
 */
function snapToNetwork(graph, node, proj, maxDist = 150) {
  let best;
  const seen = new Set();
  for (const a of graph.values()) {
    for (const e of a.edges) {
      const b = e.to;
      const pair = a.key < b.key ? a.key + b.key : b.key + a.key;
      if (seen.has(pair) || a === node || b === node || e.ref.startsWith("stand")) continue;
      seen.add(pair);
      const ab = sub(b.xy, a.xy);
      const f = Math.max(0, Math.min(1, dot(sub(node.xy, a.xy), ab) / (dot(ab, ab) || 1)));
      const p = add(a.xy, mul(ab, f));
      const d = len(sub(node.xy, p));
      if (d < maxDist && (!best || d < best.d)) best = { a, b, e, f, p, d };
    }
  }
  if (!best) return false;
  const { a, b, e, f, p, d } = best;
  let joint = f < 1e-6 ? a : f > 1 - 1e-6 ? b : undefined;
  if (!joint) {
    // Split a-b at p. If the node already lies on the segment, splice the node itself in.
    if (d < 0.5) {
      joint = node;
    } else {
      const lonLat = proj.toLonLat(p);
      joint = { key: key(lonLat), lonLat, xy: p, edges: [] };
      graph.set(joint.key, joint);
    }
    a.edges = a.edges.filter((x) => x.to !== b);
    b.edges = b.edges.filter((x) => x.to !== a);
    for (const [u, v] of [[a, joint], [joint, b]]) {
      const w = len(sub(u.xy, v.xy));
      u.edges.push({ to: v, w, ref: e.ref });
      v.edges.push({ to: u, w, ref: e.ref });
    }
  }
  if (joint !== node) {
    node.edges.push({ to: joint, w: d, ref: "" });
    joint.edges.push({ to: node, w: d, ref: "" });
  }
  return true;
}

/** Dijkstra from `source` over the whole graph. Returns distance and predecessor maps. */
function shortestPaths(source) {
  const dist = new Map([[source, 0]]);
  const prev = new Map();
  const done = new Set();
  // Small graphs (hundreds to a few thousand nodes): a sorted array is fast enough.
  const queue = [source];
  while (queue.length) {
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (dist.get(queue[i]) < dist.get(queue[best])) best = i;
    const n = queue.splice(best, 1)[0];
    if (done.has(n)) continue;
    done.add(n);
    for (const e of n.edges) {
      const d = dist.get(n) + e.w;
      if (d < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, d);
        prev.set(e.to, { node: n, ref: e.ref });
        queue.push(e.to);
      }
    }
  }
  return { dist, prev };
}

function findRunwayEnd(layers, designator) {
  for (const f of layers.runway) {
    for (const end of f.ends ?? []) if (norm(end.designator) === norm(designator)) return end;
  }
  const known = layers.runway.flatMap((f) => (f.ends ?? []).map((e) => e.designator));
  throw new Error(`Runway ${designator} not found in the map data${known.length ? ` (found ${known.join(", ")})` : ""}.`);
}

function findGate(layers, ref, proj) {
  const gate = layers.gate.find((g) => norm(g.tags.ref) === norm(ref));
  const standByRef = layers.stand.find((s) => norm(s.tags.ref) === norm(ref));
  if (!gate && !standByRef) {
    const sample = layers.gate.map((g) => g.tags.ref).filter(Boolean).slice(0, 8);
    throw new Error(`Gate ${ref} not found in the map data${sample.length ? ` (e.g. ${sample.join(", ")})` : ""}.`);
  }
  const anchor = gate ? gate.geometry.coordinates : null;
  const standPos = (s) => (s.geometry.type === "Point" ? s.geometry.coordinates : s.labelPosition ?? s.geometry.coordinates.at(-1));
  let stand = standByRef;
  if (!stand && anchor) {
    // Stand numbered like the gate ("A12" -> "12"), else the closest stand within 200 m.
    const digits = norm(ref).replace(/^[A-Z]+/, "");
    stand = layers.stand.find((s) => norm(s.tags.ref) === digits);
    if (!stand) {
      let best = 200;
      for (const s of layers.stand) {
        const d = len(sub(proj.toXY(standPos(s)), proj.toXY(anchor)));
        if (d < best) [best, stand] = [d, s];
      }
    }
  }
  return { gate, stand, anchor: anchor ?? standPos(stand) };
}

/**
 * Plan the arrival. Returns the path as vertices { lonLat, agl, phase, ref } plus metadata.
 * Throws an Error with a readable message if the runway or gate is missing from the data.
 */
export function planArrival(layers, { runway = "01L", gate = "A12", approachLength = 9000, glideDeg = 3, thresholdCrossingHeight = 15, touchdown = 400 } = {}) {
  const end = findRunwayEnd(layers, runway);
  const proj = projector(end.position);
  const thr = proj.toXY(end.position);
  const runwayVec = sub(proj.toXY(end.opposite), thr);
  const runwayLength = len(runwayVec);
  const u = mul(runwayVec, 1 / runwayLength);
  const along = (p) => thr.map((v, i) => v + u[i] * p);
  const warnings = [];

  const { gate: gateFeature, stand, anchor } = findGate(layers, gate, proj);

  // Stand lead-in: drive along it and stop at the end nearest the gate.
  let standLine = [];
  if (stand?.geometry.type === "LineString") {
    standLine = stand.geometry.coordinates.slice();
    const dFirst = len(sub(proj.toXY(standLine[0]), proj.toXY(anchor)));
    const dLast = len(sub(proj.toXY(standLine.at(-1)), proj.toXY(anchor)));
    if (dFirst < dLast) standLine.reverse();
  } else if (stand) {
    standLine = [stand.geometry.coordinates];
  } else {
    warnings.push(`No aircraft stand found near gate ${gate}; parking at the gate position.`);
    standLine = [anchor];
  }
  const stopPoint = standLine.at(-1);

  // Taxi graph and the node where the stand connects to it
  const graph = buildTaxiGraph(layers, proj, stand);
  const nodes = [...graph.values()];
  let entry = standLine.length > 1 ? graph.get(key(standLine[0])) : undefined;
  // Lead-in start not shared with any taxiway: join it to the nearest taxiway segment.
  if (entry && entry.edges.every((e) => e.ref.startsWith("stand")) && !snapToNetwork(graph, entry, proj)) {
    warnings.push(`The stand for gate ${gate} is not connected to a taxiway in the map data.`);
  }
  if (!entry || !entry.edges.length) {
    let best = Infinity;
    for (const n of nodes) {
      const d = len(sub(n.xy, proj.toXY(stopPoint)));
      if (n.edges.length && d < best) [best, entry] = [d, n];
    }
  }

  const vertices = [];
  const push = (xy, agl, phase, ref = "") => vertices.push({ lonLat: proj.toLonLat(xy), agl, phase, ref });

  // Final approach on the extended centre line, down to the threshold crossing height.
  const glide = Math.tan((glideDeg * Math.PI) / 180);
  for (const d of [approachLength, approachLength * 0.6, 3000, 1000]) {
    if (d <= approachLength) push(along(-d), d * glide + thresholdCrossingHeight, "approach");
  }
  push(thr, thresholdCrossingHeight, "approach");
  push(along(touchdown), 0, "rollout");

  // Pick the runway exit with the lowest estimated time: rollout (~30 m/s average) + taxi (~7 m/s).
  let exit;
  if (entry) {
    const { dist, prev } = shortestPaths(entry);
    let bestCost = Infinity;
    for (const n of nodes) {
      const rel = sub(n.xy, thr);
      const s = dot(rel, u);
      const offset = Math.abs(rel[0] * u[1] - rel[1] * u[0]);
      if (offset > 75 || s < touchdown + 1100 || s > runwayLength - 100) continue;
      const taxi = dist.get(n);
      if (taxi === undefined) continue;
      const cost = s / 30 + taxi / 7;
      if (cost < bestCost) [bestCost, exit] = [cost, { node: n, s }];
    }
    if (exit) {
      push(along(exit.s), 0, "rollout");
      // Follow predecessors from the exit back to the stand entry (Dijkstra ran from the entry).
      let n = exit.node;
      const refs = [];
      push(n.xy, 0, "taxi");
      while (n !== entry) {
        const p = prev.get(n);
        if (p.ref && p.ref !== refs.at(-1) && !p.ref.startsWith("stand")) refs.push(p.ref);
        n = p.node;
        push(n.xy, 0, "taxi", p.ref);
      }
      for (const c of standLine.slice(1)) push(proj.toXY(c), 0, "stand", `stand ${stand?.tags.ref ?? ""}`.trim());
      return finish(refs);
    }
  }

  // No usable taxiway network: roll out, then drive directly to the stand.
  warnings.push(`No taxiway route from runway ${runway} to gate ${gate} in the map data; using a direct path.`);
  const s = Math.min(touchdown + 1500, runwayLength - 100);
  push(along(s), 0, "rollout");
  push(proj.toXY(stopPoint), 0, "taxi");
  return finish([]);

  function finish(taxiways) {
    // Remove consecutive duplicates (e.g. exit node on the centre line).
    const clean = vertices.filter((v, i) => i === 0 || key(v.lonLat) !== key(vertices[i - 1].lonLat));
    return {
      vertices: clean,
      runway: end.designator,
      gate: gateFeature?.tags.ref ?? gate,
      stand: stand?.tags.ref,
      taxiways,
      warnings,
    };
  }
}

/**
 * Turn path vertices into a time-stamped motion profile. `groundHeights[i]` is the ground height
 * (m above ellipsoid) at vertex i. Speeds follow realistic limits: ~145 kt on final, braking on the
 * runway, 15 kt taxi, slower in turns, stopping with the nose at the stand.
 */
export function buildProfile(plan, groundHeights = plan.vertices.map(() => 0), { step = 5, noseOffset = 18 } = {}) {
  const proj = projector(plan.vertices[0].lonLat);
  const V = plan.vertices.map((v, i) => ({ ...v, xy: proj.toXY(v.lonLat), ground: groundHeights[i] ?? 0 }));

  // Stop with the nose, not the aircraft's centre, at the stand.
  const last = V.at(-1);
  const before = V.at(-2);
  const lastLen = len(sub(last.xy, before.xy));
  if (lastLen > noseOffset + 1) last.xy = add(before.xy, mul(sub(last.xy, before.xy), (lastLen - noseOffset) / lastLen));

  // Speed limits per vertex: turns slow the aircraft down while taxiing.
  const turnLimit = V.map((v, i) => {
    if (i === 0 || i === V.length - 1 || v.phase === "approach") return Infinity;
    const a = sub(v.xy, V[i - 1].xy);
    const b = sub(V[i + 1].xy, v.xy);
    const cos = dot(a, b) / ((len(a) * len(b)) || 1);
    const angle = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (angle < 15) return Infinity;
    return Math.max(4 * KT, 15 * KT * (1 - angle / 150)); // 90° turn ≈ 6 kt
  });

  // Densify
  const S = [];
  let s = 0;
  for (let i = 0; i < V.length - 1; i++) {
    const a = V[i];
    const b = V[i + 1];
    const d = len(sub(b.xy, a.xy));
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      S.push({
        xy: add(a.xy, mul(sub(b.xy, a.xy), f)),
        agl: a.agl + (b.agl - a.agl) * f,
        ground: a.ground + (b.ground - a.ground) * f,
        // Threshold -> touchdown is still airborne (the flare).
        phase: a.phase === "approach" ? "approach" : b.phase,
        ref: b.ref,
        s: s + d * f,
        vmax: k === 0 ? turnLimit[i] : Infinity,
      });
    }
    s += d;
  }
  S.push({ ...V.at(-1), s, vmax: 0 });

  const phaseMax = { approach: 145 * KT, rollout: 140 * KT, taxi: 15 * KT, stand: 5 * KT };
  const touchdownS = S.find((p) => p.phase === "rollout" && p.agl === 0)?.s ?? 0;
  for (const p of S) {
    let vmax = Math.min(p.vmax, phaseMax[p.phase] ?? 15 * KT);
    if (p.phase === "approach") vmax = Math.min(vmax, 135 * KT + (10 * KT * Math.min(1, (touchdownS - p.s) / 9000)));
    p.v = vmax;
  }
  // Rollout must be down to taxi speed (≤ 20 kt) where the aircraft turns off the runway.
  const lastRollout = S.findLastIndex((p) => p.phase === "rollout");
  if (lastRollout >= 0) S[lastRollout].v = Math.min(S[lastRollout].v, 20 * KT);

  // Backward pass: braking limits. Forward pass: acceleration limits.
  for (let i = S.length - 2; i >= 0; i--) {
    const ds = S[i + 1].s - S[i].s;
    const decel = S[i].phase === "rollout" ? 2.2 : S[i].phase === "approach" ? 1.5 : 1.0;
    S[i].v = Math.min(S[i].v, Math.sqrt(S[i + 1].v ** 2 + 2 * decel * ds));
  }
  for (let i = 1; i < S.length; i++) {
    const ds = S[i].s - S[i - 1].s;
    // No acceleration after touchdown: the aircraft only brakes on the runway.
    const accel = S[i].phase === "approach" ? 1.5 : S[i].phase === "rollout" ? 0 : 0.6;
    S[i].v = Math.min(S[i].v, Math.sqrt(S[i - 1].v ** 2 + 2 * accel * ds));
  }

  // Time stamps and smoothed headings
  let t = 0;
  for (let i = 0; i < S.length; i++) {
    if (i > 0) t += (S[i].s - S[i - 1].s) / Math.max((S[i].v + S[i - 1].v) / 2, 0.3);
    S[i].t = t;
  }
  for (let i = 0; i < S.length; i++) {
    const a = S[Math.max(0, i - 3)].xy;
    const b = S[Math.min(S.length - 1, i + 3)].xy;
    const d = sub(b, a);
    S[i].heading = len(d) > 0.1 ? ((Math.atan2(d[0], d[1]) * 180) / Math.PI + 360) % 360 : S[i - 1]?.heading ?? 0;
    S[i].lonLat = proj.toLonLat(S[i].xy);
  }
  return S.map(({ lonLat, agl, ground, phase, ref, s, v, t, heading }) => ({ lonLat, agl, ground, phase, ref, s, v, t, heading }));
}

/** Interpolated state at time t (seconds) along a profile. */
export function sampleProfile(profile, t) {
  if (t <= 0) return profile[0];
  if (t >= profile.at(-1).t) return profile.at(-1);
  let lo = 0;
  let hi = profile.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (profile[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = profile[lo];
  const b = profile[hi];
  const f = (t - a.t) / (b.t - a.t || 1);
  const lerp = (x, y) => x + (y - x) * f;
  let dh = b.heading - a.heading;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return {
    lonLat: [lerp(a.lonLat[0], b.lonLat[0]), lerp(a.lonLat[1], b.lonLat[1])],
    agl: lerp(a.agl, b.agl),
    ground: lerp(a.ground, b.ground),
    v: lerp(a.v, b.v),
    heading: (a.heading + dh * f + 360) % 360,
    phase: a.phase,
    ref: a.ref,
    s: lerp(a.s, b.s),
    t,
  };
}
