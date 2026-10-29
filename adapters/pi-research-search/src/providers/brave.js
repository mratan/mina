// Brave Search web API. Request shape from @bytetrue/pi-web-search 0.5.1 src/providers/brave.ts (MIT); richer mapping.
import { createOriginPolicy } from '../net-guard.js';
import { makeResult } from '../normalize.js';
import { MINA_USER_AGENT } from '../user-agent.js';

export const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const POLICY = createOriginPolicy([BRAVE_SEARCH_URL]);
export const BRAVE_DEFAULT_COUNT = 10;
export const BRAVE_MAX_COUNT = 20;

export function buildBraveUrl({ query, maxResults, publishedAfter, publishedBefore, today = new Date() }) {
  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(maxResults ?? BRAVE_DEFAULT_COUNT, BRAVE_MAX_COUNT)));
  if (publishedAfter || publishedBefore) {
    const from = (publishedAfter ?? '1970-01-01').slice(0, 10);
    const to = (publishedBefore ?? today.toISOString()).slice(0, 10);
    url.searchParams.set('freshness', `${from}to${to}`);
  }
  return url.toString();
}

export function mapBraveResults(raw, query) {
  return (raw.web?.results ?? []).map((r, i) => makeResult({
    title: r.title,
    url: r.url,
    snippet: [r.description, ...(r.extra_snippets ?? [])].filter(Boolean).join(' … '),
    backend: 'brave',
    query,
    rank: i + 1,
    published_date: r.page_age?.slice(0, 10),
    site: r.meta_url?.hostname || r.profile?.long_name,
  }));
}

export async function braveSearch({ http, apiKey, query, maxResults, publishedAfter, publishedBefore, signal, timeoutMs }) {
  const url = buildBraveUrl({ query, maxResults, publishedAfter, publishedBefore });
  const res = await http.request({ method: 'GET', url, policy: POLICY, signal, timeoutMs, maxBytes: 4 * 1024 * 1024, overflow: 'error',
    headers: { accept: 'application/json', 'user-agent': MINA_USER_AGENT, 'x-subscription-token': apiKey } });
  if (res.status === 429) { const e = new Error('Brave HTTP 429 (rate limited)'); e.retryable = true; throw e; }
  if (res.status !== 200) throw new Error(`Brave HTTP ${res.status}`);
  const raw = JSON.parse(res.body.toString('utf8'));
  return { results: mapBraveResults(raw, query), meta: { via: 'brave-web-api', altered_query: raw.query?.altered || undefined } };
}
