// Unit tests of the literature broker. No network: pure functions are tested directly, and the
// pipelines run against fake providers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRef, authorityFor } from '../broker/ids.mjs';
import { classifyField, keywords, forArxiv, forOpenalexKeyword, withSynonyms, formulations, feedbackTerms } from '../broker/query.mjs';
import { FamilyBuilder, familyId, familyStatus } from '../broker/family.mjs';
import { fuse, assignRoles, selectWithRoles, introducesMethod } from '../broker/rank.mjs';
import { validateRepresentation } from '../broker/validate.mjs';
import { sectionize, makeDocument, fromPmcSections, arxivHtmlToText, parseLatexmlBibliography } from '../broker/text.mjs';
import { buildIndex, retrieve } from '../broker/passages.mjs';
import { createCache, createRuntime, createLog, classify } from '../broker/runtime.mjs';
import { planBackends, literatureSearch, absenceStatement } from '../broker/search.mjs';
import { paperResolve } from '../broker/resolve.mjs';
import { acquire } from '../broker/get.mjs';
import { candidate } from '../lib/normalize.mjs';
import { formatGet } from '../broker/format.mjs';

const memRt = (opts = {}) => createRuntime({ cache: createCache({ dir: null }), log: createLog({ dir: null }), ...opts });

// ---- identifier parsing and authority routing ------------------------------------------------------------------------------
test('parseRef: every identifier kind, versions, URLs, titles', () => {
  assert.deepEqual([parseRef('10.1038/S41592-024-02424-1').kind, parseRef('10.1038/S41592-024-02424-1').value], ['doi', '10.1038/s41592-024-02424-1']);
  assert.equal(parseRef('https://doi.org/10.1038/nature14539').value, '10.1038/nature14539');
  assert.deepEqual([parseRef('pmid:27572649').kind, parseRef('27572649').kind], ['pmid', 'pmid']);
  assert.equal(parseRef('pmc4932909').value, 'PMC4932909');
  const ax = parseRef('arxiv:2106.09685v2');
  assert.deepEqual([ax.kind, ax.value, ax.version], ['arxiv', '2106.09685', 2]);
  assert.equal(parseRef('2405.21060').value, '2405.21060', 'arXiv ids are strings (a YAML float would be 2405.2106)');
  assert.equal(parseRef('10.48550/arXiv.2211.17192').kind, 'arxiv', 'the arXiv DataCite DOI is an arXiv id');
  const bx = parseRef('10.1101/2023.01.31.526521v2');
  assert.deepEqual([bx.kind, bx.value, bx.version], ['biorxiv', '10.1101/2023.01.31.526521', 2]);
  assert.equal(parseRef('https://www.biorxiv.org/content/10.1101/2023.01.31.526521v1.full').version, 1);
  assert.equal(parseRef('10.64898/2026.06.02.729447').kind, 'biorxiv', 'medRxiv/bioRxiv 10.64898 prefix');
  assert.equal(parseRef('W4402874641').kind, 'openalex');
  assert.equal(parseRef('s2:abc').kind, 's2');
  assert.equal(parseRef('https://arxiv.org/abs/2401.10774v3').version, 3);
  assert.equal(parseRef('https://academic.oup.com/bioinformatics/article/40/5/btae252/7658366').kind, 'url');
  assert.equal(parseRef('title:Attention is not Explanation').kind, 'title');
  assert.equal(parseRef({ doi: '10.1/x', pmid: '1' }).kind, 'pmid', 'an object ref uses its strongest identifier');
  assert.throws(() => parseRef(''), /INVALID_REF/);
});
test('authority routing: arXiv ids never go to OpenAlex first', () => {
  assert.equal(authorityFor('arxiv').authority, 'arxiv');
  assert.equal(authorityFor('pmcid').authority, 'pubmed');
  assert.equal(authorityFor('biorxiv').authority, 'biorxiv');
  assert.equal(authorityFor('doi').fallback, 'doi_org');
});

