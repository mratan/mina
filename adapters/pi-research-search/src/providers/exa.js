// Exa search: keyed API (POST /search) with an opt-in keyless fallback through Exa's hosted MCP endpoint.
// Keyed request shape follows Exa's build-with-exa guidance: {query, type:"auto", contents:{highlights:true}} and nothing
// else; numResults only when the caller passed max_results; published-date bounds only for an explicit bounded window.
// Keyless client ported from @bytetrue/pi-web-search 0.5.1 src/providers/exa-free.ts (MIT), on the injectable client.
import { createOriginPolicy } from '../net-guard.js';
import { makeResult } from '../normalize.js';
import { MINA_USER_AGENT, MINA_VERSION } from '../user-agent.js';

export const EXA_SEARCH_URL = 'https://api.exa.ai/search';
export const EXA_MCP_URL = 'https://mcp.exa.ai/mcp';
const POLICY = createOriginPolicy([EXA_SEARCH_URL, EXA_MCP_URL]);
const MAX_BYTES = 4 * 1024 * 1024;

function errorBody(res) {
  try {
    const j = JSON.parse(res.body.toString('utf8'));
    return String(j.error ?? j.message ?? '').slice(0, 200);
  } catch { return ''; }
}

function splitAuthors(author) {
  if (!author) return undefined;
  const parts = String(author).split(/\s*[,;]\s*/).filter(Boolean);
  return parts.every((p) => /\s/.test(p)) ? parts : [String(author)];
}

export function buildExaRequest({ query, maxResults, publishedAfter, publishedBefore }) {
  const body = { query, type: 'auto', contents: { highlights: true } };
  if (maxResults !== undefined) body.numResults = maxResults;
  if (publishedAfter) body.startPublishedDate = publishedAfter;
  if (publishedBefore) body.endPublishedDate = publishedBefore;
  return body;
}

export function mapExaResults(raw, query) {
  return (raw.results ?? []).map((r, i) => {
    const pub = (r.entities ?? []).find((e) => e?.type === 'publication')?.properties ?? {};
    // Exa sometimes returns its own library page as the URL; when it also supplies the DOI, lead with the DOI resolver.
    const exaLibrary = /^https:\/\/exa\.ai\/library\//.test(r.url ?? '');
    return makeResult({
      title: r.title || pub.title,
      url: exaLibrary && pub.doi ? `https://doi.org/${pub.doi}` : r.url,
      alternate_urls: exaLibrary && pub.doi ? [r.url] : undefined,
      snippet: Array.isArray(r.highlights) ? r.highlights.join(' … ') : r.text,
      backend: 'exa',
      query,
      rank: i + 1,
      published_date: (r.publishedDate ?? pub.date)?.slice(0, 10),
      authors: pub.authors?.map((a) => a?.name).filter(Boolean) ?? splitAuthors(r.author),
      doi: pub.doi,
      type: pub.type,
      citation_count: Number.isFinite(pub.citationCount) ? pub.citationCount : undefined,
      score: Number.isFinite(r.score) ? r.score : undefined,
    });
  });
}

export async function exaKeyedSearch({ http, apiKey, query, maxResults, publishedAfter, publishedBefore, signal, timeoutMs }) {
  const res = await http.request({
    method: 'POST', url: EXA_SEARCH_URL, policy: POLICY, signal, timeoutMs, maxBytes: MAX_BYTES, overflow: 'error',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': MINA_USER_AGENT, 'x-api-key': apiKey },
    body: JSON.stringify(buildExaRequest({ query, maxResults, publishedAfter, publishedBefore })),
  });
  if (res.status !== 200) throw new Error(`Exa HTTP ${res.status}${errorBody(res) ? `: ${errorBody(res)}` : ''}`);
  const raw = JSON.parse(res.body.toString('utf8'));
  return {
    results: mapExaResults(raw, query),
    meta: { via: 'exa-api', request_id: raw.requestId, search_type: raw.resolvedSearchType || 'auto',
      cost_usd: raw.costDollars?.total, server_ms: raw.searchTime },
  };
}

// ---- keyless (Exa MCP free tier) ----

let rpcId = 1;

async function mcpPost(http, body, sessionId, signal, timeoutMs) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': MINA_USER_AGENT };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await http.request({ method: 'POST', url: EXA_MCP_URL, policy: POLICY, signal, timeoutMs, maxBytes: MAX_BYTES,
    overflow: 'error', headers, body: JSON.stringify(body) });
  if (res.status === 429) throw new Error('Exa MCP free tier rate-limited the request; set EXA_API_KEY for the keyed API');
  if (res.status < 200 || res.status >= 300) throw new Error(`Exa MCP HTTP ${res.status}`);
  const nextSession = res.headers['mcp-session-id'] ?? sessionId;
  if (body.id === undefined) return { json: null, sessionId: nextSession };
  const text = res.body.toString('utf8');
  let json;
  if ((res.headers['content-type'] ?? '').includes('text/event-stream')) {
    const last = text.split('\n').filter((l) => l.startsWith('data: ')).at(-1)?.slice(6);
    if (!last) throw new Error('Exa MCP: empty event stream');
    json = JSON.parse(last);
  } else json = JSON.parse(text);
  if (json.error) throw new Error(`Exa MCP JSON-RPC error ${json.error.code}`);
  return { json, sessionId: nextSession };
}

export function parseMcpSearchText(text, query) {
  const out = [];
  for (const block of String(text).split(/\n---+\n/)) {
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
    const url = block.match(/^URL:\s*(https?:\/\/\S+)$/m)?.[1]?.trim();
    if (!title || !url) continue;
    const published = block.match(/^Published(?: Date)?:\s*(.+)$/m)?.[1]?.trim();
    const author = block.match(/^Author:\s*(.+)$/m)?.[1]?.trim();
    const at = block.search(/^(Highlights|Text):\s*/m);
    const snippet = at >= 0 ? block.slice(at).replace(/^(Highlights|Text):\s*/m, '') : '';
    out.push(makeResult({ title, url, snippet, backend: 'exa', query, rank: out.length + 1,
      published_date: /^\d{4}/.test(published ?? '') ? published.slice(0, 10) : undefined, authors: splitAuthors(author) }));
  }
  return out;
}

export async function exaKeylessSearch({ http, query, maxResults, signal, timeoutMs }) {
  const init = await mcpPost(http, { jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mina', version: MINA_VERSION } } },
  undefined, signal, timeoutMs);
  if (!init.sessionId) throw new Error('Exa MCP: no session id returned');
  await mcpPost(http, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, init.sessionId, signal, timeoutMs).catch(() => {});
  const args = { query };
  if (maxResults !== undefined) args.numResults = maxResults;
  const call = await mcpPost(http, { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: 'web_search_exa', arguments: args } },
    init.sessionId, signal, timeoutMs);
  const text = call.json?.result?.content?.find((c) => c.type === 'text')?.text ?? '';
  return { results: parseMcpSearchText(text, query), meta: { via: 'exa-mcp-keyless' } };
}
