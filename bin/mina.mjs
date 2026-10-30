#!/usr/bin/env node
// mina: normal Pi with goals, compaction and handoff, research and a sandbox layered on top (docs/architecture.md).
// It starts the Pi pinned in this repository (package.json) with your own ~/.pi/agent, in the folder you are in, with Pi's normal
// explicit trusted Mina layers. Project instructions cross the same worker boundary as file tools.
//
// Usage: mina [--full | --fast | --lean] [--nosandbox] [--sandbox-write PATH] [--sandbox-net open|packages|offline]
//             [--mina-dry-run] [pi arguments]
//   --full   Mina layers, research skill, and safe project instructions (model tuning can select another default)
//   --fast   mina's packages only: no other extensions, no AGENTS.md/CLAUDE.md (smaller first prompt, for local models)
//   --lean   Pi's base prompt and tools, without the research tools
//   --nosandbox      run without the sandbox (it is on by default: sandbox/sandbox.mjs)
//   --sandbox-read PATH    another read-only data root (repeatable; also "read" in the configuration)
//   --sandbox-write PATH   another writable folder (repeatable; also "write" in ~/.config/mina/sandbox.json)
//   --sandbox-net LEVEL    network for the agent's commands: open (default), packages, offline
//   --mina-dry-run   print the Pi command, the model and where it came from, the tuning and the sandbox, then exit
// Without --model or --provider, mina starts on MINA_MODEL (provider/id) if it is set, else on Pi's own settings default
// (defaultProvider/defaultModel in ~/.pi/agent/settings.json). There is no built-in default model.
// Model tuning files (<provider>__<model>.json) come from $MINA_MODELS_DIR (else ~/.config/mina/models), then models/.
// Pi's subcommands (install, list, config, mcp, ...) pass through unchanged, without the sandbox.
// mina sandbox unlink-git-objects [--dry-run] DIR   gives each hard-linked git object of the clone DIR its own copy
//   (sandbox/git-objects.mjs), for a clone that the startup check refuses.
// mina host discover|show [PROJECT]|validate|apply FILE|- [--dry-run] [--yes]|edit [--yes]
//   shows and changes the host policy (~/.config/mina/host.json, or $MINA_HOST_CONFIG) in your terminal: host/policy.py.
//   Exit status: 0 done, 1 refused or failed, 2 usage error. The agent's sandbox cannot write the policy file.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { hotCompactConfig } from '../extensions/handoff/policy.mjs';
import { findMostRecentSession } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js';
import * as sandbox from '../sandbox/sandbox.mjs';
import { unlinkGitObjects, formatUnlinkReport } from '../sandbox/git-objects.mjs';
import { createInstance, scopeCommand, instanceLimits, instanceDirectory, artifactDirectory, loadInstance, inspectInstance, stopInstance, writeInstance } from '../lib/instance-runtime.mjs';
import { request as hostRequest } from '../extensions/host/index.js';
import { ownerSkills } from '../lib/skill-resources.mjs';
import { modelTuning, modelDirs, userModelsDir } from '../lib/model-tuning.mjs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PI_CLI = join(REPO, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const MODES = ['full', 'fast', 'lean'];
// Flags that open an existing session, which keeps its own model: mina adds no --model to them.
const SESSION_FLAGS = ['--continue', '-c', '--resume', '-r', '--session', '--fork'];
const SUBCOMMANDS = ['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth', 'mcp'];

