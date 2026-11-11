// Loki: early bets and suspicious volume on geopolitical Polymarket markets.
// Runs hourly in GitHub Actions (.github/workflows/loki.yml) and writes loki.json to the
// loki-data branch. The page reads it as a static file from raw.githubusercontent.com, so
// visitors never trigger a Pages Function for it (free plan: 100k calls a day).
// Usage: node tools/loki.mjs [out.json]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.argv[2] || 'loki.json', PREV = process.argv[3] || OUT; // previous file keeps the GDELT curve when GDELT refuses
const UA = 'ConnecTHOR-Loki/1.0 (+https://github.com/mbp-agentz/connecthor)';
const GAMMA = 'https://gamma-api.polymarket.com', DATA = 'https://data-api.polymarket.com';
const H = 3600e3, WINDOW = 24 * H;
const BIG = 5000;          // a trade this size (USD) is worth checking against the news
const MAX_PAID = 0.9, MIN_GAIN = 0.03; // a 97¢ "sure thing" isn't a tip-off; the market must have moved their way
const LEAD_MAX = 12 * H;   // headline at most this long after the trade
const LEAD_MIN = 5 * 60e3; // and at least 5 min after it (same-minute = reacting, not leading)
const QUIET = 6 * H;       // no matching headline in the 6 h before the trade

// One source for places: the page's own LOCS table and conflict regex
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const LOCS = Function('return ' + html.match(/const LOCS=(\{[^\n]*?\});/)[1])();
const CONFLICT_RE = Function('return ' + html.match(/const CONFLICT_RE=(\/.*?\/i);/)[1])();
const SKIP_KEYS = new Set(['bitcoin', 'fed', 'trump']); // not places in a headline sense
const STOP = new Set('will would could should before after between which there their about other these those being under again until least more than with from into over what when where while have been does this that they them then also most such only very much many some your year years month day days week weeks time first last next market markets price above below reach announce announced officially happen january february march april may june july august september october november december 2026 2027 2028'.split(' '));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (r.status === 429 && i < tries - 1) { await sleep(/gdelt/.test(url) ? 6000 : 2000 * (i + 1)); continue; } // GDELT: one call per 5 s
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return await r.json();
    } catch (e) { if (i >= tries - 1) throw e; await sleep(1500 * (i + 1)); }
  }
}
const num = v => { const n = +v; return isFinite(n) ? n : 0 };
const parseArr = v => { try { return Array.isArray(v) ? v : JSON.parse(v || '[]') } catch { return [] } };
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]) } catch (e) { console.warn(e.message); out[k] = null } } }));
  return out;
}

