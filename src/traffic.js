// Renders live ADS-B aircraft as 3D models with smooth motion between position reports.
import {
  ArcType,
  CallbackProperty,
  CallbackPositionProperty,
  Cartesian2,
  Cartesian3,
  Color,
  ColorMaterialProperty,
  ConstantProperty,
  CustomDataSource,
  DistanceDisplayCondition,
  HeadingPitchRoll,
  HeightReference,
  LabelStyle,
  Math as CesiumMath,
  NearFarScalar,
  PolylineGlowMaterialProperty,
  ReferenceFrame,
  Transforms,
  VerticalOrigin,
} from "cesium";
import { FT, KT, heightAboveEllipsoid, isEmergencySquawk } from "./adsb.js";
import { aircraftModelUrl } from "./aircraftModel.js";

const STALE_MS = 60_000; // drop aircraft not heard from for a minute
const MAX_EXTRAPOLATION_S = 20; // don't dead-reckon further than this
const CORRECTION_MS = 1200; // how quickly a position jump is smoothed out
const TRAIL_POINTS = 60;
const M_PER_DEG = 111_320;

/** Altitude colour scale, similar in spirit to common ADS-B maps: low = orange, high = violet. */
export function altitudeColor(ac) {
  if (ac.onGround) return Color.fromCssColorString("#9aa3ad");
  const ft = ac.altGeomFt ?? ac.altBaroFt ?? 0;
  const t = Math.min(Math.max(ft / 40000, 0), 1);
  return Color.fromHsl((25 + t * 255) / 360, 0.85, 0.55);
}

const fmt = (v, digits = 0) => (v === undefined ? "–" : Number(v).toLocaleString("en-US", { maximumFractionDigits: digits }));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function labelText(ac) {
  const name = ac.callsign || ac.registration || ac.hex.toUpperCase();
  const alt = ac.onGround ? "GND" : `${fmt(ac.altBaroFt ?? ac.altGeomFt)} ft`;
  const spd = ac.groundSpeedKt !== undefined ? ` · ${fmt(ac.groundSpeedKt)} kt` : "";
  const emergency = ac.emergency || isEmergencySquawk(ac.squawk) ? "⚠ " : "";
  return `${emergency}${name}\n${alt}${spd}`;
}

function describe(ac) {
  const rows = [
    ["Callsign", ac.callsign],
    ["Registration", ac.registration],
    ["Type", [ac.type, ac.description].filter(Boolean).join(" – ")],
    ["ICAO 24-bit", ac.hex.toUpperCase()],
    ["Altitude (baro)", ac.onGround ? "On ground" : ac.altBaroFt !== undefined ? `${fmt(ac.altBaroFt)} ft` : ""],
    ["Altitude (GNSS)", ac.altGeomFt !== undefined ? `${fmt(ac.altGeomFt)} ft` : ""],
    ["Ground speed", ac.groundSpeedKt !== undefined ? `${fmt(ac.groundSpeedKt)} kt` : ""],
    ["Track", ac.trackDeg !== undefined ? `${fmt(ac.trackDeg)}°` : ""],
    ["Vertical rate", ac.verticalRateFpm !== undefined ? `${fmt(ac.verticalRateFpm)} ft/min` : ""],
    ["Squawk", ac.squawk + (isEmergencySquawk(ac.squawk) ? " (emergency)" : "")],
    ["Emergency", ac.emergency],
    ["Last position", `${Math.max(0, Math.round((Date.now() - ac.observedAt) / 1000))} s ago`],
  ].filter(([, v]) => v);
  const body = rows.map(([k, v]) => `<tr><th style="text-align:left;padding-right:12px">${esc(k)}</th><td>${esc(v)}</td></tr>`).join("");
  return `<table>${body}</table>
<p>Double-click the aircraft to follow it.
<a href="https://globe.adsb.lol/?icao=${esc(ac.hex)}" target="_blank" rel="noopener">Open on adsb.lol</a></p>`;
}

