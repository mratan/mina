// Broker runtime: cache, structured log, per-backend hard timeouts and pacing, outcome
// classification, backend health, and the OpenAlex daily budget. Every provider call goes through runtime.call().
//
// Design rules:
//   - a rate-limit event is never an empty result; only an error response or HTTP 429 counts as rate limited;
//   - retries are bounded (at most one, and only for transient faults); nothing retries forever;
//   - secret values never reach a log line or a cache file.
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setMaxListeners } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const sha = (s) => createHash('sha256').update(s).digest('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A sleep that ends early when the signal aborts. */
const sleepUnless = (ms, signal) => new Promise((r) => {
  if (signal?.aborted) { r(); return; }
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); r(); }
  signal?.addEventListener('abort', done, { once: true });
});
/** Results handed to more than one holder (the cache, coalesced callers, cache hits) get their own copy of `data`, so one
 *  holder's mutation cannot leak into another's. structuredClone is native; a value it cannot copy is passed as is. */
export const cloneData = (d) => { if (d === null || typeof d !== 'object') return d; try { return structuredClone(d); } catch { return d; } };
/** One signal that aborts when any of the given ones does; dispose() removes the listeners it added. */
function linkSignals(...signals) {
  const list = signals.filter(Boolean);
  if (list.length <= 1) return { signal: list[0] ?? null, dispose() {} };
  const ac = new AbortController();
  const on = () => ac.abort();
  for (const s of list) { if (s.aborted) { ac.abort(); break; } s.addEventListener('abort', on, { once: true }); }
  return { signal: ac.signal, dispose() { for (const s of list) s.removeEventListener('abort', on); } };
}

// ---- invocation scope ----------------------------------------------------------------------------------------------------
// A tool invocation (createBroker's literature_search, paper_get, ...) runs inside a scope carrying the tool's AbortSignal and
// its overall deadline. Every runtime.call() made inside the scope, however deep in search, resolve, get or the providers,
// inherits both: the signal is merged with the call's own and the deadline is the earlier of the two. AsyncLocalStorage
// carries the scope across awaits, so no call site can forget to pass it.
const SCOPE = new AsyncLocalStorage();
export const currentScope = () => SCOPE.getStore() ?? null;
/** The longest an abandoned non-cancellable request (an MCP call) keeps its lane: the MCP client's own request timeout is
 *  180 s (providers.mjs), so the upstream promise has settled by then unless the client itself is broken. */
export const ABANDONED_HOLD_MAX_MS = 190000;
export const DAY = 86400000;

