// macOS: the host session from end to end. The launcher opens a session with a real broker (host/hostd.py serve, with
// isolated state), the Pi of a real instance (a launchd job, under the outer profile) calls mina_host, and a command of
// the agent cannot reach the broker. On Linux test/host.test.mjs and host/test_hostd.py cover the same rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO } from '../sandbox/sandbox.mjs';
import { needsLauncher } from './capabilities.mjs';

const skip = process.platform !== 'darwin' ? 'macOS only' : needsLauncher;

test('the Pi of a macOS instance uses the host session; a command of the agent cannot reach the broker', { skip, timeout: 120_000 }, async () => {
  // A short folder below the home folder: the socket path must stay below 104 bytes.
  const root = realpathSync(mkdtempSync(join(homedir(), '.mina-th-')));
  const project = join(root, 'p'), agent = join(root, 'agent'), run = join(root, 'r'), cfg = join(root, 'cfg');
  for (const d of [project, agent, cfg]) mkdirSync(d);
  spawnSync('/usr/bin/git', ['init', '-q', project]);
  // The configuration folders are trusted state: they must not contain the project.
  writeFileSync(join(cfg, 'host.json'), JSON.stringify({ version: 1, projects: { [project]: {} } }));
  writeFileSync(join(cfg, 'sandbox.json'), JSON.stringify({ network: 'offline' }));
  const hostEnv = { MINA_HOST_CONFIG: join(cfg, 'host.json'), MINA_HOST_STATE: join(root, 'state'), MINA_HOST_RUNTIME: run,
    MINA_HOSTD_RUNTIME: run, MINA_HOST_UNIT_PREFIX: `com.mina.test.wl${process.pid}`, MINA_SANDBOX_CONFIG: join(cfg, 'sandbox.json'), PI_CODING_AGENT_DIR: agent };
  const broker = spawn('/usr/bin/python3', ['-I', join(REPO, 'host/hostd.py'), 'serve'], { env: { ...process.env, ...hostEnv }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 200 && !existsSync(join(run, 'sock')); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(join(run, 'sock')), 'the broker listens');
    const plugin = join(root, 'provider.mjs');
    const probe = `/usr/bin/perl -MIO::Socket::UNIX -e 'print IO::Socket::UNIX->new(Peer => "${join(run, 'sock')}") ? "BROKER_REACHED" : "BROKER_REFUSED"'`;
    writeFileSync(plugin, `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(pathToFileURL(join(REPO, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href)};
export default function(pi) { const f = fauxProvider({ provider: 'mina-fixture', models: [{ id: 'fixture' }] });
  f.setResponses([fauxAssistantMessage(fauxToolCall('mina_host', { action: 'capabilities' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('bash', { command: ${JSON.stringify(probe)} }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Fixture completed.')]);
  pi.registerProvider(f.provider); }`);
    const env = { ...process.env, ...hostEnv, XDG_STATE_HOME: join(root, 'state-mina'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data') };
    const out = await new Promise((done) => {
      const child = execFile(process.execPath, [join(REPO, 'bin/mina.mjs'), '--full', '--model', 'mina-fixture/fixture', '-e', plugin, '--mode', 'json', '-p', 'go'],
        { cwd: project, env, timeout: 90_000, maxBuffer: 16 * 1024 ** 2 }, (error, stdout, stderr) => done({ error, stdout, stderr }));
      child.stdin.end();
    });
    const results = out.stdout.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e?.type === 'tool_execution_end').map((e) => ({ tool: e.toolName, text: JSON.stringify(e.result) }));
    const host = results.find((r) => r.tool === 'mina_host'), bash = results.find((r) => r.tool === 'bash');
    assert.ok(host, `${out.stderr}\n${out.stdout.slice(-3000)}`);
    assert.doesNotMatch(host.text, /UNAUTHENTICATED|not available|not running/, host.text);
    assert.match(host.text, /capabilities/);
    assert.match(bash.text, /BROKER_REFUSED/, 'a worker has no way to the broker socket');
  } finally {
    broker.kill('SIGTERM');
    await new Promise((r) => broker.once('exit', r));
    rmSync(root, { recursive: true, force: true });
  }
});
