// Live providers behind the broker. These reuse the already working infrastructure:
//   - the local literature MCP servers (PubMed/Europe PMC/Unpaywall, bioRxiv, arXiv, Semantic Scholar) through the same
//     sandboxed commands .pi/mcp.json gives Pi (scripts/mcp-client.mjs);
//   - OpenAlex through its REST API with the request its official MCP issues (same parameters, checked for parity);
//   - Exa and SearXNG through this repository's research_search adapter;
//   - OpenAlex Content through literature/openalex-content.mjs.
// Every call goes through runtime.call() (timeouts, pacing, classification, budget, cache, log). Each search operation
// returns { items: candidate[], total, sent } with the exact query sent, so provenance records what each backend saw.
// Mina's own requests (OpenAlex, doi.org, open-access PDFs) send MINA_USER_AGENT; the polite-pool APIs (OpenAlex, doi.org /
// Crossref) add `mailto:` only when the user configured RESEARCH_EMAIL (or NCBI_ADMIN_EMAIL), as the MCP servers do.
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, resultText } from '../../scripts/mcp-client.mjs';
import { keyDirs, readKeyDirs } from '../../scripts/mcp-sandbox.mjs';
import { createResearchTools, createNodeHttpClient, createPublicFetchPolicy, loadConfig, loadKeys } from '../../adapters/pi-research-search/index.js';
import { exaKeyedSearch, exaKeylessSearch } from '../../adapters/pi-research-search/src/providers/exa.js';
import { contactEmail, minaUserAgent, MINA_USER_AGENT } from '../../adapters/pi-research-search/src/user-agent.js';
import { openalexContent } from '../openalex-content.mjs';
import { parseLatexmlBibliography } from './text.mjs';
import { candidate, normDoi } from '../lib/normalize.mjs';
import { runSandboxedPython } from '../supplements/pdf-sandbox.mjs';
import { RLIMIT_PRELUDE } from '../supplements/pdf.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OA = 'https://api.openalex.org';
export const EXA_NOT_CONFIGURED = 'not configured: no EXA_API_KEY, and keyless Exa is opt-in (set MINA_EXA_KEYLESS=1 to use it)';
// OpenAlex list prices: searches USD 0.001, list/filter queries USD 0.0001, get by id free, content file USD 0.01.
export const OA_COST = { search: 0.001, filter: 0.0001, get: 0, content: 0.01 };
export const OA_SELECT = 'id,doi,ids,display_name,publication_year,publication_date,type,primary_location,abstract_inverted_index,cited_by_count,is_retracted,authorships,referenced_works_count';
const OA_SELECT_FULL = `${OA_SELECT},open_access,has_content,best_oa_location,locations,referenced_works`;

export const abstractFrom = (inv) => {
  if (!inv) return null; const w = [];
  for (const [t, ps] of Object.entries(inv)) for (const p of ps) w[p] = t;
  return w.filter(Boolean).join(' ') || null;
};
const authorsOf = (w) => (w.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean);
export function oaWork(w, rank) {
  const ids = w.ids ?? {};
  const c = candidate({
    rank, title: w.display_name ?? w.title, year: w.publication_year, date: w.publication_date, type: w.type,
    venue: w.primary_location?.source?.display_name, doi: ids.doi ?? w.doi, pmid: ids.pmid ? String(ids.pmid).replace(/\D/g, '') : undefined,
    pmcid: ids.pmcid ? String(ids.pmcid).replace(/^.*\//, '') : undefined, openalex: w.id, abstract: abstractFrom(w.abstract_inverted_index),
    cited_by: w.cited_by_count, is_retracted: w.is_retracted || undefined, url: w.id, authors: authorsOf(w).slice(0, 12),
    references_count: w.referenced_works_count,
  });
  // OpenAlex's DOI for an arXiv work is 10.48550/arxiv.<id>; the identity is the arXiv id, but its title is not trusted
  // (OpenAlex's arXiv records were seen to carry another work's title): the record is marked so that resolution confirms it
  // against arXiv.
  if (c.arxiv) c.arxiv_from_openalex = true;
  if (w.referenced_works) c.referenced_works = w.referenced_works.map((x) => x.replace(/^.*\//, ''));
  if (w.open_access) c.oa = { is_oa: w.open_access.is_oa, status: w.open_access.oa_status, url: w.open_access.oa_url };
  if (w.has_content) c.has_content = w.has_content;
  if (w.locations) c.locations = w.locations.map((l) => ({ source: l.source?.display_name ?? null, source_type: l.source?.type ?? null, version: l.version ?? null,
    is_oa: l.is_oa, license: l.license ?? null, landing: l.landing_page_url ?? null, pdf: l.pdf_url ?? null }));
  return c;
}

// ---- date windows -------------------------------------------------------------------------------------------------------
/** One inclusive bound of a date window as YYYY-MM-DD: 'YYYY', 'YYYY-MM' and 'YYYY-MM-DD' (optionally with a time, which is
 *  dropped) expand to the first ('from') or last ('to') day they cover. Absent → null. Anything else, or a day that is not on
 *  the calendar, throws: a bad bound is never dropped, because dropping it would silently widen the window. */
export function dateBound(value, side) {
  if (value === undefined || value === null || value === '') return null;
  const m = String(value).trim().match(/^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ].*)?)?)?$/);
  if (!m) throw new RangeError(`${side} date '${value}' is not an ISO date (YYYY, YYYY-MM or YYYY-MM-DD)`);
  const y = Number(m[1]); const mo = m[2] ? Number(m[2]) : side === 'from' ? 1 : 12;
  if (mo < 1 || mo > 12) throw new RangeError(`${side} date '${value}' has no month ${mo}`);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const d = m[3] ? Number(m[3]) : side === 'from' ? 1 : last;
  if (d < 1 || d > last) throw new RangeError(`${side} date '${value}' is not a real calendar date`);
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/** { from, to } as inclusive YYYY-MM-DD bounds (either may be null); throws on an invalid or inverted window. */
export function dateWindow(from, to) {
  const w = { from: dateBound(from, 'from'), to: dateBound(to, 'to') };
  if (w.from && w.to && w.from > w.to) throw new RangeError(`the date window starts (${w.from}) after it ends (${w.to})`);
  return w;
}
/** OpenAlex works inside an inclusive window, by publication_date; a work with only a year is kept when that whole year lies
 *  inside the window and counted as unverifiable otherwise. A publication_date that is not a real calendar day (2020-13-45,
 *  2021-02-30; validated like a window bound) cannot be placed in the window: it is counted as undated, never compared as text. */
