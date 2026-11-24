// Domestic air traffic between Norwegian airports, drawn as GPU particle streams on ballistic arcs.
//
// One custom primitive issues two draw calls with the same shader program:
//   - particles: GL points, each a glowing dot with a short fading tail. The vertex shader moves
//     it along its route's arc from the elapsed time alone, so animating costs no CPU work at all.
//   - guide lines: faint GL lines along every arc (the same shader, with t fixed per vertex).
// The number of particles on a route is proportional to the chosen traffic metric, so busier
// routes look denser and brighter. The arc maths is mirrored in traffic.js (arcPoint).
import {
  BlendingState,
  BoundingSphere,
  Buffer,
  BufferUsage,
  Cartesian3,
  Color,
  ComponentDatatype,
  DrawCommand,
  Entity,
  LabelCollection,
  LabelStyle,
  Matrix4,
  NearFarScalar,
  Pass,
  PointPrimitiveCollection,
  PrimitiveType,
  RenderState,
  ShaderProgram,
  VertexArray,
  VerticalOrigin,
  Cartesian2,
  CallbackProperty,
} from "cesium";
import { ARC, apexHeight, arcPoint, distance, flightSeconds } from "./traffic.js";

export const METRICS = {
  seats: { label: "Seats offered, last 12 months", unit: "seats" },
  flights: { label: "Flights, last 12 months", unit: "flights" },
  passengers: { label: "Passengers, 2019", unit: "passengers" },
};

const TRAIL = 5; // points per particle: the head plus a fading tail
const TRAIL_STEP = 0.0065; // tail spacing, in fractions of the route
const LINE_SEGMENTS = 48;
const MAX_HEADS = 260; // particles on the busiest route
const RAMP = ["#2fb8d6", "#4f8dff", "#b06cff", "#ff7a59", "#ffc36b"].map((c) => Color.fromCssColorString(c));

/** Colour for a value in [0, 1] (log-scaled traffic), interpolated along RAMP. */
function rampColor(x) {
  const f = Math.min(Math.max(x, 0), 1) * (RAMP.length - 1);
  const i = Math.min(Math.floor(f), RAMP.length - 2);
  return Color.lerp(RAMP[i], RAMP[i + 1], f - i, new Color());
}

const ATTRIBUTES = { a_start: 0, a_end: 1, a_arc: 2, a_anim: 3, a_color: 4 };
const SIZES = { a_start: 3, a_end: 3, a_arc: 2, a_anim: 4, a_color: 4 };

const VS = /* glsl */ `
in vec3 a_start;   // Earth-centred position of the origin airport, m
in vec3 a_end;     // ... of the destination
in vec2 a_arc;     // apex height (m), flight time (s; 0 = static guide-line vertex)
in vec4 a_anim;    // phase or fixed t, trail index, point size (px), alpha
in vec4 a_color;

uniform float u_time;
uniform float u_heightScale;
uniform float u_side;
uniform float u_sizeScale;
uniform vec3 u_center;

out vec4 v_color;

void main() {
  float flight = a_arc.y;
  float trail = a_anim.y;
  float t = flight > 0.0 ? fract(a_anim.x + u_time / flight) - trail * ${TRAIL_STEP.toFixed(5)} : a_anim.x;
  float visible = step(0.0, t);
  t = clamp(t, 0.0, 1.0);

  // Ballistic arc: chord pushed back out to the surface, plus a parabola h = 4·apex·t·(1 − t),
  // plus a sideways bulge to the right of travel. Keep in sync with arcPoint() in traffic.js.
  vec3 chord = mix(a_start, a_end, t);
  vec3 up = normalize(chord);
  float surface = mix(length(a_start), length(a_end), t);
  float h = 4.0 * a_arc.x * t * (1.0 - t) * u_heightScale;
  vec3 right = normalize(cross(a_end - a_start, up));
  vec3 p = up * (surface + h) + right * (u_side * h) - u_center;

  gl_Position = czm_modelViewProjection * vec4(p, 1.0);

  // Fade in after take-off and out before landing; tails fade towards their end.
  float ends = smoothstep(0.0, 0.035, t) * smoothstep(1.0, 0.965, t);
  float tail = 1.0 - trail / ${TRAIL.toFixed(1)};
  float alpha = flight > 0.0 ? a_color.a * ends * tail * tail * visible : a_color.a;
  v_color = vec4(a_color.rgb, alpha * a_anim.w);
  gl_PointSize = max(1.0, a_anim.z * u_sizeScale * (0.45 + 0.55 * tail)) * czm_pixelRatio;
}
`;

