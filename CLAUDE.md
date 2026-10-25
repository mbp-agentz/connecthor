# ConnecTHOR — project guide for Claude

Read this first. It replaces the chat history that built the project, so keep it current. When you finish a piece of work, update **Status** and **Open items** below.
For the background (what the owner asked for, the timeline, and why things were decided), read `HISTORY.md`.

## What it is
A single-page "situation monitor" inspired by PizzINT (pizzint.watch). A 3D globe shows geopolitical prediction markets, with a Pentagon Pizza Index / DOUGHCON panel, a "Nothing Ever Happens" (NEH) index, live trades, military aircraft and a news feed.

- Repo: https://github.com/mbp-agentz/connecthor (moved from `dekabet/connecthor` in Oct 2026; PRs #1–#3 were made there)
- Live site: https://mbp-agentz.github.io/connecthor/ (GitHub Pages, deploys from `main`). The old `dekabet.github.io/connecthor` URL is no longer the one to share.
- The app is **one static file**, `index.html`: React 18 UMD, react-globe.gl 2.27.2 and in-browser Babel 7.25.6, all pinned from unpkg. No build step, no package.json.
- Backend (Cloudflare Pages only): `functions/api/[[path]].js`, an allow-listed, edge-cached proxy. Routes `gamma`, `data`, `clob`, `kalshi`, `manifold`, `predictit`, `adsb` (adsb.lol, then adsb.fi), `gdelt`, plus `news` (fetches and merges the five RSS feeds). `wrangler.toml` sets output dir `.`. Test locally with `npx wrangler pages dev .`.
- `og-image.png` (1200×630) is the X/OG share card, rendered from a real screenshot.
- Icons: `favicon.svg` is the source. `favicon.ico`, `favicon-32.png`, `apple-touch-icon.png` and `icon-512.png` are rendered from it, because Safari ignores SVG favicons.

## Layout of `index.html` (search for these markers)
| Section | Marker | Notes |
|---|---|---|
| Boot screen + failure message | `window.__booted` | Shows why the page failed instead of leaving it blank |
| News | `// ============ NEWS` | `/api/news` (server-side RSS) when the proxy exists, else GDELT `artlist` (CORS OK). rss2json is dead (Cloudflare challenge) |
| Pizza index (modeled) | `PIZZA INDEX` | `SHOPS` (generic names, ids `shop-1`…`shop-6`), `DOUGHCON`, `modelSnapshot`, and `PIZZA_DATA_URL` for a real feed |
| Sample markets (offline fallback) | `const MARKETS=[` | |
| Polymarket: Gamma, Data API trades, CLOB history, WebSocket | `POLYMARKET` | `getJSON` = direct first, `/api` as fallback (if `apiUp`); `API_ONLY` hosts (Kalshi, PredictIt, adsb) only via `/api`; `/api/...` paths (news) only via the proxy. `useLivePrices` = WebSocket |
| Kalshi / Manifold / PredictIt | `OTHER PREDICTION MARKETS` | `SOURCES`, `similarMarkets` (cross-venue matching). Kalshi: `discoverKalshi` (series tagged Iran / International / International elections → events, every 30 min), `fetchKalshi` (one `/markets?tickers=` price refresh in between), `fetchKalshiTrades`, `fetchKalshiHistory` (hourly candlesticks) |
| adsb.lol military aircraft, GDELT coverage, Doomsday Clock | `OSINT LAYERS` | `DOOMSDAY` is a hand-maintained constant (85 s, Jan 2026) |
| Globe view: night / day / live sun | `DAY / NIGHT` | `subsolar()` (sun position), `applyDayNight` patches the globe's own MeshPhongMaterial via `onBeforeCompile`; button at the end of the layer bar, saved in `ct-view` |
| NEH index | `NOTHING EVER HAPPENS INDEX` | Real-money venues only (`isUSD`) |
| Hotspots, Ticker, FlatMap (2D fallback), Boundary | `COMPONENTS` | |
| App state, effects, render | `function App()` | |
| Footer (PizzINT credit, data sources, disclaimer) | `className="foot"` | Its own grid row `f` below the ticker |

