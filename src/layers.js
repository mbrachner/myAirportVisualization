// Turns parsed OSM features into Cesium primitives.
//
// Performance notes: instead of one Entity per feature (each of which Cesium turns into its own
// geometry update, terrain clamping callback and height query), every layer is drawn with a
// handful of batched primitives:
//   - ground areas (aprons, runway/taxiway surfaces): one GroundPrimitive per layer
//   - centre lines and outlines: one GroundPolylinePrimitive per style
//   - buildings: one Primitive with all extruded polygons, placed at pre-sampled ground heights
//   - gates/stands/labels: PointPrimitiveCollection + LabelCollection at pre-sampled heights
// Geometry is built in web workers. Picking still works because each geometry instance's id is a
// lightweight (detached) Entity, which the Viewer shows in its InfoBox when clicked.
import {
  Entity,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  ClassificationType,
  ColorGeometryInstanceAttribute,
  CorridorGeometry,
  CornerType,
  DistanceDisplayCondition,
  GeometryInstance,
  GroundPolylineGeometry,
  GroundPolylinePrimitive,
  GroundPrimitive,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  Material,
  NearFarScalar,
  PerInstanceColorAppearance,
  PointPrimitiveCollection,
  PolygonGeometry,
  PolygonHierarchy,
  PolylineColorAppearance,
  PolylineMaterialAppearance,
  Primitive,
  PrimitiveCollection,
  ShadowMode,
  VerticalOrigin,
} from "cesium";

export const LAYER_DEFS = [
  { key: "apron", label: "Aprons", show: true },
  { key: "taxiway", label: "Taxiways", show: true },
  { key: "runway", label: "Runways", show: true },
  { key: "building", label: "Buildings (OSM, extruded)", show: true },
  { key: "gate", label: "Gates", show: true },
  { key: "stand", label: "Aircraft stands", show: true },
  { key: "aerodrome", label: "Airport boundary", show: true },
];

const COLORS = {
  runway: Color.fromCssColorString("#3b3f45"),
  runwayCenter: Color.WHITE,
  taxiway: Color.fromCssColorString("#5a5f66"),
  taxiwayCenter: Color.fromCssColorString("#f2c200"),
  apron: Color.fromCssColorString("#8a9099").withAlpha(0.55),
  terminal: Color.fromCssColorString("#4f8fd6"),
  hangar: Color.fromCssColorString("#b07b4f"),
  tower: Color.fromCssColorString("#e05d5d"),
  other: Color.fromCssColorString("#c9c4bb"),
  gate: Color.fromCssColorString("#2bb3a3"),
  stand: Color.fromCssColorString("#f2c200"),
  boundary: Color.fromCssColorString("#e05d5d"),
};