// mina's layers, by mode. Paths are absolute so they load from any folder. `skip` names layers the user already has.
export function layers(mode, skip = new Set(), { sandboxed = false } = {}) {
  // extensions/host does nothing unless the launcher opened a host session (openHostSession).
  const base = [join(REPO, 'extensions/identity'), ...(sandboxed ? [join(REPO, 'extensions/sandbox')] : []), join(REPO, 'extensions/host'),
    ...(skip.has('codex-usage') ? [] : [join(REPO, 'extensions/codex-usage')]),
    join(REPO, 'extensions/footer'),
    // Claude through the Claude Agent SDK on the local Claude Code login (provider claude-sdk); pinned in package.json.
    ...(skip.has('claude-sdk') ? [] : [join(REPO, 'node_modules/pi-claude-subscription')])];
  const goal = skip.has('goal') ? [] : [join(REPO, 'extensions/goal')];
  const compact = skip.has('hot-compact') ? [] : [join(REPO, 'extensions/compact')];
  const handoff = [...(sandboxed ? [join(REPO, 'extensions/delegates')] : []), join(REPO, 'extensions/handoff')];
  const research = [...(skip.has('research-search') ? [] : [join(REPO, 'adapters/pi-research-search')]),
    ...(skip.has('literature') ? [] : [join(REPO, 'extensions/literature')])];
  const skills = [join(REPO, 'skills/mina-research')];
  if (mode === 'lean') return { extensions: [...base, ...goal, ...compact, ...handoff], skills: [] };
  return { extensions: [...base, ...goal, ...compact, ...handoff, ...research], skills };
}

// A layer that Pi already loads from your settings or the project's .pi/settings.json (for example your own pi-goal, or
// a copy of the research adapters) is not loaded twice: two extensions with the same tool names fail to load.
const DUPLICATES = [[/pi-goal(?![-\w])/, 'goal'], [/pi-hot-compact(?![-\w])/, 'hot-compact'],
  [/pi-research-search(?![-\w])/, 'research-search'], [/pi-literature-broker(?![-\w])/, 'literature'],
  [/pi-claude-subscription(?![-\w])/, 'claude-sdk']];
export function userDuplicates(...settingsList) {
  const sources = settingsList.flatMap((settings) => [...(settings?.packages ?? []), ...(settings?.extensions ?? [])])
    .map((x) => (typeof x === 'string' ? x : x?.source ?? ''));
  return new Set(DUPLICATES.filter(([re]) => sources.some((s) => re.test(s))).map(([, layer]) => layer));
}

// The project's Pi settings: .pi/settings.json in the folder and in its git top level.
export function projectSettings(cwd) {
  const top = sandbox.projectRoot(cwd);
  return [...new Set([cwd, top])].map((dir) => readJson(join(dir, '.pi', 'settings.json'))).filter(Boolean);
}

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const agentDir = (env) => env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');

// The model this session starts on, and where it came from: --model provider/id (or --provider + --model) 'flag', else
// MINA_MODEL 'MINA_MODEL', else Pi's settings default 'pi-settings' (--provider alone keeps the settings default model).
// Neither: { provider: null, model: null, source: 'none' }, and Pi chooses as it would without mina.
export function resolveModel(args, env = process.env) {
  const value = (...names) => { for (const n of names) { const i = args.indexOf(n); if (i >= 0 && i + 1 < args.length) return args[i + 1]; } return undefined; };
  const settings = readJson(join(agentDir(env), 'settings.json')) ?? {};
  let model = value('--model'), provider = value('--provider'), source = model || provider ? 'flag' : null;
  if (!model && !provider && env.MINA_MODEL?.trim()) { model = env.MINA_MODEL.trim(); source = 'MINA_MODEL'; }
  if (model) {
    model = model.replace(/:[a-z]+$/, ''); // drop a ":<thinking>" suffix
    if (model.includes('/')) [provider, model] = [model.slice(0, model.indexOf('/')), model.slice(model.indexOf('/') + 1)];
  }
  provider ??= settings.defaultProvider ?? null;
  model ??= settings.defaultModel ?? null;
  return { provider, model, source: source ?? (provider || model ? 'pi-settings' : 'none') };
}
export function startingModel(args, env = process.env) {
  const { provider, model } = resolveModel(args, env);
  return { provider, model };
}

