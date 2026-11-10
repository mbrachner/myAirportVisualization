import {
  Ion,
  Viewer,
  ProviderViewModel,
  UrlTemplateImageryProvider,
  OpenStreetMapImageryProvider,
  IonImageryProvider,
  IonWorldImageryStyle,
  EllipsoidTerrainProvider,
  createWorldTerrainAsync,
  createOsmBuildingsAsync,
  createGooglePhotorealistic3DTileset,
  GoogleMaps,
  Credit,
  buildModuleUrl,
  Cartesian3,
  Cartographic,
  BoundingSphere,
  HeadingPitchRange,
  Math as CesiumMath,
  sampleTerrainMostDetailed,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import "./style.css";

import { AIRPORT, summarize } from "./osm.js";
import { loadAirportData } from "./data.js";
import { buildLayers, heightQueries, LAYER_DEFS } from "./layers.js";
import { AdsbPoller, providerList } from "./adsb.js";
import { TrafficLayer, altitudeColor } from "./traffic.js";

const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN?.trim();
const GOOGLE_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim();
const ADSB_PROXY_URL = import.meta.env.VITE_ADSB_PROXY_URL?.trim();
if (ION_TOKEN) Ion.defaultAccessToken = ION_TOKEN;
if (GOOGLE_KEY) GoogleMaps.defaultApiKey = GOOGLE_KEY;

const $ = (sel) => document.querySelector(sel);
const status = (text) => ($("#status").textContent = text);

// ---------------------------------------------------------------------------
// Base maps and terrain

const icon = (name) => buildModuleUrl(`Widgets/Images/ImageryProviders/${name}.png`);

const imageryModels = [];
if (ION_TOKEN) {
  imageryModels.push(
    new ProviderViewModel({
      name: "Bing aerial (ion)",
      tooltip: "Bing Maps aerial imagery via Cesium ion",
      iconUrl: icon("bingAerial"),
      creationFunction: () => IonImageryProvider.fromAssetId(2),
    }),
    new ProviderViewModel({
      name: "Bing aerial + labels (ion)",
      tooltip: "Bing Maps aerial imagery with labels via Cesium ion",
      iconUrl: icon("bingAerialLabels"),
      creationFunction: () => IonImageryProvider.fromAssetId(3),
    }),
  );
}
imageryModels.push(
  new ProviderViewModel({
    name: "Esri World Imagery",
    tooltip: "Esri World Imagery aerial photos (no key required)",
    iconUrl: icon("ArcGisMapServiceWorldImagery"),
    creationFunction: () =>
      new UrlTemplateImageryProvider({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        maximumLevel: 19,
        credit: new Credit("Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community"),
      }),
  }),
  new ProviderViewModel({
    name: "Kartverket topo",
    tooltip: "Norwegian Mapping Authority topographic map",
    iconUrl: icon("openStreetMap"),
    creationFunction: () =>
      new UrlTemplateImageryProvider({
        url: "https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png",
        maximumLevel: 18,
        credit: new Credit("© Kartverket"),
      }),
  }),
  new ProviderViewModel({
    name: "Kartverket grey",
    tooltip: "Norwegian Mapping Authority greyscale topographic map",
    iconUrl: icon("stadiaAlidadeSmooth"),
    creationFunction: () =>
      new UrlTemplateImageryProvider({
        url: "https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png",
        maximumLevel: 18,
        credit: new Credit("© Kartverket"),
      }),
  }),
  new ProviderViewModel({
    name: "OpenStreetMap",
    tooltip: "OpenStreetMap standard map",
    iconUrl: icon("openStreetMap"),
    creationFunction: () => new OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" }),
  }),
);

const terrainModels = [
  new ProviderViewModel({
    name: "Flat (no terrain)",
    tooltip: "WGS84 ellipsoid, no elevation data",
    iconUrl: buildModuleUrl("Widgets/Images/TerrainProviders/Ellipsoid.png"),
    creationFunction: () => new EllipsoidTerrainProvider(),
  }),
];
if (ION_TOKEN) {
  terrainModels.push(
    new ProviderViewModel({
      name: "Cesium World Terrain",
      tooltip: "High-resolution global terrain via Cesium ion",
      iconUrl: buildModuleUrl("Widgets/Images/TerrainProviders/CesiumWorldTerrain.png"),
      creationFunction: () => createWorldTerrainAsync(),
    }),
  );
}

const viewer = new Viewer("cesiumContainer", {
  imageryProviderViewModels: imageryModels,
  selectedImageryProviderViewModel: imageryModels[0],
  terrainProviderViewModels: terrainModels,
  selectedTerrainProviderViewModel: terrainModels[terrainModels.length - 1],
  geocoder: false,
  homeButton: false,
  timeline: false,
  animation: false,
  sceneModePicker: false,
  navigationHelpButton: true,
  fullscreenButton: true,
});
viewer.scene.globe.depthTestAgainstTerrain = true;
viewer.scene.globe.enableLighting = false;
viewer.scene.skyAtmosphere.show = true;

// ---------------------------------------------------------------------------
// Camera helpers

let photorealTileset;
let osmBuildingsTileset;

// Our own primitives, excluded when sampling heights so we don't measure building roofs.
let ownPrimitives = [];

/**
 * Heights of the visible ground (terrain or photorealistic 3D tiles) for many [lon, lat] points
 * in one batch, in metres above the ellipsoid. Flat terrain needs no sampling at all.
 */
async function groundHeights(points) {
  const fallback = photorealTileset?.show ? AIRPORT.elevationMsl + 38 : 0; // ~38 m geoid height at Gardermoen
  const heights = points.map(() => fallback);
  const todo = () => heights.map((h, i) => (h === fallback ? i : -1)).filter((i) => i >= 0);
  try {
    if (photorealTileset?.show && viewer.scene.sampleHeightSupported) {
      const cartos = points.map(([lon, lat]) => Cartographic.fromDegrees(lon, lat));
      const res = await viewer.scene.sampleHeightMostDetailed(cartos, ownPrimitives);
      res.forEach((c, i) => Number.isFinite(c?.height) && (heights[i] = c.height));
    }
    if (!(viewer.terrainProvider instanceof EllipsoidTerrainProvider)) {
      const idx = todo();
      if (idx.length) {
        const cartos = idx.map((i) => Cartographic.fromDegrees(...points[i]));
        const res = await sampleTerrainMostDetailed(viewer.terrainProvider, cartos);
        res.forEach((c, k) => Number.isFinite(c?.height) && (heights[idx[k]] = c.height));
      }
    }
  } catch (err) {
    console.warn("Height sampling failed, using fallback heights", err);
  }
  return heights;
}

const groundHeight = async (lon, lat) => (await groundHeights([[lon, lat]]))[0];

async function lookAt(lon, lat, { range, pitch = -35, heading = 0, duration = 2.5 } = {}) {
  viewer.trackedEntity = undefined; // stop following an aircraft
  const h = await groundHeight(lon, lat);
  viewer.camera.flyToBoundingSphere(new BoundingSphere(Cartesian3.fromDegrees(lon, lat, h), 20), {
    offset: new HeadingPitchRange(CesiumMath.toRadians(heading), CesiumMath.toRadians(pitch), range),
    duration,
  });
}

/** Fly to a point on a 3° glide path, 3 km before the runway threshold, looking down the runway. */
async function approachView(end) {
  viewer.trackedEntity = undefined;
  const [lon, lat] = end.position;
  const distance = 3000;
  const rad = CesiumMath.toRadians(end.heading);
  const metresPerDegLat = 111320;
  const metresPerDegLon = metresPerDegLat * Math.cos(CesiumMath.toRadians(lat));
  const camLon = lon - (Math.sin(rad) * distance) / metresPerDegLon;
  const camLat = lat - (Math.cos(rad) * distance) / metresPerDegLat;
  const h = await groundHeight(lon, lat);
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(camLon, camLat, h + distance * Math.tan(CesiumMath.toRadians(3)) + 15),
    orientation: { heading: rad, pitch: CesiumMath.toRadians(-4), roll: 0 },
    duration: 3,
  });
}

