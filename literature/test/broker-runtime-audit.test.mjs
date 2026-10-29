// Runtime regressions (offline repros A–F of concurrency and budget faults, cancellation through the registered tools, date
// validation of the OpenAlex local window filter). Every exec, fetch and MCP connection is a fake; nothing leaves the process.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, createCache, createLog, sleep } from '../broker/runtime.mjs';
import { createProviders, filterWorksByWindow } from '../broker/providers.mjs';
import { createBroker } from '../broker/index.mjs';
import { createLiteratureTools } from '../../adapters/pi-literature-broker/index.js';
import { createSupervisedLiteratureTools } from '../../lib/literature-tools.mjs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => { throw new Error(`live fetch attempted in a unit test: ${u}`); };
after(() => { globalThis.fetch = realFetch; });

const mk = (o = {}) => createRuntime({ cache: createCache({ dir: null }), log: createLog({ dir: null }), ...o });
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const close = (a, b) => Math.abs(a - b) < 1e-9;

// ---- A: queue expiry after a transient attempt --------------------------------------------------------------------------
test('A: a retry that expires in the lane queue is queued/deadline_truncated and does not bench the lane', async () => {
  const rt = mk({ pacing: { semantic_scholar: 0 } });
  const g = gate();
  const a = rt.call({ backend: 'semantic_scholar', op: 's', args: { q: 1 }, cacheNs: null, retries: 1, deadlineMs: 2500,
    exec: async () => ({ isError: true, status: 503, text: 'HTTP 503' }) });
  await sleep(50);
  const blocker = rt.call({ backend: 'semantic_scholar', op: 's', args: { q: 2 }, cacheNs: null, retries: 0, exec: async () => { await g.p; return { data: {} }; } });
  const ra = await a; g.open(); await blocker;
  assert.equal(ra.outcome, 'timeout');
  assert.equal(ra.queued, true);
  assert.equal(ra.deadline_truncated, true);
  assert.equal(ra.attempts, 1);
  assert.equal(rt.health.get('semantic_scholar').state, 'healthy', 'queue congestion says nothing about the backend');
});

// ---- B: cache hits cost nothing ------------------------------------------------------------------------------------------
test('B: a cache hit reports cost_usd 0 (original_cost_usd keeps the first cost)', async () => {
  const rt = mk({ budgetUsd: 1, reserveUsd: 0, pacing: { openalex: 0 } });
  const exec = async () => ({ data: { results: [1] } });
  const c = () => rt.call({ backend: 'openalex', op: 'kw', args: { q: 'c' }, cacheNs: 'search', costUsd: 0.002, exec });
  const r1 = await c(); const r2 = await c();
  assert.equal(r1.cost_usd, 0.002);
  assert.equal(r2.cached, true);
  assert.equal(r2.cost_usd, 0);
  assert.equal(r2.original_cost_usd, 0.002);
  assert.ok(close(rt.budget.spent(), 0.002));
});

// ---- C: a retry answered from cache costs nothing; earlier attempt costs are kept -----------------------------------------
test('C: a transient failure whose retry is answered from cache charges only attempts that ran', async () => {
  const rt = mk({ budgetUsd: 1, reserveUsd: 0, pacing: { openalex: 0 } });
  let n = 0;
  const p = rt.call({ backend: 'openalex', op: 'kw', args: { q: 'd' }, cacheNs: 'search', costUsd: 0.002,
    exec: async () => { n++; return { isError: true, status: 503, text: 'HTTP 503' }; } });
  await sleep(50);
  rt.cache.put('search', ['openalex', 'kw', { q: 'd' }], { backend: 'openalex', op: 'kw', outcome: 'ok', data: { results: [1] }, error: null, cost_usd: 0.002, attempts: 1 });
  const r = await p;
  assert.equal(r.outcome, 'ok'); assert.equal(r.cached, true); assert.equal(n, 1);
  assert.equal(r.cost_usd, 0);
  assert.equal(rt.budget.spent(), 0, 'one 503 and no paid success');
  assert.equal(rt.budget.outstanding(), 0);
});

