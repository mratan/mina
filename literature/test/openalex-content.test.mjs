import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeIdentifier, teiSections, completeness, abstractFrom, openalexContent } from '../openalex-content.mjs';

const TEI = `<TEI><teiHeader><title>x</title></teiHeader><text><body>
<div><head n="1">Introduction</head><p><s>Short reads are common.</s><s>Long reads are not.</s></p></div>
<div><head n="2">Materials and methods</head><p><s>We align &amp; chain.</s></p><formula>a &lt; b</formula></div>
<div><head n="3">Results</head><p>${'Accurate. '.repeat(600)}</p></div>
</body><back><div><head>References</head><p>not body</p></div></back></text></TEI>`;

test('identifiers normalize to one canonical form per kind', () => {
  assert.deepEqual(normalizeIdentifier('https://openalex.org/w2789843538'), { kind: 'openalex', value: 'W2789843538', key: 'W2789843538' });
  assert.equal(normalizeIdentifier('https://doi.org/10.1093/Bioinformatics/BTY191').key, 'doi:10.1093/bioinformatics/bty191');
  assert.equal(normalizeIdentifier('doi:10.1101/2024.01.01.123456').value, '10.1101/2024.01.01.123456');
  assert.equal(normalizeIdentifier('pmid:29750242').key, 'pmid:29750242');
  assert.equal(normalizeIdentifier('pmc6137996').key, 'pmcid:PMC6137996');
  assert.throws(() => normalizeIdentifier('minimap2'), /INVALID_IDENTIFIER/);
});

test('TEI body becomes ordered sections; sentences keep their spacing; the back matter is not body text', () => {
  const s = teiSections(TEI);
  assert.deepEqual(s.map((x) => x.head), ['Introduction', 'Materials and methods', 'Results']);
  assert.equal(s[0].text, 'Short reads are common. Long reads are not.');
  assert.match(s[1].text, /We align & chain\.\n\na < b/);
  assert.deepEqual(completeness(s), { complete: 'likely', body_chars: completeness(s).body_chars, sections: 3, has_methods_like: true, has_results_like: true });
  assert.equal(completeness(s.slice(0, 1)).complete, 'partial');
  assert.equal(completeness([]).complete, 'none');
  assert.equal(abstractFrom({ reads: [1], Long: [0] }), 'Long reads');
});

const fakeFetch = (routes) => async (url) => {
  const u = new URL(url);
  for (const [prefix, reply] of routes) if (decodeURIComponent(u.href).startsWith(prefix)) return reply(u);
  return new Response('no route', { status: 500 });
};
const work = (has) => ({ id: 'https://openalex.org/W1', ids: { doi: 'https://doi.org/10.1234/x', pmid: 'https://pubmed.ncbi.nlm.nih.gov/7' }, display_name: 'X',
  has_content: has, content_urls: has.grobid_xml ? { grobid_xml: 'https://content.openalex.org/works/W1.grobid-xml' } : null, open_access: { oa_status: 'gold' } });

test('content: structured sections with provenance; a selected section only; the key never appears in results or errors', async () => {
  const fetchImpl = fakeFetch([
    ['https://api.openalex.org/works/doi:10.1234/x', () => Response.json(work({ grobid_xml: true, pdf: true }))],
    ['https://content.openalex.org/works/W1.grobid-xml', () => new Response(TEI, { headers: { 'x-ratelimit-cost-usd': '0.01' } })],
  ]);
  const r = await openalexContent('10.1234/x', { apiKey: 'SECRET-KEY', fetchImpl, select: ['method'] });
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.sections.map((s) => s.head), ['Materials and methods']);
  assert.equal(r.provenance.openalex, 'W1'); assert.equal(r.provenance.pmid, '7'); assert.equal(r.provenance.cost_usd, 0.01);
  assert.equal(r.provenance.complete, 'likely');
  assert.doesNotMatch(JSON.stringify(r), /SECRET-KEY/);
  const failing = await openalexContent('10.1234/x', { apiKey: 'SECRET-KEY', fetchImpl: async (u) => { throw new Error(`connect failed for ${u}`); } });
  assert.equal(failing.status, 'ERROR');
  assert.doesNotMatch(JSON.stringify(failing), /SECRET-KEY/);
});

test('content: metadata without an OpenAlex copy is FULLTEXT_UNAVAILABLE, never a partial paper; no key is unavailable, not an error', async () => {
  const fetchImpl = fakeFetch([['https://api.openalex.org/works/W1', () => Response.json(work({ grobid_xml: false, pdf: false }))]]);
  const r = await openalexContent('W1', { apiKey: 'k', fetchImpl });
  assert.equal(r.status, 'FULLTEXT_UNAVAILABLE');
  assert.equal(r.record.title, 'X');
  assert.equal(r.sections, undefined);
  assert.equal((await openalexContent('W1', { apiKey: undefined, fetchImpl })).status, 'FULLTEXT_UNAVAILABLE');
  const missing = await openalexContent('W2', { apiKey: 'k', fetchImpl: fakeFetch([['https://api.openalex.org/works/W2', () => new Response('', { status: 404 })]]) });
  assert.equal(missing.status, 'NOT_FOUND');
});