// Lift points and labels slightly so they never sink into the ground surface.
const POINT_LIFT = 1.5;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function describe(feature, extra = {}) {
  const rows = { ...extra, ...feature.tags };
  const body = Object.entries(rows)
    .map(([k, v]) => `<tr><th style="text-align:left;padding-right:12px">${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join("");
  const [type, id] = feature.id.split("#")[0].split("/");
  const link = `https://www.openstreetmap.org/${type}/${id}`;
  return `<table>${body}</table><p><a href="${link}" target="_blank" rel="noopener">View on OpenStreetMap</a></p>`;
}

/** Detached entity used only as a pick id: gives the InfoBox a name, description and anchor. */
function pickTarget(feature, name, position, extra) {
  let html;
  return new Entity({
    name,
    position,
    // Built on first click rather than for every feature up front.
    description: new CallbackProperty(() => (html ??= describe(feature, extra)), true),
  });
}

/** Remove consecutive duplicate coordinates, which make Cesium geometries degenerate. */
function clean(coords) {
  const out = [];
  for (const c of coords) {
    const last = out[out.length - 1];
    if (!last || last[0] !== c[0] || last[1] !== c[1]) out.push(c);
  }
  return out;
}

const flat = (coords) => Cartesian3.fromDegreesArray(clean(coords).flat());
const hierarchy = (geom) => new PolygonHierarchy(flat(geom.outer), geom.holes.map((h) => new PolygonHierarchy(flat(h))));
const colorAttr = (color) => ({ color: ColorGeometryInstanceAttribute.fromColor(color) });
const validRing = (ring) => clean(ring).length >= 4;
const validLine = (line) => clean(line).length >= 2;

function groundAreas(instances, translucent) {
  if (!instances.length) return undefined;
  return new GroundPrimitive({
    geometryInstances: instances,
    appearance: new PerInstanceColorAppearance({ flat: true, translucent }),
    classificationType: ClassificationType.BOTH,
  });
}

function groundLines(instances, appearance) {
  if (!instances.length) return undefined;
  return new GroundPolylinePrimitive({
    geometryInstances: instances,
    appearance,
    classificationType: ClassificationType.BOTH,
  });
}

const dashed = (color, dashLength) =>
  new PolylineMaterialAppearance({ material: Material.fromType("PolylineDash", { color, dashLength }) });

function labelOptions(text, position, id, { font = "600 12px system-ui, sans-serif", maxDistance } = {}) {
  return {
    id,
    position,
    text,
    font,
    fillColor: Color.WHITE,
    outlineColor: Color.BLACK.withAlpha(0.85),
    outlineWidth: 3,
    style: LabelStyle.FILL_AND_OUTLINE,
    verticalOrigin: VerticalOrigin.BOTTOM,
    horizontalOrigin: HorizontalOrigin.CENTER,
    pixelOffset: new Cartesian2(0, -8),
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    distanceDisplayCondition: maxDistance ? new DistanceDisplayCondition(0, maxDistance) : undefined,
    scaleByDistance: new NearFarScalar(300, 1.1, 8000, 0.7),
  };
}

/** Every [lon, lat] that needs a ground height (building bases, points, labels). */
export function heightQueries(layers) {
  const out = [];
  for (const f of layers.building) out.push(f.centroid);
  for (const f of [...layers.gate, ...layers.stand]) out.push(poiPosition(f));
  for (const f of layers.runway) for (const end of f.ends ?? []) out.push(end.position);
  return out.filter(Boolean);
}

function poiPosition(f) {
  return f.geometry.type === "Point" ? f.geometry.coordinates : f.labelPosition ?? f.centroid;
}

/**
 * Build all layers. `heightAt([lon, lat])` returns the ground height (metres above the ellipsoid)
 * for points from `heightQueries`. Returns one PrimitiveCollection per layer plus an index of
 * notable places (gates, stands, runway thresholds, main terminal) for navigation.
 */
export function buildLayers(layers, heightAt = () => 0) {
  const collections = Object.fromEntries(LAYER_DEFS.map((d) => [d.key, new PrimitiveCollection()]));
  const index = { places: [], runwayEnds: [], terminal: undefined };
  const addTo = (key, primitive) => primitive && collections[key].add(primitive);

  // --- Aprons -------------------------------------------------------------------------------
  const apronAreas = [];
  for (const f of layers.apron) {
    if (f.geometry.type !== "Polygon" || !validRing(f.geometry.outer)) continue;
    const id = pickTarget(f, f.name ?? "Apron", Cartesian3.fromDegrees(...f.centroid));
    apronAreas.push(new GeometryInstance({ geometry: new PolygonGeometry({ polygonHierarchy: hierarchy(f.geometry) }), id, attributes: colorAttr(COLORS.apron) }));
  }
  addTo("apron", groundAreas(apronAreas, true));

  // --- Runways and taxiways -----------------------------------------------------------------
  for (const key of ["taxiway", "runway"]) {
    const surface = COLORS[key];
    const areas = [];
    const centre = [];
    for (const f of layers[key]) {
      const extra = f.width ? { "width (m)": f.width } : {};
      const title = f.name ? `${f.tags.aeroway} ${f.name}` : f.tags.aeroway;
      if (f.geometry.type === "Polygon") {
        if (!validRing(f.geometry.outer)) continue;
        const id = pickTarget(f, title, Cartesian3.fromDegrees(...f.centroid), extra);
        areas.push(new GeometryInstance({ geometry: new PolygonGeometry({ polygonHierarchy: hierarchy(f.geometry) }), id, attributes: colorAttr(surface) }));
        continue;
      }
      const coords = f.geometry.coordinates;
      if (!validLine(coords)) continue;
      const positions = flat(coords);
      const mid = coords[Math.floor(coords.length / 2)];
      const id = pickTarget(f, title, Cartesian3.fromDegrees(...mid), extra);
      areas.push(new GeometryInstance({ geometry: new CorridorGeometry({ positions, width: f.width, cornerType: CornerType.ROUNDED }), id, attributes: colorAttr(surface) }));
      centre.push(new GeometryInstance({ geometry: new GroundPolylineGeometry({ positions, width: key === "runway" ? 3 : 2 }), id, attributes: key === "runway" ? undefined : colorAttr(COLORS.taxiwayCenter) }));
    }
    addTo(key, groundAreas(areas, false));
    addTo(key, groundLines(centre, key === "runway" ? dashed(COLORS.runwayCenter, 24) : new PolylineColorAppearance()));
  }

  // Runway designators at each threshold
  const runwayLabels = new LabelCollection();
  for (const f of layers.runway) {
    for (const end of f.ends ?? []) {
      index.runwayEnds.push(end);
      const position = Cartesian3.fromDegrees(...end.position, heightAt(end.position) + POINT_LIFT);
      const id = new Entity({ name: `Runway ${end.designator} threshold`, position });
      runwayLabels.add(labelOptions(end.designator, position, id, { font: "700 18px system-ui, sans-serif" }));
    }
  }
  if (runwayLabels.length) collections.runway.add(runwayLabels);

  // --- Buildings ----------------------------------------------------------------------------
  const buildings = [];
  for (const f of layers.building) {
    if (!validRing(f.geometry.outer)) continue;
    const base = heightAt(f.centroid);
    const name = f.name ?? (f.kind === "other" ? "Building" : f.kind[0].toUpperCase() + f.kind.slice(1));
    const id = pickTarget(f, name, Cartesian3.fromDegrees(...f.centroid, base + f.height), {
      "height (m)": f.height.toFixed(1),
      "footprint (m²)": Math.round(f.area),
    });
    buildings.push(
      new GeometryInstance({
        geometry: new PolygonGeometry({
          polygonHierarchy: hierarchy(f.geometry),
          height: base + f.minHeight,
          extrudedHeight: base + f.height,
          vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        id,
        attributes: colorAttr(COLORS[f.kind] ?? COLORS.other),
      }),
    );
    if (f.kind === "terminal" && (!index.terminal || f.area > index.terminal.area)) index.terminal = f;
  }
  if (buildings.length) {
    collections.building.add(
      new Primitive({
        geometryInstances: buildings,
        appearance: new PerInstanceColorAppearance({ translucent: false, closed: true }),
        shadows: ShadowMode.DISABLED,
      }),
    );
  }
  // Fall back to the largest building if nothing is tagged as a terminal.
  if (!index.terminal && layers.building.length) {
    index.terminal = layers.building.reduce((a, b) => (b.area > a.area ? b : a));
  }

  // --- Gates and stands ---------------------------------------------------------------------
  const addPois = (key, kind, color, size, maxDistance) => {
    const points = new PointPrimitiveCollection();
    const labels = new LabelCollection();
    const leadIns = [];
    for (const f of layers[key]) {
      const pos = poiPosition(f);
      if (!pos) continue;
      const ref = f.tags.ref ?? f.tags.name;
      const position = Cartesian3.fromDegrees(...pos, heightAt(pos) + POINT_LIFT);
      const id = pickTarget(f, ref ? `${kind} ${ref}` : kind, position);
      points.add({
        id,
        position,
        pixelSize: size,
        color,
        outlineColor: Color.BLACK.withAlpha(0.7),
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new DistanceDisplayCondition(0, maxDistance),
      });
      if (ref) {
        labels.add(labelOptions(ref, position, id, { maxDistance }));
        index.places.push({ label: `${kind} ${ref}`, position: pos, kind });
      }
      if (f.geometry.type === "LineString" && validLine(f.geometry.coordinates)) {
        leadIns.push(new GeometryInstance({ geometry: new GroundPolylineGeometry({ positions: flat(f.geometry.coordinates), width: 1.5 }), id, attributes: colorAttr(color.withAlpha(0.8)) }));
      }
    }
    addTo(key, groundLines(leadIns, new PolylineColorAppearance({ translucent: true })));
    if (points.length) collections[key].add(points);
    if (labels.length) collections[key].add(labels);
  };
  addPois("gate", "Gate", COLORS.gate, 9, 4000);
  addPois("stand", "Stand", COLORS.stand, 7, 2500);

  // --- Aerodrome boundary -------------------------------------------------------------------
  const boundary = [];
  for (const f of layers.aerodrome) {
    const ring = f.geometry.type === "Polygon" ? f.geometry.outer : f.geometry.coordinates;
    if (!validLine(ring)) continue;
    const id = pickTarget(f, f.name ?? "Aerodrome boundary", Cartesian3.fromDegrees(...(f.centroid ?? ring[0])));
    boundary.push(new GeometryInstance({ geometry: new GroundPolylineGeometry({ positions: flat(ring), width: 2.5 }), id }));
  }
  addTo("aerodrome", groundLines(boundary, dashed(COLORS.boundary, 20)));

  index.places.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  index.runwayEnds.sort((a, b) => a.designator.localeCompare(b.designator, undefined, { numeric: true }));
  return { collections, index };
}
