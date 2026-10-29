import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';
import { createSupplementService } from '../supplements.mjs';
import { DEFAULT_PYTHON } from '../supplements/pdf.mjs';
import { BWRAP } from '../supplements/pdf-sandbox.mjs';
import { parseRange } from '../supplements/xlsx.mjs';
import { walkXml } from '../supplements/xml.mjs';
import { createNodeHttpClient } from '../../adapters/pi-research-search/src/http.js';
import { buildPdf, buildXlsx, buildZip, fakeHttp, fakeResolve, reply } from './supplement-fixtures.mjs';

const NOW = () => new Date('2026-10-23T12:00:00.000Z');
const BASE = 'https://files.example.org/suppl/';
const svc = (routes, extra = {}) => {
  const httpc = fakeHttp(routes);
  return { http: httpc, s: createSupplementService({ http: httpc, resolve: fakeResolve, now: NOW, ...extra }) };
};
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- URL / redirect policy

test('refuses loopback, private, metadata, credentialed and non-http URLs before any request', async () => {
  const { s, http: h } = svc({});
  for (const url of ['http://127.0.0.1/x.csv', 'http://localhost/x.csv', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/a.csv',
    'http://10.1.2.3/a.csv', 'file:///etc/passwd', 'https://user:pw@files.example.org/a.csv', 'https://host.private.test/a.csv', 'http://[::ffff:127.0.0.1]/a.csv']) {
    const r = await s.get({ url });
    assert.equal(r.status, 'blocked_url', url);
    assert.equal(r.isError, true);
  }
  assert.equal(h.calls.length, 0);
});

test('a redirect to a metadata/private address is refused before the second hop', async () => {
  const { s, http: h } = svc({ [`${BASE}a.csv`]: reply(302, '', { location: 'http://169.254.169.254/latest/meta-data/iam' }),
    [`${BASE}b.csv`]: reply(301, '', { location: 'https://cdn.private.test/b.csv' }) });
  const r = await s.get({ url: `${BASE}a.csv` });
  assert.equal(r.status, 'blocked_redirect');
  assert.equal(r.details.refused_url, 'http://169.254.169.254/latest/meta-data/iam');
  const r2 = await s.get({ url: `${BASE}b.csv` });
  assert.equal(r2.status, 'blocked_redirect');
  assert.deepEqual(h.calls.map((c) => c.url), [`${BASE}a.csv`, `${BASE}b.csv`]);
  assert.ok(h.calls.every((c) => /^Mina\/\S+ \(\+https:\/\/github\.com\/mratan\/mina\)$/.test(c.headers['user-agent'])), 'supplement downloads send Mina\'s identity');
});

