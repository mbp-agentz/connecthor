// Mjölnir: betting odds set against the stocks, commodities and currencies that should price the
// same risk. Runs hourly in GitHub Actions (.github/workflows/mjolnir.yml) and writes mjolnir.json
// to the mjolnir-data branch; the page reads it from raw.githubusercontent.com (no Pages Function).
// Odds: Polymarket (Gamma + CLOB price history). Stocks, commodities, FX: Yahoo Finance's chart API
// (free, no key, unofficial), else Twelve Data (official, free key in TWELVEDATA_API_KEY: 800 calls a
// day, 8 a minute, US listings + FX only, so foreign names fall back to a US-listed proxy or drop
// out). Stooq sits behind a bot check now. Crypto: Coinbase Exchange, else Kraken (both public, no key).
// Usage: node tools/mjolnir.mjs [out.json]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.argv[2] || 'mjolnir.json', PREV = process.argv[3] || OUT; // previous file carries the list of past lightning
const UA = 'Mozilla/5.0 (compatible; ConnecTHOR-Mjolnir/1.0; +https://github.com/mbp-agentz/connecthor)';
const GAMMA = 'https://gamma-api.polymarket.com', CLOB = 'https://clob.polymarket.com';
const H = 3600e3, DAY = 24 * H;

// Each hotspot and the prices most exposed to it. s = which way the price goes when the risk rises
// (TSMC falls on Taiwan risk, so s = -1). x = exchange key in the page's EXCH table (bolt target).
const THEMES = [
  { id: 'iran', country: 'Iran', in: ['Iran'], re: /strike|attack|war|military|invade|hormuz|regime|nuclear|ceasefire|deal/i,
    assets: [{ sym: 'BZ=F', td: 'BNO', n: 'Brent crude', x: 'ice', s: 1 }, { sym: 'LMT', td: 'LMT', n: 'Lockheed Martin', x: 'nyse', s: 1 }] },
  { id: 'israel', country: 'Israel', in: ['Israel', 'Gaza', 'Lebanon'], re: /ceasefire|strike|hezbollah|hamas|war|attack|invade|hostage/i,
    assets: [{ sym: 'ILS=X', td: 'USD/ILS', n: 'USD/Shekel', x: 'tase', s: 1 }, { sym: 'ESLT', td: 'ESLT', n: 'Elbit Systems', x: 'nasdaq', s: 1 }] },
  { id: 'taiwan', country: 'Taiwan', in: ['Taiwan', 'China'], re: /invade|invasion|blockade|taiwan|military|clash/i,
    assets: [{ sym: '2330.TW', td: 'TSM', n: 'TSMC', x: 'twse', s: -1 }, { sym: 'TWD=X', td: 'USD/TWD', n: 'USD/Taiwan dollar', x: 'twse', s: 1 }] },
  { id: 'ukraine', country: 'Ukraine', in: ['Ukraine', 'Russia'], re: /ceasefire|peace|truce|war|deal|invade|capture|offensive/i,
    assets: [{ sym: 'RHM.DE', n: 'Rheinmetall', x: 'xetra', s: 1 }, { sym: 'TTF=F', n: 'EU gas (TTF)', x: 'ttf', s: 1 }] },
  { id: 'venezuela', country: 'Venezuela', in: ['Venezuela'], re: /military|invade|strike|action|maduro|attack|war/i,
    assets: [{ sym: 'CL=F', td: 'USO', n: 'WTI crude', x: 'nymex', s: 1 }] },
  { id: 'nk', country: 'North Korea', in: ['North Korea', 'South Korea'], re: /icbm|missile|nuclear|test|launch|war|attack/i,
    assets: [{ sym: '^KS11', td: 'EWY', n: 'KOSPI', x: 'krx', s: -1 }, { sym: '7011.T', n: 'Mitsubishi Heavy', x: 'tse', s: 1 }] },
  { id: 'yemen', country: 'Yemen', in: ['Yemen'], re: /houthi|red sea|ship|attack|strike|war/i,
    assets: [{ sym: 'MAERSK-B.CO', n: 'Maersk', x: 'cph', s: 1 }, { sym: 'BZ=F', td: 'BNO', n: 'Brent crude', x: 'ice', s: 1 }] },
];
// Crypto never closes, so it still says something on weekends. Bitcoin trades as a risk asset (falls when
// fear rises); PAXG is tokenised gold, the safe haven. Bolts go to one point (Coinbase, San Francisco).
const BTC = { cb: 'BTC-USD', kr: 'XBTUSD', n: 'Bitcoin', x: 'crypto', k: 'crypto', s: -1 };
const GOLD = { cb: 'PAXG-USD', kr: 'PAXGUSD', n: 'Gold token (PAXG)', x: 'crypto', k: 'crypto', s: 1 };
const CRYPTO = { iran: [BTC, GOLD], israel: [BTC, GOLD], taiwan: [BTC, GOLD], ukraine: [BTC, GOLD], venezuela: [BTC], nk: [BTC], yemen: [BTC] };
// Fear gauges: what options traders pay for protection. They jump on real fear even when prices
// hardly move yet, so they sharpen the price side. Cboe indices on Yahoo; no Twelve Data proxy.
const OVX = { sym: '^OVX', n: 'Oil volatility (OVX)', x: 'cboe', k: 'vol', s: 1 };
const GVZ = { sym: '^GVZ', n: 'Gold volatility (GVZ)', x: 'cboe', k: 'vol', s: 1 };
const VIX = { sym: '^VIX', n: 'Stock volatility (VIX)', x: 'cboe', k: 'vol', s: 1 };
const VOL = { iran: [OVX], israel: [GVZ], taiwan: [VIX], ukraine: [GVZ], venezuela: [OVX], nk: [VIX], yemen: [OVX] };
// "Yes" on these questions means less risk (a ceasefire holds, a deal is signed)
const CALM_RE = /ceasefire|peace|truce|deal|agreement|normaliz|recogni|release|withdraw/i;
const MIN_VOL = 20000; // a thinner market moves on a single trade

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const LOCS = Function('return ' + html.match(/const LOCS=(\{[^\n]*?\});/)[1])();

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return await r.json();
    } catch (e) { if (i >= tries - 1) throw e; await sleep(1500 * (i + 1)); }
  }
}
const num = v => { const n = +v; return isFinite(n) ? n : 0 };
const parseArr = v => { try { return Array.isArray(v) ? v : JSON.parse(v || '[]') } catch { return [] } };
const countriesIn = q => { const l = ' ' + q.toLowerCase() + ' '; return new Set(Object.entries(LOCS).filter(([k]) => l.includes(k)).map(([, v]) => v.c)) };

