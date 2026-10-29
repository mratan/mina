// Provider request shapes, checked at the network seams (fake fetch, fake MCP connect): no live API, no MCP server process.
// Regressions for two live failures: OpenAlex semantic answers HTTP 400 when a date filter is sent with search.semantic,
// and @cyanheads/arxiv-mcp-server 1.5.3 rejects submitted_from/to stripped of hyphens (it requires YYYY-MM-DD).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProviders, dateBound, dateWindow } from '../broker/providers.mjs';
import { createRuntime, createCache, createLog } from '../broker/runtime.mjs';
import { literatureSearch } from '../broker/search.mjs';
import { candidate } from '../lib/normalize.mjs';

// A live request from this file is a test failure, not a silent network call.
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => { throw new Error(`live fetch attempted in a unit test: ${u}`); };
after(() => { globalThis.fetch = realFetch; });

const rtFor = () => createRuntime({ cache: createCache({ dir: null }), log: createLog({ dir: null }), pacing: {} });
const work = (id, date, year) => ({ id: `https://openalex.org/${id}`, display_name: `Paper ${id}`, publication_date: date, publication_year: year ?? (date ? Number(date.slice(0, 4)) : undefined), ids: {} });

function fakeFetch(results, count = 1234) {
  const urls = [];
  const fn = async (u) => {
    urls.push(new URL(String(u)));
    return { ok: true, status: 200, text: async () => JSON.stringify({ meta: { count }, results }) };
  };
  return { fn, urls };
}
function fakeMcp(responder = () => ({ structuredContent: { papers: [] } })) {
  const calls = [];
  const connectMcp = async (name) => ({
    async call(tool, args) { calls.push({ server: name, tool, args: JSON.parse(JSON.stringify(args)) }); return responder(tool, args); },
    async tools() { return []; }, async close() {},
  });
  return { connectMcp, calls };
}
const providers = (rt, over = {}) => createProviders(rt, { keys: {}, researchKeys: {}, config: {}, fetchImpl: fakeFetch([]).fn, connectMcp: fakeMcp().connectMcp, ...over });

// ---- OpenAlex semantic ------------------------------------------------------------------------------------------------------
test('OpenAlex semantic: no publication-date filter is sent with search.semantic', async () => {
  const f = fakeFetch([]);
  const p = providers(rtFor(), { fetchImpl: f.fn });
  await p.openalex.semantic({ q: 'strain phasing long reads', from: '2024-01-01', to: '2024-12-31' });
  assert.equal(f.urls.length, 1);
  const u = f.urls[0];
  assert.equal(u.pathname, '/works');
  assert.equal(u.searchParams.get('search.semantic'), 'strain phasing long reads');
  assert.doesNotMatch(decodeURIComponent(u.search), /(from|to)_publication_date/, 'the API rejects from/to_publication_date with search.semantic (HTTP 400)');
  assert.equal(u.searchParams.has('filter'), false);
  assert.equal(u.searchParams.get('per_page'), '50', 'a date window asks for the largest page, so local filtering has more candidates');
});

test('OpenAlex semantic: requested dates are enforced locally and the limitation is reported', async () => {
  const f = fakeFetch([work('W1', '2024-05-01'), work('W2', '2019-03-03'), work('W3', null, 2024), work('W4', null, null), work('W5', '2025-01-02')]);
  const p = providers(rtFor(), { fetchImpl: f.fn });
  const r = await p.openalex.semantic({ q: 'q', from: '2024-01-01', to: '2024-12-31' });
  assert.equal(r.outcome, 'ok');
  assert.deepEqual(r.items.map((c) => c.openalex), ['W1', 'W3']);
  assert.deepEqual(r.items.map((c) => c.rank), [1, 2], 'ranks are renumbered after filtering');
  assert.equal(r.date_filter.method, 'local_post_filter');
  assert.deepEqual({ from: r.date_filter.from, to: r.date_filter.to }, { from: '2024-01-01', to: '2024-12-31' });
  assert.equal(r.date_filter.retrieved, 5); assert.equal(r.date_filter.kept, 2);
  assert.equal(r.date_filter.out_of_window, 2); assert.equal(r.date_filter.undated, 1); assert.equal(r.date_filter.year_only, 1);
  assert.equal(r.date_filter.exhaustive, false);
  assert.equal(r.total, null, 'the unfiltered match count is not reported as the in-window total');
  assert.equal(r.total_unfiltered, 1234);
  assert.ok(r.notes.some((n) => /OpenAlex semantic/.test(n) && /not exhaustive|cannot guarantee/i.test(n)), r.notes.join('\n'));
});