test('C: the cost an earlier attempt reported is summed with the retry, not overwritten', async () => {
  const rt = mk({ budgetUsd: 1, reserveUsd: 0, pacing: { openalex: 0 } });
  let n = 0;
  const r = await rt.call({ backend: 'openalex', op: 'kw', args: { q: 'sum' }, cacheNs: null, costUsd: 0.002,
    exec: async () => (++n === 1 ? { isError: true, status: 503, text: 'HTTP 503', costUsd: 0.0005 } : { data: { results: [1] }, costUsd: 0.001 }) });
  assert.equal(r.outcome, 'ok'); assert.equal(n, 2);
  assert.ok(close(r.cost_usd, 0.0015), `cost ${r.cost_usd}`);
  assert.ok(close(rt.budget.spent(), 0.0015), `ledger ${rt.budget.spent()}`);
});

test('C: a cached retry result is not written back to the cache as a fresh entry', async () => {
  const rt = mk({ pacing: { pubmed: 0 } });
  let n = 0;
  const p = rt.call({ backend: 'pubmed', op: 's', args: { q: 'wb' }, cacheNs: 'search', exec: async () => { n++; return { isError: true, status: 503, text: 'HTTP 503' }; } });
  await sleep(50);
  rt.cache.put('search', ['pubmed', 's', { q: 'wb' }], { backend: 'pubmed', op: 's', outcome: 'ok', data: { v: 1 }, error: null, cost_usd: 0, attempts: 1 });
  const writes = rt.cache.stats.writes;
  await p;
  assert.equal(rt.cache.stats.writes, writes);
});

// ---- D: cost attribution when the owner cancels ----------------------------------------------------------------------------
test('D: when the caller that started a shared request cancels, the first caller still waiting is charged', async () => {
  const rt = mk({ budgetUsd: 1, reserveUsd: 0, pacing: { openalex: 0 } });
  const g = gate();
  const ac = new AbortController();
  const exec = async () => { await g.p; return { data: { results: [1] } }; };
  const o = rt.call({ backend: 'openalex', op: 'kw', args: { q: 'e' }, cacheNs: 'search', costUsd: 0.002, signal: ac.signal, exec });
  const j1 = rt.call({ backend: 'openalex', op: 'kw', args: { q: 'e' }, cacheNs: 'search', costUsd: 0.002, exec });
  const j2 = rt.call({ backend: 'openalex', op: 'kw', args: { q: 'e' }, cacheNs: 'search', costUsd: 0.002, exec });
  await sleep(10); ac.abort(); g.open();
  const [ro, r1, r2] = await Promise.all([o, j1, j2]);
  assert.equal(ro.outcome, 'cancelled'); assert.equal(ro.cost_usd, 0);
  assert.equal(r1.outcome, 'ok'); assert.equal(r1.cost_usd, 0.002, 'the first remaining caller is charged');
  assert.equal(r2.cost_usd, 0);
  assert.ok(close(rt.budget.spent(), 0.002));
});

// ---- E: dispatch recheck order ----------------------------------------------------------------------------------------------
test('E: at dispatch the cache is checked before health', async () => {
  const rt = mk({ pacing: { pubmed: 0 } });
  const g = gate();
  const x = rt.call({ backend: 'pubmed', op: 's', args: { q: 'x' }, cacheNs: null, retries: 0, exec: async () => { await g.p; return { isError: true, status: 429, text: '429' }; } });
  const y = rt.call({ backend: 'pubmed', op: 's', args: { q: 'y' }, cacheNs: 'search', exec: async () => ({ data: {} }) });
  await sleep(10);
  rt.cache.put('search', ['pubmed', 's', { q: 'y' }], { backend: 'pubmed', op: 's', outcome: 'ok', data: { y: 1 }, error: null, cost_usd: 0, attempts: 1 });
  g.open(); await x; const ry = await y;
  assert.equal(ry.outcome, 'ok'); assert.equal(ry.cached, true); assert.deepEqual(ry.data, { y: 1 });
});

