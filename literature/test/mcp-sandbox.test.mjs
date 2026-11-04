import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs, readKeyDirs, serverEnv, bwrapArgs } from '../../scripts/mcp-sandbox.mjs';

test('the launcher: secrets come from key files (quoted or not), first directory wins, fallbacks in order, nothing invented', () => {
  const a = mkdtempSync(join(tmpdir(), 'lit-keys-')), b = mkdtempSync(join(tmpdir(), 'lit-keys-'));
  try {
    writeFileSync(join(a, 'ncbi'), 'export NCBI_API_KEY="k1"\nNCBI_ADMIN_EMAIL=me@example.org\n');
    writeFileSync(join(b, 'ncbi'), 'NCBI_API_KEY=k2\nRESEARCH_EMAIL=lab@example.org\n');
    const keys = readKeyDirs([a, b]);
    assert.equal(keys.NCBI_API_KEY, 'k1');
    const spec = parseArgs(['--name', 'pubmed', '--secret', 'NCBI_API_KEY', '--secret', 'UNPAYWALL_EMAIL=RESEARCH_EMAIL,NCBI_ADMIN_EMAIL',
      '--secret', 'SEMANTIC_SCHOLAR_API_KEY', '--env', 'MCP_LOG_LEVEL=warning', '--', '/usr/bin/node', 'x.js']);
    const { env, missing } = serverEnv(spec, { keys, processEnv: { HOME: '/home/me', SECRET_OF_THE_USER: 'no' }, home: '/cache/pubmed' });
    assert.equal(env.NCBI_API_KEY, 'k1');
    assert.equal(env.UNPAYWALL_EMAIL, 'lab@example.org');
    assert.deepEqual(missing, ['SEMANTIC_SCHOLAR_API_KEY']);
    assert.equal(env.SEMANTIC_SCHOLAR_API_KEY, undefined);
    assert.equal(env.SECRET_OF_THE_USER, undefined, 'nothing else of the environment passes');
    assert.equal(env.HOME, '/cache/pubmed'); assert.equal(env.MCP_LOG_LEVEL, 'warning'); assert.equal(env.NODE_USE_ENV_PROXY, '1');
    assert.equal(env.ORT_DISABLE_TELEMETRY, '1', 'onnxruntime (the Semantic Scholar PDF converter) never reports to Microsoft');
    assert.equal(env.DO_NOT_TRACK, '1');
  } finally { rmSync(a, { recursive: true }); rmSync(b, { recursive: true }); }
});

test('the sandbox: own namespaces, no host files beyond /usr, /etc, the pinned install and its private home; secrets never in arguments', () => {
  const args = bwrapArgs({ home: '/cache/pubmed', socketPath: '/cache/.sockets/x/proxy.sock', command: ['/usr/bin/node', '/srv/x.js'] });
  assert.ok(args.includes('--unshare-all') && args.includes('--die-with-parent'));
  assert.ok(!args.includes('--share-net'), 'no host network: egress only through the proxy socket');
  const binds = args.flatMap((a, i) => (a === '--bind' || a === '--ro-bind' ? [args[i + 1]] : []));
  assert.ok(binds.every((p) => ['/usr', '/etc', '/cache/pubmed', '/cache/.sockets/x/proxy.sock'].includes(p) || p.includes('services/literature-mcp') || p.endsWith('netbridge.mjs')), JSON.stringify(binds));
  assert.ok(!args.some((a) => /HOME|KEY|EMAIL/.test(a) && a.includes('=')), 'no environment in arguments');
  assert.throws(() => parseArgs(['--name', 'x']), /usage/);
  assert.throws(() => parseArgs(['--name', '../x', '--', 'y']), /lowercase/);
});

// ---------------------------------------------------------------- macOS: a real server through the supervisor

const MAC_ARXIV = join(dirname(fileURLToPath(import.meta.url)), '../../services/literature-mcp/node_modules/@cyanheads/arxiv-mcp-server/dist/index.js');
const macSkip = process.platform !== 'darwin' ? 'macOS only' : !existsSync(MAC_ARXIV) ? 'run npm run literature:install' : false;

test('macOS: the server request has the roots of bwrapArgs: the install read-only, only its home writable, one proxy port', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  const { macServiceRequest } = await import('../../scripts/mcp-sandbox.mjs');
  const home = mkdtempSync(join(tmpdir(), 'mcp-home-'));
  try {
    const r = macServiceRequest({ home, command: ['/bin/true'], env: { SECRET: 'x' }, endpoint: { port: 4321, token: 't0k' } });
    assert.equal(r.kind, 'service'); assert.deepEqual(r.writes, [home]); assert.equal(r.egressPort, 4321);
    assert.ok(r.reads.every((p) => p.includes('literature-mcp') || !p.startsWith(homedir())), `reads: ${r.reads}`);
    assert.equal(r.env.HTTPS_PROXY, 'http://mina:t0k@127.0.0.1:4321'); assert.equal(r.env.SECRET, 'x');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('macOS: a literature server runs in the sandbox and answers MCP', { skip: macSkip }, async () => {
  await import('../../test/capabilities.mjs');                          // a supervisor for this process
  const { spawn } = await import('node:child_process');
  const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const child = spawn(process.execPath, [join(repo, 'scripts/mcp-sandbox.mjs'), '--name', 'arxiv', '--', '.venv/bin/node', 'node_modules/@cyanheads/arxiv-mcp-server/dist/index.js'],
    { cwd: repo, stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
  try {
    let buf = '';
    const replies = new Map();
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); replies.get(m.id)?.(m); } catch { /* log */ } } });
    let id = 0;
    const rpc = (method, params) => new Promise((done, fail) => { const n = ++id; const t = setTimeout(() => fail(new Error(`${method}: no reply`)), 30_000);
      replies.set(n, (m) => { clearTimeout(t); done(m); }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'arxiv-mcp-server');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = await rpc('tools/list', {});
    assert.ok(tools.result.tools.some((t) => t.name === 'arxiv_search'));
  } finally { child.kill('SIGTERM'); }
});