test('OpenAlex semantic: nothing in the window is an empty search, with the same note; no window means no filtering', async () => {
  const f = fakeFetch([work('W2', '2019-03-03')]);
  const rt = rtFor();
  const p = providers(rt, { fetchImpl: f.fn });
  const r = await p.openalex.semantic({ q: 'q', from: '2024', to: '2024' });
  assert.equal(r.outcome, 'empty');
  assert.equal(r.items.length, 0);
  assert.equal(r.date_filter.out_of_window, 1);
  assert.ok(r.notes.length >= 1);
  const plain = await p.openalex.semantic({ q: 'q2', n: 10 });
  assert.equal(f.urls.at(-1).searchParams.get('per_page'), '10');
  assert.equal(plain.date_filter, undefined); assert.deepEqual(plain.notes ?? [], []);
  assert.equal(plain.items.length, 1); assert.equal(plain.total, 1234);
});

test('OpenAlex semantic: the request does not depend on the window, so it is cached once and filtered per window', async () => {
  const f = fakeFetch([work('W1', '2024-05-01'), work('W2', '2019-03-03')]);
  const p = providers(rtFor(), { fetchImpl: f.fn });
  const a = await p.openalex.semantic({ q: 'same', from: '2024-01-01' });
  const b = await p.openalex.semantic({ q: 'same', to: '2020-01-01' });
  assert.equal(f.urls.length, 1);
  assert.equal(b.cached, true);
  assert.deepEqual(a.items.map((c) => c.openalex), ['W1']);
  assert.deepEqual(b.items.map((c) => c.openalex), ['W2']);
});

test('OpenAlex keyword search still sends server-side date filters', async () => {
  const f = fakeFetch([]);
  const p = providers(rtFor(), { fetchImpl: f.fn });
  await p.openalex.keyword({ q: 'x', from: '2024-01-01', to: '2024-12-31' });
  assert.match(f.urls[0].searchParams.get('filter'), /from_publication_date:2024-01-01,to_publication_date:2024-12-31/);
});

// ---- arXiv -------------------------------------------------------------------------------------------------------------------
// The installed server's schema (dist/mcp-server/tools/definitions/arxiv-search.tool.js): /^(\d{4}-\d{2}-\d{2})?$/ and a
// real UTC calendar date, inclusive bounds, from <= to.
const ARXIV_DATE = /^\d{4}-\d{2}-\d{2}$/;
test('arXiv search: submitted_from/to are serialized as YYYY-MM-DD', async () => {
  const m = fakeMcp(() => ({ structuredContent: { papers: [{ id: '2401.00001v1', title: 'A', published: '2024-01-02' }], totalFound: 1 } }));
  const p = providers(rtFor(), { connectMcp: m.connectMcp });
  const r = await p.arxiv.search({ q: 'all:phasing', from: '2024-01-01', to: '2024-06-30' });
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].server, 'arxiv'); assert.equal(m.calls[0].tool, 'arxiv_search');
  assert.equal(m.calls[0].args.submitted_from, '2024-01-01');
  assert.equal(m.calls[0].args.submitted_to, '2024-06-30');
  assert.match(m.calls[0].args.submitted_from, ARXIV_DATE);
  assert.equal(r.outcome, 'ok');
});

test('arXiv search: partial dates expand to inclusive calendar bounds; no window sends no bounds', async () => {
  const m = fakeMcp();
  const p = providers(rtFor(), { connectMcp: m.connectMcp });
  await p.arxiv.search({ q: 'a', from: '2024', to: '2024-02' });
  assert.equal(m.calls[0].args.submitted_from, '2024-01-01');
  assert.equal(m.calls[0].args.submitted_to, '2024-02-29');
  await p.arxiv.search({ q: 'b' });
  assert.equal('submitted_from' in m.calls[1].args, false);
  assert.equal('submitted_to' in m.calls[1].args, false);
});

