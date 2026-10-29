import { test } from 'node:test';
import assert from 'node:assert/strict';
import codexUsage, { applies, accountId, duration, format, claudeApplies, formatClaude, formatClaudeCode, claudeCodeLabels, readClaudeProfiles } from '../extensions/codex-usage/index.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = 1_792_000_000_000;
const REPLY = { rate_limit: { allowed: true, limit_reached: false,
  primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_after_seconds: 8206, reset_at: NOW / 1000 + 8160 },
  secondary_window: { used_percent: 43, limit_window_seconds: 604800, reset_after_seconds: 519720, reset_at: NOW / 1000 + 6 * 86400 + 3600 } } };
const codex = { provider: 'openai-codex', id: 'gpt-6.1-sol', baseUrl: 'https://chatgpt.com/backend-api' };
const local = { provider: 'local', id: 'test-model' };
const claude = { provider: 'anthropic', id: 'claude-opus-5-5', baseUrl: 'https://api.anthropic.com' };
const claudeSdk = { provider: 'claude-sdk', id: 'claude-opus-5-5' };
// Two account profiles, as the owner's claude-sdk.json would name them.
const PROFILES = [{ id: 'work', name: 'Work', configDir: '/home/user/.claude-work' }, { id: 'home', name: 'Home', configDir: '/home/user/.claude-home' }];
const claudeWork = { ...claudeSdk, provider: 'claude-sdk-work' };
const claudeHome = { ...claudeSdk, provider: 'claude-sdk-home' };
const registry = (oauth = true) => ({ isUsingOAuth: (m) => oauth && ['openai-codex', 'anthropic'].includes(m.provider),
  getApiKeyForProvider: async (p) => (p === 'anthropic' ? 'sk-ant-oat-test' : 'h.eyJ4IjoxfQ.s') });
// The shape of a real /api/oauth/usage reply (2026-10-16), trimmed: an active five-hour session and an inactive scoped week.
const CLAUDE_REPLY = { five_hour: { utilization: 4, resets_at: new Date(NOW + (4 * 60 + 20) * 60_000).toISOString() }, seven_day: null,
  limits: [{ kind: 'session', group: 'session', percent: 4, severity: 'normal', resets_at: new Date(NOW + (4 * 60 + 20) * 60_000).toISOString(), scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resets_at: new Date(NOW + 6 * 86400_000).toISOString(), scope: { model: null, surface: { display_name: 'Cowork' } }, is_active: false }] };

test('only Codex through OAuth applies', () => {
  assert.ok(applies(codex, registry()));
  assert.ok(!applies(codex, registry(false)));
  assert.ok(!applies(local, registry()));
  assert.ok(!applies(undefined, registry()));
});

test('format: both windows with countdowns from reset_at', () => {
  assert.equal(format(REPLY, NOW), 'Codex 5h 42% ↺2h16m · wk 43% ↺6d1h');
  assert.equal(format({ rate_limit: { ...REPLY.rate_limit, limit_reached: true } }, NOW).startsWith('Codex limit reached · 5h'), true);
  assert.equal(format({}, NOW), undefined);
  assert.equal(duration(-5), '0m');
  assert.equal(duration(59 * 60), '59m');
});

test('accountId reads the ChatGPT account claim, and tolerates a non-JWT', () => {
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })).toString('base64url');
  assert.equal(accountId(`h.${payload}.s`), 'acct-1');
  assert.equal(accountId('sk-not-a-jwt'), null);
});

test('only Claude through pi\'s own Anthropic OAuth applies; claude-sdk (Claude Code\'s login) does not', () => {
  assert.ok(claudeApplies(claude, registry()));
  assert.ok(!claudeApplies(claude, registry(false)));
  assert.ok(!claudeApplies(claudeSdk, registry()));
  assert.ok(!claudeApplies(codex, registry()));
});

test('Claude format: active limits with countdowns; inactive scoped limits hidden; old field shape still read', () => {
  assert.equal(formatClaude(CLAUDE_REPLY, NOW), 'Claude 5h 4% ↺4h20m');
  const week = { five_hour: { utilization: 31, resets_at: new Date(NOW + 90 * 60_000).toISOString() },
    seven_day: { utilization: 12, resets_at: new Date(NOW + 3 * 86400_000).toISOString() } };
  assert.equal(formatClaude(week, NOW), 'Claude 5h 31% ↺1h30m · wk 12% ↺3d0h');
  const scoped = { limits: [{ group: 'weekly', percent: 55, is_active: true, resets_at: new Date(NOW + 86400_000).toISOString(), scope: { model: { display_name: 'Opus' } } }] };
  assert.equal(formatClaude(scoped, NOW), 'Claude wk Opus 55% ↺1d0h');
  const full = { limits: [{ group: 'session', percent: 100, is_active: true, resets_at: new Date(NOW + 600_000).toISOString() }] };
  assert.equal(formatClaude(full, NOW), 'Claude limit reached · 5h 100% ↺10m');
  assert.equal(formatClaude({}, NOW), undefined);
});

