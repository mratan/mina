import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { serverEnv, keyDirs, bwrapArgs, mcpCacheDir, EGRESS_RUN } from '../scripts/mcp-sandbox.mjs';
import { REPO } from '../sandbox/sandbox.mjs';

test('MCP servers get MINA_EXA_KEYLESS when the user sets it, and no other variable of the caller', () => {
  const spec = { secrets: [], env: {} };
  const on = serverEnv(spec, { keys: {}, processEnv: { MINA_EXA_KEYLESS: '1', HOME: '/home/user', OTHER: 'x' }, home: '/cache/x' }).env;
  assert.equal(on.MINA_EXA_KEYLESS, '1');
  assert.equal(on.OTHER, undefined); assert.equal(on.HOME, '/cache/x');
  assert.equal(serverEnv(spec, { keys: {}, processEnv: {}, home: '/cache/x' }).env.MINA_EXA_KEYLESS, undefined);
  // A server's fixed settings still win.
  assert.equal(serverEnv({ secrets: [], env: { MINA_EXA_KEYLESS: '0' } }, { keys: {}, processEnv: { MINA_EXA_KEYLESS: '1' }, home: '/c' }).env.MINA_EXA_KEYLESS, '0');
});

test('MCP sandbox paths: key folders, cache, in-sandbox egress folder', () => {
  assert.deepEqual(keyDirs({ PI_RESEARCH_KEYS_DIR: '/k' }, '/home/user'), ['/k', join(REPO, 'keys'), '/home/user/.config/mina/keys']);
  assert.equal(mcpCacheDir({}, '/home/user'), '/home/user/.cache/mina/mcp');
  assert.equal(mcpCacheDir({ XDG_CACHE_HOME: '/c' }, '/home/user'), '/c/mina/mcp');
  const a = bwrapArgs({ home: '/home/user/.cache/mina/mcp/x', socketPath: '/s/proxy.sock', command: ['node', 'server.js'] });
  assert.equal(EGRESS_RUN, '/run/mina-egress');
  assert.ok(a.join(' ').includes('--bind /s/proxy.sock /run/mina-egress/proxy.sock'));
  assert.deepEqual(a.slice(a.lastIndexOf('--') - 1), ['/run/mina-egress/netbridge.mjs', '--', 'node', 'server.js']);
});