export class TrafficLayer {
  /**
   * @param viewer Cesium Viewer
   * @param options.heightOffset () => metres to subtract from ellipsoid heights. With flat terrain
   *   the airport sits at height 0, so real altitudes are shifted down by the field elevation.
   * @param options.geoidHeight geoid separation used to convert barometric (MSL) altitudes.
   */
  constructor(viewer, { heightOffset = () => 0, geoidHeight = 38, clampToTerrain = () => false } = {}) {
    this.viewer = viewer;
    this.heightOffset = heightOffset;
    this.geoidHeight = geoidHeight;
    this.clampToTerrain = clampToTerrain;
    this.source = new CustomDataSource("traffic");
    this.aircraft = new Map(); // hex -> state
    this.showTrails = true;
    this.modelUrl = aircraftModelUrl();
    viewer.dataSources.add(this.source);
  }

  set show(on) {
    this.source.show = on;
  }

  get show() {
    return this.source.show;
  }

  get count() {
    return this.aircraft.size;
  }

  /** Displayed position (lon, lat, height) of an aircraft at wall-clock time `now`. */
  predict(state, now) {
    const { ac } = state;
    const dt = Math.min(Math.max((now - ac.observedAt) / 1000, 0), MAX_EXTRAPOLATION_S);
    let { lon, lat } = ac;
    let h = state.baseHeight;
    if (ac.groundSpeedKt !== undefined && ac.trackDeg !== undefined) {
      const dist = ac.groundSpeedKt * KT * dt;
      const tr = CesiumMath.toRadians(ac.trackDeg);
      lat += (dist * Math.cos(tr)) / M_PER_DEG;
      lon += (dist * Math.sin(tr)) / (M_PER_DEG * Math.cos(CesiumMath.toRadians(lat)));
    }
    if (!ac.onGround && ac.verticalRateFpm !== undefined) h += (ac.verticalRateFpm * FT * dt) / 60;
    // Blend out the jump between the old prediction and the new report.
    const k = Math.exp(-(now - state.correctionStart) / CORRECTION_MS * 3);
    return [lon + state.err[0] * k, lat + state.err[1] * k, h + state.err[2] * k];
  }

  displayHeight(ac) {
    if (ac.onGround) return 0;
    const hae = heightAboveEllipsoid(ac, this.geoidHeight);
    if (hae === undefined) return 0;
    const h = hae - this.heightOffset();
    return this.clampToTerrain() ? h : Math.max(h, 0);
  }

  position(state, now = Date.now()) {
    const [lon, lat, h] = this.predict(state, now);
    return Cartesian3.fromDegrees(lon, lat, h);
  }

  orientation(state) {
    const { ac } = state;
    const pos = this.position(state);
    const track = ac.trackDeg ?? 0;
    const gs = (ac.groundSpeedKt ?? 0) * KT;
    const vr = ac.onGround ? 0 : ((ac.verticalRateFpm ?? 0) * FT) / 60;
    const pitch = gs > 20 ? Math.atan2(vr, gs) : 0;
    // Cesium's model heading 0 points east; ADS-B track 0 is north.
    return Transforms.headingPitchRollQuaternion(pos, new HeadingPitchRoll(CesiumMath.toRadians(track - 90), pitch, 0));
  }

  /** Apply a fresh batch of aircraft from the poller. */
  update(list) {
    const now = Date.now();
    const seen = new Set();
    for (const ac of list) {
      seen.add(ac.hex);
      let state = this.aircraft.get(ac.hex);
      if (!state) {
        state = { ac, baseHeight: this.displayHeight(ac), err: [0, 0, 0], correctionStart: now, trail: [], lastSeen: now };
        state.entity = this.createEntity(state);
        this.aircraft.set(ac.hex, state);
      } else {
        const before = this.predict(state, now);
        state.ac = ac;
        state.baseHeight = this.displayHeight(ac);
        state.err = [0, 0, 0];
        const after = this.predict(state, now);
        // Large jumps (bad data, long gaps) are applied immediately instead of smoothed.
        const jumpM = Math.hypot((before[0] - after[0]) * M_PER_DEG * 0.5, (before[1] - after[1]) * M_PER_DEG);
        state.err = jumpM < 2000 ? [before[0] - after[0], before[1] - after[1], before[2] - after[2]] : [0, 0, 0];
        state.correctionStart = now;
        state.lastSeen = now;
      }
      state.trail.push(Cartesian3.fromDegrees(ac.lon, ac.lat, state.baseHeight));
      if (state.trail.length > TRAIL_POINTS) state.trail.shift();
      this.refreshStyle(state);
    }
    for (const [hex, state] of this.aircraft) {
      if (!seen.has(hex) && now - state.lastSeen > STALE_MS) {
        if (this.viewer.trackedEntity === state.entity) this.viewer.trackedEntity = undefined;
        this.source.entities.remove(state.entity);
        if (state.trailEntity) this.source.entities.remove(state.trailEntity);
        this.aircraft.delete(hex);
      }
    }
  }

