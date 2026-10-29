// Closure regressions for the supplement_get verifier findings that remained after e035db8/a293508: paired stray CSV
// quotes (span metrics), inline-tag CSV misread as HTML, HTML hidden behind long prefixes/UTF-16 BOMs, nested
// percent-encoded credentials, and ZIP-member PDF failure provenance. Synthetic offline fixtures at the service boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BWRAP } from '../supplements/pdf-sandbox.mjs';
import { createSupplementService } from '../supplements.mjs';
import { redactText } from '../supplements/redact.mjs';
import { sniffMagic } from '../supplements/sniff.mjs';
import { buildPdf, buildZip, fakeHttp, fakeResolve, reply } from './supplement-fixtures.mjs';

const NOW = () => new Date('2026-10-23T12:00:00.000Z');
const BASE = 'https://files.example.org/suppl/';
const svc = (routes, extra = {}) => {
  const httpc = fakeHttp(routes);
  return { http: httpc, s: createSupplementService({ http: httpc, resolve: fakeResolve, now: NOW, ...extra }) };
};
const csv = (body) => reply(200, body, { 'content-type': 'text/csv' });

// ---------------------------------------------------------------- 1 CSV quoted spans

test('CSV: paired stray quotes are not silently clean: physical lines, multiline records and the longest quoted span are reported', async () => {
  const lines = ['id,size,name', '1,"5 inch,x', ...Array.from({ length: 50 }, (_, i) => `${i + 2},${i},n${i}`), '52,7 inch",y', '53,1,z'];
  const { s } = svc({ [`${BASE}p.csv`]: csv(`${lines.join('\n')}\n`) });
  for (const operation of ['list', 'extract']) {
    const r = await s.get({ url: `${BASE}p.csv`, operation, max_cell_chars: 4000 });
    assert.equal(r.status, 'ok', operation);
    const res = r.details.result;
    assert.equal(res.records, 3);
    assert.equal(res.physical_lines, lines.length);
    assert.equal(res.quoted_multiline_records, 1);
    assert.deepEqual(res.longest_quoted_span, { physical_lines: 52, record: 2, start_line: 2 });
    const note = r.details.notes.find((n) => /span multiple physical lines/.test(n));
    assert.ok(note, operation);
    assert.match(note, /3 records from 54 physical lines/);
    assert.match(note, /covers 52 physical lines/); assert.match(note, /stray|unbalanced/);
    assert.doesNotMatch(note, /verified|complete/i);
    assert.match(r.text, /Note: .*span multiple physical lines/);
  }
  const l = await s.get({ url: `${BASE}p.csv` });
  assert.match(l.text, /3 records \(row 1 included\) from 54 physical lines/);
});

test('CSV: legitimate quoted multiline cells are preserved, with the same bounded span metrics', async () => {
  const { s } = svc({ [`${BASE}m.csv`]: csv('id,note\n1,"line one\nline two, with comma"\n2,plain\n'), [`${BASE}flat.csv`]: csv('a,b\n"x",1\n2,"y"\n') });
  const r = await s.get({ url: `${BASE}m.csv`, operation: 'extract' });
  assert.equal(r.status, 'ok');
  assert.match(r.text, /^2\t1\tline one\\nline two, with comma$/m);
  assert.match(r.text, /^3\t2\tplain$/m);
  assert.equal(r.details.result.records, 3); assert.equal(r.details.result.physical_lines, 4);
  assert.equal(r.details.result.quoted_multiline_records, 1);
  assert.deepEqual(r.details.result.longest_quoted_span, { physical_lines: 2, record: 2, start_line: 2 });
  assert.ok(r.details.notes.some((n) => /span multiple physical lines/.test(n)));
  const f = await s.get({ url: `${BASE}flat.csv`, operation: 'extract' });
  assert.equal(f.details.result.quoted_multiline_records, 0); assert.equal(f.details.result.longest_quoted_span, null);
  assert.equal(f.details.result.physical_lines, 3);
  assert.ok(!f.details.notes.some((n) => /span multiple physical lines/.test(n)));
});

