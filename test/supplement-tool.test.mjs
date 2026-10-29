// supplement_get through the real registration path (extensions/literature default export) with a fake pi, a fake
// broker and a fake HTTP client: schema, execute(), isError/details contract, and laziness at registration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import minaLiterature from '../extensions/literature/index.js';
import { SUPPLEMENT_GET_PARAMETERS } from '../extensions/literature/supplement-tool.mjs';
import { buildXlsx, buildZip, fakeHttp, fakeResolve, reply } from '../literature/test/supplement-fixtures.mjs';

function register(routes) {
  const tools = [];
  const http = fakeHttp(routes);
  const pi = { registerTool: (t) => tools.push(t) };
  minaLiterature(pi, { broker: { providers: async () => ({}) }, supplement: { http, resolve: fakeResolve, now: () => new Date('2026-10-23T00:00:00Z') } });
  return { tools, http, tool: tools.find((t) => t.name === 'supplement_get') };
}

test('the literature extension registers supplement_get after the five broker tools, without network at registration', () => {
  const { tools, http, tool } = register({});
  assert.deepEqual(tools.map((t) => t.name), ['literature_search', 'paper_resolve', 'paper_get', 'citation_expand', 'literature_db', 'supplement_get']);
  assert.equal(http.calls.length, 0);
  assert.equal(tool.parameters, SUPPLEMENT_GET_PARAMETERS);
  assert.deepEqual(tool.parameters.required, ['url']);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.properties.operation.enum, ['list', 'extract']);
  assert.equal(tool.parameters.properties.source.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.parameters.properties.source.properties), ['article_url', 'ref', 'doi', 'version', 'label']);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(typeof tool.execute, 'function');
  assert.ok(tool.promptGuidelines.some((g) => /not verified/.test(g)));
});

test('execute: XLSX inside a ZIP, named sheet and cells, provenance in details and text', async () => {
  const xlsx = buildXlsx({ sheets: [{ name: 'S2', rows: '<row r="7"><c r="C7" t="inlineStr"><is><t>BRCA1</t></is></c><c r="D7"><f>1/3</f><v>0.333</v></c></row>' }] });
  const url = 'https://static-content.example.org/esm/art%3A10.1%2Fx/MediaObjects/41586_2024_MOESM2_ESM.zip';
  const { tool } = register({ [url]: reply(200, buildZip([{ name: 'Supplementary Data 2.xlsx', data: xlsx }]), { 'content-type': 'application/zip' }) });
  const updates = [];
  const res = await tool.execute('call-1', { url, operation: 'extract', entry: 'Supplementary Data 2.xlsx', sheet: 'S2', range: 'C7:D7',
    source: { article_url: 'https://www.example.org/articles/s41586-024-0', ref: 'Supplementary Data 2', version: 'published 2024-05-01' } },
  undefined, (u) => updates.push(u));
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].type, 'text');
  const t = res.content[0].text;
  assert.match(t, /^7\tBRCA1\t0\.333 \[cached value of formula =1\/3\]$/m);
  assert.match(t, /Location: entry "Supplementary Data 2\.xlsx" .* · sheet "S2" · cells C7:D7 · rows 7-7/);
  assert.match(t, /retrieved 2026-10-23T00:00:00\.000Z/);
  assert.equal(res.details.status, 'ok');
  assert.equal(res.details.provenance.final_url, url);
  assert.match(res.details.provenance.sha256, /^[0-9a-f]{64}$/);
  assert.equal(res.details.linkage.verified, false);
  assert.equal(res.details.location.cells, 'C7:D7');
  assert.equal(updates.length, 1); assert.doesNotMatch(updates[0].content[0].text, /BRCA1/);
});

test('execute: access outcomes return isError with details (not a throw); invalid params and abort throw', async () => {
  const url = 'https://publisher.example.org/doi/suppl/10.1/x/suppl_file/s1.xlsx';
  const { tool } = register({ [url]: reply(403, '<html>Access Denied</html>', { 'content-type': 'text/html' }) });
  const res = await tool.execute('c', { url });
  assert.equal(res.isError, true);
  assert.equal(res.details.status, 'challenge');
  assert.equal(res.details.provenance.http_status, 403);
  assert.match(res.content[0].text, /does not solve challenges/);
  await assert.rejects(tool.execute('c', { url, operation: 'bogus' }), /operation must be/);
  const ac = new AbortController(); ac.abort(new Error('user cancelled'));
  await assert.rejects(tool.execute('c', { url }, ac.signal), /user cancelled/);
  const blocked = await tool.execute('c', { url: 'http://169.254.169.254/latest/meta-data/' });
  assert.equal(blocked.isError, true); assert.equal(blocked.details.status, 'blocked_url');
});
