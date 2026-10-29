// Rank fusion, role labels and coverage-aware selection.
//
// Fusion is reciprocal-rank fusion over *families*, one vote per backend (a family's best rank in each backend across
// all formulations), so the same article seen by three databases is one family with three votes, not three results.
// Expansion lists (references, citing) are not relevance rankings; they vote at half weight.
//
// Roles are labels with the evidence that produced them (role_signals), not a hidden score:
//   review / benchmark     publication type and title wording
//   seminal (foundational) referenced by ≥ 2 anchor papers of the result neighborhood (reviews, benchmarks, central
//                          methods) and highly cited within the candidate set, or referenced by ≥ 3 anchors; never from
//                          age alone, never from citation count alone
//   current_method         introduces a named method/tool ("Name: …" titles, "we present/introduce/propose …")
//   recent_development     published in the last two years
//   application            applies a method to a problem rather than introducing one
// Selection for landscape/comprehensive modes reserves capacity per role group so that twenty recent papers cannot
// crowd out the foundational methods (agents were seen to drop them when results were ranked by recency alone).

const RRF_K = 60;
export const REVIEW_RE = /\b(review|survey|overview|perspective|primer|tutorial|state of the art|landscape|roadmap)\b/i;
export const BENCHMARK_RE = /\b(benchmark\w*|comparison|comparative|evaluation of|evaluating|assessment of|critical assessment|systematic evaluation|head-to-head|performance of)\b/i;
const INTRO_TITLE = /^\s*([A-Z][A-Za-z0-9+._-]{1,30}(?:[- ][A-Z0-9][A-Za-z0-9+._-]{0,15})?)\s*:\s+\S/;
const INTRO_ABS = /\b(?:here,?\s+)?we\s+(?:present|introduce|propose|develop(?:ed)?|describe|report)\b/i;
const APPLY_RE = /\b(we appl(y|ied)|applied to|application of|case study|in a cohort|clinical application)\b/i;

const SHORT_STOP = new Set('the and for are was were but not all any can had has her his its may new now old one our out own see two use way who why how via per its yet off'.split(' '));
const stem = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
export function topicalTerms(text) {
  // three-letter terms count (RNA, ANI, LLM); common short function words do not
  return new Set(String(text ?? '').toLowerCase().split(/[^a-z0-9-]+/).flatMap((w) => w.split('-')).filter((w) => w.length >= 3 && !SHORT_STOP.has(w)).map(stem));
}
/** Content-term overlap between a family and the topic terms (query keywords plus field feedback terms). */
export function topicalOverlap(fam, topic) {
  const t = topicalTerms(`${fam.title ?? ''} ${(fam.abstract ?? '').slice(0, 600)}`);
  let n = 0; for (const w of topic) if (t.has(w)) n++;
  return n;
}

/** Fused score of each family. `hits` maps family_id → [{ backend, rank, channel }]. */
export function fuse(hits, { weights = {} } = {}) {
  const out = new Map();
  for (const [fid, hs] of hits) {
    const best = new Map();
    for (const h of hs) { const ch = h.channel ?? h.backend; if (!best.has(ch) || h.rank < best.get(ch).rank) best.set(ch, h); }
    let s = 0; const parts = [];
    for (const [ch, h] of best) { const w = weights[ch] ?? (ch.startsWith('expansion') ? 0.5 : 1); const v = w / (RRF_K + h.rank); s += v; parts.push({ channel: ch, rank: h.rank, contribution: +v.toFixed(5) }); }
    out.set(fid, { score: s, channels: best.size, parts: parts.sort((a, b) => b.contribution - a.contribution) });
  }
  return out;
}

export function introducesMethod(fam) {
  const m = String(fam.title ?? '').match(INTRO_TITLE);
  if (m && !REVIEW_RE.test(fam.title) && !/^(review|correction|erratum|retraction|editorial|comment)/i.test(m[1])) return { by: 'title', name: m[1] };
  if (INTRO_ABS.test(String(fam.abstract ?? '').slice(0, 800)) && !REVIEW_RE.test(fam.title ?? '')) return { by: 'abstract', name: null };
  return null;
}

