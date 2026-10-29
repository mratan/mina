// Identifier normalization, candidate records, and work-family clustering.
//
// A candidate is one record one channel returned at one rank. A *record* is one identifier-distinct version (a
// preprint version, a journal article). A *work family* groups the records that are the same research object:
// a preprint and its publication, arXiv v1/v2 and the proceedings paper. Families are formed by union-find over
// identifier keys, plus explicit cross-links (OpenAlex ids, Semantic Scholar externalIds, bioRxiv published DOI),
// plus an exact normalized-title key (titles of at least 30 characters). Every link remembers why it was made.
// Not merged with adapters/pi-research-search/src/normalize.js: that one shapes web search results (snippets, URL dedupe)
// and keeps DOIs verbatim; this one builds broker candidates and strips bioRxiv version suffixes to group versions.

export function normDoi(s) {
  if (!s) return null;
  let d = String(s).trim().replace(/^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)/i, '').toLowerCase();
  d = decodeURIComponent(d).replace(/[.,;)\]]+$/, '');
  if (!/^10\.\d{4,9}\/\S+$/.test(d)) return null;
  // bioRxiv/medRxiv URLs carry the version on the DOI suffix (…526521v2); the DOI itself has none.
  d = d.replace(/^(10\.(?:1101|64898)\/\d{4}\.\d{2}\.\d{2}\.\d{5,})v\d+$/, '$1');
  d = d.replace(/\.(full|abstract|full-text|pdf)$/, '');
  return d;
}
export function normArxiv(s) {
  if (!s) return null;
  const m = String(s).match(/(?:arxiv[:.]|abs\/|pdf\/|^)(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i);
  return m ? { id: m[1].toLowerCase(), version: m[2] ? Number(m[2].slice(1)) : null } : null;
}
export function normTitle(t) {
  return String(t ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Identifiers that can be read verbatim from a URL (resolver and repository URL shapes only; nothing guessed). */
export function idsFromUrl(url) {
  const u = String(url ?? '');
  const ids = {};
  let m;
  if ((m = u.match(/doi\.org\/(10\.\d{4,9}\/[^?#\s]+)/i))) ids.doi = normDoi(m[1]);
  if ((m = u.match(/(?:biorxiv|medrxiv)\.org\/content\/(?:biorxiv\/early\/[\d/]+\/)?(10\.\d{4,9}\/(?:\d{4}\.\d{2}\.\d{2}\.)?\d{5,})(v\d+)?(?:[./?#]|$)/i))) { ids.doi = normDoi(m[1]); if (m[2]) ids.preprint_version = Number(m[2].slice(1)); }
  if ((m = u.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i)) || (m = u.match(/ncbi\.nlm\.nih\.gov\/pubmed\/(\d+)/i)) || (m = u.match(/europepmc\.org\/(?:article|abstract)\/MED\/(\d+)/i))) ids.pmid = m[1];
  if ((m = u.match(/(PMC\d+)/i))) ids.pmcid = m[1].toUpperCase();
  if ((m = u.match(/arxiv\.org\/(?:abs|pdf|html)\/([^?#\s]+)/i))) { const a = normArxiv(m[1]); if (a) { ids.arxiv = a.id; if (a.version) ids.arxiv_version = a.version; } }
  if ((m = u.match(/openalex\.org\/(W\d+)/i))) ids.openalex = m[1].toUpperCase();
  if ((m = u.match(/semanticscholar\.org\/paper\/(?:[^/]+\/)?([0-9a-f]{40})/i))) ids.s2 = m[1].toLowerCase();
  if ((m = u.match(/europepmc\.org\/(?:article|abstract)\/PPR\/(PPR\d+)/i))) ids.epmc_ppr = m[1].toUpperCase();
  // Publisher article URLs that embed the DOI suffix verbatim.
  if (!ids.doi && (m = u.match(/nature\.com\/articles\/([a-z0-9.-]+)/i))) ids.doi = normDoi(`10.1038/${m[1]}`);
  if (!ids.doi && (m = u.match(/(?:onlinelibrary\.wiley\.com|journals\.plos\.org|academic\.oup\.com|science\.org|cell\.com|pnas\.org|tandfonline\.com|frontiersin\.org|mdpi\.com|biomedcentral\.com|springer\.com|sciencedirect\.com)\/.*?(10\.\d{4,9}\/[^?#\s&]+)/i))) ids.doi = normDoi(m[1]);
  if (ids.doi && /^10\.48550\/arxiv\./.test(ids.doi)) { const a = normArxiv(ids.doi.replace(/^10\.48550\/arxiv\./, '')); if (a) ids.arxiv = a.id; }
  return ids;
}

export const PREPRINT_DOI = /^10\.(1101|64898|21203|20944|2139|31219|31234|48550|36227|26434|22541|33774)\//;
export function isPreprint(c) {
  return Boolean(c.is_preprint || (c.doi && PREPRINT_DOI.test(c.doi)) || (c.arxiv && !c.doi) || /preprint|posted-content/i.test(c.type ?? ''));
}

/** Build a candidate record; drops empty fields; derives identifiers from the URL when the provider gave none. */
export function candidate(fields) {
  const fromUrl = idsFromUrl(fields.url);
  const c = { ...fromUrl, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== '')) };
  if (c.doi) c.doi = normDoi(c.doi);
  if (c.arxiv) { const a = normArxiv(c.arxiv); if (a) { c.arxiv = a.id; if (a.version && !c.arxiv_version) c.arxiv_version = a.version; } }
  if (c.doi && /^10\.48550\/arxiv\./.test(c.doi) && !c.arxiv) c.arxiv = normArxiv(c.doi.replace(/^10\.48550\/arxiv\./, ''))?.id;
  if (c.pmcid) c.pmcid = String(c.pmcid).toUpperCase();
  if (c.openalex) c.openalex = String(c.openalex).replace(/^.*\//, '').toUpperCase();
  if (c.year === undefined && c.date) c.year = Number(String(c.date).slice(0, 4)) || undefined;
  c.is_preprint = isPreprint(c);
  return c;
}

export function idKeys(c) {
  const k = [];
  if (c.doi) k.push(`doi:${c.doi}`);
  if (c.pmid) k.push(`pmid:${c.pmid}`);
  if (c.pmcid) k.push(`pmcid:${c.pmcid}`);
  if (c.arxiv) k.push(`arxiv:${c.arxiv}`);
  if (c.openalex) k.push(`oa:${c.openalex}`);
  if (c.s2) k.push(`s2:${c.s2}`);
  if (c.epmc_ppr) k.push(`ppr:${c.epmc_ppr}`);
  return k;
}

/** Union-find over keys with a reason per edge. */
export class Families {
  constructor() { this.parent = new Map(); this.edges = []; }
  find(x) { if (!this.parent.has(x)) this.parent.set(x, x); let r = x; while (this.parent.get(r) !== r) r = this.parent.get(r); let y = x; while (this.parent.get(y) !== r) { const n = this.parent.get(y); this.parent.set(y, r); y = n; } return r; }
  union(a, b, reason) { if (!a || !b) return; const ra = this.find(a), rb = this.find(b); this.edges.push({ a, b, reason }); if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); }
  // Records: the identifiers on one record denote the same version, so they are linked as "same-record".
  addRecord(c, reason = 'same-record') {
    const ks = idKeys(c);
    const t = normTitle(c.title);
    if (t.length >= 30) ks.push(`title:${t}`);
    if (!ks.length) return null;
    ks.forEach((k) => this.find(k));
    for (let i = 1; i < ks.length; i++) this.union(ks[0], ks[i], ks[i].startsWith('title:') ? 'exact-title' : reason);
    return this.find(ks[0]);
  }
  link(keyA, keyB, reason) { this.union(keyA, keyB, reason); }
  familyOf(c) { const ks = idKeys(c); const t = normTitle(c.title); if (t.length >= 30) ks.push(`title:${t}`); return ks.length ? this.find(ks[0]) : null; }
}