function harness({ oauth = true, model = codex } = {}) {
  const handlers = {}, status = [], urls = [], headers = [], credentialReads = [];
  const pi = { on: (name, fn) => { (handlers[name] ??= []).push(fn); } };
  const fetch = async (url, init) => { urls.push(url); headers.push(init?.headers ?? {});
    return { ok: true, json: async () => (url.includes('/api/oauth/usage') ? CLAUDE_REPLY : REPLY) }; };
  codexUsage(pi, { fetch, now: () => NOW, claudeProfiles: PROFILES });
  const modelRegistry = registry(oauth);
  const getApiKey = modelRegistry.getApiKeyForProvider;
  modelRegistry.getApiKeyForProvider = async (provider) => { credentialReads.push(provider); return getApiKey(provider); };
  const ctx = { hasUI: true, model, modelRegistry, ui: { setStatus: (k, t) => status.push([k, t]) } };
  const emit = (name, event, c) => { for (const fn of handlers[name] ?? []) fn(event, c); };
  return { handlers, emit, status, urls, headers, credentialReads, ctx };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

test('a Codex OAuth session shows the limits; switching to another model clears them', async () => {
  const h = harness();
  h.emit('session_start', {}, h.ctx);
  await settle();
  assert.deepEqual(h.urls, ['https://chatgpt.com/backend-api/wham/usage']);
  assert.deepEqual(h.status.filter(([k]) => k === 'codex-usage').at(-1), ['codex-usage', 'Codex 5h 42% ↺2h16m · wk 43% ↺6d1h']);
  h.emit('model_select', { model: local, previousModel: codex }, { ...h.ctx, model: local });
  assert.deepEqual(h.status.filter(([k]) => k === 'codex-usage').at(-1), ['codex-usage', undefined]);
  h.emit('session_shutdown', {}, h.ctx);
});

test('a Claude session on pi\'s Anthropic OAuth shows its limits from the usage endpoint; claude-sdk shows and fetches nothing', async () => {
  const h = harness({ model: claude });
  h.emit('session_start', {}, h.ctx);
  await settle();
  assert.deepEqual(h.urls, ['https://api.anthropic.com/api/oauth/usage']);
  assert.equal(h.headers[0].Authorization, 'Bearer sk-ant-oat-test');
  assert.match(h.headers[0]['anthropic-beta'], /oauth-2025-04-20/);
  assert.deepEqual(h.status.filter(([k]) => k === 'claude-usage').at(-1), ['claude-usage', 'Claude 5h 4% ↺4h20m']);
  assert.ok(h.status.filter(([k]) => k === 'codex-usage').every(([, t]) => t === undefined));
  h.emit('model_select', { model: claudeSdk, previousModel: claude }, { ...h.ctx, model: claudeSdk });
  assert.deepEqual(h.status.filter(([k]) => k === 'claude-usage').at(-1), ['claude-usage', undefined]);
  h.emit('session_shutdown', {}, h.ctx);
  const sdk = harness({ model: claudeSdk });
  sdk.emit('session_start', {}, sdk.ctx);
  await settle();
  assert.deepEqual(sdk.urls, []);
  assert.ok(sdk.status.every(([, t]) => t === undefined));
});

test('nothing is fetched or shown for an API key or another provider', async () => {
  for (const h of [harness({ oauth: false }), harness({ model: local }), harness({ oauth: false, model: claude })]) {
    h.emit('session_start', {}, h.ctx);
    await settle();
    assert.deepEqual(h.urls, []);
    assert.ok(h.status.every(([, t]) => t === undefined));
  }
});

// Claude Code's rate_limit_event, as the carried pi-claude-subscription forwards it (vendor/patches). Real payloads from
// 2026-10-16: an individual plan near its weekly limit, and a team plan with only a five-hour window.
const S = NOW / 1000;
const INDIVIDUAL_PLAN = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.96, resetsAt: S + 39 * 3600,
  unifiedWindows: { five_hour: { utilization: 0.07, resetsAt: S + 4 * 3600 }, seven_day: { utilization: 0.96, resetsAt: S + 39 * 3600 } } } };
const TEAM_PLAN = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour',
  unifiedWindows: { five_hour: { utilization: 0.22, resetsAt: S + 70 * 60 } } } };

