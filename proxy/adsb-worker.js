// Cloudflare Worker that relays ADS-B data to the browser with CORS headers.
//
//   GET /point/{lat}/{lon}/{radius}   -> readsb v2 JSON ({ ac: [...] })
//
// It tries the public providers in order, caches each answer for a few seconds so that many
// viewers share one upstream request (the providers allow about 1 request per second), and only
// answers pages from ALLOWED_ORIGINS. Deploy with `npx wrangler deploy` (see proxy/README.md).

const UPSTREAMS = [
  (lat, lon, r) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${r}`,
  (lat, lon, r) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${r}`,
  (lat, lon, r) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${r}`,
];
const CACHE_SECONDS = 4;
const MAX_RADIUS_NM = 100;

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = (env.ALLOWED_ORIGINS ?? "*").split(",").map((s) => s.trim());
  const allow = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : "";
  return allow ? { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Methods": "GET, OPTIONS", Vary: "Origin" } : null;
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (!cors) return new Response("Origin not allowed", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });

    const match = new URL(request.url).pathname.match(/^\/point\/(-?[\d.]+)\/(-?[\d.]+)\/([\d.]+)\/?$/);
    if (!match) return new Response("Use /point/{lat}/{lon}/{radiusNm}", { status: 404, headers: cors });
    // Round so that nearby requests share a cache entry.
    const lat = Number(match[1]).toFixed(2);
    const lon = Number(match[2]).toFixed(2);
    const radius = Math.min(Math.round(Number(match[3])), MAX_RADIUS_NM);
    if (![lat, lon, radius].every((v) => Number.isFinite(Number(v)))) {
      return new Response("Bad coordinates", { status: 400, headers: cors });
    }

    const cache = caches.default;
    const cacheKey = new Request(`https://adsb-cache.internal/point/${lat}/${lon}/${radius}`);
    let upstream = await cache.match(cacheKey);
    if (!upstream) {
      for (const make of UPSTREAMS) {
        try {
          const res = await fetch(make(lat, lon, radius), { headers: { "User-Agent": "airport-3d-proxy" } });
          if (!res.ok) continue;
          const body = await res.text();
          upstream = new Response(body, {
            headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
          });
          ctx.waitUntil(cache.put(cacheKey, upstream.clone()));
          break;
        } catch {
          // try the next provider
        }
      }
    }
    if (!upstream) return new Response("All ADS-B providers failed", { status: 502, headers: cors });

    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(upstream.body, { status: 200, headers });
  },
};