/**
 * assignRoles(fams, { nowYear, anchorRefs, topic }) mutates each family with roles[] and role_signals{}.
 * anchorRefs: Map family_id → number of anchor papers whose reference lists include the family.
 */
/** Title-only overlap with the query's own terms (not field feedback terms): the topicality test for foundational papers. */
export function titleOverlap(fam, queryTopic) {
  const t = topicalTerms(fam.title ?? '');
  let n = 0; for (const w of queryTopic) if (t.has(w)) n++;
  return n;
}
/**
 * Seminality score (inspectable, used to order the foundational group): co-reference by anchors, title overlap with the
 * question, method introduction, and log citations. Raw citation count alone never decides it: generic infrastructure
 * (aligners, file-format tools) is co-cited by every anchor in a field but shares no words with the question.
 */
export function seminality(sig) {
  // co-references on a log scale (generic infrastructure is co-cited everywhere), scaled by how specifically the title
  // matches the question (rarity-weighted, 0–1), plus small terms for method introduction and citations
  const ref = Math.log2(1 + (sig.anchor_refs ?? 0));
  const rel = sig.title_relevance ?? Math.min(1, (sig.title_overlap ?? 0) / 3);
  return +(ref * (0.3 + 0.7 * rel) + (sig.introduces_method ? 0.3 : 0) + 0.1 * Math.log10((sig.cited_by ?? 0) + 1)).toFixed(3);
}
/** Rarity-weighted title relevance: each question term in the title counts by its inverse frequency among the candidate
 *  titles, so the discriminating constraint of a question ("long reads" among strain papers) outweighs its common term. */
export function titleRelevance(fams, queryTopic, feedbackTopic = new Set()) {
  const N = fams.length || 1; const df = new Map();
  const weight = (w) => (queryTopic.has(w) ? 1 : feedbackTopic.has(w) ? 0.6 : 0); // the field's own words count, less
  for (const f of fams) for (const w of topicalTerms(f.title ?? '')) if (weight(w)) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w) => Math.log(1 + N / (1 + (df.get(w) ?? 0)));
  const raw = fams.map((f) => { let s = 0; for (const w of topicalTerms(f.title ?? '')) if (weight(w)) s += weight(w) * idf(w); return s; });
  const max = Math.max(1e-9, ...raw);
  return new Map(fams.map((f, i) => [f.family_id, +(raw[i] / max).toFixed(3)]));
}

export function assignRoles(fams, { nowYear = new Date().getUTCFullYear(), anchorRefs = new Map(), topic = new Set(), queryTopic = topic, feedbackTopic = new Set() } = {}) {
  const cites = fams.map((f) => f.cited_by ?? 0).sort((a, b) => a - b);
  const pct = (v) => { if (!cites.length) return 0; let i = 0; while (i < cites.length && cites[i] <= v) i++; return i / cites.length; };
  const p75 = cites[Math.floor(cites.length * 0.75)] ?? 0;
  const rel = queryTopic.size ? titleRelevance(fams, queryTopic, feedbackTopic) : new Map();
  for (const f of fams) {
    const roles = new Set();
    const refs = anchorRefs.get(f.family_id) ?? 0;
    const intro = introducesMethod(f);
    const overlap = topic.size ? topicalOverlap(f, topic) : null;
    const isReview = f.type === 'review' || REVIEW_RE.test(f.title ?? '');
    const isBench = BENCHMARK_RE.test(f.title ?? '');
    if (isReview) roles.add('review');
    if (isBench) roles.add('benchmark');
    const citedHigh = (f.cited_by ?? 0) >= Math.max(50, p75);
    const tOverlap = queryTopic.size ? titleOverlap(f, new Set([...queryTopic, ...feedbackTopic])) : null;
    // on topic for a foundational role: two of the question's terms in the title, or one and a named method
    const onTopic = tOverlap === null || tOverlap >= 2 || (tOverlap >= 1 && Boolean(intro));
    // seminal: co-referenced by the anchors (≥ 3, or ≥ 2 and highly cited), or an established on-topic paper an anchor
    // cites (two question terms in the title, highly cited, at least two years old) — never age or citations alone
    const established = refs >= 1 && (tOverlap ?? 0) >= 2 && (f.cited_by ?? 0) >= Math.max(100, p75) && f.year && f.year <= nowYear - 2;
    if (onTopic && !isReview && ((refs >= 2 && citedHigh) || refs >= 3 || established)) { roles.add('seminal'); roles.add('foundational'); }
    if (intro && !isReview && !isBench) roles.add('current_method');
    if (f.year && f.year >= nowYear - 1 && !isReview) roles.add('recent_development');
    if (!intro && !isReview && !isBench && APPLY_RE.test(`${f.title ?? ''} ${(f.abstract ?? '').slice(0, 500)}`)) roles.add('application');
    f.roles = [...roles];
    f.role_signals = { anchor_refs: refs, cited_by: f.cited_by ?? null, cited_by_percentile: +pct(f.cited_by ?? 0).toFixed(2), introduces_method: intro, topical_overlap: overlap, title_overlap: tOverlap, title_relevance: rel.get(f.family_id) ?? null, year: f.year ?? null };
    f.role_signals.seminality = seminality(f.role_signals);
  }
  return fams;
}

