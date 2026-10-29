#!/usr/bin/env node
// Runs one literature MCP server (stdio) in a sandbox. Pi starts this script as the server's command; MCP traffic passes
// through it unchanged on stdin/stdout.
//
// The server is third-party code that only needs the network and its own credentials, so it gets exactly that:
// - bubblewrap: read-only /usr and /etc, the pinned server code read-only, a private writable home
//   (~/.cache/mina/mcp/<name>), an empty /tmp, and nothing else of the host's files: no repository, no keys
//   directory, no ~/.pi, no workspace;
// - its own network namespace, with egress only through an egress proxy this script runs (lib/egress-proxy.mjs, level
//   'open'): public hosts only, never the host's loopback services or private networks; every connection is logged to
//   ~/.cache/mina/mcp/<name>.egress.jsonl;
// - an environment holding only the variables named on the command line, with secret values read here from the
//   research key directories (or this process's environment), never from the server's arguments or Pi's configuration;
//   MINA_EXA_KEYLESS (the user's opt-in to keyless Exa) is passed on when it is set.
//
// Usage: node scripts/mcp-sandbox.mjs --name NAME [--secret VAR[=FALLBACK_VAR]]... [--env VAR=VALUE]... -- COMMAND [ARGS...]
//   --secret NCBI_ADMIN_EMAIL=RESEARCH_EMAIL  passes NCBI_ADMIN_EMAIL, or RESEARCH_EMAIL's value when it is not set
//   (several fallbacks: VAR=A,B, tried in order).
//   COMMAND paths are relative to services/literature-mcp (the pinned install).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync, appendFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEgressProxy } from '../lib/egress-proxy.mjs';
import { EGRESS_ENV, NETBRIDGE_PATH } from '../sandbox/sandbox.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const install = join(repo, 'services/literature-mcp');
const die = (msg) => { process.stderr.write(`mcp-sandbox: ${msg}\n`); process.exit(2); };

export function parseArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep < 0 || sep === argv.length - 1) throw new Error('usage: --name NAME [--secret VAR[=FALLBACK]] [--env VAR=VALUE] -- COMMAND [ARGS...]');
  const out = { name: null, secrets: [], env: {}, command: argv.slice(sep + 1) };
  for (let i = 0; i < sep; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--name') { out.name = v; i++; } else if (a === '--secret') { const [name, fallbacks] = v.split('='); out.secrets.push({ name, fallbacks: fallbacks ? fallbacks.split(',') : [] }); i++; }
    else if (a === '--env') { const at = v.indexOf('='); out.env[v.slice(0, at)] = v.slice(at + 1); i++; } else throw new Error(`unknown option ${a}`);
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(out.name ?? '')) throw new Error('--name must be a lowercase identifier');
  return out;
}

// KEY=VALUE or `export KEY=VALUE` lines (optionally quoted) from every file in the key directories.
export function readKeyDirs(dirs) {
  const values = {};
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      let text;
      try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
        if (!m) continue;
        const v = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
        if (v && values[m[1]] === undefined) values[m[1]] = v;
      }
    }
  }
  return values;
}

// The research key directories, first one wins per variable: PI_RESEARCH_KEYS_DIR, this repository's keys/, then
// ~/.config/mina/keys (the launcher passes the first that exists as PI_RESEARCH_KEYS_DIR, bin/mina.mjs layerEnv).
export const keyDirs = (env = process.env, home = homedir()) => [env.PI_RESEARCH_KEYS_DIR, join(repo, 'keys'), join(home, '.config/mina/keys')];
// Settings of the user's (not secrets) that every server gets when they are set.
export const PASS_ENV = Object.freeze(['MINA_EXA_KEYLESS']);