  createEntity(state) {
    const position = new CallbackPositionProperty((time, result) => {
      const p = this.position(state);
      return result ? Cartesian3.clone(p, result) : p;
    }, false, ReferenceFrame.FIXED);
    return this.source.entities.add({
      id: `aircraft-${state.ac.hex}`,
      name: state.ac.callsign || state.ac.hex.toUpperCase(),
      position,
      orientation: new CallbackProperty(() => this.orientation(state), false),
      description: new CallbackProperty(() => describe(state.ac), false),
      model: {
        uri: this.modelUrl,
        minimumPixelSize: 30,
        maximumScale: 400,
        color: new ConstantProperty(Color.WHITE),
        silhouetteColor: Color.BLACK.withAlpha(0.6),
        silhouetteSize: 1,
        heightReference: new ConstantProperty(HeightReference.NONE),
      },
      label: {
        text: new ConstantProperty(""),
        font: "600 12px system-ui, sans-serif",
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK.withAlpha(0.85),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -22),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new DistanceDisplayCondition(0, 80_000),
        scaleByDistance: new NearFarScalar(1000, 1, 60_000, 0.75),
      },
      // Vertical line to the ground: makes altitude readable in 3D.
      polyline: {
        positions: new CallbackProperty(() => {
          const [lon, lat, h] = this.predict(state, Date.now());
          return [Cartesian3.fromDegrees(lon, lat, h), Cartesian3.fromDegrees(lon, lat, 0)];
        }, false),
        width: 1,
        arcType: ArcType.NONE,
        material: new ColorMaterialProperty(Color.WHITE.withAlpha(0.35)),
        show: new ConstantProperty(false),
      },
    });
  }

  refreshStyle(state) {
    const { ac, entity } = state;
    const color = altitudeColor(ac);
    const emergency = ac.emergency || isEmergencySquawk(ac.squawk);
    entity.name = ac.callsign || ac.registration || ac.hex.toUpperCase();
    entity.model.color.setValue(emergency ? Color.RED : color);
    entity.model.heightReference.setValue(ac.onGround ? HeightReference.CLAMP_TO_GROUND : HeightReference.NONE);
    entity.label.text.setValue(labelText(ac));
    entity.label.fillColor = emergency ? Color.fromCssColorString("#ff6b6b") : Color.WHITE;
    // With real terrain the drop line would end at the ellipsoid, below ground: only draw it on flat terrain.
    entity.polyline.show.setValue(!ac.onGround && !this.clampToTerrain());

    if (!state.trailEntity) {
      state.trailEntity = this.source.entities.add({
        polyline: {
          positions: new CallbackProperty(() => [...state.trail, this.position(state)], false),
          width: 3,
          arcType: ArcType.NONE,
          material: new PolylineGlowMaterialProperty({ color: color.withAlpha(0.7), glowPower: 0.15 }),
          show: new CallbackProperty(() => this.showTrails && state.trail.length > 1 && !state.ac.onGround, false),
        },
      });
    } else {
      state.trailEntity.polyline.material.color = color.withAlpha(0.7);
    }
  }

  clear() {
    this.source.entities.removeAll();
    this.aircraft.clear();
  }

  /** Aircraft sorted by distance from a point, for the side panel list. */
  nearest(lon, lat, limit = 8) {
    const cosLat = Math.cos(CesiumMath.toRadians(lat));
    return [...this.aircraft.values()]
      .map((s) => ({ s, d: Math.hypot((s.ac.lon - lon) * cosLat, s.ac.lat - lat) * M_PER_DEG }))
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map(({ s, d }) => ({ ac: s.ac, entity: s.entity, distanceKm: d / 1000 }));
  }
}