// ---- query transformation and backend selection ----------------------------------------------------------------------------
test('field classification', () => {
  assert.equal(classifyField('speculative decoding for large language model inference').field, 'ml_cs');
  assert.equal(classifyField('strain-resolved metagenomic profiling from long reads').field, 'computational_biology');
  assert.equal(classifyField('GLP-1 receptor agonists for alcohol use disorder in patients').field, 'biomedical');
  assert.equal(classifyField('history of the printing press').field, 'general');
});
test('query transformation per backend', () => {
  const kw = keywords('What methods exist for strain-resolved metagenomic profiling from long reads?');
  assert.equal(kw, 'strain-resolved metagenomic profiling long reads');
  assert.equal(forArxiv('speculative decoding "large language model"'), 'all:speculative AND all:decoding AND all:"large language model"');
  assert.equal(forArxiv('ti:Medusa'), 'ti:Medusa', 'explicit arXiv field syntax passes through');
  assert.equal(forOpenalexKeyword('persist* cells, antibiotic'), 'persist cells antibiotic', 'no wildcards, no commas for OpenAlex');
  assert.equal(withSynonyms('persister antibiotic', [['tolerance', 'dormant cells']]), 'persister antibiotic (tolerance OR "dormant cells")');
  const f = formulations({ query: 'Which detection methods find CRISPR-Cas9 off-target effects genome-wide in human cells?', mode: 'novelty', synonyms: [['off-target', 'unintended edits']] });
  assert.deepEqual(f.map((x) => x.id), ['sentence', 'keywords', 'synonyms', 'core']);
  assert.ok(f.length >= 3, 'novelty runs at least three formulations');
  const fb = feedbackTerms('model compression', [{ title: 'Knowledge distillation for small models' }, { title: 'Distillation of BERT' }, { title: 'Patient knowledge distillation' }, { title: 'other' }]);
  assert.deepEqual(fb, ['distillation'], 'feedback terms come from the semantic results the query does not use');
});
test('backend selection per mode and field', () => {
  const ids = (x) => x.plan.map((p) => `${p.backend}/${p.form}`);
  assert.deepEqual(ids(planBackends({ mode: 'standard', field: 'biomedical', s2State: 'enabled_keyless' })), ['exa/sentence', 'openalex_semantic/sentence', 'openalex_keyword/keywords', 'pubmed/keywords']);
  assert.deepEqual(ids(planBackends({ mode: 'standard', field: 'ml_cs', s2State: 'enabled_keyless' })), ['exa/sentence', 'openalex_semantic/sentence', 'arxiv/arxiv']);
  const std = planBackends({ mode: 'standard', field: 'ml_cs', s2State: 'enabled_keyed' });
  assert.ok(std.skipped.some((s) => s.backend === 'semantic_scholar'), 'Semantic Scholar is not routed in standard mode before the keyed rerun');
  assert.ok(std.skipped.some((s) => s.backend === 'searxng'));
  const comp = planBackends({ mode: 'comprehensive', field: 'computational_biology', s2State: 'enabled_keyless', synonymsGiven: true });
  for (const b of ['searxng/keywords', 'semantic_scholar/keywords', 'europepmc/synonyms', 'pubmed/core', 'arxiv/arxiv']) assert.ok(ids(comp).includes(b), b);
  const unhealthy = planBackends({ mode: 'comprehensive', field: 'general', s2State: 'temporarily_unhealthy' });
  assert.ok(!ids(unhealthy).some((x) => x.startsWith('semantic_scholar')));
  const rec = planBackends({ mode: 'recent', field: 'biomedical', s2State: 'disabled', window: { from: '2026-09-01', to: '2026-10-01' } });
  assert.ok(ids(rec).includes('biorxiv/keywords'), 'direct bioRxiv only for a narrow window');
  assert.ok(!ids(planBackends({ mode: 'recent', field: 'biomedical', window: { from: '2025-01-01' } })).includes('biorxiv/keywords'));
});