test('Claude Code format: unified windows as percentages, the single reported window otherwise, rejection marked', () => {
  assert.equal(formatClaudeCode(INDIVIDUAL_PLAN.rate_limit_info, NOW), 'Claude Code 5h 7% \u21ba4h00m \u00b7 wk 96% \u21ba1d15h');
  assert.equal(formatClaudeCode(TEAM_PLAN.rate_limit_info, NOW), 'Claude Code 5h 22% \u21ba1h10m');
  assert.equal(formatClaudeCode({ status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 0.5, resetsAt: S + 86400 }, NOW), 'Claude Code wk Opus 50% \u21ba1d0h');
  assert.equal(formatClaudeCode({ ...TEAM_PLAN.rate_limit_info, status: 'rejected' }, NOW), 'Claude Code limit reached \u00b7 5h 22% \u21ba1h10m');
  assert.equal(formatClaudeCode({ status: 'allowed' }, NOW), undefined);
});

test('a claude-sdk session shows Claude Code limits from forwarded rate-limit events only, and clears on another model', async () => {
  const h = harness({ model: claudeSdk });
  h.emit('session_start', {}, h.ctx);
  await settle();
  assert.deepEqual(h.urls, [], 'no request: the data comes from the live transport');
  assert.ok(h.status.filter(([k]) => k === 'claude-code-usage').every(([, t]) => t === undefined), 'nothing before an event arrives');
  h.emit('provider_stream_event', { type: 'provider_stream_event', provider: 'claude-sdk', model: 'claude-opus-5-5', data: { type: 'message_start' } }, h.ctx);
  h.emit('provider_stream_event', { type: 'provider_stream_event', provider: 'other', model: 'x', data: INDIVIDUAL_PLAN }, h.ctx);
  assert.ok(h.status.filter(([k]) => k === 'claude-code-usage').every(([, t]) => t === undefined), 'other events and providers are ignored');
  h.emit('provider_stream_event', { type: 'provider_stream_event', provider: 'claude-sdk', model: 'claude-opus-5-5', data: TEAM_PLAN }, h.ctx);
  assert.deepEqual(h.status.filter(([k]) => k === 'claude-code-usage').at(-1), ['claude-code-usage', 'Claude Code 5h 22% \u21ba1h10m']);
  h.emit('model_select', { model: claude, previousModel: claudeSdk }, { ...h.ctx, model: claude });
  assert.deepEqual(h.status.filter(([k]) => k === 'claude-code-usage').at(-1), ['claude-code-usage', undefined]);
  h.emit('session_shutdown', {}, h.ctx);
});

test('Claude Code account switches never borrow usage; switching back and same-account model changes reuse it', async (t) => {
  const h = harness({ model: claudeWork });
  t.after(() => h.emit('session_shutdown', {}, h.ctx));
  const last = () => h.status.filter(([k]) => k === 'claude-code-usage').at(-1)?.[1];
  const select = (model) => {
    const previousModel = h.ctx.model;
    h.ctx.model = model;
    h.emit('model_select', { model, previousModel }, h.ctx);
  };
  const rate = (provider, data) => h.emit('provider_stream_event', { provider, data }, h.ctx);
  h.emit('session_start', {}, h.ctx);
  assert.equal(last(), undefined);
  rate(claudeWork.provider, TEAM_PLAN);
  assert.equal(last(), 'Claude Work 5h 22% ↺1h10m');
  select(claudeHome);
  assert.equal(last(), undefined, 'one account\'s usage must not appear for another');
  rate(claudeHome.provider, INDIVIDUAL_PLAN);
  assert.equal(last(), 'Claude Home 5h 7% ↺4h00m · wk 96% ↺1d15h');
  select({ ...claudeHome, id: 'claude-sonnet-4-6' });
  assert.equal(last(), 'Claude Home 5h 7% ↺4h00m · wk 96% ↺1d15h');
  select(claudeWork);
  assert.equal(last(), 'Claude Work 5h 22% ↺1h10m');
  select(claudeSdk);
  assert.equal(last(), undefined, 'legacy provider has a separate cache key');
  rate(claudeSdk.provider, TEAM_PLAN);
  assert.equal(last(), 'Claude Code 5h 22% ↺1h10m');
  select(local);
  assert.equal(last(), undefined);
  select(claudeHome);
  assert.equal(last(), 'Claude Home 5h 7% ↺4h00m · wk 96% ↺1d15h');
  await settle();
  assert.deepEqual(h.urls, [], 'all account usage comes from events');
  assert.deepEqual(h.credentialReads, [], 'no account credentials are read');
});

