import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
