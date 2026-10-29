import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const source = '../node_modules/pi-claude-subscription/src/';
const { resolveConfig } = await jiti.import(source + 'config.ts');
const { childEnv } = await jiti.import(source + 'session.ts');
const { projectDir, sessionFile, findMessageUuid, synthesizeSession } = await jiti.import(source + 'cc-sessions.ts');
const { forkPersistedSession } = await jiti.import(source + 'fork-session.ts');
const { AnchorRegistry } = await jiti.import(source + 'anchors.ts');
const { ClaudeSdkProvider } = await jiti.import(source + 'provider.ts');
const { AsyncQueue } = await jiti.import(source + 'util.ts');
const { default: extension } = await jiti.import(source + 'index.ts');
const { createInitialSystemMessage } = await import('@earendil-works/pi-ai');

const user = (text) => ({ role: 'user', content: text, timestamp: 1 });
const model = (provider) => ({ provider, id: 'claude-opus-5-5', api: 'claude-agent-sdk', maxTokens: 1024,
  reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const assistant = { role: 'assistant', provider: 'other', api: 'anthropic-messages', model: 'claude-opus-5-5',
  content: [{ type: 'text', text: 'old reply' }], stopReason: 'stop', timestamp: 2 };
const history = [user('hello'), assistant];
const profiles = (root) => ['work', 'home'].map((id) => ({ id, name: id === 'work' ? 'Work' : 'Home', configDir: join(root, id) }));

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'mina-claude-profiles-'));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('profiles come only from owner configuration, validate strictly, and preserve harmless project tuning', () => fixture(async (root) => {
  const agentDir = join(root, 'agent'), cwd = join(root, 'project');
  mkdirSync(agentDir); mkdirSync(join(cwd, '.pi'), { recursive: true });
  const file = join(agentDir, 'claude-sdk.json');
  writeFileSync(file, JSON.stringify({ profiles: profiles(root), maxSessions: 2 }));
  writeFileSync(join(cwd, '.pi/claude-sdk.json'), JSON.stringify({ profiles: [{ id: 'evil', configDir: '/evil' }], maxSessions: 4 }));
  const config = resolveConfig({ cwd, agentDir, env: {} });
  assert.deepEqual(config.profiles, profiles(root));
  assert.equal(config.maxSessions, 4);
  for (const value of [{}, [profiles(root)[0], profiles(root)[0]], [{ id: 'home', name: 'Home', configDir: 'relative' }]]) {
    writeFileSync(file, JSON.stringify({ profiles: value }));
    assert.throws(() => resolveConfig({ cwd, agentDir, env: {} }), /claude-sdk.json:/);
  }
  writeFileSync(file, '{}');
  assert.deepEqual(resolveConfig({ cwd, agentDir, env: {} }).profiles, []);
}));

test('each child gets an immutable account environment, without inherited token or billing overrides', () => {
  const base = { ...process.env, CLAUDE_CONFIG_DIR: '/wrong', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/wrong',
    CLAUDE_CODE_OAUTH_TOKEN: 'not-a-secret', ANTHROPIC_API_KEY: 'not-a-secret', ANTHROPIC_AUTH_TOKEN: 'not-a-secret',
    ANTHROPIC_OAUTH_TOKEN: 'not-a-secret', ANTHROPIC_BASE_URL: 'https://wrong', CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'not-a-secret', CLAUDE_CODE_HOST_SESSION_ID: 'other-account',
    CLAUDE_CODE_HOST_CREDS_FILE: '/wrong', CLAUDE_SESSION_INGRESS_TOKEN_FILE: '/wrong',
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'not-a-secret', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    ANTHROPIC_IDENTITY_TOKEN_FILE: '/wrong', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: wrong',
    CLAUDE_CODE_API_BASE_URL: 'https://wrong', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1' };
  const saved = { ...base };
  const work = childEnv(base, { configDir: '/work' }), home = childEnv(base, { configDir: '/home' });
  assert.equal(work.CLAUDE_CONFIG_DIR, '/work'); assert.equal(home.CLAUDE_CONFIG_DIR, '/home');
  assert.equal(home.CLAUDE_SECURESTORAGE_CONFIG_DIR, '/home');
  for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
    'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_API_BASE_URL', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH']) {
    assert.equal(home[key], undefined, key); assert.equal(work[key], undefined, key);
  }
  assert.deepEqual(base, saved);
  assert.equal(childEnv(base, {}).CLAUDE_CODE_SESSION_ACCESS_TOKEN, 'not-a-secret', 'legacy provider behavior stays unchanged');
  assert.equal(childEnv(base, {}).CLAUDE_CODE_HOST_SESSION_ID, 'other-account');
});

