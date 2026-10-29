import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearchTools } from '../src/tools.js';
import { buildExaRequest, mapExaResults } from '../src/providers/exa.js';
import { buildBraveUrl } from '../src/providers/brave.js';
import { buildSearxngUrl, interleaveByEngine, mapSearxngResults } from '../src/providers/searxng.js';
import { describeKeys, loadConfig, loadKeys, parseKeyFile } from '../src/config.js';
import { contactEmail, MINA_USER_AGENT, MINA_VERSION, minaUserAgent } from '../src/user-agent.js';

const json = (status, obj, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(obj)), truncated: false, redirects: [] });

function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      if (req.policy) await req.policy.check(req.url);
      const u = new URL(req.url);
      for (const [prefix, handler] of routes) if (`${u.origin}${u.pathname}`.startsWith(prefix)) return { url: req.url, ...handler(req, u) };
      throw new Error(`no route for ${req.url}`);
    },
  };
}

const EXA = { results: [
  { title: 'Strainy | Nature Methods', url: 'https://www.nature.com/articles/s41592-024-02424-1', publishedDate: '2024-09-26T00:00:00.000Z', highlights: ['phasing strain haplotypes'] },
  { title: 'lib', url: 'https://exa.ai/library/publication/abc', highlights: ['h'], entities: [{ type: 'publication', properties: { doi: '10.1234/X', authors: [{ name: 'A B' }], date: '2024-11-20', type: 'preprint', citationCount: 2 } }] },
], requestId: 'r1', costDollars: { total: 0.007 } };
const BRAVE = { web: { results: [{ title: 'Strainy GitHub', url: 'https://github.com/katerinakazantseva/strainy', description: '<strong>Strainy</strong> &amp; more', page_age: '2025-01-02T00:00:00', meta_url: { hostname: 'github.com' } }] } };
const SX = { results: [
  { title: 'Strainy: phasing and assembly', url: 'https://oadoi.org/10.1038/s41592-024-02424-1', content: '<jats:p>Abstract text</jats:p>', engines: ['openalex', 'crossref'], score: 2, publishedDate: '2024-09-26T00:00:00', authors: ['E Kazantseva'], journal: 'Nature Methods', doi: '10.1038/s41592-024-02424-1', comments: '120 citations' },
  { title: 'Unrelated', url: 'https://www.ncbi.nlm.nih.gov/pubmed/1', content: 'x', engines: ['pubmed'], score: 1, publishedDate: 'None' },
], unresponsive_engines: [['google scholar', 'access denied']] };

const routes = (over = {}) => [
  ['https://api.exa.ai/search', over.exa ?? (() => json(200, EXA))],
  ['https://api.search.brave.com/res/v1/web/search', over.brave ?? (() => json(200, BRAVE))],
  ['http://127.0.0.1:18080/search', over.searxng ?? (() => json(200, SX))],
];
const KEYS = { exa: 'test-exa-key', brave: 'test-brave-key' };

test('Exa request follows the build-with-exa recommended shape', () => {
  assert.deepEqual(buildExaRequest({ query: 'q' }), { query: 'q', type: 'auto', contents: { highlights: true } });
  assert.deepEqual(buildExaRequest({ query: 'q', maxResults: 5, publishedAfter: '2024-01-01' }),
    { query: 'q', type: 'auto', contents: { highlights: true }, numResults: 5, startPublishedDate: '2024-01-01' });
  const [, lib] = mapExaResults(EXA, 'q');
  assert.equal(lib.url, 'https://doi.org/10.1234/X');
  assert.deepEqual(lib.alternate_urls, ['https://exa.ai/library/publication/abc']);
  assert.equal(lib.doi, '10.1234/x');
  assert.deepEqual(lib.authors, ['A B']);
});

test('Brave and SearXNG URL building and mapping', () => {
  const b = new URL(buildBraveUrl({ query: 'site:docs.vllm.ai "expert parallel"', publishedAfter: '2025-01-01', today: new Date('2026-10-02') }));
  assert.equal(b.searchParams.get('q'), 'site:docs.vllm.ai "expert parallel"');
  assert.equal(b.searchParams.get('count'), '10');
  assert.equal(b.searchParams.get('freshness'), '2025-01-01to2026-10-02');
  const s = new URL(buildSearxngUrl('http://127.0.0.1:18080', { query: 'q', engines: ['pubmed', 'semantic scholar'] }));
  assert.equal(s.pathname, '/search');
  assert.equal(s.searchParams.get('format'), 'json');
  assert.equal(s.searchParams.get('engines'), 'pubmed,semantic scholar');
  const m = mapSearxngResults(SX, 'q');
  assert.equal(m[0].snippet, 'Abstract text');
  assert.equal(m[0].venue, 'Nature Methods');
  assert.equal(m[0].citation_count, 120);
  assert.equal(m[1].published_date, undefined);
});