const overview = (duration = 2.5) => lookAt(AIRPORT.lon, AIRPORT.lat, { range: 9000, pitch: -50, heading: 20, duration });

// Start above the airport immediately, before data has loaded.
viewer.camera.setView({
  destination: Cartesian3.fromDegrees(AIRPORT.lon - 0.03, AIRPORT.lat - 0.07, 6500),
  orientation: { heading: CesiumMath.toRadians(20), pitch: CesiumMath.toRadians(-50), roll: 0 },
});

// ---------------------------------------------------------------------------
// UI

function addToggle(container, text, checked, onChange) {
  const id = `toggle-${container.children.length}-${text.replace(/\W+/g, "")}`;
  const row = document.createElement("label");
  row.className = "toggle";
  row.htmlFor = id;
  row.innerHTML = `<input type="checkbox" id="${id}" ${checked ? "checked" : ""}/> <span></span>`;
  row.querySelector("span").textContent = text;
  const input = row.querySelector("input");
  input.addEventListener("change", () => onChange(input.checked));
  container.appendChild(row);
  return input;
}

function addButton(container, text, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = text;
  btn.addEventListener("click", onClick);
  container.appendChild(btn);
  return btn;
}

$("#panel-toggle").addEventListener("click", () => $("#panel").classList.toggle("collapsed"));