## Rules that matter (learned the hard way)
- **WebGL may be missing** (Brave without graphics acceleration). `HAS_WEBGL` switches to the 2D `FlatMap`. Never render `<Globe>` unguarded: an uncaught WebGL error blanks the whole page.
- **Keep globe data objects stable.** Arcs and rings are memoised on `shownKey` (the set of shown market IDs), and points are reused via `pointCache`. Recreating them on every price tick restarts their animations and makes markers re-grow.
- **The ticker swaps content only between loops** (`onAnimationIteration`) at `TICKER_PX_PER_S`. Never bind its duration or text straight to live data, or it jumps mid-scroll.
- **App state named `history`** (price history) shadows `window.history`. Use `window.history` explicitly.
- Polymarket's `outcomePrices`/`clobTokenIds`/`outcomes` are JSON-encoded strings; use `parseArr`. Kalshi prices are integer cents or `*_dollars` strings; use `kPrice`.
- Manifold is play money (Ṁ). Keep it out of the NEH index, the $ totals and volume-based rings/arcs.
- Respect `REDUCED_MOTION`, and skip polling when `document.hidden`.
- `apiUp` is true on any http(s) host except `*.github.io`; a 404/non-JSON answer from `/api` switches it off. Don't re-add public CORS proxies (corsproxy.io needs a key, allorigins times out).
- **Pages Functions quota:** every `/api` call is a Function invocation (free plan: 100k/day, cache hits included). So CORS-friendly hosts (Polymarket, Manifold, GDELT) go direct first and use `/api` only as fallback; Kalshi re-discovers every 30 min and otherwise refreshes all prices in one call; Kalshi trades poll 3 markets every 2 min. Rough cost: ~45 calls per 10-minute visit. If a launch takes off, move to Workers Paid ($5/mo, 10M requests). Edge caching (Cache API) only persists on a custom domain, not on *.pages.dev.
- Kalshi rate-limits bursts (429 at 8 parallel): discovery runs in batches of 4 with a retry pass. Lifetime series volume favours resolved series (Next Pope, Nobel), so discovery keeps only series whose title names a place in `LOCS`.
- Kalshi trades: the taker buys Yes or No; a No buy is shown as SELL Yes at 1−price, like Polymarket fills. Both feeds share the ≥ $100 floor.
- Day/night: react-globe.gl 2.27's ref has no `globeMaterial()`, so `globeMat` finds the sphere in `scene()`. `Texture.clone()` shares its image `Source`; the night copy needs its own (`new map.source.constructor(img)`) or the day map turns into night too. Never let the view code throw into `App` (it once blanked the page).
- GDELT allows one request per 5 s per IP: without the proxy, the coverage chart starts 7 s after the news fallback.
- Only switch from sample markets to live data when a real-money venue loaded (`all.some(isUSD)`); Manifold alone made NEH 0 and volume $0.
- Every arc/ring/point number must be finite: a missing `vol24` once made arc stroke `NaN` (three.js "radius is NaN").
- The page must degrade gracefully: every feed failure falls back to sample data or a labelled simulated view, never to a crash.

## How to test (no network to these APIs from the cloud sandbox)
The sandbox blocks unpkg and every data API. Install the libraries from npm into a scratch folder and serve them through Playwright `page.route`; mock each API with fixtures, and use `page.routeWebSocket` for the CLOB stream. Run Chromium from `/opt/pw-browsers/chromium`. Scenarios to cover: full mocks, offline (abort everything), and `--disable-webgl`. Also compile-check with `@babel/standalone` (classic React preset) before pushing.

