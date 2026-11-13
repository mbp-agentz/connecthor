// /api/* for ConnecTHOR on Cloudflare Pages: an allow-listed, edge-cached proxy.
// Browsers can't read Kalshi, PredictIt, adsb.lol or the news RSS feeds directly (no CORS
// headers, bot challenges), and caching here keeps a traffic spike from hitting the APIs'
// rate limits (GDELT allows one request per 5 s). Only GET, only the hosts below.

import PIZZA from '../../pizza-venues.json';

const UA = 'ConnecTHOR/1.0 (+https://github.com/mbp-agentz/connecthor)';

// route -> upstream base(s) and edge cache seconds. Several bases = try in order.
const ROUTES = {
  gamma: { up: ['https://gamma-api.polymarket.com'], ttl: 60 },
  data: { up: ['https://data-api.polymarket.com'], ttl: 10 },
  clob: { up: ['https://clob.polymarket.com'], ttl: 300 },
  // series lists are big (~0.5 MB) and change slowly; candles are hourly; trades are near-live
  kalshi: { up: ['https://api.elections.kalshi.com/trade-api/v2'], ttl: p => /candlesticks/.test(p) ? 600 : /^\/series/.test(p) ? 3600 : /^\/markets\/trades/.test(p) ? 30 : 120 },
  manifold: { up: ['https://api.manifold.markets/v0'], ttl: 120 },
  predictit: { up: ['https://www.predictit.org/api/marketdata'], ttl: 120 },
  // adsb.fi serves the same readsb format, so it stands in when adsb.lol is down
  adsb: { up: ['https://api.adsb.lol/v2', 'https://opendata.adsb.fi/api/v2'], ttl: 30 },
  gdelt: { up: ['https://api.gdeltproject.org/api/v2/doc/doc'], ttl: 900 },
};

const FEEDS = [
  ['BBC', 'https://feeds.bbci.co.uk/news/world/rss.xml'],
  ['NYT', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml'],
  ['Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml'],
  ['NPR', 'https://feeds.npr.org/1001/rss.xml'],
  ['Guardian', 'https://www.theguardian.com/world/rss'],
];

const json = (body, status = 200, ttl = 0) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': ttl ? `public, max-age=${ttl}` : 'no-store' },
});

export async function onRequest(ctx) {
  const { request } = ctx;
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET' } });
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);

  const url = new URL(request.url);
  const [route, ...rest] = url.pathname.replace(/^\/api\/?/, '').split('/');
  if (route === 'news') return cached(ctx, 300, news);
  if (route === 'faa') return cached(ctx, 180, faa, url.origin + '/api/faa');
  // Every uncached call spends one BestTime credit per venue, so the cache key ignores the query
  // string (no ?x=1 cache-busting) and lives an hour: BestTime refreshes live data hourly anyway.
  if (route === 'pizza') return cached(ctx, 3600, () => pizza(ctx.env), url.origin + '/api/pizza');
  const r = ROUTES[route];
  if (!r) return json({ error: 'unknown route' }, 404);
  // pathname is already percent-encoded; the upstream host is fixed, so the path can't escape it
  const path = rest.length ? '/' + rest.join('/') : '';
  return cached(ctx, typeof r.ttl === 'function' ? r.ttl(path) : r.ttl, () => forward(r.up, path + url.search));
}

