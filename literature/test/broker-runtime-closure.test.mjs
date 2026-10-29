// Regressions for the runtime closure findings (verifier repros /tmp/closure-rt r1-runtime X2/X5, r2-tools T3):
//   R1  get.mjs: a stopped acquisition, or a partial one with a temporary tier failure, never becomes a permanent cache entry
//   R2  runtime: a caller does not join an in-flight request whose deadline is earlier than its own
//   R3  runtime: while an abandoned MCP request holds its lane, new and queued calls fail fast with skipped_busy
//   R4  get.mjs: the bioRxiv page wait is abortable and leaves lane health alone on cancel
// No network: every exec, fetch, MCP connection, Exa/SearXNG client, web.page, web.pdf and pdfToText is a local fake.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../broker/runtime.mjs';
const { createRuntime, createCache, createLog, sleep } = runtime;
// before the fix there was no exported list; the fallback keeps the red run per-test
const TEMPORARY_OUTCOMES = runtime.TEMPORARY_OUTCOMES ?? ['rate_limited', 'timeout', 'cancelled', 'skipped_unhealthy', 'skipped_busy', 'transient', 'budget_exhausted', 'error'];
import { createProviders } from '../broker/providers.mjs';
import { createBroker } from '../broker/index.mjs';
import { acquire } from '../broker/get.mjs';
import { literatureSearch, absenceStatement } from '../broker/search.mjs';
import { createLiteratureTools } from '../../adapters/pi-literature-broker/index.js';

const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => { throw new Error(`live fetch attempted in a unit test: ${u}`); };
after(() => { globalThis.fetch = realFetch; });

const mk = (o = {}) => createRuntime({ cache: createCache({ dir: null }), log: createLog({ dir: null }), ...o });
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const PARTIAL_HTML = '<title>x</title><h1>Intro</h1><p>' + 'word '.repeat(1500) + '</p>';
const FULL_TEXT = 'Introduction\n'.repeat(10) + '# Methods\n' + 'm '.repeat(9000) + '\n# Results\n' + 'r '.repeat(9000) + '\n# Discussion\n' + 'd '.repeat(5000);
const arxivFamily = (id = '2101.00001') => ({ family_id: `arxiv:${id}`, members: [{ arxiv: id, is_preprint: true }] });
/** Providers for acquire(): tier 2 arXiv HTML (partial), tier 5 arXiv PDF; nothing else is reachable. */
function acqProviders({ page = async () => ({ outcome: 'ok', data: { text: PARTIAL_HTML } }), pdf, pdfToText = async () => FULL_TEXT, biorxiv } = {}) {
  const calls = { page: 0, pdf: 0, pdfToText: 0, biorxiv: 0 };
  const fail = async () => ({ outcome: 'error', error: 'not stubbed' });
  return { calls, p: {
    pubmed: { fulltext: fail }, arxiv: { read: fail }, openalex: { content: fail },
    biorxiv: { fulltext: async (a) => { calls.biorxiv++; return biorxiv ? biorxiv(a) : fail(); } },
    web: { page: async (a) => { calls.page++; return page(a); }, pdf: async (a) => { calls.pdf++; return pdf ? pdf(a) : fail(); } },
    pdfToText: async (b) => { calls.pdfToText++; return pdfToText(b); },
  } };
}

// ---- R1: fulltext cache ----------------------------------------------------------------------------------------------------
test('R1: partial text from an acquisition stopped during the tier-5 PDF is not cached; the next call retries the PDF', async () => {
  const rt = mk();
  const ac = new AbortController();
  const a = acqProviders({ pdf: async () => { ac.abort(); return { outcome: 'cancelled', error: 'CANCELLED web.pdf' }; } });
  const first = await acquire({ p: a.p, rt, signal: ac.signal }, arxivFamily(), {});
  assert.equal(first.status, 'partial');
  assert.equal(first.temporary, true, 'a stopped acquisition is reported as temporary');
  const b = acqProviders({ pdf: async () => ({ outcome: 'ok', data: { pdf: Buffer.from('%PDF-fake') } }) });
  const second = await acquire({ p: b.p, rt }, arxivFamily(), {});
  assert.notEqual(second.cached, true, 'the partial result was not cached');
  assert.equal(b.calls.pdf, 1, 'the PDF tier was retried');
  assert.equal(second.status, 'ok');
  assert.equal((await acquire({ p: b.p, rt }, arxivFamily(), {})).cached, true, 'a complete result caches');
});