// ---- work families -----------------------------------------------------------------------------------------------------------
const rec = (f) => ({ ...candidate(f), _source: f._source ?? 'test' });
test('work-family grouping: one article from several databases is one family; version of record is canonical', () => {
  const fb = new FamilyBuilder();
  fb.add(rec({ doi: '10.1038/s41592-024-02424-1', pmid: '39327484', title: 'Strainy: phasing and assembly of strain haplotypes from long-read metagenome sequencing', year: 2024, _source: 'pubmed' }));
  fb.add(rec({ doi: '10.1038/s41592-024-02424-1', openalex: 'W4402874641', title: 'Strainy: phasing and assembly of strain haplotypes from long-read metagenome sequencing', cited_by: 40, _source: 'openalex' }));
  fb.add(rec({ doi: '10.1101/2023.01.31.526521', title: 'stRainy: assembly-based metagenomic strain phasing using long reads', year: 2023, _source: 'biorxiv' }));
  fb.link('doi:10.1101/2023.01.31.526521', 'doi:10.1038/s41592-024-02424-1', 'preprint_of', 'authoritative', 'bioRxiv API published DOI');
  const fams = fb.build();
  assert.equal(fams.length, 1);
  assert.equal(fams[0].members.length, 2, 'the two database records of the article merge into one member');
  assert.equal(fams[0].family_id, 'doi:10.1038/s41592-024-02424-1');
  assert.ok(fams[0].links.some((l) => l.relation === 'preprint_of' && l.confidence === 'authoritative'));
});
test('same-title records with different identifiers are not merged (Zenodo deposit, two journal records)', () => {
  const t = 'Strainy: phasing and assembly of strain haplotypes from long-read metagenome sequencing';
  const fb = new FamilyBuilder();
  fb.add(rec({ doi: '10.1038/s41592-024-02424-1', title: t, year: 2024 }));
  fb.add(rec({ doi: '10.5281/zenodo.123456', title: t, year: 2024, type: 'software' }));
  fb.add(rec({ doi: '10.9999/other.journal.1', title: t, year: 2024 }));
  const fams = fb.build();
  assert.equal(fams.length, 3);
  assert.ok(fams.some((f) => f.links.some((l) => l.relation === 'same_title_unverified')), 'the possible duplicate is reported');
});
test('preprint ↔ journal by exact title merges only as probable; identifier-less web records attach by title', () => {
  const t = 'Floria: fast and accurate strain haplotyping in metagenomes';
  const fb = new FamilyBuilder();
  fb.add(rec({ doi: '10.1093/bioinformatics/btae252', title: t, year: 2024 }));
  fb.add(rec({ doi: '10.1101/2024.01.28.577669', title: t, year: 2024 }));
  fb.add(rec({ url: 'https://example.org/floria', title: t }));
  const [f] = fb.build();
  assert.equal(f.members.length, 3);
  const l = f.links.find((x) => x.relation === 'preprint_of');
  assert.equal(l.confidence, 'probable');
  assert.equal(f.canonical.doi, '10.1093/bioinformatics/btae252');
  assert.equal(familyId(f.canonical), 'doi:10.1093/bioinformatics/btae252');
});
test('retraction and correction status of a family', () => {
  const st = familyStatus([{ title: 'RETRACTED: Stimulus-triggered fate conversion', is_retracted: true, retraction_notices: ['pmid:25008524'] }, { title: 'x', corrections: ['doi:10.1/err'] }]);
  assert.equal(st.retracted, true);
  assert.deepEqual(st.corrections, ['doi:10.1/err']);
  assert.deepEqual(st.retraction_notices, ['pmid:25008524']);
});

// ---- rank fusion and roles ---------------------------------------------------------------------------------------------------
test('rank fusion: one vote per backend, duplicates across formulations do not count twice', () => {
  const hits = new Map([['a', [{ channel: 'exa', rank: 1 }, { channel: 'exa', rank: 3 }, { channel: 'pubmed', rank: 2 }]], ['b', [{ channel: 'exa', rank: 2 }]], ['c', [{ channel: 'expansion:openalex:references', rank: 1 }]]]);
  const f = fuse(hits);
  assert.equal(f.get('a').channels, 2);
  assert.ok(f.get('a').score > f.get('b').score);
  assert.ok(f.get('c').score < f.get('b').score, 'expansion lists vote at half weight');
});
test('roles: seminal needs co-reference by anchors, not age or citations alone; capacity reserved per group', () => {
  const fams = [
    { family_id: 'old', title: 'A quiet paper on topic graphs', year: 1990, cited_by: 5000, fused: 0.001 },
    { family_id: 'sem', title: 'Medusa: Simple LLM inference acceleration with multiple decoding heads', year: 2024, cited_by: 300, fused: 0.001 },
    { family_id: 'rev', title: 'A survey of speculative decoding', year: 2024, cited_by: 40, fused: 0.02 },
    ...Array.from({ length: 30 }, (_, i) => ({ family_id: `r${i}`, title: `Faster decoding variant ${i}`, year: 2026, cited_by: 0, fused: 0.03 - i * 0.0001 })),
  ];
  assignRoles(fams, { nowYear: 2026, anchorRefs: new Map([['sem', 3]]), topic: new Set(['decodi', 'specul']) });
  assert.ok(fams.find((f) => f.family_id === 'sem').roles.includes('seminal'));
  assert.ok(!fams.find((f) => f.family_id === 'old').roles.includes('seminal'), 'highly cited but not co-referenced: not seminal');
  assert.ok(fams.find((f) => f.family_id === 'rev').roles.includes('review'));
  const sel = selectWithRoles(fams, { max: 10 });
  assert.ok(sel.selected.some((f) => f.family_id === 'sem'), 'the low-scoring seminal paper survives selection');
  assert.equal(sel.groups[0].id, 'foundational');
  assert.ok(sel.selected.length <= 10);
  assert.equal(introducesMethod({ title: 'HiCanu: accurate assembly of segmental duplications' }).name, 'HiCanu');
  assert.equal(introducesMethod({ title: 'Review: methods for assembly' }), null);
});