// ---- odds: the busiest open Polymarket market per theme ----
async function pickMarkets() {
  const now = Date.now(), all = new Map();
  for (const t of ['geopolitics', 'world', 'middle-east']) {
    const evs = await getJSON(`${GAMMA}/events?closed=false&active=true&limit=100&order=volume24hr&ascending=false&tag_slug=${t}`);
    for (const e of evs) for (const m of e.markets || []) {
      if (m.closed || !m.conditionId || all.has(m.conditionId)) continue;
      const p = num(parseArr(m.outcomePrices)[0]), tok = parseArr(m.clobTokenIds)[0];
      if (!tok || p <= 0.03 || p >= 0.97) continue;                      // decided or near it
      if (!(Date.parse(m.endDate || '') > now + 3 * DAY)) continue;       // about to resolve: drifts to 0/1
      all.set(m.conditionId, { id: m.conditionId, q: m.question, url: `https://polymarket.com/event/${e.slug}`, tok, p, vol: num(m.volume), vol24: num(m.volume24hr), cs: countriesIn(m.question || '') });
    }
  }
  const out = {};
  for (const th of THEMES) {
    const c = [...all.values()].filter(m => m.vol >= MIN_VOL && th.re.test(m.q) && th.in.some(x => m.cs.has(x)));
    // the market people trade most today, so the 24 h move means something
    out[th.id] = c.sort((a, b) => b.vol24 - a.vol24 || b.vol - a.vol)[0] || null;
  }
  return out;
}
async function oddsSeries(tok) {
  const now = Math.floor(Date.now() / 1000);
  const d = await getJSON(`${CLOB}/prices-history?market=${tok}&startTs=${now - 27 * 3600}&endTs=${now}&fidelity=60`);
  return (d.history || []).map(x => ({ t: x.t * 1000, v: num(x.p) })).filter(x => x.v > 0);
}