// Serve from the edge cache, or build the response and store it for ttl seconds.
// (The Cache API only persists on a custom domain; on *.pages.dev it is a no-op.)
async function cached(ctx, ttl, build, keyUrl) {
  const cache = caches.default;
  const key = new Request(keyUrl || new URL(ctx.request.url).toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await build();
  if (res.status === 200) {
    const out = new Response(res.body, res);
    out.headers.set('cache-control', `public, max-age=${ttl}`);
    out.headers.set('access-control-allow-origin', '*');
    ctx.waitUntil(cache.put(key, out.clone()));
    return out;
  }
  return res;
}

async function forward(bases, tail) {
  let last = 'no upstream', status = 502;
  for (const base of bases) {
    try {
      // 10 s per upstream: shorter than the page's own timeouts, so the page gets a clean 502
      // and can fall back to a direct request instead of aborting while we still wait
      const res = await fetch(base + tail, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      const type = res.headers.get('content-type') || '';
      // Buffer the whole body: streaming it would let a timeout cut it off mid-way after the
      // 200 was sent, and the truncated JSON would then sit in the cache
      if (res.ok && /json/.test(type)) return new Response(await res.text(), { headers: { 'content-type': type } });
      last = `${new URL(base).hostname} HTTP ${res.status}${res.ok ? ' (not JSON)' : ''}`;
      if (res.status === 429) status = 429; // let the page (and logs) see rate limiting as such
    } catch (e) {
      last = `${new URL(base).hostname} ${e.name}`;
    }
  }
  return json({ error: 'upstream failed: ' + last }, status);
}

// ---- FAA: US airport status (official, no key, but no CORS), as compact JSON ----
// Ground stops show up as delay entries whose reason says STOP ("TM INITIATIVES:STOP:NAS GS" = a stop
// ordered for the whole National Airspace System), equipment outages as "EQ:…". Several of either at once
// is the signal (the 2023 and 2026 nationwide stops looked like that); weather and volume delays aren't.
async function faa() {
  const res = await fetch('https://nasstatus.faa.gov/api/airport-status-information', { headers: { 'user-agent': UA, accept: 'application/xml' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return json({ error: 'FAA HTTP ' + res.status }, 502);
  const xml = await res.text(), items = [];
  for (const [, block] of xml.matchAll(/<Delay_type>([\s\S]*?)<\/Delay_type>/g)) {
    const type = tag(block, 'Name');
    if (/closure/i.test(type)) continue; // planned closures (NOTAMs for airshows, GA rules) are routine
    for (const [, a, why] of block.matchAll(/<ARPT>([A-Z0-9]+)<\/ARPT>[\s\S]*?<Reason>([\s\S]*?)<\/Reason>/g)) items.push({ arpt: a, why: decode(why), type });
  }
  const stops = items.filter(x => /stop/i.test(x.why) || /ground stop/i.test(x.type)), equip = items.filter(x => /\bEQ\b/i.test(x.why) && !stops.includes(x));
  const nas = stops.filter(x => /\bNAS\b/i.test(x.why)).length;
  return json({ updated: tag(xml, 'Update_Time'), stops: stops.map(x => x.arpt + ' · ' + x.why), equip: equip.map(x => x.arpt), delays: items.length, national: nas >= 2 || stops.length + equip.length >= 6 });
}

// ---- news: fetch the RSS feeds and merge them into one list ----
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m)
  .replace(/\s+/g, ' ')
  .trim();
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
};

async function feed([source, url]) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${source} HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].slice(0, 8).map(([item]) => {
    const t = Date.parse(tag(item, 'pubDate') || tag(item, 'dc:date'));
    return { title: tag(item, 'title'), url: tag(item, 'link'), guid: tag(item, 'guid'), source, time: isFinite(t) ? new Date(t).toISOString() : null };
  }).filter(n => n.title && n.url);
}

async function news() {
  const res = await Promise.allSettled(FEEDS.map(feed));
  const items = res.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  const failed = res.map((r, i) => r.status === 'rejected' ? FEEDS[i][0] : null).filter(Boolean);
  if (!items.length) return json({ error: 'all feeds failed', failed }, 502);
  items.sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0));
  return json({ source: 'rss', failed, items: items.slice(0, 40) });
}

// ---- pizza: live foot traffic for the pizza places near the Pentagon (BestTime.app) ----
// pizza-venues.json (written by tools/pizza-setup.mjs) holds the venues and their typical week in US
// Eastern clock hours; only the live value is fetched here, with the BESTTIME_PRIVATE_KEY secret.
const ET_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
const DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

async function besttimeLive(key, venueId) {
  // the docs show both spellings of the live path; try the plural first
  for (const path of ['forecasts/live', 'forecast/live']) {
    const res = await fetch(`https://besttime.app/api/v1/${path}?api_key_private=${encodeURIComponent(key)}&venue_id=${encodeURIComponent(venueId)}`,
      { method: 'POST', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
    if (res.status === 404) continue;
    const d = await res.json();
    if (d.status !== 'OK') throw new Error(d.message || `BestTime HTTP ${res.status}`);
    return d.analysis || {};
  }
  throw new Error('BestTime live endpoint not found');
}

async function pizza(env) {
  const key = env && env.BESTTIME_PRIVATE_KEY, venues = (PIZZA && PIZZA.venues) || [];
  if (!key || !venues.length) return json({ error: 'pizza feed not configured' }, 503);
  const day = DOW[ET_DAY.format(new Date())];
  const res = await Promise.allSettled(venues.map(v => besttimeLive(key, v.venue_id)));
  const shops = venues.map((v, i) => {
    const a = res[i].status === 'fulfilled' ? res[i].value : null;
    return {
      id: v.venue_id, name: v.name, area: v.area, dist: v.dist, lat: v.lat, lng: v.lng,
      typical: (v.week && v.week[day]) || null,
      live: a && a.venue_live_busyness_available ? a.venue_live_busyness : null,
      forecast: a && a.venue_forecast_busyness_available ? a.venue_forecasted_busyness : null,
    };
  });
  if (!shops.some(s => s.live != null || s.forecast != null)) {
    const why = res.find(r => r.status === 'rejected');
    return json({ error: 'no BestTime data' + (why ? ': ' + why.reason.message : '') }, 502);
  }
  return json({ source: 'besttime', updated: new Date().toISOString(), forecast_updated: PIZZA.updated, shops });
}