// ---- places in a text ----
function locsIn(text) {
  const l = ' ' + text.toLowerCase() + ' ', hits = [];
  for (const [k, v] of Object.entries(LOCS)) { const i = l.indexOf(k); if (i >= 0) hits.push({ i, k, c: v.c }) }
  return hits.sort((a, b) => a.i - b.i);
}
const words = t => (t.toLowerCase().match(/[a-z][a-z'-]+/g) || []);
// What a headline must mention to count as "news about this market": the market's country and
// one more word from its question (another place, or a topic word like "ceasefire" or "strike")
function matcher(q) {
  const ls = locsIn(q).filter(h => !SKIP_KEYS.has(h.k));
  if (!ls.length) return null;
  const country = ls[0].c;
  const cKeys = Object.entries(LOCS).filter(([k, v]) => v.c === country && !SKIP_KEYS.has(k)).map(([k]) => k);
  const cWords = new Set(cKeys.flatMap(words));
  const own = w => cKeys.some(k => w.startsWith(k.trim())); // "iranian" is the country again, not a topic
  const topic = new Set([...words(q).filter(w => w.length >= 5 && !STOP.has(w) && !STOP.has(w.replace(/e?s$/, '')) && !cWords.has(w) && !own(w)), ...ls.filter(h => h.c !== country).map(h => h.k.trim())]);
  if (!topic.size) return null;
  const has = (l, k) => new RegExp(`(^|[^a-z])${k.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(l);
  return { country, test: title => { const l = ' ' + title.toLowerCase() + ' '; return cKeys.some(k => has(l, k)) && [...topic].some(k => has(l, k)) } };
}

// ---- news: the page's five RSS feeds (all items) + GDELT's last 24 h ----
const FEEDS = [
  ['BBC', 'https://feeds.bbci.co.uk/news/world/rss.xml'],
  ['NYT', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml'],
  ['Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml'],
  ['NPR', 'https://feeds.npr.org/1001/rss.xml'],
  ['Guardian', 'https://www.theguardian.com/world/rss'],
];
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m)
  .replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1]) : '' };
async function rss([source, url]) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${source} HTTP ${r.status}`);
  const xml = await r.text();
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map(([it]) => ({ title: tag(it, 'title'), url: tag(it, 'link'), source, t: Date.parse(tag(it, 'pubDate') || tag(it, 'dc:date')) })).filter(n => n.title && isFinite(n.t));
}
async function gdelt() {
  const q = '(military OR missile OR airstrike OR troops OR ceasefire OR sanctions OR nuclear OR invasion OR drone OR election OR strike) sourcelang:english';
  const d = await getJSON(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=250&sort=datedesc&timespan=24h&format=json`, 2);
  return (d.articles || []).map(a => { const m = String(a.seendate).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/); return { title: a.title || '', url: a.url, source: (a.domain || 'News').replace(/^www\./, ''), t: m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN } }).filter(n => n.title && isFinite(n.t));
}

// The page's "war coverage" curve (share of world news about military conflict, 7 days). Fetched
// here once an hour because GDELT allows one request per 5 s per IP and often takes 10-20 s:
// from visitors' browsers or Cloudflare's shared IPs it mostly fails
const COV_Q = '(airstrike OR missile OR "military strike" OR invasion OR "armed conflict" OR shelling)'; // = GDELT_Q in index.html
async function coverage() {
  const d = await getJSON(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(COV_Q)}&mode=timelinevol&timespan=7d&timelinesmooth=3&format=json`, 2);
  const pts = (d.timeline?.[0]?.data || []).map(x => { const m = String(x.date).match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?/); return m ? { t: Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)), v: num(x.value) } : null }).filter(Boolean);
  if (pts.length < 3) throw new Error('empty timeline');
  return { updated: new Date().toISOString(), pts };
}
// GDELT twice in a row would trip its 5 s limit: articles first, then the curve after a pause
async function gdeltAll() {
  const arts = await gdelt().catch(e => (console.warn('GDELT articles', e.message), []));
  await sleep(6000);
  const cov = await coverage().catch(e => (console.warn('GDELT coverage', e.message), null));
  return [arts, cov];
}
async function loadPrev() {
  try {
    if (/^https?:/.test(PREV)) { const r = await fetch(PREV, { headers: { 'user-agent': UA } }); return r.ok ? await r.json() : null }
    return existsSync(PREV) ? JSON.parse(readFileSync(PREV, 'utf8')) : null;
  } catch { return null }
}

// ---- markets: open geopolitical Polymarket markets with a place, busiest first ----
async function markets() {
  const now = Date.now(), seen = new Map();
  for (const t of ['geopolitics', 'world', 'middle-east']) {
    const evs = await getJSON(`${GAMMA}/events?closed=false&active=true&limit=100&order=volume24hr&ascending=false&tag_slug=${t}`);
    for (const e of evs) for (const m of e.markets || []) {
      if (m.closed || m.active === false || !m.conditionId || seen.has(m.conditionId)) continue;
      const prices = parseArr(m.outcomePrices).map(num);
      if (!prices.length || prices[0] >= 0.99 || prices[0] <= 0.01) continue; // decided
      if (Date.parse(m.endDate || '') < now) continue;
      const mt = matcher(m.question || ''); if (!mt) continue;
      seen.set(m.conditionId, { id: m.conditionId, question: m.question, url: `https://polymarket.com/event/${e.slug}`, country: mt.country, war: CONFLICT_RE.test(m.question), vol24: num(m.volume24hr), outcomes: parseArr(m.outcomes), prices, mt });
    }
  }
  return [...seen.values()].sort((a, b) => b.vol24 - a.vol24).slice(0, 40);
}

async function trades(m) {
  const d = await getJSON(`${DATA}/v2/trades?condition_id=${m.id}&limit=500&filter_type=CASH&filter_amount=100`);
  const since = Date.now() - WINDOW;
  return (d.data || []).map(t => ({ wallet: t.proxy_wallet, name: t.pseudonym || t.name || '', side: t.side, oi: num(t.outcome_index), outcome: t.outcome || '', size: num(t.size), price: num(t.price), usd: num(t.size) * num(t.price), t: num(t.timestamp) * 1000 })).filter(t => t.t >= since && t.wallet);
}