test('R1: even a complete result is not cached when the acquisition was stopped', async () => {
  const rt = mk();
  const ac = new AbortController();
  const a = acqProviders({ page: async () => { ac.abort(); return { outcome: 'ok', data: { text: `<title>x</title><p>${FULL_TEXT}</p>` } }; } });
  const r = await acquire({ p: a.p, rt, signal: ac.signal }, arxivFamily(), {});
  assert.equal(r.status, 'ok');
  assert.notEqual((await acquire({ p: a.p, rt }, arxivFamily(), {})).cached, true);
});

for (const outcome of TEMPORARY_OUTCOMES) {
  test(`R1: a partial result is not cached when a tier failed temporarily (${outcome})`, async () => {
    const rt = mk();
    const a = acqProviders({ pdf: async () => ({ outcome, error: `${outcome} upstream` }) });
    const r = await acquire({ p: a.p, rt }, arxivFamily(), {});
    assert.equal(r.status, 'partial');
    assert.equal(r.temporary, true);
    const again = await acquire({ p: a.p, rt }, arxivFamily(), {});
    assert.notEqual(again.cached, true);
    assert.equal(a.calls.pdf, 2, 'the failed tier is retried');
  });
}

test('R1: a partial result whose other tiers failed permanently is still cached; so is a complete one', async () => {
  const rt = mk();
  const a = acqProviders({ pdf: async () => ({ outcome: 'not_found', error: 'HTTP 404' }) });
  const r = await acquire({ p: a.p, rt }, arxivFamily('2101.00002'), {});
  assert.equal(r.status, 'partial'); assert.notEqual(r.temporary, true);
  assert.equal((await acquire({ p: a.p, rt }, arxivFamily('2101.00002'), {})).cached, true);
  const c = acqProviders({ page: async () => ({ outcome: 'ok', data: { text: `<title>x</title><p>${FULL_TEXT}</p>` } }) });
  const ok = await acquire({ p: c.p, rt }, arxivFamily('2101.00003'), {});
  assert.equal(ok.status, 'ok');
  assert.equal((await acquire({ p: c.p, rt }, arxivFamily('2101.00003'), {})).cached, true);
});

