// aggregaTHOR (sister site, aggregathor.com) stories for the page's ⚡ aggregaTHOR tab.
// Its archive (data/articles.json) holds every story with full text, ~4 MB: too much for each
// visitor. This keeps the newest 4 top stories, 3 trending bets and 3 signals with what the tab shows
// (no pictures, no body).
// Runs hourly in GitHub Actions (.github/workflows/aggregathor.yml), started by the ticker Worker,
// and writes aggregathor.json to the orphan branch aggregathor-data.
// Usage: node tools/aggregathor.mjs [out.json]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.argv[2] || 'aggregathor.json', BASE = 'https://aggregathor.com';
// aggregaTHOR's own story URL (public/seo.js: newsUrl), so links land on the canonical page
const slugify = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const newsUrl = a => `${BASE}/news/${slugify(a.article.headline).split('-').slice(0, 10).join('-')}-${slugify(a.id)}`;
const publishedOf = a => a.article?.researchedAt || a.publishedAt;

const get = async path => {
  const r = await fetch(BASE + path, { headers: { 'user-agent': 'ConnecTHOR/1.0 (+https://github.com/mbp-agentz/connecthor)' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`aggregaTHOR ${path} HTTP ${r.status}`);
  return r.json();
};
const [d, sg] = await Promise.all([get('/data/articles.json'), get('/data/signals.json').catch(() => ({ signals: [] }))]);
const newest = (a, b) => Date.parse(publishedOf(b)) - Date.parse(publishedOf(a));
// The overview's sections, as aggregaTHOR's public/hub.js defines them, each cut to its newest items:
// Top stories = researched stories (after review); Trending = the 12 bets with the most money staked
// in 24 h; Signals = live findings from ConnecTHOR's tools
const open = (d.articles || []).filter(a => a.article && a.article.headline && !a.closed);
const published = a => a.article.researched && !a.article.reviewPending;
const top = open.filter(published).sort(newest).slice(0, 4);
const trending = open.filter(a => !published(a) && a.market?.vol24 > 0).sort((a, b) => b.market.vol24 - a.market.vol24).slice(0, 12).sort(newest).slice(0, 3);
const signals = (sg.signals || []).filter(a => a.article && a.article.headline && !a.closed)
  .sort((a, b) => Date.parse(b.updatedAt || b.publishedAt) - Date.parse(a.updatedAt || a.publishedAt)).slice(0, 3);
const pick = (a, kind) => {
  const m = a.market || {};
  return {
    id: a.id, kind, url: newsUrl(a), headline: a.article.headline, teaser: a.article.teaser || '', time: kind === 'signal' ? a.updatedAt || a.publishedAt : publishedOf(a),
    place: a.article.region || (m.places || [])[0] || null, impact: a.article.impact ?? null,
    market: m.question ? { question: m.question, source: m.source, p: m.probability ?? null, change24: m.change24 ?? null } : null,
  };
};
const stories = [...top.map(a => pick(a, 'top')), ...trending.map(a => pick(a, 'trending')), ...signals.map(a => pick(a, 'signal'))];
if (!stories.length) throw new Error('no open aggregaTHOR stories');
mkdirSync(dirname(OUT) || '.', { recursive: true });
writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), source: d.updatedAt || null, stories }));
console.log(`wrote ${OUT}: ${top.length} top · ${trending.length} trending · ${signals.length} signals (archive ${d.articles.length}, updated ${d.updatedAt})`);
for (const s of stories) console.log(' ', s.time.slice(0, 16), s.kind.padEnd(8), s.place || '-', '·', s.headline.slice(0, 70));
