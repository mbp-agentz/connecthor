# ⚡ ConnecTHOR

Pentagon Pizza Index + geopolitical prediction-market intel on a 3D globe, in a single static `index.html`. Inspired by [PizzINT](https://www.pizzint.watch/).

## Features

- **🍕 Pentagon Pizza Watch** - "Popular Times"-style busyness charts for pizza shops near the Pentagon, each scored against its usual level for that hour (QUIET / NOMINAL / BUSY / SPIKE)
- **DOUGHCON level** - a DEFCON-style 5→1 alert level driven by the combined pizza index, with a 24-hour history sparkline
- **📉 Nothing Ever Happens Index** - 0-100 tension score from the volume-weighted odds of conflict/escalation markets (ceasefire markets inverted), with the top driving markets
- **Interactive 3D Globe** - Polymarket markets, Pentagon beacon whose pulse speeds up with DOUGHCON, pizza shops, arcs to hotspots
- **Intel Feed** - live world news (BBC, NYT, Al Jazeera, NPR, Guardian via RSS) tagged MILITARY / DIPLOMACY / ECONOMY, plus a breaking ticker
- **Markets tab** - live Polymarket odds streamed in real time, 24h change and volume
- **Flow tab** - real Polymarket trades with a whale filter; whale trades arc across the globe
- **Hotspots tab** - countries ranked by escalation odds × money at stake, with the top market for each; top hotspots are labelled on the globe
- **Linked intel** - headlines that mention a country link to that country's busiest market
- **✈ Military aircraft** - live positions of military aircraft broadcasting ADS-B ([adsb.lol](https://adsb.lol), free community data; many military flights don't broadcast, so it's a partial picture)
- **Layer toggles** - switch markets, connections, trades, pizza shops and aircraft on/off (remembered per browser)
- **News coverage gauge** - share of world news about military conflict over 7 days ([GDELT](https://www.gdeltproject.org/))
- **Signal types** - headlines classified as Nuclear / Aerial / Naval / Cyber / Ground / Military / Diplomacy / Economy, with filters
- **☢ Doomsday Clock** - current setting from the Bulletin of the Atomic Scientists (85 seconds to midnight, Jan 2026)
- **Shareable links** - `#m=<market id>` opens a market directly; Esc closes it
- **Calm motion** - slow auto-rotate and spotlight, smooth in-place updates, a ticker that only refreshes between loops; honours the OS "reduce motion" setting

### About the pizza data

Google Maps Popular Times has no public API and can't be read from a static page, so out of the box the pizza busyness is **modeled**: typical hourly curves per shop plus deterministic noise and occasional correlated surges (every viewer sees the same values at the same time). The panel is badged `MODELED` while this is the case.

To use real data, run your own collector and set `PIZZA_DATA_URL` in `index.html` to a JSON endpoint returning:

```json
{"updated":"2026-10-08T20:00:00Z","shops":[{"id":"shop-1","live":72,"typical":[0,0,0,0,0,0,0,0,0,0,10,25,45,40,30,28,35,55,70,72,60,45,30,15]}]}
```

`id` must match an entry in `SHOPS`; `typical` is 24 hourly values (0-100, ET).

## 🚀 Deploy to GitHub Pages

### Quick Setup (2 minutes)

1. **Create a new repository** on GitHub
   - Go to [github.com/new](https://github.com/new)
   - Name it `polyglobe` (or any name)
   - Make it **Public**
   - Click "Create repository"

2. **Upload the files**
   ```bash
   git clone https://github.com/YOUR_USERNAME/polyglobe.git
   cd polyglobe
   # Copy index.html to this folder
   git add .
   git commit -m "Initial Polyglobe deployment"
   git push origin main
   ```

3. **Enable GitHub Pages**
   - Go to your repo → **Settings** → **Pages**
   - Under "Source", select **main** branch
   - Click **Save**
   - Wait 1-2 minutes for deployment

4. **Access your site**
   ```
   https://YOUR_USERNAME.github.io/polyglobe/
   ```

### Alternative: GitHub UI Upload

1. Create repo on GitHub
2. Click "Add file" → "Upload files"
3. Drag `index.html` into the upload area
4. Click "Commit changes"
5. Enable Pages in Settings

## 📊 Polymarket connections

All public and keyless; every REST call tries a direct request first, then falls back to CORS proxies.

| Connection | Endpoint | Used for |
|---|---|---|
| Gamma API | `gamma-api.polymarket.com/events` (geopolitics, world, politics, middle-east, economy tags + top 24h volume) | Markets on the globe, odds, 24h change, 24h volume, liquidity, bid/ask |
| CLOB WebSocket | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | Live price updates for the 100 busiest markets (header shows **Price stream LIVE**) |
| Data API | `data-api.polymarket.com/trades` (polled every 15s) | Real trade flow, whale filter (≥ $5K), globe pulses and whale arcs, ticker |
| CLOB REST | `clob.polymarket.com/prices-history` | 7-day price chart in the market detail panel |

### Other prediction markets

| Venue | Endpoint | Notes |
|---|---|---|
| Kalshi | `api.elections.kalshi.com/trade-api/v2/events` | US-regulated, real money; politics/world/economics events only |
| Manifold | `api.manifold.markets/v0/search-markets` | Play money (Ṁ) — shown but excluded from the NEH index and $ totals |
| PredictIt | `www.predictit.org/api/marketdata/all/` | US politics, prices only (no volume) |

The market detail panel lists **the same question on other venues** with the odds gap, e.g. Polymarket 40% vs Kalshi 34% (−6). The Markets tab filters by venue.

Globe arcs connect every location a market mentions (e.g. *Israel strike on Iran* draws Israel ↔ Iran). If Polymarket is unreachable the page falls back to sample markets and a clearly labelled simulated flow.

## 🛠️ Customization

### Add Your Own Markets

Edit the `MARKETS` array in `index.html`:

```javascript
const SAMPLE_MARKETS = [
  {
    id: 'unique-id',
    question: 'Your market question?',
    outcomePrices: '0.65,0.35',  // YES,NO probabilities
    volume: '1000000',
    slug: 'polymarket-slug',
    endDate: '2026-12-31'
  },
  // ... more markets
];
```

### Add Location Keywords

Expand the `LOCS` object to map new keywords:

```javascript
const LOCATIONS = {
  // ... existing locations
  'your_keyword': { lat: 40.7128, lng: -74.0060, country: 'New York' },
};
```

### Customize Colors

Modify the color logic in `getColor`:

```javascript
const getColor = (market) => {
  if (market.yesPrice >= 0.7) return '#22c55e';  // Green
  if (market.yesPrice >= 0.4) return '#eab308';  // Yellow  
  return '#ef4444';  // Red
};
```

## 📁 Project Structure

```
polyglobe/
├── index.html      # Complete standalone app
├── favicon.svg     # Site icon (+ favicon.ico, favicon-32.png, apple-touch-icon.png, icon-512.png)
└── README.md       # This file
```

## 🔧 Technology Stack

- **React 18** - UI framework (via CDN)
- **globe.gl** - 3D WebGL globe visualization
- **Three.js** - 3D rendering engine
- **Babel** - JSX transformation (browser)

## 📜 License

MIT License - Feel free to use and modify.

## 🙏 Credits

- [Polymarket](https://polymarket.com) - Prediction market data
- [globe.gl](https://globe.gl) - Globe visualization library
- [Three.js](https://threejs.org) - 3D graphics
- Inspired by [PizzINT Polyglobe](https://pizzint.watch/polyglobe)

---

**Disclaimer:** This is an educational project. Trading on prediction markets involves financial risk. Always do your own research.