// Volume that looks staged: the same wallet buying and selling the same outcome inside the
// window (round trips), and how much of the volume a handful of wallets make up
function fakeVolume(ts) {
  const total = ts.reduce((a, t) => a + t.usd, 0); if (!total || ts.length < 40) return null; // a few trades always look concentrated
  const by = new Map();
  for (const t of ts) { const k = t.wallet + ':' + t.oi, x = by.get(k) || { buy: 0, sell: 0 }; x[t.side === 'SELL' ? 'sell' : 'buy'] += t.usd; by.set(k, x) }
  const rt = [...by.values()].reduce((a, x) => a + 2 * Math.min(x.buy, x.sell), 0) / total;
  const per = new Map(); for (const t of ts) per.set(t.wallet, (per.get(t.wallet) || 0) + t.usd);
  const top3 = [...per.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0) / total;
  // round trips weigh most: a few big wallets alone can be honest whales
  const score = Math.min(100, Math.round(140 * rt + 50 * Math.max(0, top3 - 0.5)));
  return { score, roundTrip: +rt.toFixed(3), top3: +top3.toFixed(3), trades: ts.length, wallets: per.size, usd: Math.round(total) };
}

async function walletInfo(w) {
  const d = await getJSON(`${DATA}/v2/activity?user=${w}&limit=500`);
  const rows = d.data || [], more = !!d.pagination?.has_more;
  const first = rows.length ? num(rows[rows.length - 1].timestamp) * 1000 : Date.now();
  const ageDays = Math.floor((Date.now() - first) / 864e5);
  return { acts: rows.length, more, ageDays: more ? null : ageDays, isNew: !more && (ageDays < 7 || rows.length <= 5) };
}

const short = w => w.slice(0, 6) + '…' + w.slice(-4);
async function main() {
  const [prev, ms, [arts, cov], ...news] = await Promise.all([loadPrev(), markets(), gdeltAll(), ...FEEDS.map(f => rss(f).catch(e => (console.warn(e.message), [])))]);
  news.push(arts);
  const heads = news.flat().sort((a, b) => a.t - b.t);
  console.log(`${ms.length} markets, ${heads.length} headlines`);
  const all = await pool(ms, 4, trades);
  // a failed GDELT call keeps the last good curve for up to a day
  const coverageOut = cov || (prev?.coverage && Date.now() - Date.parse(prev.coverage.updated) < 864e5 ? prev.coverage : null);
  console.log(`GDELT coverage: ${cov ? 'fresh' : coverageOut ? 'kept from last run' : 'none'}`);
  const out = { updated: new Date().toISOString(), windowHours: 24, checked: ms.length, headlines: heads.length, coverage: coverageOut, flags: [], volume: [] };
  ms.forEach((m, i) => {
    const ts = all[i]; if (!ts) return;
    const fv = fakeVolume(ts);
    if (fv) out.volume.push({ id: m.id, question: m.question, url: m.url, country: m.country, ...fv });
    const mine = heads.filter(h => m.mt.test(h.title));
    for (const t of ts) {
      if (t.usd < BIG) continue;
      const hit = mine.find(h => h.t >= t.t + LEAD_MIN && h.t <= t.t + LEAD_MAX);
      if (!hit || mine.some(h => h.t < t.t && h.t > t.t - QUIET)) continue; // news was already out
      const now = m.prices[t.oi] ?? null, gain = now == null ? null : t.side === 'SELL' ? t.price - now : now - t.price;
      const paid = t.side === 'SELL' ? 1 - t.price : t.price;
      if (gain == null || gain < MIN_GAIN || paid > MAX_PAID) continue;
      out.flags.push({ id: m.id, question: m.question, url: m.url, country: m.country, wallet: t.wallet, who: t.name || short(t.wallet), side: t.side, outcome: t.outcome, usd: Math.round(t.usd), price: +t.price.toFixed(3), now: +now.toFixed(3), time: new Date(t.t).toISOString(), leadMin: Math.round((hit.t - t.t) / 60e3), headline: { title: hit.title, source: hit.source, url: hit.url, time: new Date(hit.t).toISOString() } });
    }
  });
  // one flag per wallet and market (the biggest), then look the wallets up
  const best = new Map(); for (const f of out.flags) { const k = f.wallet + f.id; if (!best.has(k) || best.get(k).usd < f.usd) best.set(k, f) }
  out.flags = [...best.values()].sort((a, b) => b.usd - a.usd).slice(0, 20);
  const info = await pool([...new Set(out.flags.map(f => f.wallet))], 3, async w => [w, await walletInfo(w)]);
  const byW = new Map(info.filter(Boolean));
  for (const f of out.flags) f.walletInfo = byW.get(f.wallet) || null;
  out.flags.sort((a, b) => b.usd * (b.walletInfo?.isNew ? 2 : 1) - a.usd * (a.walletInfo?.isNew ? 2 : 1));
  out.volume = out.volume.sort((a, b) => b.score - a.score).slice(0, 15);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`${out.flags.length} early bets, top volume score ${out.volume[0]?.score ?? '-'} → ${OUT}`);
}
main().catch(e => { console.error(e); process.exit(1) });
