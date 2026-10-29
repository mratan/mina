import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuery, resolveRoute } from '../src/router.js';

test('auto classification', () => {
  const cases = [
    ['strain-resolved metagenomic profiling with long reads', 'discover'],
    ['covalently retaining RNA in hydrogels', 'discover'],
    ['spatially resolved microbiome analysis', 'discover'],
    ['recent papers benchmarking long-read metagenomic taxonomic profilers', 'literature'],
    ['bioRxiv preprints on CRISPR off-target detection', 'literature'],
    ['"RuntimeError: CUDA error: device-side assert triggered"', 'exact'],
    ['site:docs.vllm.ai tensor_parallel_size', 'docs'],
    ['vLLM docs for expert parallelism', 'docs'],
    ['minimap2 -x map-ont preset documentation', 'docs'],
    ['tensor_parallel_size', 'exact'],
    ['seqkit install instructions', 'docs'],
  ];
  for (const [q, mode] of cases) assert.equal(classifyQuery(q).mode, mode, q);
});

test('explicit modes map to backends; backends override; bad input rejected', () => {
  assert.deepEqual(resolveRoute({ query: 'x', mode: 'discover' }).backends, ['exa']);
  assert.deepEqual(resolveRoute({ query: 'x', mode: 'literature' }).backends, ['searxng']);
  assert.deepEqual(resolveRoute({ query: 'x', mode: 'docs' }).backends, ['brave']);
  assert.deepEqual(resolveRoute({ query: 'x', mode: 'exact' }).backends, ['brave']);
  assert.deepEqual(resolveRoute({ query: 'x', mode: 'verify' }).backends, ['exa', 'searxng', 'brave']);
  assert.deepEqual(resolveRoute({ query: 'x', mode: 'verify', backends: ['exa', 'searxng'] }).backends, ['exa', 'searxng']);
  assert.deepEqual(resolveRoute({ query: 'x', mode: 'docs', backends: ['exa'] }).backends, ['exa']);
  assert.throws(() => resolveRoute({ query: 'x', mode: 'web' }), /Unknown mode/);
  assert.throws(() => resolveRoute({ query: 'x', mode: 'auto', backends: ['tavily'] }), /Unknown backend/);
});
