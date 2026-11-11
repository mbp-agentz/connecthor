// Valkyries: who calls geopolitics right, and how right the markets themselves are.
// 1. Smart money: wallets ranked by their record on resolved geopolitical Polymarket markets,
//    and what they hold now on open ones ("picks").
// 2. Track record: an archive of resolved Polymarket and Kalshi markets with the price a week
//    before the close, grouped into calibration bins by venue and topic.
// Runs every 6 h in GitHub Actions (.github/workflows/valkyries.yml), force-pushes valkyries.json
// to the valkyries-data branch; the page reads it from raw.githubusercontent.com (no Pages Function).
// Usage: node tools/valkyries.mjs [out.json] [previous.json or URL, to grow the archive]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.argv[2] || 'valkyries.json', PREV = process.argv[3] || OUT;
const UA = 'ConnecTHOR-Valkyries/1.0 (+https://github.com/mbp-agentz/connecthor)';
const GAMMA = 'https://gamma-api.polymarket.com', DATA = 'https://data-api.polymarket.com', CLOB = 'https://clob.polymarket.com';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2', KALSHI_TAGS = ['Iran', 'International', 'International elections'];
const DAY = 864e5, NOW = Date.now();
const LOOKBACK = 120 * DAY;  // resolved markets for the wallet record
const KEEP = 365 * DAY;      // archive horizon
const NEW_PER_RUN = 150;     // price lookups per venue per run (the archive grows run by run)

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const LOCS = Function('return ' + html.match(/const LOCS=(\{[^\n]*?\});/)[1])();
const CONFLICT_RE = Function('return ' + html.match(/const CONFLICT_RE=(\/.*?\/i);/)[1])();
const place = q => { const l = ' ' + String(q).toLowerCase() + ' '; let best = null; for (const [k, v] of Object.entries(LOCS)) { if (k === 'bitcoin' || k === 'fed') continue; const i = l.indexOf(k); if (i >= 0 && (!best || i < best.i)) best = { i, c: v.c } } return best && best.c };
const topic = q => CONFLICT_RE.test(q) ? 'war' : /elect|vote|president|prime minister|parliament|referendum|chancellor|leader/i.test(q) ? 'elections' : /deal|agree|talks|meet|summit|treaty|recogni|sanction|ceasefire|visit/i.test(q) ? 'diplomacy' : 'other';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
      if (r.status === 429 && i < tries - 1) { await sleep(2500 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 120)}`);
      return await r.json();
    } catch (e) { if (i >= tries - 1) throw e; await sleep(1500 * (i + 1)); }
  }
}
const num = v => { const n = +v; return isFinite(n) ? n : 0 };
const parseArr = v => { try { return Array.isArray(v) ? v : JSON.parse(v || '[]') } catch { return [] } };
async function pool(items, n, fn, gap = 0) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; if (gap) await sleep(gap); try { out[k] = await fn(items[k]) } catch (e) { console.warn(e.message); out[k] = null } } }));
  return out;
}
const short = w => w.slice(0, 6) + '…' + w.slice(-4);
// reference moment for "what the market said": a week before the close, or halfway for short markets
const refTime = (open, close) => close - Math.min(7 * DAY, Math.max(DAY / 2, (close - open) / 2));

// ---- Polymarket markets ----
const TAGS = ['geopolitics', 'world', 'middle-east'];
async function gammaEvents(closed) {
  const out = [];
  for (const t of TAGS) for (let off = 0; off < (closed ? 400 : 200); off += 100) {
    const evs = await getJSON(`${GAMMA}/events?closed=${closed}&limit=100&offset=${off}&tag_slug=${t}&` + (closed ? 'order=closedTime&ascending=false' : 'active=true&order=volume24hr&ascending=false'));
    out.push(...evs); if (evs.length < 100) break;
    if (closed && evs.every(e => Date.parse(e.closedTime || e.endDate || 0) < NOW - KEEP)) break;
  }
  return out;
}
function pmMarkets(evs, closed) {
  const seen = new Map();
  for (const e of evs) for (const m of e.markets || []) {
    if (!m.conditionId || seen.has(m.conditionId) || !!m.closed !== closed) continue;
    const prices = parseArr(m.outcomePrices).map(num), outcomes = parseArr(m.outcomes), tokens = parseArr(m.clobTokenIds);
    const country = place(m.question || ''); if (!country || prices.length !== 2) continue;
    const x = { id: m.conditionId, question: m.question, url: `https://polymarket.com/event/${e.slug}`, country, outcomes, prices, token: tokens[0], vol: num(m.volumeNum ?? m.volume) };
    if (closed) {
      const win = prices.findIndex(p => p >= 0.99); if (win < 0) continue; // not settled cleanly
      x.win = win; x.close = Date.parse(m.closedTime || m.endDate || ''); x.open = Date.parse(m.startDate || m.createdAt || e.startDate || '');
      if (!isFinite(x.close) || x.close < NOW - KEEP) continue;
    } else if (prices[0] >= 0.99 || prices[0] <= 0.01) continue;
    seen.set(m.conditionId, x);
  }
  return [...seen.values()];
}