const FS = /* glsl */ `
in vec4 v_color;
uniform float u_isLine;

void main() {
  if (u_isLine > 0.5) {
    out_FragColor = v_color;
    return;
  }
  // Soft round glow; with additive blending overlapping particles add up to a bright stream.
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c) * 4.0;
  if (d2 > 1.0) discard;
  float glow = exp(-d2 * 3.5);
  out_FragColor = vec4(v_color.rgb, v_color.a * glow);
}
`;

/** Custom Cesium primitive drawing the particles and guide lines. */
class FlowPrimitive {
  constructor() {
    this.show = true;
    this.showLines = true;
    this.time = 0;
    this.heightScale = 1;
    this.sizeScale = 1;
    this._data = undefined;
    this._dirty = false;
    this._commands = {};
    this._center = new Cartesian3();
    this._modelMatrix = Matrix4.clone(Matrix4.IDENTITY);
  }

  /** `particles` and `lines` are { arrays: { a_start: Float32Array, ... }, count } */
  setData(data) {
    this._data = data;
    this._dirty = true;
    Cartesian3.clone(data.center, this._center);
    Matrix4.fromTranslation(data.center, this._modelMatrix);
  }

  _createVertexArray(context, { arrays, count }) {
    if (!count) return undefined;
    const attributes = Object.entries(ATTRIBUTES).map(([name, index]) => ({
      index,
      vertexBuffer: Buffer.createVertexBuffer({ context, typedArray: arrays[name], usage: BufferUsage.STATIC_DRAW }),
      componentsPerAttribute: SIZES[name],
      componentDatatype: ComponentDatatype.FLOAT,
    }));
    return new VertexArray({ context, attributes });
  }

  _build(context) {
    this._destroyCommands();
    this._program ??= ShaderProgram.fromCache({
      context,
      vertexShaderSource: VS,
      fragmentShaderSource: FS,
      attributeLocations: ATTRIBUTES,
    });
    const renderState = (additive) =>
      RenderState.fromCache({
        depthTest: { enabled: true },
        depthMask: false,
        blending: additive ? BlendingState.ADDITIVE_BLEND : BlendingState.ALPHA_BLEND,
      });
    const uniforms = (isLine) => ({
      u_time: () => this.time,
      u_heightScale: () => this.heightScale,
      u_side: () => ARC.side,
      u_sizeScale: () => this.sizeScale,
      u_center: () => this._center,
      u_isLine: () => (isLine ? 1 : 0),
    });
    const make = (key, primitiveType, isLine) => {
      const vertexArray = this._createVertexArray(context, this._data[key]);
      if (!vertexArray) return;
      this._commands[key] = new DrawCommand({
        owner: this,
        vertexArray,
        primitiveType,
        shaderProgram: this._program,
        renderState: renderState(!isLine),
        uniformMap: uniforms(isLine),
        modelMatrix: this._modelMatrix,
        boundingVolume: this._data.boundingSphere,
        pass: Pass.OPAQUE, // drawn after the globe; blending is set by the render state
      });
    };
    make("lines", PrimitiveType.LINES, true);
    make("particles", PrimitiveType.POINTS, false);
  }

  update(frameState) {
    if (!this.show || !this._data) return;
    if (this._dirty) {
      this._build(frameState.context);
      this._dirty = false;
    }
    if (!frameState.passes.render) return;
    if (this.showLines && this._commands.lines) frameState.commandList.push(this._commands.lines);
    if (this._commands.particles) frameState.commandList.push(this._commands.particles);
  }

  _destroyCommands() {
    for (const c of Object.values(this._commands)) c.vertexArray?.destroy();
    this._commands = {};
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    this._destroyCommands();
    this._program?.destroy();
    this._program = undefined;
  }
}

const fmt = new Intl.NumberFormat("en-GB");
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * The traffic view: particle flows plus airport dots and labels, filterable by metric and airport.
 */
