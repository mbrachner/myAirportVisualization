# Oslo Airport 3D

Interactive 3D visualization of **Oslo Airport Gardermoen (OSL / ENGM)** built with
[CesiumJS](https://cesium.com/platform/cesiumjs/) and OpenStreetMap data.

- Runways, taxiways, aprons, gates, aircraft stands and the airport boundary from OpenStreetMap
- Extruded buildings (terminal, hangars, tower) with heights from OSM tags
- Click any feature to see its OSM tags and a link to the object on openstreetmap.org
- Camera views: overview, terminal and a 3° glide-path approach to every runway end
- **Tower view** from the control tower cab (OSM building `ref:bygningsnr=15344334`): drag to look
  around, scroll to zoom, optionally keep the arriving aircraft in view; Esc or Exit to leave. The eye
  is 2 m below the tower's mapped height (40 m is assumed if the map has no height)
- Search for gates and stands (e.g. `Gate D4`, `Stand 40`)
- **Arrival demo:** a simulated Norwegian Boeing 737-800 (NAX741) flies a 3° approach to runway
  01L, lands, brakes, leaves the runway at the quickest exit and taxis along the OSM taxiway
  network to gate A12, then loops. Pause, restart, follow and 1×/3×/10× speed in the side panel
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

**For GitHub Pages, commit the snapshot.** Public Overpass servers often refuse or ignore requests
from GitHub's shared build machines, so the workflow's own download is unreliable. Run
`npm run fetch-osm` on your computer and commit `public/data/engm-osm.json`; the workflow then uses
it (and still tries to refresh it). Repeat whenever you want newer map data.

The **Reload live OSM data** button always fetches fresh data from Overpass.

## Arrival demo

The route is computed from the map data, so it changes with the OSM snapshot:

1. Runway end `01L` and gate `A12` (or a stand with the same number) are looked up by their `ref` tags.
2. The approach starts 9 km out on the extended centre line, 3° glide path, crossing the threshold
   at 15 m and touching down 400 m in at about 135 kt.
3. The runway exit is chosen by estimated time (rollout plus taxi), at least 1.1 km after touchdown.
4. The taxi route is the shortest path over taxiways and taxilanes (where OSM ways share nodes);
   the stand's lead-in line is joined to the nearest taxiway if the map leaves a gap.
5. Speeds: 145 kt on final, braking up to 2.2 m/s², 15 kt taxi, slower in turns, stopping with the
   nose at the stand.

If the runway, gate or a taxi route is missing from the data, the panel says so (and falls back to a
direct path where it can). Change `ARRIVAL` in `src/main.js` for another runway or gate. This is a
simulation, not live traffic.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/osm.js` | Overpass query, OSM parsing (multipolygons, heights, runway thresholds); no Cesium dependency |
| `src/data.js` | Loading order: snapshot → browser cache → live Overpass |
| `src/layers.js` | OSM features → Cesium entities, one data source per layer |
| `src/main.js` | Viewer, base maps, 3D tiles, camera views and UI wiring |
| `src/routing.js` | Arrival planning: runway/gate lookup, taxi graph, shortest path, speed profile |
| `src/towerView.js` | First-person tower-cab camera: look-around, zoom, tracking |
| `src/arrival.js` | Animates the simulated arrival in Cesium |
| `src/aircraftModel.js` | Generates the low-poly 737 glTF model (with a two-colour scheme) in code |
| `scripts/fetch-osm.mjs` | Saves an OSM snapshot to `public/data/` |
| `test/` | Unit tests for OSM parsing, arrival planning and the model (`npm test`) |

## Building

```bash
npm run build
```

`dist/` is a static site that can be hosted anywhere (GitHub Pages, Netlify, S3, …).

## Deploying to GitHub Pages

`.github/workflows/pages.yml` builds the site, bundles a fresh OpenStreetMap snapshot and
publishes it on every push to `main` (and to the development branch), or manually from the
Actions tab.

One-time setup:

1. **Settings → Pages → Build and deployment → Source:** choose **GitHub Actions**.
2. Deployments are only allowed from `main` by default. Either merge into `main`, or add your
   branch under **Settings → Environments → github-pages → Deployment branches and tags**.
3. Optional keys: **Settings → Secrets and variables → Actions → New repository secret**:
   - `CESIUM_ION_TOKEN`
   - `GOOGLE_MAPS_API_KEY`
4. Re-run the workflow (**Actions → Deploy to GitHub Pages → Run workflow**).

The site is published at `https://<user>.github.io/<repo>/`.

### Keeping the keys safe

GitHub Pages is static hosting, so the keys are compiled into the public JavaScript. Secrets only
keep them out of the repository. Protect them where they are issued:

- **Cesium ion:** create a dedicated token for this site, grant only the assets used
  (World Terrain, Bing imagery, OSM Buildings) and set **Allowed URLs** to your Pages domain.
- **Google:** restrict the key to **HTTP referrers** (`https://<user>.github.io/*`), to the
  **Map Tiles API** only, and set a daily quota plus a billing budget alert.

Credentials that cannot be restricted to a website (paid APIs, flight-data logins) must never be
put in `VITE_*` variables; serve them through a small proxy such as a Cloudflare Worker instead.

## Ideas for next steps

- Live aircraft from ADS-B (OpenSky Network, adsb.lol) as 3D models moving on the field
- Arrivals/departures and gate assignments from Avinor's flight data API
- METAR weather for ENGM (wind sock, runway in use, visibility/fog)
- Kartverket LiDAR terrain and FKB building data for survey-grade geometry

## Attribution

Map data © OpenStreetMap contributors (ODbL). Topographic maps © Kartverket.
Imagery © Esri and its data providers. Follow each provider's terms of use if you deploy publicly.