// The environment the server sees: its named secrets (missing ones are reported, never invented), its fixed settings, and
// the proxy variables (NODE_USE_ENV_PROXY makes Node's fetch honor them).
export function serverEnv({ secrets, env }, { keys, processEnv = process.env, home }) {
  // ORT_DISABLE_TELEMETRY: the Semantic Scholar server's PDF converter loads onnxruntime, which otherwise reports to Microsoft.
  const out = { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', TMPDIR: '/tmp', LOGS_DIR: join(home, 'logs'), ...EGRESS_ENV, NODE_USE_ENV_PROXY: '1',
    ORT_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', ...Object.fromEntries(PASS_ENV.filter((n) => processEnv[n]).map((n) => [n, processEnv[n]])), ...env };
  const missing = [];
  for (const { name, fallbacks = [] } of secrets) {
    const v = [name, ...fallbacks].map((n) => processEnv[n] ?? keys[n]).find(Boolean);
    if (v) out[name] = v; else missing.push(name);
  }
  return { env: out, missing };
}

// Inside the server's sandbox: the proxy socket and the bridge (lib/netbridge.mjs's default socket path).
export const EGRESS_RUN = '/run/mina-egress';
export function bwrapArgs({ home, socketPath, command }) {
  const venv = join(install, '.venv');
  return ['--unshare-all', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/bin', '/sbin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64',
    '--ro-bind', '/etc', '/etc', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run',
    '--ro-bind', install, install, ...(existsSync(venv) ? ['--ro-bind', realpathSync(venv), realpathSync(venv)] : []),
    '--bind', home, home,
    '--dir', EGRESS_RUN, '--bind', socketPath, `${EGRESS_RUN}/proxy.sock`,
    '--ro-bind', NETBRIDGE_PATH, `${EGRESS_RUN}/netbridge.mjs`,
    // The environment is set by spawn (it replaces the parent's completely), never as arguments: arguments of a running
    // process are readable in /proc, and secrets must not be.
    '--chdir', home, '--', '/usr/bin/node', `${EGRESS_RUN}/netbridge.mjs`, '--', ...command];
}

// Each server's private home and its egress log: ~/.cache/mina/mcp (XDG_CACHE_HOME is respected).
export const mcpCacheDir = (env = process.env, home = homedir()) => join(env.XDG_CACHE_HOME || join(home, '.cache'), 'mina', 'mcp');

async function main() {
  let spec;
  try { spec = parseArgs(process.argv.slice(2)); } catch (error) { die(error.message); }
  const cache = mcpCacheDir();
  const home = join(cache, spec.name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const log = join(cache, `${spec.name}.egress.jsonl`);
  // Paths into the pinned install (node_modules/..., .venv/...) are relative to services/literature-mcp.
  const command = spec.command.map((part) => (!isAbsolute(part) && /^(node_modules|\.venv)\//.test(part) ? join(install, part) : part));
  for (const part of command) if (part.startsWith(install) && !existsSync(part)) die(`${part} is not installed: run npm run literature:install`);
  const { env, missing } = serverEnv(spec, { keys: readKeyDirs(keyDirs()), home });
  if (missing.length) process.stderr.write(`mcp-sandbox[${spec.name}]: not configured (runs without them): ${missing.join(', ')}\n`);
  const proxy = createEgressProxy({ level: 'open', socketDir: join(cache, '.sockets'),
    onEvent: (e) => { try { appendFileSync(log, `${JSON.stringify(e)}\n`, { mode: 0o600 }); } catch { /* diagnostic only */ } } });
  await proxy.start();
  const child = spawn('bwrap', bwrapArgs({ home, socketPath: proxy.socketPath, command }), { stdio: 'inherit', env });
  const stop = (signal) => { try { child.kill(signal); } catch { /* gone */ } };
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => stop(s));
  child.on('exit', async (code, signal) => { await proxy.close().catch(() => {}); process.exit(code ?? (signal ? 128 : 1)); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (spawnSync('bwrap', ['--version']).status !== 0) die('bubblewrap (bwrap) is required');
  main();
}