test('literature interleave: preferred engines lead, multi-engine and on-topic results first within an engine', () => {
  const rs = [
    { title: 'off topic', source_engines: ['pubmed'] },
    { title: 'long read taxonomic profiler benchmark', source_engines: ['pubmed'] },
    { title: 'oa one', source_engines: ['openalex'] },
    { title: 'consensus', source_engines: ['crossref', 'europepmc'] },
  ];
  const pri = ['pubmed', 'europepmc', 'openalex', 'crossref'];
  // Without the on-topic tier (minOverlap 0): plain priority round-robin, multi-engine and on-topic first within an engine.
  const flat = interleaveByEngine(rs, pri, 'long-read taxonomic profiler benchmarking', 0);
  assert.deepEqual(flat.map((r) => r.title), ['long read taxonomic profiler benchmark', 'consensus', 'oa one', 'off topic']);
  // Default: on-topic results (lexical overlap >= 0.5) from any engine lead; low-priority engines are not pushed into the top.
  const more = [...rs, { title: 'taxonomic profiler benchmark for long read metagenomes', source_engines: ['crossref'] }, { title: 'click metamaterials', source_engines: ['arxiv'] }];
  const bio = interleaveByEngine(more, [...pri, 'arxiv'], 'long-read taxonomic profiler benchmarking');
  assert.deepEqual(bio.map((r) => r.title).slice(0, 2), ['long read taxonomic profiler benchmark', 'taxonomic profiler benchmark for long read metagenomes']);
  assert.deepEqual(bio.map((r) => r.rank), [1, 2, 3, 4, 5, 6]);
  assert.ok(bio.findIndex((r) => r.title === 'click metamaterials') > 1);
});

test('each backend is addressable on its own', async () => {
  for (const [backend, origin] of [['exa', 'https://api.exa.ai'], ['brave', 'https://api.search.brave.com'], ['searxng', 'http://127.0.0.1:18080']]) {
    const http = fakeHttp(routes());
    const t = createResearchTools({ http, keys: KEYS });
    const { details } = await t.search({ query: 'strainy', backends: [backend] });
    assert.deepEqual(details.backends, [backend]);
    assert.equal(http.calls.length, 1);
    assert.equal(new URL(http.calls[0].url).origin, origin);
    assert.ok(['GET', 'POST'].includes(http.calls[0].method));
  }
});

test('Exa gets no numResults unless max_results is passed', async () => {
  const http = fakeHttp(routes());
  const t = createResearchTools({ http, keys: KEYS });
  await t.search({ query: 'q', mode: 'discover' });
  assert.equal(JSON.parse(http.calls[0].body).numResults, undefined);
  await t.search({ query: 'q', mode: 'discover', max_results: 3 });
  assert.equal(JSON.parse(http.calls[1].body).numResults, 3);
  assert.equal(http.calls[1].headers['x-api-key'], 'test-exa-key');
  assert.equal(http.calls[1].headers['user-agent'], MINA_USER_AGENT, 'Exa is sent Mina\'s identity');
  await t.search({ query: 'q', mode: 'docs' });
  assert.equal(http.calls[2].headers['user-agent'], MINA_USER_AGENT, 'Brave is sent Mina\'s identity');
});

test('verify runs all three, merges by DOI, reports coverage, unresponsive engines and the no-negative-evidence note', async () => {
  const http = fakeHttp(routes());
  const t = createResearchTools({ http, keys: KEYS, config: { braveMinIntervalMs: 0 } });
  const r = await t.researchSearch.execute('id', { query: 'Strainy strain phasing', mode: 'verify' }, undefined, undefined, {});
  const d = r.details;
  assert.deepEqual(d.backends, ['exa', 'searxng', 'brave']);
  const strainy = d.results.find((x) => x.doi === '10.1038/s41592-024-02424-1');
  assert.ok(strainy, 'the SearXNG record carries the Strainy DOI');
  assert.ok(d.coverage.unique_sources >= 4);
  const text = r.content[0].text;
  assert.match(text, /unresponsive: google scholar \(access denied\)/);
  assert.match(text, /not evidence that a source, method or feature does not exist/);
  assert.match(text, /via searxng\[openalex, crossref\]/);
  assert.doesNotMatch(text, /test-exa-key|test-brave-key/);
});