export const GROUPS = [
  { id: 'foundational', label: 'Foundational / seminal', roles: ['seminal'], share: 0.35 },
  { id: 'benchmarks_reviews', label: 'Benchmarks and reviews', roles: ['benchmark', 'review'], share: 0.2 },
  { id: 'current_methods', label: 'Leading / current methods', roles: ['current_method'], share: 0.25 },
  { id: 'recent', label: 'Recent developments', roles: ['recent_development'], share: 0.2 },
];

/**
 * Coverage-aware selection. Each family goes to its first matching group (order above); each group gets a reserved share
 * of `max`; leftover capacity is filled by fused score. Within a group: seminal by seminality (anchor refs, then citations),
 * others by fused score. Returns { groups: [{id,label,families}], selected: [...], overflow: [...] }.
 */
export function selectWithRoles(fams, { max = 20, grouped = true } = {}) {
  const byScore = [...fams].sort((a, b) => b.fused - a.fused);
  if (!grouped) return { groups: null, selected: byScore.slice(0, max), overflow: byScore.slice(max) };
  const assigned = new Map(GROUPS.map((g) => [g.id, []]));
  const other = [];
  for (const f of byScore) { const g = GROUPS.find((x) => x.roles.some((r) => f.roles?.includes(r))); (g ? assigned.get(g.id) : other).push(f); }
  assigned.get('foundational').sort((a, b) => (b.role_signals.seminality - a.role_signals.seminality) || ((b.cited_by ?? 0) - (a.cited_by ?? 0)));
  const quota = new Map(GROUPS.map((g) => [g.id, Math.max(2, Math.round(g.share * max))]));
  const chosen = new Map(GROUPS.map((g) => [g.id, []]));
  let used = 0;
  for (const g of GROUPS) { const take = assigned.get(g.id).slice(0, quota.get(g.id)); chosen.get(g.id).push(...take); used += take.length; }
  // leftover capacity by fused score across everything not yet chosen
  const picked = new Set([...chosen.values()].flat().map((f) => f.family_id));
  const rest = byScore.filter((f) => !picked.has(f.family_id));
  const fill = rest.slice(0, Math.max(0, max - used));
  for (const f of fill) { const g = GROUPS.find((x) => x.roles.some((r) => f.roles?.includes(r))); (g ? chosen.get(g.id) : (chosen.get('other') ?? chosen.set('other', []).get('other'))).push(f); picked.add(f.family_id); }
  const groups = [...GROUPS.map((g) => ({ id: g.id, label: g.label, families: chosen.get(g.id) })), { id: 'other', label: 'Other relevant', families: chosen.get('other') ?? [] }].filter((g) => g.families.length);
  for (const g of groups) if (g.id !== 'foundational') g.families.sort((a, b) => b.fused - a.fused);
  const selected = groups.flatMap((g) => g.families);
  return { groups, selected, overflow: byScore.filter((f) => !picked.has(f.family_id)) };
}
