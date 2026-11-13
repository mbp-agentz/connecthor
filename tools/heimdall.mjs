// Heimdall's slow channels: official travel warnings and Wikipedia attention, per LOCS country.
// Runs every 3 hours in GitHub Actions (.github/workflows/heimdall.yml) and writes heimdall.json to
// the heimdall-data branch; the page merges it with its own live channels (aircraft, news, odds).
// Sources (official, free, no key): US State Department advisories (RSS), German Foreign Office
// (open data JSON), UK FCDO (GOV.UK content API), Wikimedia pageviews (daily, per article).
// Usage: node tools/heimdall.mjs [out.json] [previous file or URL]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.argv[2] || 'heimdall.json', PREV = process.argv[3] || OUT;
const UA = 'ConnecTHOR-Heimdall/1.0 (+https://github.com/mbp-agentz/connecthor)';
const H = 3600e3, DAY = 24 * H;
const FRESH = 72 * H;   // an advisory change counts as a signal for three days
const WIKI_X = 2;       // yesterday's views at least twice the 4-week median…
const WIKI_MIN = 3000;  // …and enough views that it isn't a rounding blip

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const LOCS = Function('return ' + html.match(/const LOCS=(\{[^\n]*?\});/)[1])();
const COUNTRIES = [...new Set(Object.values(LOCS).map(v => v.c))].filter(c => c !== 'NATO' && c !== 'EU');

// Names per source. w = Wikipedia article, f = GOV.UK travel-advice slug (null: none), i = ISO3 (German
// Foreign Office), us = start of the State Department title. Defaults: the country name itself.
const ISO3 = { USA: 'USA', Ukraine: 'UKR', Russia: 'RUS', China: 'CHN', Taiwan: 'TWN', Iran: 'IRN', Israel: 'ISR', Gaza: 'PSE', Lebanon: 'LBN', Syria: 'SYR', Yemen: 'YEM', Venezuela: 'VEN', 'North Korea': 'PRK', 'South Korea': 'KOR', India: 'IND', Pakistan: 'PAK', Greenland: 'GRL', France: 'FRA', Germany: 'DEU', UK: 'GBR', Japan: 'JPN', Mexico: 'MEX', Canada: 'CAN', Romania: 'ROU', Falklands: 'FLK', 'Saudi Arabia': 'SAU', Qatar: 'QAT', Egypt: 'EGY', Turkey: 'TUR', Brazil: 'BRA', Argentina: 'ARG', Colombia: 'COL', Cuba: 'CUB', Panama: 'PAN', Poland: 'POL', Hungary: 'HUN', Serbia: 'SRB', Sudan: 'SDN', 'DR Congo': 'COD', Ethiopia: 'ETH', Somalia: 'SOM', Philippines: 'PHL', Vietnam: 'VNM', Australia: 'AUS', 'South Africa': 'ZAF', Nigeria: 'NGA' };
const NAMES = {
  USA: { w: 'United States', f: 'usa', us: null }, UK: { w: 'United Kingdom', f: null, us: 'United Kingdom' },
  Gaza: { w: 'Gaza Strip', f: 'the-occupied-palestinian-territories' }, 'DR Congo': { w: 'Democratic Republic of the Congo', f: 'democratic-republic-of-the-congo', us: 'Democratic Republic of the Congo' },
  Falklands: { w: 'Falkland Islands', f: 'falkland-islands', us: 'Falkland Islands' }, Greenland: { f: null },
};
const nameOf = c => ({ w: c, f: c.toLowerCase().replace(/ /g, '-'), us: c, ...(NAMES[c] || {}) });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, type = 'json', tries = 2) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return type === 'json' ? await r.json() : await r.text();
    } catch (e) { if (i >= tries - 1) throw e; await sleep(1500) }
  }
}
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]) } catch (e) { console.warn(e.message); out[k] = null } } }));
  return out;
}
const strip = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const DEPART_RE = /ordered departure|authorized departure|leave (the country |immediately|now)|evacuat/i;

