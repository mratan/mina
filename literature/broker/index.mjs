// The unified literature broker: four tools (literature_search, paper_resolve, paper_get, citation_expand) over the
// scholarly backends. User documentation: docs/research-literature.md.
//
//   const broker = createBroker();               // live providers, cache in ~/.cache/mina/literature
//   await broker.literature_search({ query, mode });
//   await broker.paper_resolve({ ref });
//   await broker.paper_get({ ref, depth: 'evidence', query });
//   await broker.citation_expand({ ref, direction });
//   await broker.close();
//
// Providers are injected (createBroker({ providers })) so tests run the whole pipeline against fakes.
import { createRuntime, createCache, createLog } from './runtime.mjs';
import { literatureSearch, buildFamilies, DEFAULT_CONFIG } from './search.mjs';
import { paperResolve } from './resolve.mjs';
import { paperGet } from './get.mjs';
import { expandAnchor } from './expand.mjs';

export const VERSION = '0.1.0';

export async function citationExpand(env, { ref, direction = 'both', limit = 25 } = {}) {
  const ctx = { tool: 'citation_expand', direction };
  if (!['references', 'citing', 'both', 'similar'].includes(direction)) return { status: 'invalid', error: 'direction must be references, citing, both or similar (similar: PubMed only)' };
  const res = await paperResolve(env, ref, { ctx, lineage: false });
  if (res.status !== 'ok') return { status: res.status, resolve: res };
  const fam = res.family;
  const pick = (k) => fam.members.find((m) => m[k] && !(k === 'openalex' && m.openalex_conflict))?.[k] ?? null;
  const anchor = { family_id: fam.family_id, openalex: pick('openalex'), pmid: pick('pmid'), arxiv: pick('arxiv'), openalex_conflict: fam.members.find((m) => m.openalex_conflict)?.openalex_conflict ?? null };
  const n = Math.min(100, Math.max(1, Number(limit) || 25));
  const r = await expandAnchor(env, anchor, { direction, limit: n, ctx });
  const pool = r.edges.map((e) => ({ ...e.candidate, _source: `${e.backend}:${e.relation}`, _rank: e.rank, _relation: e.relation }));
  const st = await buildFamilies(env, pool, { ctx });
  const results = st.families.map((f) => {
    const rel = [];
    for (const m of f.members) for (const s of m._sources ?? [m._source]) if (s) { const [backend, relation] = s.split(':'); rel.push({ relation, backend, rank: f.ranks[s] ?? null }); }
    const uniq = [...new Map(rel.map((x) => [`${x.backend}|${x.relation}`, x])).values()];
    return { family_id: f.family_id, title: f.title, year: f.year, venue: f.venue, ids: f.ids, cited_by: f.cited_by, retracted: f.retracted || undefined,
      relations: uniq, anchor: fam.family_id, versions: f.versions.length > 1 ? f.versions : undefined };
  }).sort((a, b) => Math.min(...a.relations.map((x) => x.rank ?? 1e9)) - Math.min(...b.relations.map((x) => x.rank ?? 1e9)));
  return { status: 'ok', anchor: { family_id: fam.family_id, title: fam.canonical.title, ids: { openalex: anchor.openalex, pmid: anchor.pmid } }, direction,
    results, calls: r.calls, notes: [...r.notes, ...(anchor.openalex ? [] : ['the anchor has no usable OpenAlex record: OpenAlex expansion did not run']),
      'OpenAlex related_works is not offered (no relevant papers in testing); Semantic Scholar graph operations are not offered until re-evaluated with an API key'] };
}

// Overall deadline per tool invocation (ms). Inside it every backend call is bounded by what is left; a call that cannot
// start before it returns `timeout` with deadline_truncated, so the tool composes what it has. TOOL_GRACE_MS later the
// invocation is rejected even if non-backend work (PDF text extraction) is still running.
export const TOOL_DEADLINE_MS = { literature_search: 300000, paper_resolve: 120000, paper_get: 600000, citation_expand: 180000, literature_db: 120000 };
export const TOOL_GRACE_MS = 2000;