test('CSV: characters after a closing quote (not a delimiter or line end) are malformed_csv with the physical line', async () => {
  const lines = ['id,size,name', '1,"5 inch,x', ...Array.from({ length: 5 }, (_, i) => `${i + 2},${i},n${i}`), '7,7 inch"y,z', '8,1,z'];
  const { s } = svc({ [`${BASE}a.csv`]: csv('a,b,c\n1,"x"y,2\n'), [`${BASE}b.csv`]: csv(`${lines.join('\n')}\n`),
    [`${BASE}ws.csv`]: csv('a,b\n"x" ,2\n'), [`${BASE}t.tsv`]: reply(200, 'a\tb\n"x"\t2\n', { 'content-type': 'text/tab-separated-values' }) });
  for (const operation of ['list', 'extract']) {
    const r = await s.get({ url: `${BASE}a.csv`, operation });
    assert.equal(r.status, 'malformed_csv', operation); assert.equal(r.isError, true);
    assert.equal(r.details.text_after_closing_quote_line, 2); assert.equal(r.details.physical_lines, 2);
    assert.match(r.text, /closing quote.*physical line 2/);
    assert.doesNotMatch(r.text, /^row\t/m);
  }
  const b = await s.get({ url: `${BASE}b.csv`, operation: 'extract' });
  assert.equal(b.status, 'malformed_csv'); assert.equal(b.details.text_after_closing_quote_line, 8);
  assert.equal((await s.get({ url: `${BASE}ws.csv`, operation: 'extract' })).status, 'ok'); // trailing blanks before the delimiter
  const t = await s.get({ url: `${BASE}t.tsv`, operation: 'extract' });
  assert.equal(t.status, 'ok'); assert.match(t.text, /^2\tx\t2$/m);
});

// ---------------------------------------------------------------- 2 inline tags are not HTML

test('HTML sniff: inline-tag CSV cells (<i>, <b>, <sup>) are valid CSV; structural markup after a short tag is still HTML', async () => {
  const { s } = svc({
    [`${BASE}i.csv`]: csv('<i>E. coli</i>,12\n<i>S. aureus</i>,4\n'), [`${BASE}b.csv`]: csv('<b>gene</b>,x\n'),
    [`${BASE}sup.csv`]: csv('<sup>2</sup>,x\n'), [`${BASE}em.csv`]: csv('<em>a</em>,<strong>b</strong>\n1,2\n'),
    [`${BASE}br`]: csv('<b>Error</b><br>File missing\n'), [`${BASE}p`]: reply(200, '<p>File missing</p>\n', { 'content-type': 'text/plain' }),
    [`${BASE}a-div`]: csv('<a href="/x">x</a><div>login</div>'),
  });
  const i = await s.get({ url: `${BASE}i.csv`, operation: 'extract' });
  assert.equal(i.status, 'ok'); assert.equal(i.details.result.delimiter, ',');
  assert.match(i.text, /^1\t<i>E\. coli<\/i>\t12$/m);
  for (const k of ['b.csv', 'sup.csv', 'em.csv']) assert.equal((await s.get({ url: `${BASE}${k}`, operation: 'extract' })).status, 'ok', k);
  for (const k of ['br', 'p', 'a-div']) assert.equal((await s.get({ url: `${BASE}${k}`, operation: 'extract' })).status, 'html_not_file', k);
});

// ---------------------------------------------------------------- 3 prefixes, BOMs and the sniff bound

const u16 = (s, be = false) => {
  const le = Buffer.from(s, 'utf16le');
  if (!be) return Buffer.concat([Buffer.from([0xff, 0xfe]), le]);
  const out = Buffer.alloc(le.length); for (let k = 0; k < le.length; k += 2) { out[k] = le[k + 1]; out[k + 1] = le[k]; }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), out]);
};

test('HTML sniff: long leading comments, thousands of blank lines and UTF-16 BOM pages are HTML within the bounded scan', async () => {
  const page = '<!DOCTYPE html><html><body>Login</body></html>';
  const { s } = svc({
    [`${BASE}c3k.csv`]: csv(`<!-- ${'x'.repeat(3000)} -->\n${page}`),
    [`${BASE}c12k.csv`]: csv(`${'<!-- c -->\n'.repeat(1000)}${page}`),
    [`${BASE}nl3k`]: reply(200, `${'\n'.repeat(3000)}${page}`, { 'content-type': 'text/plain' }),
    [`${BASE}nl50k`]: reply(200, `${'\r\n'.repeat(50000)}${page}`, { 'content-type': 'text/plain' }),
    [`${BASE}u16le`]: reply(200, u16(`${page}\n`), { 'content-type': 'text/plain' }),
    [`${BASE}u16be.csv`]: reply(200, u16(`\n<html><body>Sign in</body></html>`, true), { 'content-type': 'text/csv' }),
    [`${BASE}u16le-comment.csv`]: reply(200, u16(`<!-- ${'y'.repeat(4000)} -->${page}`), { 'content-type': 'text/csv' }),
  });
  for (const k of ['c3k.csv', 'c12k.csv', 'nl3k', 'nl50k', 'u16le', 'u16be.csv', 'u16le-comment.csv']) {
    const r = await s.get({ url: `${BASE}${k}`, operation: 'extract' });
    assert.equal(r.status, 'html_not_file', k); assert.equal(r.details.result, undefined, k);
  }
});

