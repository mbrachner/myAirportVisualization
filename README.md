# Oslo Airport 3D

Interactive 3D visualization of **Oslo Airport Gardermoen (OSL / ENGM)** built with
[CesiumJS](https://cesium.com/platform/cesiumjs/) and OpenStreetMap data.

- Runways, taxiways, aprons, gates, aircraft stands and the airport boundary from OpenStreetMap
- Extruded buildings (terminal, hangars, tower) with heights from OSM tags
- Click any feature to see its OSM tags and a link to the object on openstreetmap.org
- Camera views: overview, terminal and a 3° glide-path approach to every runway end
- Search for gates and stands (e.g. `Gate D4`, `Stand 40`)
- **Live aircraft from ADS-B** within 40 NM: 3D models coloured by altitude, smooth motion between
  updates, trails, labels, emergency squawks highlighted, a nearest-aircraft list and click-to-follow
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

## Live traffic (ADS-B)

Aircraft positions come from free community ADS-B networks (adsb.lol, airplanes.live, adsb.fi),
polled every 5 seconds while the page is visible. The app uses the first source that answers.

- **`npm run dev`:** works out of the box; Vite proxies the APIs.
- **GitHub Pages / any static host:** the public APIs may refuse direct browser requests (CORS).
  Deploy the small Cloudflare Worker in [`proxy/`](proxy/README.md) and set its URL as the
  `ADSB_PROXY_URL` repository variable (or `VITE_ADSB_PROXY_URL` in `.env`). Without it the app
  still tries the APIs directly and shows a message in the panel if they refuse.

Altitudes use the aircraft's GNSS altitude when available (barometric plus geoid otherwise). On the
flat globe everything is shifted down by the airport elevation so that landing aircraft touch the
runways. Data is crowd-sourced and unfiltered: positions can be missing, delayed or wrong.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/osm.js` | Overpass query, OSM parsing (multipolygons, heights, runway thresholds); no Cesium dependency |
| `src/data.js` | Loading order: snapshot → browser cache → live Overpass |
| `src/layers.js` | OSM features → Cesium entities, one data source per layer |
| `src/main.js` | Viewer, base maps, 3D tiles, camera views and UI wiring |
| `src/adsb.js` | ADS-B providers, polling with fallback, parsing; no Cesium dependency |
| `src/traffic.js` | Aircraft rendering: dead-reckoned motion, colours, labels, trails |
| `src/aircraftModel.js` | Generates the low-poly airliner glTF model in code |
| `proxy/` | Cloudflare Worker that relays ADS-B data with CORS headers |
| `scripts/fetch-osm.mjs` | Saves an OSM snapshot to `public/data/` |
| `test/` | Unit tests for OSM and ADS-B parsing, polling and the model (`npm test`) |

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

   and, for live traffic, under the **Variables** tab: `ADSB_PROXY_URL` (see [`proxy/`](proxy/README.md)).
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

- Arrivals/departures and gate assignments from Avinor's flight data API
- METAR weather for ENGM (wind sock, runway in use, visibility/fog)
- Kartverket LiDAR terrain and FKB building data for survey-grade geometry

## Attribution

Map data © OpenStreetMap contributors (ODbL). Live traffic from adsb.lol, airplanes.live and
adsb.fi (community ADS-B networks). Topographic maps © Kartverket.
Imagery © Esri and its data providers. Follow each provider's terms of use if you deploy publicly.