export function filterWorksByWindow(works, { from, to }) {
  const out = { kept: [], out_of_window: 0, undated: 0, year_only: 0 };
  for (const w of works) {
    let date = null;
    const pd = typeof w.publication_date === 'string' ? w.publication_date.trim() : '';
    if (/^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(pd)) {
      try { date = dateBound(pd.slice(0, 10), 'from'); } catch { out.undated++; continue; }
    } else if (/^\d{4}-\d{2}-\d{2}/.test(pd)) { out.undated++; continue; } // a date followed by junk is not a date either
    if (date) {
      if ((from && date < from) || (to && date > to)) out.out_of_window++; else out.kept.push(w);
      continue;
    }
    const y = Number(w.publication_year);
    if (!Number.isInteger(y) || y <= 0) { out.undated++; continue; }
    const ys = `${y}-01-01`; const ye = `${y}-12-31`;
    if ((from && ye < from) || (to && ys > to)) out.out_of_window++;
    else if ((from && ys < from) || (to && ye > to)) out.undated++; // the year straddles a bound: the date cannot be verified
    else { out.kept.push(w); out.year_only++; }
  }
  return out;
}
const windowError = (backend, op, q, e) => ({ backend, op, outcome: 'error', ms: 0, data: null, error: `invalid date window: ${e.message}`, cached: false, cost_usd: 0, attempts: 0,
  sent: q, items: [], total: null });

/** research_search keys (Exa, Brave): the adapter's own lookup (environment, PI_RESEARCH_KEYS_DIR, <repo>/keys), then the
 *  user key directories the MCP sandbox reads (scripts/mcp-sandbox.mjs keyDirs) — keys kept only in ~/.config/mina/keys
 *  would otherwise leave Exa keyless and Brave unconfigured. */
export function researchKeysWithFallback() {
  const a = loadKeys();
  if (a.exa && a.brave) return a;
  for (const d of keyDirs().filter(Boolean)) {
    const b = loadKeys({ keysDir: d });
    if (b.exa || b.brave) return { ...b, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v)) };
  }
  return a;
}

