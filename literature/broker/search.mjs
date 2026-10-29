// literature_search: one search over the scholarly backends, with a machine-readable coverage report.
//
// Pipeline: classify field → plan backends for the mode → transform the query per backend → run concurrently (each backend
// under a hard timeout; one failure never aborts the search) → normalize → cheap OpenAlex enrichment (citations, type,
// retraction) → work families → rank fusion → [landscape: two-hop expansion; comprehensive/novelty: bounded expansion]
// → roles → coverage-aware selection → compact result + machine-readable coverage report.
import { classifyField, keywords, formulations, forArxiv, forOpenalexKeyword, forPubmed, feedbackTerms } from './query.mjs';
import { FamilyBuilder, familyStatus, versionsOf } from './family.mjs';
import { fuse, assignRoles, selectWithRoles, topicalTerms, topicalOverlap, introducesMethod, REVIEW_RE, BENCHMARK_RE } from './rank.mjs';
import { expandAnchor } from './expand.mjs';
import { paperResolve, jaccard } from './resolve.mjs';
import { parseRef } from './ids.mjs';
import { normTitle, normDoi, isPreprint } from '../lib/normalize.mjs';

export const MODES = ['standard', 'landscape', 'recent', 'comprehensive', 'novelty'];
export const DEFAULT_MAX = { standard: 15, landscape: 30, recent: 15, comprehensive: 30, novelty: 30 };

// Routing table per field: semantic engines get the sentence, lexical engines the keywords. `form`: which formulation a
// backend receives.
const CORE = {
  biomedical: [['exa', 'sentence'], ['openalex_semantic', 'sentence'], ['openalex_keyword', 'keywords'], ['pubmed', 'keywords']],
  computational_biology: [['exa', 'sentence'], ['openalex_semantic', 'sentence'], ['openalex_keyword', 'keywords'], ['pubmed', 'keywords']],
  ml_cs: [['exa', 'sentence'], ['openalex_semantic', 'sentence'], ['arxiv', 'arxiv']],
  general: [['exa', 'sentence'], ['openalex_semantic', 'sentence'], ['openalex_keyword', 'keywords'], ['pubmed', 'keywords']],
};
export const DEFAULT_CONFIG = {
  // Semantic Scholar stays out of standard routing until it has been re-evaluated with an API key (keyless, it was
  // rate limited too often to rely on); set to e.g. ['comprehensive','novelty','computational_biology'], or 'disabled'.
  semantic_scholar: 'comprehensive_only',
  searxng_modes: ['comprehensive', 'novelty'],
  expansion: { neighborhood: 40, bibliographies: 6, max_cocited: 150, citing: 25, comprehensive_anchors: 4, max_new_families: 500, named_methods: 6 },
};

/** `exaMode`: the provider's p.exa.mode. 'unconfigured' (no key, keyless not opted in) keeps Exa out of the plan, with the
 *  reason in `skipped`; any other value (or none) routes it. */
export function planBackends({ mode, field, s2State, config = DEFAULT_CONFIG, window = {}, synonymsGiven = false, exaMode, exaReason }) {
  const plan = []; const skipped = [];
  const exaOff = exaMode === 'unconfigured';
  if (exaOff) skipped.push({ backend: 'exa', reason: exaReason ?? 'not configured: no EXA_API_KEY, and keyless Exa is opt-in (MINA_EXA_KEYLESS=1)' });
  const add = (backend, form) => { if (exaOff && backend === 'exa') return; if (!plan.some((x) => x.backend === backend && x.form === form)) plan.push({ backend, form }); };
  for (const [b, f] of CORE[field] ?? CORE.general) add(b, f);
  if (mode === 'landscape' && field === 'ml_cs') add('openalex_keyword', 'keywords');
  if (mode === 'recent') {
    if (field !== 'ml_cs') add('europepmc', 'keywords');
    if (field === 'ml_cs' || field === 'computational_biology') add('arxiv_recent', 'arxiv');
    const narrow = window.from && (Date.parse(window.to ?? new Date().toISOString()) - Date.parse(window.from)) <= 92 * 86400000;
    if (narrow && field !== 'ml_cs') add('biorxiv', 'keywords'); else if (field !== 'ml_cs') skipped.push({ backend: 'biorxiv', reason: 'direct bioRxiv/medRxiv search only for an explicit window of ≤ 3 months (OpenAlex and Europe PMC index new preprints within days)' });
  }
  if (mode === 'comprehensive' || mode === 'novelty') {
    for (const b of ['exa', 'openalex_semantic']) add(b, 'sentence');
    for (const f of ['keywords', ...(synonymsGiven ? ['synonyms'] : []), 'core']) { add('openalex_keyword', f); add('pubmed', f); add('europepmc', f); }
    if (field !== 'biomedical') add('arxiv', 'arxiv');
    if (mode === 'novelty') { add('arxiv', 'arxiv'); if (field !== 'ml_cs') add('biorxiv', 'keywords'); }
  }
  if ((config.searxng_modes ?? []).includes(mode)) add('searxng', 'keywords'); else skipped.push({ backend: 'searxng', reason: `not in ${mode} mode (in testing it added relevant records but no key paper the other backends missed)` });
  const s2cfg = config.semantic_scholar;
  const s2Wanted = s2cfg !== 'disabled' && (s2cfg === 'comprehensive_only' ? ['comprehensive', 'novelty'].includes(mode) : Array.isArray(s2cfg) && (s2cfg.includes(mode) || s2cfg.includes(field)));
  if (s2Wanted && (s2State === 'enabled_keyed' || s2State === 'enabled_keyless')) add('semantic_scholar', 'keywords');
  else skipped.push({ backend: 'semantic_scholar', reason: s2cfg === 'disabled' ? 'disabled in configuration' : s2State === 'temporarily_unhealthy' ? 'temporarily unhealthy (recent rate limit or timeout)' : `not routed in ${mode} mode until re-evaluated with an API key` });
  return { plan, skipped };
}

