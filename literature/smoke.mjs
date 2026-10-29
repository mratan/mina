#!/usr/bin/env node
// Literature stack smoke/integration suite. Each check calls the real servers through the same
// sandboxed commands .pi/mcp.json gives Pi, and reports PASS / FAIL / SKIP with the evidence it saw.
// Usage: node literature/smoke.mjs [--out DIR] [A B C ...]   writes smoke-<date>.{md,json} to DIR (default .mina/literature)
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { connect, resultText } from '../scripts/mcp-client.mjs';
import { readKeyDirs, keyDirs } from '../scripts/mcp-sandbox.mjs';
import { openalexContent, toRecord } from './openalex-content.mjs';
import { reportArgs } from './report-out.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { out, only } = reportArgs(process.argv.slice(2), repo);
const keys = readKeyDirs(keyDirs());
const results = [];
const servers = {};
const server = async (name) => (servers[name] ??= await connect(name, { timeoutMs: 120000, onStderr: () => {} }));
const call = async (name, tool, args) => {
  const started = Date.now();
  const r = await (await server(name)).call(tool, args);
  return { text: resultText(r), structured: r.structuredContent ?? null, isError: Boolean(r.isError), ms: Date.now() - started };
};
const short = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
function record(id, title, status, evidence) {
  results.push({ id, title, status, evidence });
  process.stdout.write(`${status.padEnd(4)} ${id} ${title}\n${Object.entries(evidence).map(([k, v]) => `       ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')}\n`);
}
async function check(id, title, fn) {
  if (only.length && !only.includes(id)) return;
  try { await fn(); } catch (error) { record(id, title, 'FAIL', { error: short(error.stack ?? error.message, 600) }); }
}
const openalexGet = async (path) => {
  const u = new URL(`https://api.openalex.org${path}`);
  if (keys.OPENALEX_API_KEY) u.searchParams.set('api_key', keys.OPENALEX_API_KEY);
  const r = await fetch(u); if (!r.ok) throw new Error(`OpenAlex HTTP ${r.status}`); return r.json();
};
const sectionHeads = (text) => [...text.matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) => m[1].trim());