// 3D tiles toggles
const tilesBox = $("#tiles");
let buildingToggle;
if (GOOGLE_KEY) {
  addToggle(tilesBox, "Google photorealistic 3D", false, async (on) => {
    try {
      if (on && !photorealTileset) {
        status("Loading Google photorealistic 3D tiles …");
        photorealTileset = await createGooglePhotorealistic3DTileset();
        viewer.scene.primitives.add(photorealTileset);
      }
      if (photorealTileset) photorealTileset.show = on;
      // The photorealistic mesh already contains terrain and buildings.
      viewer.scene.globe.show = !on;
      if (buildingToggle && buildingToggle.checked === on) buildingToggle.click();
      if (osmBuildingsTileset && on) osmBuildingsTileset.show = false;
      status(on ? "Google photorealistic 3D tiles on" : "Google photorealistic 3D tiles off");
      // Points and labels must sit on the new ground surface.
      scheduleRebuild();
    } catch (err) {
      console.error(err);
      status(`Could not load Google 3D tiles: ${err.message}`);
    }
  });
}
if (ION_TOKEN) {
  addToggle(tilesBox, "Cesium OSM Buildings (ion)", false, async (on) => {
    try {
      if (on && !osmBuildingsTileset) {
        osmBuildingsTileset = await createOsmBuildingsAsync();
        viewer.scene.primitives.add(osmBuildingsTileset);
      }
      if (osmBuildingsTileset) osmBuildingsTileset.show = on;
    } catch (err) {
      console.error(err);
      status(`Could not load Cesium OSM Buildings: ${err.message}`);
    }
  });
}
if (!GOOGLE_KEY && !ION_TOKEN) {
  tilesBox.innerHTML =
    '<p class="hint">Add <code>VITE_CESIUM_ION_TOKEN</code> and/or <code>VITE_GOOGLE_MAPS_API_KEY</code> to <code>.env</code> for terrain, aerial imagery and photorealistic 3D. See README.</p>';
}

// Navigation
const viewsBox = $("#views");
addButton(viewsBox, "Overview", () => overview());

const searchInput = $("#search");
let places = [];
searchInput.addEventListener("change", () => {
  const q = searchInput.value.trim().toLowerCase();
  const place =
    places.find((p) => p.label.toLowerCase() === q) ??
    places.find((p) => p.label.toLowerCase().endsWith(" " + q)) ??
    places.find((p) => p.label.toLowerCase().includes(q));
  if (place) lookAt(...place.position, { range: 350, pitch: -40 });
  else status(`No gate or stand matching “${searchInput.value}”`);
});

// ---------------------------------------------------------------------------
// Data

let airportLayers;
let collections = {};
let buildToken = 0;
const visibility = Object.fromEntries(LAYER_DEFS.map((d) => [d.key, d.show]));

/** (Re)create the primitives for the current data, terrain and 3D tiles. */
async function rebuild() {
  if (!airportLayers) return;
  const token = ++buildToken;
  const queries = heightQueries(airportLayers);
  const heights = await groundHeights(queries);
  if (token !== buildToken) return; // a newer rebuild started meanwhile
  const lookup = new Map(queries.map((q, i) => [q.join(","), heights[i]]));
  const { collections: next, index } = buildLayers(airportLayers, (p) => lookup.get(p.join(",")) ?? 0);

  for (const c of Object.values(collections)) viewer.scene.primitives.remove(c);
  collections = next;
  ownPrimitives = [];
  for (const def of LAYER_DEFS) {
    const c = collections[def.key];
    c.show = visibility[def.key];
    viewer.scene.primitives.add(c);
    for (let i = 0; i < c.length; i++) ownPrimitives.push(c.get(i));
  }
  return index;
}

let rebuildTimer;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 250);
}
viewer.scene.terrainProviderChanged.addEventListener(scheduleRebuild);