test('every Claude child runs with telemetry, error reporting, updates and claude.ai connectors off, and no inherited exporter', () => {
  const base = { PATH: '/usr/bin', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example', OTEL_METRICS_EXPORTER: 'otlp',
    ANT_OTEL_X: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '1', BETA_TRACING_ENDPOINT: 'https://trace.example', DISABLE_TELEMETRY: '0' };
  for (const spec of [{}, { configDir: '/work' }]) {
    const env = childEnv(base, spec);
    for (const key of ['DISABLE_TELEMETRY', 'DO_NOT_TRACK', 'DISABLE_ERROR_REPORTING', 'DISABLE_AUTOUPDATER', 'DISABLE_UPDATES',
      'DISABLE_BUG_COMMAND', 'DISABLE_FEEDBACK_COMMAND', 'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY']) assert.equal(env[key], '1', key);
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    for (const key of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_METRICS_EXPORTER', 'ANT_OTEL_X', 'CLAUDE_CODE_ENABLE_TELEMETRY', 'BETA_TRACING_ENDPOINT']) assert.equal(env[key], undefined, key);
    assert.equal(env.PATH, '/usr/bin');
  }
});

test('transcript lookup, synthesis, real SDK forks and anchors stay in their account directories', () => fixture(async (root) => {
  const [work, home] = profiles(root).map((p) => p.configDir);
  const first = synthesizeSession(root, 'claude-opus-5-5', history, work);
  const second = synthesizeSession(root, 'claude-opus-5-5', history, home);
  const file = sessionFile(root, first.sessionId, work);
  assert.ok(file.startsWith(work));
  assert.equal(sessionFile(root, first.sessionId, home), undefined);
  assert.ok(sessionFile(root, second.sessionId, home).startsWith(home));
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const messageId = rows.at(-1).message.id;
  assert.equal(findMessageUuid(root, first.sessionId, messageId, work), first.at);
  assert.equal(findMessageUuid(root, first.sessionId, messageId, home), undefined);
  const before = process.env.CLAUDE_CONFIG_DIR;
  const forks = await Promise.all([
    forkPersistedSession(first.sessionId, root, first.at, work),
    forkPersistedSession(second.sessionId, root, second.at, home),
  ]);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, before);
  assert.ok(sessionFile(root, forks[0].sessionId, work));
  assert.equal(sessionFile(root, forks[0].sessionId, home), undefined);
  assert.ok(sessionFile(root, forks[1].sessionId, home));
  const a = new AnchorRegistry(join(root, 'anchors-work.jsonl'));
  const b = new AnchorRegistry(join(root, 'anchors-home.jsonl'));
  a.put('identical-chain', { sessionId: first.sessionId, cwd: root, messageId });
  assert.equal(b.get('identical-chain'), undefined);
  b.put('identical-chain', { sessionId: second.sessionId, cwd: root, messageId });
  assert.equal(a.get('identical-chain').sessionId, first.sessionId);
  assert.equal(b.get('identical-chain').sessionId, second.sessionId);
}));

