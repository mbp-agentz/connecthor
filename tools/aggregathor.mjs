// aggregaTHOR (sister site, aggregathor.com) stories for the page's ⚡ aggregaTHOR tab.
// Its archive (data/articles.json) holds every story with full text, ~4 MB: too much for each
// visitor. This keeps the 10 newest open written stories and bet items with what the tab shows (no pictures, no body).
// Runs hourly in GitHub Actions (.github/workflows/aggregathor.yml), started by the ticker Worker,
// and writes aggregathor.json to the orphan branch aggregathor-data.
// Usage: node tools/aggregathor.mjs [out.json]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.argv[2] || 'aggregathor.json', BASE = 'https://aggregathor.com', KEEP = 10;
// aggregaTHOR's own story URL (public/seo.js: newsUrl), so links land on the canonical page
const slugify = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const newsUrl = a => `${BASE}/news/${slugify(a.article.headline).split('-').slice(0, 10).join('-')}-${slugify(a.id)}`;
const publishedOf = a => a.article?.researchedAt || a.publishedAt;

const r = await fetch(`${BASE}/data/articles.json`, { headers: { 'user-agent': 'ConnecTHOR/1.0 (+https://github.com/mbp-agentz/connecthor)' }, signal: AbortSignal.timeout(60000) });
if (!r.ok) throw new Error('aggregaTHOR HTTP ' + r.status);
const d = await r.json();
// Most of the archive is bet items written from a template (no AI, "Data Desk"); written stories are
// rarer and often days old. Keep the 10 newest of each, so the tab's Stories chip is never empty.
const open = (d.articles || []).filter(a => a.article && a.article.headline && !a.closed)
  .sort((a, b) => Date.parse(publishedOf(b)) - Date.parse(publishedOf(a)));
const isBet = a => a.article.writer === 'template';
const stories = [...open.filter(a => !isBet(a)).slice(0, KEEP), ...open.filter(isBet).slice(0, KEEP)]
  .sort((a, b) => Date.parse(publishedOf(b)) - Date.parse(publishedOf(a)))
  .map(a => {
    const m = a.market || {};
    return {
      id: a.id, url: newsUrl(a), headline: a.article.headline, teaser: a.article.teaser || '', time: publishedOf(a),
      place: a.article.region || (m.places || [])[0] || null, impact: a.article.impact ?? null,
      kind: isBet(a) ? 'bet' : 'story',
      market: m.question ? { question: m.question, source: m.source, p: m.probability ?? null, change24: m.change24 ?? null, url: m.url || null } : null,
    };
  });
if (!stories.length) throw new Error('no open aggregaTHOR stories');
mkdirSync(dirname(OUT) || '.', { recursive: true });
writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), source: d.updatedAt || null, stories }));
console.log(`wrote ${OUT}: ${stories.length} stories (archive ${d.articles.length}, updated ${d.updatedAt})`);
for (const s of stories) console.log(' ', s.time.slice(0, 16), s.kind.padEnd(5), s.place || '-', '·', s.headline.slice(0, 70));