// ---- 1. smart money ----
async function tradesOf(m) {
  const rows = []; let cursor = '';
  for (let page = 0; page < 3; page++) {
    const d = await getJSON(`${DATA}/v2/trades?condition_id=${m.id}&limit=500&filter_type=CASH&filter_amount=500${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
    rows.push(...(d.data || []));
    cursor = d.pagination?.next_cursor; if (!d.pagination?.has_more || !cursor) break;
  }
  return rows;
}
// Each trade is scored at resolution. Only real forecasts count: paid 5–85¢, before the close
function scoreWallets(resolved, trades) {
  const by = new Map();
  resolved.forEach((m, i) => {
    for (const t of trades[i] || []) {
      const w = t.proxy_wallet, ts = num(t.timestamp) * 1000, price = num(t.price), size = num(t.size), oi = num(t.outcome_index);
      if (!w || ts > m.close) continue;
      const sell = t.side === 'SELL', paid = sell ? 1 - price : price; if (paid < 0.05 || paid > 0.85) continue;
      const won = (oi === m.win) !== sell, stake = size * paid, pnl = won ? size * (1 - paid) : -stake;
      const x = by.get(w) || { wallet: w, who: t.pseudonym || t.name || short(w), pnl: 0, staked: 0, wonUsd: 0, markets: new Set(), lead: 0 };
      x.pnl += pnl; x.staked += stake; if (won) x.wonUsd += stake; x.markets.add(m.id); x.lead += stake * (m.close - ts) / DAY;
      by.set(w, x);
    }
  });
  return [...by.values()].filter(x => x.markets.size >= 3 && x.staked >= 5000 && x.pnl > 0)
    .map(x => ({ wallet: x.wallet, who: x.who, pnl: Math.round(x.pnl), staked: Math.round(x.staked), roi: +(x.pnl / x.staked).toFixed(3), hitRate: +(x.wonUsd / x.staked).toFixed(3), markets: x.markets.size, leadDays: Math.round(x.lead / x.staked) }))
    .sort((a, b) => b.pnl - a.pnl).slice(0, 20);
}
async function picksOf(wallets, open) {
  const byId = new Map(open.map(m => [m.id, m])), picks = new Map();
  const pos = await pool(wallets, 3, w => getJSON(`${DATA}/v2/positions?user=${w.wallet}&limit=200`).then(d => d.data || []), 200);
  wallets.forEach((w, i) => {
    w.open = [];
    for (const p of pos[i] || []) {
      const m = byId.get(p.condition_id), value = num(p.current_value) || num(p.current_size) * num(p.current_price);
      if (!m || value < 100) continue;
      const oi = num(p.outcome_index), first = Date.parse(p.first_entry_at || '');
      const row = { id: m.id, question: m.question, url: m.url, country: m.country, outcome: p.outcome || m.outcomes[oi], avg: +num(p.avg_price).toFixed(3), now: +num(p.current_price).toFixed(3), value: Math.round(value), recent: isFinite(first) && first > NOW - 7 * DAY };
      w.open.push(row);
      const k = m.id + ':' + oi, x = picks.get(k) || { id: m.id, question: m.question, url: m.url, country: m.country, outcome: row.outcome, now: row.now, wallets: 0, value: 0, avgW: 0, recent: 0 };
      x.wallets++; x.value += row.value; x.avgW += row.avg * row.value; if (row.recent) x.recent++; picks.set(k, x);
    }
    w.open.sort((a, b) => b.value - a.value); w.open = w.open.slice(0, 6);
  });
  return [...picks.values()].map(({ avgW, ...x }) => ({ ...x, avg: +(avgW / x.value).toFixed(3) }))
    .sort((a, b) => b.wallets - a.wallets || b.value - a.value).slice(0, 15);
}

// ---- 2. track record ----
async function pmRef(m) {
  const ref = refTime(isFinite(m.open) ? m.open : m.close - 14 * DAY, m.close);
  const d = await getJSON(`${CLOB}/prices-history?market=${m.token}&startTs=${Math.floor((ref - DAY) / 1000)}&endTs=${Math.floor((ref + DAY / 2) / 1000)}&fidelity=60`);
  const h = (d.history || []).filter(x => isFinite(+x.p)); if (!h.length) return null;
  const at = h.reduce((b, x) => Math.abs(x.t * 1000 - ref) < Math.abs(b.t * 1000 - ref) ? x : b);
  return { id: 'pm:' + m.id, v: 'pm', q: m.question.slice(0, 120), k: topic(m.question), c: m.country, p: +num(at.p).toFixed(3), y: m.win === 0 ? 1 : 0, t: m.close };
}
async function kalshiSettled() {
  const series = new Map();
  for (const tg of KALSHI_TAGS) {
    const d = await getJSON(`${KALSHI}/series?tags=${encodeURIComponent(tg)}`);
    for (const s of d.series || []) if (!series.has(s.ticker) && (place(s.title || '') || (s.tags || []).includes('Iran'))) series.set(s.ticker, s);
  }
  const lists = await pool([...series.keys()], 3, t => getJSON(`${KALSHI}/markets?status=settled&series_ticker=${t}&limit=200`).then(d => (d.markets || []).map(m => ({ ...m, series: t }))), 350);
  return lists.flat().filter(m => (m.result === 'yes' || m.result === 'no') && num(m.volume_fp) >= 1000 && Date.parse(m.close_time) > NOW - KEEP);
}
async function ksRef(m) {
  const close = Date.parse(m.close_time), ref = refTime(Date.parse(m.open_time) || close - 14 * DAY, close);
  const d = await getJSON(`${KALSHI}/series/${m.series}/markets/${m.ticker}/candlesticks?start_ts=${Math.floor((ref - 2 * DAY) / 1000)}&end_ts=${Math.floor((ref + DAY) / 1000)}&period_interval=1440`);
  const cs = (d.candlesticks || []).filter(c => c.end_period_ts * 1000 <= ref + DAY);
  const c = cs[cs.length - 1]; if (!c) return null;
  const traded = num(c.price?.close_dollars), bid = num(c.yes_bid?.close_dollars), ask = num(c.yes_ask?.close_dollars);
  const p = traded > 0 ? traded : bid > 0 && ask > 0 && ask - bid <= 0.2 ? (bid + ask) / 2 : null; // a 3¢/99¢ book says nothing
  if (p == null) return null;
  const q = m.title + (m.yes_sub_title && !m.title.includes(m.yes_sub_title) ? ` (${m.yes_sub_title})` : '');
  return { id: 'ks:' + m.ticker, v: 'ks', q: q.slice(0, 120), k: topic(q), c: place(q) || place(m.title), p: +p.toFixed(3), y: m.result === 'yes' ? 1 : 0, t: close };
}
const BINS = [[0, .2], [.2, .4], [.4, .6], [.6, .8], [.8, 1.01]];
function summary(recs) {
  const one = rs => rs.length ? { n: rs.length, brier: +(rs.reduce((a, r) => a + (r.p - r.y) ** 2, 0) / rs.length).toFixed(3), bins: BINS.map(([lo, hi]) => { const b = rs.filter(r => r.p >= lo && r.p < hi); return { lo, hi: Math.min(hi, 1), n: b.length, p: b.length ? +(b.reduce((a, r) => a + r.p, 0) / b.length).toFixed(3) : null, hit: b.length ? +(b.reduce((a, r) => a + r.y, 0) / b.length).toFixed(3) : null } }) } : null;
  const out = {};
  for (const v of ['all', 'pm', 'ks']) { out[v] = {}; for (const k of ['all', 'war', 'elections', 'diplomacy', 'other']) out[v][k] = one(recs.filter(r => (v === 'all' || r.v === v) && (k === 'all' || r.k === k))) }
  return out;
}

async function loadPrev() {
  try {
    if (/^https?:/.test(PREV)) { const r = await fetch(PREV, { headers: { 'user-agent': UA } }); return r.ok ? await r.json() : null }
    return existsSync(PREV) ? JSON.parse(readFileSync(PREV, 'utf8')) : null;
  } catch (e) { console.warn('no previous archive:', e.message); return null }
}

async function main() {
  const [prev, closedEv, openEv] = await Promise.all([loadPrev(), gammaEvents(true), gammaEvents(false)]);
  const resolved = pmMarkets(closedEv, true), open = pmMarkets(openEv, false);
  console.log(`${resolved.length} resolved, ${open.length} open Polymarket markets`);

  // 1. smart money: the 80 biggest resolved markets of the last 120 days
  const recent = resolved.filter(m => m.close > NOW - LOOKBACK).sort((a, b) => b.vol - a.vol).slice(0, 80);
  const trades = await pool(recent, 4, tradesOf, 100);
  const wallets = scoreWallets(recent, trades);
  const picks = wallets.length ? await picksOf(wallets, open) : [];
  console.log(`${wallets.length} wallets, ${picks.length} picks`);

  // 2. archive: keep what we had, add up to NEW_PER_RUN markets per venue
  const arch = new Map((prev?.records || []).filter(r => r.t > NOW - KEEP).map(r => [r.id, r]));
  const pmNew = resolved.filter(m => m.token && m.vol >= 10000 && !arch.has('pm:' + m.id)).sort((a, b) => b.close - a.close).slice(0, NEW_PER_RUN);
  const ksAll = await kalshiSettled().catch(e => (console.warn('Kalshi', e.message), []));
  const ksNew = ksAll.filter(m => !arch.has('ks:' + m.ticker)).slice(0, NEW_PER_RUN);
  const [pmR, ksR] = await Promise.all([pool(pmNew, 4, pmRef, 50), pool(ksNew, 2, ksRef, 400)]);
  for (const r of [...pmR, ...ksR]) if (r) arch.set(r.id, r);
  const records = [...arch.values()].sort((a, b) => b.t - a.t);
  console.log(`archive ${records.length} (+${pmR.filter(Boolean).length} Polymarket, +${ksR.filter(Boolean).length} Kalshi)`);

  const out = { updated: new Date().toISOString(), resolvedChecked: recent.length, wallets, picks, calibration: summary(records), records };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  console.log('→', OUT);
}
main().catch(e => { console.error(e); process.exit(1) });