function fakeSession(spec, chain, count) {
  const events = new AsyncQueue();
  let resolveExit;
  const session = { spec, chain, count, systemPrompt: spec.systemPrompt, model: spec.model, sessionId: spec.resume?.sessionId ?? randomUUID(),
    busy: false, dead: false, lastUsed: Date.now(), awaiting: new Set(), servedByClaude: new Set(), events,
    exited: new Promise((r) => { resolveExit = r; }), stderr: '', entryUuid: async () => randomUUID(),
    setModel: async (m) => { session.model = m; }, deliver() {}, interrupt: async () => {},
    close() { session.dead = true; events.close(); resolveExit(); },
    send() {
      const messageId = randomUUID();
      for (const event of [
        { type: 'message_start', message: { id: messageId, model: spec.model, usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: spec.configDir } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
        { type: 'message_stop' },
      ]) events.push({ type: 'stream_event', event });
      events.push({ type: 'result', subtype: 'success' });
    } };
  return session;
}

test('overlapping account requests and restarts use separate session pools and persistence', () => fixture(async (root) => {
  const configs = profiles(root), made = [], instances = [];
  const before = process.env.CLAUDE_CONFIG_DIR;
  const context = { messages: [createInitialSystemMessage('test', [{ name: 'read', description: 'read', parameters: { type: 'object', properties: {} } }]), ...history, user('next')] };
  try {
    const request = async (config) => {
      const provider = new ClaudeSdkProvider({ configDir: config.configDir, cwd: () => root,
        registry: new AnchorRegistry(join(root, config.id + '-anchors.jsonl')),
        createSession: (spec, chain, count) => { made.push(spec); return fakeSession(spec, chain, count); } });
      instances.push(provider);
      const result = await provider.streamSimple(model('claude-sdk-' + config.id), context).result();
      assert.equal(result.stopReason, 'stop', result.errorMessage);
      assert.equal(result.content[0].text, config.configDir);
      assert.equal(provider.lastRoute, 'synth');
      assert.ok(sessionFile(root, made.find((s) => s.configDir === config.configDir).resume.sessionId, config.configDir));
      return result;
    };
    const results = await Promise.all(configs.map(request));
    assert.notEqual(made[0].resume.sessionId, made[1].resume.sessionId);
    assert.equal(process.env.CLAUDE_CONFIG_DIR, before);
    // The same account can reuse its process after another account answers.
    const continuation = { messages: [...context.messages, results[0], user('again')] };
    const result = await instances[0].streamSimple(model('claude-sdk-work'), continuation).result();
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(instances[0].lastRoute, 'live');
    assert.equal(made.length, 2);
    for (const [i, config] of configs.entries()) {
      const original = made[i].resume.sessionId;
      instances[i].shutdown();
      let forkSource;
      const restarted = new ClaudeSdkProvider({ configDir: config.configDir, cwd: () => root,
        registry: new AnchorRegistry(join(root, config.id + '-anchors.jsonl')),
        forkSession: async (id) => { forkSource = id; return { sessionId: randomUUID() }; },
        createSession: fakeSession });
      instances.push(restarted);
      const next = await restarted.streamSimple(model('claude-sdk-' + config.id), {
        messages: [...context.messages, results[i], user('after restart')],
      }).result();
      assert.equal(next.stopReason, 'stop', next.errorMessage);
      assert.equal(restarted.lastRoute, 'resume');
      assert.equal(forkSource, original);
    }
  } finally { for (const p of instances) p.shutdown(); }
}));

test('the extension registers labeled providers while preserving the original route and Claude prompt', () => fixture(async (root) => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  const savedCwd = process.cwd();
  process.env.PI_CODING_AGENT_DIR = root;
  process.chdir(root);
  writeFileSync(join(root, 'claude-sdk.json'), JSON.stringify({ profiles: profiles(root) }));
  const providers = new Map(), handlers = {};
  try {
    extension({ registerProvider: (id, config) => providers.set(id, config), on: (event, fn) => { handlers[event] = fn; } });
    assert.deepEqual([...providers.keys()], ['claude-sdk', 'claude-sdk-work', 'claude-sdk-home']);
    assert.match(providers.get('claude-sdk-home').models[0].name, /\[Home\]$/);
    assert.match(providers.get('claude-sdk-work').models[0].name, /\[Work\]$/);
    assert.notEqual(providers.get('claude-sdk-home').streamSimple, providers.get('claude-sdk-work').streamSimple);
    assert.ok(!providers.get('claude-sdk').models[0].name.includes('[Work]'));
    const event = { systemPromptOptions: { selectedTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [] } };
    handlers.before_agent_start(event, { model: { provider: 'claude-sdk-home' } });
    assert.match(event.systemPromptOptions.customPrompt, /^You are Claude/);
    const own = { systemPromptOptions: { customPrompt: 'owner prompt' } };
    handlers.before_agent_start(own, { model: { provider: 'claude-sdk-work' } });
    assert.equal(own.systemPromptOptions.customPrompt, 'owner prompt');
  } finally {
    handlers.session_shutdown?.(); process.chdir(savedCwd);
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
  }
}));
