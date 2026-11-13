// Wallet profiles (subscriber feature, draft): how the best geopolitical Polymarket bettors actually bet.
// Every trade on the busiest geopolitical markets resolved in the last LOOKBACK days is rebuilt into
// positions (buys, sells before the close, payout at resolution), then each wallet gets a profile:
// record, edge over the price it paid and whether that edge is more than luck, preferred odds,
// timing, holding style, topics and places. Kalshi has no per-account data (trades are anonymous).
// The output is for paying users: never publish it to a public branch (the repo is public).
// A second, public teaser file (counts + two sample profiles) is what visitors without a subscription see;
// the Action publishes only that one (insights-data branch) and throws the full file away.
// Usage: node tools/profiles.mjs out.json [teaser.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.argv[2] || 'profiles.json', TEASER = process.argv[3] || '';
const UA = 'ConnecTHOR-Profiles/1.0 (+https://github.com/mbp-agentz/connecthor)';
const GAMMA = 'https://gamma-api.polymarket.com', DATA = 'https://data-api.polymarket.com';
const DAY = 864e5, NOW = Date.now();
const LOOKBACK = 180 * DAY;  // resolved markets in this window
const MARKETS = 150;         // busiest resolved markets that are scanned
const PAGES = 6;             // trade pages (500 each) per market
const MIN_TRADE = 100;       // USD per trade; smaller fills are noise and cost pages
const MIN_BETS = 8;          // a profile needs this many settled positions

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const LOCS = Function('return ' + html.match(/const LOCS=(\{[^\n]*?\});/)[1])();
const CONFLICT_RE = Function('return ' + html.match(/const CONFLICT_RE=(\/.*?\/i);/)[1])();
const place = q => { const l = ' ' + String(q).toLowerCase() + ' '; let best = null; for (const [k, v] of Object.entries(LOCS)) { if (k === 'bitcoin' || k === 'fed') continue; const i = l.indexOf(k); if (i >= 0 && (!best || i < best.i)) best = { i, c: v.c } } return best && best.c };
const topic = q => CONFLICT_RE.test(q) || /airspace|strike|attack|blockade|military|missile|invade|troops|bomb|drone|clash|hormuz/i.test(q) ? 'war' : /elect|vote|president|prime minister|parliament|referendum|chancellor|leader/i.test(q) ? 'elections' : /deal|agree|talks|meet|summit|treaty|recogni|sanction|ceasefire|visit/i.test(q) ? 'diplomacy' : 'other';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
      if (r.status === 429 && i < tries - 1) { await sleep(3000 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 120)}`);
      return await r.json();
    } catch (e) { if (i >= tries - 1) throw e; await sleep(1500 * (i + 1)); }
  }
}
const num = v => { const n = +v; return isFinite(n) ? n : 0 };
const parseArr = v => { try { return Array.isArray(v) ? v : JSON.parse(v || '[]') } catch { return [] } };
async function pool(items, n, fn, gap = 0) {
  const out = []; let i = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; if (gap) await sleep(gap); try { out[k] = await fn(items[k]) } catch (e) { console.warn(e.message); out[k] = null } if (++done % 25 === 0) console.log(`  ${done}/${items.length}`) } }));
  return out;
}
const short = w => w.slice(0, 6) + '…' + w.slice(-4);

// ---- resolved geopolitical markets ----
async function resolvedMarkets() {
  const seen = new Map();
  for (const t of ['geopolitics', 'world', 'middle-east']) for (let off = 0; off < 600; off += 100) {
    const evs = await getJSON(`${GAMMA}/events?closed=true&limit=100&offset=${off}&tag_slug=${t}&order=closedTime&ascending=false`);
    for (const e of evs) for (const m of e.markets || []) {
      if (!m.conditionId || seen.has(m.conditionId) || !m.closed) continue;
      const prices = parseArr(m.outcomePrices).map(num), win = prices.findIndex(p => p >= 0.99), close = Date.parse(m.closedTime || m.endDate || '');
      const country = place(m.question || '');
      if (!country || prices.length !== 2 || win < 0 || !(close > NOW - LOOKBACK)) continue;
      seen.set(m.conditionId, { id: m.conditionId, ev: e.slug, q: m.question, url: `https://polymarket.com/event/${e.slug}`, country, topic: topic(m.question), win, close, outcomes: parseArr(m.outcomes), vol: num(m.volumeNum ?? m.volume) });
    }
    if (evs.length < 100 || evs.every(e => Date.parse(e.closedTime || e.endDate || 0) < NOW - LOOKBACK)) break;
  }
  return [...seen.values()].sort((a, b) => b.vol - a.vol).slice(0, MARKETS);
}
async function tradesOf(m) {
  const rows = []; let cursor = '';
  for (let page = 0; page < PAGES; page++) {
    const d = await getJSON(`${DATA}/v2/trades?condition_id=${m.id}&limit=500&filter_type=CASH&filter_amount=${MIN_TRADE}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
    rows.push(...(d.data || []));
    cursor = d.pagination?.next_cursor; if (!d.pagination?.has_more || !cursor) break;
  }
  return rows;
}

// ---- positions: one per wallet × market × outcome ----
// cost of buys, proceeds of sells before the close, remaining shares paid 1 or 0 at resolution
function positions(markets, trades) {
  const pos = new Map();
  markets.forEach((m, i) => {
    for (const t of trades[i] || []) {
      const w = t.proxy_wallet, ts = num(t.timestamp) * 1000, price = num(t.price), size = num(t.size), oi = num(t.outcome_index);
      if (!w || !size || ts > m.close) continue;
      const k = w + '|' + m.id + '|' + oi, p = pos.get(k) || { w, who: t.pseudonym || t.name || '', m, oi, buyQ: 0, buyC: 0, sellQ: 0, sellP: 0, first: ts };
      if (t.side === 'BUY') { p.buyQ += size; p.buyC += size * price; p.first = Math.min(p.first, ts) } else { p.sellQ += size; p.sellP += size * price }
      pos.set(k, p);
    }
  });
  return [...pos.values()].filter(p => p.buyQ > 0).map(p => {
    const paid = p.buyC / p.buyQ, sold = Math.min(p.sellQ, p.buyQ), left = p.buyQ - sold, won = p.oi === p.m.win;
    const pnl = (sold ? p.sellP * (sold / p.sellQ) : 0) + (won ? left : 0) - p.buyC;
    return { ...p, paid, won, pnl, stake: p.buyC, soldShare: sold / p.buyQ, lead: (p.m.close - p.first) / DAY };
  });
}

// ---- profiles ----
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0 };
function profile(w, ps) {
  const bets = ps.filter(p => p.paid >= 0.03 && p.paid <= 0.97); // near-certain fills say nothing about judgement
  if (bets.length < MIN_BETS) return null;
  const marketsBoth = new Set(), seenM = new Map();
  for (const p of ps) { const o = seenM.get(p.m.id); if (o != null && o !== p.oi) marketsBoth.add(p.m.id); seenM.set(p.m.id, p.oi) }
  const staked = bets.reduce((t, p) => t + p.stake, 0), pnl = bets.reduce((t, p) => t + p.pnl, 0);
  // edge = how often the bet won minus the price paid (what the market said); z = that edge against
  // the spread luck alone would give: above ~2 it's unlikely to be a lucky streak
  // Deadline ladders ("by June 8", "by June 15"…) are one call, not several: bets are grouped by event
  // and each event counts once (its mean edge and variance), so a ladder can't inflate the evidence
  const evs = new Map(); for (const p of bets) { const a = evs.get(p.m.ev) || []; a.push(p); evs.set(p.m.ev, a) }
  let edgeE = 0, varE = 0; for (const a of evs.values()) { edgeE += a.reduce((t, p) => t + (p.won ? 1 : 0) - p.paid, 0) / a.length; varE += a.reduce((t, p) => t + p.paid * (1 - p.paid), 0) / a.length }
  const edge = bets.reduce((t, p) => t + (p.won ? 1 : 0) - p.paid, 0), z = varE > 0 ? edgeE / Math.sqrt(varE) : 0;
  const share = f => bets.filter(f).length / bets.length;
  const by = key => { const m = new Map(); for (const p of bets) m.set(key(p), (m.get(key(p)) || 0) + p.stake); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, share: +(v / staked).toFixed(2) })) };
  const avgPaid = bets.reduce((t, p) => t + p.paid * p.stake, 0) / staked;
  const lead = median(bets.map(p => p.lead)), sold = bets.reduce((t, p) => t + p.soldShare * p.stake, 0) / staked;
  const topics = by(p => p.m.topic).slice(0, 3), places = by(p => p.m.country).slice(0, 3);
  const style = avgPaid < 0.35 ? 'longshots' : avgPaid > 0.7 ? 'favourites' : 'balanced';
  const tags = [
    style === 'longshots' ? 'Longshot hunter' : style === 'favourites' ? 'Favourite grinder' : 'Mid-odds',
    topics[0] && topics[0].share >= 0.6 ? topics[0].k[0].toUpperCase() + topics[0].k.slice(1) + ' specialist' : null,
    places[0] && places[0].share >= 0.5 ? places[0].k + ' focus' : null,
    lead >= 30 ? 'Early (weeks ahead)' : lead <= 2 ? 'Late (last days)' : null,
    sold >= 0.4 ? 'Trades in and out' : sold <= 0.05 ? 'Holds to resolution' : null,
  ].filter(Boolean);
  return {
    wallet: w, short: short(w), name: ps[0].who || null,
    bets: bets.length, markets: new Set(bets.map(p => p.m.id)).size, staked: Math.round(staked), pnl: Math.round(pnl), roi: +(pnl / staked).toFixed(3),
    hit: +share(p => p.won).toFixed(3), avgPaid: +avgPaid.toFixed(3), edge: +(edge / bets.length).toFixed(3), z: +z.toFixed(2),
    events: evs.size, skill: z >= 2 && evs.size >= 8 && pnl > 0, // a likely real edge: beyond luck, over 8+ separate events, and it made money mm: marketsBoth.size / seenM.size >= 0.4,
    odds: { longshot: +share(p => p.paid < 0.3).toFixed(2), mid: +share(p => p.paid >= 0.3 && p.paid <= 0.7).toFixed(2), favourite: +share(p => p.paid > 0.7).toFixed(2) },
    leadDays: +lead.toFixed(1), soldEarly: +sold.toFixed(2), medianStake: Math.round(median(bets.map(p => p.stake))), maxStake: Math.round(Math.max(...bets.map(p => p.stake))),
    topics, places, tags,
    best: bets.filter(p => p.won).sort((a, b) => b.pnl - a.pnl).slice(0, 3).map(p => ({ q: p.m.q, outcome: p.m.outcomes[p.oi] || (p.oi ? 'No' : 'Yes'), paid: +p.paid.toFixed(2), pnl: Math.round(p.pnl), leadDays: Math.round(p.lead), url: p.m.url })),
  };
}

async function main() {
  console.log('resolved markets…');
  const markets = await resolvedMarkets();
  console.log(`${markets.length} markets, trades…`);
  const trades = await pool(markets, 4, tradesOf, 150);
  const pos = positions(markets, trades), byW = new Map();
  for (const p of pos) { const a = byW.get(p.w) || []; a.push(p); byW.set(p.w, a) }
  const all = [...byW.entries()].map(([w, ps]) => profile(w, ps)).filter(Boolean).filter(p => !p.mm);
  // ranked by evidence of skill, not by luck or size: z first, then profit; plus the 30 biggest winners
  const ranked = all.sort((a, b) => b.z - a.z || b.pnl - a.pnl);
  mkdirSync(dirname(OUT) || '.', { recursive: true });
  writeFileSync(OUT, JSON.stringify({ updated: new Date(NOW).toISOString(), markets: markets.length, trades: trades.reduce((t, x) => t + (x ? x.length : 0), 0), wallets: byW.size, profiled: all.length, skilled: all.filter(p => p.skill).length, profiles: [...new Map([...ranked.slice(0, 50), ...all.filter(p => p.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 30)].map(p => [p.wallet, p])).values()] }, null, 1));
  if (TEASER) {
    // samples: the strongest proven wallet and the biggest winner (marked "could be luck"), nothing else
    const sk = ranked.find(p => p.skill), win = all.filter(p => p.pnl > 0 && (!sk || p.wallet !== sk.wallet)).sort((a, b) => b.pnl - a.pnl)[0];
    const samples = [sk, win].filter(Boolean);
    mkdirSync(dirname(TEASER) || '.', { recursive: true });
    writeFileSync(TEASER, JSON.stringify({ updated: new Date(NOW).toISOString(), preview: true, markets: markets.length, trades: trades.reduce((t, x) => t + (x ? x.length : 0), 0), wallets: byW.size, profiled: all.length, skilled: all.filter(p => p.skill).length, locked: Math.max(0, Math.min(all.length, 80) - samples.length), profiles: samples }));
    console.log(`wrote teaser ${TEASER}: ${samples.length} samples`);
  }
  console.log(`wrote ${OUT}: ${byW.size} wallets, ${all.length} with ${MIN_BETS}+ bets, ${all.filter(p => p.skill).length} with a likely real edge`);
}
main().catch(e => { console.error(e); process.exit(1) });