// The verifier's T3 through the registered paper_get tool on the real broker/runtime/providers, every seam stubbed.
function stubWorld({ pdfMs = 300, pageText = PARTIAL_HTML } = {}) {
  const d = [];
  const fetchImpl = async (u, o = {}) => {
    d.push({ k: 'fetch', u: String(u) });
    await new Promise((res, rej) => { const t = setTimeout(res, 50); o.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('AbortError')); }, { once: true }); });
    return { ok: true, status: 200, json: async () => ({}), text: async () => JSON.stringify({ meta: { count: 0 }, results: [] }) };
  };
  const connectMcp = async (name) => ({
    async call(tool) {
      d.push({ k: 'mcp', s: name, tool });
      const sc = tool === 'arxiv_get_metadata' ? { papers: [{ id: '2101.00001v1', title: 'A partial paper on persisters', abstract: 'abs', published: '2021-01-01', authors: ['X'] }] }
        : { pmids: [], summaries: [], hits: [], papers: [], data: [], articles: [] };
      return sleep(10).then(() => ({ structuredContent: sc }));
    },
    async tools() { return []; }, async close() {},
  });
  return { d, fetchImpl, connectMcp, pdfMs, pageText };
}
function stubBroker(w, cache) {
  const rt = createRuntime({ cache, log: createLog({ dir: null }), budgetUsd: 1, reserveUsd: 0,
    pacing: { openalex: 0, openalex_semantic: 0, pubmed: 0, europepmc: 0, searxng: 0, exa: 0, web: 0, arxiv: 0, semantic_scholar_keyless: 0 } });
  const p = createProviders(rt, { keys: {}, researchKeys: {}, config: { exaKeyless: true }, fetchImpl: w.fetchImpl, connectMcp: w.connectMcp });
  for (const b of ['exa', 'searxng']) p[b].search = ({ q, ctx }) => rt.call({ backend: b, op: 'search', args: { q }, cacheNs: 'search', ctx, exec: async () => { w.d.push({ k: b }); return { data: { results: [] }, empty: true }; } })
    .then((r) => ({ ...r, sent: q, items: [] }));
  p.web.page = ({ url, ctx, lane = 'web' }) => rt.call({ backend: 'web', op: 'page.raw', lane, args: { url }, cacheNs: null, retries: 0, ctx, exec: async () => {
    w.d.push({ k: 'web.page', u: url }); await sleep(5); return { data: { text: w.pageText, final_url: url } }; } });
  p.web.pdf = ({ url, ctx }) => rt.call({ backend: 'web', op: 'pdf', lane: 'web', args: { url }, cacheNs: null, retries: 0, ctx, exec: async (s) => {
    w.d.push({ k: 'web.pdf', u: url });
    await new Promise((r) => { const t = setTimeout(r, w.pdfMs); s.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
    return { data: { pdf: Buffer.from('%PDF-fake') } }; } });
  p.pdfToText = async () => { w.d.push({ k: 'pdfToText' }); return FULL_TEXT; };
  return createBroker({ runtime: rt, providers: p });
}
test('R1 (T3): registered paper_get aborted during the tier-5 PDF does not pin the partial text; a later call reads the PDF', async () => {
  const cache = createCache({ dir: null });
  const w = stubWorld({ pdfMs: 2000 });
  const tool = createLiteratureTools(stubBroker(w, cache)).find((t) => t.name === 'paper_get');
  const ac = new AbortController();
  const first = tool.execute('t3', { ref: 'arxiv:2101.00001', depth: 'full' }, ac.signal, () => {}).then(() => 'resolved', (e) => String(e.message));
  while (!w.d.some((x) => x.k === 'web.pdf')) await sleep(5);
  ac.abort();
  assert.match(await first, /CANCELLED/);
  await sleep(50);
  const w2 = stubWorld({ pdfMs: 10 });
  const r2 = await createLiteratureTools(stubBroker(w2, cache)).find((t) => t.name === 'paper_get').execute('t3b', { ref: 'arxiv:2101.00001', depth: 'full' }, undefined, () => {});
  assert.ok(w2.d.some((x) => x.k === 'web.pdf'), 'the second call dispatched the PDF');
  assert.equal(r2.details.fulltext.cached, false);
  assert.equal(r2.details.fulltext.completeness, 'complete');
});

// ---- R2: deadlines of shared requests ----------------------------------------------------------------------------------------
const abortableExec = (counter, ms = 300) => async (s) => {
  counter.n++;
  await new Promise((r, j) => { const t = setTimeout(r, ms); s.addEventListener('abort', () => { clearTimeout(t); j(new Error('AbortError')); }, { once: true }); });
  return { data: { v: counter.n } };
};
test('R2 (X2): a joiner with a later deadline does not join a shared request that ends earlier; it runs its own', async () => {
  const rt = mk({ pacing: { openalex: 0 } }); const c = { n: 0 };
  const exec = abortableExec(c);
  const a = rt.scoped({ deadline: Date.now() + 100 }, () => rt.call({ backend: 'openalex', op: 'kw', args: { q: 'x2' }, cacheNs: 'search', exec }));
  await sleep(5);
  const b = rt.scoped({ deadline: Date.now() + 60000 }, () => rt.call({ backend: 'openalex', op: 'kw', args: { q: 'x2' }, cacheNs: 'search', exec }));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.outcome, 'timeout');
  assert.equal(rb.outcome, 'ok', JSON.stringify(rb));
  assert.notEqual(rb.deadline_truncated, true);
  assert.notEqual(rb.coalesced, true);
  assert.equal(c.n, 2);
});
test('R2: a joiner whose deadline is earlier than (or equal to) the shared request\'s still coalesces', async () => {
  const rt = mk({ pacing: { openalex: 0 } }); const c = { n: 0 };
  const exec = abortableExec(c, 100);
  const a = rt.scoped({ deadline: Date.now() + 60000 }, () => rt.call({ backend: 'openalex', op: 'kw', args: { q: 'x2r' }, cacheNs: 'search', exec }));
  await sleep(5);
  const b = rt.scoped({ deadline: Date.now() + 5000 }, () => rt.call({ backend: 'openalex', op: 'kw', args: { q: 'x2r' }, cacheNs: 'search', exec }));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.outcome, 'ok'); assert.equal(rb.outcome, 'ok'); assert.equal(rb.coalesced, true); assert.equal(c.n, 1);
  // equal deadlines (one scope, two identical calls)
  const c2 = { n: 0 }; const e2 = abortableExec(c2, 50);
  const [x, y] = await rt.scoped({ deadline: Date.now() + 10000 }, () => Promise.all([0, 1].map(() => rt.call({ backend: 'openalex', op: 'kw', args: { q: 'eq' }, cacheNs: 'search', exec: e2 }))));
  assert.equal(x.outcome, 'ok'); assert.equal(y.coalesced, true); assert.equal(c2.n, 1);
  // default deadlines, no scope: a later start under the same default budget is not a longer deadline
  const c3 = { n: 0 }; const e3 = abortableExec(c3, 50);
  const p1 = rt.call({ backend: 'openalex', op: 'kw', args: { q: 'df' }, cacheNs: 'search', exec: e3 });
  await sleep(10);
  const r2 = await rt.call({ backend: 'openalex', op: 'kw', args: { q: 'df' }, cacheNs: 'search', exec: e3 });
  await p1;
  assert.equal(r2.coalesced, true); assert.equal(c3.n, 1);
});