// ---- F: no shared mutable data --------------------------------------------------------------------------------------------
test('F: coalesced callers and the cache do not share one mutable data object', async () => {
  const rt = mk({ pacing: { pubmed: 0 } });
  const exec = async () => { await sleep(5); return { data: { list: [1] } }; };
  const c = () => rt.call({ backend: 'pubmed', op: 's', args: { q: 'm' }, cacheNs: 'search', exec });
  const [a, b] = await Promise.all([c(), c()]);
  a.data.list.push('MUT');
  assert.deepEqual(b.data, { list: [1] });
  const later = await c();
  assert.equal(later.cached, true);
  assert.deepEqual(later.data, { list: [1] });
  later.data.list.push('MUT2');
  assert.deepEqual((await c()).data, { list: [1] }, 'a hit cannot corrupt the cache either');
});

// ---- date validation in the local window filter ----------------------------------------------------------------------------
test('filterWorksByWindow: an impossible publication_date is undated, not compared as text', () => {
  const w = (id, d, y) => ({ id, publication_date: d, publication_year: y });
  const f = filterWorksByWindow([w('bad', '2020-13-45', 2020), w('feb30', '2021-02-30', 2021), w('ok', '2020-06-01', 2020), w('dt', '2020-06-02T00:00:00Z', 2020)],
    { from: '2020-01-01', to: '2021-12-31' });
  assert.deepEqual(f.kept.map((x) => x.id), ['ok', 'dt']);
  assert.equal(f.undated, 2);
  assert.equal(f.out_of_window, 0);
});

// ---- cancellation at the runtime --------------------------------------------------------------------------------------------
test('runtime: an abandoned non-cancellable (MCP) attempt is reported honestly and keeps its lane until it settles', async () => {
  const rt = mk({ pacing: { pubmed: 0 } });
  const g = gate(); let settled = false; let secondStart = 0;
  const ac = new AbortController();
  const p = rt.call({ backend: 'pubmed', op: 'fetch', args: { q: 1 }, cacheNs: null, retries: 0, cancellable: false, signal: ac.signal,
    exec: async () => { await g.p; settled = true; return { data: {} }; } });
  await sleep(10);
  ac.abort();
  const r = await p;
  assert.equal(r.outcome, 'cancelled');
  assert.equal(r.upstream, 'abandoned_not_stopped');
  assert.match(r.error, /abandoned/); assert.match(r.error, /not stopped/);
  // While the abandoned call holds the lane nothing else is dispatched on it: a new call is skipped_busy at once (closure R3).
  const busy = await rt.call({ backend: 'pubmed', op: 'fetch', args: { q: 2 }, cacheNs: null, retries: 0, exec: async () => { secondStart = Date.now(); return { data: {} }; } });
  assert.equal(busy.outcome, 'skipped_busy');
  assert.equal(secondStart, 0, 'the lane is not freed while the abandoned upstream call runs');
  const opened = Date.now(); g.open(); await sleep(10);
  const next = await rt.call({ backend: 'pubmed', op: 'fetch', args: { q: 2 }, cacheNs: null, retries: 0, exec: async () => { secondStart = Date.now(); return { data: {} }; } });
  assert.equal(next.outcome, 'ok');
  assert.ok(settled && secondStart >= opened);
});

test('runtime: a scope signal and deadline reach calls made inside it; a passed deadline dispatches nothing', async () => {
  const rt = mk({ pacing: { pubmed: 0 } });
  let n = 0;
  const ac = new AbortController(); ac.abort();
  const r1 = await rt.scoped({ signal: ac.signal }, () => rt.call({ backend: 'pubmed', op: 's', args: { q: 'sc' }, cacheNs: null, exec: async () => { n++; return { data: {} }; } }));
  assert.equal(r1.outcome, 'cancelled');
  const r2 = await rt.scoped({ deadline: Date.now() - 1 }, () => rt.call({ backend: 'pubmed', op: 's', args: { q: 'dl' }, cacheNs: null, exec: async () => { n++; return { data: {} }; } }));
  assert.equal(r2.outcome, 'timeout'); assert.equal(r2.deadline_truncated, true);
  assert.equal(n, 0);
  assert.equal(rt.health.get('pubmed').state, 'healthy');
});