// The model of the session that -c, --session or --fork opens: its last model_change entry. -c continues the most recent
// session of this folder, found the way Pi finds it. Without this, `mina -c` loaded the tuning of the starting model
// instead of the session's own (a small local model's compaction threshold on a large-window session), and the goal
// settings of the wrong model.
export function sessionModel(args, env = process.env, cwd = env.MINA_CWD || process.cwd()) {
  const value = (n) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
  let file = value('--session') ?? value('--fork');
  if (!file && (args.includes('-c') || args.includes('--continue'))) {
    const dir = value('--session-dir') || env.PI_CODING_AGENT_SESSION_DIR
      || join(agentDir(env), 'sessions', `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
    file = findMostRecentSession(dir, cwd);
  }
  if (!file || !existsSync(file)) return null;
  // Pi restores the latest model_change or answering assistant message. Pi 1.3 records `-c --model X` only on the
  // assistant messages that follow, so model_change alone resumed a session with the tuning of the model it switched from.
  let last = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"model_change"') && !line.includes('"assistant"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'model_change' && e.provider && e.modelId) last = { provider: e.provider, model: e.modelId };
      else if (e.type === 'message' && e.message?.role === 'assistant' && e.message.provider && e.message.model) last = { provider: e.message.provider, model: e.message.model };
    } catch { /* a partial line */ }
  }
  return last;
}

// The model's tuning file: the user's folder first, then models/ in this repository (lib/model-tuning.mjs).
export function tuningFor({ provider, model }, dirs = modelDirs()) {
  return provider && model ? modelTuning(provider, model, dirs) : null;
}

// Split mina's own flags from Pi's arguments and build the Pi command line.
export function plan(argv, env = process.env) {
  if (SUBCOMMANDS.includes(argv[0])) return { args: argv, mode: null, tuning: null, dryRun: false, passthrough: true };
  let mode = env.MINA_MODE && MODES.includes(env.MINA_MODE) ? env.MINA_MODE : null, dryRun = false;
  let sandboxed = env.MINA_SANDBOX !== '0', network = null;
  const write = [], read = [], rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full' || a === '--fast' || a === '--lean') mode = a.slice(2);
    else if (a === '--mina-dry-run') dryRun = true;
    else if (a === '--nosandbox' || a === '--no-sandbox') sandboxed = false;
    else if (a === '--sandbox-write' || a === '--sandbox-read') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${a} requires a path.`);
      (a === '--sandbox-write' ? write : read).push(value);
    }
    else if (a === '--sandbox-net') network = argv[++i];
    else rest.push(a);
  }
  const opensSession = rest.some((a) => SESSION_FLAGS.includes(a)) && !rest.includes('--model') && !rest.includes('--provider');
  const opened = opensSession ? sessionModel(rest, env) : null;
  const { source: resolvedSource, ...started } = opened ? { source: 'session' } : resolveModel(rest, env);
  const model = opened ?? started, modelSource = opened ? 'session' : resolvedSource;
  // MINA_MODEL is passed to Pi explicitly; Pi starts on its own settings default by itself.
  if (modelSource === 'MINA_MODEL' && !rest.some((a) => SESSION_FLAGS.includes(a)) && model.provider && model.model)
    rest.unshift('--model', `${model.provider}/${model.model}`);
  // MINA_TUNING_FILE replaces the model's tuning file (tests, experiments): it then drives hot-compact and handoff alike.
  const override = env.MINA_TUNING_FILE ? readJson(env.MINA_TUNING_FILE) : null;
  const tuning = override ? { file: env.MINA_TUNING_FILE, ...override } : tuningFor(model, modelDirs(env));
  mode ??= tuning?.default_mode ?? 'full';
  // Sandboxed modes never discover executable project code. Explicit trusted Mina layers stay pinned.
  const cwd = env.MINA_CWD || process.cwd();
  const skip = !sandboxed && mode === 'full' ? userDuplicates(readJson(join(agentDir(env), 'settings.json')), ...projectSettings(cwd)) : new Set();
  // Plain pi's copy of the Codex usage footer (a link to extensions/codex-usage) is discovered in --full: not loaded twice.
  if (!sandboxed && mode === 'full' && existsSync(join(agentDir(env), 'extensions', 'codex-usage'))) skip.add('codex-usage');
  const box = sandboxed ? sandbox.settings({ cwd, env, write, read, network }) : null;
  if (box) box.limits = instanceLimits(sandbox.loadConfig(homedir(), env).limits ?? {});
  const { extensions, skills } = layers(mode, skip, { sandboxed });
  const pre = [];
  if (sandboxed) {
    // Project instructions load through the worker, not native filesystem discovery.
    pre.push('--no-extensions', '--no-approve', '--no-context-files', '--no-skills', '--no-prompt-templates');
    if (rest.some((a) => ['--approve', '-a'].includes(a))) throw new Error('Project executable configuration is disabled. Use explicit trusted extensions outside writable roots.');
  } else {
    if (mode === 'fast' || mode === 'lean') pre.push('--no-extensions', '--no-context-files');
    if (mode === 'lean') pre.push('--no-skills');
  }
  for (const e of extensions) pre.push('-e', e);
  for (const s of skills) pre.push('--skill', s);
  return { args: [...pre, ...rest], mode, model, modelSource, tuning, dryRun, passthrough: false, skipped: [...skip], sandbox: box };
}

