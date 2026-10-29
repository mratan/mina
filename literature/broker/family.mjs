// Work families: the preprint versions, the version of record and their identifiers, grouped as one study.
//
// A *record* is one identifier-distinct manifestation (a preprint version, a journal article, a correction notice).
// A *family* groups the records that are the same research work. Families are built by union-find over identifier keys,
// with every merge recording why it happened and how much it is trusted:
//
//   same_record      identifiers on one record (a DOI and a PMID of the same article)        authoritative
//   preprint_of      bioRxiv API published DOI; arXiv journal DOI; PubMed UpdateOf link     authoritative / strong
//   preprint_of      exact title (≥ 30 chars), years within 2, one side a preprint server,
//                    the other a journal article, neither a dataset/software deposit         probable
//   same_title_unverified  exact title otherwise (two journal records, a Zenodo deposit…):
//                    NOT merged; the link is reported on both families                       same_title_unverified
//   corrected_by / retracted_by  PubMed ErratumIn / RetractionIn; OpenAlex is_retracted      authoritative
//
// Records without any persistent identifier (web results) join a family by exact title (probable): they carry no
// identity of their own to conflict with. A family is never counted as more than one study.
import { normTitle, isPreprint, PREPRINT_DOI } from '../lib/normalize.mjs';
import { refKeys } from './ids.mjs';

export const CONFIDENCE = ['authoritative', 'strong', 'probable', 'same_title_unverified'];
const NON_PAPER_DOI = /^10\.(5281|6084|17605|5061|25080|7910|24433)\//; // Zenodo, figshare, Mendeley Data, Dryad, Harvard Dataverse…
const NON_PAPER_TYPE = /dataset|software|component|peer-review|paratext|other|standard|grant/i;

const titleKey = (t) => { const n = normTitle(t); return n.length >= 30 ? `title:${n}` : null; };
const hasIds = (r) => refKeys(r).length > 0;
const isNonPaper = (r) => Boolean((r.doi && NON_PAPER_DOI.test(r.doi)) || (r.type && NON_PAPER_TYPE.test(r.type)));

export class FamilyBuilder {
  constructor() { this.parent = new Map(); this.records = []; this.links = []; this.titleIndex = new Map(); }
  find(x) { if (!this.parent.has(x)) this.parent.set(x, x); let r = x; while (this.parent.get(r) !== r) r = this.parent.get(r); let y = x; while (this.parent.get(y) !== r) { const n = this.parent.get(y); this.parent.set(y, r); y = n; } return r; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); }
  /** Add one record; returns its index. */
  add(rec) {
    const i = this.records.length;
    const keys = refKeys(rec);
    const node = `rec:${i}`;
    this.records.push({ ...rec, _node: node });
    this.find(node);
    for (const k of keys) { this.find(k); this.union(node, k); }
    if (keys.length > 1) this.links.push({ from: keys[0], to: keys.slice(1), relation: 'same_record', confidence: 'authoritative', evidence: rec._source ?? 'record identifiers' });
    const tk = titleKey(rec.title);
    if (tk) { if (!this.titleIndex.has(tk)) this.titleIndex.set(tk, []); this.titleIndex.get(tk).push(i); }
    return i;
  }
  /** An explicit lineage link between two identifier keys (e.g. bioRxiv published DOI). Merges unless unverified. */
  link(keyA, keyB, relation, confidence, evidence) {
    this.links.push({ from: keyA, to: [keyB], relation, confidence, evidence });
    if (confidence !== 'same_title_unverified') { this.find(keyA); this.find(keyB); this.union(keyA, keyB); }
  }
  /** Title pass: identifier-less records attach; preprint ↔ journal pairs merge as probable; anything else is reported only. */
  titlePass() {
    for (const [, idx] of this.titleIndex) {
      if (idx.length < 2) continue;
      const recs = idx.map((i) => this.records[i]);
      const anchor = recs.find(hasIds) ?? recs[0];
      for (const r of recs) {
        if (r === anchor || this.find(r._node) === this.find(anchor._node)) continue;
        const yearsOk = !r.year || !anchor.year || Math.abs(r.year - anchor.year) <= 2;
        if (!hasIds(r) || !hasIds(anchor)) {
          if (yearsOk) { this.union(r._node, anchor._node); this.links.push({ from: anchor._node, to: [r._node], relation: 'same_record', confidence: 'probable', evidence: 'exact title; one record has no persistent identifier' }); }
          continue;
        }
        const pair = [r, anchor];
        const pre = pair.filter((x) => isPreprint(x)); const pub = pair.filter((x) => !isPreprint(x));
        if (yearsOk && pre.length === 1 && pub.length === 1 && !pair.some(isNonPaper)) {
          this.union(r._node, anchor._node);
          this.links.push({ from: refKeys(pre[0])[0], to: [refKeys(pub[0])[0]], relation: 'preprint_of', confidence: 'probable', evidence: 'exact title, years within 2, preprint server ↔ journal (not verified by a lineage source)' });
        } else {
          this.links.push({ from: refKeys(r)[0], to: [refKeys(anchor)[0]], relation: 'same_title_unverified', confidence: 'same_title_unverified',
            evidence: pair.some(isNonPaper) ? 'exact title; one record is a dataset/software deposit' : 'exact title only' });
        }
      }
    }
  }
  /** Families: { family_id, canonical, members, links }. Canonical = version of record if any, else the latest preprint version. */
  build() {
    this.titlePass();
    const groups = new Map();
    this.records.forEach((r, i) => { const root = this.find(r._node); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(i); });
    const families = [];
    for (const [, idx] of groups) {
      const members = idx.map((i) => this.records[i]);
      const merged = mergeMembers(members);
      const keys = new Set(merged.flatMap((m) => refKeys(m)));
      const nodes = new Set(members.map((m) => m._node));
      const links = this.links.filter((l) => keys.has(l.from) || nodes.has(l.from) || l.to.some((t) => keys.has(t) || nodes.has(t)));
      const canonical = pickCanonical(merged);
      families.push({ family_id: familyId(canonical, merged), canonical, members: merged, links, member_index: idx });
    }
    return families;
  }
}

