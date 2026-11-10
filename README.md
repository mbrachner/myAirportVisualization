# Oslo Airport 3D

Interactive 3D visualization of **Oslo Airport Gardermoen (OSL / ENGM)** built with
[CesiumJS](https://cesium.com/platform/cesiumjs/) and OpenStreetMap data.

- Runways, taxiways, aprons, gates, aircraft stands and the airport boundary from OpenStreetMap
- Extruded buildings (terminal, hangars, tower) with heights from OSM tags
- Click any feature to see its OSM tags and a link to the object on openstreetmap.org
- Camera views: overview, terminal and a 3° glide-path approach to every runway end
- Search for gates and stands (e.g. `Gate D4`, `Stand 40`)
- Base maps: Esri World Imagery, Kartverket topo/grey, OpenStreetMap; with keys also Bing aerial,
  Cesium World Terrain, Cesium OSM Buildings and Google Photorealistic 3D Tiles

## Getting started

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173).

### Optional API keys

The app works without any keys (flat terrain, open map tiles). For terrain and photorealistic 3D,
copy `.env.example` to `.env` and fill in:

| Variable | Gives you | Where to get it |
| --- | --- | --- |
| `VITE_CESIUM_ION_TOKEN` | Cesium World Terrain, Bing aerial imagery, Cesium OSM Buildings | https://ion.cesium.com/tokens (free tier) |
| `VITE_GOOGLE_MAPS_API_KEY` | Google Photorealistic 3D Tiles | Google Cloud console, enable the *Map Tiles API* |

Restart `npm run dev` after editing `.env`. Keys in `VITE_*` variables end up in the browser bundle,
so restrict them by HTTP referrer in the Cesium ion / Google consoles.

### Airport data

On load the app looks for data in this order:

1. `public/data/engm-osm.json`, a snapshot created with `npm run fetch-osm`
2. a copy cached in the browser (refreshed weekly)
3. live from the Overpass API

Saving a snapshot makes loading instant and reproducible:

```bash
npm run fetch-osm
```

The **Reload live OSM data** button always fetches fresh data from Overpass.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/osm.js` | Overpass query, OSM parsing (multipolygons, heights, runway thresholds); no Cesium dependency |
| `src/data.js` | Loading order: snapshot → browser cache → live Overpass |
| `src/layers.js` | OSM features → Cesium entities, one data source per layer |
| `src/main.js` | Viewer, base maps, 3D tiles, camera views and UI wiring |
| `scripts/fetch-osm.mjs` | Saves an OSM snapshot to `public/data/` |
| `test/` | Unit tests for the parsing logic (`npm test`) |

## Building

```bash
npm run build
```

`dist/` is a static site that can be hosted anywhere (GitHub Pages, Netlify, S3, …).

## Ideas for next steps

- Live aircraft from ADS-B (OpenSky Network, adsb.lol) as 3D models moving on the field
- Arrivals/departures and gate assignments from Avinor's flight data API
- METAR weather for ENGM (wind sock, runway in use, visibility/fog)
- Kartverket LiDAR terrain and FKB building data for survey-grade geometry

## Attribution

Map data © OpenStreetMap contributors (ODbL). Topographic maps © Kartverket.
Imagery © Esri and its data providers. Follow each provider's terms of use if you deploy publicly.