test('HTML sniff: a leading comment/declaration that outruns the 16 KiB window is an explicit unclassified outcome, not clean CSV', async () => {
  const { s } = svc({
    [`${BASE}c20k.csv`]: csv(`<!-- ${'x'.repeat(20000)} -->\n<!DOCTYPE html><html><body>Login</body></html>`),
    [`${BASE}pi20k.csv`]: csv(`<?xml ${'x'.repeat(20000)}?>\n<html><body>Login</body></html>`),
  });
  for (const k of ['c20k.csv', 'pi20k.csv']) {
    const r = await s.get({ url: `${BASE}${k}`, operation: 'extract' });
    assert.equal(r.status, 'unsupported_format', k); assert.equal(r.isError, true);
    assert.equal(r.details.detected, 'unclassified_markup_prefix', k);
    assert.match(r.text, /16 KiB/);
    assert.doesNotMatch(r.text, /^row\t/m);
  }
  assert.equal(sniffMagic(Buffer.from(`<!--${'x'.repeat(20000)}`)), 'unclassified_markup_prefix');
});

test('HTML sniff: valid text and data are unaffected (UTF-16 CSV, XML with comments, blank-line-prefixed CSV, short unclosed comment)', async () => {
  const { s } = svc({
    [`${BASE}u16.csv`]: reply(200, u16('gene,value\nA,1\nB,2\n'), { 'content-type': 'text/csv' }),
    [`${BASE}d.xml`]: reply(200, `<?xml version="1.0"?>\n<!-- ${'g'.repeat(10000)} -->\n<dataset><row a="1"/></dataset>\n`, { 'content-type': 'application/xml' }),
    [`${BASE}nl.csv`]: csv(`${'\n'.repeat(20000)}a,b\n1,2\n`),
    [`${BASE}cmt.csv`]: csv('<!-- note\na,b\n1,2\n'),
    [`${BASE}cmp.csv`]: csv('<0.05,>10,<p\n1,2,3\n'),
  });
  const u = await s.get({ url: `${BASE}u16.csv`, operation: 'extract' });
  assert.equal(u.status, 'ok'); assert.match(u.text, /^2\tA\t1$/m); assert.match(u.details.result.encoding, /utf-16le/);
  assert.equal((await s.get({ url: `${BASE}d.xml`, operation: 'extract' })).status, 'ok');
  assert.equal((await s.get({ url: `${BASE}nl.csv`, operation: 'extract' })).status, 'ok');
  assert.equal((await s.get({ url: `${BASE}cmt.csv`, operation: 'extract' })).status, 'ok');
  assert.equal((await s.get({ url: `${BASE}cmp.csv`, operation: 'extract' })).status, 'ok');
});

// ---------------------------------------------------------------- 4 nested percent-encoded credentials

test('redactText: credentials inside single/double/triple percent-encoded query values are redacted; plain search values are untouched', () => {
  const cases = [
    ['https://x/f?q=%26token%3DS12&page=2', ['S12'], ['page=2', 'q=']],
    ['https://x/f?next=https%3A%2F%2Fb.s3.amazonaws.com%2Ff%3FX-Amz-Signature%3DAWSSIG1%26X-Amz-Credential%3DAKIA1%26X-Amz-Expires%3D300&lang=en', ['AWSSIG1', 'AKIA1'], ['lang=en', 'X-Amz-Expires%3D300']],
    ['https://x/f?next=%253FX-Amz-Signature%253DAWSSIG2%2526X-Amz-Security-Token%253DTOK2&lang=en', ['AWSSIG2', 'TOK2'], ['lang=en']],
    ['https://x/f?r=%25253Fsig%25253DSAS3&k=v', ['SAS3'], ['k=v']],
    ['https://x/f?q=token%3DS13', ['S13'], []],
    ['https://x/f?u=https%3A%2F%2Fuser%3APW14%40h%2Fp', ['PW14'], []],
    [JSON.stringify({ url: 'https://x/f?q=%26access_token%3DS15', offset: 0 }), ['S15'], ['"offset":0']],
  ];
  for (const [input, secrets, kept] of cases) {
    const out = redactText(input);
    for (const sec of secrets) assert.ok(!out.includes(sec), `${sec} in ${out}`);
    for (const k of kept) assert.ok(out.includes(k), `${k} lost in ${out}`);
    assert.match(out, /redacted/);
  }
  for (const plain of ['https://x/f?q=%26page%3D2%26sort%3Dasc&lang=en', 'https://x/f?q=E.%20coli%20%2B%20gene', 'https://x/f?q=%ZZbad']) {
    assert.equal(redactText(plain), plain);
  }
  // Deeper than the decode bound with a credential-like name visible in the raw value: conservatively redacted.
  assert.ok(!redactText('https://x/f?q=%2525252526token%2525252533DS16').includes('S16'));
});