export class TrafficFlows {
  constructor(viewer, data) {
    this.viewer = viewer;
    this.data = data;
    this.metric = "seats";
    this.airport = ""; // ICAO code to show only its routes; "" for all
    this.speed = 1;
    this.playing = true;
    this.airports = new Map(data.airports.map((a) => [a.icao, { ...a, position: Cartesian3.fromDegrees(a.lon, a.lat, 0) }]));
    this.routes = data.routes
      .filter((r) => this.airports.has(r.from) && this.airports.has(r.to))
      .map((r) => {
        const d = distance(this.airports.get(r.from), this.airports.get(r.to));
        const apex = apexHeight(d);
        return { ...r, distance: d, apex, flight: flightSeconds(apex) };
      });

    this.flows = new FlowPrimitive();
    this.points = new PointPrimitiveCollection();
    this.labels = new LabelCollection();
    viewer.scene.primitives.add(this.flows);
    viewer.scene.primitives.add(this.points);
    viewer.scene.primitives.add(this.labels);

    this._onTick = () => {
      const now = performance.now();
      const dt = this._last === undefined ? 0 : Math.min((now - this._last) / 1000, 0.25);
      this._last = now;
      if (this.playing) this.flows.time += dt * this.speed;
    };
    viewer.clock.onTick.addEventListener(this._onTick);
    this.rebuild();
  }

  get show() {
    return this.flows.show;
  }

  set show(on) {
    this.flows.show = on;
    this.points.show = on;
    this.labels.show = on;
  }

  set showLines(on) {
    this.flows.showLines = on;
  }

  set heightScale(v) {
    this.flows.heightScale = v;
  }

  /** Routes with traffic for the current metric and airport filter. */
  visibleRoutes() {
    return this.routes.filter((r) => r[this.metric] > 0 && (!this.airport || r.from === this.airport || r.to === this.airport));
  }

  /** Both directions of each city pair summed, busiest first. */
  topPairs(n = 10) {
    const pairs = new Map();
    for (const r of this.visibleRoutes()) {
      const key = [r.from, r.to].sort().join("-");
      const p = pairs.get(key) ?? { a: r.from, b: r.to, value: 0, distance: r.distance };
      p.value += r[this.metric];
      pairs.set(key, p);
    }
    return [...pairs.values()].sort((x, y) => y.value - x.value).slice(0, n);
  }

  totals() {
    const routes = this.visibleRoutes();
    return { routes: routes.length, value: routes.reduce((s, r) => s + r[this.metric], 0) };
  }

  rebuild() {
    const routes = this.visibleRoutes();
    // Scale against the busiest route overall so filtering an airport keeps densities comparable.
    const max = Math.max(1, ...this.routes.map((r) => r[this.metric]));
    const logMax = Math.log10(max);
    const logMin = Math.log10(Math.max(1, max / 3000));

    // Particles per second arriving ∝ traffic: a route's particle count is its share of the busiest
    // route's traffic times its flight time relative to that route's.
    const busiest = this.routes.reduce((a, b) => (b[this.metric] > a[this.metric] ? b : a));
    let heads = 0;
    const plan = routes.map((r) => {
      const share = r[this.metric] / max;
      const n = Math.max(1, Math.round((MAX_HEADS * share * r.flight) / busiest.flight));
      heads += n;
      const level = (Math.log10(Math.max(1, r[this.metric])) - logMin) / (logMax - logMin);
      return { r, n, level, color: rampColor(level) };
    });

    const center = BoundingSphere.fromPoints([...this.airports.values()].map((a) => a.position)).center;
    const alloc = (count) => ({ count, arrays: Object.fromEntries(Object.keys(ATTRIBUTES).map((k) => [k, new Float32Array(count * SIZES[k])])) });
    const particles = alloc(heads * TRAIL);
    const lines = alloc(routes.length * LINE_SEGMENTS * 2);

    const put = (buf, i, r, anim, color) => {
      const a = this.airports.get(r.from).position;
      const b = this.airports.get(r.to).position;
      const A = buf.arrays;
      A.a_start.set([a.x, a.y, a.z], i * 3);
      A.a_end.set([b.x, b.y, b.z], i * 3);
      A.a_arc.set(anim.static ? [r.apex, 0] : [r.apex, r.flight], i * 2);
      A.a_anim.set([anim.t, anim.trail ?? 0, anim.size ?? 1, anim.alpha], i * 4);
      A.a_color.set([color.red, color.green, color.blue, 1], i * 4);
    };

    // Deterministic jitter so particles on a route don't move in lockstep but the layout is stable.
    let seed = 12345;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

    let pi = 0;
    let li = 0;
    const bounds = [];
    for (const { r, n, level, color } of plan) {
      const size = 2.5 + 3 * level;
      // Busy routes get many particles, so keep each one dimmer to avoid blowing out to white.
      const alpha = 0.5 - 0.25 * level;
      for (let k = 0; k < n; k++) {
        const phase = (k + rand() * 0.8) / n;
        for (let j = 0; j < TRAIL; j++) put(particles, pi++, r, { t: phase, trail: j, size, alpha }, color);
      }
      for (let s = 0; s < LINE_SEGMENTS; s++) {
        for (const t of [s / LINE_SEGMENTS, (s + 1) / LINE_SEGMENTS]) {
          put(lines, li++, r, { t, static: true, alpha: 0.08 + 0.22 * level }, color);
        }
      }
      const a = this.airports.get(r.from).position;
      const b = this.airports.get(r.to).position;
      for (const t of [0.25, 0.5, 0.75]) bounds.push(Cartesian3.fromArray(arcPoint([a.x, a.y, a.z], [b.x, b.y, b.z], r.apex * 2, t)));
    }
    bounds.push(...[...this.airports.values()].map((a) => a.position));
    this.flows.setData({ center, particles, lines, boundingSphere: BoundingSphere.fromPoints(bounds) });
    this._buildAirports(routes);
    this.particleCount = heads;
  }

