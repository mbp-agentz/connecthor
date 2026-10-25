# ConnecTHOR — project guide for Claude

Read this first. It replaces the chat history that built the project, so keep it current. When you finish a piece of work, update **Status** and **Open items** below.
For the background (what the owner asked for, the timeline, and why things were decided), read `HISTORY.md`.

## What it is
A single-page "situation monitor" inspired by PizzINT (pizzint.watch). A 3D globe shows geopolitical prediction markets, with a Pentagon Pizza Index / DOUGHCON panel, a "Nothing Ever Happens" (NEH) index, live trades, military aircraft and a news feed.

- Repo: https://github.com/mbp-agentz/connecthor (moved from `dekabet/connecthor` in Oct 2026; PRs #1–#3 were made there)
- Live site: https://mbp-agentz.github.io/connecthor/ (GitHub Pages, deploys from `main`). The old `dekabet.github.io/connecthor` URL is no longer the one to share.
- Everything is in **one static file**, `index.html`: React 18 UMD, react-globe.gl 2.27.2 and in-browser Babel 7.25.6, all pinned from unpkg. There is no build step, no package.json and no backend (yet).
- Icons: `favicon.svg` is the source. `favicon.ico`, `favicon-32.png`, `apple-touch-icon.png` and `icon-512.png` are rendered from it, because Safari ignores SVG favicons.

## Layout of `index.html` (search for these markers)
| Section | Marker | Notes |
|---|---|---|
| Boot screen + failure message | `window.__booted` | Shows why the page failed instead of leaving it blank |
| News (RSS via rss2json) | `// ============ NEWS` | NewsAPI was removed (its key can't be public); it returns server-side with the `/api` proxy |
| Pizza index (modeled) | `PIZZA INDEX` | `SHOPS` (generic names, ids `shop-1`…`shop-6`), `DOUGHCON`, `modelSnapshot`, and `PIZZA_DATA_URL` for a real feed |
| Sample markets (offline fallback) | `const MARKETS=[` | |
| Polymarket: Gamma, Data API trades, CLOB history, WebSocket | `POLYMARKET` | `getJSON` = direct, then CORS proxies; `useLivePrices` = WebSocket |
| Kalshi / Manifold / PredictIt | `OTHER PREDICTION MARKETS` | `SOURCES`, `similarMarkets` (cross-venue matching) |
| adsb.lol military aircraft, GDELT coverage, Doomsday Clock | `OSINT LAYERS` | `DOOMSDAY` is a hand-maintained constant (85 s, Jan 2026) |
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

So the `/api` proxy (open item 1) is a launch blocker, not an optimisation.
Data-shape notes from the same check: Kalshi markets now only carry `*_dollars` / `*_fp` fields (`volume_fp`, `volume_24h_fp`, `liquidity_dollars`), so `num(m.volume)` and `num(m.volume_24h)` read 0. Polymarket events can contain resolved-but-not-closed markets (`outcomePrices` `["1","0"]`). The console shows repeated `THREE.BufferGeometry.computeBoundingSphere(): Computed radius is NaN` (cosmetic; cause not found yet).

## Status (2026-10-22)
- dekabet/connecthor#1–#3 are merged; the repo now lives at mbp-agentz/connecthor and Pages is live at the new URL.
- Pre-launch fixes done (pending PR merge): generic shop names, NewsAPI key and code removed, footer with PizzINT credit + "for fun, not financial advice", absolute `og:image`/`og:url` + `twitter:card` for X previews.
- **The old NewsAPI key is still in git history**: the owner must revoke/rotate it at newsapi.org.
- The owner wants to launch and share on X/Twitter for feedback.

## Open items (priority order)
1. **Launch blocker: move to Cloudflare Pages + Functions** (news, Kalshi, PredictIt and aircraft are dead in the browser without it; see Live API check):
   - An `/api/*` allow-listed proxy with edge caching per feed.
   - Secrets (NewsAPI) stored server-side.
   - The page tries `/api` first, then falls back to the current direct path.
   - `wrangler.toml`; the owner connects the repo in the Cloudflare dashboard (framework None, output `/`).
2. **Data fixes:** Kalshi `_fp`/`_dollars` volume fields; skip Polymarket markets that are resolved (price ≥ 0.99) or past `endDate`; only geopolitical whale trades in the ticker; badge must not say "Live" when only Manifold loaded; NaN geometry warning.
3. **Owner (pre-launch):** rotate the old NewsAPI key; 1200×630 share image (currently the 512px icon as a small `summary` card).
4. Real pizza data (a scheduled job feeding `PIZZA_DATA_URL`) if a lawful data source is found.

## Working conventions
- Single-file style. Match the existing compact code; comments explain *why*, not what.
- Commit messages: a summary line, then bullets. Open a PR into `main`; the owner merges.
- Never commit secrets.
