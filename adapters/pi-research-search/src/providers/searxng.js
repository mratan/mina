// SearXNG JSON API, used for scholarly literature. Base from @bytetrue/pi-web-search 0.5.1 src/providers/searxng.ts (MIT);
// adds explicit engine selection, paper metadata, per-engine failure reporting and engine-priority interleaving.
import { createOriginPolicy } from '../net-guard.js';
import { makeResult } from '../normalize.js';

/** Engines queried for literature, by SearXNG engine name (shortcut in comment). */
export const LITERATURE_ENGINES = ['pubmed', 'europepmc', 'openalex', 'semantic scholar', 'arxiv', 'crossref', 'google scholar'];
// !pub !epmc !oa !se !arx !cr !gos

export const FIELD_PRIORITY = {
  biomedical: ['pubmed', 'europepmc', 'semantic scholar', 'openalex', 'crossref', 'arxiv', 'google scholar'],
  computational: ['openalex', 'semantic scholar', 'arxiv', 'europepmc', 'crossref', 'pubmed', 'google scholar'],
  general: ['openalex', 'europepmc', 'semantic scholar', 'pubmed', 'arxiv', 'crossref', 'google scholar'],
};

export function buildSearxngUrl(baseUrl, { query, engines = LITERATURE_ENGINES, pageno = 1 }) {
  const url = new URL('search', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('engines', engines.join(','));
  url.searchParams.set('pageno', String(pageno));
  return url.toString();
}

function citationCount(comments) {
  const m = String(comments ?? '').match(/^(\d+) citations\b/);
  return m ? Number(m[1]) : undefined;
}

export function mapSearxngResults(raw, query) {
  return (raw.results ?? []).map((r) => makeResult({
    title: r.title,
    url: r.url,
    snippet: r.content,
    backend: 'searxng',
    query,
    published_date: r.publishedDate && r.publishedDate !== 'None' ? String(r.publishedDate).slice(0, 10) : undefined,
    authors: Array.isArray(r.authors) ? r.authors.filter(Boolean) : undefined,
    venue: r.journal && r.journal !== 'None' ? r.journal : undefined,
    publisher: r.publisher || undefined,
    doi: r.doi || undefined,
    type: r.type || undefined,
    pdf_url: r.pdf_url || undefined,
    source_engines: Array.isArray(r.engines) ? r.engines : r.engine ? [r.engine] : undefined,
    citation_count: citationCount(r.comments),
    score: Number.isFinite(r.score) ? Math.round(r.score * 1000) / 1000 : undefined,
  }));
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'into', 'using', 'use', 'based',
  'recent', 'new', 'methods', 'method', 'approach', 'approaches', 'study', 'studies', 'via', 'how', 'what', 'which', 'its', 'their']);

function terms(text) {
  return [...new Set(String(text).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t)).map((t) => t.replace(/(ies|es|s)$/, '')))];
}

/** Fraction of query terms found in title (weight 2) and snippet (weight 1), in [0, 1]. Transparent and deterministic. */
export function lexicalOverlap(query, r) {
  const q = terms(query);
  if (!q.length) return 0;
  const title = new Set(terms(r.title));
  const body = new Set(terms(r.snippet ?? ''));
  let s = 0;
  for (const t of q) s += title.has(t) ? 2 : body.has(t) ? 1 : 0;
  return Math.round((s / (2 * q.length)) * 1000) / 1000;
}

/**
 * Round-robin across engines in priority order so no single engine dominates and the preferred engines lead.
 * A result found by several engines belongs to its highest-priority engine. Within an engine bucket, results found by
 * more engines come first, then higher lexical overlap with the query, then the engine's own order. (PubMed's
 * E-utilities search, as SearXNG calls it, returns recent-first rather than best-match order, so its raw order is not
 * a relevance signal.)
 *
 * With a query, results are first split into two tiers by lexical overlap (ON_TOPIC_OVERLAP): the on-topic tier is
 * interleaved and listed first, the rest after it. Without the tiers, round-robin gives every engine a top-10 slot even
 * when its results are off topic (arXiv and Crossref noise for biomedical queries). On captured SearXNG responses for
 * four test queries, keyword-relevant results in the top 10 went from 5 to 9, 2 to 7 and 2 to 4, with one unchanged.
 */
export const ON_TOPIC_OVERLAP = 0.5;

export function interleaveByEngine(results, priority, query = '', minOverlap = ON_TOPIC_OVERLAP) {
  if (query && minOverlap > 0) {
    const scored = results.map((r) => ({ ...r, lexical_overlap: lexicalOverlap(query, r) }));
    const on = scored.filter((r) => r.lexical_overlap >= minOverlap);
    const off = scored.filter((r) => r.lexical_overlap < minOverlap);
    if (on.length && off.length) {
      return [...interleaveByEngine(on, priority, query, 0), ...interleaveByEngine(off, priority, query, 0)].map((r, i) => ({ ...r, rank: i + 1 }));
    }
  }
  const rank = (e) => { const i = priority.indexOf(e); return i < 0 ? priority.length : i; };
  const buckets = new Map();
  results.forEach((r, i) => {
    const engines = r.source_engines ?? ['unknown'];
    const primary = [...engines].sort((a, b) => rank(a) - rank(b))[0];
    if (!buckets.has(primary)) buckets.set(primary, []);
    buckets.get(primary).push({ r: { ...r, lexical_overlap: query ? lexicalOverlap(query, r) : undefined }, i });
  });
  for (const list of buckets.values()) {
    list.sort((a, b) => (b.r.source_engines?.length ?? 1) - (a.r.source_engines?.length ?? 1)
      || (b.r.lexical_overlap ?? 0) - (a.r.lexical_overlap ?? 0) || a.i - b.i);
  }
  const order = [...buckets.keys()].sort((a, b) => rank(a) - rank(b));
  const out = [];
  for (let i = 0; out.length < results.length; i++) {
    for (const e of order) { const x = buckets.get(e)[i]; if (x) out.push(x.r); }
  }
  return out.map((r, i) => ({ ...r, rank: i + 1 }));
}

export async function searxngSearch({ http, baseUrl, query, engines = LITERATURE_ENGINES, field = 'general', signal, timeoutMs }) {
  const url = buildSearxngUrl(baseUrl, { query, engines });
  const res = await http.request({ method: 'GET', url, policy: createOriginPolicy([baseUrl]), signal, timeoutMs,
    maxBytes: 4 * 1024 * 1024, overflow: 'error', headers: { accept: 'application/json' } });
  if (res.status === 403) throw new Error('SearXNG HTTP 403: is "json" listed in search.formats of settings.yml?');
  if (res.status !== 200) throw new Error(`SearXNG HTTP ${res.status}`);
  const raw = JSON.parse(res.body.toString('utf8'));
  const results = interleaveByEngine(mapSearxngResults(raw, query), FIELD_PRIORITY[field] ?? FIELD_PRIORITY.general, query);
  const perEngine = {};
  for (const e of engines) perEngine[e] = 0;
  for (const r of results) for (const e of r.source_engines ?? []) perEngine[e] = (perEngine[e] ?? 0) + 1;
  const unresponsive = (raw.unresponsive_engines ?? []).map(([name, reason]) => ({ engine: name, reason: String(reason) }));
  return { results, meta: { via: 'searxng', engines_queried: engines, results_per_engine: perEngine, unresponsive_engines: unresponsive } };
}