test('real node client: redirect from an allowed local test server to loopback/metadata is refused by the shared policy', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/meta') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
    if (req.url === '/loop') { res.writeHead(302, { location: 'http://localhost:1/x.csv' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/csv' }); res.end('a,b\n1,2\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const s = createSupplementService({ http: createNodeHttpClient(), allowHosts: [`127.0.0.1:${port}`], now: NOW });
    const ok = await s.get({ url: `http://127.0.0.1:${port}/t.csv`, operation: 'extract' });
    assert.equal(ok.status, 'ok');
    assert.match(ok.text, /^2\t1\t2$/m);
    assert.equal((await s.get({ url: `http://127.0.0.1:${port}/meta` })).status, 'blocked_redirect');
    assert.equal((await s.get({ url: `http://127.0.0.1:${port}/loop` })).status, 'blocked_redirect');
    // allowHosts is host:port exact: another port on the same host is still refused
    assert.equal((await s.get({ url: `http://127.0.0.1:${port + 1}/x.csv` })).status, 'blocked_url');
  } finally { server.close(); }
});

// ---------------------------------------------------------------- access / type outcomes

test('403, challenge, 429, 404, 5xx are typed access outcomes; their bodies are never shown or parsed', async () => {
  const { s } = svc({
    [`${BASE}403.xlsx`]: reply(403, 'SECRET-DENIAL-BODY', { 'content-type': 'text/plain' }),
    [`${BASE}cf.xlsx`]: reply(403, '<!DOCTYPE html><html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script></html>', { 'content-type': 'text/html' }),
    [`${BASE}429.csv`]: reply(429, 'slow down', { 'retry-after': '120' }),
    [`${BASE}404.csv`]: reply(404, 'nope'),
    [`${BASE}500.csv`]: reply(500, 'boom'),
    [`${BASE}ok-but-challenge.csv`]: reply(200, '<html><body>Please verify you are a human (captcha)</body></html>', { 'content-type': 'text/html' }),
  });
  const r403 = await s.get({ url: `${BASE}403.xlsx` });
  assert.equal(r403.status, 'access_denied'); assert.equal(r403.isError, true); assert.equal(r403.details.provenance.http_status, 403);
  assert.doesNotMatch(r403.text, /SECRET-DENIAL-BODY/);
  assert.equal((await s.get({ url: `${BASE}cf.xlsx` })).status, 'challenge');
  const r429 = await s.get({ url: `${BASE}429.csv` });
  assert.equal(r429.status, 'rate_limited'); assert.equal(r429.details.retry_after, '120'); assert.match(r429.text, /Retry-After: 120/);
  assert.equal((await s.get({ url: `${BASE}404.csv` })).status, 'not_found');
  assert.equal((await s.get({ url: `${BASE}500.csv` })).status, 'http_error');
  assert.equal((await s.get({ url: `${BASE}ok-but-challenge.csv`, operation: 'extract' })).status, 'challenge');
});

test('HTML masquerading as CSV/XLSX and MIME/magic mismatches are refused, never parsed as tables', async () => {
  const html = '<!DOCTYPE html><html><head><title>Article</title></head><body><table><tr><td>1</td></tr></table></body></html>';
  const { s } = svc({
    [`${BASE}fake.csv`]: reply(200, html, { 'content-type': 'text/csv' }),
    [`${BASE}fake.xlsx`]: reply(200, `\n  ${html}`, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    [`${BASE}pdf-but-zip.pdf`]: reply(200, buildZip([{ name: 'a.csv', data: 'x' }]), { 'content-type': 'application/pdf' }),
    [`${BASE}csv-as-html`]: reply(200, 'a,b\n1,2\n', { 'content-type': 'text/html' }),
    [`${BASE}zip-as-csv.csv`]: reply(200, buildZip([{ name: 'a.csv', data: 'x' }]), { 'content-type': 'text/csv' }),
    [`${BASE}img.png`]: reply(200, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), { 'content-type': 'image/png' }),
    [`${BASE}old.xls`]: reply(200, Buffer.from('d0cf11e0a1b11ae1000000000000', 'hex'), { 'content-type': 'application/vnd.ms-excel' }),
  });
  for (const f of ['fake.csv', 'fake.xlsx']) {
    const r = await s.get({ url: `${BASE}${f}`, operation: 'extract' });
    assert.equal(r.status, 'html_not_file', f); assert.equal(r.isError, true); assert.equal(r.details.result, undefined);
  }
  assert.equal((await s.get({ url: `${BASE}pdf-but-zip.pdf` })).status, 'type_mismatch');
  assert.equal((await s.get({ url: `${BASE}csv-as-html`, operation: 'extract' })).status, 'type_mismatch');
  assert.equal((await s.get({ url: `${BASE}zip-as-csv.csv` })).status, 'type_mismatch');
  const img = await s.get({ url: `${BASE}img.png` });
  assert.equal(img.status, 'unsupported_format'); assert.match(img.text, /no OCR/);
  assert.equal((await s.get({ url: `${BASE}old.xls` })).status, 'unsupported_format');
});

test('downloads over the byte limit are too_large (bounded read, nothing parsed)', async () => {
  const { s } = svc({ [`${BASE}big.csv`]: reply(200, 'a,b\n'.repeat(5000), { 'content-type': 'text/csv' }) }, { limits: { maxDownloadBytes: 1000 } });
  const r = await s.get({ url: `${BASE}big.csv`, operation: 'extract' });
  assert.equal(r.status, 'too_large'); assert.equal(r.isError, true);
});

// ---------------------------------------------------------------- CSV / TSV

test('CSV: bounded extract with row/column provenance, pagination, Unicode, quoted newlines, no formula evaluation', async () => {
  const lines = ['gene,"description",score,=cmd|calc'];
  for (let i = 1; i <= 120; i++) lines.push(`G${i},"Zellkern ü 日本 🧬, line ""${i}""",${i / 10},=1+${i}`);
  lines[3] = 'G3,"multi\nline",0.3,=1+3';
  const body = Buffer.from(lines.join('\r\n'), 'utf8');
  const url = `${BASE}Table_S1.csv`;
  const { s } = svc({ [url]: reply(200, body, { 'content-type': 'text/csv; charset=utf-8', etag: '"v7"', 'last-modified': 'Tue, 01 Oct 2024 00:00:00 GMT' }) });
  const source = { article_url: 'https://journal.example.org/article/10.1/abc', ref: 'Supplementary Table S1', version: 'VoR', doi: '10.1/abc' };
  const list = await s.get({ url, source });
  assert.equal(list.status, 'ok'); assert.equal(list.details.result.records, 121); assert.equal(list.details.format, 'csv');
  const r = await s.get({ url, operation: 'extract', range: 'A1:C', offset: 1, limit: 3, source });
  assert.equal(r.status, 'ok'); assert.equal(r.isError, false);
  const p = r.details.provenance;
  assert.equal(p.sha256, sha(body)); assert.equal(p.final_url, url); assert.equal(p.retrieved_at, '2026-10-23T12:00:00.000Z');
  assert.equal(p.etag, '"v7"'); assert.equal(p.cache, 'hit');
  assert.deepEqual(r.details.linkage.caller_supplied, source); assert.equal(r.details.linkage.verified, false);
  assert.match(r.text, /Linkage \(caller-supplied, NOT verified\)/);
  assert.equal(r.details.location.rows, '2-4'); assert.equal(r.details.location.columns, 'A-C');
  assert.equal(r.details.pagination.next_offset, 4);
  assert.match(r.text, /^row\tA\tB\tC$/m);
  assert.match(r.text, /^2\tG1\tZellkern ü 日本 🧬, line "1"\t0\.1$/m);
  assert.match(r.text, /^4\tG3\tmulti\\nline\t0\.3$/m);
  assert.match(r.text, /<<<UNTRUSTED EXTERNAL CONTENT/);
  const d = await s.get({ url, operation: 'extract', range: 'D1:D2' });
  assert.match(d.text, /^1\t=cmd\|calc$/m); // text, not executed or evaluated
  const last = await s.get({ url, operation: 'extract', offset: 118, limit: 50, max_columns: 2 });
  assert.equal(last.details.pagination.next_offset, null); assert.equal(last.details.pagination.columns_truncated, true);
  assert.equal(last.details.location.rows, '119-121');
});

test('CSV: max_chars cuts at a whole row and next_offset resumes exactly there', async () => {
  const body = Array.from({ length: 200 }, (_, i) => `${i},${'x'.repeat(40)}`).join('\n');
  const url = `${BASE}w.csv`;
  const { s } = svc({ [url]: reply(200, body, { 'content-type': 'text/csv' }) });
  const r = await s.get({ url, operation: 'extract', limit: 200, max_chars: 1000 });
  const pg = r.details.pagination;
  assert.equal(pg.truncated_by_max_chars, true);
  assert.ok(pg.returned > 5 && pg.returned < 200);
  assert.equal(pg.next_offset, pg.returned);
  const r2 = await s.get({ url, operation: 'extract', offset: pg.next_offset, limit: 1 });
  assert.match(r2.text, new RegExp(`^${pg.returned + 1}\\t${pg.returned}\\t`, 'm'));
});

test('TSV by content type, UTF-8 BOM and Windows-1252 fallback are decoded and reported', async () => {
  const { s } = svc({
    [`${BASE}t`]: reply(200, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\tb,c\nµ\t2\n')]), { 'content-type': 'text/tab-separated-values' }),
    [`${BASE}l.csv`]: reply(200, Buffer.from([0x61, 0x2c, 0xe9, 0x0a, 0x31, 0x2c, 0x32]), { 'content-type': 'text/csv' }),
  });
  const t = await s.get({ url: `${BASE}t`, operation: 'extract' });
  assert.equal(t.details.format, 'tsv'); assert.equal(t.details.result.encoding, 'utf-8 (BOM)');
  assert.match(t.text, /^1\ta\tb,c$/m); assert.match(t.text, /^2\tµ\t2$/m);
  const l = await s.get({ url: `${BASE}l.csv`, operation: 'extract' });
  assert.match(l.details.result.encoding, /windows-1252/); assert.match(l.text, /^1\ta\té$/m);
});

// ---------------------------------------------------------------- XLSX

const SST = ['Gene', 'Fold change', '<r><t>Rich </t></r><r><rPr><b/></rPr><t>text</t></r><rPh sb="0" eb="1"><t>PHONETIC</t></rPh>', 'Ünïcødé 名前', 'a &amp; b &lt;c&gt;'];
const ROWS = [
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>inline ✓</t></is></c></row>',
  '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1.5</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" s="3"/></row>',
  '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><f>B2*2</f><v>3</v></c><c r="C3" t="e"><v>#N/A</v></c></row>',
  '<row r="4"><c r="A4" t="s"><v>4</v></c><c r="B4"><f>SUM(B2:B3)</f></c><c r="C4" t="str"><f>A1&amp;"x"</f><v>Genex</v></c></row>',
  '<row r="5"><c r="B5"><f t="shared" si="0"/><v>9</v></c><c r="C5" t="d"><v>2024-05-01T00:00:00</v></c></row>',
].join('');

function workbook(opts = {}) {
  return buildXlsx({
    sheets: [
      { name: 'Table S3 – Ü', rows: ROWS, dimension: 'A1:D5', extra: '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>' },
      { name: 'Hidden', rows: '<row r="1"><c r="A1"><v>1</v></c></row>', state: 'hidden' },
    ],
    sharedStrings: SST, ...opts,
  });
}

test('XLSX: sheet enumeration, then named cells with shared/inline/rich strings, cached formulas labelled, provenance', async () => {
  const buf = workbook({ externalRels: ['https://evil.example.org/linked.xlsx', 'file:///etc/passwd'],
    extraParts: [{ name: 'xl/externalLinks/externalLink1.xml', data: '<externalLink/>' }], macros: true });
  const url = `${BASE}mmc3.xlsx`;
  const { s, http: h } = svc({ [url]: reply(200, buf, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) });
  const list = await s.get({ url });
  assert.equal(list.status, 'ok'); assert.equal(list.details.format, 'xlsx');
  assert.deepEqual(list.details.result.sheet_list.map((x) => [x.name, x.state, x.dimension]), [['Table S3 – Ü', 'visible', 'A1:D5'], ['Hidden', 'hidden', null]]);
  assert.equal(list.details.result.external_relationships_not_resolved, 2);
  assert.equal(list.details.result.external_link_parts, 1);
  assert.equal(list.details.result.macros_present_not_run, true);
  const multi = await s.get({ url, operation: 'extract' });
  assert.equal(multi.status, 'selection_required'); assert.equal(multi.isError, false); assert.match(multi.text, /Table S3/);
  assert.equal((await s.get({ url, operation: 'extract', sheet: 'Nope' })).status, 'sheet_not_found');

  const r = await s.get({ url, operation: 'extract', sheet: 'Table S3 – Ü', range: 'A1:C5', source: { ref: 'Table S3' } });
  assert.equal(r.status, 'ok');
  assert.equal(r.details.location.sheet, 'Table S3 – Ü'); assert.equal(r.details.location.rows, '1-5'); assert.equal(r.details.location.cells, 'A1:C5');
  const cells = Object.fromEntries(r.details.result.rows.flatMap((row) => row.cells.map((c) => [c.ref, c])));
  assert.equal(cells.A1.value, 'Gene'); assert.equal(cells.C1.value, 'inline ✓');
  assert.equal(cells.A2.value, 'Rich text'); // runs joined, phonetic dropped
  assert.equal(cells.A3.value, 'Ünïcødé 名前'); assert.equal(cells.A4.value, 'a & b <c>');
  assert.equal(cells.C2.value, 'TRUE'); assert.equal(cells.C3.type, 'error'); assert.equal(cells.C3.value, '#N/A');
  assert.deepEqual([cells.B3.value, cells.B3.formula, cells.B3.cached], ['3', 'B2*2', true]);
  assert.deepEqual([cells.B4.value, cells.B4.formula, cells.B4.cached], [null, 'SUM(B2:B3)', false]);
  assert.deepEqual([cells.C4.value, cells.C4.cached], ['Genex', true]);
  assert.deepEqual([cells.B5.value, cells.B5.formula], ['9', '(shared formula)']);
  assert.equal(cells.C5.type, 'date');
  assert.equal(cells.D2, undefined); // styled empty cell
  assert.match(r.text, /^3\tÜnïcødé 名前\t3 \[cached value of formula =B2\*2\]\t#N\/A$/m);
  assert.match(r.text, /^4\ta & b <c>\t \[formula =SUM\(B2:B3\), no cached value\]\tGenex \[cached value of formula =A1&"x"\]$/m);
  assert.match(r.text, /never recalculated/); assert.match(r.text, /external relationship\(s\).*not resolved/);
  assert.deepEqual(r.details.result.sheet.merged_cells, ['A1:B1']);
  assert.equal(h.calls.length, 1); // one download; external targets never fetched
  assert.ok(h.calls.every((c) => !c.url.includes('evil')));
});

test('XLSX: row paging with next_offset, column window, and max_chars cut', async () => {
  let rows = '';
  for (let i = 1; i <= 120; i++) rows += `<row r="${i}">${Array.from({ length: 30 }, (_, c) => `<c r="${String.fromCharCode(65 + (c % 26)).repeat(c < 26 ? 1 : 2)}${i}"><v>${i * 100 + c}</v></c>`).join('')}</row>`;
  const url = `${BASE}big.xlsx`;
  const { s } = svc({ [url]: reply(200, buildXlsx({ sheets: [{ name: 'S1', rows }] }), { 'content-type': 'application/octet-stream' }) });
  const p1 = await s.get({ url, operation: 'extract', sheet: 'S1', limit: 50, max_columns: 3 });
  assert.equal(p1.details.location.rows, '1-50'); assert.equal(p1.details.pagination.next_offset, 50);
  assert.equal(p1.details.pagination.columns_truncated, true); assert.equal(p1.details.location.columns, 'A-C');
  const p3 = await s.get({ url, operation: 'extract', sheet: 'S1', offset: 100, limit: 50, range: 'B1:C200' });
  assert.equal(p3.details.location.rows, '101-120'); assert.equal(p3.details.pagination.next_offset, null);
  assert.match(p3.text, /^101\t10101\t10102$/m);
  const cut = await s.get({ url, operation: 'extract', sheet: 'S1', range: 'A:Z', limit: 100, max_chars: 2000 });
  assert.equal(cut.details.pagination.truncated_by_max_chars, true);
  const shown = cut.details.pagination.returned;
  assert.equal(cut.details.pagination.next_offset, shown);
  assert.ok(cut.text.length < 4000);
});

test('XLSX: DOCTYPE/ENTITY (external or billion-laughs) in any part is refused, never expanded', async () => {
  const xxe = '<?xml version="1.0"?><!DOCTYPE sst [<!ENTITY x SYSTEM "file:///etc/passwd">]><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>&x;</t></si></sst>';
  const url = `${BASE}xxe.xlsx`;
  const { s } = svc({ [url]: reply(200, buildXlsx({ sheets: [{ name: 'A', rows: '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' }], sharedStringsXml: xxe })) });
  const r = await s.get({ url, operation: 'extract', sheet: 'A' });
  assert.equal(r.status, 'parse_error'); assert.equal(r.details.reason, 'xml_doctype_rejected');
  assert.doesNotMatch(r.text, /root:/);
  assert.throws(() => walkXml('<a>&custom;</a>', { text() {} }), /undeclared entity/);
  assert.throws(() => walkXml('<!DOCTYPE a [<!ENTITY l "lol">]><a>&l;&l;</a>', { text() {} }), /DOCTYPE/);
});

// ---------------------------------------------------------------- ZIP

test('ZIP: listing, explicit CSV and XLSX member extraction with member provenance', async () => {
  const csv = 'id,value\n1,α\n2,β\n';
  const xlsx = workbook();
  const zip = buildZip([{ name: 'supp/', data: '' }, { name: 'supp/Table S1.csv', data: csv }, { name: 'supp/Data S2.xlsx', data: xlsx, method: 0 }, { name: 'README.txt', data: 'hello\nworld\n' }]);
  const url = `${BASE}41586_2024_suppl.zip`;
  const { s } = svc({ [url]: reply(200, zip, { 'content-type': 'application/zip' }) });
  const list = await s.get({ url });
  assert.equal(list.status, 'ok'); assert.equal(list.details.format, 'zip');
  assert.deepEqual(list.details.result.entry_list.map((e) => e.name), ['supp/', 'supp/Table S1.csv', 'supp/Data S2.xlsx', 'README.txt']);
  assert.equal((await s.get({ url, operation: 'extract' })).status, 'selection_required');
  const c = await s.get({ url, operation: 'extract', entry: 'supp/Table S1.csv' });
  assert.equal(c.status, 'ok'); assert.equal(c.details.member.name, 'supp/Table S1.csv'); assert.equal(c.details.member.sha256, sha(Buffer.from(csv)));
  assert.equal(c.details.location.entry, 'supp/Table S1.csv'); assert.match(c.text, /^3\t2\tβ$/m);
  const sheets = await s.get({ url, operation: 'list', entry: 'supp/Data S2.xlsx' });
  assert.equal(sheets.details.format, 'xlsx'); assert.equal(sheets.details.result.sheet_list.length, 2);
  const x = await s.get({ url, operation: 'extract', entry: 'supp/Data S2.xlsx', sheet: 'Table S3 – Ü', range: 'B3' });
  assert.equal(x.details.location.entry, 'supp/Data S2.xlsx'); assert.equal(x.details.location.cells, 'B3:B3');
  const wide = await s.get({ url, operation: 'extract', entry: 'supp/Data S2.xlsx', sheet: 'Table S3 – Ü', range: 'B1:D5' });
  assert.equal(wide.details.location.cells, 'B1:C5'); assert.equal(wide.details.location.requested_rows, '1-5');
  assert.match(x.text, /^3\t3 \[cached value of formula =B2\*2\]$/m);
  const t = await s.get({ url, operation: 'extract', entry: 'README.txt' });
  assert.equal(t.details.format, 'text'); assert.match(t.text, /^2\tworld$/m);
  const miss = await s.get({ url, operation: 'extract', entry: 'table s1.csv' });
  assert.equal(miss.status, 'entry_not_found');
});

test('ZIP: traversal, absolute, backslash, symlink and duplicate members are listed as refused and never read', async () => {
  const zip = buildZip([
    { name: '../../etc/evil.csv', data: 'a,b' }, { name: '/abs.csv', data: 'a,b' }, { name: 'C:/win.csv', data: 'a' },
    { name: 'dir\\back.csv', data: 'a' }, { name: 'link.csv', data: '/etc/passwd', unixMode: 0o120777 },
    { name: 'dup.csv', data: '1' }, { name: 'dup.csv', data: '2' }, { name: 'ok.csv', data: 'x,y\n1,2' },
  ]);
  const url = `${BASE}tricks.zip`;
  const { s } = svc({ [url]: reply(200, zip, { 'content-type': 'application/zip' }) });
  const list = await s.get({ url });
  const refused = Object.fromEntries(list.details.result.entry_list.map((e) => [e.name, e.refused]));
  assert.deepEqual(refused, { '../../etc/evil.csv': 'path_traversal', '/abs.csv': 'absolute_path', 'C:/win.csv': 'absolute_path',
    'dir\\back.csv': 'backslash_separator', 'link.csv': 'symlink', 'dup.csv': 'duplicate_name', 'ok.csv': null });
  for (const entry of ['../../etc/evil.csv', '/abs.csv', 'link.csv', 'dup.csv', 'dir\\back.csv']) {
    const r = await s.get({ url, operation: 'extract', entry });
    assert.equal(r.status, 'entry_rejected', entry); assert.equal(r.isError, true);
  }
  assert.equal((await s.get({ url, operation: 'extract', entry: 'ok.csv' })).status, 'ok');
});

test('ZIP bombs and malformed archives: ratio, size lie, overlap, entry count, budget, nesting', async () => {
  const zeros = Buffer.alloc(3 * 1024 * 1024);
  const lie = buildZip([{ name: 'lie.csv', data: 'a,b\n'.repeat(1000), declaredSize: 10 }]);
  const routes = {
    [`${BASE}ratio.zip`]: reply(200, buildZip([{ name: 'z.csv', data: zeros }])),
    [`${BASE}lie.zip`]: reply(200, lie),
    [`${BASE}overlap.zip`]: reply(200, buildZip([{ name: 'a.csv', data: 'a' }, { name: 'b.csv', data: 'b' }], { duplicateCentral: 0 })),
    [`${BASE}many.zip`]: reply(200, buildZip(Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.csv`, data: 'x' })))),
    [`${BASE}budget.zip`]: reply(200, buildZip([{ name: 'a.csv', data: 'x'.repeat(5000) }])),
    [`${BASE}nested.zip`]: reply(200, buildZip([{ name: 'inner.zip', data: buildZip([{ name: 'deep.csv', data: 'a' }]) }])),
    [`${BASE}crc.zip`]: reply(200, buildZip([{ name: 'c.csv', data: 'a,b', declaredCrc: 1234 }])),
    [`${BASE}trunc.zip`]: reply(200, buildZip([{ name: 'a.csv', data: 'abc' }]).subarray(0, 40), { 'content-type': 'application/zip' }),
  };
  const { s } = svc(routes, { limits: { zip: { maxEntries: 10 } } });
  const ratio = await s.get({ url: `${BASE}ratio.zip`, operation: 'extract', entry: 'z.csv' });
  assert.equal(ratio.status, 'archive_rejected'); assert.match(ratio.details.message, /compression_ratio/);
  const l = await s.get({ url: `${BASE}lie.zip`, operation: 'extract', entry: 'lie.csv' });
  assert.equal(l.status, 'archive_rejected'); assert.equal(l.details.reason, 'decompressed_size_mismatch');
  assert.equal((await s.get({ url: `${BASE}overlap.zip` })).details.reason, 'zip_overlapping_entries');
  assert.equal((await s.get({ url: `${BASE}many.zip` })).details.reason, 'zip_too_many_entries');
  assert.equal((await s.get({ url: `${BASE}nested.zip`, operation: 'extract', entry: 'inner.zip' })).status, 'nested_archive_unsupported');
  assert.equal((await s.get({ url: `${BASE}crc.zip`, operation: 'extract', entry: 'c.csv' })).details.reason, 'crc_mismatch');
  assert.equal((await s.get({ url: `${BASE}trunc.zip` })).details.reason, 'zip_corrupt');
  const { s: tight } = svc({ [`${BASE}budget.zip`]: routes[`${BASE}budget.zip`] }, { limits: { decompressionBudgetBytes: 100 } });
  assert.equal((await tight.get({ url: `${BASE}budget.zip`, operation: 'extract', entry: 'a.csv' })).details.reason, 'decompression_budget');
  // sanity: the inflate cap really bounds output (a 3 MiB member is never materialized past its declared size)
  assert.throws(() => zlib.inflateRawSync(zlib.deflateRawSync(zeros), { maxOutputLength: 10 }));
});

// ---------------------------------------------------------------- PDF

const PY = process.env.SUPPLEMENT_TEST_PYTHON || DEFAULT_PYTHON;
test('PDF: page count and bounded page text via the pinned PyMuPDF (no OCR)', { skip: existsSync(PY) ? false : `no Python at ${PY} (set SUPPLEMENT_TEST_PYTHON)` }, async () => {
  const pdf = buildPdf(['Supplementary Methods page one', 'Table S9 legend on page two', 'Third page']);
  const url = `${BASE}mmc1.pdf`;
  const { s } = svc({ [url]: reply(200, pdf, { 'content-type': 'application/pdf' }) }, { python: PY });
  const list = await s.get({ url });
  assert.equal(list.status, 'ok'); assert.equal(list.details.result.page_count, 3);
  const r = await s.get({ url, operation: 'extract', offset: 1, limit: 1 });
  assert.equal(r.status, 'ok'); assert.match(r.text, /=== page 2 of 3/); assert.match(r.text, /Table S9 legend on page two/);
  assert.doesNotMatch(r.text, /page one/); assert.equal(r.details.pagination.next_offset, 2); assert.match(r.text, /no OCR/);
  const z = await svc({ [`${BASE}p.zip`]: reply(200, buildZip([{ name: 'S1.pdf', data: pdf }])) }, { python: PY }).s.get({ url: `${BASE}p.zip`, operation: 'extract', entry: 'S1.pdf', limit: 1 });
  assert.equal(z.status, 'ok'); assert.match(z.text, /page one/);
  const broken = await svc({ [`${BASE}b.pdf`]: reply(200, Buffer.from('%PDF-1.4\nnot really a pdf\n%%EOF'), { 'content-type': 'application/pdf' }) }, { python: PY }).s.get({ url: `${BASE}b.pdf`, operation: 'extract' });
  assert.ok(['parse_error', 'extractor_failed'].includes(broken.status), broken.status); assert.equal(broken.isError, true);
});

// Spawn is faked below, but the runtime/bubblewrap preflight still runs: a fake venv that passes the mount policy.
const NO_BWRAP = existsSync(BWRAP) ? false : `no ${BWRAP}`;
function fakeVenv() {
  const root = mkdtempSync(join(tmpdir(), 'supp-fake-venv-'));
  mkdirSync(join(root, 'bin')); writeFileSync(join(root, 'bin', 'python'), '#!/bin/false\n'); chmodSync(join(root, 'bin', 'python'), 0o755);
  writeFileSync(join(root, 'pyvenv.cfg'), 'home = /usr/bin\n');
  return { python: join(root, 'bin', 'python'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('PDF: missing extractor and timeouts are typed outcomes, not text', { skip: NO_BWRAP }, async () => {
  const url = `${BASE}x.pdf`;
  const pdf = buildPdf(['x']);
  const missing = await svc({ [url]: reply(200, pdf, { 'content-type': 'application/pdf' }) }, { python: '/nonexistent/python3' }).s.get({ url });
  assert.equal(missing.status, 'pdf_extractor_unavailable'); assert.equal(missing.isError, true);
  const killed = [];
  const spawned = [];
  const hang = (cmd) => { spawned.push(cmd); const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = Object.assign(new EventEmitter(), { end() {} }); c.kill = (sig) => killed.push(sig); return c; };
  const v = fakeVenv();
  try {
    const slow = await svc({ [url]: reply(200, pdf) }, { python: v.python, spawnImpl: hang, limits: { pdfTimeoutMs: 30 } }).s.get({ url });
    assert.equal(slow.status, 'extractor_timeout'); assert.deepEqual(killed, ['SIGKILL']); assert.deepEqual(spawned, [BWRAP]);
  } finally { v.cleanup(); }
});

// ---------------------------------------------------------------- cancellation, cache, hash, logging, params

test('cancellation: pre-aborted, during download, and during PDF extraction all reject (no result)', { skip: NO_BWRAP }, async () => {
  const url = `${BASE}a.csv`;
  const ac0 = new AbortController(); ac0.abort(new Error('stop-0'));
  const { s, http: h } = svc({ [url]: reply(200, 'a,b', { 'content-type': 'text/csv' }) });
  await assert.rejects(s.get({ url }, ac0.signal), /stop-0/); assert.equal(h.calls.length, 0);
  const ac1 = new AbortController();
  const { s: s1 } = svc({ [url]: (opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(opts.signal.reason))) });
  const p1 = s1.get({ url }, ac1.signal);
  setTimeout(() => ac1.abort(new Error('stop-1')), 10);
  await assert.rejects(p1, /stop-1/);
  const killed = [];
  const hang = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = Object.assign(new EventEmitter(), { end() {} }); c.kill = (sig) => killed.push(sig); return c; };
  const ac2 = new AbortController();
  const v = fakeVenv();
  try {
    const { s: s2 } = svc({ [`${BASE}p.pdf`]: reply(200, buildPdf(['x'])) }, { python: v.python, spawnImpl: hang });
    const p2 = s2.get({ url: `${BASE}p.pdf` }, ac2.signal);
    setTimeout(() => ac2.abort(new Error('stop-2')), 10);
    await assert.rejects(p2, /stop-2/); assert.deepEqual(killed, ['SIGKILL']);
  } finally { v.cleanup(); }
});

test('in-memory cache reuses one download per URL; refresh re-downloads; expected_sha256 pins the version', async () => {
  const url = `${BASE}c.csv`;
  const body = 'a,b\n1,2\n';
  const { s, http: h } = svc({ [url]: reply(200, body, { 'content-type': 'text/csv' }) });
  await s.get({ url }); const again = await s.get({ url, operation: 'extract' });
  assert.equal(h.calls.length, 1); assert.equal(again.details.provenance.cache, 'hit');
  await s.get({ url, refresh: true }); assert.equal(h.calls.length, 2);
  const bad = await s.get({ url, expected_sha256: '0'.repeat(64) });
  assert.equal(bad.status, 'hash_mismatch'); assert.equal(bad.isError, true);
  assert.equal((await s.get({ url, expected_sha256: sha(Buffer.from(body)) })).status, 'ok');
});

test('no console or stderr output (payload text is never logged)', async () => {
  const seen = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, write: process.stderr.write };
  console.log = console.error = console.warn = console.info = (...a) => seen.push(a.join(' '));
  process.stderr.write = (c, ...rest) => { seen.push(String(c)); return true; };
  try {
    const url = `${BASE}secret.csv`;
    const { s } = svc({ [url]: reply(200, 'PAYLOAD-MARKER,1\n', { 'content-type': 'text/csv' }), [`${BASE}d`]: reply(403, 'PAYLOAD-403') });
    await s.get({ url, operation: 'extract' }); await s.get({ url: `${BASE}d` });
  } finally { Object.assign(console, { log: orig.log, error: orig.error, warn: orig.warn, info: orig.info }); process.stderr.write = orig.write; }
  assert.deepEqual(seen.filter((x) => !x.startsWith('# ')), []);
});

test('invalid parameters throw before any request', async () => {
  const { s, http: h } = svc({});
  await assert.rejects(s.get({}), /url is required/);
  await assert.rejects(s.get({ url: `${BASE}a.csv`, operation: 'delete' }), /operation must be/);
  await assert.rejects(s.get({ url: `${BASE}a.csv`, range: 'A1:10' }), /range/);
  await assert.rejects(s.get({ url: `${BASE}a.csv`, offset: -1 }), /offset/);
  await assert.rejects(s.get({ url: `${BASE}a.csv`, expected_sha256: 'abc' }), /expected_sha256/);
  await assert.rejects(s.get({ url: `${BASE}a.csv`, source: { ref: 5 } }), /source.ref/);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(parseRange('b2:d20'), { r1: 2, c1: 2, r2: 20, c2: 4, label: 'B2:D20' });
  assert.deepEqual(parseRange('A:C'), { r1: 1, c1: 1, r2: 1048576, c2: 3, label: 'A:C' });
  assert.deepEqual(parseRange('5:10'), { r1: 5, c1: 1, r2: 10, c2: 16384, label: '5:10' });
  assert.throws(() => parseRange('C1:A1'));
});