const yearOf = (d) => (d ? Number(String(d).slice(0, 4)) || null : null);

export async function literatureSearch(env, params) {
  const { p, rt } = env;
  const config = { ...DEFAULT_CONFIG, ...(env.config ?? {}), expansion: { ...DEFAULT_CONFIG.expansion, ...(env.config?.expansion ?? {}) } };
  if (params?.continuation) return continuePage(env, params.continuation, params.max_results);
  const query = String(params?.query ?? '').trim();
  if (!query) return { status: 'invalid', error: 'query is required' };
  const mode = MODES.includes(params.mode) ? params.mode : 'standard';
  const t0 = Date.now();
  const ctx = { tool: 'literature_search', mode, q: query.slice(0, 160) };

  // An identifier (or a URL) is a lookup, not a search (of the search backends only PubMed treats a bare DOI or PMID as a lookup).
  try {
    const pr = parseRef(query);
    if (!['title', 'url'].includes(pr.kind) || (pr.kind === 'url' && Object.keys(pr.ids).length)) {
      const r = await paperResolve(env, query, { ctx });
      return { status: r.status === 'ok' ? 'ok' : r.status, mode: 'identifier_lookup', results: r.family ? [r.family] : [], resolve: r,
        coverage: { mode: 'identifier_lookup', coverage_notes: ['the query is an identifier: resolved with paper_resolve instead of searched'] } };
    }
  } catch { /* not an identifier */ }

  const fieldIn = params.field && params.field !== 'auto' ? params.field : null;
  const fc = classifyField(`${query} ${params.keywords ?? ''}`);
  const field = fieldIn ?? fc.field;
  const window = { from: params.date_from ?? (mode === 'recent' ? new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10) : undefined), to: params.date_to };
  const forms = formulations({ query, keywords: params.keywords, synonyms: params.synonyms, mode });
  const formText = Object.fromEntries(forms.map((f) => [f.id, f.text]));
  const s2State = p.semantic_scholar.state(config);
  const { plan, skipped } = planBackends({ mode, field, s2State, config, window, synonymsGiven: Boolean(formText.synonyms), exaMode: p.exa?.mode, exaReason: p.exa?.notConfigured });
  const max = Math.min(50, Math.max(1, Number(params.max_results) || DEFAULT_MAX[mode]));
  const executed = []; const notes = [];

  // ---- wave 1: planned backends, concurrently ---------------------------------------------------------------------------
  const runOne = async ({ backend, form }) => {
    const text = form === 'arxiv' ? forArxiv(formText.keywords) : form === 'feedback_arxiv' ? forArxiv(formText.feedback ?? formText.keywords) : formText[form] ?? formText.keywords;
    const lex = form === 'sentence' ? text : form === 'arxiv' ? text : text;
    const n = 25;
    switch (backend) {
      case 'exa': return p.exa.search({ q: lex, n: 20, from: window.from, to: window.to, ctx });
      case 'openalex_semantic': return p.openalex.semantic({ q: lex, n, from: window.from, to: window.to, ctx });
      case 'openalex_keyword': return p.openalex.keyword({ q: forOpenalexKeyword(lex), n, from: window.from, to: window.to, ctx });
      case 'pubmed': return p.pubmed.search({ q: forPubmed(lex), n, from: window.from, to: window.to, ctx });
      case 'europepmc': return p.europepmc.search({ q: lex, n, from: window.from, to: window.to, ctx });
      case 'arxiv': return p.arxiv.search({ q: lex, n, from: window.from, to: window.to, ctx });
      case 'arxiv_recent': return p.arxiv.search({ q: lex, n, sort: 'submitted', from: window.from, to: window.to, ctx });
      case 'biorxiv': return p.biorxiv.search({ q: lex, n, from: window.from, to: window.to, ctx });
      case 'searxng': return p.searxng.search({ q: lex, field, ctx });
      case 'semantic_scholar': return p.semantic_scholar.search({ q: lex, n: 20, ctx });
      default: return { outcome: 'error', error: `unknown backend ${backend}`, items: [] };
    }
  };
  const pool = [];
  async function runWave(entries, wave) {
    const settled = await Promise.allSettled(entries.map((e) => runOne(e)));
    settled.forEach((s, i) => {
      const e = entries[i];
      const r = s.status === 'fulfilled' ? s.value : { outcome: 'error', error: String(s.reason?.message ?? s.reason), items: [] };
      const channel = e.backend === 'arxiv_recent' ? 'arxiv' : e.backend;
      executed.push({ wave, backend: channel, operation: r.op ?? e.backend, formulation: e.form, sent: r.sent ?? null, outcome: r.outcome, returned: r.items?.length ?? 0, total: r.total ?? null, ms: r.ms ?? null, cached: r.cached || undefined, error: r.error ?? undefined,
        date_filter: r.date_filter ?? undefined });
      // provider-level coverage limits (e.g. OpenAlex semantic dates filtered locally, not server-side)
      for (const n of r.notes ?? []) if (!notes.includes(n)) notes.push(n);
      (r.items ?? []).forEach((c) => pool.push({ ...c, _source: channel, _rank: c.rank, _form: e.form, _wave: wave }));
    });
  }
  // A cancelled invocation stops between stages (env.signal is the tool's; its backend calls are already cancelled).
  const stopped = () => Boolean(env.signal?.aborted);
  const cancelled = () => ({ status: 'cancelled', mode, query, results: [], coverage: { mode, queries_executed: executed, coverage_notes: ['the caller cancelled the search'] } });
  await runWave(plan, 1);
  if (stopped()) return cancelled();

  // comprehensive / novelty: a feedback formulation from the semantic engines' vocabulary (the literature may use other
  // terms than the query)
  const semItems = pool.filter((c) => c._source === 'exa' || c._source === 'openalex_semantic').sort((a, b) => a._rank - b._rank);
  const fb = feedbackTerms(query, semItems);
  if ((mode === 'comprehensive' || mode === 'novelty' || mode === 'landscape') && fb.length) {
    formText.feedback = `${formText.keywords} ${fb.slice(0, 3).join(' ')}`;
    await runWave(['openalex_keyword', 'pubmed', 'arxiv'].filter((b) => plan.some((x) => x.backend === b)).map((b) => ({ backend: b, form: b === 'arxiv' ? 'feedback_arxiv' : 'feedback' })), 2);
  }

  if (stopped()) return cancelled();
  // ---- normalize, enrich, family ---------------------------------------------------------------------------------------
  const topic = new Set([...topicalTerms(formText.keywords), ...topicalTerms((params.synonyms ?? []).flat().join(' ')), ...topicalTerms(fb.join(' '))]);
  let state = await buildFamilies(env, pool, { ctx, notes });
  const enrichment = state.enrichment;

  // ---- expansion ----------------------------------------------------------------------------------------------------------
  let expansion = null;
  const anchorRefs = new Map();
  if (stopped()) return cancelled();
  if (mode === 'landscape' || mode === 'comprehensive' || mode === 'novelty') {
    expansion = await expand(env, state, { mode, field, topic, config, ctx, anchorRefs, notes, executed });
    if (expansion.added.length) state = await buildFamilies(env, [...pool, ...expansion.added], { ctx, notes, prior: state });
    // anchorRefs was keyed by candidate keys; map to the final family ids
    const byKey = state.keyToFamily;
    const counts = new Map();
    for (const [key, anchors] of expansion.refAnchors) { const fid = byKey.get(key); if (!fid) continue; if (!counts.has(fid)) counts.set(fid, new Set()); for (const a of anchors) counts.get(fid).add(a); }
    for (const [fid, s] of counts) anchorRefs.set(fid, s.size);
  }

  // ---- fuse, filter, roles, select ----------------------------------------------------------------------------------------
  const nowYear = new Date().getUTCFullYear();
  const queryTopic = new Set([...topicalTerms(formText.keywords), ...topicalTerms((params.synonyms ?? []).flat().join(' '))]);
  const feedbackTopic = topicalTerms(fb.join(' '));
  let before = 0;
  const score = (st) => {
    const fused = fuse(st.hits);
    let fs = st.families.map((f) => ({ ...f, fused: fused.get(f.family_id)?.score ?? 0, fusion: fused.get(f.family_id) }));
    const knownItem = (f) => jaccard(f.title, query) >= 0.8;
    for (const f of fs) if (f.retracted && !knownItem(f)) { f.fused *= 0.3; f.demoted = 'retracted'; }
    // Expansion-only families must be on topic or co-referenced: the neighborhood is broad by design.
    fs = fs.filter((f) => f.found_by.some((x) => !x.startsWith('expansion')) || (anchorRefs.get(f.family_id) ?? 0) >= 2 || topicalOverlap(f, topic) >= 2);
    before = fs.length;
    if (window.from) { const y = yearOf(window.from); fs = fs.filter((f) => !f.year_max || f.year_max >= y); }
    if (window.to) { const y = yearOf(window.to); fs = fs.filter((f) => !f.year_min || f.year_min <= y); }
    if (params.include_preprints === false) fs = fs.filter((f) => !f.preprint_only);
    assignRoles(fs, { nowYear, anchorRefs, topic, queryTopic, feedbackTopic });
    return fs;
  };
  const fams = score(state);
  const grouped = mode === 'landscape' || mode === 'comprehensive' || mode === 'novelty';
  const sel = selectWithRoles(fams, { max, grouped });

  // ---- coverage -----------------------------------------------------------------------------------------------------------
  const attempted = [...new Set(executed.map((e) => e.backend))];
  const okSet = new Set(executed.filter((e) => e.outcome === 'ok' || e.outcome === 'empty').map((e) => e.backend));
  const failed = executed.filter((e) => !['ok', 'empty'].includes(e.outcome)).map((e) => ({ backend: e.backend, operation: e.operation, formulation: e.formulation, reason: e.outcome, error: e.error }));
  if (p.exa.mode === 'keyless') notes.push('Exa ran through its keyless endpoint (no EXA key found; keyless opted in): fewer and different results than the keyed API');
  if (p.exa.mode === 'unconfigured') notes.push(`Exa did not run: ${p.exa.notConfigured ?? 'not configured'}`);
  if (failed.some((f) => f.reason === 'budget_exhausted')) notes.push('OpenAlex daily budget exhausted: OpenAlex searches did not run; results come from the remaining backends');
  const zero = executed.filter((e) => e.outcome === 'empty').map((e) => `${e.backend} (${e.formulation}): ${e.sent}`);
  const coverage = {
    mode, field, field_inferred: !fieldIn, field_scores: fc.scores, date_window: window.from || window.to ? window : null,
    formulations: formText, feedback_terms: fb,
    backends_attempted: attempted, backends_succeeded: attempted.filter((b) => okSet.has(b)),
    backends_failed: failed, backends_not_routed: skipped,
    queries_executed: executed, searches_with_zero_results: zero,
    // How each date-windowed search applied the window, when not server-side (OpenAlex semantic: local post-filter).
    date_filtering: executed.filter((e) => e.date_filter).map((e) => ({ backend: e.backend, wave: e.wave, formulation: e.formulation, ...e.date_filter })),
    citation_expansion: Boolean(expansion), expansion: expansion?.report ?? null, enrichment,
    candidates: { raw: pool.length + (expansion?.added.length ?? 0), families: state.families.length, after_filters: before, returned: sel.selected.length, overflow: sel.overflow.length },
    exa_mode: p.exa.mode, semantic_scholar: s2State, openalex_budget: rt.budget.status(),
    coverage_notes: notes,
  };
  if (mode === 'novelty') coverage.absence_statement = absenceStatement(coverage, query);
  const contToken = sel.overflow.length ? putContinuation(env, sel.overflow, { query, mode }) : null;
  const out = {
    status: 'ok', mode, field, query,
    groups: sel.groups ? sel.groups.map((g) => ({ id: g.id, label: g.label, families: g.families.map((f) => f.family_id) })) : null,
    results: sel.selected.map(compact),
    continuation: contToken, coverage, latency_ms: Date.now() - t0,
  };
  rt.log.event('search', { ctx, field, backends: attempted, failed: failed.map((f) => `${f.backend}:${f.reason}`), raw: coverage.candidates.raw, families: coverage.candidates.families, returned: out.results.length,
    roles: Object.fromEntries(['seminal', 'review', 'benchmark', 'current_method', 'recent_development'].map((r) => [r, sel.selected.filter((f) => f.roles.includes(r)).length])), expansion: expansion?.report?.counts ?? null, ms: out.latency_ms });
  return out;
}

