// First-person view from the control tower cab: the camera stays put, dragging looks around,
// scrolling zooms like binoculars, and it can keep a moving target (the arrival) in view.
import {
  Cartesian2,
  Cartesian3,
  Math as CesiumMath,
  PerspectiveFrustum,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  Matrix4,
} from "cesium";

const DEFAULT_FOV = CesiumMath.toRadians(60);
const MIN_FOV = CesiumMath.toRadians(8);
const MAX_FOV = CesiumMath.toRadians(90);
const MIN_PITCH = CesiumMath.toRadians(-85);
const MAX_PITCH = CesiumMath.toRadians(45);

/** Heading and pitch (radians) to look from `from` towards `to`, both Cartesian3. */
export function headingPitchTo(from, to) {
  const enu = Transforms.eastNorthUpToFixedFrame(from);
  const inv = Matrix4.inverseTransformation(enu, new Matrix4());
  const local = Matrix4.multiplyByPoint(inv, to, new Cartesian3());
  const heading = Math.atan2(local.x, local.y);
  const pitch = Math.atan2(local.z, Math.hypot(local.x, local.y));
  return { heading: CesiumMath.zeroToTwoPi(heading), pitch };
}

export class TowerView {
  constructor(viewer) {
    this.viewer = viewer;
    this.active = false;
    this.position = undefined;
    this.heading = 0;
    this.pitch = 0;
    this.target = undefined; // () => Cartesian3 | undefined
    this.onChange = undefined;
    this.handler = undefined;
    this.saved = undefined;
    this.onKey = (e) => {
      if (e.key === "Escape" && this.active) this.exit();
    };
    viewer.scene.preRender.addEventListener(() => this.update());
  }

  /** Enter the cab at `position` (Cartesian3), initially looking along `heading`/`pitch` (radians). */
  enter(position, { heading = 0, pitch = CesiumMath.toRadians(-6) } = {}) {
    const { viewer } = this;
    viewer.trackedEntity = undefined;
    viewer.camera.cancelFlight();
    this.position = Cartesian3.clone(position);
    this.heading = heading;
    this.pitch = pitch;

    if (!this.active) {
      const c = viewer.scene.screenSpaceCameraController;
      this.saved = {
        enableInputs: c.enableInputs,
        fov: viewer.camera.frustum instanceof PerspectiveFrustum ? viewer.camera.frustum.fov : undefined,
      };
      // Our own handler replaces the default orbit/pan/zoom controls while in the cab.
      c.enableInputs = false;
      this.handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
      // Cesium reuses its event position objects, so keep copies.
      let last;
      this.handler.setInputAction((e) => (last = Cartesian2.clone(e.position)), ScreenSpaceEventType.LEFT_DOWN);
      this.handler.setInputAction(() => (last = undefined), ScreenSpaceEventType.LEFT_UP);
      this.handler.setInputAction((e) => {
        if (!last) return;
        // Drag the view: move the mouse right to look left, like grabbing the scenery.
        const fov = viewer.camera.frustum.fov ?? DEFAULT_FOV;
        const perPixel = fov / viewer.scene.canvas.clientHeight;
        this.heading = CesiumMath.zeroToTwoPi(this.heading - (e.endPosition.x - last.x) * perPixel);
        this.pitch = CesiumMath.clamp(this.pitch + (e.endPosition.y - last.y) * perPixel, MIN_PITCH, MAX_PITCH);
        last = Cartesian2.clone(e.endPosition, last);
        this.target = undefined; // manual looking stops tracking
        this.onChange?.();
      }, ScreenSpaceEventType.MOUSE_MOVE);
      this.handler.setInputAction((delta) => {
        const f = viewer.camera.frustum;
        f.fov = CesiumMath.clamp(f.fov * (delta > 0 ? 0.9 : 1 / 0.9), MIN_FOV, MAX_FOV);
      }, ScreenSpaceEventType.WHEEL);
      window.addEventListener("keydown", this.onKey);
      this.active = true;
    }
    this.apply();
    this.onChange?.();
  }

  exit() {
    if (!this.active) return;
    const { viewer } = this;
    viewer.scene.screenSpaceCameraController.enableInputs = this.saved.enableInputs;
    if (this.saved.fov !== undefined) viewer.camera.frustum.fov = this.saved.fov;
    this.handler?.destroy();
    this.handler = undefined;
    window.removeEventListener("keydown", this.onKey);
    this.active = false;
    this.target = undefined;
    this.onChange?.();
  }

  /** Keep a moving object in view; pass undefined to stop. */
  track(getPosition) {
    this.target = getPosition;
    this.onChange?.();
  }

  get fovDegrees() {
    return CesiumMath.toDegrees(this.viewer.camera.frustum.fov ?? DEFAULT_FOV);
  }

  update() {
    if (!this.active) return;
    const p = this.target?.();
    if (p) ({ heading: this.heading, pitch: this.pitch } = headingPitchTo(this.position, p));
    this.apply();
  }

  apply() {
    this.viewer.camera.setView({
      destination: this.position,
      orientation: { heading: this.heading, pitch: this.pitch, roll: 0 },
    });
  }
}