// ---- cancellation through the real registered tools ---------------------------------------------------------------------------
function fakeWorld({ mcpMs = 400 } = {}) {
  const dispatched = []; const pendingMcp = new Set();
  const fetchImpl = async (u, o = {}) => {
    const url = new URL(String(u));
    dispatched.push({ kind: 'fetch', url, at: Date.now() });
    await new Promise((res, rej) => {
      const t = setTimeout(res, 300);
      o.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('AbortError: aborted')); }, { once: true });
    });
    return { ok: true, status: 200, text: async () => JSON.stringify({ meta: { count: 1 }, results: [{ id: `https://openalex.org/W${dispatched.length}`, display_name: `Persister paper ${dispatched.length}`, publication_year: 2020, ids: {} }] }) };
  };
  const connectMcp = async (name) => ({
    async call(tool) {
      dispatched.push({ kind: 'mcp', server: name, tool, at: Date.now() });
      const done = sleep(mcpMs).then(() => ({ structuredContent: { pmids: [], summaries: [], hits: [], papers: [], data: [] } })); // MCP: no cancellation
      pendingMcp.add(done); done.then(() => pendingMcp.delete(done));
      return done;
    },
    async tools() { return [{ name: 'pubmed_fetch_articles', description: 'x', inputSchema: {} }]; }, async close() {},
  });
  return { dispatched, pendingMcp, fetchImpl, connectMcp };
}
function realBroker(world, rtOpts = {}) {
  const rt = mk({ budgetUsd: 1, reserveUsd: 0, pacing: { openalex: 250, openalex_semantic: 250, pubmed: 250, europepmc: 250, searxng: 0, exa: 0, semantic_scholar_keyless: 250 }, ...rtOpts });
  const p = createProviders(rt, { keys: {}, researchKeys: {}, config: { exaKeyless: true }, fetchImpl: world.fetchImpl, connectMcp: world.connectMcp });
  // Exa and SearXNG go through the research adapter's own HTTP client: replaced by fakes that still run through rt.call.
  for (const b of ['exa', 'searxng']) {
    p[b].search = ({ q, ctx }) => rt.call({ backend: b, op: 'search', args: { q }, cacheNs: 'search', ctx, exec: async (signal) => {
      world.dispatched.push({ kind: b, at: Date.now() });
      await new Promise((res) => { const t = setTimeout(res, 300); signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
      return { data: { results: [] }, empty: true };
    } }).then((r) => ({ ...r, sent: q, items: [] }));
  }
  // The public-web fetcher too: nothing in this file may reach the network.
  p.web.page = ({ url, ctx, lane = 'web' }) => rt.call({ backend: 'web', op: 'page.raw', lane, args: { url }, cacheNs: null, retries: 0, ctx, exec: async () => {
    world.dispatched.push({ kind: 'web', at: Date.now() }); await sleep(300); return { isError: true, status: 404, text: 'HTTP 404' };
  } });
  p.web.pdf = ({ url, ctx }) => rt.call({ backend: 'web', op: 'pdf', lane: 'web', args: { url }, cacheNs: null, retries: 0, ctx, exec: async () => {
    world.dispatched.push({ kind: 'web', at: Date.now() }); await sleep(300); return { isError: true, status: 404, text: 'HTTP 404' };
  } });
  return { rt, broker: createBroker({ runtime: rt, providers: p }) };
}
const oaCost = (url) => (url.pathname !== '/works' ? 0 : url.searchParams.get('search.semantic') || /search/.test(url.searchParams.get('filter') ?? '') ? 0.001 : 0.0001);

test('registered literature_search: abort mid-search settles promptly, dispatches nothing more, settles reservations', async () => {
  const world = fakeWorld();
  const { rt, broker } = realBroker(world);
  const tool = createLiteratureTools(broker).find((t) => t.name === 'literature_search');
  const ac = new AbortController();
  const run = tool.execute('t1', { query: 'persister cells antibiotic tolerance in bacterial infections', mode: 'comprehensive', field: 'biomedical' }, ac.signal, () => {});
  const outcome = run.then((x) => ({ ok: true, x }), (e) => ({ ok: false, e }));
  while (world.dispatched.length < 3) await sleep(5);
  await sleep(20);
  const t0 = Date.now(); ac.abort();
  const r = await outcome;
  const settleMs = Date.now() - t0;
  assert.equal(r.ok, false, `an aborted tool rejects (${JSON.stringify(r.x?.details?.coverage?.backends_failed ?? r.x?.content)?.slice(0, 600)})`);
  assert.match(String(r.e.message), /CANCELLED/);
  assert.ok(settleMs < 150, `settled in ${settleMs} ms`);
  const atAbort = world.dispatched.length;
  assert.ok(world.pendingMcp.size > 0, 'fixture: an MCP request was in flight at the abort');
  assert.match(String(r.e.message), /abandoned/); assert.match(String(r.e.message), /not stopped/);
  assert.doesNotMatch(String(r.e.message), /upstream (was )?stopped/);
  await sleep(1200); // several pacing gaps: queued calls would have started by now
  assert.equal(world.dispatched.length, atAbort, `no dispatch after the abort (${world.dispatched.slice(atAbort).map((d) => d.server ?? d.kind).join(',')})`);
  assert.equal(rt.budget.outstanding(), 0, 'every reservation settled');
  const expected = world.dispatched.filter((d) => d.kind === 'fetch').reduce((s, d) => s + oaCost(d.url), 0);
  assert.ok(close(rt.budget.spent(), expected), `ledger ${rt.budget.spent()} vs dispatched estimate ${expected}`);
});

test('registered literature_search: an already-aborted signal rejects without any dispatch', async () => {
  const world = fakeWorld();
  const { broker } = realBroker(world);
  const tool = createLiteratureTools(broker).find((t) => t.name === 'literature_search');
  const ac = new AbortController(); ac.abort();
  await assert.rejects(tool.execute('t0', { query: 'persister cells', mode: 'standard' }, ac.signal, () => {}), /CANCELLED/);
  await sleep(50);
  assert.equal(world.dispatched.length, 0);
});

test('registered paper_get: the per-tool deadline bounds the whole invocation', async () => {
  const world = fakeWorld({ mcpMs: 5000 });
  const { broker } = realBroker(world);
  const tool = createLiteratureTools(broker, { deadlineMs: { paper_get: 300 } }).find((t) => t.name === 'paper_get');
  const t0 = Date.now();
  const r = await tool.execute('t2', { ref: 'pmid:12345', depth: 'metadata' }, undefined, () => {}).then((x) => ({ ok: true, x }), (e) => ({ ok: false, e }));
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `took ${ms} ms`);
  if (!r.ok) assert.match(String(r.e.message), /TIMEOUT|deadline/);
});

test('literature_db: the tool signal reaches the runtime; abort settles promptly and reports the MCP request as abandoned', async () => {
  const world = fakeWorld({ mcpMs: 600 });
  const { broker } = realBroker(world);
  const runner = { run: async ({ execute }) => ({ result: await execute({ effect_id: null }) }), reconcileReadOnly() {} };
  const db = createSupervisedLiteratureTools({ literature: { broker, createLiteratureTools }, runner }).literature_db;
  const ac = new AbortController();
  const p = db.execute('d1', { server: 'pubmed', tool: 'pubmed_fetch_articles', args: { pmids: ['1'] } }, ac.signal).then(() => null, (e) => e);
  while (!world.dispatched.length) await sleep(5);
  const t0 = Date.now(); ac.abort();
  const e = await p;
  assert.ok(e, 'rejects'); assert.ok(Date.now() - t0 < 150);
  assert.match(e.message, /CANCELLED/); assert.match(e.message, /abandoned/); assert.match(e.message, /not stopped/);
});

test('literature_db: a broker double that ignores signals still settles promptly on abort', async () => {
  const broker = { providers: async () => ({ mcp: () => new Promise(() => {}) }) };
  const runner = { run: async ({ execute }) => ({ result: await execute({ effect_id: null }) }), reconcileReadOnly() {} };
  const db = createSupervisedLiteratureTools({ literature: { broker, createLiteratureTools }, runner }).literature_db;
  const ac = new AbortController();
  const p = db.execute('d2', { server: 'pubmed', tool: 'pubmed_fetch_articles', args: { pmids: ['1'] } }, ac.signal).then(() => null, (e) => e);
  await sleep(10); ac.abort();
  const e = await Promise.race([p, sleep(300).then(() => 'hung')]);
  assert.notEqual(e, 'hung'); assert.match(e.message, /CANCELLED/);
});