// ---- families ------------------------------------------------------------------------------------------------------------
export async function buildFamilies(env, pool, { ctx, notes = [], prior } = {}) {
  const { p } = env;
  // Enrichment: OpenAlex batch lookups (USD 0.0001 per 50) for records that lack an OpenAlex id, so every family has
  // citation counts, type and retraction status. arXiv records are enriched by their DataCite DOI, but only when OpenAlex's
  // title matches arXiv's (OpenAlex's arXiv records sometimes carry another work's title).
  const enrichment = prior?.enrichment ?? { calls: 0, matched: 0, arxiv_conflicts: 0 };
  const seen = prior?.enriched ?? new Map();
  const needDoi = [...new Set(pool.filter((c) => !c.openalex && c.doi && !seen.has(`doi:${c.doi}`)).map((c) => c.doi))].slice(0, 200);
  const needAx = [...new Set(pool.filter((c) => c.arxiv && !c.openalex && !seen.has(`doi:10.48550/arxiv.${c.arxiv}`)).map((c) => `10.48550/arxiv.${c.arxiv}`))].slice(0, 100);
  const needPm = [...new Set(pool.filter((c) => !c.openalex && !c.doi && c.pmid && !seen.has(`pmid:${c.pmid}`)).map((c) => c.pmid))].slice(0, 100);
  const jobs = [];
  if (needDoi.length || needAx.length) jobs.push(p.openalex.batch({ key: 'doi', values: [...needDoi, ...needAx], ctx }));
  if (needPm.length) jobs.push(p.openalex.batch({ key: 'pmid', values: needPm, ctx }));
  for (const r of await Promise.all(jobs)) {
    enrichment.calls += r.calls?.length ?? 0;
    if (r.outcome !== 'ok') notes.push(`OpenAlex enrichment ${r.outcome}: some families lack citation counts`);
    for (const w of r.items) { if (w.doi) seen.set(`doi:${w.doi}`, w); if (w.pmid) seen.set(`pmid:${w.pmid}`, w); }
  }
  const enriched = pool.map((c) => {
    const w = (c.arxiv && seen.get(`doi:10.48550/arxiv.${c.arxiv}`)) || (c.doi && seen.get(`doi:${c.doi}`)) || (c.pmid && seen.get(`pmid:${c.pmid}`));
    if (!w) return c;
    if (c.arxiv && c._source === 'arxiv' && w.title && jaccard(w.title, c.title) < 0.6) { enrichment.arxiv_conflicts++; return { ...c, openalex_conflict: w.openalex }; }
    enrichment.matched++;
    const x = { ...c };
    // bibliography titles are as the citing authors typed them; an indexed record with a matching title is better cased
    if (/arxiv_html/.test(c._source ?? '') && w.title && jaccard(w.title, c.title) >= 0.6) x.title = w.title;
    for (const k of ['openalex', 'cited_by', 'type', 'is_retracted', 'pmid', 'pmcid', 'year', 'venue', 'abstract', 'authors', 'references_count']) if (x[k] === undefined || x[k] === null || x[k] === '') x[k] = w[k];
    if (!x.doi && w.doi && !w.doi.startsWith('10.48550/')) x.doi = w.doi;
    return x;
  });
  const fb = new FamilyBuilder();
  const idx = enriched.map((c) => fb.add(c));
  for (const c of enriched) {
    if (c.published_doi && c.doi) fb.link(`doi:${c.doi}`, `doi:${normDoi(c.published_doi)}`, 'preprint_of', 'authoritative', 'bioRxiv API published DOI');
    if (c.arxiv && c.doi && !c.doi.startsWith('10.48550/') && c._source === 'arxiv') fb.link(`arxiv:${c.arxiv}`, `doi:${c.doi}`, 'preprint_of', 'strong', 'arXiv metadata journal DOI');
  }
  const built = fb.build();
  const hits = new Map(); const keyToFamily = new Map();
  const families = built.map((f) => {
    const members = f.members;
    const ax = members.find((m) => (m._sources ?? [m._source]).includes('arxiv'));
    const title = ax?.title ?? f.canonical.title ?? members.find((m) => m.title)?.title;
    const years = members.map((m) => m.year).filter(Boolean);
    const st = familyStatus(members);
    const foundBy = new Set(); const ranks = {}; const forms = new Set();
    for (const i of f.member_index) {
      const c = enriched[i];
      const ch = c._source ?? 'unknown';
      foundBy.add(ch); if (c._rank && (!ranks[ch] || c._rank < ranks[ch])) ranks[ch] = c._rank;
      if (c._form) forms.add(c._form);
      if (!hits.has(f.family_id)) hits.set(f.family_id, []);
      hits.get(f.family_id).push({ channel: ch, rank: c._rank ?? 50 });
      for (const k of famKeys(c)) keyToFamily.set(k, f.family_id);
    }
    const abstract = members.map((m) => m.abstract).filter(Boolean).sort((a, b) => b.length - a.length)[0] ?? null;
    return {
      family_id: f.family_id, title, year: f.canonical.year ?? (years.length ? Math.min(...years) : null), year_min: years.length ? Math.min(...years) : null, year_max: years.length ? Math.max(...years) : null,
      venue: f.canonical.venue ?? null, authors: (f.canonical.authors ?? members.find((m) => m.authors?.length)?.authors ?? []).slice(0, 4), type: f.canonical.type ?? null,
      cited_by: Math.max(0, ...members.map((m) => m.cited_by ?? 0)) || null, abstract,
      ids: mergeIds(members), versions: versionsOf(members, f.canonical), links: f.links.filter((l) => l.relation !== 'same_record'),
      retracted: st.retracted, preprint_only: members.every((m) => isPreprint(m)),
      openalex_conflict: members.find((m) => m.openalex_conflict)?.openalex_conflict ?? null,
      found_by: [...foundBy], ranks, formulations: [...forms], members,
    };
  });
  return { families, hits, keyToFamily, enrichment, enriched: seen };
}
// Keys used to count co-references across anchors and to map candidates to families: identifiers, and the normalized
// title (bibliography entries often carry only a title).
const famKeys = (c) => { const t = normTitle(c.title); return [c.doi && `doi:${c.doi}`, c.pmid && `pmid:${c.pmid}`, c.arxiv && `arxiv:${c.arxiv}`, c.openalex && `oa:${c.openalex}`, t.length >= 20 && `title:${t}`].filter(Boolean); };
function mergeIds(members) {
  const ids = {};
  const vor = members.find((m) => !isPreprint(m) && m.doi);
  if (vor) ids.doi = vor.doi;
  for (const k of ['pmid', 'pmcid', 'arxiv', 'openalex', 's2']) { const m = members.find((x) => x[k] && (k !== 'openalex' || !x.openalex_conflict)); if (m) ids[k] = m[k]; }
  const pre = members.find((m) => m.doi && /^10\.(1101|64898)\//.test(m.doi));
  if (pre) ids.preprint_doi = pre.doi;
  if (!ids.doi) { const any = members.find((m) => m.doi && !/^10\.48550\//.test(m.doi) && m.doi !== ids.preprint_doi); if (any) ids.doi = any.doi; }
  return ids;
}

// ---- expansion ----------------------------------------------------------------------------------------------------------
// Capitalized words that are not tool names when they appear mid-sentence.
const COMMON_CAPS = new Set('Gram Illumina Nanopore Oxford PacBio Bayesian Gaussian Markov Monte Carlo Euclidean Pearson Spearman Fisher Student Wilcoxon English Chinese European American Africa Asia Europe America Google Microsoft Amazon Python Java Linux Unix Windows Escherichia Bacillus Staphylococcus Pseudomonas Mycobacterium Salmonella Streptococcus Arabidopsis Drosophila Saccharomyces Caenorhabditis Mus Homo Here However Moreover Furthermore Finally Therefore Thus These This That Those Our Its Their Figure Table Supplementary Methods Results Discussion Introduction Conclusion Abstract Background Data January February March April May June July August September October November December'.split(' '));

async function expand(env, state, { mode, field, topic, config, ctx, notes, executed }) {
  const { p } = env;
  const fused = fuse(state.hits);
  const ranked = state.families.map((f) => ({ ...f, fused: fused.get(f.family_id)?.score ?? 0, channels: fused.get(f.family_id)?.channels ?? 0 })).sort((a, b) => b.fused - a.fused);
  // The neighborhood: the top results of the search itself ("centrality within the retrieved citation
  // neighborhood"). A paper that many of them cite is central to the topic; one that only an anchor or two cite is not.
  const hood = ranked.filter((f) => !f.retracted).slice(0, config.expansion.neighborhood);
  const added = []; const refAnchors = new Map(); const per = [];
  const count = (keys, citer) => { for (const k of keys) { if (!refAnchors.has(k)) refAnchors.set(k, new Set()); refAnchors.get(k).add(citer); } };
  const log1 = (backend, operation, sent, r) => executed.push({ wave: 'expansion', backend, operation, formulation: 'citation', sent, outcome: r.outcome, returned: r.items?.length ?? r.count ?? 0, total: r.total ?? null, ms: r.ms ?? null, cached: r.cached || undefined, error: r.error ?? undefined });

  // 1. OpenAlex reference lists of the neighborhood, in one batch call (USD 0.0001 per 50)
  const oaIds = hood.filter((f) => f.ids.openalex && !f.openalex_conflict).map((f) => f.ids.openalex);
  const refsBy = new Map();
  if (oaIds.length) {
    const bt = await p.openalex.batch({ key: 'openalex', values: oaIds, select: 'id,referenced_works', ctx });
    log1('openalex', 'reference lists of the top results', `${oaIds.length} works`, bt);
    for (const w of bt.items) refsBy.set(w.openalex, w.referenced_works ?? []);
  }
  for (const f of hood) { const refs = refsBy.get(f.ids.openalex) ?? []; for (const r of refs) count([`oa:${r}`], f.family_id); if (refs.length) per.push({ family_id: f.family_id, title: f.title, role: 'neighborhood', edges: refs.length, source: 'openalex' }); }
  // 2. arXiv bibliographies where OpenAlex has no reference list (its arXiv records carry none)
  const needBib = hood.filter((f) => f.ids.arxiv && !(refsBy.get(f.ids.openalex)?.length)).slice(0, config.expansion.bibliographies);
  const bibs = await Promise.all(needBib.map(async (f) => ({ f, r: await p.arxiv.bibliography({ id: f.ids.arxiv, ctx }) })));
  for (const { f, r } of bibs) {
    log1('arxiv_html', `bibliography of ${f.family_id}`, f.ids.arxiv, r);
    per.push({ family_id: f.family_id, title: f.title, role: 'neighborhood', edges: r.items?.length ?? 0, source: 'arxiv_bibliography' });
    for (const c of r.items ?? []) { count(famKeys(c), f.family_id); added.push({ ...c, _source: 'expansion:arxiv_html:references', _rank: c.rank, _form: 'expansion', _anchor: f.family_id }); }
  }
  // 3. PubMed reference lists of the top PMID-bearing results without an OpenAlex list (biomedical fields)
  if (field !== 'ml_cs') {
    const needPm = hood.filter((f) => f.ids.pmid && !(refsBy.get(f.ids.openalex)?.length)).slice(0, 4);
    const pm = await Promise.all(needPm.map(async (f) => ({ f, r: await p.pubmed.related({ pmid: f.ids.pmid, relationship: 'references', n: 100, ctx }) })));
    for (const { f, r } of pm) { log1('pubmed', `references of ${f.family_id}`, f.ids.pmid, r); for (const c of r.items ?? []) count(famKeys(c), f.family_id); }
  }
  // 4. The cited works themselves: everything cited by ≥ 2 neighborhood papers (one metadata batch per 50)
  const minRefs = 2;
  const cited = [...refAnchors.entries()].filter(([k, s]) => s.size >= minRefs && k.startsWith('oa:')).sort((x, y) => y[1].size - x[1].size).slice(0, config.expansion.max_cocited).map(([k]) => k.slice(3));
  if (cited.length) {
    const meta = await p.openalex.batch({ key: 'openalex', values: cited, ctx });
    log1('openalex', 'metadata of co-cited works', `${cited.length} works`, meta);
    const order = new Map(cited.map((w, i) => [w, i]));
    for (const w of meta.items) added.push({ ...w, _source: 'expansion:openalex:references', _rank: (order.get(w.openalex) ?? 99) + 1, _form: 'expansion' });
  }
  const pmCited = [...refAnchors.entries()].filter(([k, s]) => s.size >= minRefs && k.startsWith('pmid:')).map(([k]) => k.slice(5)).slice(0, 100);
  if (pmCited.length) {
    const meta = await p.openalex.batch({ key: 'pmid', values: pmCited, ctx });
    for (const w of meta.items) added.push({ ...w, _source: 'expansion:pubmed:references', _rank: 1, _form: 'expansion' });
  }
  // 5. Successors: citing papers of the top on-topic method papers (current and recent work)
  const methods = hood.filter((f) => introducesMethod(f) && topicalOverlap(f, topic) >= 2 && f.ids.openalex && !f.openalex_conflict).slice(0, mode === 'landscape' ? 2 : config.expansion.comprehensive_anchors);
  const citing = await Promise.all(methods.map(async (f) => ({ f, r: await p.openalex.citing({ openalex: f.ids.openalex, n: config.expansion.citing, ctx }) })));
  for (const { f, r } of citing) { log1('openalex', `papers citing ${f.family_id}`, f.ids.openalex, r); per.push({ family_id: f.family_id, title: f.title, role: 'method (citing)', edges: r.items?.length ?? 0, source: 'openalex' }); for (const c of r.items ?? []) added.push({ ...c, _source: 'expansion:openalex:cited_by', _rank: c.rank, _form: 'expansion' }); }

  // Bounded: keep co-cited candidates, and on-topic ones (bibliography entries and citing papers).
  const keep = added.filter((c) => famKeys(c).some((k) => (refAnchors.get(k)?.size ?? 0) >= minRefs) || topicalOverlap(c, topic) >= 2);
  const bounded = keep.slice(0, config.expansion.max_new_families);

  // ---- named methods (landscape, novelty): names the neighborhood uses that no result introduces ------------------------
  const named = [];
  if (mode === 'landscape' || mode === 'novelty') {
    const counts = new Map();
    const bump = (name, src) => { if (!name || name.length < 3 || /^(The|A|An|In|On|We|Our|This|How|Why|What|Towards?|Beyond|Correction|Erratum|Review|Survey|Retraction|Editorial)$/i.test(name)) return; if (!counts.has(name)) counts.set(name, new Set()); counts.get(name).add(src); };
    const anchorsForNames = hood.slice(0, 12);
    for (const a of anchorsForNames) for (const m of String(a.abstract ?? '').matchAll(/(?<=[a-z,;(]\s)([A-Z][a-z]{2,15}[0-9]?)\b(?!\s+[A-Z][a-z])/g)) if (!COMMON_CAPS.has(m[1])) bump(m[1], a.family_id);
    for (const a of anchorsForNames) for (const m of String(a.abstract ?? '').matchAll(/\b([A-Z][a-z]*[A-Z][A-Za-z0-9-]*|[A-Z]{3,}[0-9]*|[a-z]+[A-Z][A-Za-z0-9-]*|[A-Za-z]+-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)\b/g)) if (/[A-Z]/.test(m[1]) && !/^(DNA|RNA|PCR|USA|NIH|LLMs?|VLMs?|MLLMs?|GPUs?|TPUs?|CPUs?|AI|ML|NLP|HTTP|API|URL|SOTA|IEEE|ACM|ICML|ICLR|NeurIPS|ACL|EMNLP|CVPR|ArXiv|arXiv|CoRR)$/.test(m[1])) bump(m[1], a.family_id);
    const present = new Set([...state.families, ...bounded].map((f) => (introducesMethod(f)?.name ?? '').toLowerCase()).filter(Boolean));
    const names = [...counts.entries()].filter(([n, s]) => s.size >= 2 && !present.has(n.toLowerCase())).sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).slice(0, config.expansion.named_methods).map(([n]) => n);
    const lookups = await Promise.all(names.map(async (name) => {
      const rs = await Promise.all([p.openalex.titleSearch({ title: name, n: 5, ctx }), field === 'ml_cs' || field === 'computational_biology' ? p.arxiv.search({ q: `ti:${name}`, n: 5, ctx }) : null]);
      const hits = rs.filter(Boolean).flatMap((r) => r.items ?? []).filter((c) => new RegExp(`(^|[^A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i').test(c.title ?? '') && topicalOverlap(c, topic) >= 1);
      const best = hits.sort((a, b) => ((introducesMethod(b)?.name ?? '').toLowerCase() === name.toLowerCase()) - ((introducesMethod(a)?.name ?? '').toLowerCase() === name.toLowerCase()) || (b.cited_by ?? 0) - (a.cited_by ?? 0))[0];
      for (const r of rs.filter(Boolean)) executed.push({ wave: 'named_method', backend: r.backend, operation: r.op, formulation: 'named_method', sent: r.sent ?? name, outcome: r.outcome, returned: r.items?.length ?? 0, ms: r.ms, cached: r.cached || undefined, error: r.error ?? undefined });
      return { name, found: best ? { title: best.title, doi: best.doi ?? null, arxiv: best.arxiv ?? null } : null, cand: best ? { ...best, _source: 'expansion:named_method', _rank: 1, _form: 'named_method' } : null };
    }));
    for (const l of lookups) { named.push({ name: l.name, found: l.found }); if (l.cand) bounded.push(l.cand); }
  }
  const report = { anchors: per, neighborhood: hood.length, counts: { anchors: per.length, edges: [...refAnchors.values()].reduce((s, x) => s + x.size, 0), cocited: cited.length, kept: bounded.length,
    references: added.filter((c) => /references/.test(c._source)).length, citing: added.filter((c) => /cited_by/.test(c._source)).length },
    named_methods: named, stop: `one hop: reference lists of the top ${hood.length} results (co-citation ≥ ${minRefs}), citing papers of ${methods.length} method papers${named.length ? `, ${named.length} named-method searches` : ''}` };
  return { added: bounded, refAnchors, report };
}

// ---- output ---------------------------------------------------------------------------------------------------------------
function compact(f) {
  return {
    family_id: f.family_id, title: f.title, year: f.year, venue: f.venue, authors: f.authors, ids: f.ids,
    roles: f.roles, role_signals: f.role_signals, retracted: f.retracted || undefined, demoted: f.demoted, openalex_conflict: f.openalex_conflict || undefined,
    cited_by: f.cited_by, versions: f.versions.length > 1 ? f.versions : undefined, links: f.links.length ? f.links : undefined,
    found_by: f.found_by, ranks: f.ranks, formulations: f.formulations, citation_expanded: f.found_by.some((b) => b.startsWith('expansion')) || undefined,
    fused_score: +f.fused.toFixed(5), fusion: f.fusion?.parts, abstract: f.abstract ? `${f.abstract.slice(0, 320)}${f.abstract.length > 320 ? '…' : ''}` : null,
  };
}

function putContinuation(env, overflow, meta) {
  const items = overflow.map(compact);
  return env.rt.cache.put('continuation', ['cont', meta, Date.now(), items.length], { meta, items });
}
async function continuePage(env, token, max = 20) {
  const [key, off = '0'] = String(token).split(':');
  const hit = env.rt.cache.get('continuation', key);
  if (!hit) return { status: 'expired', error: 'continuation token expired or unknown; run the search again' };
  const o = Number(off) || 0; const n = Math.min(50, Number(max) || 20);
  const items = hit.value.items.slice(o, o + n);
  return { status: 'ok', mode: hit.value.meta.mode, query: hit.value.meta.query, results: items, continuation: o + n < hit.value.items.length ? `${key}:${o + n}` : null, page: { offset: o, returned: items.length, total: hit.value.items.length } };
}

export function absenceStatement(cov, query) {
  const ok = cov.queries_executed.filter((e) => e.outcome === 'ok' || e.outcome === 'empty');
  const bad = cov.backends_failed;
  return `Searched for "${query}" with ${ok.length} successful searches across ${cov.backends_succeeded.join(', ')} (formulations: ${Object.keys(cov.formulations).join(', ')})`
    + `${cov.citation_expansion ? ', plus one hop of citation expansion' : ''}${cov.expansion?.named_methods?.length ? ` and ${cov.expansion.named_methods.length} named-method searches` : ''}.`
    + `${bad.length ? ` Did not run successfully: ${[...new Set(bad.map((b) => `${b.backend} (${b.reason})`))].join(', ')}.` : ''}`
    + `${cov.backends_not_routed.length ? ` Not searched: ${cov.backends_not_routed.map((b) => b.backend).join(', ')}.` : ''}`
    + ' If no returned work matches, report: "No matching work was found after these searches", never "no such work exists".';
}