function cancelledError(name, abandoned) {
  const n = abandoned.length;
  const e = new Error(`CANCELLED ${name}: aborted by the caller; no further backend requests will start.`
    + (n ? ` ${n} in-flight MCP request(s) (${[...new Set(abandoned)].join(', ')}) were abandoned, upstream not stopped: MCP calls cannot be cancelled, and each such lane stays busy until its request finishes.` : '')
    + ' In-flight HTTP requests were sent an abort signal; a request the provider already received may still be billed (its cost estimate is recorded).');
  return Object.assign(e, { code: 'CANCELLED', abandoned });
}
function deadlineError(name, ms, abandoned) {
  const n = abandoned.length;
  return Object.assign(new Error(`TIMEOUT ${name}: the tool deadline of ${ms} ms expired.`
    + (n ? ` ${n} in-flight MCP request(s) (${[...new Set(abandoned)].join(', ')}) were abandoned, upstream not stopped.` : '')), { code: 'TIMEOUT', abandoned });
}

// `providerOptions`: passed to createProviders (a host can supply its own keys and search configuration).
export function createBroker({ providers, providerOptions = {}, runtime, config = {}, cacheDir, log, deadlineMs = {} } = {}) {
  const rt = runtime ?? createRuntime({ cache: createCache(cacheDir === undefined ? {} : { dir: cacheDir }), log: log ?? createLog(cacheDir === undefined ? {} : { dir: cacheDir }) });
  let p = providers;
  const env = { rt, config: { ...DEFAULT_CONFIG, ...config }, get p() { return p; } };
  const ensure = async () => { if (!p) { const m = await import('./providers.mjs'); p = m.createProviders(rt, providerOptions); } };
  const deadlines = { ...TOOL_DEADLINE_MS, ...deadlineMs };
  const clock = () => (typeof rt.now === 'function' ? rt.now() : Date.now());
  /**
   * Run one tool invocation under its AbortSignal and overall deadline. The signal and deadline reach every runtime call made
   * inside (runtime.scoped; also env.signal / env.deadline for the pipeline's own checks). On abort the invocation rejects
   * promptly with a CANCELLED error and nothing queued starts afterwards; requests already sent are reported honestly
   * (MCP: abandoned, upstream not stopped).
   */
  function invoke(name, fn, { signal, deadlineMs: ms } = {}) {
    const limit = Number.isFinite(ms) && ms > 0 ? ms : deadlines[name] ?? TOOL_DEADLINE_MS.literature_search;
    if (signal?.aborted) return Promise.reject(cancelledError(name, []));
    const scoped = typeof rt.scoped === 'function' ? rt.scoped : (_o, f) => f({ signal, deadline: null, abandoned: () => [], abort() {}, dispose() {} });
    return scoped({ signal, deadline: clock() + limit }, (scope) => new Promise((resolve, reject) => {
      let done = false;
      const finish = (f, v) => { if (done) return; done = true; clearTimeout(backstop); signal?.removeEventListener('abort', onAbort); f(v); };
      // One turn later, so the runtime has detached every waiter and marked what it abandoned.
      const onAbort = () => setImmediate(() => finish(reject, cancelledError(name, scope.abandoned())));
      signal?.addEventListener('abort', onAbort, { once: true });
      const backstop = setTimeout(() => { scope.abort(); setImmediate(() => finish(reject, deadlineError(name, limit, scope.abandoned()))); }, limit + TOOL_GRACE_MS);
      backstop.unref?.();
      const callEnv = { rt, config: env.config, get p() { return p; }, signal: scope.signal, deadline: scope.deadline };
      const work = Promise.resolve().then(() => fn(callEnv));
      // After an abort the invocation is CANCELLED, never a partial "ok" built from cancelled calls (onAbort rejects).
      work.then((v) => { if (!signal?.aborted) finish(resolve, v); }, (e) => { if (!signal?.aborted) finish(reject, e); });
      work.then(scope.dispose, scope.dispose);
    }));
  }
  const wrap = (name, fn) => (params, opts) => invoke(name, async (e) => { await ensure(); return fn(e, params ?? {}); }, opts);
  return {
    env, runtime: rt, invoke,
    async providers() { await ensure(); return p; },
    literature_search: wrap('literature_search', literatureSearch),
    paper_resolve: wrap('paper_resolve', (e, prm) => paperResolve(e, prm.ref, { lineage: prm.lineage !== false, ctx: { tool: 'paper_resolve' } })),
    paper_get: wrap('paper_get', paperGet),
    citation_expand: wrap('citation_expand', citationExpand),
    async close() { if (p?.close) await p.close(); },
  };
}
