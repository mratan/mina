import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arxivFromUrl, canonicalUrl, dedupeResults, doiFromUrl, makeResult, normalizeDoi, normalizeTitle, pmidFromUrl } from '../src/normalize.js';

test('identifier parsing', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1186/S13059-024-03363-Y'), '10.1186/s13059-024-03363-y');
  assert.equal(normalizeDoi('doi:10.1038/nmeth.1234.'), '10.1038/nmeth.1234');
  assert.equal(normalizeDoi('no doi here'), undefined);
  assert.equal(doiFromUrl('https://oadoi.org/10.1186/s13059-019-1727-y'), '10.1186/s13059-019-1727-y');
  assert.equal(doiFromUrl('https://pubs.acs.org/doi/abs/10.1021/acschembio.9b00079'), '10.1021/acschembio.9b00079');
  assert.equal(doiFromUrl('https://example.com/a'), undefined);
  assert.equal(pmidFromUrl('https://www.ncbi.nlm.nih.gov/pubmed/36513983'), '36513983');
  assert.equal(pmidFromUrl('https://pubmed.ncbi.nlm.nih.gov/39959302/'), '39959302');
  assert.equal(pmidFromUrl('https://europepmc.org/article/MED/42785439'), '42785439');
  assert.deepEqual(arxivFromUrl('http://arxiv.org/abs/1404.1029v1'), { id: '1404.1029', version: 'v1' });
  assert.deepEqual(arxivFromUrl('https://arxiv.org/pdf/2401.01234'), { id: '2401.01234', version: undefined });
});

test('canonical URL and title normalization', () => {
  assert.equal(canonicalUrl('http://www.Example.com/a/?utm_source=x&b=2&a=1#frag'), 'https://example.com/a?a=1&b=2');
  assert.equal(canonicalUrl('https://example.com/a/'), canonicalUrl('https://example.com/a'));
  assert.equal(normalizeTitle('Strainy: phasing & assembly | Nature Methods'), 'strainy phasing assembly');
  assert.equal(normalizeTitle('Évaluation  of  tools.'), 'evaluation of tools');
});

test('makeResult omits empty fields and never invents values', () => {
  const r = makeResult({ title: '<b>T</b> &amp; U', url: 'https://example.com', snippet: '', authors: [], doi: undefined, backend: 'brave' });
  assert.deepEqual(Object.keys(r).sort(), ['backend', 'title', 'url']);
  assert.equal(r.title, 'T & U');
});

const R = (o) => makeResult({ snippet: 's', ...o });

test('dedupe by DOI, then PMID, then canonical URL; provenance is accumulated', () => {
  const merged = dedupeResults([
    R({ title: 'Melon: long-read profiler', url: 'https://oadoi.org/10.1186/s13059-024-03363-y', backend: 'searxng', source_engines: ['crossref'], query: 'q' }),
    R({ title: 'Melon: metagenomic long-read-based taxonomic identification', url: 'https://europepmc.org/article/MED/39160564', doi: '10.1186/S13059-024-03363-Y', backend: 'searxng', source_engines: ['europepmc'], query: 'q' }),
    R({ title: 'Melon (PubMed)', url: 'https://www.ncbi.nlm.nih.gov/pubmed/39160564', backend: 'searxng', source_engines: ['pubmed'], query: 'q' }),
    R({ title: 'Some page', url: 'http://www.example.com/x/', backend: 'brave', query: 'q' }),
    R({ title: 'Some page again', url: 'https://example.com/x', backend: 'exa', query: 'q2' }),
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].source_engines, ['crossref', 'europepmc', 'pubmed']);
  assert.equal(merged[0].pmid, '39160564');
  assert.equal(merged[0].alternate_urls.length, 2);
  assert.deepEqual(merged[1].backends, ['brave', 'exa']);
  assert.deepEqual(merged[1].queries, ['q', 'q2']);
});

test('title matches merge copies of the same record but never a preprint with its publication or two DOIs', () => {
  const title = 'Strain-level metagenomic assignment and compositional estimation for long reads';
  const merged = dedupeResults([
    R({ title, url: 'https://www.nature.com/articles/s41467-019-10934-2', backend: 'exa' }),
    R({ title: `${title} | Nature Communications`, url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6624308/', backend: 'brave' }),
    R({ title, url: 'https://www.biorxiv.org/content/10.1101/362707v1', backend: 'searxng' }),
  ]);
  // nature + pmc merge (same record, no DOI conflict); the bioRxiv preprint stays apart.
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].backends, ['exa', 'brave']);
  assert.ok(merged.some((m) => m.url.includes('biorxiv') && m.backends.length === 1));

  const twoDois = dedupeResults([
    R({ title, url: 'https://journal-a.example/x', doi: '10.1000/aaa', backend: 'searxng' }),
    R({ title, url: 'https://journal-b.example/y', doi: '10.1000/bbb', backend: 'searxng' }),
    R({ title, url: 'https://journal-c.example/z', backend: 'brave' }),
  ]);
  // Different DOIs never merge; a DOI-less copy with the same title joins the first compatible record.
  assert.equal(twoDois.length, 2);
  assert.deepEqual(twoDois.map((m) => m.doi), ['10.1000/aaa', '10.1000/bbb']);
});

test('arXiv versions are distinct records', () => {
  const merged = dedupeResults([
    R({ title: 'A long enough arxiv paper title', url: 'http://arxiv.org/abs/1404.1029v1', backend: 'searxng' }),
    R({ title: 'A long enough arxiv paper title', url: 'http://arxiv.org/abs/1404.1029v2', backend: 'searxng' }),
  ]);
  assert.equal(merged.length, 2);
});