export function createProviders(rt, { keys = readKeyDirs(keyDirs()), researchKeys = researchKeysWithFallback(), config = loadConfig(), python = join(REPO, 'services/literature-mcp/.venv/bin/python'),
  fetchImpl = (...a) => globalThis.fetch(...a), connectMcp = connect, env = process.env } = {}) {
  // fetchImpl and connectMcp are the network seams: tests inject fakes so no live API or MCP server is reached.
  const http = createNodeHttpClient();
  const research = createResearchTools({ config, keys: researchKeys, http });
  // Contact for polite pools: only an address the user set (environment or research key files), never a placeholder.
  const contact = contactEmail({ env, keys });
  const politeUA = minaUserAgent({ contact });
  // Unpaywall (inside the pubmed MCP server) runs only with an address: UNPAYWALL_EMAIL, else the same contact.
  const unpaywallEmail = Boolean(env.UNPAYWALL_EMAIL || keys.UNPAYWALL_EMAIL || contact);
  // Exa: keyed with EXA_API_KEY; keyless only when the user opted in (MINA_EXA_KEYLESS=1 or config exaKeyless: true).
  const exaMode = researchKeys.exa ? 'keyed' : research.config.exaKeyless ? 'keyless' : 'unconfigured';
  const servers = new Map();
  const mcp = async (name) => {
    if (!servers.has(name)) servers.set(name, connectMcp(name, { timeoutMs: 180000, onStderr: () => {} }).catch((e) => { servers.delete(name); throw e; }));
    return servers.get(name);
  };
  // MCP server processes are closed after 30 s without a call, by an unref'd timer: an idle child process must not keep
  // the host alive (a Pi print-mode session did not exit after its answer while the servers were open).
  let inFlight = 0; let lastUse = 0; let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      if (inFlight || !servers.size || Date.now() - lastUse < 30000) return;
      const all = [...servers.values()]; servers.clear();
      for (const sp of all) sp.then((x) => x.close()).catch(() => {});
      clearInterval(idleTimer); idleTimer = null;
    }, 5000);
    idleTimer.unref?.();
  };
  async function mcpCall(name, tool, args) {
    inFlight++; lastUse = Date.now(); armIdle();
    try { return await mcpCallInner(name, tool, args); } finally { inFlight--; lastUse = Date.now(); }
  }
  async function mcpCallInner(name, tool, args) {
    try {
      const r = await (await mcp(name)).call(tool, args);
      const text = resultText(r);
      // Some servers (Semantic Scholar) answer in text only: JSON text is parsed, anything else is kept as { text }.
      let data = r.structuredContent ?? null;
      if (!data) { try { data = JSON.parse(text); } catch { data = { text }; } }
      return { data, text, isError: Boolean(r.isError) || /^\s*\{?\s*"error"\s*:/.test(text.slice(0, 200)) };
    } catch (error) {
      if (/exited|EPIPE|closed|timed out/i.test(error.message)) { const p = servers.get(name); servers.delete(name); p?.then((s) => s.close()).catch(() => {}); }
      return { isError: true, text: `MCP ${name}: ${error.message}` };
    }
  }
  const oaUrl = (path, params) => {
    const u = new URL(`${OA}${path}`);
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, v);
    if (keys.OPENALEX_API_KEY) u.searchParams.set('api_key', keys.OPENALEX_API_KEY);
    return u;
  };
  async function oaGet(path, params, signal) {
    try {
      const res = await fetchImpl(oaUrl(path, params), { headers: { accept: 'application/json', 'user-agent': politeUA }, ...(signal ? { signal } : {}) });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
      if (!res.ok) return { isError: true, status: res.status, text: `HTTP ${res.status} ${json?.error ?? ''} ${json?.message ?? text.slice(0, 200)}` };
      return { data: json, costUsd: json?.meta?.cost_usd ?? undefined };
    } catch (e) { return { isError: true, text: `FETCH ${e.message}` }; }
  }
  const s2Keyed = Boolean(keys.SEMANTIC_SCHOLAR_API_KEY || process.env.SEMANTIC_SCHOLAR_API_KEY);

  const p = {
    keys: { exa: Boolean(researchKeys.exa), brave: Boolean(researchKeys.brave), openalex: Boolean(keys.OPENALEX_API_KEY), ncbi: Boolean(keys.NCBI_API_KEY), semantic_scholar: s2Keyed,
      contact_email: Boolean(contact), unpaywall: unpaywallEmail },

    // ---- OpenAlex --------------------------------------------------------------------------------------------------------
    openalex: {
      async keyword({ q, n = 25, from, to, ctx }) {
        const filter = [`title_and_abstract.search:${q.replace(/,/g, ' ').replace(/(\w)\*/g, '$1')}`, from && `from_publication_date:${from}`, to && `to_publication_date:${to}`].filter(Boolean).join(',');
        const params = { filter, sort: 'relevance_score:desc', per_page: n, select: OA_SELECT };
        const r = await rt.call({ backend: 'openalex', op: 'keyword', args: params, costUsd: OA_COST.search, cacheNs: 'search', ctx,
          exec: async (signal) => { const x = await oaGet('/works', params, signal); return x.isError ? x : { ...x, empty: !x.data?.results?.length } } });
        return { ...r, sent: filter, items: (r.data?.results ?? []).map((w, i) => oaWork(w, i + 1)), total: r.data?.meta?.count };
      },
      /** Semantic search. OpenAlex rejects publication-date filters combined with search.semantic (HTTP 400), so the
       *  request never carries the window: with a window it asks for the largest page (50)
       *  and filters the returned works locally. That is not exhaustive date-bounded discovery — in-window works ranked
       *  below the first page are never seen — and the result says so (date_filter, notes). The request does not depend on
       *  the window, so one cached answer serves every window. */
      async semantic({ q, n = 25, from, to, ctx }) {
        let win; try { win = dateWindow(from, to); } catch (e) { return windowError('openalex', 'semantic', q, e); }
        const windowed = Boolean(win.from || win.to);
        const params = { 'search.semantic': q, per_page: windowed ? 50 : Math.min(n, 50), select: OA_SELECT };
        const r = await rt.call({ backend: 'openalex', op: 'semantic', lane: 'openalex_semantic', args: params, costUsd: OA_COST.search, cacheNs: 'search', ctx,
          exec: async (signal) => { const x = await oaGet('/works', params, signal); return x.isError ? x : { ...x, empty: !x.data?.results?.length } } });
        const works = r.data?.results ?? [];
        if (!windowed) return { ...r, sent: q, items: works.map((w, i) => oaWork(w, i + 1)), total: r.data?.meta?.count };
        if (r.outcome !== 'ok' && r.outcome !== 'empty') return { ...r, sent: q, items: [], total: null };
        const f = filterWorksByWindow(works, win);
        const items = f.kept.slice(0, n).map((w, i) => oaWork(w, i + 1));
        const date_filter = { method: 'local_post_filter', field: 'publication_date', from: win.from, to: win.to, retrieved: works.length, kept: f.kept.length,
          returned: items.length, out_of_window: f.out_of_window, undated: f.undated, year_only: f.year_only, exhaustive: false };
        const span = `${win.from ?? 'any date'} to ${win.to ?? 'any date'}`;
        const notes = [`OpenAlex semantic search cannot take a publication-date filter, so its top ${works.length} matches (no date restriction) were filtered locally to ${span}: `
          + `${f.kept.length} kept, ${f.out_of_window} outside the window, ${f.undated} without a verifiable date. In-window works ranked below those ${works.length} were not retrieved, `
          + 'so this cannot guarantee exhaustive date-bounded discovery; backends that filter by date server-side are unaffected.'];
        return { ...r, outcome: r.outcome === 'ok' && !items.length ? 'empty' : r.outcome, sent: q, items, total: null, total_unfiltered: r.data?.meta?.count ?? null, date_filter, notes };
      },
      async titleSearch({ title, n = 5, ctx }) {
        const params = { filter: `title.search:${title.replace(/[,:|]/g, ' ').slice(0, 250)}`, per_page: n, select: OA_SELECT };
        const r = await rt.call({ backend: 'openalex', op: 'title', args: params, costUsd: OA_COST.search, cacheNs: 'meta', ctx, exec: (signal) => oaGet('/works', params, signal) });
        return { ...r, sent: params.filter, items: (r.data?.results ?? []).map((w, i) => oaWork(w, i + 1)) };
      },
      /** One work by OpenAlex id, doi:…, pmid:…, pmcid:… (free). */
      async get({ id, full = false, ctx }) {
        const path = `/works/${id}`;
        const r = await rt.call({ backend: 'openalex', op: 'get', args: { path, full }, costUsd: OA_COST.get, cacheNs: 'meta', ctx, exec: (signal) => oaGet(path, { select: full ? OA_SELECT_FULL : OA_SELECT }, signal) });
        return { ...r, item: r.data?.id ? oaWork(r.data, 1) : null };
      },
      /** Batch by filter key (doi | openalex | pmid), at most 50 values per request (USD 0.0001 each). */
      async batch({ key, values, ctx, select = OA_SELECT }) {
        const out = [];
        const calls = [];
        for (let i = 0; i < values.length; i += 50) {
          const chunk = values.slice(i, i + 50);
          const params = { filter: `${key}:${chunk.join('|')}`, per_page: 50, select };
          const r = await rt.call({ backend: 'openalex', op: `batch.${key}`, args: params, costUsd: OA_COST.filter, cacheNs: 'meta', ctx, exec: (signal) => oaGet('/works', params, signal) });
          calls.push(r);
          for (const w of r.data?.results ?? []) out.push(oaWork(w, out.length + 1));
        }
        return { outcome: calls.every((c) => c.outcome === 'ok' || c.outcome === 'empty') ? 'ok' : calls.find((c) => c.outcome !== 'ok')?.outcome ?? 'ok', items: out, calls };
      },
      async citing({ openalex, n = 25, sort = 'cited_by_count:desc', from, ctx }) {
        const params = { filter: [`cites:${openalex}`, from && `from_publication_date:${from}`].filter(Boolean).join(','), sort, per_page: n, select: OA_SELECT };
        const r = await rt.call({ backend: 'openalex', op: 'citing', args: params, costUsd: OA_COST.filter, cacheNs: 'expand', ctx, exec: (signal) => oaGet('/works', params, signal) });
        return { ...r, items: (r.data?.results ?? []).map((w, i) => oaWork(w, i + 1)), total: r.data?.meta?.count };
      },
      async references({ openalex, n = 100, ctx }) {
        const g = await rt.call({ backend: 'openalex', op: 'get.refs', args: { openalex }, costUsd: OA_COST.get, cacheNs: 'expand', ctx,
          exec: (signal) => oaGet(`/works/${openalex}`, { select: 'id,referenced_works' }, signal) });
        const refs = (g.data?.referenced_works ?? []).map((x) => x.replace(/^.*\//, '')).slice(0, n);
        if (!refs.length) return { ...g, items: [], total: 0 };
        const b = await this.batch({ key: 'openalex', values: refs, ctx });
        // keep the reference-list order
        const order = new Map(refs.map((x, i) => [x, i]));
        const items = b.items.sort((a, b2) => (order.get(a.openalex) ?? 1e9) - (order.get(b2.openalex) ?? 1e9)).map((c, i) => ({ ...c, rank: i + 1 }));
        return { ...g, outcome: b.outcome === 'ok' ? g.outcome : b.outcome, items, total: refs.length };
      },
      /** OpenAlex Content: GROBID TEI sections or the PDF bytes (USD 0.01 per file). */
      async content({ id, format = 'grobid_xml', ctx }) {
        return rt.call({ backend: 'openalex_content', op: format, args: { id }, costUsd: OA_COST.content, cacheNs: null, timeoutMs: 90000, ctx, exec: async (signal) => {
          const x = await openalexContent(id, { apiKey: keys.OPENALEX_API_KEY, format, userAgent: politeUA, fetchImpl: (u, o = {}) => fetchImpl(u, { ...o, ...(signal ? { signal } : {}) }) });
          if (x.status === 'ERROR') return { isError: true, text: x.reason };
          if (x.status !== 'OK') return { data: { status: x.status, reason: x.reason }, costUsd: 0, empty: true };
          return { data: { status: 'OK', sections: x.sections ?? null, pdf: x.pdf ?? null, claim: x.provenance?.complete ?? null, title: x.record?.title ?? null, content_url: x.provenance?.content_url ?? null },
            costUsd: x.provenance?.cost_usd ?? OA_COST.content };
        } });
      },
    },

    // ---- PubMed / Europe PMC / Unpaywall (pubmed MCP) -----------------------------------------------------------------------
    pubmed: {
      async search({ q, n = 25, from, to, sort = 'relevance', ctx }) {
        const args = { query: q, maxResults: n, sort, summaryCount: n, ...(from || to ? { dateRange: { minDate: (from ?? '1800-01-01').replace(/-/g, '/'), maxDate: (to ?? '3000-01-01').replace(/-/g, '/'), dateType: 'pdat' } } : {}) };
        const r = await rt.call({ backend: 'pubmed', op: 'search', args, cacheNs: 'search', ctx, cancellable: false, exec: async () => { const x = await mcpCall('pubmed', 'pubmed_search_articles', args); return x.isError ? x : { ...x, empty: !x.data?.pmids?.length }; } });
        const s = r.data ?? {};
        return { ...r, sent: s.effectiveQuery ?? q, total: s.totalCount, items: (s.summaries ?? []).map((x, i) => candidate({ rank: i + 1, title: x.title, date: x.pubDate, venue: x.source, doi: x.doi, pmid: x.pmid, pmcid: x.pmcId, url: x.pubmedUrl, type: x.docType })) };
      },
      async fetch({ pmids, ctx }) {
        const args = { pmids: pmids.map(String), includeMesh: false };
        return rt.call({ backend: 'pubmed', op: 'fetch', args, cacheNs: 'meta', ctx, cancellable: false, exec: () => mcpCall('pubmed', 'pubmed_fetch_articles', args) });
      },
      async convert({ ids, idType, ctx }) {
        const args = { ids, idType };
        return rt.call({ backend: 'pubmed', op: 'convert', args, cacheNs: 'idmap', ctx, cancellable: false, exec: () => mcpCall('pubmed', 'pubmed_convert_ids', args) });
      },
      async related({ pmid, relationship, n = 50, ctx }) {
        // the tool returns at most 50 per call: page with offset
        let r = null; const list = []; let total = null;
        for (let offset = 0; offset < n; offset += 50) {
          const args = { pmid: String(pmid), relationship, maxResults: Math.min(50, n - offset), ...(offset ? { offset } : {}) };
          r = await rt.call({ backend: 'pubmed', op: `related.${relationship}`, args, cacheNs: 'expand', ctx, cancellable: false, exec: () => mcpCall('pubmed', 'pubmed_find_related', args) });
          const page = r.data?.articles ?? r.data?.summaries ?? r.data?.results ?? r.data?.related ?? (Array.isArray(r.data?.pmids) ? r.data.pmids.map((x) => ({ pmid: x })) : []);
          total = r.data?.totalCount ?? total;
          list.push(...page);
          if (r.outcome !== 'ok' || page.length < 50) break;
        }
        const s = { ...(r?.data ?? {}), articles: list, totalCount: total };
        const items = list.map((x, i) => candidate({ rank: i + 1, title: x.title, date: x.pubDate ?? x.date, venue: x.source ?? x.journal, doi: x.doi, pmid: x.pmid ?? x.id, pmcid: x.pmcId ?? x.pmcid }));
        return { ...r, items, total: s.totalCount ?? items.length };
      },
      async fulltext({ pmcids, pmids, dois, ctx }) {
        const args = { ...(pmcids ? { pmcids } : {}), ...(pmids ? { pmids } : {}), ...(dois ? { dois } : {}), includeReferences: false, includeTables: true, maxCharacters: 600000, maxResponseCharacters: 900000 };
        return rt.call({ backend: 'pubmed', op: 'fulltext', args, cacheNs: null, lane: 'pubmed', timeoutMs: 90000, ctx, cancellable: false, exec: () => mcpCall('pubmed', 'pubmed_fetch_fulltext', args) });
      },
    },
    europepmc: {
      async search({ q, n = 25, from, to, ctx }) {
        const query = from || to ? `(${q}) AND FIRST_PDATE:[${from ?? '1800-01-01'} TO ${to ?? '3000-01-01'}]` : q;
        const args = { query, pageSize: n };
        const r = await rt.call({ backend: 'europepmc', op: 'search', args, cacheNs: 'search', ctx, cancellable: false, exec: async () => { const x = await mcpCall('pubmed', 'pubmed_europepmc_search', args); return x.isError ? x : { ...x, empty: !x.data?.hits?.length }; } });
        const s = r.data ?? {};
        return { ...r, sent: s.query ?? query, total: s.totalCount, items: (s.hits ?? []).map((x, i) => candidate({ rank: i + 1, title: x.title, date: x.firstPublicationDate, year: Number(x.pubYear) || undefined,
          doi: x.doi, pmid: x.pmid, pmcid: x.pmcId, epmc_ppr: x.source === 'PPR' ? x.epmcId : undefined, is_preprint: x.source === 'PPR' || undefined, abstract: x.abstractSnippet, url: x.epmcUrl })) };
      },
    },

    // ---- bioRxiv / medRxiv (authoritative for preprint identity, versions, published DOI) ------------------------------------
    biorxiv: {
      async preprint({ doi, ctx }) {
        const args = { dois: [doi] };
        return rt.call({ backend: 'biorxiv', op: 'preprint', args, cacheNs: 'meta', ctx, cancellable: false, exec: () => mcpCall('biorxiv', 'biorxiv_get_preprint', args) });
      },
      async published({ doi, ctx }) {
        const args = { doi };
        // "has no published journal version" is an answer (none), not a failure
        return rt.call({ backend: 'biorxiv', op: 'published', args, cacheNs: 'meta', ctx, cancellable: false, exec: async () => {
          const x = await mcpCall('biorxiv', 'biorxiv_get_published_version', args);
          return x.isError && /no published (journal )?version/i.test(x.text) ? { data: { publishedDoi: null, note: 'no published version listed' }, empty: true } : x;
        } });
      },
      async search({ q, n = 25, from, to, ctx }) {
        const args = { query: q, server: 'both', limit: n, include_abstract: true, ...(from ? { date_from: from } : {}), ...(to ? { date_to: to } : {}) };
        const r = await rt.call({ backend: 'biorxiv', op: 'search', args, cacheNs: 'search', ctx, cancellable: false, exec: async () => { const x = await mcpCall('biorxiv', 'biorxiv_search_preprints', args); return x.isError ? x : { ...x, empty: !x.data?.preprints?.length }; } });
        const s = r.data ?? {};
        return { ...r, sent: q, total: s.totalCount, items: (s.preprints ?? []).map((x, i) => candidate({ rank: i + 1, title: x.title, date: x.date, doi: x.doi, preprint_version: Number(x.version) || undefined,
          published_doi: x.publishedJournalDoi || undefined, is_preprint: true, abstract: x.abstract, venue: x.server })) };
      },
      async fulltext({ doi, version, ctx }) {
        let text = ''; let offset = 0; let last = null;
        for (let page = 0; page < 8; page++) {
          const args = { doi, ...(version ? { version } : {}), offset, limit: 50000 };
          last = await rt.call({ backend: 'biorxiv', op: 'fulltext', lane: 'biorxiv_page', args, cacheNs: null, retries: 0, timeoutMs: 60000, ctx, cancellable: false, exec: () => mcpCall('biorxiv', 'biorxiv_get_fulltext', args) });
          if (last.outcome !== 'ok') break;
          const s = last.data ?? {};
          const chunk = s.content ?? s.markdown ?? s.text ?? '';
          text += chunk;
          const next = s.nextOffset ?? s.next_offset ?? (s.hasMore || s.has_more ? offset + chunk.length : null);
          if (next == null || next <= offset || !chunk) break;
          offset = next;
        }
        return { ...last, text };
      },
    },

    // ---- arXiv (authoritative for arXiv identity and metadata) --------------------------------------------------------------
    arxiv: {
      /** The installed @cyanheads/arxiv-mcp-server 1.5.3 validates submitted_from/submitted_to as real UTC calendar dates in
       *  YYYY-MM-DD form, inclusive, from ≤ to (dates with the hyphens stripped fail its validation). An invalid window is
       *  reported, not sent and not dropped. arXiv filters on submission date (first version). */
      async search({ q, n = 25, sort = 'relevance', from, to, ctx }) {
        let win; try { win = dateWindow(from, to); } catch (e) {
          rt.log.event('backend', { ctx, backend: 'arxiv', op: 'search', outcome: 'error', error: `invalid date window: ${e.message}` });
          return windowError('arxiv', 'search', q, e);
        }
        const args = { query: q, max_results: n, sort_by: sort, ...(win.from ? { submitted_from: win.from } : {}), ...(win.to ? { submitted_to: win.to } : {}) };
        const r = await rt.call({ backend: 'arxiv', op: 'search', args, cacheNs: 'search', ctx, cancellable: false, exec: async () => { const x = await mcpCall('arxiv', 'arxiv_search', args); return x.isError ? x : { ...x, empty: !x.data?.papers?.length }; } });
        const s = r.data ?? {};
        return { ...r, sent: s.effectiveQuery ?? q, total: s.totalFound, items: (s.papers ?? []).map((x, i) => candidate({ rank: i + 1, title: x.title, date: x.published, arxiv: x.id, abstract: x.abstract, doi: x.doi,
          is_preprint: true, venue: x.journal_ref, authors: (x.authors ?? []).slice(0, 12).map((a) => (typeof a === 'string' ? a : a.name)) })) };
      },
      async metadata({ ids, ctx }) {
        const args = { paper_ids: ids };
        return rt.call({ backend: 'arxiv', op: 'metadata', args, cacheNs: 'meta', ctx, cancellable: false, exec: () => mcpCall('arxiv', 'arxiv_get_metadata', args) });
      },
      /** The reference list of an arXiv paper, from its LaTeXML HTML (arxiv.org/html, then ar5iv). */
      async bibliography({ id, ctx }) {
        for (const url of [`https://arxiv.org/html/${id}`, `https://ar5iv.labs.arxiv.org/html/${id}`]) {
          const r = await p.web.page({ url, raw: true, ctx, lane: 'arxiv' });
          const entries = r.outcome === 'ok' ? parseLatexmlBibliography(r.data?.text ?? '') : [];
          if (entries.length) return { ...r, backend: 'arxiv_html', op: 'bibliography', url, items: entries.map((e, i) => candidate({ rank: i + 1, title: e.title, year: e.year, arxiv: e.arxiv, doi: e.doi })), total: entries.length };
        }
        return { backend: 'arxiv_html', op: 'bibliography', outcome: 'empty', items: [], total: 0, error: 'no LaTeXML bibliography found (no HTML rendering for this paper)' };
      },
      async read({ id, ctx }) {
        let text = ''; let start = 0; let last = null; let source = null;
        for (let page = 0; page < 6; page++) {
          const args = { paper_id: id, max_characters: 200000, start };
          last = await rt.call({ backend: 'arxiv', op: 'read', args, cacheNs: null, timeoutMs: 60000, ctx, cancellable: false, exec: () => mcpCall('arxiv', 'arxiv_read_paper', args) });
          if (last.outcome !== 'ok') break;
          const s = last.data ?? {};
          const chunk = s.content ?? s.text ?? '';
          source ??= s.source ?? null;
          text += chunk;
          if (!(s.truncated || s.hasMore) || !chunk.length) break;
          start = s.nextStart ?? start + chunk.length;
        }
        return { ...last, text, source };
      },
    },

    // ---- Semantic Scholar (behind a provider boundary) ----------------------------------------------------------------------
    semantic_scholar: {
      state(config) {
        if (config?.semantic_scholar === 'disabled') return 'disabled';
        const h = rt.health.get(s2Keyed ? 'semantic_scholar' : 'semantic_scholar_keyless');
        if (h.state === 'temporarily_unhealthy') return 'temporarily_unhealthy';
        return s2Keyed ? 'enabled_keyed' : 'enabled_keyless';
      },
      async search({ q, n = 20, ctx }) {
        const args = { query: q, limit: n, fields: ['paperId', 'title', 'abstract', 'year', 'venue', 'externalIds', 'external_ids', 'citationCount', 'citation_count', 'publicationTypes'] };
        const r = await rt.call({ backend: 'semantic_scholar', op: 'search', lane: s2Keyed ? 'semantic_scholar' : 'semantic_scholar_keyless', args, retries: 0, cacheNs: 'search', ctx,
          cancellable: false, exec: () => mcpCall('semantic_scholar', 'search_papers', args) });
        const data = r.outcome === 'ok' ? (r.data?.data ?? r.data?.result?.data ?? []) : [];
        return { ...r, sent: q, items: data.map((x, i) => { const e = x.external_ids ?? x.externalIds ?? {}; return candidate({ rank: i + 1, title: x.title, year: x.year, s2: x.paper_id ?? x.paperId,
          doi: e.DOI, pmid: e.PubMed, arxiv: e.ArXiv, venue: x.venue, abstract: x.abstract, cited_by: x.citation_count ?? x.citationCount }); }) };
      },
      async get({ id, ctx }) {
        const args = { paper_id: id, fields: ['paperId', 'title', 'year', 'venue', 'externalIds', 'external_ids', 'abstract', 'publicationTypes'] };
        return rt.call({ backend: 'semantic_scholar', op: 'get', lane: s2Keyed ? 'semantic_scholar' : 'semantic_scholar_keyless', args, retries: 0, cacheNs: 'meta', ctx,
          cancellable: false, exec: () => mcpCall('semantic_scholar', 'get_paper', args) });
      },
    },

    // ---- Exa and SearXNG (research_search adapter) --------------------------------------------------------------------------
    exa: {
      /** 'keyed' | 'keyless' (opted in) | 'unconfigured' (no key, no opt-in: not routed, see search.mjs planBackends). */
      mode: exaMode,
      notConfigured: EXA_NOT_CONFIGURED,
      async search({ q, n = 20, from, to, ctx }) {
        if (exaMode === 'unconfigured') {
          return { backend: 'exa', op: 'search', outcome: 'skipped_unconfigured', ms: 0, data: null, error: EXA_NOT_CONFIGURED, cached: false, cost_usd: 0, attempts: 0, sent: q, items: [] };
        }
        const args = { q, n, from, to, mode: exaMode };
        const r = await rt.call({ backend: 'exa', op: 'search', args, cacheNs: 'search', ctx, exec: async (signal) => {
          try {
            const out = researchKeys.exa
              ? await exaKeyedSearch({ http, apiKey: researchKeys.exa, query: q, maxResults: n, publishedAfter: from, publishedBefore: to, signal, timeoutMs: 30000 })
              : await exaKeylessSearch({ http, query: q, maxResults: n, signal, timeoutMs: 30000 });
            return { data: { results: out.results ?? out }, costUsd: out.meta?.cost_usd ?? (researchKeys.exa ? 0.0156 : 0), empty: !(out.results ?? out).length };
          } catch (e) { return { isError: true, status: e.status, text: String(e.message) }; }
        } });
        return { ...r, sent: q, items: (r.data?.results ?? []).map((x, i) => candidate({ rank: i + 1, title: x.title, url: x.url, date: x.published_date, doi: x.doi, abstract: x.snippet, authors: x.authors, cited_by: x.citation_count })) };
      },
    },
    searxng: {
      async search({ q, field = 'general', ctx }) {
        const args = { q, field };
        const r = await rt.call({ backend: 'searxng', op: 'search', args, cacheNs: 'search', ctx, exec: async (signal) => {
          try {
            const out = await research.search({ query: q, backends: ['searxng'], field: field === 'biomedical' ? 'biomedical' : field === 'general' ? 'general' : 'computational' }, signal);
            const c = out.details.calls[0];
            return c.status === 'error' ? { isError: true, text: c.error } : { data: { results: out.details.results, unresponsive: c.meta?.unresponsive_engines ?? [] }, empty: !out.details.results.length };
          } catch (e) { return { isError: true, text: String(e.message) }; }
        } });
        return { ...r, sent: q, unresponsive: r.data?.unresponsive, items: (r.data?.results ?? []).map((x, i) => candidate({ rank: i + 1, title: x.title, url: x.url, date: x.published_date, doi: x.doi, pmid: x.pmid, arxiv: x.arxiv_id, abstract: x.snippet, venue: x.venue })) };
      },
    },

    // ---- generic, read-only access for direct database operations (the literature_db tool) ----------------------------
    /** One MCP operation on a local literature server, through the runtime (timeout, health, log, cache). */
    async mcp({ server, tool, args, ctx, signal, deadlineMs }) {
      return rt.call({ backend: server, op: tool, args, cacheNs: "backend", lane: server === "semantic_scholar" && !s2Keyed ? "semantic_scholar_keyless" : server, retries: 0, timeoutMs: 90000, ctx,
        signal, deadlineMs, cancellable: false, exec: () => mcpCall(server, tool, args) });
    },
    /** The tools a local literature server offers: name, description, input schema. */
    async mcpTools(server) {
      try { return (await (await mcp(server)).tools()).map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? null })); }
      catch (e) { return { error: e.message }; }
    },
    /** A GET on the OpenAlex REST API (budget-tracked: searches USD 0.001, list/filter USD 0.0001, get by id free). */
    async openalexRaw({ path, params = {}, ctx, signal, deadlineMs }) {
      const isList = !/^\/[a-z_]+\/[^/]+$/.test(path);
      const cost = !isList ? OA_COST.get : params.search || params["search.semantic"] || /search/.test(params.filter ?? "") ? OA_COST.search : OA_COST.filter;
      return rt.call({ backend: "openalex", op: "raw", args: { path, params }, costUsd: cost, cacheNs: "backend", ctx, signal, deadlineMs, exec: (s) => oaGet(path, params, s) });
    },

    // ---- DOI metadata (doi.org content negotiation; the registration agency's record) ---------------------------------------
    doi_org: {
      async get({ doi, ctx }) {
        return rt.call({ backend: 'doi_org', op: 'csl', args: { doi }, cacheNs: 'meta', ctx, exec: async (signal) => {
          try {
            const res = await fetchImpl(`https://doi.org/${encodeURI(doi)}`, { headers: { accept: 'application/vnd.citationstyles.csl+json', 'user-agent': politeUA }, redirect: 'follow', ...(signal ? { signal } : {}) });
            if (!res.ok) return { isError: true, status: res.status, text: `HTTP ${res.status}` };
            return { data: await res.json() };
          } catch (e) { return { isError: true, text: `FETCH ${e.message}` }; }
        } });
      },
    },

    // ---- public web (SSRF-guarded): HTML pages and open-access PDFs ---------------------------------------------------------
    web: {
      async page({ url, raw = false, ctx, lane = 'web' }) {
        return rt.call({ backend: 'web', op: raw ? 'page.raw' : 'page', lane, args: { url, raw }, cacheNs: null, retries: 0, ctx, exec: async (signal) => {
          try {
            let text = ''; let start = 0; let details = null;
            for (let i = 0; i < 6; i++) {
              if (signal?.aborted) return { isError: true, text: `CANCELLED web.page: ${signal.reason?.message ?? 'aborted'}` };
              const out = await research.fetch({ url, max_chars: 100000, start_char: start, raw }, signal);
              details = out.details;
              if (details.unsupported) return { data: { unsupported: details.unsupported, final_url: details.final_url ?? url }, empty: true };
              text += out.text.replace(/^[\s\S]*?<<<UNTRUSTED EXTERNAL CONTENT[^\n]*\n(?:[^\n]*\n)*?---\n/, '').replace(/\n---\n<<<END UNTRUSTED[\s\S]*$/, '');
              if (!details.truncated) break;
              start = (details.start_char ?? start) + (details.returned_chars ?? 0);
            }
            return { data: { text, title: details?.title ?? null, final_url: details?.final_url ?? url, status: details?.status } };
          } catch (e) { return { isError: true, text: String(e.message), status: Number(String(e.message).match(/HTTP (\d{3})/)?.[1]) || undefined }; }
        } });
      },
      async pdf({ url, ctx }) {
        return rt.call({ backend: 'web', op: 'pdf', lane: 'web', args: { url }, cacheNs: null, retries: 0, timeoutMs: 120000, ctx, exec: async (signal) => {
          try {
            const policy = createPublicFetchPolicy();
            await policy.check(url);
            const res = await http.request({ method: 'GET', url, policy, signal, timeoutMs: 90000, maxBytes: 60 * 1024 * 1024, overflow: 'error', maxRedirects: 5,
              headers: { 'user-agent': MINA_USER_AGENT, accept: 'application/pdf,*/*;q=0.5' } });
            if (res.status < 200 || res.status >= 300) return { isError: true, status: res.status, text: `HTTP ${res.status}` };
            if (res.body.subarray(0, 5).toString('latin1') !== '%PDF-') return { data: { notPdf: true, contentType: res.headers['content-type'] ?? null, final_url: res.url }, empty: true };
            return { data: { pdf: res.body, final_url: res.url } };
          } catch (e) { return { isError: true, text: String(e.message) }; }
        } });
      },
    },

    /** PDF bytes → Markdown text (pymupdf4llm, the extractor that kept section structure best in testing), in the PDF sandbox: no
     *  network, no home, a cleared environment and rlimits. pymupdf4llm loads onnxruntime, which reports to Microsoft
     *  when it can; it never can here. '' when the extractor is unavailable or fails, as before. */
    async pdfToText(buf) {
      const r = await runSandboxedPython(buf, { python, script: PDF_TO_MARKDOWN, timeoutMs: 300000, maxStdoutBytes: 64 << 20, maxMemoryBytes: PDF_TO_MARKDOWN_MEMORY });
      return r?.status === 'ok' && typeof r.text === 'string' ? r.text : '';
    },

    async close() { for (const s of servers.values()) { try { await (await s).close(); } catch { /* gone */ } } servers.clear(); },
  };
  return p;
}

// onnxruntime reserves several GiB of address space; 8 GiB passed every test PDF (4 GiB did not). It also starts one
// thread per core, which spends the CPU-time limit in seconds on a large host: two threads match the old wall time.
export const PDF_TO_MARKDOWN_MEMORY = 8 * 1024 ** 3;
export const PDF_TO_MARKDOWN = RLIMIT_PRELUDE + String.raw`
import json, onnxruntime as _ort
_ort_session = _ort.InferenceSession
def _two_threads(path_or_bytes, sess_options=None, *args, **kwargs):
    so = sess_options if sess_options is not None else _ort.SessionOptions()
    so.intra_op_num_threads = 2; so.inter_op_num_threads = 1
    return _ort_session(path_or_bytes, so, *args, **kwargs)
_ort.InferenceSession = _two_threads
import pymupdf, pymupdf4llm
doc = pymupdf.open(stream=sys.stdin.buffer.read(), filetype="pdf")
sys.stdout.buffer.write(json.dumps({"status": "ok", "text": pymupdf4llm.to_markdown(doc)}, ensure_ascii=False).encode("utf-8", "replace")); sys.stdout.flush()
`;

export { normDoi };
