import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, startingModel, resolveModel, researchEnv, layerEnv, tuningFor, privacyEnv, REPO } from '../bin/mina.mjs';
import { readModelTuning, tuningPath, userModelsDir, REPO_MODELS_DIR } from '../lib/model-tuning.mjs';
import { thresholds } from '../extensions/handoff/policy.mjs';
import { bwrapAvailable } from '../sandbox/sandbox.mjs';
import { readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// A user tuning folder (MINA_MODELS_DIR) with one local model, as a user would keep it outside the repository: a small
// shared KV pool, so mina starts it in --fast mode with its own hot-compact window.
const MODELS = mkdtempSync(join(tmpdir(), 'mina-models-'));
const LOCAL = { model: 'local/test-model', context_window: 131072, default_mode: 'fast', compact_at_tokens: 60000, handoff_at_tokens: 90000,
  hot_compact: { startPercent: 35, hardPercent: 58 } };
writeFileSync(join(MODELS, 'local__test-model.json'), JSON.stringify(LOCAL));
const agent = (settings, { models = MODELS } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'mina-agent-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  return { PI_CODING_AGENT_DIR: dir, MINA_MODELS_DIR: models };
};
const codex = agent({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol' });

test('the real launcher refuses the default broker state as a read or write root', () => {
  const root = mkdtempSync(join(tmpdir(), 'mina-private-broker-'));
  const home = join(root, 'home'), cwd = join(root, 'project');
  const state = join(home, '.local/state/mina/hostd');
  mkdirSync(state, { recursive: true }); mkdirSync(cwd);
  writeFileSync(join(state, 'sessions.json'), '{}');
  const env = { ...process.env, HOME: home, MINA_HOST: '0', PI_CODING_AGENT_DIR: join(home, '.pi/agent'),
    XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data') };
  delete env.MINA_HOST_STATE;
  try {
    for (const kind of ['read', 'write']) {
      const out = spawnSync(process.execPath, [join(REPO, 'bin/mina.mjs'), `--sandbox-${kind}`, state, '--help'], { cwd, env, encoding: 'utf8', timeout: 15_000 });
      assert.notEqual(out.status, 0, out.stdout);
      assert.match(out.stderr, /overlaps (private controller state|trusted runtime\/state)/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('full mode loads explicit trusted layers and keeps the research skill' , () => {
  const p = plan(['--full', 'hello'], codex);
  assert.equal(p.mode, 'full');
  assert.ok(p.args.includes('--no-extensions') && p.args.includes('--no-approve') && p.args.includes('--no-context-files'));
  assert.deepEqual(p.args.filter((a, i) => p.args[i - 1] === '-e'), [join(REPO, 'extensions/identity'), join(REPO, 'extensions/sandbox'), join(REPO, 'extensions/host'), join(REPO, 'extensions/codex-usage'), join(REPO, 'extensions/footer'), join(REPO, 'node_modules/pi-claude-subscription'), join(REPO, 'extensions/goal'), join(REPO, 'extensions/compact'), join(REPO, 'extensions/delegates'), join(REPO, 'extensions/handoff'), join(REPO, 'adapters/pi-research-search'), join(REPO, 'extensions/literature')]);
  assert.ok(p.args.includes('--skill'));
  assert.equal(p.args.at(-1), 'hello');
});

test('mina loads the live compaction adapter and marks only its generated settings as managed', () => {
  const env = { ...codex, XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), 'mina-cache-')) };
  const p = plan(['--full'], env);
  assert.ok(p.args.includes(join(REPO, 'extensions/compact')));
  assert.equal(layerEnv(p, env).MINA_HOT_COMPACT_MANAGED, '1');
  const explicit = layerEnv(p, { ...env, PI_HOT_COMPACT_CONFIG: '/user/config.json' });
  assert.equal(explicit.PI_HOT_COMPACT_CONFIG, undefined);
  assert.equal(explicit.MINA_HOT_COMPACT_MANAGED, undefined);
});

test('the tuning file chooses the default mode; a flag overrides it', () => {
  const local = plan(['--model', 'local/test-model'], codex);
  assert.equal(local.mode, 'fast');
  assert.ok(local.args.includes('--no-extensions') && local.args.includes('--no-context-files') && local.args.includes('-e'));
  assert.equal(plan(['--full', '--model', 'local/test-model'], codex).mode, 'full');
  assert.ok(!plan(['--full', '--model', 'local/test-model'], codex).args.includes('--full'));
});

test('sandboxed full mode keeps its own trusted Codex usage layer' , () => {
  const env = agent({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol' });
  mkdirSync(join(env.PI_CODING_AGENT_DIR, 'extensions', 'codex-usage'), { recursive: true });
  const p = plan(['--full'], env);
  assert.ok(!p.skipped.includes('codex-usage') && p.args.includes(join(REPO, 'extensions/codex-usage')));
  // --fast and --lean turn Pi's discovery off, so mina keeps its own
  assert.ok(plan(['--lean'], env).args.includes(join(REPO, 'extensions/codex-usage')));
});

test('lean mode keeps /goal and drops the research layers and skills', () => {
  const p = plan(['--lean'], codex);
  assert.ok(p.args.includes('--no-skills') && !p.args.includes('--skill'));
  assert.deepEqual(p.args.filter((a, i) => p.args[i - 1] === '-e'), [join(REPO, 'extensions/identity'), join(REPO, 'extensions/sandbox'), join(REPO, 'extensions/host'), join(REPO, 'extensions/codex-usage'), join(REPO, 'extensions/footer'), join(REPO, 'node_modules/pi-claude-subscription'), join(REPO, 'extensions/goal'), join(REPO, 'extensions/compact'), join(REPO, 'extensions/delegates'), join(REPO, 'extensions/handoff')]);
});

test('Claude through the Agent SDK: pinned claude-sdk layer, full mode, capped default thresholds', () => {
  const p = plan(['--model', 'claude-sdk/claude-opus-5-5'], codex);
  assert.equal(p.mode, 'full');
  assert.ok(p.args.includes(join(REPO, 'node_modules/pi-claude-subscription')));
  assert.deepEqual(thresholds(p.tuning), { compactAt: 250000, handoffAt: 350000, maxCompactions: 2 }); // capped defaults
  assert.equal(p.tuning.context_window, 1000000);
  // Unsandboxed full mode discovers the user's own installed copy: one claude-sdk provider, not two.
  const own = agent({ defaultProvider: 'claude-sdk', defaultModel: 'claude-opus-5-5', packages: ['npm:pi-claude-subscription'] });
  const plain = plan(['--full', '--nosandbox'], own);
  assert.ok(plain.skipped.includes('claude-sdk') && !plain.args.includes(join(REPO, 'node_modules/pi-claude-subscription')));
  // The sandbox never discovers packages, so it keeps its pinned copy.
  assert.ok(plan(['--full'], own).args.includes(join(REPO, 'node_modules/pi-claude-subscription')));
});

test('account aliases keep Claude tuning and the pinned shared provider layer', () => {
  for (const id of ['work', 'home']) {
    const p = plan(['--model', `claude-sdk-${id}/claude-opus-5-5`], codex);
    assert.equal(p.mode, 'full');
    assert.equal(p.tuning.model, `claude-sdk-${id}/claude-opus-5-5`);
    assert.equal(p.tuning.file, join(REPO, 'models', 'claude-sdk__claude-opus-5-5.json')); // one file for every account
    assert.equal(p.tuning.context_window, 1000000);
    assert.equal(p.tuning.goal_prompt, 'minimal');
    assert.deepEqual(thresholds(p.tuning), { compactAt: 250000, handoffAt: 350000, maxCompactions: 2 });
    assert.ok(p.args.includes(join(REPO, 'node_modules/pi-claude-subscription')));
  }
});

test('Claude account profiles share the claude-sdk tuning; a profile\'s own file replaces it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mina-tuning-'));
  try {
    writeFileSync(join(dir, 'claude-sdk__claude-haiku-5-5.json'), JSON.stringify({ model: 'claude-sdk/claude-haiku-5-5', handoff_at_tokens: 95000 }));
    assert.deepEqual(tuningFor({ provider: 'claude-sdk-work', model: 'claude-haiku-5-5' }, dir),
      { file: join(dir, 'claude-sdk__claude-haiku-5-5.json'), model: 'claude-sdk-work/claude-haiku-5-5', handoff_at_tokens: 95000 });
    writeFileSync(join(dir, 'claude-sdk-work__claude-haiku-5-5.json'), JSON.stringify({ handoff_at_tokens: 80000 }));
    assert.equal(tuningFor({ provider: 'claude-sdk-work', model: 'claude-haiku-5-5' }, dir).handoff_at_tokens, 80000);
    assert.equal(tuningFor({ provider: 'claude-sdkx', model: 'claude-haiku-5-5' }, dir), null);
    assert.equal(readModelTuning('claude-sdk-work__claude-haiku-5-5.json', { env: { MINA_MODELS_DIR: join(dir, 'none') } }).model, 'claude-sdk-work/claude-haiku-5-5');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tuning files: the user folder (MINA_MODELS_DIR, else ~/.config/mina/models) first, then the repository models/', () => {
  const home = mkdtempSync(join(tmpdir(), 'mina-home-'));
  const user = mkdtempSync(join(tmpdir(), 'mina-user-models-'));
  try {
    assert.equal(userModelsDir({}, home), join(home, '.config', 'mina', 'models'));
    assert.equal(userModelsDir({ MINA_MODELS_DIR: user }, home), user);
    // Nothing in the user folder: the repository's file.
    const dirs = [user, REPO_MODELS_DIR];
    assert.equal(tuningPath('claude-sdk', 'claude-opus-5-5', dirs), join(REPO_MODELS_DIR, 'claude-sdk__claude-opus-5-5.json'));
    // The user's file replaces the repository's, also for a Claude account profile, also for the extensions' reader.
    writeFileSync(join(user, 'claude-sdk__claude-opus-5-5.json'), JSON.stringify({ context_window: 1000000, compact_at_tokens: 123000 }));
    assert.equal(tuningPath('claude-sdk', 'claude-opus-5-5', dirs), join(user, 'claude-sdk__claude-opus-5-5.json'));
    assert.equal(tuningPath('claude-sdk-work', 'claude-opus-5-5', dirs), join(user, 'claude-sdk__claude-opus-5-5.json'));
    assert.equal(readModelTuning('claude-sdk-work__claude-opus-5-5.json', { env: { MINA_MODELS_DIR: user } }).compact_at_tokens, 123000);
    const p = plan(['--model', 'claude-sdk/claude-opus-5-5'], { ...codex, MINA_MODELS_DIR: user });
    assert.equal(p.tuning.file, join(user, 'claude-sdk__claude-opus-5-5.json'));
    assert.equal(p.tuning.compact_at_tokens, 123000);
    // A profile's own file in the repository folder still beats the shared file in the user folder.
    const repoLike = mkdtempSync(join(tmpdir(), 'mina-repo-models-'));
    writeFileSync(join(repoLike, 'claude-sdk-work__claude-opus-5-5.json'), JSON.stringify({ compact_at_tokens: 1 }));
    assert.equal(tuningPath('claude-sdk-work', 'claude-opus-5-5', [user, repoLike]), join(repoLike, 'claude-sdk-work__claude-opus-5-5.json'));
    rmSync(repoLike, { recursive: true, force: true });
    // A model without a file anywhere has no tuning.
    assert.equal(plan(['--model', 'x/unknown'], { ...codex, MINA_MODELS_DIR: user }).tuning, null);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(user, { recursive: true, force: true }); }
});

test('the real launcher refuses Claude Code\'s login state as a read or write root', () => {
  const root = mkdtempSync(join(tmpdir(), 'mina-claude-state-'));
  const home = join(root, 'home'), cwd = join(root, 'project');
  mkdirSync(join(home, '.claude'), { recursive: true }); mkdirSync(cwd);
  writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
  const env = { ...process.env, HOME: home, MINA_HOST: '0', PI_CODING_AGENT_DIR: join(home, '.pi/agent'),
    XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data') };
  try {
    for (const kind of ['read', 'write']) {
      const out = spawnSync(process.execPath, [join(REPO, 'bin/mina.mjs'), `--sandbox-${kind}`, join(home, '.claude'), '--help'], { cwd, env, encoding: 'utf8', timeout: 15_000 });
      assert.notEqual(out.status, 0, `${kind}: ${out.stdout}`);
      assert.match(out.stderr, /overlaps (private controller state|trusted runtime\/state)/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('sandboxed goals do not inherit a configured replacement package' , () => {
  const env = agent({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol', packages: ['npm:@narumitw/pi-goal@0.54.8'] });
  const p = plan(['--full'], env);
  assert.deepEqual(p.skipped, []);
  // --fast and --lean turn Pi's discovery off, so the user's copy would not load: mina keeps its own
  assert.deepEqual(plan(['--fast'], env).skipped, []);
  assert.ok(p.args.includes(join(REPO, 'extensions/goal')));
  assert.deepEqual(plan([], agent({ packages: ['npm:pi-goal-tracker'] })).skipped, []);
});

test('model resolution: provider/id, a thinking suffix, --provider, the settings default', () => {
  assert.deepEqual(startingModel(['--model', 'local/test-model:high'], codex), { provider: 'local', model: 'test-model' });
  assert.deepEqual(startingModel(['--provider', 'x', '--model', 'y'], codex), { provider: 'x', model: 'y' });
  assert.deepEqual(startingModel(['--provider', 'x'], codex), { provider: 'x', model: 'gpt-6.1-sol' });
});

test('without --model, mina starts on MINA_MODEL, else on Pi\'s settings default; there is no built-in default', () => {
  assert.deepEqual(resolveModel([], codex), { provider: 'openai-codex', model: 'gpt-6.1-sol', source: 'pi-settings' });
  assert.deepEqual(resolveModel([], { ...codex, MINA_MODEL: 'local/test-model' }), { provider: 'local', model: 'test-model', source: 'MINA_MODEL' });
  assert.deepEqual(resolveModel(['--model', 'claude-sdk/claude-opus-5-5'], { ...codex, MINA_MODEL: 'local/test-model' }),
    { provider: 'claude-sdk', model: 'claude-opus-5-5', source: 'flag' });
  assert.deepEqual(resolveModel(['--provider', 'x'], { ...codex, MINA_MODEL: 'local/test-model' }), { provider: 'x', model: 'gpt-6.1-sol', source: 'flag' });
  assert.deepEqual(resolveModel([], agent({})), { provider: null, model: null, source: 'none' });
  // The settings default: Pi chooses it itself, mina only reads it for the tuning.
  const p = plan(['hi'], codex);
  assert.equal(p.modelSource, 'pi-settings'); assert.equal(p.mode, 'full');
  assert.match(p.tuning.file, /openai-codex__gpt-6\.1-sol\.json$/);
  assert.ok(!p.args.includes('--model'));
  // MINA_MODEL is passed to Pi explicitly and brings its tuning.
  const m = plan(['hi'], { ...codex, MINA_MODEL: 'local/test-model' });
  assert.equal(m.modelSource, 'MINA_MODEL'); assert.equal(m.mode, 'fast'); assert.equal(m.tuning.file, join(MODELS, 'local__test-model.json'));
  assert.deepEqual(m.args.slice(m.args.indexOf('--model'), m.args.indexOf('--model') + 2), ['--model', 'local/test-model']);
  assert.equal(plan(['--model', 'openai-codex/gpt-6.1-sol'], { ...codex, MINA_MODEL: 'local/test-model' }).args.filter((a) => a === '--model').length, 1);
  assert.ok(!plan(['--continue'], { ...codex, MINA_MODEL: 'local/test-model' }).args.includes('--model'));
  assert.ok(!plan(['--provider', 'x'], codex).args.includes('--model'));
  // Nothing configured: no --model, no tuning, Pi decides.
  const none = plan(['hi'], agent({}));
  assert.equal(none.modelSource, 'none'); assert.equal(none.tuning, null); assert.equal(none.mode, 'full'); assert.ok(!none.args.includes('--model'));
});

test('research settings passed to Pi: MINA_EXA_KEYLESS when set, nothing else', () => {
  assert.deepEqual(researchEnv({ MINA_EXA_KEYLESS: '1', EXA_API_KEY: 'secret', RESEARCH_EMAIL: 'lab@example.org' }), { MINA_EXA_KEYLESS: '1' });
  assert.deepEqual(researchEnv({ MINA_EXA_KEYLESS: '' }), {});
});

test('dry run: the model and where it came from', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-dry-'));
  try {
    const run = (extra, args = ['--mina-dry-run', '--nosandbox', '-p', 'hi']) => {
      const out = spawnSync(process.execPath, [join(REPO, 'bin/mina.mjs'), ...args], { cwd, env: { ...process.env, ...codex, MINA_CWD: cwd, MINA_MODEL: '', ...extra }, encoding: 'utf8', timeout: 15_000 });
      assert.equal(out.status, 0, out.stderr);
      return JSON.parse(out.stdout);
    };
    const settingsDefault = run({});
    assert.deepEqual([settingsDefault.model, settingsDefault.model_source], [{ provider: 'openai-codex', model: 'gpt-6.1-sol' }, 'pi-settings']);
    const env = run({ MINA_MODEL: 'local/test-model' });
    assert.deepEqual([env.model, env.model_source, env.tuning, env.mode], [{ provider: 'local', model: 'test-model' }, 'MINA_MODEL', join(MODELS, 'local__test-model.json'), 'fast']);
    const flag = run({ MINA_MODEL: 'local/test-model' }, ['--mina-dry-run', '--nosandbox', '--model', 'claude-sdk/claude-opus-5-5', '-p', 'hi']);
    assert.deepEqual([flag.model.provider, flag.model_source], ['claude-sdk', 'flag']);
    // MINA_EXA_KEYLESS (keyless Exa, opt-in) reaches Pi when the user sets it, in and outside the sandbox.
    assert.deepEqual(settingsDefault.research, {});
    assert.deepEqual(run({ MINA_EXA_KEYLESS: '1' }).research, { MINA_EXA_KEYLESS: '1' });
    if (bwrapAvailable()) assert.deepEqual(run({ MINA_EXA_KEYLESS: '1', MINA_HOST: '0' }, ['--mina-dry-run', '-p', 'hi']).research, { MINA_EXA_KEYLESS: '1' });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Pi subcommands pass through unchanged', () => {
  assert.deepEqual(plan(['install', 'npm:foo'], codex), { args: ['install', 'npm:foo'], mode: null, tuning: null, dryRun: false, passthrough: true });
});

test('the sandbox is on by default; --nosandbox and MINA_SANDBOX=0 turn it off; its flags do not reach Pi', () => {
  const p = plan(['--sandbox-write', '/data/out', '--sandbox-net', 'offline', 'hi'], codex);
  assert.equal(p.sandbox.network, 'offline'); assert.ok(p.sandbox.writable.includes('/data/out'));
  assert.ok(!p.args.includes('--sandbox-write') && !p.args.includes('/data/out') && !p.args.includes('--sandbox-net'));
  const env = layerEnv(p, { ...codex, XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), 'mina-cache-')) });
  assert.equal(env.MINA_SANDBOX, '1'); assert.equal(env.MINA_SANDBOX_NET, 'offline');
  const off = plan(['--nosandbox'], codex);
  assert.equal(off.sandbox, null); assert.ok(!off.args.includes(join(REPO, 'extensions/sandbox')) && !off.args.includes('--nosandbox'));
  assert.equal(plan([], { ...codex, MINA_SANDBOX: '0' }).sandbox, null);
  assert.throws(() => plan(['--sandbox-net', 'wide'], codex), /must be one of/);
});

test('the literature extension gives the five pic tools, and literature_db refuses writes before any call', async () => {
  const { createMinaLiteratureTools } = await import('../extensions/literature/index.js');
  let calls = 0;
  const broker = { providers: async () => { calls++; return {}; } };
  const tools = createMinaLiteratureTools(broker);
  assert.deepEqual(tools.map((t) => t.name), ['literature_search', 'paper_resolve', 'paper_get', 'citation_expand', 'literature_db']);
  const db = tools.find((t) => t.name === 'literature_db');
  await assert.rejects(db.execute('x', { server: 'semantic_scholar', tool: 'create_project', args: {} }), /not an allowed read-only operation/);
  assert.equal(calls, 0);
});

test('layer environment: the tuning file, and hot-compact settings that keep the user file and start at compact_at', () => {
  const env = agent({ defaultProvider: 'local', defaultModel: 'test-model' });
  writeFileSync(join(env.PI_CODING_AGENT_DIR, 'hot-compact.json'), JSON.stringify({ semantic: false }));
  const cache = mkdtempSync(join(tmpdir(), 'mina-cache-'));
  const p = plan([], env);
  const out = layerEnv(p, { ...env, XDG_CACHE_HOME: cache });
  assert.equal(out.MINA_TUNING_FILE, join(MODELS, 'local__test-model.json'));
  const cfg = JSON.parse(readFileSync(out.PI_HOT_COMPACT_CONFIG, 'utf8'));
  // the model's tuning sets the window itself (35% to 58%, wider than the default 46% to 57%)
  assert.equal(cfg.semantic, false); assert.equal(cfg.startPercent, 35); assert.equal(cfg.hardPercent, 58);
  assert.equal(layerEnv(p, { ...env, XDG_CACHE_HOME: cache, MINA_TUNING_FILE: '/x.json' }).MINA_TUNING_FILE, undefined);
});

test('MINA_TUNING_FILE replaces the model tuning for hot-compact too', () => {
  const env = agent({ defaultProvider: 'local', defaultModel: 'test-model' });
  const file = join(env.PI_CODING_AGENT_DIR, 'test-tuning.json');
  writeFileSync(file, JSON.stringify({ context_window: 131072, compact_at_tokens: 39322, handoff_at_tokens: 60000, default_mode: 'lean' }));
  const cache = mkdtempSync(join(tmpdir(), 'mina-cache-'));
  const p = plan([], { ...env, MINA_TUNING_FILE: file });
  assert.equal(p.mode, 'lean');
  const out = layerEnv(p, { ...env, MINA_TUNING_FILE: file, XDG_CACHE_HOME: cache });
  assert.equal(JSON.parse(readFileSync(out.PI_HOT_COMPACT_CONFIG, 'utf8')).startPercent, 30);
});

test('project configuration cannot replace the trusted research stack' , () => {
  const proj = mkdtempSync(join(tmpdir(), 'mina-proj-'));
  mkdirSync(join(proj, '.pi'));
  writeFileSync(join(proj, '.pi', 'settings.json'), JSON.stringify({ extensions: ['../adapters/pi-research-search', '../adapters/pi-literature-broker'] }));
  const p = plan(['--full'], { ...codex, MINA_CWD: proj });
  assert.deepEqual(p.skipped, []);
  assert.ok(p.args.includes(join(REPO, 'adapters/pi-research-search')) && p.args.includes(join(REPO, 'extensions/literature')));
  assert.ok(p.args.includes(join(REPO, 'extensions/goal')));
  assert.deepEqual(plan(['--fast'], { ...codex, MINA_CWD: proj }).skipped, []);
});

test("the research key folder: PI_RESEARCH_KEYS_DIR, else the repository's keys/, else ~/.config/mina/keys; never overrides the user", () => {
  // The search adapter alone looks only in <repo>/keys: keys kept in the user folder went unused (Brave "not
  // configured", Exa keyless) until the launcher passed the folder.
  const p = plan(['hi'], codex);
  const home = mkdtempSync(join(tmpdir(), 'mina-home-'));
  const cache = mkdtempSync(join(tmpdir(), 'mina-cache-'));
  assert.equal(layerEnv(p, { ...codex, XDG_CACHE_HOME: cache }, { home, repoKeys: join(home, 'none') }).PI_RESEARCH_KEYS_DIR, undefined);
  mkdirSync(join(home, '.config', 'mina', 'keys'), { recursive: true });
  assert.equal(layerEnv(p, { ...codex, XDG_CACHE_HOME: cache }, { home, repoKeys: join(home, 'none') }).PI_RESEARCH_KEYS_DIR, join(home, '.config', 'mina', 'keys'));
  mkdirSync(join(home, 'mina-keys'));
  assert.equal(layerEnv(p, { ...codex, XDG_CACHE_HOME: cache }, { home, repoKeys: join(home, 'mina-keys') }).PI_RESEARCH_KEYS_DIR, join(home, 'mina-keys'));
  assert.equal(layerEnv(p, { ...codex, XDG_CACHE_HOME: cache, PI_RESEARCH_KEYS_DIR: '/mine' }, { home }).PI_RESEARCH_KEYS_DIR, undefined);  // the user's own
});

test('-c, --session and --fork take the tuning of the session they open, not of the starting model', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const agent = mkdtempSync(join(tmpdir(), 'mina-agent-'));
  const cwd = mkdtempSync(join(tmpdir(), 'mina-proj-'));
  const dir = join(agent, 'sessions', `--${cwd.replace(/^\//, '').replace(/[/\\:]/g, '-')}--`);
  mkdirSync(dir, { recursive: true });
  const session = (name, provider, modelId, t) => {
    const f = join(dir, name);
    writeFileSync(f, [{ type: 'session', version: 3, id: name, cwd, timestamp: 'x' }, { type: 'model_change', provider: 'local', modelId: 'test-model' },
      { type: 'message', message: { role: 'user', content: 'hi' } }, { type: 'model_change', provider, modelId }].map((e) => JSON.stringify(e)).join('\n') + '\n');
    utimesSync(f, t, t);
    return f;
  };
  const older = session('a.jsonl', 'local', 'test-model', 1000);
  session('b.jsonl', 'openai-codex', 'gpt-6.1-sol', 2000);                       // the most recent: what -c continues
  const env = { PI_CODING_AGENT_DIR: agent, MINA_CWD: cwd, MINA_MODELS_DIR: MODELS, MINA_MODEL: 'local/test-model' };
  const c = plan(['--full', '-c'], env);
  assert.deepEqual(c.model, { provider: 'openai-codex', model: 'gpt-6.1-sol' });
  assert.equal(c.modelSource, 'session');
  assert.match(c.tuning.file, /openai-codex__gpt-6\.1-sol\.json$/);
  assert.ok(!c.args.includes('--model'));                                        // Pi keeps the session's own model
  assert.match(plan(['--session', older], env).tuning.file, /local__test-model\.json$/);
  assert.match(plan(['-c', '--model', 'local/test-model'], { ...env, MINA_MODEL: '' }).tuning.file, /local__test-model\.json$/); // explicit wins
  const empty = mkdtempSync(join(tmpdir(), 'mina-proj-'));
  const fresh = plan(['-c'], { ...env, MINA_CWD: empty });
  assert.equal(fresh.model.model, 'test-model'); assert.equal(fresh.modelSource, 'MINA_MODEL'); // no session: the starting model
});

test('a resumed session takes the model that last answered: Pi 1.3 records -c --model only on assistant messages', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const agent = mkdtempSync(join(tmpdir(), 'mina-agent-'));
  const cwd = mkdtempSync(join(tmpdir(), 'mina-proj-'));
  const dir = join(agent, 'sessions', `--${cwd.replace(/^\//, '').replace(/[/\\:]/g, '-')}--`);
  mkdirSync(dir, { recursive: true });
  // Codex selected at the start, Claude answering after `mina -c --model claude-sdk/...`.
  writeFileSync(join(dir, 's.jsonl'), [{ type: 'session', version: 3, id: 's', cwd, timestamp: 'x' },
    { type: 'model_change', provider: 'openai-codex', modelId: 'gpt-6.1-sol' },
    { type: 'message', message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-6.1-sol', content: [] } },
    { type: 'message', message: { role: 'user', content: 'resume' } },
    { type: 'message', message: { role: 'assistant', provider: 'claude-sdk', model: 'claude-opus-5-5', content: [] } }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const c = plan(['--full', '-c'], { PI_CODING_AGENT_DIR: agent, MINA_CWD: cwd });
  assert.deepEqual(c.model, { provider: 'claude-sdk', model: 'claude-opus-5-5' });
  assert.match(c.tuning.file, /claude-sdk__claude-opus-5-5\.json$/);
});

test('privacy: sessions run Pi offline with telemetry off; Pi subcommands keep their network but not telemetry', () => {
  const session = privacyEnv(plan(['--nosandbox', '-p', 'hi'], agent({})));
  assert.deepEqual(session, { PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', ORT_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', PI_OFFLINE: '1' });
  for (const sub of ['install', 'update']) {
    const env = privacyEnv(plan([sub, 'npm:x'], agent({})));
    assert.equal(env.PI_OFFLINE, undefined, `${sub} needs the network`);
    assert.equal(env.PI_TELEMETRY, '0'); assert.equal(env.ORT_DISABLE_TELEMETRY, '1');
  }
});

test('privacy: the environment Pi gets cannot be switched back on from the caller environment', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-privacy-'));
  try {
    // The sandboxed dry run needs bwrap installed (it is not run); without it, only the unsandboxed launch is checked.
    for (const args of [...(bwrapAvailable() ? [['--mina-dry-run', '-p', 'hi']] : []), ['--mina-dry-run', '--nosandbox', '-p', 'hi']]) {
      const env = { ...process.env, ...agent({}), PI_TELEMETRY: '1', PI_OFFLINE: '0', ORT_DISABLE_TELEMETRY: '0', MINA_CWD: cwd };
      const out = spawnSync(process.execPath, [join(REPO, 'bin/mina.mjs'), ...args], { cwd, env, encoding: 'utf8', timeout: 15_000 });
      assert.equal(out.status, 0, out.stderr);
      assert.deepEqual(JSON.parse(out.stdout).privacy, { PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', ORT_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', PI_OFFLINE: '1' }, args.join(' '));
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