// ---- cache --------------------------------------------------------------------------------------------------------------
// Namespaces and their time-to-live. Paper text and parsed indexes are immutable per (family, version, representation);
// a cached "unavailable" expires after 7 days because open-access copies appear later; search results expire after a day.
export const TTL = {
  search: DAY, backend: DAY, meta: 7 * DAY, idmap: 30 * DAY, family: 7 * DAY, expand: 7 * DAY,
  fulltext: Infinity, fulltext_unavailable: 7 * DAY, index: Infinity, budget: 2 * DAY, continuation: DAY,
};
export function defaultCacheDir() {
  return process.env.LIT_BROKER_CACHE_DIR || join(homedir(), '.cache', 'mina', 'literature');
}
export function createCache({ dir = defaultCacheDir(), now = () => Date.now() } = {}) {
  const mem = new Map();
  const path = (ns, h) => join(dir, ns, h.slice(0, 2), `${h}.json`);
  const stats = { hits: 0, misses: 0, writes: 0 };
  const fresh = new WeakSet(); // entries just parsed from disk: nobody else holds them
  return {
    dir, stats,
    /** True when `entry` was parsed from disk by this get (a private object), false for the shared in-memory entry. */
    isFresh: (entry) => fresh.has(entry),
    key: (parts) => sha(JSON.stringify(parts)),
    get(ns, key, { ttlMs = TTL[ns] ?? DAY } = {}) {
      const h = typeof key === 'string' && /^[0-9a-f]{64}$/.test(key) ? key : sha(JSON.stringify(key));
      let entry = mem.get(`${ns}/${h}`);
      if (!entry && dir) { const p = path(ns, h); if (existsSync(p)) { try { entry = JSON.parse(readFileSync(p, 'utf8')); fresh.add(entry); } catch { entry = null; } } }
      if (!entry || (Number.isFinite(entry.ttl_ms ?? ttlMs) && now() - entry.stored_at > (entry.ttl_ms ?? ttlMs))) { stats.misses++; return null; }
      stats.hits++;
      return entry;
    },
    put(ns, key, value, { ttlMs, provenance } = {}) {
      const h = typeof key === 'string' && /^[0-9a-f]{64}$/.test(key) ? key : sha(JSON.stringify(key));
      const entry = { stored_at: now(), ttl_ms: Number.isFinite(ttlMs) ? ttlMs : undefined, provenance, value };
      mem.set(`${ns}/${h}`, entry);
      if (dir) { const p = path(ns, h); mkdirSync(dirname(p), { recursive: true }); const tmp = `${p}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(entry)); renameSync(tmp, p); }
      stats.writes++;
      return h;
    },
  };
}

// ---- structured log -----------------------------------------------------------------------------------------------------
export function createLog({ dir = defaultCacheDir(), secrets = [], sink = null } = {}) {
  const values = secrets.filter((v) => v && String(v).length >= 8).map(String);
  const scrub = (obj) => {
    let s = JSON.stringify(obj);
    for (const v of values) s = s.split(v).join('<redacted>');
    s = s.replace(/(api_key=)[^&\s"\\]+/gi, '$1<redacted>');
    return s;
  };
  return {
    scrub,
    event(type, fields) {
      const line = scrub({ ts: new Date().toISOString(), type, ...fields });
      if (sink) sink(JSON.parse(line));
      if (!dir) return;
      const p = join(dir, 'logs', `${new Date().toISOString().slice(0, 10)}.jsonl`);
      try { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, `${line}\n`); } catch { /* logging never breaks a search */ }
    },
  };
}

// ---- outcome classification --------------------------------------------------------------------------------------------
const RATE = /rate.?limit|too many requests|\b429\b|error code:? ?1015|retry_after|throttl/i;
const BUDGET = /insufficient budget|budget (is )?exhausted|daily budget|credits? (are )?exhausted/i;
const TRANSIENT = /Failed to embed|\b50[234]\b|ECONNRESET|socket hang up|EAI_AGAIN|ETIMEDOUT/i;
const NOT_FOUND = /\b404\b|not.?found|no such|does not exist/i;
/** Outcomes that say "not now", never "does not exist": nothing built from them is negative-cached or cached as final, and
 *  coverage reports them as failed backends. skipped_busy: the lane was held by an abandoned, still-running upstream request
 *  (see runJob); 'error' is included because an unclassified failure is not evidence of absence either. */
export const TEMPORARY_OUTCOMES = Object.freeze(['rate_limited', 'timeout', 'cancelled', 'skipped_unhealthy', 'skipped_busy', 'transient', 'budget_exhausted', 'error']);
/** ok | empty | not_found | rate_limited | budget_exhausted | cancelled | timeout | transient | unavailable | error
 *  (the runtime adds skipped_unhealthy and skipped_busy without calling a provider) */
export function classify({ isError, text, status, empty }) {
  const t = String(text ?? '');
  if (isError && BUDGET.test(t)) return 'budget_exhausted';
  if (status === 429 || (isError && RATE.test(t))) return 'rate_limited';
  // The broker's own hard timeout (label "TIMEOUT backend.op") is a timeout; a provider reporting that its upstream timed
  // out (the arXiv MCP: "arXiv API timed out after 15000ms") is a transient fault worth one bounded retry.
  if (isError && /^CANCELLED /.test(t)) return 'cancelled';
  if (isError && /^TIMEOUT /.test(t)) return 'timeout';
  if (isError && /timed out|AbortError/i.test(t)) return 'transient';
  if (isError && (status === 404 || NOT_FOUND.test(t.slice(0, 300)))) return 'not_found';
  if (isError && (TRANSIENT.test(t) || (status >= 500 && status < 600))) return 'transient';
  if (isError || (status && status >= 400)) return 'error';
  return empty ? 'empty' : 'ok';
}

// ---- runtime -------------------------------------------------------------------------------------------------------------
// Pacing per backend (minimum ms between calls), from each provider's documented or observed rate limits.
export const PACING = { openalex: 120, openalex_semantic: 1000, openalex_content: 400, pubmed: 350, europepmc: 350, biorxiv: 600, biorxiv_page: 20000,
  arxiv: 3100, semantic_scholar: 1100, semantic_scholar_keyless: 4000, exa: 200, searxng: 800, doi_org: 300, web: 800 };
// Hard timeouts per backend, applied outside the MCP: Semantic Scholar keyless was seen to retry
// internally for 397 s; it gets 25 s here. Full-text and PDF operations get longer.
export const TIMEOUTS = { default: 30000, openalex: 30000, openalex_semantic: 30000, openalex_content: 60000, pubmed: 45000, europepmc: 30000,
  biorxiv: 30000, biorxiv_page: 60000, arxiv: 30000, semantic_scholar: 25000, exa: 30000, searxng: 25000, doi_org: 20000, web: 45000, pdf: 120000, fulltext: 90000 };

// ---- OpenAlex spend ledger ------------------------------------------------------------------------------------------------
// Settled spend is appended to <cache dir>/budget-ledger/<UTC day>.jsonl, one line per paid call, and the day's spend is the
// sum of the lines. Earlier the spend was one read-modify-write cache entry, and a runtime's in-memory copy
// shadowed the file: two processes (a session and its delegated children) silently overwrote each other's spend.
// Appends do not overwrite. Reservations for calls still in flight are shared by runtimes in this process that use the
// same cache directory (or the same in-memory cache object); they are NOT visible to other processes, so concurrent
// processes can still overshoot by at most their in-flight paid calls. Nothing here enforces a budget across hosts.
const LEDGERS_BY_DIR = new Map(); // cache dir → { mem: entry[], reservations: Map<id, usd> }
const LEDGERS_BY_CACHE = new WeakMap(); // in-memory cache object → same
const ledgerFor = (cache) => {
  const m = cache.dir ? LEDGERS_BY_DIR : LEDGERS_BY_CACHE; const k = cache.dir || cache;
  if (!m.has(k)) m.set(k, { mem: [], reservations: new Map() });
  return m.get(k);
};
const EPS = 1e-9;
let reservationSeq = 0;

export function createRuntime({ cache = createCache(), log = createLog(), budgetUsd = Number(process.env.LIT_BROKER_OPENALEX_BUDGET_USD || 1), reserveUsd = 0.05,
  now = () => Date.now(), pacing = {} } = {}) {
  const PACE = { ...PACING, ...pacing };
  const lanes = new Map();
  const health = new Map(); // lane → { state, until, reason }
  const timeouts = new Map(); // lane → consecutive hard timeouts
  const inflight = new Map(); // coalescing key → job
  const shared = ledgerFor(cache);
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const budgetKey = () => ['openalex-spend', day()]; // legacy single-entry record, still read for compatibility
  const ledgerPath = () => join(cache.dir, 'budget-ledger', `${day()}.jsonl`);
  const readLedger = () => {
    const d = day();
    // In memory: the ledger itself without a cache directory, or entries whose append failed (never dropped silently).
    const mem = shared.mem.filter((e) => e.day === d);
    if (!cache.dir) return mem;
    let text = ''; try { text = readFileSync(ledgerPath(), 'utf8'); } catch { return mem; }
    return [...text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean), ...mem];
  };
  const appendLedger = (entry) => {
    const e = { day: day(), ts: now(), pid: process.pid, ...entry };
    if (!cache.dir) { shared.mem.push(e); return; }
    try { mkdirSync(dirname(ledgerPath()), { recursive: true }); appendFileSync(ledgerPath(), `${JSON.stringify(e)}\n`); } catch { shared.mem.push(e); }
  };
  const legacy = () => cache.get('budget', budgetKey())?.value ?? {};
  const budget = {
    limit: budgetUsd, reserve: reserveUsd,
    spent() { return (legacy().spent ?? 0) + readLedger().filter((e) => e.kind === 'spend').reduce((a, e) => a + (Number(e.usd) || 0), 0); },
    /** Paid cost reserved by calls admitted but not yet settled (this process, this cache directory). */
    outstanding() { let s = 0; for (const v of shared.reservations.values()) s += v; return s; },
    exhaustedUntil() { return Math.max(legacy().exhausted_until ?? 0, ...readLedger().filter((e) => e.kind === 'exhausted').map((e) => e.until ?? 0)); },
    add(usd) { if (usd) appendLedger({ kind: 'spend', usd }); },
    markExhausted(reason) {
      const midnight = new Date(now()); midnight.setUTCHours(24, 0, 0, 0);
      appendLedger({ kind: 'exhausted', until: midnight.getTime(), reason: String(reason ?? '').slice(0, 200) });
    },
    /** Can an operation of this cost run? Free operations (get by id) always can, unless OpenAlex said the budget is gone. */
    allows(usd) {
      if (this.exhaustedUntil() > now()) return false;
      return !usd || this.spent() + this.outstanding() + usd <= this.limit - this.reserve + EPS;
    },
    /** Reserve a paid call's cost before it is queued; null when it does not fit. Synchronous, so concurrent admissions in
     *  this process cannot both pass the same check. */
    reserveFor(usd) {
      if (!this.allows(usd)) return null;
      const id = ++reservationSeq;
      if (usd) shared.reservations.set(id, usd);
      return id;
    },
    /** Release a reservation and record what the call actually cost. */
    settle(id, usd) { shared.reservations.delete(id); this.add(usd); },
    status() {
      const s = this.spent(); const o = this.outstanding();
      return { spent_usd: +s.toFixed(4), outstanding_usd: o ? +o.toFixed(4) : undefined, limit_usd: this.limit,
        exhausted: this.exhaustedUntil() > now() || s + o >= this.limit - this.reserve - EPS };
    },
  };

  function lane(name) { if (!lanes.has(name)) lanes.set(name, { tail: Promise.resolve(), last: 0, held: 0, heldBy: null, waiting: new Set() }); return lanes.get(name); }
  /** Wait for this lane's turn (serial, paced). Resolves { release(used) } or { expired: 'deadline' | 'cancelled' | 'busy' };
   *  an expired waiter gives its turn away without running or consuming the pacing gap. 'busy': the lane is held by an
   *  abandoned upstream request (holdLane), so the wait could only end at that request's settlement or the caller's
   *  deadline, whichever is first; it fails at once instead (queued: whether the caller had been waiting in the queue). */
  function acquireLane(name, deadline, signal) {
    const l = lane(name);
    if (l.held) return Promise.resolve({ expired: 'busy', heldBy: l.heldBy, queued: false });
    let releaseTurn; const turn = new Promise((r) => { releaseTurn = r; });
    const prev = l.tail;
    l.tail = prev.then(() => turn);
    return new Promise((resolveSlot) => {
      let done = false; let timer = null;
      const onAbort = () => finish({ expired: 'cancelled' });
      const finish = (v) => {
        if (done) return false;
        done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); l.waiting.delete(onBusy);
        if (v.expired) releaseTurn();
        resolveSlot(v); return true;
      };
      const onBusy = () => finish({ expired: 'busy', heldBy: l.heldBy, queued: true });
      l.waiting.add(onBusy);
      timer = setTimeout(() => finish({ expired: 'deadline' }), Math.max(0, deadline - now()));
      if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
      prev.then(async () => {
        if (done) return;
        const wait = l.last + (PACE[name] ?? 300) - now();
        if (wait > 0) await sleep(Math.min(wait, 30000));
        let released = false;
        const release = (used = true) => { if (released) return; released = true; if (used) l.last = now(); releaseTurn(); };
        if (!finish({ release })) release(false);
      });
    });
  }
  /** Mark a lane held by an abandoned upstream request until `settled` resolves: every caller queued on it now, and every
   *  caller arriving while it is held, gets skipped_busy at once instead of waiting out its deadline in the queue. */
  function holdLane(name, label, settled) {
    const l = lane(name);
    l.held++; l.heldBy = label;
    for (const busy of [...l.waiting]) busy();
    settled.then(() => { if (--l.held === 0) l.heldBy = null; });
  }
  /** Race an operation against a hard timeout and a cancellation signal; on either, the operation's controller is aborted so
   *  providers that honour AbortSignal stop their upstream request. */
  function withTimeout(promise, ms, label, controller = null, cancel = null) {
    let t; let onCancel;
    const guards = new Promise((_, rej) => {
      const guard = (m) => Object.assign(new Error(m), { guard: true });
      t = setTimeout(() => { controller?.abort(new Error(`TIMEOUT ${label} after ${ms} ms`)); rej(guard(`TIMEOUT ${label} after ${ms} ms`)); }, ms);
      if (cancel) {
        onCancel = () => { controller?.abort(new Error(`CANCELLED ${label}`)); rej(guard(`CANCELLED ${label}: no caller is waiting`)); };
        if (cancel.aborted) onCancel(); else cancel.addEventListener('abort', onCancel, { once: true });
      }
    });
    return Promise.race([promise, guards]).finally(() => { clearTimeout(t); cancel?.removeEventListener('abort', onCancel); });
  }

  const backendHealth = {
    get(name) { const h = health.get(name); if (h && h.until && h.until < now()) { health.delete(name); return { state: 'healthy' }; } return h ?? { state: 'healthy' }; },
    mark(name, state, ms, reason) { health.set(name, { state, until: now() + ms, reason }); },
  };

  const local = (backend, op, outcome, error, extra = {}) => ({ backend, op, outcome, ms: 0, data: null, error, cached: false, cost_usd: 0, attempts: 0, ...extra });
  // A cache hit cost nothing now: cost_usd is 0 (summing the log never double-counts); original_cost_usd is what the
  // stored answer cost when it was fetched.
  const cacheHit = (cacheNs, ckey, ttlMs) => {
    if (!cacheNs) return null;
    const hit = cache.get(cacheNs, ckey, ttlMs ? { ttlMs } : {});
    if (!hit) return null;
    const v = hit.value;
    return { ...v, data: cache.isFresh?.(hit) ? v.data : cloneData(v.data), cached: true, ms: 0, cost_usd: 0, original_cost_usd: v.cost_usd || undefined, cost_uncertain: undefined };
  };
  const unhealthy = (backend, op, hk) => {
    const h = backendHealth.get(hk);
    return h.state === 'temporarily_unhealthy' ? local(backend, op, 'skipped_unhealthy', h.reason) : null;
  };
  const budgetOut = (backend, op) => local(backend, op, 'budget_exhausted', `OpenAlex daily budget: ${JSON.stringify(budget.status())}`);

  /** One provider execution, shared by every caller that joined it. Owns the budget reservation, the lane turn, retries,
   *  health bookkeeping and the cache write. Never rejects.
   *  Cost: the sum of what the attempts that actually ran cost (a transient failure may report a cost; a retry answered from
   *  the cache at dispatch costs nothing). The reservation settles at that sum.
   *  An attempt abandoned by timeout or cancellation whose executor cannot be cancelled (cancellable: false — the MCP
   *  servers) is still running upstream: the result says so (upstream: 'abandoned_not_stopped') and the lane stays busy
   *  until the upstream call settles (bounded by ABANDONED_HOLD_MAX_MS), so pacing still holds for the provider. While it is
   *  held, queued and new calls on the lane return skipped_busy at once (holdLane) rather than each waiting out its deadline. */
  async function runJob(spec, job) {
    const { backend, op, exec, hk, cacheNs, ckey, ttlMs, costUsd, retries, tmo, deadline, reservation, cancellable } = spec;
    const isOA = backend.startsWith('openalex');
    let attempts = 0; let res = null; let executed = false; let uncertain = false; let spent = 0; let local_ = false;
    const t0 = now();
    try {
      while (attempts <= retries) {
        const slot = await acquireLane(hk, deadline, job.controller.signal);
        if (slot.expired) {
          // Queue expiry is local congestion (or the caller's deadline), never evidence about the backend. Neither is a held
          // lane: skipped_busy is a temporary outcome and does not touch health or the timeout count.
          res = slot.expired === 'deadline'
            ? local(backend, op, 'timeout', `TIMEOUT ${backend}.${op}: deadline expired after ${now() - t0} ms waiting in the ${hk} lane queue`, { queued: true, deadline_truncated: true })
            : slot.expired === 'busy'
              ? local(backend, op, 'skipped_busy', `${hk} lane held by an abandoned upstream request (${slot.heldBy ?? 'request'}, still running upstream; released when it settles, at most ${Math.round(ABANDONED_HOLD_MAX_MS / 1000)} s after it started); not dispatched, try again later`,
                { ...(slot.queued ? { queued: true } : {}), held_by: slot.heldBy ?? undefined })
              : local(backend, op, 'cancelled', `CANCELLED ${backend}.${op}: no caller is waiting`, { queued: true });
          if (attempts) { res.attempts = attempts; res.cost_usd = spent; if (uncertain) res.cost_uncertain = true; }
          local_ = true;
          break;
        }
        let used = false; let hold = null;
        try {
          // Rechecked at dispatch, in the entry path's order: the answer may have been cached, the lane benched, or the
          // budget exhausted while queued.
          const skip = cacheHit(cacheNs, ckey, ttlMs) ?? unhealthy(backend, op, hk) ?? (isOA && budget.exhaustedUntil() > now() ? budgetOut(backend, op) : null);
          if (skip) {
            res = attempts ? { ...skip, attempts, cost_usd: spent, ...(uncertain ? { cost_uncertain: true } : {}) } : skip;
            local_ = true;
            break;
          }
          attempts++; used = true; executed = true;
          const atmo = Math.max(1, Math.min(tmo, deadline - now()));
          const ac = new AbortController();
          const a0 = now(); let raw; let abandoned = false;
          const running = Promise.resolve().then(() => exec(ac.signal));
          job.attempt = { cancellable };
          try {
            raw = await withTimeout(running, atmo, `${backend}.${op}`, ac, job.controller.signal);
          } catch (e) { raw = { isError: true, text: String(e?.message ?? e) }; abandoned = e?.guard === true; }
          const outcome = classify(raw);
          const fullTimeout = outcome === 'timeout' && atmo >= tmo;
          // A request abandoned by timeout or cancellation may still have been billed: its estimate is recorded.
          const unsure = (outcome === 'timeout' || outcome === 'cancelled') && raw.costUsd === undefined && costUsd > 0;
          const cost = raw.costUsd ?? (outcome === 'ok' || outcome === 'empty' || unsure ? costUsd : 0);
          spent += Number(cost) || 0; uncertain ||= unsure;
          res = { backend, op, outcome, ms: now() - a0, data: raw.data ?? null, error: outcome === 'ok' || outcome === 'empty' ? null : String(raw.text ?? '').slice(0, 400),
            cached: false, cost_usd: spent, attempts };
          if (uncertain) res.cost_uncertain = true;
          if (outcome === 'timeout' && !fullTimeout) res.deadline_truncated = true;
          if (abandoned && !cancellable) {
            res.upstream = 'abandoned_not_stopped';
            res.error = `${res.error}; the request was abandoned, upstream not stopped (this backend cannot be cancelled; its lane stays held, and calls on it are skipped_busy, until the request finishes)`;
            job.abandonedUpstream = `${backend}.${op}`;
            let cap;
            hold = Promise.race([running.then(() => {}, () => {}), new Promise((r) => { cap = setTimeout(r, ABANDONED_HOLD_MAX_MS); cap.unref?.(); })])
              .then(() => { clearTimeout(cap); job.upstreamDone = true; });
            holdLane(hk, `${backend}.${op}`, hold);
          }
        } finally {
          job.attempt = null;
          if (hold) hold.then(() => slot.release(true)); else slot.release(used);
        }
        if (res.outcome === 'transient' && attempts <= retries && now() + 1500 * attempts < deadline && !job.controller.signal.aborted) { await sleepUnless(1500 * attempts, job.controller.signal); continue; }
        break;
      }
    } catch (e) {
      res = local(backend, op, 'error', `runtime: ${String(e?.message ?? e)}`.slice(0, 400), { attempts, cost_usd: spent });
    } finally {
      if (reservation != null) budget.settle(reservation, executed ? spent : 0);
      else if (isOA && executed && spent) budget.add(spent);
    }
    // A result that did not come from an attempt (queue expiry, a dispatch-time cache hit, a benched lane, an exhausted
    // budget) says nothing about the backend and is not written back to the cache.
    if (!executed || local_) { if (executed) res.elapsed_ms = now() - t0; return res; }
    if (isOA && res.outcome === 'budget_exhausted') budget.markExhausted(res.error);
    // Health is tracked per lane, not per backend: the bioRxiv article pages (www.biorxiv.org, Cloudflare-throttled) and the
    // bioRxiv API (api.biorxiv.org) fail independently. A rate limit benches the lane (Semantic Scholar
    // keyless 10 min, others 1 min); a hard timeout benches it only for Semantic Scholar or after two in a row. Cancellations
    // and attempts cut short by the caller's deadline say nothing about the backend.
    if (res.outcome === 'timeout' && !res.deadline_truncated) timeouts.set(hk, (timeouts.get(hk) ?? 0) + 1);
    else if (res.outcome !== 'cancelled' && res.outcome !== 'timeout') timeouts.set(hk, 0);
    if (res.outcome === 'rate_limited' || (res.outcome === 'timeout' && !res.deadline_truncated && (backend === 'semantic_scholar' || timeouts.get(hk) >= 2))) {
      backendHealth.mark(hk, 'temporarily_unhealthy', backend === 'semantic_scholar' ? 600000 : 60000, `${res.outcome}: ${res.error ?? ''}`.slice(0, 200));
    }
    res.elapsed_ms = now() - t0; // queue wait, attempts and backoff; ms stays the last attempt's own time
    if (cacheNs && ['ok', 'empty', 'not_found'].includes(res.outcome)) {
      try { cache.put(cacheNs, ckey, { ...res, data: cloneData(res.data) }, { ttlMs }); } catch (e) { log.event('cache_error', { backend, op, error: String(e?.message ?? e).slice(0, 200) }); }
    }
    return res;
  }

  /** Wait for a job on behalf of one caller. A caller that gives up (its signal, or a joiner's own deadline) detaches; the
   *  shared execution is cancelled only when no caller is left. Resolves { r, own, pays }: own — the caller's own local
   *  result (it detached); pays — this caller is the first one still waiting when the job settled, and is charged its cost.
   *  Only the first holder gets the job's result object; every later one gets its own copy of the data. */
  function waitFor(job, { signal, deadline, backend, op, ckey: key }) {
    job.waiters++;
    return new Promise((resolveWait) => {
      let done = false; let timer = null;
      const onAbort = () => {
        const last = job.waiters === 1 && !job.settled;
        const r = local(backend, op, 'cancelled', `CANCELLED ${backend}.${op}: the caller cancelled`);
        if (last && job.attempt && !job.attempt.cancellable) {
          r.upstream = 'abandoned_not_stopped';
          r.error += '; the in-flight request was abandoned, upstream not stopped (this backend cannot be cancelled; its lane stays held, and calls on it are skipped_busy, until the request finishes)';
        } else if (!last && !job.settled) r.error += '; the shared request continues for another caller';
        detach(r);
      };
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      const detach = (r) => {
        if (done) return; done = true; cleanup();
        if (--job.waiters === 0 && !job.settled) { job.controller.abort(); if (key && inflight.get(key) === job) inflight.delete(key); }
        resolveWait({ r, own: true, pays: false });
      };
      if (deadline != null) timer = setTimeout(() => detach(local(backend, op, 'timeout', `TIMEOUT ${backend}.${op}: caller deadline expired while waiting for a shared request`, { deadline_truncated: true })), Math.max(0, deadline - now()));
      if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
      job.promise.then((r) => {
        if (done) return; done = true; cleanup(); job.waiters--;
        const pays = !job.paid; job.paid = true;
        const out = job.handed ? { ...r, data: cloneData(r.data) } : r; job.handed = true;
        resolveWait({ r: out, own: false, pays });
      });
    });
  }

  /**
   * call({ backend, op, args, exec, lane?, timeoutMs?, deadlineMs?, signal?, cacheNs?, ttlMs?, costUsd?, retries?, coalesce?, cancellable?, ctx })
   *   exec(signal) → { data, text?, isError?, status?, empty?, costUsd? }; signal aborts on timeout or cancellation.
   *   cancellable: false — exec ignores its signal (MCP calls); an abandoned attempt keeps the lane until it settles.
   * Returns { backend, op, outcome, ms, data, error, cached, cost_usd, attempts, coalesced?, queued?, deadline_truncated?,
   * upstream?, original_cost_usd? }. A cache hit reports cost_usd 0.
   * A cached answer is reused only when it was ok/empty/not_found; failures are never cached.
   * Identical cacheable calls (same lane, namespace, backend, op and args) that overlap share one execution, unless the
   * in-flight one has an earlier deadline than the new caller's (see callIn); uncached operations are not merged unless
   * coalesce: true. outcome skipped_busy: the lane is held by an abandoned non-cancellable request; nothing was dispatched. deadlineMs bounds queue wait, attempts and backoff together (default:
   * max(timeoutMs, 2 × lane pacing) + timeoutMs × (retries + 1) + backoff); each attempt is also bounded by timeoutMs.
   */
  async function call(opts) {
    // The invocation scope (a tool's signal and overall deadline) applies to every call made inside it.
    const scope = SCOPE.getStore();
    const link = linkSignals(opts.signal, scope?.signal);
    try { return await callIn({ ...opts, signal: link.signal ?? undefined }, scope); } finally { link.dispose(); }
  }
  async function callIn({ backend, op, args, exec, lane: laneName, timeoutMs, deadlineMs, signal, cacheNs = 'backend', ttlMs, costUsd = 0, retries = 1, coalesce, cancellable = true, ctx }, scope) {
    const hk = laneName ?? backend;
    const ckey = [backend, op, args];
    const tmo = timeoutMs ?? TIMEOUTS[hk] ?? TIMEOUTS.default;
    // Default end-to-end bound: a queue allowance (the attempt timeout, or two pacing gaps if longer), every attempt's
    // timeout, and the retry backoff; never later than the invocation scope's deadline.
    let deadline = now() + (deadlineMs ?? Math.max(tmo, 2 * (PACE[hk] ?? 300)) + tmo * (retries + 1) + 750 * retries * (retries + 1));
    // natural: the deadline is this call's default budget, neither chosen by the caller nor cut by the scope.
    let natural = deadlineMs == null;
    if (Number.isFinite(scope?.deadline) && scope.deadline < deadline) { deadline = scope.deadline; natural = false; }
    const emit = (r, extra = {}) => {
      log.event('backend', { ctx, backend, op, outcome: r.outcome, cached: r.cached || undefined, ms: r.ms, attempts: r.attempts || undefined,
        cost_usd: r.cost_usd || undefined, original_cost_usd: r.original_cost_usd || undefined, error: r.error ?? undefined, upstream: r.upstream ?? undefined, ...extra });
      return r;
    };
    const hit = cacheHit(cacheNs, ckey, ttlMs);
    if (hit) return emit(hit);
    const sick = unhealthy(backend, op, hk);
    if (sick) return emit(sick);
    if (signal?.aborted) return emit(local(backend, op, 'cancelled', `CANCELLED ${backend}.${op}: the caller cancelled`));
    if (deadline <= now()) return emit(local(backend, op, 'timeout', `TIMEOUT ${backend}.${op}: the deadline had expired before dispatch`, { queued: true, deadline_truncated: true }));
    const key = (coalesce ?? Boolean(cacheNs)) ? sha(JSON.stringify([hk, cacheNs, backend, op, args])) : null;
    // A shared request runs under its owner's deadline. A caller whose own deadline is later does not join one that ends
    // earlier (it would come back deadline_truncated while it still had time): it runs its own request, queued behind the
    // first on the lane, where a successful first answer reaches it from the cache at dispatch. Two calls on their natural
    // default budget are the same request started at different moments, so they still share it.
    const candidate = key ? inflight.get(key) : null;
    const existing = candidate && (candidate.deadline >= deadline || (candidate.natural && natural)) ? candidate : null;
    if (existing) {
      // The joiner's result is the shared one, marked coalesced. Its cost is reported by the first caller still waiting
      // when the request settles (normally the caller that started it); everyone else reports 0.
      scope?.jobs.add(existing);
      const { r, own, pays } = await waitFor(existing, { signal, deadline, backend, op, ckey: key });
      if (own) return emit(r);
      return emit(pays ? { ...r, coalesced: true } : { ...r, coalesced: true, cost_usd: 0, cost_uncertain: undefined }, { coalesced: true });
    }
    let reservation = null;
    if (backend.startsWith('openalex')) {
      reservation = budget.reserveFor(costUsd);
      if (reservation == null) return emit(budgetOut(backend, op), { budget: budget.status() });
    }
    const job = { waiters: 0, controller: new AbortController(), settled: false, paid: false, handed: false, attempt: null, abandonedUpstream: null, upstreamDone: false, deadline, natural };
    scope?.jobs.add(job);
    job.promise = runJob({ backend, op, exec, hk, cacheNs, ckey, ttlMs, costUsd, retries, tmo, deadline, reservation, cancellable }, job)
      .catch((e) => local(backend, op, 'error', `runtime: ${String(e?.message ?? e)}`.slice(0, 400)))
      .then((r) => { job.settled = true; if (key && inflight.get(key) === job) inflight.delete(key); return r; });
    if (key) inflight.set(key, job);
    const { r, own, pays } = await waitFor(job, { signal, deadline: null, backend, op, ckey: key });
    return emit(own || pays ? r : { ...r, cost_usd: 0, cost_uncertain: undefined });
  }

  /**
   * scoped({ signal?, deadline? }, fn(scope)) runs fn inside an invocation scope: every call() made inside it (across awaits)
   * is cancelled by `signal` and bounded by `deadline` (absolute, runtime clock). The scope's own signal aborts with the
   * caller's or by scope.abort(). scope.abandoned() lists requests this scope waited on that were abandoned while their
   * upstream (a non-cancellable MCP call) was still running. scope.dispose() unhooks it from the caller's signal.
   */
  function scoped({ signal, deadline } = {}, fn) {
    const outer = SCOPE.getStore();
    const ac = new AbortController(); setMaxListeners(0, ac.signal);
    const parents = [signal, outer?.signal].filter(Boolean);
    const onParent = () => ac.abort();
    for (const s of parents) { if (s.aborted) { ac.abort(); break; } s.addEventListener('abort', onParent, { once: true }); }
    const d = [deadline, outer?.deadline].filter(Number.isFinite);
    const scope = {
      signal: ac.signal, deadline: d.length ? Math.min(...d) : null, jobs: new Set(),
      abort: (reason) => ac.abort(reason),
      abandoned: () => [...scope.jobs].filter((j) => !j.upstreamDone && (j.abandonedUpstream || (j.attempt && !j.attempt.cancellable && j.waiters === 0 && !j.settled)))
        .map((j) => j.abandonedUpstream ?? 'request'),
      dispose: () => { for (const s of parents) s.removeEventListener('abort', onParent); },
    };
    return SCOPE.run(scope, () => fn(scope));
  }

  return { call, scoped, cache, log, budget, health: backendHealth, withTimeout, now };
}