### Live API check (2026-10-22, real Chromium on the live site + direct requests)
| Feed | Result from a browser on mbp-agentz.github.io |
|---|---|
| Polymarket Gamma, CLOB history, CLOB WebSocket, Data API trades | ✅ CORS `*`. Gamma is ~400 KB × 6 requests with an 8 s timeout: some timed out on a slow line |
| Manifold | ✅ CORS `*` |
| GDELT | ⚠️ CORS `*`, but often 10–20 s (timeout is 12 s) and 429 "one request every 5 seconds" per IP |
| **rss2json (all news)** | ❌ Cloudflare challenge (`cf-mitigated: challenge`, 403, no CORS): **0 headlines**. Raw RSS feeds have no CORS either |
| **Kalshi** | ❌ blocked by CORS in the browser (data itself is fine server-side) |
| **PredictIt** | ❌ 403 + no CORS |
| **adsb.lol** | ❌ no CORS header; also rejects generic User-Agents |
| corsproxy.io / allorigins | ❌ corsproxy needs an API key (401); allorigins 520/522. Every failing feed burns 10–30 s retrying through them |

So the `/api` proxy is a launch blocker. It is built (functions/api); tested locally with wrangler: news 40 items from all 5 feeds, aircraft 435, Manifold/trades/CLOB OK, unknown routes 404, failures not cached. PredictIt is 403 even server-side. Gamma/Kalshi timed out locally only because this test Mac's route to AWS CloudFront is slow.
Data-shape notes from the same check: Kalshi markets now only carry `*_dollars` / `*_fp` fields (`volume_fp`, `volume_24h_fp`, `liquidity_dollars`), so `num(m.volume)` and `num(m.volume_24h)` read 0. Polymarket events can contain resolved-but-not-closed markets (`outcomePrices` `["1","0"]`). The repeated `THREE.BufferGeometry.computeBoundingSphere(): Computed radius is NaN` came from arc stroke with a missing `vol24`; fixed in PR #5.

## Status (2026-10-25)
- dekabet/connecthor#1–#3 are merged; the repo now lives at mbp-agentz/connecthor and Pages is live at the new URL.
- PR #5 (stacked on #4) adds the `/api` proxy, the data fixes, Kalshi discovery/trades/charts and the night/day/live-sun globe. Tested 2026-10-25 via `wrangler pages dev` + Chromium: Kalshi 26 geopolitical markets from 36 series (Hormuz, US–Iran deal, Brazil election, Greenland, Venezuela, Pahlavi…), 7-day chart, Kalshi whale rows in Flow; live sun terminator correct for the time of day.
- Pre-launch fixes done (pending PR merge): generic shop names, NewsAPI key and code removed, footer with PizzINT credit + "for fun, not financial advice", absolute `og:image`/`og:url` + `twitter:card` for X previews.
- **The old NewsAPI key is still in git history**: the owner must revoke/rotate it at newsapi.org.
- The owner wants to launch and share on X/Twitter for feedback.

## Open items (priority order)
1. **Launch blocker (owner): connect the repo in Cloudflare Pages** (README → Deploy). The code is done; then verify Kalshi + Gamma via `/api` on the real deployment and share the Cloudflare URL (or a custom domain) instead of GitHub Pages. Original plan, for reference:
   - An `/api/*` allow-listed proxy with edge caching per feed.
   - Secrets (NewsAPI) stored server-side.
   - The page tries `/api` first, then falls back to the current direct path.
   - `wrangler.toml`; the owner connects the repo in the Cloudflare dashboard (framework None, output `/`).
2. **Done (PR #5):** Kalshi `_fp` volumes, decided Polymarket markets skipped, ticker whales only on tracked markets, honest Live/Sample badge, NaN arc fix, news-offline state, 1200×630 share card, Kalshi discovery by tag + batched prices + trades + candlestick chart, night/day/live-sun globe.
   - Ideas not done yet: Kalshi in the 2D FlatMap tooltip, terminator shading in the 2D FlatMap, a "Kalshi vs Polymarket odds gap" list (the per-market "same question elsewhere" already exists).
3. **Owner (pre-launch):** rotate the old NewsAPI key. When the site moves to Cloudflare, update the `og:url`/`og:image` URLs in `index.html` to the new domain.
4. Real pizza data (a scheduled job feeding `PIZZA_DATA_URL`) if a lawful data source is found.

## Working conventions
- Single-file style. Match the existing compact code; comments explain *why*, not what.
- Commit messages: a summary line, then bullets. Open a PR into `main`; the owner merges.
- Never commit secrets.