test('arXiv search: an invalid or inverted window is rejected locally, never widened and never sent', async () => {
  const m = fakeMcp();
  const p = providers(rtFor(), { connectMcp: m.connectMcp });
  const bad = await p.arxiv.search({ q: 'a', from: '2024-02-30' });
  assert.equal(bad.outcome, 'error'); assert.match(bad.error, /date/i); assert.deepEqual(bad.items, []);
  const inv = await p.arxiv.search({ q: 'a', from: '2024-06-01', to: '2024-01-01' });
  assert.equal(inv.outcome, 'error'); assert.match(inv.error, /after/i);
  assert.equal(m.calls.length, 0);
});

// ---- Exa opt-in, contact address, User-Agent --------------------------------------------------------------------------------
test('Exa without a key runs keyless only after the opt-in; otherwise it is not routed, with the reason', async () => {
  const off = providers(rtFor(), { env: {} });
  assert.equal(off.exa.mode, 'unconfigured');
  const r = await off.exa.search({ q: 'q' });
  assert.equal(r.outcome, 'skipped_unconfigured');
  assert.match(r.error, /MINA_EXA_KEYLESS=1/);
  assert.equal(providers(rtFor(), { env: {}, config: { exaKeyless: true } }).exa.mode, 'keyless');
  assert.equal(providers(rtFor(), { env: {}, researchKeys: { exa: 'k' } }).exa.mode, 'keyed');
  const res = (items) => ({ outcome: items.length ? 'ok' : 'empty', items, sent: 'q', total: items.length, ms: 1 });
  const p = {
    exa: { mode: 'unconfigured', notConfigured: off.exa.notConfigured, search: async () => { throw new Error('Exa must not run'); } },
    openalex: { semantic: async () => res([candidate({ rank: 1, title: 'A paper', openalex: 'W1', year: 2024 })]), keyword: async () => res([]), batch: async () => ({ outcome: 'ok', items: [], calls: [] }),
      get: async () => ({ outcome: 'not_found', item: null }), titleSearch: async () => res([]), references: async () => res([]), citing: async () => res([]) },
    pubmed: { search: async () => res([]), related: async () => res([]) }, europepmc: { search: async () => res([]) },
    arxiv: { search: async () => res([]), bibliography: async () => res([]) }, biorxiv: { search: async () => res([]) },
    searxng: { search: async () => res([]) }, semantic_scholar: { state: () => 'enabled_keyless', search: async () => res([]) },
  };
  const s = await literatureSearch({ p, rt: rtFor(), config: {} }, { query: 'CRISPR-Cas9 off-target effects detection methods', mode: 'standard' });
  assert.ok(!s.coverage.backends_attempted.includes('exa'));
  assert.ok(s.coverage.backends_not_routed.some((b) => b.backend === 'exa' && /MINA_EXA_KEYLESS/.test(b.reason)));
  assert.ok(s.coverage.coverage_notes.some((n) => /^Exa did not run: /.test(n)));
});

test('OpenAlex and doi.org: Mina User-Agent; mailto only when the user set RESEARCH_EMAIL; Unpaywall flagged off without one', async () => {
  const seen = [];
  const fetchImpl = async (u, o = {}) => { seen.push({ url: String(u), ua: o.headers?.['user-agent'] }); return { ok: true, status: 200, text: async () => JSON.stringify({ meta: { count: 0 }, results: [] }), json: async () => ({}) }; };
  const none = providers(rtFor(), { env: {}, fetchImpl });
  await none.openalex.keyword({ q: 'a' }); await none.doi_org.get({ doi: '10.1/x' });
  assert.ok(seen.length === 2 && seen.every((s) => /^Mina\/\S+ \(\+https:\/\/github\.com\/mratan\/mina\)$/.test(s.ua)), JSON.stringify(seen));
  assert.equal(none.keys.contact_email, false); assert.equal(none.keys.unpaywall, false);
  seen.length = 0;
  const withMail = providers(rtFor(), { env: { RESEARCH_EMAIL: 'lab@example.org' }, fetchImpl });
  await withMail.openalex.keyword({ q: 'b' }); await withMail.doi_org.get({ doi: '10.1/y' });
  assert.ok(seen.every((s) => s.ua.endsWith('; mailto:lab@example.org)')), JSON.stringify(seen));
  assert.ok(seen.every((s) => !s.url.includes('example.org')), 'the address is not put into URLs');
  assert.equal(withMail.keys.unpaywall, true);
  assert.equal(providers(rtFor(), { env: {}, keys: { NCBI_ADMIN_EMAIL: 'n@example.org' } }).keys.contact_email, true, 'key-file fallback');
  assert.equal(providers(rtFor(), { env: { RESEARCH_EMAIL: 'not an address' } }).keys.contact_email, false, 'an invalid value is not sent');
});