/** Records with the same identifiers (the same article seen by several backends) merge into one member record. */
export function mergeMembers(records) {
  const out = [];
  for (const r of records) {
    const ks = new Set(refKeys(r));
    const m = ks.size ? out.find((o) => refKeys(o).some((k) => ks.has(k) && !k.startsWith('oa:'))) ?? out.find((o) => refKeys(o).some((k) => ks.has(k))) : null;
    if (m) {
      for (const [k, v] of Object.entries(r)) if (m[k] === undefined || m[k] === null || m[k] === '') m[k] = v;
      m._sources = [...new Set([...(m._sources ?? [m._source]), r._source].filter(Boolean))];
    } else out.push({ ...r, _sources: [r._source].filter(Boolean) });
  }
  return out;
}

export function pickCanonical(members) {
  const vor = members.filter((m) => !isPreprint(m) && !isNonPaper(m) && (m.doi || m.pmid));
  if (vor.length) return vor.sort((a, b) => (b.cited_by ?? 0) - (a.cited_by ?? 0) || refKeys(b).length - refKeys(a).length)[0];
  const pre = members.filter((m) => m.doi || m.arxiv);
  if (pre.length) return pre.sort((a, b) => (b.preprint_version ?? b.arxiv_version ?? 0) - (a.preprint_version ?? a.arxiv_version ?? 0) || (b.year ?? 0) - (a.year ?? 0))[0];
  return members[0];
}

/** Stable, readable family id from the canonical record: the version of record's DOI, else arXiv, PMID, OpenAlex, S2, title. */
export function familyId(canonical, members = [canonical]) {
  const c = canonical;
  if (c.doi && !(PREPRINT_DOI.test(c.doi) && c.arxiv)) return `doi:${c.doi}`;
  if (c.arxiv) return `arxiv:${c.arxiv}`;
  if (c.pmid) return `pmid:${c.pmid}`;
  if (c.openalex) return `openalex:${c.openalex}`;
  if (c.s2) return `s2:${c.s2}`;
  const any = members.find((m) => m.doi || m.arxiv || m.pmid);
  if (any) return familyId(any);
  return `title:${normTitle(c.title).slice(0, 80)}`;
}

/** Retraction / correction flags of a family, from its members (PubMed and OpenAlex signals). */
export function familyStatus(members) {
  const retracted = members.some((m) => m.is_retracted || /^retracted(:| article)/i.test(m.title ?? ''));
  const corrections = [...new Set(members.flatMap((m) => m.corrections ?? []))];
  const retractionNotices = [...new Set(members.flatMap((m) => m.retraction_notices ?? []))];
  return { retracted, corrections, retraction_notices: retractionNotices };
}

/** Versions summary for output: one line per member, preprints first by version, the version of record last. */
export function versionsOf(members, canonical) {
  return members.map((m) => ({
    kind: isNonPaper(m) ? 'deposit' : isPreprint(m) ? 'preprint' : m.type === 'erratum' ? 'correction' : 'version_of_record',
    ids: Object.fromEntries(['doi', 'pmid', 'pmcid', 'arxiv', 'openalex', 's2'].filter((k) => m[k]).map((k) => [k, m[k]])),
    version: m.preprint_version ?? m.arxiv_version ?? null, year: m.year ?? null, venue: m.venue ?? null, canonical: m === canonical,
  })).sort((a, b) => (a.kind === 'version_of_record') - (b.kind === 'version_of_record') || (a.version ?? 0) - (b.version ?? 0));
}