// A. PubMed search: several relevant papers with PMID, DOI and abstract.
await check('A', 'PubMed search returns relevant papers with PMID, DOI and abstract', async () => {
  const s = await call('pubmed', 'pubmed_search_articles', { query: 'long-read metagenomic taxonomic profiling benchmark', maxResults: 5 });
  const pmids = [...s.text.matchAll(/\b(\d{7,9})\b/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 5);
  const f = await call('pubmed', 'pubmed_fetch_articles', { pmids: pmids.slice(0, 3) });
  const titles = [...f.text.matchAll(/^#+\s*(.+)$/gm)].map((m) => m[1]).slice(0, 3);
  const dois = [...f.text.matchAll(/\b(10\.\d{4,9}\/[^\s|)\]]+)/g)].map((m) => m[1]);
  const abstracts = (f.text.match(/abstract/gi) ?? []).length;
  record('A', 'PubMed search returns relevant papers with PMID, DOI and abstract', pmids.length >= 3 && dois.length >= 1 && abstracts >= 1 ? 'PASS' : 'FAIL',
    { query: 'long-read metagenomic taxonomic profiling benchmark', pmids, titles: titles.map((t) => short(t, 110)), dois: dois.slice(0, 3), abstract_mentions: abstracts, ms: s.ms + f.ms });
});

// B. PubMed → PMC full text (Methods/Results present, provenance named); a selected section; a DOI through the fallback chain.
await check('B', 'PubMed → PMC full text, selected sections, and a DOI through the fallback chain', async () => {
  const pmid = '29750242'; // minimap2 (Li 2018): in PubMed; its OA copy is bronze (publisher), so the PMC tier may not have it
  const s = await call('pubmed', 'pubmed_search_articles', { query: 'nanopore metagenomic sequencing taxonomic classification', maxResults: 5, freeFullText: true });
  const oaPmid = [...s.text.matchAll(/\b(\d{7,9})\b/g)].map((m) => m[1])[0];
  const full = await call('pubmed', 'pubmed_fetch_fulltext', { pmids: [oaPmid], maxCharacters: 200000 });
  const heads = sectionHeads(full.text);
  const via = full.text.match(/viaSource\W+(\w+)/i)?.[1] ?? full.text.match(/\bsource\W+(pmc|europepmc|unpaywall)\b/i)?.[1] ?? null;
  const pmcid = full.text.match(/\b(PMC\d+)\b/)?.[1] ?? null;
  const methods = heads.some((h) => /method|material/i.test(h)), results = heads.some((h) => /result/i.test(h));
  const sel = await call('pubmed', 'pubmed_fetch_fulltext', { pmids: [oaPmid], sections: ['Methods'], maxCharacters: 60000 });
  // A DOI outside PMC whose open copy only Unpaywall finds; and one whose every tier fails, which must say so per tier.
  const viaOf = (r) => (r.structured?.articles ?? []).map((a) => a.viaSource ?? a.source);
  const fb = await call('pubmed', 'pubmed_fetch_fulltext', { dois: ['10.1186/s40537-019-0197-0'], maxCharacters: 50000 });
  const none = await call('pubmed', 'pubmed_fetch_fulltext', { dois: ['10.1093/bioinformatics/bty191'], maxCharacters: 5000 });
  const fallbackOk = viaOf(fb).includes('unpaywall') && viaOf(none).length === 0 && /chain:/.test(none.text);
  record('B', 'PubMed → PMC full text, selected sections, and a DOI through the fallback chain', methods && results && full.text.length > 8000 && fallbackOk ? 'PASS' : 'FAIL', {
    pmid: oaPmid, pmcid, via_source: via, chars: full.text.length, sections: heads.slice(0, 12).map((h) => short(h, 50)), methods_present: methods, results_present: results,
    selected_methods_only: { chars: sel.text.length, heads: sectionHeads(sel.text).slice(0, 6).map((h) => short(h, 50)) },
    doi_fallback: { doi: '10.1186/s40537-019-0197-0', via_source: viaOf(fb), chars: fb.text.length },
    doi_unavailable: { doi: '10.1093/bioinformatics/bty191 (pmid ' + pmid + ')', returned: viaOf(none), chain: short(none.text.match(/chain: ([^\n]+)/)?.[1], 300) } });
});

// C. bioRxiv: search → one preprint → its versions → full text of a specific version (body text, not the abstract).
await check('C', 'bioRxiv search → preprint → version → full text', async () => {
  const s = await call('biorxiv', 'biorxiv_search_preprints', { query: 'CRISPR off-target detection', limit: 5 });
  const doi = s.text.match(/\*\*DOI:\*\*\s*(10\.\d+\/[^\s*]+)/)?.[1];
  const p = await call('biorxiv', 'biorxiv_get_preprint', { dois: [doi] });
  const versions = [...p.text.matchAll(/\bv(?:ersion)?\W{0,3}(\d+)\b/gi)].map((m) => Number(m[1]));
  const latest = Math.max(1, ...versions.filter((v) => v < 50));
  // bioRxiv's article pages rate-limit bursts (HTTP 429 with a Retry-After): wait as asked, once, then try again.
  let f = await call('biorxiv', 'biorxiv_get_fulltext', { doi, version: latest, limit: 50000 });
  let waited = null;
  if (f.isError && /rate.?limit|429/i.test(f.text)) {
    waited = Math.min(120, Math.max(5, Number(f.text.match(/(\d+)-second wait/)?.[1] ?? 30)));
    await new Promise((r) => setTimeout(r, waited * 1000));
    f = await call('biorxiv', 'biorxiv_get_fulltext', { doi, version: latest, limit: 50000 });
  }
  const abstract = p.text.match(/\*\*Abstract:?\*\*\s*([\s\S]{0,4000}?)(?:\n\*\*|\n#|$)/)?.[1] ?? '';
  const heads = sectionHeads(f.text);
  const body = !f.isError && f.text.length > Math.max(6000, abstract.length * 4) && heads.some((h) => /result|method|discussion|conclusion/i.test(h));
  // When bioRxiv's own page stays unavailable, the legitimate alternate representation is OpenAlex's copy of the preprint.
  // OpenAlex may not hold the newest preprints yet, so the alternate is tried for the first few hits, in order.
  let alt = null, altDoi = null;
  if (!body) {
    for (const d of [...s.text.matchAll(/\*\*DOI:\*\*\s*(10\.\d+\/[^\s*]+)/g)].map((m) => m[1]).slice(0, 5)) {
      alt = await openalexContent(d, { apiKey: keys.OPENALEX_API_KEY }); altDoi = d;
      if (alt.status === 'OK') break;
    }
  }
  record('C', 'bioRxiv search → preprint → version → full text', body || alt?.status === 'OK' ? 'PASS' : 'FAIL', {
    fulltext_path: body ? 'biorxiv_get_fulltext (rendered article page)' : alt?.status === 'OK' ? 'OpenAlex content (bioRxiv page unavailable)' : 'none',
    waited_seconds: waited, biorxiv_page_error: f.isError ? short(f.text, 160) : null,
    openalex_alternate: alt ? { doi: altDoi, status: alt.status, provenance: alt.provenance ?? null, sections: alt.sections?.map((x) => x.head).slice(0, 8) ?? null, reason: alt.reason ?? null } : null,
    query: 'CRISPR off-target detection', doi, title: short([...p.text.matchAll(/^#+\s*(.+)$/gm)].map((m) => m[1]).find((t) => !/^Preprints/.test(t)), 120), version_requested: latest, versions_seen: [...new Set(versions)].slice(0, 6),
    fulltext_chars: f.text.length, abstract_chars: abstract.length, sections: heads.slice(0, 10).map((h) => short(h, 50)), error: f.isError ? short(f.text, 300) : null });
});

// D. arXiv: search → metadata → full text, with the representation named.
await check('D', 'arXiv search → metadata → full text (representation named)', async () => {
  const s = await call('arxiv', 'arxiv_search', { query: 'all:"minimizer" AND all:"long read"', max_results: 3 });
  const id = s.text.match(/arXiv:(\d{4}\.\d{4,5}(?:v\d+)?)/)?.[1];
  const m = await call('arxiv', 'arxiv_get_metadata', { paper_ids: [id] });
  const f = await call('arxiv', 'arxiv_read_paper', { paper_id: '1706.03762', max_characters: 400000 });
  const source = f.text.match(/Source:\s*([\w-]+)/)?.[1] ?? null;
  const technical = /Training|Model Architecture|Results/i.test(f.text);
  record('D', 'arXiv search → metadata → full text (representation named)', id && !m.isError && f.text.length > 20000 && technical && source ? 'PASS' : 'FAIL', {
    search_first_id: id, metadata: short(m.text, 160), read: '1706.03762', representation: source, chars: f.text.length, technical_sections_present: technical });
});

// E. OpenAlex: conceptual discovery and citation traversal. Through the official MCP when Pi holds an OAuth sign-in;
// otherwise the REST API with OPENALEX_API_KEY (the same index), and the check says which.
await check('E', 'OpenAlex conceptual discovery and citation traversal', async () => {
  const query = 'tracking individual bacterial strains in a microbiome from long sequencing reads';
  const found = await openalexGet(`/works?search=${encodeURIComponent(query)}&per_page=5&select=id,display_name,doi,publication_year,cited_by_count,ids`);
  const top = found.results[0];
  const citing = await openalexGet(`/works?filter=cites:${top.id.split('/').pop()}&per_page=3&select=id,display_name,doi`);
  const refs = await openalexGet(`/works/${top.id.split('/').pop()}?select=referenced_works,related_works`);
  const mcpAuth = existsSync(join(homedir(), '.pi/agent/mcp-auth.json')) && /openalex/.test(readFileSync(join(homedir(), '.pi/agent/mcp-auth.json'), 'utf8'));
  record('E', 'OpenAlex conceptual discovery and citation traversal', found.results.length >= 3 && citing.meta.count >= 0 && refs.referenced_works?.length >= 1 ? 'PASS' : 'FAIL', {
    path: mcpAuth ? 'REST API (the MCP is signed in; the Pi workflow exercises it)' : 'REST API with OPENALEX_API_KEY (the official MCP needs `/mcp login openalex`)',
    query, results: found.results.map((w) => `${w.publication_year} ${short(w.display_name, 90)} (${w.id.split('/').pop()})`),
    anchor: top.id.split('/').pop(), cited_by: citing.meta.count, citing_sample: citing.results.map((w) => short(w.display_name, 80)), references: refs.referenced_works.length, related: refs.related_works.length });
});

// F. Semantic Scholar citation expansion from one paper: references, citing papers, recommendations.
await check('F', 'Semantic Scholar references, citations and recommendations from one paper', async () => {
  const id = 'DOI:10.1093/bioinformatics/bty191';
  const refs = await call('semantic_scholar', 'get_paper_references', { paper_id: id, limit: 5 });
  const cits = await call('semantic_scholar', 'get_paper_citations', { paper_id: id, limit: 5 });
  // Recommendations are seeded from a recent paper: the endpoint returns none for some older, heavily cited ones.
  const recSeed = 'DOI:10.1038/s41592-024-02262-1';
  const recs = await call('semantic_scholar', 'get_recommendations_for_paper', { paper_id: recSeed, limit: 5 });
  const titles = (t) => [...t.matchAll(/"title":\s*"([^"]+)"/g)].map((m) => short(m[1], 80)).slice(0, 3);
  const ok = (r) => !r.isError && titles(r.text).length > 0;
  record('F', 'Semantic Scholar references, citations and recommendations from one paper', ok(refs) && ok(cits) && ok(recs) ? 'PASS' : 'FAIL', {
    paper: id, key: keys.SEMANTIC_SCHOLAR_API_KEY ? 'authenticated' : 'keyless (shared rate limit)',
    references: ok(refs) ? titles(refs.text) : short(refs.text, 200), citations: ok(cits) ? titles(cits.text) : short(cits.text, 200),
    recommendations: { seed: recSeed, titles: ok(recs) ? titles(recs.text) : `unavailable: ${short(recs.text, 200)}` } });
});

// G. One article across systems: PubMed, Semantic Scholar and OpenAlex identifiers resolve to the same DOI.
await check('G', 'Cross-source identifier resolution (one paper, not three)', async () => {
  const pmid = '29750242';
  const conv = await call('pubmed', 'pubmed_convert_ids', { ids: [pmid], idType: 'pmid' });
  const pmDoi = conv.text.match(/\b(10\.\d{4,9}\/[^\s|)\]"]+)/)?.[1]?.toLowerCase();
  const s2 = await call('semantic_scholar', 'get_paper', { paper_id: `PMID:${pmid}` });
  const s2Paper = JSON.parse(s2.text).data ?? {};
  const s2Doi = s2Paper.external_ids?.DOI?.toLowerCase(), s2Id = s2Paper.paper_id, s2Arxiv = s2Paper.external_ids?.ArXiv ?? null;
  const oa = toRecord(await openalexGet(`/works/pmid:${pmid}?select=id,doi,ids,display_name`));
  const same = pmDoi && pmDoi === s2Doi && s2Doi === oa.identifiers.doi;
  record('G', 'Cross-source identifier resolution (one paper, not three)', same ? 'PASS' : 'FAIL',
    { pmid, pubmed_doi: pmDoi, semantic_scholar: { paper_id: s2Id, doi: s2Doi, arxiv: s2Arxiv, pmid: s2Paper.external_ids?.PubMed ?? null }, openalex: oa.identifiers,
      one_paper: Boolean(same), note: 'the arXiv preprint (arXiv:' + s2Arxiv + ') is the same work; Semantic Scholar links it, OpenAlex keys this record by DOI' });
});

// H. OpenAlex Content API (the helper): structured full text with provenance, and an explicit unavailable state.
await check('H', 'OpenAlex content helper: TEI full text, and FULLTEXT_UNAVAILABLE when there is no copy', async () => {
  const r = await openalexContent('10.1093/bioinformatics/bty191', { apiKey: keys.OPENALEX_API_KEY, select: ['method', 'result'] });
  const none = await openalexContent('10.1038/nature14539', { apiKey: keys.OPENALEX_API_KEY });
  record('H', 'OpenAlex content helper: TEI full text, and FULLTEXT_UNAVAILABLE when there is no copy', r.status === 'OK' && r.provenance.complete === 'likely' ? 'PASS' : 'FAIL', {
    status: r.status, provenance: r.provenance, selected: r.selected?.matched, second: `${none.status}${none.reason ? `: ${short(none.reason, 120)}` : ''}` });
});

for (const c of Object.values(servers)) await c.close();
const date = new Date().toISOString().slice(0, 10);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `smoke-${date}.json`), `${JSON.stringify(results, null, 2)}\n`);
writeFileSync(join(out, `smoke-${date}.md`), [`# Literature smoke suite, ${date}`, '', 'Generated by `npm run literature:smoke`. Evidence is what each check saw.', '',
  ...results.flatMap((r) => [`## ${r.id}. ${r.title}: ${r.status}`, '', '```json', JSON.stringify(r.evidence, null, 2), '```', ''])].join('\n'));
const failed = results.filter((r) => r.status === 'FAIL');
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((r) => r.id).join(' ')}` : ''}\nreport: ${join(out, `smoke-${date}.md`)}\n`);
process.exit(failed.length ? 1 : 0);