test('service: nested encoded credentials never reach text, details, provenance or updates; the network uses the original URL', async () => {
  const url = `${BASE}r.csv?q=%26token%3DSECRETA&page=2`;
  const target = `${BASE}t.csv?next=%253FX-Amz-Signature%253DSECRETB%2526X-Amz-Credential%253DSECRETC&lang=en`;
  const denied = `${BASE}d.csv?redirect=https%3A%2F%2Fb.s3.amazonaws.com%2Ff%3FX-Amz-Signature%3DSECRETD`;
  const { s, http: h } = svc({ [url]: reply(302, '', { location: target }), [target]: csv('a,b\n1,2\n'), [denied]: reply(403, 'no', {}) });
  const updates = [];
  const r = await s.get({ url, operation: 'extract' }, undefined, (u) => updates.push(u));
  const d = await s.get({ url: denied }, undefined, (u) => updates.push(u));
  assert.equal(r.status, 'ok'); assert.equal(d.status, 'access_denied');
  const all = JSON.stringify([r.text, r.details, d.text, d.details, updates]);
  for (const sec of ['SECRETA', 'SECRETB', 'SECRETC', 'SECRETD']) assert.ok(!all.includes(sec), sec);
  assert.match(r.details.provenance.requested_url, /page=2/); assert.match(r.details.provenance.final_url, /lang=en/);
  assert.match(r.details.request.url, /q=.*redacted/);
  assert.deepEqual(h.calls.map((c) => c.url), [url, target, denied], 'network requests use the original URLs');
});

// ---------------------------------------------------------------- 5 ZIP-member PDF failure provenance

function fakeVenv() {
  const root = mkdtempSync(join(tmpdir(), 'supp-fake-venv-'));
  mkdirSync(join(root, 'bin')); writeFileSync(join(root, 'bin', 'python'), '#!/bin/false\n'); chmodSync(join(root, 'bin', 'python'), 0o755);
  writeFileSync(join(root, 'pyvenv.cfg'), 'home = /usr/bin\n');
  return { python: join(root, 'bin', 'python'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('PDF member: a missing extractor runtime keeps member name/hash/size and location.entry in the typed failure', async () => {
  const pdf = buildPdf(['hello']);
  const zipBuf = buildZip([{ name: 'doc/p.pdf', data: pdf }]);
  const { s } = svc({ [`${BASE}z.zip`]: reply(200, zipBuf) }, { python: '/nonexistent/python3' });
  const r = await s.get({ url: `${BASE}z.zip`, operation: 'extract', entry: 'doc/p.pdf' });
  assert.equal(r.status, 'pdf_extractor_unavailable'); assert.equal(r.isError, true);
  const sha = createHash('sha256').update(pdf).digest('hex');
  assert.equal(r.details.member.name, 'doc/p.pdf'); assert.equal(r.details.member.sha256, sha); assert.equal(r.details.member.bytes, pdf.length);
  assert.equal(r.details.location.entry, 'doc/p.pdf');
  assert.equal(r.details.provenance.sha256, createHash('sha256').update(zipBuf).digest('hex'));
  assert.match(r.text, new RegExp(`Member: entry "doc/p\\.pdf" \\(${pdf.length} bytes, sha256 ${sha}\\)`));
  // The member line is inside the untrusted fence (the name is file-controlled).
  const open = r.text.indexOf('<<<UNTRUSTED EXTERNAL CONTENT'); const close = r.text.indexOf('<<<END UNTRUSTED EXTERNAL CONTENT');
  const at = r.text.indexOf('Member: entry');
  assert.ok(open >= 0 && open < at && at < close);
});

test('PDF member: a fake extractor parse failure keeps member provenance too', { skip: existsSync(BWRAP) ? false : `no ${BWRAP}` }, async () => {
  const pdf = buildPdf(['x']);
  const fake = () => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
    c.stdin = Object.assign(new EventEmitter(), { end() { setImmediate(() => { c.stdout.emit('data', Buffer.from(JSON.stringify({ status: 'parse_error', error: 'ValueError' }))); c.emit('close', 0); }); } });
    return c;
  };
  const v = fakeVenv();
  let r;
  try {
    r = await svc({ [`${BASE}z.zip`]: reply(200, buildZip([{ name: 'S1.pdf', data: pdf }])) }, { python: v.python, spawnImpl: fake }).s
      .get({ url: `${BASE}z.zip`, operation: 'extract', entry: 'S1.pdf' });
  } finally { v.cleanup(); }
  assert.equal(r.status, 'parse_error');
  assert.equal(r.details.member.name, 'S1.pdf'); assert.equal(r.details.member.bytes, pdf.length);
  assert.equal(r.details.location.entry, 'S1.pdf');
});
