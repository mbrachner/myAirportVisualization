# ADS-B proxy (Cloudflare Worker)

The free ADS-B APIs (adsb.lol, airplanes.live, adsb.fi) may not allow requests straight from a
web page on another domain (CORS). This tiny Worker fetches the data server-side, adds the CORS
header for your site only, and caches each answer for 4 seconds, so all viewers together make at
most one upstream request every few seconds.

Cloudflare's free plan is enough.

## Deploy

```bash
cd proxy
npx wrangler login
npx wrangler deploy
```

Wrangler prints the Worker URL, e.g. `https://adsb-proxy.<your-subdomain>.workers.dev`.
Check that it answers:

```bash
curl https://adsb-proxy.<your-subdomain>.workers.dev/point/60.19/11.10/40 -H "Origin: https://mbrachner.github.io"
```

Edit `ALLOWED_ORIGINS` in `wrangler.toml` if the site runs on another domain.

## Use it

- **GitHub Pages:** in the repository, go to Settings → Secrets and variables → Actions →
  **Variables** and add `ADSB_PROXY_URL` with the Worker URL. Re-run the Pages workflow.
- **Local build:** put `VITE_ADSB_PROXY_URL=<worker URL>` in `.env`. (`npm run dev` doesn't need
  it; Vite proxies the APIs itself.)

The providers are free, non-commercial services without an SLA. Consider feeding them with an
ADS-B receiver if you use them a lot.