// ---- coverage report carries the semantic date method --------------------------------------------------------------------
test('literature_search coverage keeps the structured date-filter note of OpenAlex semantic', async () => {
  const res = (items, extra = {}) => ({ outcome: items.length ? 'ok' : 'empty', items, sent: 'q', total: items.length, ms: 1, ...extra });
  const df = { method: 'local_post_filter', from: '2024-01-01', to: null, retrieved: 3, kept: 1, out_of_window: 2, undated: 0, year_only: 0, exhaustive: false };
  const note = 'OpenAlex semantic search: test note, not exhaustive';
  const p = {
    exa: { mode: 'keyed', search: async () => res([]) },
    openalex: { semantic: async () => res([candidate({ rank: 1, title: 'In window', openalex: 'W1', year: 2024 })], { date_filter: df, notes: [note] }),
      keyword: async () => res([]), batch: async () => ({ outcome: 'ok', items: [], calls: [] }), get: async () => ({ outcome: 'not_found', item: null }),
      titleSearch: async () => res([]), references: async () => res([]), citing: async () => res([]) },
    pubmed: { search: async () => res([]), related: async () => res([]) }, europepmc: { search: async () => res([]) },
    arxiv: { search: async () => res([]), bibliography: async () => res([]) }, biorxiv: { search: async () => res([]) },
    searxng: { search: async () => res([]) }, semantic_scholar: { state: () => 'enabled_keyless', search: async () => res([]) },
  };
  const r = await literatureSearch({ p, rt: rtFor(), config: {} }, { query: 'strain-resolved metagenomic profiling', mode: 'standard', date_from: '2024-01-01' });
  const c = r.coverage;
  const q = c.queries_executed.find((e) => e.backend === 'openalex_semantic');
  assert.deepEqual(q.date_filter, df);
  assert.ok(c.coverage_notes.includes(note));
  assert.equal(c.coverage_notes.filter((n) => n === note).length, 1);
  assert.ok(c.date_filtering.some((d) => d.backend === 'openalex_semantic' && d.method === 'local_post_filter' && d.exhaustive === false));
});

test('date bounds: ISO forms expand inclusively; impossible dates throw instead of being dropped', () => {
  assert.equal(dateBound('2024-02-29', 'from'), '2024-02-29');
  assert.equal(dateBound('2023-02', 'to'), '2023-02-28');
  assert.equal(dateBound('2024-03-05T12:00:00Z', 'to'), '2024-03-05');
  assert.equal(dateBound(undefined, 'from'), null);
  for (const bad of ['2023-02-29', '2024-13', '20240101', '2024/01/01', 'last year']) assert.throws(() => dateBound(bad, 'from'), RangeError, bad);
  assert.throws(() => dateWindow('2024-02', '2024-01'), /after/);
  assert.deepEqual(dateWindow('2024-01', '2024-01'), { from: '2024-01-01', to: '2024-01-31' });
});

test('OpenAlex requests carry the runtime AbortSignal to fetch', async () => {
  let seen = null;
  const fetchImpl = async (u, o) => { seen = o?.signal ?? null; return { ok: true, status: 200, text: async () => JSON.stringify({ meta: { count: 0 }, results: [] }) }; };
  const p = providers(rtFor(), { fetchImpl });
  await p.openalex.keyword({ q: 'x' });
  assert.ok(seen instanceof AbortSignal);
});
