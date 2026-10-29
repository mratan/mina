// Runtime coordination under concurrency: in-flight coalescing, health and
// cache rechecked at dispatch, OpenAlex budget reservations, a shared on-disk spend ledger, end-to-end deadlines and
// cancellation. Every exec is a fake; nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime, createCache, createLog, sleep } from '../broker/runtime.mjs';

const mk = (opts = {}) => {
  const events = [];
  const rt = createRuntime({ cache: createCache({ dir: null }), log: createLog({ dir: null, sink: (e) => events.push(e) }), pacing: {}, ...opts });
  return { rt, events };
};
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

// ---- coalescing --------------------------------------------------------------------------------------------------------------
test('two simultaneous identical cacheable calls run the provider once; each caller is logged with its own ctx', async () => {
  const { rt, events } = mk();
  let n = 0; const g = gate();
  const exec = async () => { n++; await g.p; return { data: { v: 1 } }; };
  const call = (who) => rt.call({ backend: 'pubmed', op: 'search', args: { q: 'x' }, cacheNs: 'search', ctx: { caller: who }, exec });
  const a = call('A'); const b = call('B');
  await sleep(20); g.open();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(n, 1, 'one provider execution for two identical in-flight requests');
  assert.equal(ra.outcome, 'ok'); assert.equal(rb.outcome, 'ok');
  assert.deepEqual(ra.data, rb.data);
  assert.equal([ra, rb].filter((r) => r.coalesced).length, 1, 'the joining caller is marked coalesced');
  const logged = events.filter((e) => e.type === 'backend');
  assert.deepEqual(logged.map((e) => e.ctx.caller).sort(), ['A', 'B'], 'distinct caller attribution');
  assert.equal(logged.filter((e) => e.coalesced).length, 1);
  const third = await call('C');
  assert.equal(third.cached, true); assert.equal(n, 1);
});

test('a coalesced failure is shared, not cached, and the in-flight entry is cleaned up', async () => {
  const { rt } = mk();
  let n = 0; const g = gate();
  const exec = async () => { n++; await g.p; return { isError: true, status: 400, text: 'HTTP 400 bad' }; };
  const call = () => rt.call({ backend: 'europepmc', op: 'search', args: { q: 'y' }, cacheNs: 'search', retries: 0, exec });
  const both = Promise.all([call(), call()]);
  await sleep(10); g.open();
  const rs = await both;
  assert.equal(n, 1); assert.deepEqual(rs.map((r) => r.outcome), ['error', 'error']);
  await call();
  assert.equal(n, 2, 'after the shared failure settles, a new call executes again');
  let m = 0;
  const thrower = () => rt.call({ backend: 'europepmc', op: 'thrower', args: {}, cacheNs: 'search', retries: 0, exec: async () => { m++; throw new Error('kaput'); } });
  assert.equal((await thrower()).outcome, 'error');
  assert.equal((await thrower()).outcome, 'error');
  assert.equal(m, 2, 'a thrown exec also clears the in-flight entry');
});

test('intentionally uncached operations are not coalesced', async () => {
  const { rt } = mk();
  let n = 0;
  const exec = async () => { n++; await sleep(10); return { data: {} }; };
  await Promise.all([1, 2].map(() => rt.call({ backend: 'web', op: 'pdf', args: { url: 'u' }, cacheNs: null, exec })));
  assert.equal(n, 2);
});

// ---- dispatch-time rechecks ---------------------------------------------------------------------------------------------------
test('a call queued behind a 429 in the same lane is skipped at dispatch, not executed', async () => {
  const { rt } = mk({ pacing: { europepmc: 30 } });
  let second = 0;
  const a = rt.call({ backend: 'europepmc', op: 'search', args: { q: 1 }, cacheNs: null, retries: 0, exec: async () => { await sleep(20); return { isError: true, status: 429, text: 'HTTP 429 Too Many Requests' }; } });
  const b = rt.call({ backend: 'europepmc', op: 'search', args: { q: 2 }, cacheNs: null, retries: 0, exec: async () => { second++; return { data: {} }; } });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.outcome, 'rate_limited');
  assert.equal(rb.outcome, 'skipped_unhealthy');
  assert.equal(second, 0);
});

test('the cache is rechecked at dispatch: a queued call answered meanwhile does not execute', async () => {
  const { rt } = mk({ pacing: { pubmed: 0 } });
  const g = gate(); let yRan = 0;
  const x = rt.call({ backend: 'pubmed', op: 'search', args: { q: 'x' }, cacheNs: 'search', exec: async () => { await g.p; return { data: { x: 1 } }; } });
  const y = rt.call({ backend: 'pubmed', op: 'search', args: { q: 'y' }, cacheNs: 'search', exec: async () => { yRan++; return { data: { y: 'live' } }; } });
  await sleep(10);
  rt.cache.put('search', ['pubmed', 'search', { q: 'y' }], { backend: 'pubmed', op: 'search', outcome: 'ok', data: { y: 'cached' }, error: null, cost_usd: 0, attempts: 1 });
  g.open();
  await x; const ry = await y;
  assert.equal(yRan, 0); assert.equal(ry.cached, true); assert.deepEqual(ry.data, { y: 'cached' });
});