// ---- prices ----
// Every source returns [{t ms, v close}] oldest first
async function yahoo(sym, range, interval) {
  let err;
  for (const host of ['query1', 'query2']) {
    try {
      const d = await getJSON(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`, 2);
      const r = d.chart && d.chart.result && d.chart.result[0]; if (!r) throw new Error('no chart ' + sym);
      const ts = r.timestamp || [], cl = (r.indicators.quote[0] || {}).close || [];
      return ts.map((t, i) => ({ t: t * 1000, v: cl[i] })).filter(x => x.v != null && x.v > 0);
    } catch (e) { err = e }
  }
  throw err;
}
const TD_KEY = process.env.TWELVEDATA_API_KEY || '';
let tdLast = 0;
async function twelve(sym, interval, size) {
  const wait = tdLast + 8000 - Date.now(); if (wait > 0) await sleep(wait); tdLast = Date.now(); // free plan: 8 calls a minute
  const d = await getJSON(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${interval}&outputsize=${size}&timezone=UTC&apikey=${TD_KEY}`, 1);
  if (d.status === 'error' || !Array.isArray(d.values)) throw new Error('Twelve Data ' + sym + ': ' + (d.message || 'no values'));
  return d.values.map(x => ({ t: Date.parse(x.datetime.replace(' ', 'T') + (x.datetime.length > 10 ? 'Z' : 'T00:00:00Z')), v: num(x.close) })).filter(x => x.v > 0).reverse();
}
async function coinbase(p, gran) {
  const d = await getJSON(`https://api.exchange.coinbase.com/products/${p}/candles?granularity=${gran}`, 2); // [time, low, high, open, close, vol], newest first
  return d.map(x => ({ t: x[0] * 1000, v: num(x[4]) })).filter(x => x.v > 0).reverse();
}
async function kraken(p, mins) {
  const d = await getJSON(`https://api.kraken.com/0/public/OHLC?pair=${p}&interval=${mins}`, 2);
  if (d.error && d.error.length) throw new Error('Kraken ' + d.error.join(' '));
  const k = Object.keys(d.result).find(x => x !== 'last'); // [time, open, high, low, close, vwap, vol, count]
  return d.result[k].map(x => ({ t: x[0] * 1000, v: num(x[4]) })).filter(x => x.v > 0);
}
const sdOf = s => { const r = s.slice(1).map((x, i) => Math.log(x.v / s[i].v)).filter(isFinite), m = r.reduce((t, x) => t + x, 0) / (r.length || 1); return Math.sqrt(r.reduce((t, x) => t + (x - m) ** 2, 0) / Math.max(1, r.length - 1)) };
const hourlyToDay = h => { const days = new Set(h.map(x => new Date(x.t).toISOString().slice(0, 10))).size || 1; return sdOf(h) * Math.sqrt(h.length / days) };
// hourly bars of the last days + a normal day's move (daily σ)
async function bars(a) {
  if (a.k === 'crypto') {
    try { const [hr, dy] = await Promise.all([coinbase(a.cb, 3600), coinbase(a.cb, 86400)]); return { hr, sd: sdOf(dy.slice(-90)), src: 'Coinbase' } }
    catch (e) { console.warn(e.message); const [hr, dy] = await Promise.all([kraken(a.kr, 60), kraken(a.kr, 1440)]); return { hr: hr.slice(-200), sd: sdOf(dy.slice(-90)), src: 'Kraken' } }
  }
  try {
    const [hr, dy] = await Promise.all([yahoo(a.sym, '5d', '60m'), yahoo(a.sym, '3mo', '1d')]);
    // Yahoo has no daily history for some futures (TTF): scale the hourly spread up to a day
    return { hr, sd: dy.length >= 20 ? sdOf(dy) : hourlyToDay(await yahoo(a.sym, '1mo', '60m')), src: 'Yahoo' };
  } catch (e) {
    if (!TD_KEY || !a.td) throw e;
    console.warn(e.message, '→ Twelve Data', a.td);
    const hr = await twelve(a.td, '1h', 120), dy = await twelve(a.td, '1day', 70);
    return { hr, sd: sdOf(dy), src: 'Twelve Data' + (a.td.includes('/') || a.td === a.sym ? '' : ' (' + a.td + ')') };
  }
}
const at = (s, t) => { let v = null; for (const x of s) { if (x.t <= t) v = x.v; else break } return v ?? (s[0] && s[0].v) };
// When did a series do half of its 24 h move? (the "who moved first" clock)
function halfway(s, from) {
  const ref = at(s, from), last = s[s.length - 1].v, M = last - ref;
  if (!M) return null;
  for (const x of s) if (x.t > from && (x.v - ref) / M >= 0.5) return x.t;
  return null;
}
async function assetMove(a, now) {
  const { hr, sd: raw, src } = await bars(a);
  if (hr.length < 2) throw new Error('no bars ' + (a.sym || a.cb));
  const last = hr[hr.length - 1], ref = at(hr, now - DAY), chg = last.v / ref - 1;
  const open = hr.filter(x => x.t > now - DAY).length >= 3 && now - last.t < 6 * H; // traded in this window
  const sd = Math.max(0.004, raw || 0);
  return { n: a.n, x: a.x, k: a.k || 'stock', src, chg: +chg.toFixed(4), sd: +sd.toFixed(4), open, half: open ? halfway(hr, now - DAY) : null };
}

// ---- verdict ----
const fmtPct = c => (c > 0 ? '+' : c < 0 ? '−' : '') + Math.abs(c * 100).toFixed(1) + '%';
const fmtPts = d => (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(Math.round(d * 100)) + ' pts';
const fmtGap = ms => { const m = Math.round(Math.abs(ms) / 60e3), h = Math.floor(m / 60); return h ? `${h} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}` : `${m} min` };
function judge(th, m, os, assets, now) {
  const ref = at(os, now - DAY), d = m.p - ref, risk = CALM_RE.test(m.q) ? -1 : 1;
  const sdOdds = Math.max(0.015, 0.08 * Math.sqrt(m.p * (1 - m.p))); // a normal day's odds move: ~4 pts near 50 %, less near the ends
  const oz = d * risk / sdOdds;
  const mean = xs => xs.length ? +(xs.reduce((t, a) => t + a.z, 0) / xs.length).toFixed(2) : null, live = k => assets.filter(a => a.open && a.k === k);
  const x = { id: 'mj-' + th.id, country: th.country, q: m.q, url: m.url, marketId: m.id, p: +m.p.toFixed(3), d: +d.toFixed(3), oz: +oz.toFixed(2),
    sz: mean(live('stock')), vz: mean(live('vol')), cz: mean(live('crypto')),
    assets: assets.map(({ sd, ...a }) => a), oh: Math.abs(oz) >= 1 ? halfway(os, now - DAY) : null }; // half/oh: when each side did half its move
  return verdict(x, { stock: true, vol: true, crypto: true });
}

// The verdict. The page runs an identical copy (mjJudge in index.html) with its panel filters: keep both in step.
// Only a region's own prices (k 'stock': shares, commodities, currencies) can make lightning. Fear gauges and
// crypto are the same for every hotspot (Bitcoin can't tell Yemen from Ukraine), so they only amplify: up to
// ±15 points when they back or contradict the story, and never a signal on their own.
const MJ_FLASH = 40;
function verdict(x, f) {
  const on = a => f[a.k || 'stock'], shown = x.assets.filter(on);
  const live = x.assets.filter(a => (a.k || 'stock') === 'stock' && a.open), lead = live.slice().sort((a, b) => Math.abs(b.z) - Math.abs(a.z))[0];
  const az = live.length ? live.reduce((t, a) => t + a.z, 0) / live.length : null;
  const amp = x.assets.filter(a => a.k && a.k !== 'stock' && on(a) && a.open), W = a => a.k === 'crypto' ? 0.5 : 1, ws = amp.reduce((t, a) => t + W(a), 0);
  const mz = ws ? amp.reduce((t, a) => t + W(a) * a.z, 0) / ws : null;
  const out = { ...x, assets: shown, az: az == null ? null : +az.toFixed(2), mz: mz == null ? null : +mz.toFixed(2), boost: 0, amps: [] };
  if (az == null) return { ...out, kind: 'closed', score: 0, lead: 'Markets closed', why: `${x.assets.filter(a => (a.k || 'stock') === 'stock').map(a => a.n).join(' and ')} have not traded for most of the last 24 hours, so there is nothing to compare the odds with. Fear gauges and crypto only strengthen a signal, they never make one.` };
  const oz = x.oz, d = x.d, A = Math.abs(oz), B = Math.abs(az);
  // who moved first: the odds or the biggest-moving price
  const oh = A >= 1 ? x.oh : null, ah = B >= 1 && Math.abs(lead.z) >= 1 ? lead.half : null, gap = oh && ah ? oh - ah : null; // > 0: prices first
  const timing = gap == null ? (A >= 1 && B < 1 ? 'Odds moved, the prices on balance did not' : B >= 1 && A < 1 ? `${lead.n} moved, the odds did not` : 'Both quiet')
    : Math.abs(gap) < H ? 'Both moved within the same hour' : gap > 0 ? `${lead.n} moved ${fmtGap(gap)} before the odds` : `Odds moved ${fmtGap(gap)} before ${lead.n}`;
  const mv = `${lead.n} ${fmtPct(lead.chg)} (${Math.abs(lead.z).toFixed(1)}× a normal day)`;
  let kind, why, dir = Math.sign(oz);
  if (A < 1 && B < 1) { kind = 'quiet'; why = `Odds ${fmtPts(d)} and ${mv}: both within a normal day.` }
  else if (A >= 1 && B >= 1 && Math.sign(oz) === Math.sign(az)) {
    kind = gap != null && gap >= H ? 'lead' : 'confirm';
    why = kind === 'lead' ? `${mv} moved first and the odds (${fmtPts(d)}) followed ${fmtGap(gap)} later: the stock market priced it before the bettors.`
      : `Odds ${fmtPts(d)} and ${mv} point the same way, both beyond a normal day. Both markets tell the same story: more ${oz > 0 ? 'risk' : 'calm'}.`;
  } else if (A >= 1 && B >= 1) { kind = 'gap'; why = `The odds point to more ${oz > 0 ? 'risk' : 'calm'} (${fmtPts(d)}), ${mv} to the opposite. One of the two crowds is wrong.` }
  else if (A >= 1.5 && B < 0.5) { kind = 'gap'; why = `Odds moved ${fmtPts(d)} in 24 hours, about ${A.toFixed(1)}× a normal day, yet the prices most exposed to it barely moved on balance (${live.map(a => `${a.n} ${fmtPct(a.chg)}`).join(', ')}). Either the betting market is early, or traders think it is priced in.` }
  else if (B >= 1.5 && A < 0.5) { kind = 'gap'; dir = Math.sign(az); why = `${mv} while the odds barely changed (${fmtPts(d)}). The stock market may be pricing something the bettors have not.` }
  else { kind = 'quiet'; why = `Odds ${fmtPts(d)} and ${mv}: a small move, not a clear signal.` }
  let score = kind === 'quiet' ? Math.round(Math.min(39, 15 * Math.max(A, B))) : Math.round(Math.min(99, 40 + 12 * Math.max(A, B) + (kind === 'gap' ? 6 * Math.abs(A - B) : 4 * Math.min(A, B))));
  // amplifiers: backing the story (same direction as the signal) adds, contradicting it subtracts; below 0.5× a normal day they're noise
  if (kind !== 'quiet' && mz != null && Math.abs(mz) >= 0.5) {
    out.boost = Math.round(Math.max(-1.5, Math.min(1.5, mz * dir)) * 10);
    out.amps = amp.filter(a => Math.abs(a.z) >= 0.5 && Math.sign(a.z * dir) === Math.sign(out.boost)).map(a => a.n);
    score = Math.max(0, Math.min(99, score + out.boost));
  }
  return { ...out, kind, score, lead: timing, why };
}

async function main() {
  const now = Date.now(), picks = await pickMarkets();
  const key = a => a.sym || a.cb;
  for (const th of THEMES) th.assets = [...th.assets, ...(VOL[th.id] || []), ...(CRYPTO[th.id] || [])];
  const symbols = [...new Map(THEMES.flatMap(t => t.assets).map(a => [key(a), a])).values()];
  const moves = new Map();
  for (const a of symbols) { try { moves.set(key(a), await assetMove(a, now)) } catch (e) { console.warn(e.message) } await sleep(300) }
  const out = [];
  for (const th of THEMES) {
    const m = picks[th.id]; if (!m) { console.warn('no market for', th.id); continue }
    let os; try { os = await oddsSeries(m.tok) } catch (e) { console.warn(e.message); continue }
    if (os.length < 3) continue;
    const assets = th.assets.map(a => { const x = moves.get(key(a)); return x && { ...x, n: a.n, x: a.x, z: +(x.chg * a.s / x.sd).toFixed(2) } }).filter(Boolean);
    if (!assets.length) continue;
    const r = judge(th, m, os, assets, now); out.push(r);
    console.log(`${th.id.padEnd(9)} ${r.kind.padEnd(7)} ${String(r.score).padStart(2)}  odds ${fmtPts(r.d)} z${r.oz}  stocks z${r.sz}  amp z${r.mz} ${r.boost ? (r.boost > 0 ? '+' : '') + r.boost : ''}  | ${r.q}`);
  }
  out.sort((a, b) => b.score - a.score);
  // Past lightning (base filter: regional prices only, what every visitor sees first), newest first. A hotspot
  // that keeps flashing updates its entry for 6 h instead of adding one per run. Shown as "last real lightning".
  let prev = null;
  try { prev = /^https?:/.test(PREV) ? await getJSON(PREV, 1) : existsSync(PREV) ? JSON.parse(readFileSync(PREV, 'utf8')) : null } catch { }
  const recent = ((prev && prev.recent) || []).slice();
  for (const x of out) {
    const b = verdict(x, { stock: true, vol: false, crypto: false }); if (b.score < MJ_FLASH) continue;
    const e = { country: x.country, kind: b.kind, score: b.score, q: x.q, url: x.url, at: new Date(now).toISOString() }, k = recent.findIndex(r => r.country === x.country && now - Date.parse(r.at) < 6 * H);
    if (k >= 0) recent[k] = { ...e, at: recent[k].at, score: Math.max(recent[k].score, e.score) }; else recent.unshift(e);
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ updated: new Date(now).toISOString(), signals: out, recent: recent.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 10) }));
  console.log(`wrote ${OUT}: ${out.filter(x => x.score >= MJ_FLASH).length} signals, ${out.length} themes`);
}
main().catch(e => { console.error(e); process.exit(1) });