test('partial failure degrades; total failure throws; missing keys are reported', async () => {
  const http = fakeHttp(routes({ brave: () => json(500, {}) }));
  const t = createResearchTools({ http, keys: KEYS, config: { braveMinIntervalMs: 0 } });
  const r = await t.search({ query: 'q', mode: 'verify' });
  assert.match(r.text, /brave: FAILED \(Brave HTTP 500\)/);
  assert.ok(r.details.results.length > 0);
  const none = createResearchTools({ http: fakeHttp(routes()), keys: {}, config: { exaKeyless: false } });
  await assert.rejects(none.search({ query: 'q', mode: 'docs' }), /No search backend is configured for this mode: brave: skipped \(BRAVE_SEARCH_API_KEY is not configured\)/);
  await assert.rejects(none.search({ query: 'q', mode: 'discover' }), /EXA_API_KEY is not configured; keyless Exa is opt-in \(set MINA_EXA_KEYLESS=1/);
  // the default is the same: keyless Exa is opt-in; an unconfigured backend is SKIPPED, not FAILED, and nothing is sent
  const h = fakeHttp(routes());
  const dflt = createResearchTools({ http: h, keys: { brave: 'test-brave-key' }, config: { braveMinIntervalMs: 0, searxngMinIntervalMs: 0 } });
  const v = await dflt.search({ query: 'q', mode: 'verify' });
  assert.match(v.text, /- exa: SKIPPED \(EXA_API_KEY is not configured; keyless Exa is opt-in/);
  assert.ok(!h.calls.some((c) => /exa\.ai/.test(c.url)), 'no request to Exa');
  assert.equal(v.details.calls.find((c) => c.backend === 'exa').status, 'skipped');
});

test('keyless Exa: MINA_EXA_KEYLESS=1 opts in through loadConfig; explicit config wins; default off', () => { // gitleaks:allow (a test name, not a key)
  assert.equal(loadConfig({ env: {} }).exaKeyless, false);
  assert.equal(loadConfig({ env: { MINA_EXA_KEYLESS: '1' } }).exaKeyless, true);
  assert.equal(loadConfig({ env: { MINA_EXA_KEYLESS: 'yes' } }).exaKeyless, true);
  assert.equal(loadConfig({ env: { MINA_EXA_KEYLESS: '0' } }).exaKeyless, false);
  assert.equal(loadConfig({ env: { MINA_EXA_KEYLESS: '1' }, overrides: { exaKeyless: false } }).exaKeyless, false);
});

test('User-Agent: web_fetch sends Mina/<version> by default; fetch.userAgent "browser" sends the browser string', async () => {
  const page = () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<title>t</title><p>x</p>'), truncated: false, redirects: [] });
  for (const [setting, re] of [[undefined, /^Mina\/\S+ \(\+https:\/\/github\.com\/mratan\/mina\)$/], ['browser', /Chrome\/124/], ['mina', /^Mina\/\S+ \(\+https:\/\/github\.com\/mratan\/mina\)$/]]) {
    const h = fakeHttp([['https://example.org/', page]]);
    const t = createResearchTools({ http: h, config: { fetch: { allowHosts: ['example.org'], ...(setting ? { userAgent: setting } : {}) } } });
    await t.fetch({ url: 'https://example.org/a' });
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].headers['user-agent'], re, String(setting));
  }
  assert.equal(MINA_USER_AGENT, `Mina/${MINA_VERSION} (+https://github.com/mratan/mina)`);
  assert.equal(minaUserAgent({ contact: 'a@example.org' }), `Mina/${MINA_VERSION} (+https://github.com/mratan/mina; mailto:a@example.org)`);
  assert.equal(minaUserAgent({ contact: 'bad\r\nX: y' }), MINA_USER_AGENT, 'header injection is not passed through');
  assert.equal(contactEmail({ env: {}, keys: {} }), null);
  assert.equal(contactEmail({ env: { NCBI_ADMIN_EMAIL: 'n@example.org' }, keys: { RESEARCH_EMAIL: 'r@example.org' } }), 'r@example.org', 'RESEARCH_EMAIL first, env or key file');
});

test('alt_queries run on the same backends and are recorded per result', async () => {
  const http = fakeHttp(routes());
  const t = createResearchTools({ http, keys: KEYS });
  const r = await t.search({ query: 'q1', mode: 'discover', alt_queries: ['q2', 'q1', 'q3', 'q4', 'q5'] });
  assert.deepEqual(r.details.alt_queries, ['q2', 'q3', 'q4']);
  assert.equal(http.calls.length, 4);
  assert.deepEqual(r.details.results[0].queries, ['q1', 'q2', 'q3', 'q4']);
});

test('SearXNG calls are serialized with a minimum gap (PubMed/NCBI rate limit)', async () => {
  const starts = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const http = fakeHttp(routes({ searxng: () => { starts.push(Date.now()); return json(200, SX); } }));
  const wrapped = { calls: http.calls, async request(req) {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try { await new Promise((r) => setTimeout(r, 5)); return await http.request(req); } finally { inFlight--; }
  } };
  const t = createResearchTools({ http: wrapped, keys: KEYS, config: { searxngMinIntervalMs: 60 } });
  await t.search({ query: 'q1', mode: 'literature', alt_queries: ['q2', 'q3'] });
  assert.equal(starts.length, 3);
  assert.equal(maxInFlight, 1);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 55, `gap ${starts[i] - starts[i - 1]} ms`);
});