test('lanes are separate: a rate limit in one lane does not skip another; identical args in two lanes are not merged', async () => {
  const { rt } = mk();
  await rt.call({ backend: 'web', op: 'page', lane: 'arxiv', args: { u: 1 }, cacheNs: null, retries: 0, exec: async () => ({ isError: true, status: 429, text: '429' }) });
  const other = await rt.call({ backend: 'web', op: 'page', lane: 'web', args: { u: 1 }, cacheNs: null, exec: async () => ({ data: { ok: 1 } }) });
  assert.equal(other.outcome, 'ok');
  const blocked = await rt.call({ backend: 'web', op: 'page', lane: 'arxiv', args: { u: 2 }, cacheNs: null, exec: async () => ({ data: {} }) });
  assert.equal(blocked.outcome, 'skipped_unhealthy');
  let n = 0; const g = gate();
  const exec = async () => { n++; await g.p; return { data: {} }; };
  const both = Promise.all(['l1', 'l2'].map((lane) => rt.call({ backend: 'pubmed', op: 'search', lane, args: { q: 'same' }, cacheNs: 'search', exec })));
  await sleep(10); g.open(); await both;
  assert.equal(n, 2);
});

// ---- budget ---------------------------------------------------------------------------------------------------------------------
test('budget: concurrent paid calls reserve spend before dispatch (USD 0.003 available, two USD 0.002 calls)', async () => {
  const { rt } = mk({ budgetUsd: 0.053, reserveUsd: 0.05 });
  let n = 0; const g = gate();
  const exec = async () => { n++; await g.p; return { data: { results: [1] } }; };
  const a = rt.call({ backend: 'openalex', op: 'kw', args: { q: 1 }, cacheNs: null, costUsd: 0.002, exec });
  const b = rt.call({ backend: 'openalex', op: 'semantic', lane: 'openalex_semantic', args: { q: 2 }, cacheNs: null, costUsd: 0.002, exec });
  await sleep(20); g.open();
  const rs = await Promise.all([a, b]);
  assert.deepEqual(rs.map((r) => r.outcome).sort(), ['budget_exhausted', 'ok']);
  assert.equal(n, 1);
  assert.ok(Math.abs(rt.budget.spent() - 0.002) < 1e-9, `spent ${rt.budget.spent()}`);
  assert.equal(rt.budget.outstanding(), 0);
});

test('budget: a failed call releases its reservation; a timed-out call is settled conservatively', async () => {
  const { rt } = mk({ budgetUsd: 0.055, reserveUsd: 0.05 });
  const f = await rt.call({ backend: 'openalex', op: 'kw', args: { q: 'f' }, cacheNs: null, retries: 0, costUsd: 0.002, exec: async () => ({ isError: true, status: 400, text: 'HTTP 400' }) });
  assert.equal(f.outcome, 'error'); assert.equal(rt.budget.spent(), 0); assert.equal(rt.budget.outstanding(), 0);
  const t = await rt.call({ backend: 'openalex', op: 'kw', args: { q: 't' }, cacheNs: null, retries: 0, timeoutMs: 20, costUsd: 0.002, exec: () => new Promise(() => {}) });
  assert.equal(t.outcome, 'timeout'); assert.equal(t.cost_uncertain, true);
  assert.ok(Math.abs(rt.budget.spent() - 0.002) < 1e-9, 'the request may have been billed: the estimate is recorded');
  assert.equal(rt.budget.outstanding(), 0);
  const ok = await rt.call({ backend: 'openalex', op: 'kw', args: { q: 'o' }, cacheNs: null, costUsd: 0.002, exec: async () => ({ data: { results: [1] }, costUsd: 0.001 }) });
  assert.equal(ok.outcome, 'ok');
  assert.ok(Math.abs(rt.budget.spent() - 0.003) < 1e-9, 'success settles at the reported cost');
});