// ---- R3: lane held by an abandoned MCP request -------------------------------------------------------------------------------
test('R3 (X5): while an abandoned MCP request holds its lane, later calls fail fast with skipped_busy; health is untouched', async () => {
  const rt = mk({ pacing: { pubmed: 0 } }); let n = 0;
  const g = gate();
  const hang = async () => { n++; await g.p; return { data: {} }; };
  const r1 = await rt.call({ backend: 'pubmed', op: 's', args: { q: 1 }, cacheNs: null, retries: 0, timeoutMs: 200, cancellable: false, exec: hang });
  assert.equal(r1.outcome, 'timeout'); assert.equal(r1.upstream, 'abandoned_not_stopped');
  for (const q of [2, 3]) {
    const t0 = Date.now();
    const r = await rt.call({ backend: 'pubmed', op: 's', args: { q }, cacheNs: null, retries: 0, timeoutMs: 200, deadlineMs: 5000, cancellable: false, exec: hang });
    assert.ok(Date.now() - t0 < 100, `failed fast (${Date.now() - t0} ms)`);
    assert.equal(r.outcome, 'skipped_busy');
    assert.match(r.error, /lane held by an abandoned upstream request/);
    assert.match(r.error, /pubmed\.s/);
  }
  assert.equal(n, 1, 'nothing else dispatched on the held lane');
  assert.equal(rt.health.get('pubmed').state, 'healthy', 'a held lane is not backend failure evidence');
  // other lanes are unaffected
  assert.equal((await rt.call({ backend: 'europepmc', op: 's', args: { q: 9 }, cacheNs: null, exec: async () => ({ data: {} }) })).outcome, 'ok');
  g.open(); await sleep(20);
  assert.equal((await rt.call({ backend: 'pubmed', op: 's', args: { q: 4 }, cacheNs: null, retries: 0, exec: async () => ({ data: {} }) })).outcome, 'ok', 'the lane reopens when the upstream request settles');
});
test('R3: callers already queued behind the request are released with skipped_busy when it is abandoned, not at their deadline', async () => {
  const rt = mk({ pacing: { pubmed: 0 } });
  const g = gate(); let n = 0;
  const a = rt.call({ backend: 'pubmed', op: 's', args: { q: 'a' }, cacheNs: null, retries: 0, timeoutMs: 150, cancellable: false, exec: async () => { n++; await g.p; return { data: {} }; } });
  await sleep(10);
  const t0 = Date.now();
  const queued = [1, 2].map((q) => rt.call({ backend: 'pubmed', op: 's', args: { q }, cacheNs: null, retries: 0, deadlineMs: 10000, cancellable: false, exec: async () => { n++; return { data: {} }; } }));
  const [ra, ...rq] = await Promise.all([a, ...queued]);
  assert.equal(ra.upstream, 'abandoned_not_stopped');
  assert.ok(Date.now() - t0 < 1000, `queued callers released in ${Date.now() - t0} ms`);
  for (const r of rq) { assert.equal(r.outcome, 'skipped_busy'); assert.equal(r.queued, true); }
  assert.equal(n, 1);
  assert.equal(rt.health.get('pubmed').state, 'healthy');
  g.open();
});
test('R3: a user-cancelled MCP request also holds the lane: the next call is skipped_busy, then the lane runs after it settles', async () => {
  const rt = mk({ pacing: { pubmed: 0 } });
  const g = gate(); let settled = false;
  const ac = new AbortController();
  const p = rt.call({ backend: 'pubmed', op: 'fetch', args: { q: 1 }, cacheNs: null, retries: 0, cancellable: false, signal: ac.signal, exec: async () => { await g.p; settled = true; return { data: {} }; } });
  await sleep(10); ac.abort();
  assert.equal((await p).upstream, 'abandoned_not_stopped');
  let started = 0;
  const busy = await rt.call({ backend: 'pubmed', op: 'fetch', args: { q: 2 }, cacheNs: null, retries: 0, exec: async () => { started++; return { data: {} }; } });
  assert.equal(busy.outcome, 'skipped_busy'); assert.equal(started, 0);
  g.open(); await sleep(10);
  assert.ok(settled);
  assert.equal((await rt.call({ backend: 'pubmed', op: 'fetch', args: { q: 2 }, cacheNs: null, retries: 0, exec: async () => { started++; return { data: {} }; } })).outcome, 'ok');
  assert.equal(started, 1);
});
test('R3: skipped_busy is temporary for paper_get (no negative cache) and is a reported failure in search coverage', async () => {
  assert.ok(runtime.TEMPORARY_OUTCOMES?.includes('skipped_busy'), 'runtime exports the temporary outcomes, skipped_busy included');
  const rt = mk();
  const busy = async () => ({ outcome: 'skipped_busy', error: 'pubmed lane held by an abandoned upstream request (pubmed.fulltext)' });
  const p = { pubmed: { fulltext: busy }, arxiv: { read: busy }, openalex: { content: busy }, biorxiv: { fulltext: busy }, web: { page: busy, pdf: busy }, pdfToText: async () => '' };
  const fam = { family_id: 'doi:10.1/busy', members: [{ doi: '10.1/busy', pmid: '1', is_preprint: false }] };
  const r = await acquire({ p, rt }, fam, {});
  assert.equal(r.status, 'FULLTEXT_UNAVAILABLE'); assert.equal(r.temporary, true);
  assert.match(r.validation.reasons[0], /skipped_busy/);
  assert.notEqual((await acquire({ p, rt }, fam, {})).cached, true);
  // coverage
  const res = (items) => ({ outcome: items.length ? 'ok' : 'empty', items, sent: 'q', total: items.length, ms: 1 });
  const sp = {
    exa: { mode: 'keyed', search: async () => res([]) },
    openalex: { semantic: async () => res([]), keyword: async () => res([]), batch: async () => ({ outcome: 'ok', items: [], calls: [] }), get: async () => ({ outcome: 'not_found', item: null }), titleSearch: async () => res([]), references: async () => res([]), citing: async () => res([]) },
    pubmed: { search: async () => ({ outcome: 'skipped_busy', items: [], sent: 'q', error: 'pubmed lane held by an abandoned upstream request (pubmed.search)' }), related: async () => res([]) },
    europepmc: { search: async () => res([]) }, arxiv: { search: async () => res([]), bibliography: async () => res([]) }, biorxiv: { search: async () => res([]) },
    searxng: { search: async () => res([]) }, semantic_scholar: { state: () => 'disabled', search: async () => res([]) },
  };
  const s = await literatureSearch({ p: sp, rt: mk(), config: {} }, { query: 'persister cells antibiotic tolerance', mode: 'comprehensive', field: 'biomedical' });
  assert.ok(s.coverage.backends_failed.some((f) => f.backend === 'pubmed' && f.reason === 'skipped_busy'), JSON.stringify(s.coverage.backends_failed));
  assert.doesNotMatch(absenceStatement(s.coverage, 'q'), /^No matching work was found after these searches[^]*Did not run successfully: none/);
  assert.match(absenceStatement(s.coverage, 'q'), /Did not run successfully: .*pubmed/);
});