async function loadData({ live = false } = {}) {
  status(live ? "Fetching live OpenStreetMap data …" : "Loading airport data …");
  try {
    const { layers, source } = await loadAirportData({ live });
    airportLayers = layers;
    const index = await rebuild();
    const counts = summarize(layers);

    const layersBox = $("#layers");
    layersBox.innerHTML = "";
    for (const def of LAYER_DEFS) {
      const input = addToggle(layersBox, `${def.label} (${counts[def.key]})`, visibility[def.key], (on) => {
        visibility[def.key] = on;
        if (collections[def.key]) collections[def.key].show = on;
      });
      if (def.key === "building") buildingToggle = input;
    }

    // Views that depend on the data
    viewsBox.querySelectorAll("[data-dynamic]").forEach((el) => el.remove());
    if (index.terminal) {
      const [lon, lat] = index.terminal.centroid;
      addButton(viewsBox, "Terminal", () => lookAt(lon, lat, { range: 1100, pitch: -30, heading: 300 })).dataset.dynamic = "";
    }
    for (const end of index.runwayEnds) {
      addButton(viewsBox, `Approach ${end.designator}`, () => approachView(end)).dataset.dynamic = "";
    }

    places = index.places;
    $("#places").innerHTML = places.map((p) => `<option value="${p.label}"></option>`).join("");
    searchInput.disabled = places.length === 0;
    searchInput.placeholder = places.length ? "e.g. Gate D4, Stand 40" : "No gates or stands in data";

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    status(`${total} features from ${source}. Click anything for details.`);
  } catch (err) {
    console.error(err);
    status(`Could not load airport data: ${err.message.split("\n")[0]}`);
  }
}

// ---------------------------------------------------------------------------
// Live traffic (ADS-B)

const GEOID_HEIGHT = 38; // approx. geoid separation at Gardermoen, metres
const flatGround = () => viewer.terrainProvider instanceof EllipsoidTerrainProvider && !photorealTileset?.show;
const traffic = new TrafficLayer(viewer, {
  geoidHeight: GEOID_HEIGHT,
  // On the flat globe the airport is drawn at height 0, so shift real altitudes down by its elevation.
  heightOffset: () => (flatGround() ? AIRPORT.elevationMsl + GEOID_HEIGHT : 0),
  clampToTerrain: () => !flatGround(),
});

const trafficStatus = $("#traffic-status");
const trafficList = $("#traffic-list");
let lastUpdate = 0;
let lastProvider = "";

function renderTrafficList() {
  const items = traffic.nearest(AIRPORT.lon, AIRPORT.lat, 8);
  trafficList.innerHTML = "";
  for (const { ac, entity, distanceKm } of items) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = "Follow this aircraft";
    const alt = ac.onGround ? "GND" : `${Math.round(ac.altBaroFt ?? ac.altGeomFt ?? 0).toLocaleString("en-US")} ft`;
    btn.innerHTML = `<span class="dot"></span><span class="name"></span><span class="meta"></span>`;
    btn.querySelector(".dot").style.background = altitudeColor(ac).toCssColorString();
    btn.querySelector(".name").textContent = ac.callsign || ac.registration || ac.hex.toUpperCase();
    btn.querySelector(".meta").textContent = `${alt} · ${distanceKm.toFixed(1)} km`;
    btn.addEventListener("click", () => {
      viewer.selectedEntity = entity;
      viewer.trackedEntity = entity;
    });
    li.appendChild(btn);
    trafficList.appendChild(li);
  }
}

function renderTrafficStatus() {
  if (!lastUpdate) return;
  const age = Math.round((Date.now() - lastUpdate) / 1000);
  trafficStatus.classList.remove("error");
  trafficStatus.textContent = `${traffic.count} aircraft within 40 NM · ${lastProvider} · updated ${age} s ago`;
}

const poller = new AdsbPoller({
  providers: providerList({ proxyUrl: ADSB_PROXY_URL, dev: import.meta.env.DEV }),
  center: { lat: AIRPORT.lat, lon: AIRPORT.lon },
  radiusNm: 40,
  intervalMs: 5000,
  onData: (list, provider) => {
    traffic.update(list);
    lastUpdate = Date.now();
    lastProvider = provider;
    renderTrafficStatus();
    renderTrafficList();
  },
  onError: (message) => {
    console.warn("ADS-B:", message);
    if (lastUpdate && Date.now() - lastUpdate < 30_000) return; // brief hiccup: keep showing the last data
    trafficStatus.classList.add("error");
    trafficStatus.textContent = ADSB_PROXY_URL
      ? "Live traffic unavailable right now. Retrying …"
      : "Live traffic unavailable: the ADS-B services refused the browser request. Set up the ADS-B proxy (see README). Retrying …";
  },
});
setInterval(renderTrafficStatus, 1000);

const trafficToggles = $("#traffic-toggles");
addToggle(trafficToggles, "Show aircraft", true, (on) => {
  traffic.show = on;
  if (on) poller.start();
  else {
    poller.stop();
    viewer.trackedEntity = undefined;
  }
});
addToggle(trafficToggles, "Trails", true, (on) => (traffic.showTrails = on));
poller.start();

$("#reload").addEventListener("click", () => loadData({ live: true }));

// Expose the viewer for debugging and benchmarks: open the page with ?debug
if (new URLSearchParams(location.search).has("debug")) window.__viewer = viewer;

await loadData();
overview(3);
