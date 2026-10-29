#!/usr/bin/env node
// Literature broker integration suite: the four tools against the live services, through the same
// providers Pi uses. Reports PASS / FAIL with the evidence seen. Writes broker-integration-<date>.{md,json} to
// --out DIR (default .mina/literature, git-ignored).
// Usage: node literature/broker-integration.mjs [--out DIR] [S1 R4 F2 ...]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBroker } from './broker/index.mjs';
import { reportArgs } from './report-out.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { out, only } = reportArgs(process.argv.slice(2), repo);
const b = createBroker();
const results = [];
const has = (arr, pred) => (arr ?? []).some(pred);
async function check(id, title, fn) {
  if (only.length && !only.includes(id)) return;
  const t0 = Date.now();
  let status = 'FAIL'; let evidence = {};
  try { const r = await fn(); status = r.ok ? 'PASS' : 'FAIL'; evidence = r.evidence; } catch (e) { evidence = { error: e.message }; }
  results.push({ id, title, status, ms: Date.now() - t0, evidence });
  process.stdout.write(`${status.padEnd(4)} ${id} ${title} (${Date.now() - t0} ms)\n${Object.entries(evidence).map(([k, v]) => `       ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')}\n`);
}
const ids = (f) => JSON.stringify(f.ids ?? {}).toLowerCase();

// ---- search -------------------------------------------------------------------------------------------------------------
await check('S1', 'biomedical standard search', async () => {
  const r = await b.literature_search({ query: 'GLP-1 receptor agonists for alcohol use disorder', mode: 'standard' });
  return { ok: r.status === 'ok' && r.results.length >= 5 && r.coverage.backends_succeeded.includes('pubmed') && r.field === 'biomedical',
    evidence: { field: r.field, returned: r.results.length, succeeded: r.coverage.backends_succeeded, failed: r.coverage.backends_failed.map((f) => `${f.backend}:${f.reason}`), top: r.results.slice(0, 3).map((f) => f.title) } };
});
await check('S2', 'ML/CS standard search (arXiv routed)', async () => {
  const r = await b.literature_search({ query: 'speculative decoding for large language model inference', mode: 'standard' });
  return { ok: r.status === 'ok' && r.field === 'ml_cs' && r.coverage.backends_succeeded.includes('arxiv') && r.coverage.queries_executed.some((q) => q.backend === 'arxiv' && /all:/.test(q.sent ?? '')),
    evidence: { field: r.field, returned: r.results.length, arxiv_query: r.coverage.queries_executed.find((q) => q.backend === 'arxiv')?.sent, top: r.results.slice(0, 3).map((f) => f.title) } };
});
await check('S3', 'landscape: seminal methods kept in the foundational group', async () => {
  const r = await b.literature_search({ query: 'What are the strongest speculative decoding methods for large language model inference, and how large are their reported speedups?', mode: 'landscape' });
  const fnd = r.groups?.find((g) => g.id === 'foundational')?.families ?? [];
  const fam = r.results.filter((f) => fnd.includes(f.family_id));
  const want = ['2211.17192', '2302.01318', '2401.10774', '2401.15077'];
  const got = want.filter((a) => fam.some((f) => ids(f).includes(a)));
  return { ok: r.coverage.citation_expansion && got.length >= 3, evidence: { foundational: fam.map((f) => `${f.year} ${f.title}`.slice(0, 80)), seminal_found: `${got.length}/4`, expansion: r.coverage.expansion?.counts } };
});
await check('S4', 'recent search: date window enforced', async () => {
  const r = await b.literature_search({ query: 'GLP-1 receptor agonist alcohol use disorder', mode: 'recent', date_from: '2025-10-01' });
  const old = r.results.filter((f) => f.year && f.year < 2025);
  return { ok: r.status === 'ok' && r.results.length > 0 && old.length === 0, evidence: { returned: r.results.length, years: [...new Set(r.results.map((f) => f.year))], europepmc: r.coverage.backends_succeeded.includes('europepmc'), not_routed: r.coverage.backends_not_routed.map((x) => x.backend) } };
});
await check('S5', 'novelty search: formulations, expansion, absence statement', async () => {
  const r = await b.literature_search({ query: 'Has CRISPR-Cas9 off-target editing been detected genome-wide without a reference genome?', mode: 'novelty' });
  const forms = new Set(r.coverage.queries_executed.map((q) => q.formulation));
  return { ok: r.status === 'ok' && forms.size >= 3 && r.coverage.citation_expansion && /No matching work was found after these searches/.test(r.coverage.absence_statement ?? ''),
    evidence: { formulations: [...forms], backends: r.coverage.backends_succeeded, failed: r.coverage.backends_failed.map((f) => `${f.backend}:${f.reason}`), absence: (r.coverage.absence_statement ?? '').slice(0, 200), guide_seq_2015: r.results.some((f) => ids(f).includes('10.1038/nbt.3117')) } };
});

// ---- resolution -------------------------------------------------------------------------------------------------------------
const famHas = (r, x) => JSON.stringify(r.family?.members ?? []).toLowerCase().includes(x.toLowerCase());
await check('R1', 'DOI → family with its preprint', async () => {
  const r = await b.paper_resolve({ ref: '10.1038/s41592-024-02424-1' });
  return { ok: r.status === 'ok' && famHas(r, '10.1101/2023.01.31.526521'), evidence: { family: r.family?.family_id, versions: r.family?.versions?.map((v) => `${v.kind}:${Object.values(v.ids).join('|')}`), links: r.family?.links?.filter((l) => l.relation === 'preprint_of').map((l) => l.confidence) } };
});
await check('R2', 'PMID', async () => {
  const r = await b.paper_resolve({ ref: 'pmid:27572649' });
  return { ok: r.status === 'ok' && famHas(r, '10.1038/nmicrobiol.2016.51') && r.authority === 'pubmed', evidence: { family: r.family?.family_id, authority: r.authority, title: r.family?.canonical?.title } };
});
await check('R3', 'PMCID', async () => {
  const r = await b.paper_resolve({ ref: 'PMC4932909' });
  return { ok: r.status === 'ok' && famHas(r, '27572649'), evidence: { family: r.family?.family_id, authority: r.authority } };
});
await check('R4', 'arXiv id: arXiv authoritative, mis-titled OpenAlex record flagged', async () => {
  const r = await b.paper_resolve({ ref: 'arxiv:2106.09685' });
  return { ok: r.status === 'ok' && r.family?.canonical?.title === 'LoRA: Low-Rank Adaptation of Large Language Models' && r.conflicts?.length > 0, evidence: { title: r.family?.canonical?.title, confidence: r.confidence, conflicts: r.conflicts?.map((c) => `${c.id}: ${c.their_title}`) } };
});
await check('R5', 'bioRxiv DOI: versions and published version', async () => {
  const r = await b.paper_resolve({ ref: '10.1101/2024.02.13.580067' });
  const pre = r.family?.members?.find((m) => m.preprint_versions);
  return { ok: r.status === 'ok' && famHas(r, '10.24072/pcjournal.481') && (pre?.preprint_versions?.length ?? 0) >= 2, evidence: { family: r.family?.family_id, preprint_versions: pre?.preprint_versions?.length, links: r.family?.links?.map((l) => `${l.relation}:${l.confidence}`) } };
});
await check('R6', 'medRxiv preprint → publication pair', async () => {
  const r = await b.paper_resolve({ ref: '10.1101/2020.04.14.20062463' });
  return { ok: r.status === 'ok' && famHas(r, '10.1093/ije/dyab010') && r.family.family_id === 'doi:10.1093/ije/dyab010', evidence: { family: r.family?.family_id, links: r.family?.links?.map((l) => `${l.relation}:${l.confidence}:${l.evidence}`) } };
});
await check('R7', 'retracted paper flagged', async () => {
  const r = await b.paper_resolve({ ref: '10.1038/nature12968' });
  return { ok: r.status === 'ok' && r.family?.retracted === true, evidence: { retracted: r.family?.retracted, notices: r.family?.retraction_notices, title: r.family?.canonical?.title } };
});
await check('R8', 'corrected paper linked to its correction', async () => {
  const r = await b.paper_resolve({ ref: '10.1038/s41579-025-01211-9' });
  return { ok: r.status === 'ok' && (r.family?.corrections ?? []).some((c) => /40883419|s41579-025-01238-y/.test(c)), evidence: { corrections: r.family?.corrections, links: r.family?.links?.filter((l) => l.relation === 'corrected_by') } };
});

// ---- full text ----------------------------------------------------------------------------------------------------------------
const passageOk = (r) => (r.passages ?? []).length > 0 && r.passages.every((p) => Number.isInteger(p.offset_start) && p.representation && p.version);
await check('F1', 'PMC JATS evidence with section provenance', async () => {
  const r = await b.paper_get({ ref: '10.1038/s41592-024-02424-1', query: 'How many strain switches did Strainy and Strainberry make on the mock community?' });
  return { ok: r.source?.representation === 'pmc_jats' && passageOk(r) && r.passages.some((p) => /strain switch/i.test(p.text) && p.section), evidence: { source: r.source, passages: r.passages?.map((p) => `${p.section} › ${p.subsection ?? ''} @${p.offset_start}`).slice(0, 4), chars: r.passages?.reduce((s, p) => s + p.text.length, 0) } };
});
await check('F2', 'arXiv: clean HTML text, not raw markup', async () => {
  const r = await b.paper_get({ ref: 'arxiv:2106.09685', query: 'What rank r did LoRA use for GPT-3 175B?' });
  return { ok: /arxiv_html_text|ar5iv|arxiv_read_paper/.test(r.source?.representation ?? r.source?.source ?? '') && passageOk(r) && !r.passages.some((p) => /<\/?(div|span|p)\b/.test(p.text)), evidence: { source: r.source, sections: r.passages?.map((p) => p.section).slice(0, 4) } };
});
await check('F3', 'bioRxiv preprint text', async () => {
  const r = await b.paper_get({ ref: '10.1101/2024.11.20.624313', query: 'Which strain-resolution tools were benchmarked?' });
  return { ok: r.source?.representation === 'biorxiv_page' && passageOk(r), evidence: { source: r.source, tiers: r.fulltext?.tiers_tried?.map((t) => `${t.tier}:${t.representation}:${t.outcome}`) } };
});
await check('F4', 'OpenAlex-hosted PDF text (no PMC, no preprint)', async () => {
  const r = await b.paper_get({ ref: '10.1186/s40537-019-0197-0', query: 'Which geometric transformations are used for image data augmentation?' });
  return { ok: r.source?.representation === 'openalex_pdf_text' && passageOk(r), evidence: { source: r.source, tiers: r.fulltext?.tiers_tried?.map((t) => `${t.tier}:${t.representation}:${t.outcome}`) } };
});
await check('F8', 'version of record without open text: the preprint is read and labelled as the preprint', async () => {
  const r = await b.paper_get({ ref: '10.1093/bioinformatics/bty191', query: 'How does minimap2 chain anchors?' });
  return { ok: /arxiv_html_text|ar5iv/.test(r.source?.representation ?? '') && /preprint/.test(r.source?.version ?? '') && passageOk(r), evidence: { source: r.source, tiers: r.fulltext?.tiers_tried?.map((t) => `${t.tier}:${t.representation}:${t.outcome}`) } };
});
await check('F5', 'Unpaywall fallback (validated)', async () => {
  const r = await b.paper_get({ ref: '10.21105/joss.00027', depth: 'full' });
  return { ok: r.status === 'ok' && /unpaywall|oa_location|openalex/.test(r.source?.representation ?? ''), evidence: { source: r.source, completeness_reasons: r.fulltext?.completeness_reasons, tiers: r.fulltext?.tiers_tried?.map((t) => `${t.tier}:${t.representation}:${t.outcome}`) } };
});
await check('F6', 'FULLTEXT_UNAVAILABLE with every tier tried', async () => {
  const r = await b.paper_get({ ref: '10.1126/science.1127344', query: 'fixation protocol' });
  return { ok: r.status === 'FULLTEXT_UNAVAILABLE' && (r.fulltext?.tiers_tried ?? []).length > 0 && Boolean(r.paper?.abstract), evidence: { status: r.status, tiers: r.fulltext?.tiers_tried?.map((t) => `${t.tier}:${t.representation ?? t.source}:${t.outcome}`) } };
});
await check('F7', 'false-complete landing page rejected (HAL record page from Unpaywall)', async () => {
  const r = await b.paper_get({ ref: '10.1038/nature14539', query: 'deep learning backpropagation' });
  const rej = (r.fulltext?.tiers_tried ?? []).filter((t) => t.outcome === 'landing_page');
  return { ok: rej.length > 0 && r.source?.completeness !== 'landing_page', evidence: { status: r.status, rejected: rej.map((t) => `${t.representation}: ${t.reasons?.join('; ')}`) } };
});

await b.close();
const date = new Date().toISOString().slice(0, 10);
const pass = results.filter((r) => r.status === 'PASS').length;
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `broker-integration-${date}.json`), `${JSON.stringify({ date, pass, total: results.length, results }, null, 2)}\n`);
writeFileSync(join(out, `broker-integration-${date}.md`), `# Literature broker integration, ${date}\n\n${pass}/${results.length} passed. Generated by \`node literature/broker-integration.mjs\`.\n\n| Id | Check | Result | ms |\n| --- | --- | --- | --- |\n${results.map((r) => `| ${r.id} | ${r.title} | ${r.status} | ${r.ms} |`).join('\n')}\n\nEvidence per check: the JSON file next to this one.\n`);
process.stdout.write(`\n${pass}/${results.length} passed\nreport: ${join(out, `broker-integration-${date}.md`)}\n`);
process.exit(0);