test('web_fetch: refuses non-public targets before any request; SearXNG is not reachable through it', async () => {
  const http = fakeHttp([]);
  const t = createResearchTools({ http, keys: KEYS });
  for (const url of ['http://127.0.0.1:18080/search?q=x&format=json', 'http://localhost:18080/', 'http://169.254.169.254/', 'http://10.0.0.1/', 'http://[fd00::1]/', 'file:///etc/passwd', `https://e.com/${'a'.repeat(2100)}`]) {
    await assert.rejects(t.webFetch.execute('id', { url }, undefined, undefined, {}), undefined, url);
  }
  assert.equal(http.calls.length, 0);
});

test('web_fetch: HTML to text with markers, JSON pretty-printing, PDF notice, binary refusal, continuation', async () => {
  const page = '<html><head><title>T &amp; T</title><style>x{}</style><script>evil()</script></head><body><h1>Head</h1><p>Hello <b>world</b></p><ul><li>a</li></ul></body></html>';
  const http = {
    async request(req) {
      await req.policy.check(req.url);
      const u = new URL(req.url);
      const mk = (ct, body) => ({ status: 200, url: req.url, redirects: [], truncated: false, headers: { 'content-type': ct }, body: Buffer.from(body) });
      if (u.pathname === '/page') return mk('text/html; charset=utf-8', page);
      if (u.pathname === '/json') return mk('application/json', '{"a":1}');
      if (u.pathname === '/pdf') return { ...mk('application/pdf', ''), skipped: true };
      if (u.pathname === '/img') return mk('image/png', '');
      if (u.pathname === '/long') return mk('text/plain', 'x'.repeat(2000));
      return { ...mk('text/plain', ''), status: 404 };
    },
  };
  const t = createResearchTools({ http, config: { fetch: { allowHosts: [] } } });
  // 93.184.215.14 is a public literal: no DNS needed.
  const base = 'http://93.184.215.14';
  const p = await t.fetch({ url: `${base}/page` });
  assert.match(p.text, /^<<<UNTRUSTED EXTERNAL CONTENT/);
  assert.match(p.text, /Title: T & T/);
  assert.match(p.text, /# Head\nHello world\n+- a/);
  assert.doesNotMatch(p.text, /evil|x\{\}/);
  assert.equal(p.details.untrusted, true);
  assert.match((await t.fetch({ url: `${base}/json` })).text, /\{\n {2}"a": 1\n\}/);
  assert.match((await t.fetch({ url: `${base}/pdf` })).text, /PDF text extraction is not supported/);
  await assert.rejects(t.fetch({ url: `${base}/img` }), /Unsupported content type image\/png/);
  await assert.rejects(t.fetch({ url: `${base}/missing` }), /HTTP 404/);
  const l = await t.fetch({ url: `${base}/long`, max_chars: 500 });
  assert.equal(l.details.truncated, true);
  assert.match(l.text, /continue with start_char=500/);
  const l2 = await t.fetch({ url: `${base}/long`, max_chars: 1500, start_char: 1500 });
  assert.equal(l2.details.returned_chars, 500);
  assert.equal(l2.details.truncated, false);
});

test('key files: KEY=value and export KEY=value; env wins; describeKeys never exposes values', (t) => {
  assert.equal(parseKeyFile('export EXA_API_KEY=abc123\n', 'EXA_API_KEY'), 'abc123');
  assert.equal(parseKeyFile('BRAVE_SEARCH_API_KEY="q w"', 'BRAVE_SEARCH_API_KEY'), 'q w');
  assert.equal(parseKeyFile('OTHER=1', 'EXA_API_KEY'), undefined);
  const dir = mkdtempSync(join(tmpdir(), 'prs-keys-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'exa'), 'export EXA_API_KEY=file-exa\n');
  writeFileSync(join(dir, 'brave'), 'BRAVE_SEARCH_API_KEY=file-brave\n');
  const env = { PI_CODING_AGENT_DIR: dir };
  assert.deepEqual({ ...loadKeys({ env, keysDir: dir }) }, { exa: 'file-exa', brave: 'file-brave' });
  const k = loadKeys({ env: { ...env, EXA_API_KEY: 'env-exa' }, keysDir: dir });
  assert.equal(k.exa, 'env-exa');
  const described = JSON.stringify(describeKeys(k));
  assert.doesNotMatch(described, /env-exa|file-brave/);
  assert.match(described, /present/);
});