  _buildAirports(routes) {
    this.points.removeAll();
    this.labels.removeAll();
    const totals = new Map();
    for (const r of routes) {
      for (const c of [r.from, r.to]) totals.set(c, (totals.get(c) ?? 0) + r[this.metric]);
    }
    const max = Math.max(1, ...totals.values());
    for (const [icao, value] of totals) {
      const a = this.airports.get(icao);
      const level = Math.sqrt(value / max);
      const id = this._airportEntity(a);
      const position = Cartesian3.fromDegrees(a.lon, a.lat, 300);
      this.points.add({
        position,
        pixelSize: 5 + 9 * level,
        color: Color.WHITE.withAlpha(0.95),
        outlineColor: Color.fromCssColorString("#0b1320"),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        id,
      });
      this.labels.add({
        position,
        text: a.name.split(" ")[0],
        font: `${level > 0.25 ? 600 : 500} 13px system-ui, sans-serif`,
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK.withAlpha(0.8),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -10),
        scaleByDistance: new NearFarScalar(3e5, 1.1, 4e6, 0.75),
        translucencyByDistance: level > 0.15 || icao === this.airport ? undefined : new NearFarScalar(1.2e6, 1, 2.5e6, 0),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        id,
      });
    }
  }

  /** A detached entity that gives the InfoBox the airport's name and traffic summary. */
  _airportEntity(a) {
    const describe = () => {
      const unit = METRICS[this.metric].unit;
      const out = this.routes.filter((r) => r.from === a.icao && r[this.metric] > 0).sort((x, y) => y[this.metric] - x[this.metric]);
      const inbound = this.routes.filter((r) => r.to === a.icao).reduce((s, r) => s + r[this.metric], 0);
      const total = out.reduce((s, r) => s + r[this.metric], 0);
      const rows = out
        .slice(0, 12)
        .map((r) => `<tr><td>${escapeHtml(this.airports.get(r.to).name)}</td><td style="text-align:right">${fmt.format(r[this.metric])}</td></tr>`)
        .join("");
      return `<p><b>${a.icao}</b> · ${escapeHtml(this.periodLabel())}</p>
        <p>Departing: <b>${fmt.format(total)}</b> ${unit}<br>Arriving: <b>${fmt.format(inbound)}</b> ${unit}<br>
        Domestic destinations: ${out.length}</p>
        <table style="width:100%"><tr><th style="text-align:left">Top destinations</th><th style="text-align:right">${unit}</th></tr>${rows}</table>
        <p style="font-size:11px;opacity:.7">Source: Statistics Norway (SSB), tables 08511/08509, CC BY 4.0.</p>`;
    };
    const e = new Entity({ name: `${a.name} (${a.icao})`, position: a.position, description: new CallbackProperty(describe, false) });
    e.icao = a.icao;
    return e;
  }

  periodLabel() {
    const s = this.data.sources;
    if (this.metric === "passengers") return `Passengers on board, ${s.passengers.year}`;
    const [from, to] = s.flightsSeats.period.map((m) => {
      const [y, mm] = m.split("M");
      return new Date(Date.UTC(+y, +mm - 1, 1)).toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
    });
    return `${from} – ${to}`;
  }

  destroy() {
    this.viewer.clock.onTick.removeEventListener(this._onTick);
    for (const p of [this.flows, this.points, this.labels]) this.viewer.scene.primitives.remove(p);
  }
}
