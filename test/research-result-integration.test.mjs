import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { withRetainedOutput } from '../lib/retained-tool-results.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import minaLiterature, { createMinaLiteratureTools, passthroughRunner } from '../extensions/literature/index.js';
import { createSupervisedLiteratureTools } from '../lib/literature-tools.mjs';
import { createLiteratureTools } from '../adapters/pi-literature-broker/index.js';
import { runFileOperation } from '../sandbox/worker-client.mjs';
import piResearchSearch, { loadConfig } from '../adapters/pi-research-search/index.js';
import { needsSandbox } from './capabilities.mjs';

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-research-result-cwd-'));
  const outputs = mkdtempSync(join(tmpdir(), 'mina-research-result-out-'));
  return { cwd, outputs, env: { MINA_SANDBOX_PROJECT: cwd, MINA_SANDBOX_WRITE: JSON.stringify([cwd]),
    MINA_SANDBOX_NET: 'offline', MINA_WORKER_OUTPUTS: outputs },
  close() { rmSync(cwd, { recursive: true, force: true }); rmSync(outputs, { recursive: true, force: true }); } };
}

test('retained result sidecars redact credentials in signed URL arguments', async () => {
  const f = fixture();
  try {
    const tool = withRetainedOutput({ name: 'fixture', execute: async () => ({ content: [{ type: 'text', text: 'X'.repeat(80000) }] }) }, { env: f.env });
    const out = await tool.execute('signed', { url: 'https://example.org/table?X-Amz-Signature=FAKE_SIGNATURE_VALUE&X-Amz-Security-Token=FAKE_SECURITY_TOKEN&part=2' });
    const sidecar = readFileSync(out.details.retainedResult.hostPath.replace(/\.txt$/, '.meta.json'), 'utf8');
    assert.doesNotMatch(sidecar, /FAKE_SIGNATURE_VALUE|FAKE_SECURITY_TOKEN/);
    assert.match(sidecar, /redacted/);
    assert.match(sidecar, /part=2/);
  } finally { f.close(); }
});

test('registered supplements share retained output delivery with the broker tools', { skip: needsSandbox }, async () => {
  const f = fixture(); let calls = 0;
  try {
    const tools = [];
    minaLiterature({ registerTool: t => tools.push(t) }, { env: f.env, broker: { providers: async () => ({}) },
      supplement: { service: { get: async () => { calls++; return { text: 'X'.repeat(80000) + 'LAST_SUPPLEMENT_CELL', details: { status: 'ok', location: { sheet: 'S2' } } }; } } } });
    const tool = tools.find(t => t.name === 'supplement_get');
    const out = await tool.execute('supplement', { url: 'https://example.org/fixture.xlsx' });
    assert.ok(out.details.retainedResult);
    assert.equal(out.details.location.sheet, 'S2');
    const retained = (await runFileOperation('read', { path: out.details.retainedResult.path }, { cwd: f.cwd, env: f.env })).toString();
    assert.match(retained, /LAST_SUPPLEMENT_CELL/);
    assert.ok(Buffer.byteLength(out.content[0].text) <= 32000);
    assert.equal(calls, 1);
  } finally { f.close(); }
});

test('non-mina literature hosts retain their existing database inline cap', async () => {
  const broker = { providers: async () => ({ mcp: async () => ({ outcome: 'ok', data: { text: 'A'.repeat(70000), tail: 'OUTSIDE_INLINE_CAP' } }) }) };
  const db = createSupervisedLiteratureTools({ literature: { broker, createLiteratureTools }, runner: passthroughRunner }).literature_db;
  const out = await db.execute('legacy', { server: 'pubmed', tool: 'pubmed_fetch_articles', args: { pmids: ['1'] } });
  assert.match(out.content[0].text, /\[truncated:/);
  assert.doesNotMatch(out.content[0].text, /OUTSIDE_INLINE_CAP/);
});

test('registered web research definitions retain oversized results before a child inherits them', { skip: needsSandbox }, async () => {
  const f = fixture(); let calls = 0;
  try {
    const registered = [];
    const http = { request: async () => { calls++; return { status: 200, headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ web: { results: [{ title: 'L'.repeat(80000) + 'LAST_SEARCH_ROW', url: 'https://example.org/fixture', description: 'Fixture' }] } })),
      redirects: [], truncated: false }; } };
    piResearchSearch({ registerTool: t => registered.push(t) }, { env: f.env, config: loadConfig({ env: {} }), keys: { brave: 'fixture-not-a-key' }, http });
    assert.deepEqual(registered.map(t => t.name), ['research_search', 'web_fetch']);
    const inherited = registered.find(t => t.name === 'research_search');
    const out = await inherited.execute('search', { query: 'fixture', mode: 'exact' });
    assert.ok(out.details.retainedResult);
    const retained = (await runFileOperation('read', { path: out.details.retainedResult.path }, { cwd: f.cwd, env: f.env })).toString();
    assert.match(retained, /LAST_SEARCH_ROW/);
    assert.ok(Buffer.byteLength(out.content[0].text) <= 32000);
    assert.equal(calls, 1);
  } finally { f.close(); }
});

test('the real mina literature_db retains the full upstream body beyond its old 50k cap, and a child worker can read it', { skip: needsSandbox }, async () => {
  const f = fixture(); let calls = 0;
  const body = { articles: Array.from({ length: 2500 }, (_, i) => ({ id: String(i), title: `Fixture row ${i} with enough text to require retention` })), tail: 'LAST_UPSTREAM_ROW' };
  const broker = { providers: async () => ({ mcp: async () => { calls++; return { outcome: 'ok', data: body, ms: 1, cached: false }; } }) };
  try {
    const db = createMinaLiteratureTools(broker, { env: f.env }).find(t => t.name === 'literature_db');
    const out = await db.execute('db', { server: 'pubmed', tool: 'pubmed_fetch_articles', args: { pmids: ['1'] } });
    const receipt = out.details.retainedResult;
    assert.ok(receipt, 'the registered definition must be wrapped before child inheritance');
    assert.ok(receipt.complete);
    const stored = (await runFileOperation('read', { path: receipt.path }, { cwd: f.cwd, env: f.env })).toString();
    assert.match(stored, /LAST_UPSTREAM_ROW/);
    assert.match(stored, /Fixture row 2499/);
    assert.doesNotMatch(stored, /\[truncated:/);
    assert.ok(Buffer.byteLength(out.content[0].text) <= 32000);
    assert.equal(calls, 1);
    assert.equal(out.details.outcome, 'ok');
  } finally { f.close(); }
});
