// Result normalization, identifiers, and cross-backend dedupe. Fields are copied only when a backend supplies them;
// nothing is inferred or fabricated except identifiers parsed verbatim out of a URL (DOI, PMID, arXiv id).
// Not merged with literature/lib/normalize.mjs (broker candidates and work families, version-stripped DOIs): the adapter
// keeps src/ free of imports from the rest of the repository, and the two disagree on DOI versions by design.
import { stripTags } from './html.js';

export const SNIPPET_MAX_CHARS = 700;

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;

export function normalizeDoi(value) {
  if (!value) return undefined;
  const m = String(value).trim().match(DOI_RE);
  if (!m) return undefined;
  return decodeURIComponentSafe(m[1]).replace(/[.,;)\]]+$/, '').toLowerCase();
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** DOI carried by a resolver or publisher URL (doi.org, oadoi.org, dx.doi.org, or a /doi/ path). */
export function doiFromUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return undefined; }
  const host = url.hostname.replace(/^www\./, '');
  if (['doi.org', 'dx.doi.org', 'oadoi.org'].includes(host)) return normalizeDoi(url.pathname.slice(1));
  const m = url.pathname.match(/\/doi\/(?:abs\/|full\/|pdf\/|epdf\/)?(10\.\d{4,9}\/.+)$/i);
  return m ? normalizeDoi(m[1]) : undefined;
}

export function pmidFromUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return undefined; }
  const host = url.hostname.replace(/^www\./, '');
  let m;
  if (host === 'ncbi.nlm.nih.gov' && (m = url.pathname.match(/^\/pubmed\/(\d+)/))) return m[1];
  if (host === 'pubmed.ncbi.nlm.nih.gov' && (m = url.pathname.match(/^\/(\d+)/))) return m[1];
  if (host === 'europepmc.org' && (m = url.pathname.match(/\/(?:article|abstract)\/MED\/(\d+)/i))) return m[1];
  return undefined;
}

/** arXiv id without version, plus the version when present. */
export function arxivFromUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return undefined; }
  if (!/(^|\.)arxiv\.org$/.test(url.hostname)) return undefined;
  const m = url.pathname.match(/\/(?:abs|pdf|html)\/([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/i);
  return m ? { id: m[1].toLowerCase(), version: m[2]?.toLowerCase() } : undefined;
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|spm)$/i;

/** Canonical form used only as a dedupe key: https, no www., no fragment, no tracking params, no trailing slash. */
export function canonicalUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return String(raw ?? '').trim().toLowerCase(); }
  url.hash = '';
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  if (url.port === '443' || url.port === '80') url.port = '';
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  const s = url.toString();
  return s.endsWith('/') && !url.search ? s.slice(0, -1) : s;
}

export function normalizeTitle(title) {
  return String(title ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+[|–—-]\s+[^|–—-]{2,60}$/, '') // trailing " | Site Name"
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const PREPRINT_HOSTS = /(^|\.)(arxiv\.org|biorxiv\.org|medrxiv\.org|chemrxiv\.org|preprints\.org|researchsquare\.com|ssrn\.com|osf\.io|zenodo\.org)$/;
const PREPRINT_DOI = /^10\.(1101|48550|21203|20944|2139|31219|26434)\//;

/** True when the record is (identifiably) a preprint rather than a version of record. */
export function isPreprint(r) {
  if (r.doi && PREPRINT_DOI.test(r.doi)) return true;
  if (/preprint|posted-content/i.test(r.type ?? '')) return true;
  if (/rxiv|preprint/i.test(r.venue ?? '')) return true;
  try { return PREPRINT_HOSTS.test(new URL(r.url).hostname.replace(/^www\./, '')); } catch { return false; }
}

export function cleanSnippet(text, max = SNIPPET_MAX_CHARS) {
  const s = stripTags(text);
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export function toIsoDate(value) {
  if (!value || value === 'None') return undefined;
  const s = String(value);
  const m = s.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m) return undefined;
  return [m[1], m[2], m[3]].filter(Boolean).join('-');
}

/** Build a normalized record. Unknown/empty fields are omitted. */
export function makeResult(fields) {
  const r = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    r[k] = v;
  }
  r.title = r.title ? stripTags(r.title) : '(untitled)';
  if (r.snippet) r.snippet = cleanSnippet(r.snippet);
  if (r.url) {
    r.doi = normalizeDoi(r.doi) ?? doiFromUrl(r.url) ?? r.doi;
    if (!r.doi) delete r.doi;
    r.pmid = r.pmid ?? pmidFromUrl(r.url);
    if (!r.pmid) delete r.pmid;
    const ax = arxivFromUrl(r.url);
    if (ax) { r.arxiv_id = ax.id; if (ax.version) r.arxiv_version = ax.version; }
  }
  return r;
}

