# ConnecTHOR — project history

A summary of the original build conversation (Oct 2026), so a new Claude session or account has the same memory. `CLAUDE.md` holds the working rules and the to-do list. This file is the background: what was asked, what was decided and why.

## About the owner
- GitHub `dekabet`. Runs Claude Code in the terminal on a MacBook (a different Claude account and GitHub account from the original build).
- Main browser: **Brave**. Also uses Safari. Times are wanted in **London / Central Europe**, not UTC.
- Prefers that Claude works autonomously ("check what can be improved and improve it"), with polish, smooth motion and facts without clutter.
- Merges PRs themselves. Wants to launch on X/Twitter for feedback.

## Timeline
1. **News feed fix:** NewsAPI's free plan blocks non-localhost browsers, so the deployed site falls back to RSS. Fixed: feeds load in parallel, rss2json UTC dates parse correctly, the dead Reuters feed is replaced, and the panel no longer flashes on refresh.
2. **Rebuilt as a PizzINT-style dashboard:** Pentagon Pizza Watch (modeled busyness, because Google Popular Times has no API), DOUGHCON 5→1, the Nothing Ever Happens index, and a globe sized to its panel (it had been sized to the window).
3. **Deeper Polymarket integration:** Gamma topic feeds, the CLOB WebSocket live price stream, Data API trades with a whale filter (≥ $5K) and globe pulses, 7-day price history, and arcs linking every place a market mentions. Also fixed `outcomePrices` parsing (live markets had been stuck at 50%).
4. **"Page not loading":**
   - The work wasn't on `main` yet; GitHub Pages deploys from `main`.
   - Then the page went **blank in Brave** while Safari worked. Cause: no WebGL in Brave, so globe.gl threw and React unmounted the whole page. Fixed with a 2D FlatMap fallback and error boundaries per section.
5. **More venues:** Kalshi, Manifold (play money, Ṁ) and PredictIt, plus "same question elsewhere" odds-gap matching.
6. **Calmer animation:** the owner found it "weird and too quick". Root cause: live price ticks rebuilt the globe's arcs, rings and points every second. Fixed by keeping the data objects stable, with a slower spotlight and rotation. Zulu replaced by London + Central Europe clocks.
7. **Polish pass:**
   - The ticker swaps content only between loops, at a steady 30px/s.
   - Markers update in place.
   - Hotspots tab, country labels on the globe, headlines linked to markets, time to close, 24h volume, reduced-motion support, pausing in hidden tabs.
   - First favicon (SVG).
8. **Research + more facts:**
   - Favicon as ICO/PNG too (Safari ignores SVG).
   - adsb.lol military aircraft layer and layer toggles.
   - GDELT conflict-coverage chart.
   - PizzINT-style signal types (Nuclear / Aerial / Naval / Cyber / Ground…).
   - Doomsday Clock (85 s, Jan 2026).
   - Shareable `#m=<id>` links and Esc to close.
9. **Launch review:** PizzINT credit, a footer, generic shop names and removing the NewsAPI key are still to do (see CLAUDE.md). A Cloudflare Pages + Functions move is recommended, so feeds go through a cached `/api` proxy that holds up under traffic.
10. **Handoff:** CLAUDE.md and this file were written so the project can move to another repo/account and Claude session.
11. **Move (2026-10-22):** the repo moved to `mbp-agentz/connecthor`; the site is now https://mbp-agentz.github.io/connecthor/. First work there: the pre-launch fixes (generic shop names, NewsAPI removed, footer with credit and disclaimer, share-card tags).

## Decisions and why
| Decision | Why |
|---|---|
| Single static `index.html`, no build | Deploys anywhere (GitHub Pages / Cloudflare Pages); the owner can edit it directly |
| Pinned CDN versions | Unpinned Babel/React could break the page without warning |
| Pizza data clearly labelled MODELED | No lawful public Popular Times API; don't pass simulation off as real |
| Real-money venues only in the NEH index and $ totals | Manifold mana isn't money |
| Every feed has a fallback | The page must never go blank; the sandbox couldn't verify the live APIs |
| Ticker/globe data kept stable | Rebinding to live data caused jumpy animation |

## Pull requests
- dekabet/connecthor#1: news fix, PizzINT-style rebuild, Polymarket connections
- dekabet/connecthor#2: Brave fix, more venues, smoother motion, hotspots, aircraft, favicons
- dekabet/connecthor#3: CLAUDE.md + this history (handoff)
