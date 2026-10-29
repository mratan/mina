// Identifier parsing and authority routing.
//
// parseRef() turns whatever a caller passes (DOI in any form, PMID, PMCID, arXiv id with or without version, bioRxiv/medRxiv
// DOI with or without version, OpenAlex W-id, Semantic Scholar id, a URL, or a title) into one typed reference. authorityFor()
// names the source that is authoritative for that kind. Both are pure.
import { normDoi, normArxiv, idsFromUrl } from '../lib/normalize.mjs';

export const PREPRINT_SERVER_DOI = /^10\.(1101|64898)\//; // bioRxiv and medRxiv (10.64898 since 2025)

/**
 * parseRef(ref) → { kind, value, version?, raw, ids }
 *   kind ∈ doi | biorxiv | pmid | pmcid | arxiv | openalex | s2 | url | title
 * `ids` holds every identifier the reference itself carries (a URL can carry a DOI and a version).
 */
export function parseRef(ref) {
  if (ref && typeof ref === 'object') {
    // A WorkRef object from an earlier broker result: take its strongest identifier.
    for (const k of ['arxiv', 'pmcid', 'pmid', 'doi', 'biorxiv', 'openalex', 's2']) {
      if (ref[k]) return parseRef(k === 'pmid' ? `pmid:${ref[k]}` : k === 's2' ? `s2:${ref[k]}` : k === 'arxiv' ? `arxiv:${ref[k]}${ref.arxiv_version ? `v${ref.arxiv_version}` : ''}` : ref[k]);
    }
    if (ref.title) return parseRef(`title:${ref.title}`);
    throw new Error('INVALID_REF: an object reference needs an identifier or a title');
  }
  const raw = String(ref ?? '').trim();
  if (!raw) throw new Error('INVALID_REF: empty reference');
  let m;
  if ((m = raw.match(/^title:\s*(.+)$/is))) return { kind: 'title', value: m[1].trim(), raw, ids: {} };
  if ((m = raw.match(/^(?:pmid:\s*|PMID\s*)(\d{1,9})$/i))) return { kind: 'pmid', value: m[1], raw, ids: { pmid: m[1] } };
  if ((m = raw.match(/^(?:pmcid:\s*)?(PMC\d{4,9})$/i))) return { kind: 'pmcid', value: m[1].toUpperCase(), raw, ids: { pmcid: m[1].toUpperCase() } };
  if ((m = raw.match(/^(?:https?:\/\/openalex\.org\/|openalex:)?(W\d{4,})$/i))) return { kind: 'openalex', value: m[1].toUpperCase(), raw, ids: { openalex: m[1].toUpperCase() } };
  if ((m = raw.match(/^(?:s2:|corpusid:)\s*(\S+)$/i)) || (m = raw.match(/^([0-9a-f]{40})$/i))) {
    const v = /^corpusid:/i.test(raw) ? `CorpusId:${m[1]}` : m[1].toLowerCase();
    return { kind: 's2', value: v, raw, ids: { s2: v } };
  }
  if ((m = raw.match(/^arxiv:\s*(.+)$/i)) || /^\d{4}\.\d{4,5}(v\d+)?$/.test(raw) || /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/.test(raw)) {
    const a = normArxiv(m ? m[1] : raw);
    if (!a) throw new Error(`INVALID_REF: ${raw.slice(0, 80)} is not an arXiv id`);
    return { kind: 'arxiv', value: a.id, version: a.version ?? null, raw, ids: { arxiv: a.id, ...(a.version ? { arxiv_version: a.version } : {}) } };
  }
  if (/^https?:\/\//i.test(raw)) {
    const ids = idsFromUrl(raw);
    if (ids.arxiv) return { kind: 'arxiv', value: ids.arxiv, version: ids.arxiv_version ?? null, raw, ids };
    if (ids.doi && PREPRINT_SERVER_DOI.test(ids.doi)) return { kind: 'biorxiv', value: ids.doi, version: ids.preprint_version ?? null, raw, ids };
    if (ids.pmcid) return { kind: 'pmcid', value: ids.pmcid, raw, ids };
    if (ids.pmid) return { kind: 'pmid', value: ids.pmid, raw, ids };
    if (ids.doi) return { kind: 'doi', value: ids.doi, raw, ids };
    if (ids.openalex) return { kind: 'openalex', value: ids.openalex, raw, ids };
    if (ids.s2) return { kind: 's2', value: ids.s2, raw, ids };
    return { kind: 'url', value: raw, raw, ids };
  }
  // A bare DOI or doi:… form; a bioRxiv/medRxiv DOI may carry a version suffix (…526521v2).
  const vm = raw.match(/^(?:doi:\s*)?(10\.(?:1101|64898)\/[\d.]+?)v(\d+)$/i);
  const doi = normDoi(raw);
  if (doi) {
    if (doi.startsWith('10.48550/arxiv.')) return parseRef(`arxiv:${doi.slice('10.48550/arxiv.'.length)}`);
    if (PREPRINT_SERVER_DOI.test(doi)) return { kind: 'biorxiv', value: doi, version: vm ? Number(vm[2]) : null, raw, ids: { doi, ...(vm ? { preprint_version: Number(vm[2]) } : {}) } };
    return { kind: 'doi', value: doi, raw, ids: { doi } };
  }
  if (/^\d{6,9}$/.test(raw)) return { kind: 'pmid', value: raw, raw, ids: { pmid: raw } };
  // Anything else of reasonable length is a title.
  if (raw.length >= 8) return { kind: 'title', value: raw, raw, ids: {} };
  throw new Error(`INVALID_REF: cannot interpret ${raw.slice(0, 80)}`);
}

/**
 * The authority for each identifier kind: arXiv ids → arXiv (OpenAlex arXiv
 * records were wrong or missing for 11/37 ids), PMID/PMCID → NCBI, bioRxiv/medRxiv DOI → the bioRxiv API, OpenAlex id →
 * OpenAlex, DOI → DOI metadata (OpenAlex record, then doi.org content negotiation), S2 → Semantic Scholar.
 * `enrich` lists the sources consulted after the authoritative object is resolved.
 */
export const AUTHORITY = {
  arxiv: { authority: 'arxiv', enrich: ['openalex_by_doi'] },
  pmid: { authority: 'pubmed', enrich: ['openalex_by_doi'] },
  pmcid: { authority: 'pubmed', enrich: ['openalex_by_doi'] },
  biorxiv: { authority: 'biorxiv', enrich: ['openalex_by_doi', 'published_version'] },
  doi: { authority: 'openalex', fallback: 'doi_org', enrich: ['pubmed_by_doi'] },
  openalex: { authority: 'openalex', enrich: ['pubmed_by_doi'] },
  s2: { authority: 'semantic_scholar', enrich: ['openalex_by_doi'] },
  url: { authority: 'url_meta', enrich: [] },
  title: { authority: 'title_search', enrich: [] },
};
export function authorityFor(kind) {
  const a = AUTHORITY[kind];
  if (!a) throw new Error(`no authority for identifier kind ${kind}`);
  return a;
}

/** Stable key strings for one record's identifiers (for caches and family union-find). */
export function refKeys(ids) {
  const k = [];
  if (ids.doi) k.push(`doi:${ids.doi}`);
  if (ids.pmid) k.push(`pmid:${ids.pmid}`);
  if (ids.pmcid) k.push(`pmcid:${ids.pmcid}`);
  if (ids.arxiv) k.push(`arxiv:${ids.arxiv}`);
  if (ids.openalex) k.push(`oa:${ids.openalex}`);
  if (ids.s2) k.push(`s2:${ids.s2}`);
  return k;
}
