import { existsSync } from "node:fs";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

const cesiumSource = "node_modules/cesium/Build/Cesium";
// Cesium loads web workers, widgets and assets at runtime from this folder.
const cesiumBaseUrl = "cesiumStatic";

export default defineConfig({
  define: {
    CESIUM_BASE_URL: JSON.stringify(`./${cesiumBaseUrl}`),
    // Whether `npm run fetch-osm` produced a snapshot to bundle (see src/data.js).
    __HAS_OSM_SNAPSHOT__: JSON.stringify(existsSync("public/data/engm-osm.json")),
  },
  base: "./",
  // Cesium is one large library; splitting it brings little benefit here.
  build: { chunkSizeWarningLimit: 5000 },
  plugins: [
    viteStaticCopy({
      targets: ["ThirdParty", "Workers", "Assets", "Widgets"].map((dir) => ({
        src: `${cesiumSource}/${dir}`,
        dest: cesiumBaseUrl,
        rename: { stripBase: 4 }, // strip node_modules/cesium/Build/Cesium
      })),
    }),
  ],
});