// No telemetry leaves under mina (docs/usage.md#privacy-and-network). Pi: no install ping or attribution headers
// (PI_TELEMETRY=0); in sessions also no pi.dev model-catalog fetch, version check, package checks or downloads
// (PI_OFFLINE=1). Pi's own subcommands (install, update...) keep their network. onnxruntime, which the literature PDF
// converter loads, reports to Microsoft unless ORT_DISABLE_TELEMETRY is set. Model and research traffic are unaffected.
export function privacyEnv(p) {
  return { PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', ORT_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', ...(p.passthrough ? {} : { PI_OFFLINE: '1' }) };
}

// Research settings of the user's that reach Pi (and through it the research adapters and the literature MCP servers,
// scripts/mcp-sandbox.mjs) when they are set: MINA_EXA_KEYLESS opts in to Exa's keyless endpoint. Not secrets.
export const RESEARCH_ENV = Object.freeze(['MINA_EXA_KEYLESS']);
export const researchEnv = (env = process.env) => Object.fromEntries(RESEARCH_ENV.filter((n) => env[n]).map((n) => [n, env[n]]));

// Environment for the layers: the tuning file for the handoff extension, and pi-hot-compact settings for this model
// (the user's ~/.pi/agent/hot-compact.json with compaction starting at the model's compact_at), in mina's cache.
export function layerEnv(p, env = process.env, { home = homedir(), repoKeys = join(REPO, 'keys') } = {}) {
  const out = {};
  if (p.tuning?.file && !env.MINA_TUNING_FILE) out.MINA_TUNING_FILE = p.tuning.file;
  // The research key folder (exa, brave, ...): PI_RESEARCH_KEYS_DIR, else this repository's keys/ if it exists, else
  // ~/.config/mina/keys if it exists, the same order the literature MCP sandbox reads (scripts/mcp-sandbox.mjs). The
  // search adapter alone looks only in keys/, so keys kept in the user folder would otherwise go unused (Brave "not
  // configured", Exa keyless). Only the folder is passed, never a key.
  if (!env.PI_RESEARCH_KEYS_DIR) {
    const dir = [repoKeys, join(home, '.config', 'mina', 'keys')].find((d) => existsSync(d));
    if (dir) out.PI_RESEARCH_KEYS_DIR = dir;
  }
  if (p.sandbox) Object.assign(out, { MINA_SANDBOX: '1', MINA_SANDBOX_PROJECT: p.sandbox.project, MINA_SANDBOX_NET: p.sandbox.network,
    MINA_SANDBOX_READ: JSON.stringify(p.sandbox.readable ?? []), MINA_SANDBOX_WRITE: JSON.stringify(p.sandbox.writable), MINA_SANDBOX_HIDE: JSON.stringify(p.sandbox.hidden), MINA_SANDBOX_EXPOSE: JSON.stringify(p.sandbox.exposed ?? []), MINA_SANDBOX_READONLY: JSON.stringify(p.sandbox.readOnly ?? []) });
  if (!p.skipped?.includes('hot-compact') && !env.PI_HOT_COMPACT_CONFIG) {
    const user = readJson(join(agentDir(env), 'hot-compact.json')) ?? {};
    const config = hotCompactConfig(user, p.tuning, p.tuning?.context_window);
    const dir = join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'mina');
    const file = join(dir, `hot-compact-${p.model?.provider ?? 'default'}__${String(p.model?.model ?? 'default').replaceAll('/', '_')}.json`);
    try { mkdirSync(dir, { recursive: true }); writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`); out.PI_HOT_COMPACT_CONFIG = file; out.MINA_HOT_COMPACT_MANAGED = '1'; } catch { /* keep the user's own file */ }
  }
  return out;
}

// The engineering-host profile (docs/host-profile.md): when mina-hostd runs and the project is registered in
// ~/.config/mina/host.json, the launcher (outside the sandbox) opens a host session and gets a grant that only its own Pi
// process can use. Off when the broker is not installed or the project is not registered; MINA_HOST=0 turns it off.
export async function openHostSession(project, env = process.env, { uid = process.getuid() } = {}) {
  if (env.MINA_HOST === '0') return null;
  const hp = sandbox.hostPaths({ uid, env });
  const socket = join(hp.brokerDir, 'sock');
  const configured = existsSync(env.MINA_HOST_CONFIG || join(homedir(), '.config', 'mina', 'host.json'));
  if (!existsSync(socket)) return configured ? { unavailable: `mina-hostd is not running (no ${socket})` } : null;
  const out = await hostRequest(socket, { op: 'session_open', project, label: `mina ${process.pid}` }, { timeoutMs: 5000 });
  if (!out.ok) return { unavailable: `${out.error.code}: ${out.error.message}` };
  if (!out.result.registered && env.MINA_HOST !== '1') return null;
  const dir = mkdtempSync(join(env.XDG_RUNTIME_DIR || `/run/user/${uid}`, 'mina-grant-'));
  chmodSync(dir, 0o700);
  const grantFile = join(dir, 'grant');
  writeFileSync(grantFile, `${out.result.grant}\n`, { mode: 0o600 });
  return { brokerDir: hp.brokerDir, grantFile, dir, session: out.result.session };
}

// What the Pi process is told about the host session.
export function hostEnv(host, { sandboxed, uid = process.getuid(), env = process.env } = {}) {
  if (!host) return {};
  if (host.unavailable) return { MINA_HOST_UNAVAILABLE: host.unavailable };
  const hp = sandbox.hostPaths({ uid, env });
  return sandboxed ? { MINA_HOST_SOCKET: hp.socket, MINA_HOST_GRANT_FILE: hp.grant }
    : { MINA_HOST_SOCKET: join(host.brokerDir, 'sock'), MINA_HOST_GRANT_FILE: host.grantFile };
}

// `mina host ...`: the owner's terminal commands for the host policy. One implementation (host/policy.py) with the
// broker's policy_propose: the same validation, change kinds, diff, risk flags and atomic write with a backup.
export const POLICY_PY = join(REPO, 'host', 'policy.py');
export const HOST_USAGE = 'usage: mina host discover [--json] | show [PROJECT] [--json] | validate | apply FILE|- [--project DIR] [--dry-run] [--yes] | edit [--yes]\n'
  + '  Shows and changes the host policy (MINA_HOST_CONFIG, else ~/.config/mina/host.json). See docs/host-profile.md, "Change the host policy".\n';

export function hostCommand(args, env = process.env, { cwd = env.MINA_CWD || process.cwd(), python = 'python3' } = {}) {
  if (!args.length || ['-h', '--help', 'help'].includes(args[0]) && args.length === 1) {
    (args.length ? process.stdout : process.stderr).write(HOST_USAGE);
    return args.length ? 0 : 2;
  }
  // -I: no user site packages, no PYTHON* variables, no script folder from the environment. The environment itself
  // (MINA_HOST_CONFIG, MINA_HOST_STATE, VISUAL/EDITOR, the fixture variables of the tests) passes through.
  const r = spawnSync(python, ['-I', POLICY_PY, ...args], { stdio: 'inherit', env, cwd });
  if (r.error) { process.stderr.write(`mina: cannot run ${python}: ${r.error.message}\n`); return 1; }
  if (r.signal) return 1;
  return r.status === 0 || r.status === 2 ? r.status : 1;
}

function sandboxCommand(args) {
  const dryRun = args.includes('--dry-run'), rest = args.filter((a) => a !== '--dry-run');
  if (rest[0] !== 'unlink-git-objects' || rest.length !== 2) {
    process.stderr.write('usage: mina sandbox unlink-git-objects [--dry-run] DIR\n'
      + '  Gives each hard-linked file in DIR/.git/objects its own copy (for a clone made by a git clone from a local path).\n');
    return 2;
  }
  let report;
  try { report = unlinkGitObjects(rest[1], { dryRun }); } catch (e) { process.stderr.write(`mina: ${e.message}\n`); return 1; }
  process.stdout.write(`${formatUnlinkReport(report)}\n`);
  return report.ok ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv[0] === 'sandbox') return sandboxCommand(argv.slice(1));
  if (argv[0] === 'host') return hostCommand(argv.slice(1), env);
  if (argv[0] === 'status' && !argv[1]) {
    const dir = instanceDirectory(env);
    const instances = (existsSync(dir) ? readdirSync(dir) : []).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).sort().map(name => {
      const instance = loadInstance(name.slice(0, -5), dir);
      return { instance: instance.id, cwd: instance.cwd, limits: instance.limits, ...inspectInstance(instance) };
    });
    process.stdout.write(`${JSON.stringify({ instances, broker_jobs: 'separately supervised; not stopped by this command' }, null, 2)}\n`);
    return 0;
  }
  if (['status', 'stop'].includes(argv[0])) {
    const instance = loadInstance(argv[1], instanceDirectory(env));
    const observation = argv[0] === 'stop' ? await stopInstance(instance) : inspectInstance(instance);
    process.stdout.write(`${JSON.stringify({ instance: instance.id, ...observation, broker_jobs: 'separately supervised; not stopped by this command', artifacts: { state: 'preserved', outputRoot: instance.workerOutputs } }, null, 2)}\n`);
    return 0;
  }
  if (!existsSync(PI_CLI)) { process.stderr.write(`mina: the pinned Pi is missing: ${PI_CLI}\n`); return 1; }
  const p = plan(argv, env);
  for (const s of p.skipped ?? []) process.stderr.write(`mina: your Pi or project settings already load ${({ goal: 'pi-goal', literature: 'pi-literature-broker', 'research-search': 'pi-research-search' })[s] ?? s}; mina uses that copy instead of its own\n`);
  if (p.sandbox && p.mode === 'full' && !argv.some(a => ['--no-skills', '-ns'].includes(a))) {
    const skills = await ownerSkills({ agentDir: agentDir(env), home: homedir(), writable: p.sandbox.writable,
      privateRoots: [instanceDirectory(env), artifactDirectory(env), dirname(p.sandbox.config || join(homedir(), '.config/mina/sandbox.json')),
        env.MINA_HOST_STATE || join(homedir(), '.local/state/mina/hostd')] });
    const end = p.args.indexOf('--');
    p.args.splice(end < 0 ? p.args.length : end, 0, ...skills.files.flatMap(file => ['--skill', file]));
    p.sandbox.exposed.push(...skills.directories);
  }
  const runEnv = { ...env, MINA: '1', MINA_MODE: p.mode ?? '', ...privacyEnv(p) };
  if (!p.passthrough) Object.assign(runEnv, layerEnv(p, env), { MINA_INSTANCE_ID: randomUUID() });
  let command = [process.execPath, PI_CLI, ...p.args];
  let instance = null;
  if (!p.passthrough && !p.sandbox && !p.dryRun) process.stderr.write('mina: --nosandbox disables worker isolation and instance OS limits. This is not an unattended boundary.\n');
  if (p.sandbox && !p.dryRun) {
    try {
      sandbox.validateWritableRoots(p.sandbox.writable, { trustedRoots: [REPO, ...sandbox.defaultWritable(homedir(), env), instanceDirectory(env), artifactDirectory(env),
        dirname(p.sandbox.config || join(homedir(), '.config', 'mina', 'sandbox.json')),
        env.MINA_HOST_STATE || join(homedir(), '.local', 'state', 'mina', 'hostd')], readable: p.sandbox.readable, hidden: p.sandbox.hidden });
    } catch (e) {   // a refused folder: the message says what to do; a stack trace would only hide it
      if (!e.message?.startsWith('mina sandbox:')) throw e;
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    sandbox.validateTrustedResources([
      ...['settings.json', 'models.json', 'auth.json', 'hot-compact.json'].map((name) => join(agentDir(env), name)),
      p.sandbox.config, env.MINA_TUNING_FILE, env.PI_HOT_COMPACT_CONFIG, p.tuning?.file, userModelsDir(env),
      env.MINA_HOST_CONFIG || join(homedir(), '.config', 'mina', 'host.json'),
      ...p.args.filter((_v, i) => ['-e', '--extension', '--skill'].includes(p.args[i - 1])),
    ], p.sandbox.writable);
    const privateRoots = [agentDir(env), instanceDirectory(env), ...sandbox.claudeState(homedir(), env),
      dirname(p.sandbox.config || join(homedir(), '.config', 'mina', 'sandbox.json')),
      env.MINA_HOST_STATE || join(homedir(), '.local', 'state', 'mina', 'hostd')];
    sandbox.validateReadableRoots(p.sandbox.readable, { trustedRoots: privateRoots });
    runEnv.MINA_SANDBOX_PRIVATE = JSON.stringify(privateRoots); // read grants during the session use the same rule
    for (let i = 0; i < p.args.length; i++) {
      if (['-e', '--extension', '--skill'].includes(p.args[i])) {
        const path = p.args[++i];
        if (!path || sandbox.insideAny(path, p.sandbox.writable, p.sandbox.cwd)) throw new Error('Executable extensions and native skill paths must be outside writable roots.');
      }
    }
    p.sandbox.trustedPaths = [REPO, ...p.args.filter((_v, i) => ['-e', '--extension', '--skill'].includes(p.args[i - 1])).map((path) => dirname(resolve(path)))];
    instance = createInstance({ cwd: p.sandbox.cwd, stateDir: instanceDirectory(env), artifactBase: artifactDirectory(env), limits: p.sandbox.limits });
    runEnv.MINA_INSTANCE_ID = instance.id;
    runEnv.MINA_WORKER_HOME = instance.workerHome;
    runEnv.MINA_WORKER_OUTPUTS = instance.workerOutputs;
    runEnv.TMPDIR = '/tmp';
    // Host shell hooks and editable PATH executables must not execute in the controller.
    runEnv.MINA_WORKER_PATH = env.PATH || '/usr/local/bin:/usr/bin:/bin';
    runEnv.PATH = (env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':').filter((entry) =>
      entry.startsWith('/') && !sandbox.insideAny(entry, p.sandbox.writable, p.sandbox.cwd)).join(':');
    for (const name of Object.keys(runEnv)) if (/^(BASH_FUNC_|LD_|DYLD_)/.test(name) || ['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_V8_COVERAGE', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PI_SHELL_PATH'].includes(name)) delete runEnv[name];
    // The private runtime folder and /tmp hide the Wayland and X11 sockets, so Pi copies through the terminal (OSC 52).
    delete runEnv.WAYLAND_DISPLAY; delete runEnv.DISPLAY;
    runEnv.PI_CLIPBOARD_OSC52 = '1';
    // Workers have a private home without a git identity: commits use the owner's (name and email are not secrets).
    for (const [key, vars] of [['user.name', ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']], ['user.email', ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']]]) {
      let value = '';
      try { value = execFileSync('/usr/bin/git', ['config', '--global', '--get', key], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', HOME: homedir() } }).trim(); } catch { /* unset */ }
      for (const v of vars) if (value && !runEnv[v]) runEnv[v] = value;
    }
    runEnv.GIT_CONFIG_COUNT = '3';
    Object.assign(runEnv, { GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
      GIT_CONFIG_KEY_2: 'credential.helper', GIT_CONFIG_VALUE_2: '' });
    if (p.args.includes('--verbose')) process.stderr.write(`mina: instance ${instance.id}; local limit ${instance.limits.maxWallS ? `${instance.limits.maxWallS}s` : 'no wall-clock deadline'}, ${instance.limits.memoryBytes} bytes, ${instance.limits.maxProcesses} processes.\nmina: explicit local stop: mina stop ${instance.id}; broker jobs remain separate.\n`);
  }
  const host = p.passthrough || p.dryRun ? null : await openHostSession(p.sandbox?.project ?? sandbox.projectRoot(env.MINA_CWD || process.cwd()), env);
  Object.assign(runEnv, hostEnv(host, { sandboxed: !!p.sandbox, env }));
  if (p.sandbox) {
    const problem = sandbox.projectProblem(p.sandbox.project);
    if (problem) { process.stderr.write(`mina: sandbox: ${problem}\n`); return 2; }
    if (!sandbox.bwrapAvailable()) { process.stderr.write('mina: sandbox: bubblewrap (bwrap) is required; install it, or run mina --nosandbox\n'); return 2; }
    command = [sandbox.BWRAP_PATH, ...sandbox.outerArgs(p.sandbox, { env: runEnv, host: host?.grantFile ? host : null }), '--', ...command];
  }
  Object.assign(runEnv, researchEnv(env));
  if (instance) command = scopeCommand(instance, command);
  if (p.dryRun) {
    process.stdout.write(`${JSON.stringify({ mode: p.mode, model: p.model, model_source: p.modelSource, tuning: p.tuning?.file ?? null,
      sandbox: p.sandbox ? { project: p.sandbox.project, network: p.sandbox.network, writable: p.sandbox.writable, hidden: p.sandbox.hidden.length, config: p.sandbox.config } : 'off',
      privacy: Object.fromEntries(Object.keys(privacyEnv(p)).map((k) => [k, runEnv[k]])),
      research: Object.fromEntries(RESEARCH_ENV.filter((k) => runEnv[k]).map((k) => [k, runEnv[k]])), command }, null, 2)}\n`);
    return 0;
  }
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: runEnv });
  // Pi handles its own signals. A terminal sends Ctrl+C to the whole process group, so Pi already has it; any other
  // signal (kill, a closed terminal, a supervisor stopping mina) is passed on so Pi never outlives the launcher.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { if (sig !== 'SIGINT' || !process.stdin.isTTY) child.kill(sig); });
  return new Promise((done) => child.on('exit', (code, signal) => {
    if (host?.dir) rmSync(host.dir, { recursive: true, force: true }); // the broker ends the session when this process exits
    if (instance) {
      try { writeInstance(instance, { status: 'launcher_exited', observedAt: new Date().toISOString(), observation: inspectInstance(instance) }); }
      catch { writeInstance(instance, { status: 'exit_unverified', observedAt: new Date().toISOString() }); }
    }
    done(code ?? (signal ? 128 : 1));
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write(`mina: ${e.stack ?? e.message}\n`); process.exit(1); });
}
