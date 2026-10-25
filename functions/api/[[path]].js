// /api/* for ConnecTHOR on Cloudflare Pages: an allow-listed, edge-cached proxy.
// Browsers can't read Kalshi, PredictIt, adsb.lol or the news RSS feeds directly (no CORS
// headers, bot challenges), and caching here keeps a traffic spike from hitting the APIs'
// rate limits (GDELT allows one request per 5 s). Only GET, only the hosts below.

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
  const r = ROUTES[route];
  if (!r) return json({ error: 'unknown route' }, 404);
  // pathname is already percent-encoded; the upstream host is fixed, so the path can't escape it
  const path = rest.length ? '/' + rest.join('/') : '';
  return cached(ctx, typeof r.ttl === 'function' ? r.ttl(path) : r.ttl, () => forward(r.up, path + url.search));
}

// Serve from the edge cache, or build the response and store it for ttl seconds.
// (The Cache API only persists on a custom domain; on *.pages.dev it is a no-op.)
async function cached(ctx, ttl, build) {
  const cache = caches.default;
  const key = new Request(new URL(ctx.request.url).toString(), { method: 'GET' });
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
