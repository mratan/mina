import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createNodeHttpClient } from '../src/http.js';

let server;
let base;
const seen = [];

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, host: req.headers.host });
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/hop') {
        const n = Number(u.searchParams.get('n'));
        if (n > 0) { res.writeHead(302, { location: `/hop?n=${n - 1}` }); return res.end(); }
        return res.end('landed');
      }
      if (u.pathname === '/see-other') { res.writeHead(303, { location: '/echo' }); return res.end(); }
      if (u.pathname === '/temp') { res.writeHead(307, { location: '/echo' }); return res.end(); }
      if (u.pathname === '/echo') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ method: req.method, body })); }
      if (u.pathname === '/big') { res.setHeader('content-type', 'text/plain'); return res.end('x'.repeat(10_000)); }
      if (u.pathname === '/gzip') { res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' }); return res.end(gzipSync('hello gzip')); }
      if (u.pathname === '/slow') { setTimeout(() => res.end('late'), 2_000); return; }
      if (u.pathname === '/pdf') { res.setHeader('content-type', 'application/pdf'); return res.end('%PDF-1.4 ...'); }
      if (u.pathname === '/offsite') { res.writeHead(302, { location: 'http://evil.test/' }); return res.end(); }
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const client = createNodeHttpClient();

test('GET and POST only', async () => {
  await assert.rejects(client.request({ method: 'PUT', url: `${base}/` }), /not allowed/);
  await assert.rejects(client.request({ method: 'DELETE', url: `${base}/` }), /not allowed/);
  await assert.rejects(client.request({ method: 'GET', url: 'ftp://example.com/' }), /Unsupported protocol/);
});

test('redirects are not followed by default; followed up to maxRedirects; capped at 5', async () => {
  const r0 = await client.request({ method: 'GET', url: `${base}/hop?n=1` });
  assert.equal(r0.status, 302);
  const r1 = await client.request({ method: 'GET', url: `${base}/hop?n=3`, maxRedirects: 5 });
  assert.equal(r1.body.toString(), 'landed');
  assert.equal(r1.redirects.length, 3);
  await assert.rejects(client.request({ method: 'GET', url: `${base}/hop?n=7`, maxRedirects: 50 }), /Too many redirects \(max 5\)/);
});

test('policy.check runs before every hop and can refuse a redirect target', async () => {
  const checked = [];
  const policy = { async check(u) { checked.push(new URL(u).pathname); if (new URL(u).hostname === 'evil.test') throw new Error('refused evil'); return null; } };
  await client.request({ method: 'GET', url: `${base}/hop?n=2`, maxRedirects: 5, policy });
  assert.deepEqual(checked, ['/hop', '/hop', '/hop']);
  await assert.rejects(client.request({ method: 'GET', url: `${base}/offsite`, maxRedirects: 5, policy }), /refused evil/);
});

test('a pinned address from the policy is where the connection goes (hostname kept for Host)', async () => {
  const port = server.address().port;
  const policy = { async check() { return { address: '127.0.0.1', family: 4 }; } };
  const r = await client.request({ method: 'GET', url: `http://pinned.example.test:${port}/`, policy });
  assert.equal(r.body.toString(), 'ok');
  assert.equal(seen.at(-1).host, `pinned.example.test:${port}`);
});

test('303 turns POST into GET; 307 keeps POST and body', async () => {
  const a = await client.request({ method: 'POST', url: `${base}/see-other`, body: 'abc', maxRedirects: 2, headers: { 'content-type': 'text/plain' } });
  assert.deepEqual(JSON.parse(a.body), { method: 'GET', body: '' });
  const b = await client.request({ method: 'POST', url: `${base}/temp`, body: 'abc', maxRedirects: 2 });
  assert.deepEqual(JSON.parse(b.body), { method: 'POST', body: 'abc' });
});

test('size cap truncates or errors', async () => {
  const t = await client.request({ method: 'GET', url: `${base}/big`, maxBytes: 1000 });
  assert.equal(t.truncated, true);
  assert.equal(t.body.length, 1000);
  await assert.rejects(client.request({ method: 'GET', url: `${base}/big`, maxBytes: 1000, overflow: 'error' }), /exceeds/);
});

test('gzip is decoded; skipBodyFor leaves the body unread', async () => {
  assert.equal((await client.request({ method: 'GET', url: `${base}/gzip` })).body.toString(), 'hello gzip');
  const p = await client.request({ method: 'GET', url: `${base}/pdf`, skipBodyFor: /^application\/pdf/ });
  assert.equal(p.skipped, true);
  assert.equal(p.body.length, 0);
});

test('timeout and AbortSignal', async () => {
  await assert.rejects(client.request({ method: 'GET', url: `${base}/slow`, timeoutMs: 200 }), /timed out after 200 ms/);
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error('caller aborted')), 100);
  await assert.rejects(client.request({ method: 'GET', url: `${base}/slow`, signal: ac.signal }), /aborted/);
});

test('trace receives one event per hop without headers or bodies', async () => {
  const events = [];
  const traced = createNodeHttpClient({ trace: (e) => events.push(e) });
  await traced.request({ method: 'GET', url: `${base}/hop?n=1`, maxRedirects: 2 });
  assert.equal(events.length, 2);
  for (const e of events) assert.deepEqual(Object.keys(e).sort().filter((k) => !['address'].includes(k)), ['bytes', 'method', 'ms', 'status', 'truncated', 'url']);
});