// ---- US State Department: one RSS with every country's level ----
async function usAdvisories() {
  const xml = await get('https://travel.state.gov/_res/rss/TAsTWs.xml', 'text'), out = new Map();
  for (const it of xml.split('<item>').slice(1)) {
    const title = strip((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ''), m = title.match(/^(.*?) - Level (\d)/);
    if (!m) continue;
    const desc = strip((it.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '');
    out.set(m[1].trim(), { level: +m[2], title, date: Date.parse((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || ''), url: strip((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || ''), depart: DEPART_RE.test(desc) });
  }
  return out;
}
// ---- German Foreign Office: one JSON with warning flags per country ----
async function aaWarnings() {
  const d = await get('https://www.auswaertiges-amt.de/opendata/travelwarning'), out = new Map();
  for (const [id, x] of Object.entries(d.response || {})) {
    if (!x || !x.iso3CountryCode) continue;
    const level = x.warning ? 4 : x.partialWarning ? 3 : x.situationWarning || x.situationPartWarning ? 2 : 1;
    out.set(x.iso3CountryCode, { level, date: (x.lastModified || 0) * 1000, title: x.title, url: "https://www.auswaertiges-amt.de/de/ReiseUndSicherheit/reise-und-sicherheitshinweise", id });
  }
  return out;
}
// ---- UK FCDO: one call per country ----
async function fcdo(slug) {
  const d = await get(`https://www.gov.uk/api/content/foreign-travel-advice/${slug}`); if (!d) return null;
  const st = d.details.alert_status || [], ch = (d.details.change_history || [])[0] || {};
  const level = st.some(s => s === 'avoid_all_travel_to_whole_country') ? 4 : st.some(s => s.startsWith('avoid_all_travel')) ? 3 : st.length ? 2 : 1;
  return { level, date: Date.parse(ch.public_timestamp || d.public_updated_at || ''), note: (ch.note || '').trim(), url: `https://www.gov.uk/foreign-travel-advice/${slug}` };
}
// ---- Wikipedia: daily views of the country's article ----
const ymd = t => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
async function wiki(title, now) {
  const d = await get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(title.replace(/ /g, '_'))}/daily/${ymd(now - 35 * DAY)}/${ymd(now - DAY)}`);
  const v = ((d && d.items) || []).map(x => x.views); if (v.length < 10) return null;
  const last = v[v.length - 1], base = v.slice(-29, -1).sort((a, b) => a - b), med = base[base.length >> 1] || 1;
  return { title, v: last, med, ratio: +(last / med).toFixed(2), lit: last >= WIKI_MIN && last / med >= WIKI_X, spark: v.slice(-14) };
}

async function loadPrev() {
  try { return /^https?:/.test(PREV) ? await get(PREV) : existsSync(PREV) ? JSON.parse(readFileSync(PREV, 'utf8')) : null } catch { return null }
}

async function main() {
  const now = Date.now(), prev = await loadPrev(), prevBy = new Map(((prev && prev.countries) || []).map(c => [c.country, c]));
  const [us, aa] = await Promise.all([usAdvisories().catch(e => (console.warn(e.message), new Map())), aaWarnings().catch(e => (console.warn(e.message), new Map()))]);
  const uk = new Map((await pool(COUNTRIES, 4, async c => { const f = nameOf(c).f; return f ? [c, await fcdo(f)] : null })).filter(Boolean));
  const wk = new Map(await pool(COUNTRIES, 4, async c => [c, await wiki(nameOf(c).w, now)]));
  const out = [];
  for (const c of COUNTRIES) {
    const n = nameOf(c), p = prevBy.get(c), items = [];
    const usA = n.us ? [...us.entries()].find(([k]) => k === n.us || k.startsWith(n.us + ',')) : null;
    if (usA) items.push({ src: 'US', ...usA[1] });
    const aaA = aa.get(ISO3[c]); if (aaA) items.push({ src: 'DE', ...aaA });
    const ukA = uk.get(c); if (ukA) items.push({ src: 'UK', ...ukA });
    // A level raised since the last run is the strongest sign; keep that moment for three days
    for (const it of items) {
      const old = p && (p.official.items || []).find(x => x.src === it.src);
      it.raisedAt = old && it.level > old.level ? now : old && old.raisedAt && now - old.raisedAt < FRESH ? old.raisedAt : null;
      it.fresh = now - it.date < FRESH;
    }
    // counts: a raised level, a fresh departure call, or a fresh update while at level 3+ (FCDO: a security note)
    const hits = items.filter(it => it.raisedAt || (it.fresh && it.depart) || (it.fresh && it.level >= 3 && (it.src !== 'UK' || /strike|attack|conflict|military|security|tension|leave|evacuat|border|missile/i.test(it.note || ''))));
    const strong = items.some(it => it.raisedAt || (it.fresh && it.depart));
    out.push({ country: c, official: { lit: hits.length > 0, strong, why: hits.map(it => it.src + (it.raisedAt ? ' raised to level ' + it.level : it.depart ? ' departure call' : ' updated at level ' + it.level)), items: items.map(({ fresh, ...it }) => it) }, wiki: wk.get(c) || null });
  }
  mkdirSync(dirname(OUT) || '.', { recursive: true });
  writeFileSync(OUT, JSON.stringify({ updated: new Date(now).toISOString(), countries: out }));
  const lit = out.filter(x => x.official.lit || (x.wiki && x.wiki.lit));
  console.log(`wrote ${OUT}: ${out.length} countries · US ${us.size} · DE ${aa.size} · UK ${uk.size} · wiki ${[...wk.values()].filter(Boolean).length}`);
  for (const x of lit) console.log(' ', x.country.padEnd(13), x.official.lit ? '🏛️ ' + x.official.why.join(', ') : '', x.wiki && x.wiki.lit ? `📖 ${x.wiki.v} views (${x.wiki.ratio}× median)` : '');
}
main().catch(e => { console.error(e); process.exit(1) });