// ---- completeness validation and landing pages ---------------------------------------------------------------------------------
const body = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i} describes the experimental procedure in detail with measurements, controls and replicate counts for the strain assays.`).join('\n\n');
test('completeness: a full article is complete; a short partial is partial', () => {
  const full = `# Title\n\n## Introduction\n\n${body(30)}\n\n## Methods\n\n${body(60)}\n\n## Results\n\n${body(60)}\n\n## Discussion\n\n${body(30)}\n\n## References\n\n1. A ref (2020)`;
  assert.equal(validateRepresentation(full).state, 'complete');
  const partial = `## Introduction\n\n${body(20)}\n\n## Results\n\n${body(30)}`;
  assert.equal(validateRepresentation(partial).state, 'partial');
  assert.equal(validateRepresentation(full, { altChars: 200000 }).state, 'partial', 'much shorter than an alternate copy');
  assert.equal(validateRepresentation('').state, 'unavailable');
});
test('landing pages and false-complete patterns are rejected', () => {
  const hal = `# Deep learning\n\nHAL Id: hal-04206682 · Submitted on 12 Sep 2023\n\nAuthor links open overlay panel\nExport citation\nCite this article\n\n## Abstract\n\nDeep learning allows computational models...\n\n## References\n\n${Array.from({ length: 40 }, (_, i) => `${i}. Ref ${i} (2010)`).join('\n')}`;
  const v = validateRepresentation(hal, { claim: 'complete' });
  assert.equal(v.state, 'landing_page');
  assert.equal(v.claim, 'complete', 'the provider claim is recorded, not trusted');
  assert.equal(validateRepresentation('Please enable JavaScript. We use cookies to improve your experience. Accept all cookies.').state, 'landing_page');
  const absRefs = `## Abstract\n\n${body(5)}\n\n## References\n\n${body(10)}`;
  assert.equal(validateRepresentation(absRefs).state, 'landing_page');
});