test('budget: two runtimes sharing a cache directory do not overwrite each other\'s spend', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'litrt-'));
  try {
    const mkd = () => createRuntime({ cache: createCache({ dir }), log: createLog({ dir: null }), budgetUsd: 1, reserveUsd: 0, pacing: {} });
    const a = mkd(); const b = mkd();
    const exec = async () => ({ data: { results: [1] } });
    await a.call({ backend: 'openalex', op: 'kw', args: { q: 'a' }, cacheNs: null, costUsd: 0.002, exec });
    await b.call({ backend: 'openalex', op: 'kw', args: { q: 'b' }, cacheNs: null, costUsd: 0.002, exec });
    await a.call({ backend: 'openalex', op: 'kw', args: { q: 'c' }, cacheNs: null, costUsd: 0.002, exec });
    assert.ok(Math.abs(a.budget.spent() - 0.006) < 1e-9, `a sees ${a.budget.spent()}`);
    assert.ok(Math.abs(b.budget.spent() - 0.006) < 1e-9, `b sees ${b.budget.spent()}`);
    await b.call({ backend: 'openalex', op: 'kw', args: { q: 'x' }, cacheNs: null, retries: 0, costUsd: 0.001, exec: async () => ({ isError: true, status: 429, text: 'Insufficient budget' }) });
    assert.equal(a.budget.status().exhausted, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('budget: identical concurrent paid calls are coalesced into one reservation and one spend', async () => {
  const { rt } = mk({ budgetUsd: 1, reserveUsd: 0 });
  let n = 0; const g = gate();
  const exec = async () => { n++; await g.p; return { data: { results: [1] } }; };
  const call = () => rt.call({ backend: 'openalex', op: 'semantic', lane: 'openalex_semantic', args: { q: 'same' }, cacheNs: 'search', costUsd: 0.001, exec });
  const both = Promise.all([call(), call()]);
  await sleep(10);
  assert.ok(Math.abs(rt.budget.outstanding() - 0.001) < 1e-9, 'one reservation for the shared request');
  g.open(); const rs = await both;
  assert.equal(n, 1);
  assert.ok(Math.abs(rt.budget.spent() - 0.001) < 1e-9);
  assert.deepEqual(rs.map((r) => r.cost_usd).sort(), [0, 0.001], 'the cost is attributed to the caller that spent it');
});

test('a failed cache write does not fail the call, strand waiters or leave an in-flight entry', async () => {
  const cache = createCache({ dir: null });
  const put = cache.put; let fail = true;
  cache.put = (...a) => { if (fail) { fail = false; throw new Error('disk full'); } return put(...a); };
  const rt = createRuntime({ cache, log: createLog({ dir: null }), pacing: { pubmed: 0 } });
  let n = 0;
  const call = () => rt.call({ backend: 'pubmed', op: 'search', args: { q: 'w' }, cacheNs: 'search', exec: async () => { n++; return { data: {} }; } });
  const rs = await Promise.all([call(), call()]);
  assert.deepEqual(rs.map((r) => r.outcome), ['ok', 'ok'], 'the provider answer is still returned');
  assert.equal(n, 1);
  assert.equal((await call()).outcome, 'ok'); assert.equal(n, 2, 'nothing was cached, and nothing is left in flight');
});

// ---- deadlines and cancellation ----------------------------------------------------------------------------------------------
test('the deadline includes queue wait: a call that cannot dispatch in time times out and never runs', async () => {
  const { rt } = mk();
  const g = gate(); let late = 0;
  const first = rt.call({ backend: 'arxiv', op: 'search', args: { q: 1 }, cacheNs: null, exec: async () => { await g.p; return { data: {} }; } });
  const t0 = Date.now();
  const second = await rt.call({ backend: 'arxiv', op: 'search', args: { q: 2 }, cacheNs: null, deadlineMs: 60, exec: async () => { late++; return { data: {} }; } });
  assert.equal(second.outcome, 'timeout'); assert.match(second.error, /queue/i);
  assert.ok(Date.now() - t0 < 1000);
  g.open(); await first; await sleep(20);
  assert.equal(late, 0, 'an expired queued call is dropped from the lane');
  const third = await rt.call({ backend: 'arxiv', op: 'search', args: { q: 3 }, cacheNs: null, exec: async () => ({ data: {} }) });
  assert.equal(third.outcome, 'ok', 'queue expiry is local congestion: it does not bench the lane');
});

test('exec receives an AbortSignal that fires on the hard timeout', async () => {
  const { rt } = mk();
  let seen = null;
  const r = await rt.call({ backend: 'doi_org', op: 'csl', args: {}, cacheNs: null, retries: 0, timeoutMs: 30, exec: (signal) => { seen = signal; return new Promise(() => {}); } });
  assert.equal(r.outcome, 'timeout');
  assert.ok(seen && typeof seen.aborted === 'boolean', 'exec(signal) is passed a signal');
  assert.equal(seen.aborted, true);
});

test('a caller signal detaches only that caller; the shared execution is aborted when no caller is left', async () => {
  const { rt } = mk();
  let sig = null; let n = 0;
  const exec = (signal) => { n++; sig = signal; return new Promise((res) => signal.addEventListener('abort', () => res({ isError: true, text: 'AbortError' }))); };
  const c1 = new AbortController(); const c2 = new AbortController();
  const p1 = rt.call({ backend: 'pubmed', op: 'search', args: { q: 'z' }, cacheNs: 'search', retries: 0, signal: c1.signal, exec });
  const p2 = rt.call({ backend: 'pubmed', op: 'search', args: { q: 'z' }, cacheNs: 'search', retries: 0, signal: c2.signal, exec });
  await sleep(10);
  c1.abort();
  const r1 = await p1;
  assert.equal(r1.outcome, 'cancelled');
  assert.equal(sig.aborted, false, 'the other caller still waits');
  c2.abort();
  assert.equal((await p2).outcome, 'cancelled');
  await sleep(5);
  assert.equal(sig.aborted, true); assert.equal(n, 1);
});