// ---- R4: bioRxiv page wait -------------------------------------------------------------------------------------------------------
const bxFamily = { family_id: 'doi:10.1101/2025.01.01.000002', members: [{ doi: '10.1101/2025.01.01.000002', is_preprint: true }] };
test('R4: an abort during the bioRxiv page wait ends it promptly, does not retry, and leaves the lane benched', async () => {
  const rt = mk();
  rt.health.mark('biorxiv_page', 'temporarily_unhealthy', 60000, 'rate_limited: 429');
  const a = acqProviders({ biorxiv: async () => ({ outcome: 'rate_limited', error: 'HTTP 429' }) });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const t0 = Date.now();
  const r = await acquire({ p: a.p, rt, signal: ac.signal }, bxFamily, {});
  assert.ok(Date.now() - t0 < 1000, `acquire settled in ${Date.now() - t0} ms`);
  assert.equal(a.calls.biorxiv, 1, 'no retry after the cancelled wait');
  assert.equal(rt.health.get('biorxiv_page').state, 'temporarily_unhealthy', 'health unchanged on cancel');
  assert.equal(r.temporary, true);
  assert.ok(r.tiers.some((t) => t.source === 'biorxiv_get_fulltext' && t.outcome === 'cancelled'));
  assert.equal(rt.cache.get('fulltext_unavailable', ['fulltext', bxFamily.family_id, 'best']), null);
  assert.equal(rt.cache.get('fulltext', ['fulltext', bxFamily.family_id, 'best']), null);
});
test('R4: the bioRxiv page wait also ends at the invocation deadline, without marking the lane healthy', async () => {
  const rt = mk();
  rt.health.mark('biorxiv_page', 'temporarily_unhealthy', 60000, 'rate_limited: 429');
  const a = acqProviders({ biorxiv: async () => ({ outcome: 'skipped_unhealthy', error: 'benched' }) });
  const t0 = Date.now();
  const r = await acquire({ p: a.p, rt, deadline: Date.now() + 80 }, bxFamily, {});
  assert.ok(Date.now() - t0 < 1000, `acquire settled in ${Date.now() - t0} ms`);
  assert.equal(a.calls.biorxiv, 1);
  assert.equal(rt.health.get('biorxiv_page').state, 'temporarily_unhealthy');
  assert.equal(r.temporary, true);
});
