// Turns parsed OSM features into Cesium entities, one data source per layer.
import {
  CustomDataSource,
  Cartesian2,
  Cartesian3,
  Color,
  ClassificationType,
  DistanceDisplayCondition,
  HeightReference,
  HorizontalOrigin,
  LabelStyle,
  NearFarScalar,
  PolygonHierarchy,
  PolylineDashMaterialProperty,
  VerticalOrigin,
  CornerType,
} from "cesium";

export const LAYER_DEFS = [
  { key: "runway", label: "Runways", show: true },
  { key: "taxiway", label: "Taxiways", show: true },
  { key: "apron", label: "Aprons", show: true },
  { key: "building", label: "Buildings (OSM, extruded)", show: true },
  { key: "gate", label: "Gates", show: true },
  { key: "stand", label: "Aircraft stands", show: true },
  { key: "aerodrome", label: "Airport boundary", show: true },
];

const COLORS = {
  runway: Color.fromCssColorString("#3b3f45"),
  runwayCenter: Color.WHITE,
  taxiway: Color.fromCssColorString("#5a5f66").withAlpha(0.9),
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

const flat = (coords) => Cartesian3.fromDegreesArray(coords.flat());
const hierarchy = (geom) => new PolygonHierarchy(flat(geom.outer), geom.holes.map((h) => new PolygonHierarchy(flat(h))));

function addPolygon(ds, feature, color, extra) {
  return ds.entities.add({
    id: feature.id,
    name: feature.name ?? feature.tags.aeroway ?? "Area",
    description: describe(feature, extra),
    polygon: {
      hierarchy: hierarchy(feature.geometry),
      material: color,
      classificationType: ClassificationType.BOTH,
    },
  });
}

function label(text, options = {}) {
  return {
    text,
    font: options.font ?? "600 13px system-ui, sans-serif",
    fillColor: Color.WHITE,
    outlineColor: Color.BLACK.withAlpha(0.85),
    outlineWidth: 3,
    style: LabelStyle.FILL_AND_OUTLINE,
    verticalOrigin: VerticalOrigin.BOTTOM,
    horizontalOrigin: HorizontalOrigin.CENTER,
    pixelOffset: new Cartesian2(0, -8),
    heightReference: HeightReference.CLAMP_TO_GROUND,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    distanceDisplayCondition: options.maxDistance ? new DistanceDisplayCondition(0, options.maxDistance) : undefined,
    scaleByDistance: new NearFarScalar(300, 1.1, 8000, 0.7),
  };
}

function point(color, size = 8, maxDistance) {
  return {
    pixelSize: size,
    color,
    outlineColor: Color.BLACK.withAlpha(0.7),
    outlineWidth: 1.5,
    heightReference: HeightReference.CLAMP_TO_GROUND,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    distanceDisplayCondition: maxDistance ? new DistanceDisplayCondition(0, maxDistance) : undefined,
  };
}

function addLineSurface(ds, feature, color, centerColor, extra) {
  const positions = flat(feature.geometry.coordinates);
  const entity = ds.entities.add({
    id: feature.id,
    name: feature.name ? `${feature.tags.aeroway} ${feature.name}` : feature.tags.aeroway,
    description: describe(feature, extra),
    corridor: {
      positions,
      width: feature.width,
      material: color,
      cornerType: CornerType.ROUNDED,
      classificationType: ClassificationType.BOTH,
    },
  });
  ds.entities.add({
    parent: entity,
    polyline: {
      positions,
      width: feature.layer === "runway" ? 3 : 2,
      clampToGround: true,
      classificationType: ClassificationType.BOTH,
      material:
        feature.layer === "runway"
          ? new PolylineDashMaterialProperty({ color: centerColor, dashLength: 24 })
          : centerColor,
    },
  });
  return entity;
}

/**
 * Build all Cesium data sources. Returns the sources keyed by layer plus an index
 * of notable places (gates, stands, runway thresholds, main terminal) for navigation.
 */
export function buildDataSources(layers) {
  const sources = Object.fromEntries(LAYER_DEFS.map((d) => [d.key, new CustomDataSource(d.key)]));
  const index = { places: [], runwayEnds: [], terminal: undefined };

  for (const f of layers.apron) {
    if (f.geometry.type === "Polygon") addPolygon(sources.apron, f, COLORS.apron);
  }

  for (const f of layers.runway) {
    if (f.geometry.type === "Polygon") {
      addPolygon(sources.runway, f, COLORS.runway);
      continue;
    }
    addLineSurface(sources.runway, f, COLORS.runway, COLORS.runwayCenter, { "width (m)": f.width });
    for (const end of f.ends ?? []) {
      index.runwayEnds.push(end);
      sources.runway.entities.add({
        name: `Runway ${end.designator} threshold`,
        position: Cartesian3.fromDegrees(...end.position),
        label: label(end.designator, { font: "700 18px system-ui, sans-serif" }),
      });
    }
  }

  for (const f of layers.taxiway) {
    if (f.geometry.type === "Polygon") addPolygon(sources.taxiway, f, COLORS.taxiway);
    else addLineSurface(sources.taxiway, f, COLORS.taxiway, COLORS.taxiwayCenter, { "width (m)": f.width });
  }

  for (const f of layers.building) {
    const color = COLORS[f.kind] ?? COLORS.other;
    sources.building.entities.add({
      id: f.id,
      name: f.name ?? (f.kind === "other" ? "Building" : f.kind[0].toUpperCase() + f.kind.slice(1)),
      description: describe(f, { "height (m)": f.height.toFixed(1), "footprint (m²)": Math.round(f.area) }),
      polygon: {
        hierarchy: hierarchy(f.geometry),
        material: color,
        height: f.minHeight,
        heightReference: HeightReference.RELATIVE_TO_GROUND,
        extrudedHeight: f.height,
        extrudedHeightReference: HeightReference.RELATIVE_TO_GROUND,
      },
    });
    if (f.kind === "terminal" && (!index.terminal || f.area > index.terminal.area)) index.terminal = f;
  }
  // Fall back to the largest building if nothing is tagged as a terminal.
  if (!index.terminal && layers.building.length) {
    index.terminal = layers.building.reduce((a, b) => (b.area > a.area ? b : a));
  }

  const addPoi = (source, f, kind, color, size, maxDistance) => {
    const pos = f.geometry.type === "Point" ? f.geometry.coordinates : f.labelPosition ?? f.centroid;
    if (!pos) return;
    const ref = f.tags.ref ?? f.tags.name;
    const entity = source.entities.add({
      id: f.id,
      name: ref ? `${kind} ${ref}` : kind,
      description: describe(f),
      position: Cartesian3.fromDegrees(...pos),
      point: point(color, size, maxDistance),
      label: ref ? label(ref, { maxDistance, font: "600 12px system-ui, sans-serif" }) : undefined,
    });
    if (f.geometry.type === "LineString") {
      source.entities.add({
        parent: entity,
        polyline: {
          positions: flat(f.geometry.coordinates),
          width: 1.5,
          clampToGround: true,
          material: color.withAlpha(0.8),
        },
      });
    }
    if (ref) index.places.push({ label: `${kind} ${ref}`, position: pos, kind });
  };
  for (const f of layers.gate) addPoi(sources.gate, f, "Gate", COLORS.gate, 9, 4000);
  for (const f of layers.stand) addPoi(sources.stand, f, "Stand", COLORS.stand, 7, 2500);

  for (const f of layers.aerodrome) {
    const rings = f.geometry.type === "Polygon" ? [f.geometry.outer] : [f.geometry.coordinates];
    for (const ring of rings) {
      sources.aerodrome.entities.add({
        name: f.name ?? "Aerodrome boundary",
        description: describe(f),
        polyline: {
          positions: flat(ring),
          width: 2.5,
          clampToGround: true,
          material: new PolylineDashMaterialProperty({ color: COLORS.boundary, dashLength: 20 }),
        },
      });
    }
  }

  index.places.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  index.runwayEnds.sort((a, b) => a.designator.localeCompare(b.designator, undefined, { numeric: true }));
  return { sources, index };
}