test('concurrent late Claude Code events update only their account cache, not the selected UI', (t) => {
  const h = harness({ model: claudeWork });
  t.after(() => h.emit('session_shutdown', {}, h.ctx));
  const last = () => h.status.filter(([k]) => k === 'claude-code-usage').at(-1)?.[1];
  const workCtx = h.ctx;
  const homeCtx = { ...h.ctx, model: claudeHome };
  h.emit('session_start', {}, workCtx);
  h.emit('provider_stream_event', { provider: claudeWork.provider, data: TEAM_PLAN }, workCtx);
  h.emit('model_select', { model: claudeHome, previousModel: claudeWork }, homeCtx);
  assert.equal(last(), undefined);
  const lateWork = { ...TEAM_PLAN, rate_limit_info: { ...TEAM_PLAN.rate_limit_info,
    unifiedWindows: { five_hour: { utilization: 0.33 } } } };
  const beforeLate = h.status.length;
  h.emit('provider_stream_event', { provider: claudeWork.provider, data: lateWork }, workCtx);
  h.emit('provider_stream_event', { provider: claudeSdk.provider, data: TEAM_PLAN }, workCtx);
  assert.equal(h.status.length, beforeLate, 'non-selected events do not redraw or restore an old context');
  assert.equal(last(), undefined);
  h.emit('provider_stream_event', { provider: claudeHome.provider, data: INDIVIDUAL_PLAN }, homeCtx);
  assert.equal(last(), 'Claude Home 5h 7% ↺4h00m · wk 96% ↺1d15h');
  h.emit('model_select', { model: claudeWork, previousModel: claudeHome }, workCtx);
  assert.equal(last(), 'Claude Work 5h 33%');
  const beforeHome = h.status.length;
  h.emit('provider_stream_event', { provider: claudeHome.provider, data: { ...INDIVIDUAL_PLAN,
    rate_limit_info: { rateLimitType: 'seven_day', utilization: 0.99 } } }, homeCtx);
  assert.equal(h.status.length, beforeHome);
  assert.equal(last(), 'Claude Work 5h 33%');
  h.emit('model_select', { model: claudeHome, previousModel: claudeWork }, homeCtx);
  assert.equal(last(), 'Claude Home wk 99%');
  h.emit('model_select', { model: claudeSdk, previousModel: claudeHome }, { ...h.ctx, model: claudeSdk });
  assert.equal(last(), 'Claude Code 5h 22% ↺1h10m', 'unselected legacy events are cached independently too');
});

test('Claude Code footer accepts only claude-sdk and the exact profile provider IDs', async (t) => {
  const unknown = { ...claudeSdk, provider: 'claude-sdk-home-extra' };
  const h = harness({ model: unknown });
  t.after(() => h.emit('session_shutdown', {}, h.ctx));
  const last = () => h.status.filter(([k]) => k === 'claude-code-usage').at(-1)?.[1];
  h.emit('session_start', {}, h.ctx);
  for (const provider of ['claude-sdk-home-extra', 'claude-sdk-work-extra', 'claude-sdk-other', 'other']) {
    h.emit('provider_stream_event', { provider, data: INDIVIDUAL_PLAN }, h.ctx);
    assert.equal(last(), undefined);
  }
  h.emit('model_select', { model: claudeHome, previousModel: unknown }, { ...h.ctx, model: claudeHome });
  assert.equal(last(), undefined, 'prefix events must not populate the profile cache');
  h.emit('provider_stream_event', { provider: unknown.provider, data: INDIVIDUAL_PLAN }, h.ctx);
  assert.equal(last(), undefined);
  await settle();
  assert.deepEqual(h.urls, []);
  assert.deepEqual(h.credentialReads, []);
});

test('Claude Code labels come from the owner\'s claude-sdk.json profiles', () => {
  assert.deepEqual([...claudeCodeLabels(PROFILES)], [['claude-sdk', 'Claude Code'], ['claude-sdk-work', 'Claude Work'], ['claude-sdk-home', 'Claude Home']]);
  assert.deepEqual([...claudeCodeLabels([{ id: 'lab' }, null, { id: 'bad id', name: 'X' }])], [['claude-sdk', 'Claude Code'], ['claude-sdk-lab', 'Claude lab']]);
  assert.deepEqual([...claudeCodeLabels(null)], [['claude-sdk', 'Claude Code']]);
  const agent = mkdtempSync(join(tmpdir(), 'mina-agent-'));
  try {
    assert.deepEqual(readClaudeProfiles({ PI_CODING_AGENT_DIR: agent }), []);
    writeFileSync(join(agent, 'claude-sdk.json'), JSON.stringify({ profiles: PROFILES }));
    assert.deepEqual(readClaudeProfiles({ PI_CODING_AGENT_DIR: agent }).map((p) => p.id), ['work', 'home']);
    writeFileSync(join(agent, 'claude-sdk.json'), '{');
    assert.deepEqual(readClaudeProfiles({ PI_CODING_AGENT_DIR: agent }), []);
  } finally { rmSync(agent, { recursive: true, force: true }); }
});