// ---- documents, passages, section provenance ------------------------------------------------------------------------------
test('sections with offsets and paths; PMC sections; arXiv HTML to text keeps headings and math', () => {
  const t = '# Paper\n\n## Methods\n\n### Sample preparation\n\nCells were fixed.\n\n## Results\n\nWe saw things.';
  const s = sectionize(t);
  assert.deepEqual(s.map((x) => x.title), ['Paper', 'Methods', 'Sample preparation', 'Results']);
  assert.deepEqual(s[2].path, ['Paper', 'Methods', 'Sample preparation']);
  assert.equal(t.slice(s[1].start, s[1].start + 10), '## Methods');
  assert.ok(s[1].end <= s[3].start);
  const d = fromPmcSections({ title: 'T', abstract: 'A.', sections: [{ title: 'Methods', text: 'M text.' }, { title: 'Results', text: 'R text.' }] });
  assert.deepEqual(d.sections.map((x) => x.title), ['T', 'Abstract', 'Methods', 'Results']);
  const md = arxivHtmlToText('<article><h2 class="ltx_title">2 Method</h2><div class="ltx_para"><p>We use <math alttext="\\alpha+1"><mi>a</mi></math> here.</p></div><nav>menu</nav></article>');
  assert.match(md, /^## 2 Method/m);
  assert.match(md, /\$\\alpha\+1\$/);
  assert.doesNotMatch(md, /menu/);
});
test('passage index: BM25 passages carry section, subsection and offsets; references excluded; second pass', () => {
  const text = `# Strainy\n\n## Results\n\n### Benchmarking using mock communities\n\n${'Filler text about assemblies and coverage depth in many samples. '.repeat(3)}\n\nStrainy and metaFlye assemblies only had 2 and 3 strain switches, while Strainberry made 57 strain switches on the mock community.\n\n## Methods\n\nWe ran Strainberry with default parameters on the mock community reads and counted strain switches.\n\n## References\n\nStrainberry: automated strain separation (2021). Strain switches defined in ref.`;
  const doc = makeDocument(text, 'pmc_jats');
  const idx = buildIndex(doc);
  const r = retrieve(idx, 'How many strain switches did Strainberry make?', { k: 1 });
  const p = r.passages[0];
  assert.match(p.text, /57 strain switches/);
  assert.equal(p.section, 'Results');
  assert.equal(p.subsection, 'Benchmarking using mock communities');
  assert.equal(doc.text.slice(p.start, p.end), p.text, 'offsets point at the passage in the representation');
  assert.ok(!idx.items.some((x) => x.section === 'References'), 'reference lists are not evidence');
  const second = retrieve(idx, 'How many strain switches did Strainberry make?', { k: 1, exclude: [p.id] });
  assert.notEqual(second.passages[0].id, p.id);
  const flat = buildIndex(makeDocument(`${'no headings here at all, just a long paragraph of text. '.repeat(4)}`, 'pdf_text'));
  assert.equal(flat.items[0].section, null, 'no heading → section unavailable, never invented');
});
test('LaTeXML bibliography parsing', () => {
  const html = '<ul><li id="bib.bib4" class="ltx_bibitem"><span class="ltx_tag">Cai et al. (2024)</span> <span class="ltx_bibblock"> Tianle Cai, Yuhong Li. 2024. </span> <span class="ltx_bibblock"><a href="https://doi.org/10.48550/ARXIV.2401.10774" class="ltx_ref">Medusa: Simple LLM inference acceleration framework with multiple decoding heads</a>. </span> <span class="ltx_bibblock"><em>CoRR</em>, abs/2401.10774. </span></li>'
    + '<li class="ltx_bibitem"><span class="ltx_bibblock">F. Burton. 1985. </span> <span class="ltx_bibblock"><a href="https://doi.org/10.1109/TC.1985.6312218">Speculative computation, parallelism, and functional programming</a>. </span> <span class="ltx_bibblock">IEEE.</span></li></ul>';
  const b = parseLatexmlBibliography(html);
  assert.equal(b.length, 2);
  assert.deepEqual([b[0].arxiv, b[0].year], ['2401.10774', 2024]);
  assert.match(b[0].title, /^Medusa: Simple LLM/);
  assert.deepEqual([b[1].doi, b[1].year], ['10.1109/tc.1985.6312218', 1985]);
});

// ---- runtime: cache keys, timeouts, budget, classification ------------------------------------------------------------------
test('cache keys are stable and namespaced; failures are not cached', async () => {
  const c = createCache({ dir: null });
  assert.equal(c.key(['a', 1]), c.key(['a', 1]));
  assert.notEqual(c.key(['a', 1]), c.key(['a', 2]));
  const rt = memRt();
  let n = 0;
  const ok = () => rt.call({ backend: 'pubmed', op: 'x', args: { q: 1 }, exec: async () => { n++; return { data: { v: 1 } }; } });
  await ok(); const second = await ok();
  assert.equal(n, 1); assert.equal(second.cached, true);
  let m = 0;
  const bad = () => rt.call({ backend: 'europepmc', op: 'x', args: { q: 2 }, retries: 0, exec: async () => { m++; return { isError: true, text: 'boom' }; } });
  await bad(); await bad();
  assert.equal(m, 2, 'an error is retried on the next call, never served from cache');
});
test('hard timeout outside the provider; unhealthy backend is skipped; one retry for transient faults only', async () => {
  const rt = memRt();
  const r = await rt.call({ backend: 'semantic_scholar', op: 'search', args: {}, timeoutMs: 50, retries: 0, cacheNs: null, exec: () => new Promise(() => {}) });
  assert.equal(r.outcome, 'timeout');
  const again = await rt.call({ backend: 'semantic_scholar', op: 'search', args: { other: 1 }, cacheNs: null, exec: async () => ({ data: {} }) });
  assert.equal(again.outcome, 'skipped_unhealthy');
  let tries = 0;
  const tr = await rt.call({ backend: 'openalex', op: 't', args: {}, cacheNs: null, retries: 1, exec: async () => { tries++; return { isError: true, status: 503, text: 'HTTP 503' }; } });
  assert.equal(tries, 2); assert.equal(tr.outcome, 'transient');
  assert.equal(classify({ isError: true, text: 'Insufficient budget. Resets at midnight UTC', status: 429 }), 'budget_exhausted');
  assert.equal(classify({ isError: false, text: 'an abstract mentioning rate limit and 429' }), 'ok', 'words in a successful result are not a rate limit');
});
test('OpenAlex budget: exhaustion is remembered until midnight UTC and stops paid calls', async () => {
  const rt = memRt({ budgetUsd: 1 });
  const r = await rt.call({ backend: 'openalex', op: 'kw', args: {}, cacheNs: null, retries: 0, costUsd: 0.001, exec: async () => ({ isError: true, status: 429, text: 'Insufficient budget' }) });
  assert.equal(r.outcome, 'budget_exhausted');
  let called = false;
  const s = await rt.call({ backend: 'openalex', op: 'kw2', args: {}, cacheNs: null, costUsd: 0.001, exec: async () => { called = true; return { data: {} }; } });
  assert.equal(s.outcome, 'budget_exhausted'); assert.equal(called, false);
  assert.equal(rt.budget.status().exhausted, true);
});

// ---- pipelines on fake providers -------------------------------------------------------------------------------------------
function fakeProviders(over = {}) {
  const res = (items, extra = {}) => ({ outcome: items.length ? 'ok' : 'empty', items, sent: extra.sent ?? 'q', total: items.length, ms: 1, ...extra });
  const base = {
    exa: { mode: 'keyed', search: async ({ q }) => res([candidate({ rank: 1, title: 'Strainy: phasing and assembly of strain haplotypes from long-read metagenome sequencing', doi: '10.1038/s41592-024-02424-1', url: 'https://doi.org/10.1038/s41592-024-02424-1' })], { sent: q }) },
    openalex: {
      semantic: async ({ q }) => res([candidate({ rank: 1, title: 'Strainy: phasing and assembly of strain haplotypes from long-read metagenome sequencing', doi: '10.1038/s41592-024-02424-1', openalex: 'W1', cited_by: 40, year: 2024 })], { sent: q }),
      keyword: async ({ q }) => ({ outcome: 'budget_exhausted', items: [], sent: q, error: 'OpenAlex daily budget' }),
      batch: async () => ({ outcome: 'ok', items: [], calls: [] }),
      get: async () => ({ outcome: 'not_found', item: null }),
      titleSearch: async () => res([]), references: async () => res([]), citing: async () => res([]),
    },
    pubmed: { search: async ({ q }) => res([candidate({ rank: 1, title: 'stRainy: assembly-based metagenomic strain phasing using long reads', doi: '10.1101/2023.01.31.526521', pmid: '1', is_preprint: true })], { sent: q }), related: async () => res([]) },
    europepmc: { search: async () => res([]) },
    arxiv: { search: async () => res([]), bibliography: async () => res([]) },
    biorxiv: { search: async () => res([]) },
    searxng: { search: async () => ({ outcome: 'error', items: [], error: 'connect ECONNREFUSED 127.0.0.1:9' }) },
    semantic_scholar: { state: () => 'enabled_keyless', search: async () => ({ outcome: 'rate_limited', items: [], error: '429' }) },
  };
  return { ...base, ...over };
}
test('coverage report: failed backends are distinguished from searches that found nothing; one failure does not abort', async () => {
  const env = { p: fakeProviders(), rt: memRt(), config: {} };
  const r = await literatureSearch(env, { query: 'strain-resolved metagenomic profiling from long reads', mode: 'comprehensive' });
  assert.equal(r.status, 'ok');
  const c = r.coverage;
  assert.ok(c.backends_failed.some((f) => f.backend === 'openalex_keyword' && f.reason === 'budget_exhausted'));
  assert.ok(c.backends_failed.some((f) => f.backend === 'searxng' && f.reason === 'error'));
  assert.ok(c.backends_failed.some((f) => f.backend === 'semantic_scholar' && f.reason === 'rate_limited'));
  assert.ok(c.searches_with_zero_results.some((s) => s.startsWith('europepmc')), 'searched-and-found-nothing is listed separately');
  assert.ok(c.coverage_notes.some((n) => /budget exhausted/.test(n)));
  assert.ok(c.queries_executed.every((q) => 'sent' in q), 'every executed query is recorded with what was sent');
  assert.ok(r.results.length >= 1);
  assert.equal(r.results.filter((f) => f.title?.startsWith('Strainy')).length, 1, 'the article seen by Exa and OpenAlex is one family');
  const s = absenceStatement({ ...c }, 'q');
  assert.match(s, /No matching work was found after these searches/);
  assert.match(s, /Did not run successfully: .*searxng/);
});
test('identifier queries are resolved, not searched', async () => {
  const env = { p: fakeProviders({ arxiv: { metadata: async () => ({ outcome: 'ok', data: { papers: [{ id: '2106.09685v2', title: 'LoRA: Low-Rank Adaptation of Large Language Models', published: '2021-06-17' }] } }) } }), rt: memRt(), config: {} };
  env.p.openalex.get = async () => ({ outcome: 'ok', item: candidate({ title: 'LoRA Fine-Tuning of a 3B Code LLM for Algorithmic Efficiency', openalex: 'W3168867926', doi: '10.48550/arxiv.2106.09685' }) });
  const r = await literatureSearch(env, { query: 'arxiv:2106.09685' });
  assert.equal(r.mode, 'identifier_lookup');
});
test('paper_resolve: arXiv is authoritative; a mis-titled OpenAlex record is a reported conflict, not a merge', async () => {
  const p = fakeProviders({ arxiv: { metadata: async () => ({ outcome: 'ok', backend: 'arxiv', op: 'metadata', data: { papers: [{ id: '2106.09685v2', title: 'LoRA: Low-Rank Adaptation of Large Language Models', published: '2021-06-17' }] } }) } });
  p.openalex.get = async () => ({ outcome: 'ok', backend: 'openalex', op: 'get', item: candidate({ title: 'LoRA Fine-Tuning of a 3B Code LLM for Algorithmic Efficiency', openalex: 'W3168867926', doi: '10.48550/arxiv.2106.09685' }) });
  const r = await paperResolve({ p, rt: memRt(), config: {} }, 'arxiv:2106.09685');
  assert.equal(r.status, 'ok');
  assert.equal(r.authority, 'arxiv');
  assert.equal(r.family.canonical.title, 'LoRA: Low-Rank Adaptation of Large Language Models');
  assert.equal(r.confidence, 'conflict');
  assert.equal(r.conflicts[0].id, 'W3168867926');
  assert.ok(!r.family.members.some((m) => m.openalex === 'W3168867926'), 'the conflicting OpenAlex id is not attached');
});
test('paper_resolve: bioRxiv published DOI is an authoritative preprint_of link; PubMed retraction is flagged', async () => {
  const p = fakeProviders({
    biorxiv: { preprint: async () => ({ outcome: 'ok', data: { preprints: [{ doi: '10.1101/2023.01.31.526521', revisions: [{ version: '1', date: '2023-02-03', title: 'stRainy v1' }, { version: '2', date: '2023-05-01', title: 'stRainy: assembly-based metagenomic strain phasing using long reads' }] }] } }),
      published: async () => ({ outcome: 'ok', data: { publishedDoi: '10.1038/s41592-024-02424-1', publishedJournal: 'Nature Methods' } }) },
  });
  p.openalex.get = async ({ id }) => (id === 'doi:10.1038/s41592-024-02424-1' ? { outcome: 'ok', item: candidate({ title: 'Strainy: phasing and assembly of strain haplotypes from long-read metagenome sequencing', doi: '10.1038/s41592-024-02424-1', openalex: 'W2', year: 2024 }) } : { outcome: 'not_found', item: null });
  const r = await paperResolve({ p, rt: memRt(), config: {} }, '10.1101/2023.01.31.526521');
  assert.equal(r.family.family_id, 'doi:10.1038/s41592-024-02424-1', 'the version of record is canonical');
  assert.ok(r.family.links.some((l) => l.relation === 'preprint_of' && l.confidence === 'authoritative'));
  assert.equal(r.family.versions.length, 2);
  const pm = fakeProviders({ pubmed: { fetch: async () => ({ outcome: 'ok', data: { articles: [{ pmid: '24476887', title: 'Stimulus-triggered fate conversion of somatic cells into pluripotency', doi: '10.1038/nature12968', publicationTypes: ['Journal Article', 'Retracted Publication'], commentsCorrections: [{ refType: 'RetractionIn', pmid: '25008524' }, { refType: 'ErratumIn', pmid: '24999999' }] }] } }) } });
  pm.openalex.get = async () => ({ outcome: 'not_found', item: null });
  const r2 = await paperResolve({ p: pm, rt: memRt(), config: {} }, 'pmid:24476887', { lineage: false });
  assert.equal(r2.family.retracted, true);
  assert.deepEqual(r2.family.corrections, ['pmid:24999999']);
  assert.ok(r2.family.links.some((l) => l.relation === 'retracted_by'));
});
test('paper_get acquisition: Unpaywall landing page rejected, chain continues, FULLTEXT_UNAVAILABLE lists every tier', async () => {
  const landing = `# Deep learning\n\nHAL Id: hal-04206682 · Submitted on 12 Sep 2023\nExport citation\nCite this article\n\n## Abstract\n\nShort abstract.`;
  const p = fakeProviders({
    pubmed: { fulltext: async () => ({ outcome: 'ok', data: { articles: [{ viaSource: 'unpaywall', contentFormat: 'html-markdown', content: landing, sourceUrl: 'https://hal.science/hal-04206682' }] } }) },
    web: { pdf: async () => ({ outcome: 'error', error: 'HTTP 403' }), page: async () => ({ outcome: 'error', error: 'HTTP 403' }) },
  });
  p.openalex.content = async () => ({ outcome: 'empty', data: { status: 'FULLTEXT_UNAVAILABLE' } });
  const fam = { family_id: 'doi:10.1038/nature14539', members: [{ doi: '10.1038/nature14539', pmid: '26017442', openalex: 'W1', has_content: {}, is_preprint: false, locations: [{ is_oa: true, pdf: 'https://repo.example.org/deep.pdf', source: 'Repo', source_type: 'repository' }] }] };
  const r = await acquire({ p, rt: memRt() }, fam, {});
  assert.equal(r.status, 'FULLTEXT_UNAVAILABLE');
  const up = r.tiers.find((t) => t.source === 'unpaywall');
  assert.equal(up.outcome, 'landing_page');
  assert.ok(up.reasons.length);
  assert.ok(r.tiers.some((t) => t.tier === 5 && t.outcome === 'error'), 'the repository copy OpenAlex lists was tried');
  assert.ok(r.tiers.every((t) => t.tier && t.outcome));
  assert.equal(r.temporary, true, 'the repository copy failed with an error, so the unavailability is reported as temporary');
});
test('paper_get acquisition: without a contact address the Unpaywall tier is reported as skipped, with the reason', async () => {
  const mk = (unpaywall) => {
    const p = fakeProviders({
      pubmed: { fulltext: async () => ({ outcome: 'ok', data: { articles: [] } }) },
      web: { pdf: async () => ({ outcome: 'empty', data: { notPdf: true } }), page: async () => ({ outcome: 'empty' }) },
    });
    p.keys = { unpaywall };
    p.openalex.content = async () => ({ outcome: 'empty', data: { status: 'FULLTEXT_UNAVAILABLE' } });
    return p;
  };
  const fam = { family_id: 'doi:10.1000/x', members: [{ doi: '10.1000/x', openalex: 'W1', has_content: {}, is_preprint: false }] };
  const off = await acquire({ p: mk(false), rt: memRt() }, fam, {});
  assert.equal(off.status, 'FULLTEXT_UNAVAILABLE');
  const up = off.tiers.filter((t) => t.source === 'unpaywall');
  assert.equal(up.length, 1);
  assert.equal(up[0].outcome, 'skipped');
  assert.match(up[0].reasons[0], /^Unpaywall skipped: no email set .*RESEARCH_EMAIL/);
  assert.match(formatGet({ status: 'FULLTEXT_UNAVAILABLE', paper: { title: 't', identifiers: {} }, fulltext: { tiers_tried: off.tiers } }), /4:unpaywall=skipped \(Unpaywall skipped: no email set/);
  const on = await acquire({ p: mk(true), rt: memRt() }, fam, {});
  assert.ok(!on.tiers.some((t) => t.source === 'unpaywall'), 'with an address configured nothing is added');
});
test('cancelled acquisition is temporary and never becomes a week-long negative cache entry', async () => {
  const rt = memRt(); let calls = 0;
  const p = fakeProviders({ pubmed: { fulltext: async () => { calls++; return { outcome: 'cancelled', error: 'caller cancelled' }; } } });
  const family = { family_id: 'doi:10.1/cancelled-fixture', members: [{ doi: '10.1/cancelled-fixture', is_preprint: false }] };
  const first = await acquire({ p, rt }, family, {});
  assert.equal(first.status, 'FULLTEXT_UNAVAILABLE');
  assert.equal(first.temporary, true);
  assert.notEqual((await acquire({ p, rt }, family, {})).cached, true);
  assert.equal(calls, 2);
});

test('temporary unavailability is not cached; permanent unavailability is', async () => {
  const rt = memRt();
  const p = fakeProviders({ pubmed: { fulltext: async () => ({ outcome: 'ok', data: { articles: [], unavailable: [{ reason: 'no-oa' }] } }) }, web: { pdf: async () => ({ outcome: 'error' }), page: async () => ({ outcome: 'error' }) } });
  p.openalex.content = async () => ({ outcome: 'empty', data: { status: 'FULLTEXT_UNAVAILABLE' } });
  const closed = { family_id: 'doi:10.1/closed', members: [{ doi: '10.1/closed', has_content: {}, is_preprint: false }] };
  const a = await acquire({ p, rt }, closed, {});
  assert.equal(a.status, 'FULLTEXT_UNAVAILABLE'); assert.equal(a.temporary, false);
  assert.equal((await acquire({ p, rt }, closed, {})).cached, true, 'a permanent unavailability is cached');
  const p2 = fakeProviders({ biorxiv: { fulltext: async () => ({ outcome: 'error', error: 'HTTP 500' }) } });
  const pre = { family_id: 'doi:10.1101/2025.01.01.000001', members: [{ doi: '10.1101/2025.01.01.000001', is_preprint: true }] };
  const b = await acquire({ p: p2, rt }, pre, {});
  assert.equal(b.temporary, true);
  assert.notEqual((await acquire({ p: p2, rt }, pre, {})).cached, true, 'a temporary one is not');
});