function identityKeys(r) {
  const keys = [];
  if (r.doi) keys.push(`doi:${r.doi}`);
  if (r.pmid) keys.push(`pmid:${r.pmid}`);
  if (r.arxiv_id) keys.push(`arxiv:${r.arxiv_id}${r.arxiv_version ?? ''}`);
  if (r.url) keys.push(`url:${canonicalUrl(r.url)}`);
  return keys;
}

/** Title match is allowed only when it cannot hide a distinct version (preprint vs. publication, or two DOIs). */
function titleCompatible(a, b) {
  if (a.doi && b.doi && a.doi !== b.doi) return false;
  if (isPreprint(a) !== isPreprint(b)) return false;
  if (a.arxiv_id && b.arxiv_id && (a.arxiv_id !== b.arxiv_id || a.arxiv_version !== b.arxiv_version)) return false;
  return true;
}

function mergeInto(m, r) {
  const add = (field, value) => { if (value !== undefined && !m[field].includes(value)) m[field].push(value); };
  add('backends', r.backend);
  add('queries', r.query);
  for (const e of r.source_engines ?? []) add('source_engines', e);
  if (r.url && canonicalUrl(r.url) !== canonicalUrl(m.url)) add('alternate_urls', r.url);
  for (const u of r.alternate_urls ?? []) if (canonicalUrl(u) !== canonicalUrl(m.url)) add('alternate_urls', u);
  if (r.score !== undefined) m.scores[`${r.backend}${r.source_engines?.length ? `:${r.source_engines[0]}` : ''}`] ??= r.score;
  m.ranks[r.backend] ??= r.rank;
  for (const f of ['doi', 'pmid', 'arxiv_id', 'arxiv_version', 'published_date', 'venue', 'type', 'pdf_url', 'citation_count', 'publisher', 'site']) {
    if (m[f] === undefined && r[f] !== undefined) m[f] = r[f];
  }
  if ((!m.authors || m.authors.length === 0) && r.authors?.length) m.authors = r.authors;
  if (r.snippet && (!m.snippet || (m.snippet.length < 120 && r.snippet.length > m.snippet.length))) m.snippet = r.snippet;
}

/**
 * Merge results from one or more backends. Keys in order: DOI, PMID, arXiv id+version, canonical URL; then normalized
 * title when compatible (never merging a preprint with a version of record, or two different DOIs).
 * Input order is preserved: the first occurrence decides the position.
 */
export function dedupeResults(results) {
  const merged = [];
  const byKey = new Map();
  const byTitle = new Map();
  for (const r of results) {
    let target;
    for (const k of identityKeys(r)) if ((target = byKey.get(k))) break;
    const tkey = normalizeTitle(r.title);
    if (!target && tkey.length >= 12) target = (byTitle.get(tkey) ?? []).find((m) => titleCompatible(m, r));
    if (!target) {
      target = { ...r, backends: [], queries: [], source_engines: [], alternate_urls: [], scores: {}, ranks: {} };
      delete target.backend; delete target.query; delete target.score; delete target.rank;
      merged.push(target);
      if (tkey.length >= 12) byTitle.set(tkey, [...(byTitle.get(tkey) ?? []), target]);
    } else if (target.doi && r.doi && target.doi !== r.doi) {
      // Same URL but different DOIs: keep them apart.
      target = { ...r, backends: [], queries: [], source_engines: [], alternate_urls: [], scores: {}, ranks: {} };
      delete target.backend; delete target.query; delete target.score; delete target.rank;
      merged.push(target);
    }
    mergeInto(target, r);
    for (const k of [...identityKeys(target), ...identityKeys(r)]) if (!byKey.has(k)) byKey.set(k, target);
  }
  return merged.map((m) => {
    for (const f of ['alternate_urls', 'source_engines', 'queries']) if (m[f].length === 0) delete m[f];
    if (Object.keys(m.scores).length === 0) delete m.scores;
    return m;
  });
}
