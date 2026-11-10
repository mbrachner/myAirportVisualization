// Animates one scripted arrival (approach, landing, taxi to the gate) along a planned profile.
import {
  ArcType,
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  ConstantProperty,
  CustomDataSource,
  DistanceDisplayCondition,
  HeadingPitchRoll,
  HorizontalOrigin,
  LabelStyle,
  Math as CesiumMath,
  NearFarScalar,
  PolylineDashMaterialProperty,
  ReferenceFrame,
  Transforms,
  VerticalOrigin,
} from "cesium";
import { sampleProfile } from "./routing.js";
import { aircraftModelUrl } from "./aircraftModel.js";

const FT = 0.3048;
const KT = 0.514444;

// White body with a red nose and tail: a simple scheme in the spirit of the airline's colours.
const LIVERY = { body: [0.95, 0.95, 0.95, 1], accent: [0.62, 0.02, 0.05, 1] };
const PARKED_HOLD_S = 30; // pause at the gate before the demo loops

export class ArrivalDemo {
  constructor(viewer, { callsign = "NAX741", type = "B738", operator = "Norwegian", fieldElevationMsl = 208 } = {}) {
    this.viewer = viewer;
    this.callsign = callsign;
    this.type = type;
    this.operator = operator;
    this.fieldElevationMsl = fieldElevationMsl;
    this.source = new CustomDataSource("arrival");
    viewer.dataSources.add(this.source);
    this.profile = undefined;
    this.plan = undefined;
    this.time = 0;
    this.speed = 1;
    this.playing = false;
    this.onPhase = undefined;
    this.lastPhaseText = "";

    viewer.scene.preRender.addEventListener(() => this.tick());
  }

  /** Load a new plan + profile and restart from the beginning. */
  load(plan, profile) {
    this.plan = plan;
    this.profile = profile;
    this.duration = profile.at(-1).t;
    this.time = 0;
    this.lastTick = undefined;
    this.source.entities.removeAll();
    this.createEntities();
  }

  play() {
    this.playing = true;
    this.lastTick = undefined;
  }

  pause() {
    this.playing = false;
  }

  restart() {
    this.time = 0;
    this.play();
  }

  set show(on) {
    this.source.show = on;
  }

  tick() {
    const now = performance.now();
    if (this.playing && this.profile && this.lastTick !== undefined) {
      this.time += ((now - this.lastTick) / 1000) * this.speed;
      // Hold at the gate for a while, then loop.
      if (this.time > this.duration + PARKED_HOLD_S) this.time = 0;
    }
    this.lastTick = now;
    if (this.profile && this.onPhase) {
      const text = this.statusText();
      if (text !== this.lastPhaseText) {
        this.lastPhaseText = text;
        this.onPhase(text);
      }
    }
  }

  state() {
    return sampleProfile(this.profile, Math.min(this.time, this.duration));
  }

  position(st = this.state()) {
    return Cartesian3.fromDegrees(st.lonLat[0], st.lonLat[1], st.ground + st.agl);
  }

  orientation() {
    const st = this.state();
    // Approach attitude ~2.5° nose up, flare to ~5° just before touchdown, level on the ground.
    let pitch = 0;
    if (st.phase === "approach") pitch = st.agl < 12 ? 5 : 2.5;
    const hpr = new HeadingPitchRoll(CesiumMath.toRadians(st.heading - 90), CesiumMath.toRadians(pitch), 0);
    return Transforms.headingPitchRollQuaternion(this.position(st), hpr);
  }

  phaseText(st = this.state()) {
    const kt = Math.round(st.v / KT);
    const altFt = Math.round((st.agl + this.fieldElevationMsl) / FT / 10) * 10;
    if (this.time >= this.duration) return `Parked at gate ${this.plan.gate}`;
    switch (st.phase) {
      case "approach":
        return st.agl > 15 ? `Final ${this.plan.runway} · ${altFt.toLocaleString("en-US")} ft · ${kt} kt` : `Landing ${this.plan.runway} · ${kt} kt`;
      case "rollout":
        return `Rollout ${this.plan.runway} · ${kt} kt`;
      case "taxi":
        return `Taxi${st.ref ? ` on ${st.ref}` : ""} · ${kt} kt`;
      default:
        return `Entering stand ${this.plan.stand ?? this.plan.gate} · ${kt} kt`;
    }
  }

  statusText() {
    return `${this.callsign} · ${this.phaseText()}`;
  }

  describe() {
    const p = this.plan;
    const rows = [
      ["Flight", `${this.callsign} (${this.operator})`],
      ["Aircraft", "Boeing 737-800"],
      ["Status", this.phaseText()],
      ["Runway", p.runway],
      ["Taxi route", p.taxiways.length ? p.taxiways.join(" → ") : "direct"],
      ["Gate", p.gate + (p.stand && p.stand !== p.gate ? ` (stand ${p.stand})` : "")],
    ];
    const body = rows.map(([k, v]) => `<tr><th style="text-align:left;padding-right:12px">${k}</th><td>${v}</td></tr>`).join("");
    return `<table>${body}</table><p>Simulated arrival, not live data. Double-click the aircraft to follow it.</p>`;
  }

  createEntities() {
    const positions = this.profile.filter((_, i) => i % 4 === 0 || i === this.profile.length - 1);
    // Planned route: the glide path in the air and the taxi route on the ground.
    this.source.entities.add({
      name: "Planned route",
      polyline: {
        positions: positions.map((p) => Cartesian3.fromDegrees(p.lonLat[0], p.lonLat[1], p.ground + p.agl + 0.5)),
        width: 2,
        arcType: ArcType.NONE,
        material: new PolylineDashMaterialProperty({ color: Color.fromCssColorString("#5ad1ff").withAlpha(0.85), dashLength: 16 }),
      },
    });

    this.aircraft = this.source.entities.add({
      id: "arrival-aircraft",
      name: `${this.callsign} · Boeing 737-800`,
      position: new CallbackPositionProperty((time, result) => {
        const p = this.position();
        return result ? Cartesian3.clone(p, result) : p;
      }, false, ReferenceFrame.FIXED),
      orientation: new CallbackProperty(() => this.orientation(), false),
      description: new CallbackProperty(() => this.describe(), false),
      model: {
        uri: aircraftModelUrl(LIVERY),
        minimumPixelSize: 40,
        maximumScale: 400,
        silhouetteColor: Color.BLACK.withAlpha(0.5),
        silhouetteSize: 1,
      },
      label: {
        text: new CallbackProperty(() => `${this.callsign} · ${this.type}\n${this.phaseText()}`, false),
        font: "600 12px system-ui, sans-serif",
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK.withAlpha(0.85),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        horizontalOrigin: HorizontalOrigin.CENTER,
        pixelOffset: new Cartesian2(0, -26),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new DistanceDisplayCondition(0, 40_000),
        scaleByDistance: new NearFarScalar(500, 1, 30_000, 0.75),
        show: new ConstantProperty(true),
      },
    });
  }

  follow() {
    if (this.aircraft) {
      this.viewer.selectedEntity = this.aircraft;
      this.viewer.trackedEntity = this.aircraft;
    }
  }
}
