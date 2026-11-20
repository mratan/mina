import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installUsageResume, USAGE_RESUME_ENTRY, resetFromError, resetFromHeaders, codexReset, claudeReset, claudeSdkReset, usageReset } from '../extensions/goal/usage-resume.mjs';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const HOUR = 3_600_000;
const iso = (n) => new Date(n).toISOString();

test('provider reset evidence: structured errors, rounded Codex messages, Retry-After and exhausted headers', () => {
  assert.equal(resetFromError('You have hit your ChatGPT usage limit (plus plan). Try again in ~123 min.', NOW), NOW + 123 * 60_000);
  assert.equal(resetFromError('usage limit: retry after 1h30m', NOW), NOW + 90 * 60_000);
  assert.equal(resetFromError('{"error":{"resets_at":1767283200}}', NOW), 1767283200000);
  assert.equal(resetFromError('{"resets_in_seconds":7200}', NOW), NOW + 2 * HOUR);
  assert.equal(resetFromError('insufficient_quota; retry after 5h', NOW), null);
  assert.equal(resetFromError('usage limit reached', NOW), null);
  assert.equal(resetFromError('Please retry your request', NOW), null);
  assert.equal(resetFromHeaders({ status: 429, headers: { 'Retry-After': '7200' } }, NOW), NOW + 2 * HOUR);
  assert.equal(resetFromHeaders({ status: 429, headers: { 'retry-after': new Date(NOW + HOUR).toUTCString() } }, NOW), NOW + HOUR);
  assert.equal(resetFromHeaders({ status: 200, headers: { 'retry-after': '7200' } }, NOW), null);
  assert.equal(resetFromHeaders({ status: 429, headers: { 'retry-after': 'nonsense' } }, NOW), null);
  assert.equal(resetFromHeaders({ status: 429, headers: {
    'anthropic-ratelimit-tokens-remaining': '0', 'anthropic-ratelimit-tokens-reset': iso(NOW + HOUR),
    'anthropic-ratelimit-requests-remaining': '1', 'anthropic-ratelimit-requests-reset': iso(NOW + 8 * HOUR),
    'retry-after': '60',
  } }, NOW), NOW + HOUR);
  assert.equal(resetFromHeaders({ status: 429, headers: {
    'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1h30m',
  } }, NOW), NOW + 90 * 60_000);
});

test('OAuth windows: wait for all exhausted windows, not a guessed five hours or an irrelevant model', () => {
  const usage = { rate_limit: {
    primary_window: { used_percent: 100, reset_at: (NOW + HOUR) / 1000 },
    secondary_window: { used_percent: 100, reset_at: (NOW + 7 * 24 * HOUR) / 1000 },
  } };
  assert.equal(codexReset(usage, NOW), NOW + 7 * 24 * HOUR);
  usage.rate_limit.secondary_window.used_percent = 99;
  assert.equal(codexReset(usage, NOW), NOW + HOUR);
  delete usage.rate_limit.primary_window.reset_at;
  assert.equal(codexReset(usage, NOW), null);
  usage.rate_limit.primary_window.reset_after_seconds = 3600;
  assert.equal(codexReset(usage, NOW), NOW + HOUR);
  assert.equal(codexReset({ rate_limit: { primary_window: { used_percent: 3 } } }, NOW), null);
  assert.equal(claudeReset({ five_hour: { utilization: 100, resets_at: iso(NOW + HOUR) },
    seven_day_opus: { utilization: 100, resets_at: iso(NOW + 100 * HOUR) } }, { id: 'claude-sonnet-4-6' }), NOW + HOUR);
  assert.equal(claudeReset({ limits: [
    { percent: 100, resets_at: iso(NOW + HOUR), group: 'session' },
    { percent: 100, resets_at: iso(NOW + 20 * HOUR), is_active: false },
    { percent: 100, resets_at: iso(NOW + 100 * HOUR), scope: { model: { display_name: 'Opus' } } },
  ] }, { id: 'claude-sonnet-4-6' }), NOW + HOUR);
});

test('usage readers work headlessly, use the selected OAuth account, and never read SDK or API-key logins', async () => {
  const requests = [], credentials = [];
  const ctx = { hasUI: false, model: { provider: 'openai-codex', id: 'gpt-5.4', baseUrl: 'https://chatgpt.com/backend-api/codex' },
    modelRegistry: { isUsingOAuth: () => true, getApiKeyForProvider: async (p) => { credentials.push(p); return 'token'; } } };
  const fetch = async (url) => { requests.push(url); return { ok: true, json: async () => ({ rate_limit: {
    primary_window: { used_percent: 100, reset_at: (NOW + HOUR) / 1000 },
  } }) }; };
  assert.equal(await usageReset(ctx, 'usage limit', { now: NOW, fetch }), NOW + HOUR);
  assert.deepEqual(requests, ['https://chatgpt.com/backend-api/wham/usage']);
  assert.deepEqual(credentials, ['openai-codex']);
  for (const provider of ['anthropic', 'claude-sdk', 'claude-sdk-work', 'openai']) {
    ctx.model = { provider, id: 'model' };
    ctx.modelRegistry.isUsingOAuth = () => false;
    assert.equal(await usageReset(ctx, 'usage limit', { now: NOW, fetch }), null);
  }
  assert.equal(requests.length, 1);
  ctx.model = { provider: 'anthropic', id: 'claude-sonnet-4-6' };
  ctx.modelRegistry.isUsingOAuth = () => true;
  assert.equal(await usageReset(ctx, 'usage limit', { now: NOW, fetch: async (url) => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    return { ok: true, json: async () => ({ five_hour: { utilization: 100, resets_at: iso(NOW + HOUR) } }) };
  } }), NOW + HOUR);
  const offline = async () => { throw new Error('offline'); };
  assert.equal(await usageReset(ctx, 'usage limit. Try again in ~60 min.', { now: NOW, fetch: offline }), NOW + HOUR);
  assert.equal(await usageReset(ctx, 'billing: quota exceeded', { now: NOW, fetch: () => assert.fail('billing must not fetch') }), null);
});

function harness({ entries = [], at = NOW + 5 * HOUR, resolver, model = { provider: 'openai', id: 'gpt-5' } } = {}) {
  let clock = NOW, nextId = 0;
  const handlers = {}, timers = new Map(), sent = [], notes = [], measures = [], resumedModels = [];
  const fresh = !entries.length;
  if (fresh) entries.push({ type: 'custom', customType: 'goal-state', data: { goal: { id: 'g1', status: 'active' } } });
  const ctx = { model, modelRegistry: { isUsingOAuth: () => false },
    isIdle: () => true, hasPendingMessages: () => false, hasUI: false, sessionManager: { getBranch: () => entries } };
  const pi = { on: (ev, fn) => (handlers[ev] ??= []).push(fn),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data: structuredClone(data) }),
    sendUserMessage: (text, opts) => { sent.push({ text, opts }); resumedModels.push(structuredClone(ctx.model)); },
    setModel: () => assert.fail('recovery must never switch the selected model') };
  const recovery = installUsageResume(pi, { now: () => clock, resolveReset: resolver ?? (async () => at), claudeProfiles: [{ id: 'work' }, { id: 'home' }],
    notify: (_ctx, text) => notes.push(text), measure: (m) => measures.push(m),
    setTimer: (fn, delay) => { assert.ok(delay <= 60_000); const id = ++nextId; timers.set(id, { fn, delay }); return id; },
    clearTimer: (id) => timers.delete(id) });
  const emit = async (ev, event = {}) => { let result; for (const fn of handlers[ev] ?? []) result = await fn(event, ctx) ?? result; return result; };
  const tick = (time) => { clock = time; const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((t) => t.fn()); };
  const setGoal = (g) => entries.push({ type: 'custom', customType: 'goal-state', data: { goal: g } });
  const saved = () => entries.filter((e) => e.customType === USAGE_RESUME_ENTRY).at(-1)?.data;
  if (fresh) {
    // Simulate a goal-owned run that ends in a provider usage error. Settlement follows in each test.
    for (const fn of handlers.agent_start ?? []) fn({}, ctx);
    for (const fn of handlers.turn_end ?? []) fn({ message: { role: 'assistant', stopReason: 'error', errorMessage: 'usage limit reached' } }, ctx);
    setGoal({ id: 'g1', status: 'usage_limited' });
  }
  return { ctx, entries, timers, sent, notes, measures, recovery, emit, tick, setGoal, saved, resumedModels };
}

test('a usage-limited goal waits until reset plus margin and resumes once through upstream /goal', async () => {
  const h = harness();
  await h.emit('agent_settled');
  assert.equal(h.saved().resumeAt, NOW + 5 * HOUR + 60_000);
  assert.equal(h.recovery.waiting(), true);
  assert.match(h.notes[0], /\/goal pause cancels/);
  assert.deepEqual(await h.emit('cache_warming_decision'), { action: 'stop' });
  await h.emit('agent_settled');
  assert.equal(h.entries.filter((e) => e.customType === USAGE_RESUME_ENTRY).length, 1);
  h.tick(NOW + 5 * HOUR);
  assert.equal(h.sent.length, 0);
  h.tick(NOW + 5 * HOUR + 60_000);
  assert.deepEqual(h.sent, [{ text: '/goal resume', opts: { expandPromptTemplates: true } }]);
  assert.equal(h.saved(), null);
  assert.equal(h.timers.size, 0);
  assert.equal(await h.emit('cache_warming_decision'), undefined);
});

test('pending schedules survive shutdown and /resume, including an overdue reset', async () => {
  const h = harness();
  await h.emit('agent_settled');
  await h.emit('session_shutdown');
  assert.equal(h.timers.size, 0);
  assert.ok(h.saved());
  const reopened = harness({ entries: structuredClone(h.entries), resolver: () => assert.fail('do not refetch a persisted deadline') });
  reopened.tick(NOW + 6 * HOUR);
  await reopened.emit('session_start');
  assert.equal(reopened.recovery.waiting(), true);
  reopened.tick(NOW + 6 * HOUR + 1000);
  assert.equal(reopened.sent.length, 1);
  assert.equal(h.sent.length, 0);
});

test('manual input, model selection, navigation, and explicit goal commands cancel automatic resumes', async () => {
  for (const event of ['input', 'model_select', 'session_before_switch', 'session_before_tree', 'session_before_fork', 'command']) {
    const h = harness();
    await h.emit('agent_settled');
    if (event === 'command') h.recovery.cancel(h.ctx); else await h.emit(event);
    await h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] });
    await h.emit('agent_settled');
    h.tick(NOW + 9 * HOUR);
    assert.equal(h.sent.length, 0, event);
    assert.equal(h.saved(), null, event);
  }
});

test('wake-up rechecks the exact goal, provider, and pending work before sending a resume', async () => {
  for (const change of [
    (h) => h.setGoal({ id: 'g2', status: 'usage_limited' }),
    (h) => h.setGoal({ id: 'g1', status: 'paused' }),
    (h) => h.setGoal({ id: 'g1', status: 'complete' }),
    (h) => { h.ctx.model = { provider: 'anthropic', id: 'other' }; },
  ]) {
    const h = harness(); await h.emit('agent_settled'); change(h); h.tick(NOW + 9 * HOUR);
    assert.equal(h.sent.length, 0); assert.equal(h.saved(), null);
  }
  const h = harness(); await h.emit('agent_settled');
  h.ctx.isIdle = () => false;
  h.tick(NOW + 6 * HOUR); assert.equal(h.sent.length, 0);
  h.ctx.isIdle = () => true; h.ctx.hasPendingMessages = () => true;
  h.tick(NOW + 6 * HOUR + 60_000); assert.equal(h.sent.length, 0);
  h.ctx.hasPendingMessages = () => false;
  h.tick(NOW + 6 * HOUR + 120_000); assert.equal(h.sent.length, 1);
});

test('billing, unknown resets, ordinary waits and transient errors do not get a quota timer', async () => {
  const unknown = harness({ at: null }); await unknown.emit('agent_settled');
  assert.equal(unknown.saved(), undefined); assert.match(unknown.notes[0], /no reset time/);
  const billing = harness({ resolver: () => assert.fail('do not resolve billing errors') });
  await billing.emit('turn_end', { message: { role: 'assistant', stopReason: 'error', errorMessage: 'insufficient_quota: billing required' } });
  await billing.emit('agent_settled'); assert.equal(billing.saved(), undefined);
  for (const g of [
    { id: 'g1', status: 'active', waiting: { reason: 'Waiting for download' } },
    { id: 'g1', status: 'active', waiting: { reason: 'Provider retries exhausted: server error' } },
    { id: 'g1', status: 'blocked' }, { id: 'g1', status: 'budget_limited' },
  ]) {
    const h = harness({ resolver: () => assert.fail('no quota resolution') }); h.setGoal(g);
    await h.emit('agent_settled'); assert.equal(h.saved(), undefined);
  }
});

test('API 429 reset headers replace short provider backoff without requiring OAuth', async () => {
  const h = harness({ at: null });
  h.setGoal({ id: 'g1', status: 'active', waiting: { reason: 'Provider retries exhausted: 429 rate limit' } });
  await h.emit('after_provider_response', { status: 429, headers: { 'retry-after': '18000' } });
  await h.emit('agent_settled'); assert.equal(h.saved().resumeAt, NOW + 5 * HOUR + 60_000);
  h.tick(NOW + 6 * HOUR); assert.equal(h.sent.length, 1);
});

test('API error-text reset times replace short backoff without requiring headers', async () => {
  const h = harness({ at: null });
  h.setGoal({ id: 'g1', status: 'active', waiting: { reason: 'Provider retries exhausted: 429 rate limit reached' } });
  await h.emit('turn_end', { message: { role: 'assistant', stopReason: 'error', errorMessage: '429 rate limit reached; retry after 2h' } });
  await h.emit('agent_settled');
  assert.equal(h.saved().resumeAt, NOW + 2 * HOUR + 60_000);
});

test('unrelated failures cannot rearm an inactive goal, including after a cancelled billing failure', async () => {
  const h = harness();
  await h.emit('turn_end', { message: { role: 'assistant', stopReason: 'error', errorMessage: 'account balance depleted' } });
  await h.emit('agent_settled');
  assert.equal(h.saved(), undefined);
  await h.emit('input');
  await h.emit('agent_start'); // The old goal is still usage_limited, not the owner of this run.
  await h.emit('before_provider_request');
  await h.emit('turn_end', { message: { role: 'assistant', stopReason: 'error', errorMessage: 'usage limit. Try again in 60 min.' } });
  await h.emit('agent_settled');
  assert.equal(h.saved(), undefined);
});

test('unknown and expired reset evidence cannot cause repeated probes after settlement', async () => {
  for (const at of [null, NOW - HOUR]) {
    let calls = 0;
    const h = harness({ resolver: async () => { calls++; return at; } });
    await h.emit('agent_settled');
    await h.emit('agent_settled');
    assert.equal(calls, 1);
    assert.equal(h.timers.size, 0);
  }
});

test('an in-flight usage query cannot schedule after cancellation or session replacement', async () => {
  let resolve;
  const h = harness({ resolver: () => new Promise((r) => { resolve = r; }) });
  const scheduling = h.emit('agent_settled');
  await h.emit('session_shutdown');
  resolve(NOW + HOUR); await scheduling;
  assert.equal(h.saved(), undefined); assert.equal(h.timers.size, 0);
});

const SDK = { provider: 'claude-sdk-work', id: 'claude-opus-5-5', api: 'claude-agent-sdk' };
const CODEX = { provider: 'openai-codex', id: 'gpt-5.4' };
const sdkEvent = (info, model = SDK) => ({ provider: model.provider, model: model.id, api: model.api,
  data: { type: 'rate_limit_event', rate_limit_info: info } });
const rejected = (extra = {}) => ({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: (NOW + 3 * HOUR) / 1000,
  overageStatus: 'rejected', overageDisabledReason: 'group_zero_credit_limit', ...extra });
const sdkFailure = () => ({ role: 'assistant', provider: SDK.provider, model: SDK.id, stopReason: 'error',
  errorMessage: "You've hit your session limit · resets 7am (America/Los_Angeles)", content: [] });
async function startSdkRun(h, model = SDK) {
  const previousModel = h.ctx.model;
  h.ctx.model = model;
  await h.emit('model_select', { model, previousModel });
  h.setGoal({ id: 'g1', status: 'active' });
  await h.emit('agent_start');
  await h.emit('before_provider_request');
}
async function finishSdkFailure(h, message = sdkFailure()) {
  const replacement = await h.emit('message_end', { message });
  const final = replacement?.message ?? message;
  // Upstream recognizes "usage limit", but not Claude Code's localized "session limit" text.
  h.setGoal({ id: 'g1', status: /usage[_\s-]*limit/i.test(final.errorMessage) ? 'usage_limited' : 'blocked' });
  await h.emit('turn_end', { message: final });
  await h.emit('agent_end', { messages: [final] });
  await h.emit('agent_settled');
  return final;
}

test('Claude SDK structured rejection schedules a same-model resume without reading OAuth credentials', async () => {
  const h = harness({ model: SDK, resolver: (ctx, error, options) => usageReset(ctx, error, { ...options,
    fetch: () => assert.fail('Claude SDK recovery must not fetch another login\'s usage') }) });
  await startSdkRun(h);
  await h.emit('provider_stream_event', sdkEvent(rejected()));
  const final = await finishSdkFailure(h);
  assert.match(final.errorMessage, /usage limit/i);
  assert.equal(h.saved()?.resumeAt, NOW + 3 * HOUR + 60_000);
  h.tick(NOW + 3 * HOUR + 60_000);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.resumedModels, [SDK]);
});

test('Codex → Claude SDK → Codex → Claude SDK discards old timers and resumes only on the last Claude selection', async () => {
  const h = harness({ model: CODEX, resolver: async (ctx) => ctx.model.provider === CODEX.provider ? NOW + 5 * HOUR : null });
  await h.emit('agent_settled');
  assert.ok(h.saved());
  await startSdkRun(h);
  await h.emit('provider_stream_event', sdkEvent(rejected()));
  await finishSdkFailure(h);
  assert.equal(h.saved()?.model, JSON.stringify([SDK.provider, SDK.id, null, false]));
  h.ctx.model = CODEX;
  await h.emit('model_select', { model: CODEX, previousModel: SDK });
  h.tick(NOW + 60_000);
  assert.equal(h.saved(), null);
  await startSdkRun(h);
  await h.emit('provider_stream_event', sdkEvent(rejected({ resetsAt: (NOW + 4 * HOUR) / 1000 })));
  await finishSdkFailure(h);
  h.tick(NOW + 3 * HOUR + 60_000);
  assert.equal(h.sent.length, 0, 'the previous Claude timer cannot fire');
  h.tick(NOW + 5 * HOUR);
  assert.deepEqual(h.resumedModels, [SDK]);
});

test('Claude SDK waits for exhausted weekly windows and ignores the other model family', async () => {
  const h = harness({ model: SDK, at: null });
  await startSdkRun(h);
  await h.emit('provider_stream_event', sdkEvent(rejected({ unifiedWindows: {
    five_hour: { utilization: 1, resetsAt: (NOW + 3 * HOUR) / 1000 },
    seven_day: { utilization: 1, resetsAt: (NOW + 20 * HOUR) / 1000 },
    seven_day_sonnet: { utilization: 1, resetsAt: (NOW + 40 * HOUR) / 1000 },
  } })));
  await finishSdkFailure(h);
  assert.equal(h.saved()?.resumeAt, NOW + 20 * HOUR + 60_000);
});

test('Claude SDK retains renewable resets even when optional window data or overage credits are absent', () => {
  for (const provider of ['claude-sdk', 'claude-sdk-work', 'claude-sdk-home']) {
    assert.equal(claudeSdkReset(rejected({ overageDisabledReason: 'out_of_credits', unifiedWindows: {
      five_hour: { utilization: 1 },
    } }), { ...SDK, provider }), NOW + 3 * HOUR);
  }
  assert.equal(claudeSdkReset(rejected({ resetsAt: undefined, unifiedWindows: {
    five_hour: { utilization: 1, resetsAt: (NOW + 3 * HOUR) / 1000 },
  } }), SDK), NOW + 3 * HOUR);
  assert.equal(claudeSdkReset(rejected({ rateLimitType: undefined, unifiedWindows: {
    five_hour: { utilization: 1, resetsAt: (NOW + 3 * HOUR) / 1000 },
  } }), SDK), NOW + 3 * HOUR);
  assert.equal(claudeSdkReset(rejected({ rateLimitType: 'seven_day_sonnet' }), SDK), null);
});

test('Claude SDK schedules survive reopening on the same account and model', async () => {
  const h = harness({ model: SDK, at: null });
  await startSdkRun(h);
  await h.emit('provider_stream_event', sdkEvent(rejected()));
  await finishSdkFailure(h);
  assert.ok(h.saved());
  await h.emit('session_shutdown');
  const restored = harness({ entries: structuredClone(h.entries), model: SDK });
  await restored.emit('session_start');
  restored.tick(NOW + 3 * HOUR + 60_000);
  assert.deepEqual(restored.resumedModels, [SDK]);
  const other = harness({ entries: structuredClone(h.entries), model: CODEX });
  await other.emit('session_start');
  other.tick(NOW + 4 * HOUR);
  assert.deepEqual(other.resumedModels, []);
});

test('Claude SDK billing metadata blocks recovery even when generic error text supplies a reset', async () => {
  for (const info of [rejected({ errorCode: 'credits_required' }), rejected({ rateLimitType: 'overage' }), rejected({ limitScope: 'group_pool' })]) {
    const h = harness({ model: SDK, resolver: () => assert.fail('billing metadata must override generic reset text') });
    await startSdkRun(h);
    await h.emit('provider_stream_event', sdkEvent(info));
    await finishSdkFailure(h, { ...sdkFailure(), errorMessage: 'usage limit reached; retry after 2h' });
    assert.equal(h.timers.size, 0);
  }
});

test('Claude SDK events from other accounts, models or unknown profile IDs cannot arm a timer', async () => {
  for (const model of [
    { ...SDK, provider: 'claude-sdk-home' }, { ...SDK, provider: 'claude-sdk-work-extra' },
    { ...SDK, id: 'claude-sonnet-4-6' }, CODEX,
  ]) {
    const h = harness({ model: SDK, at: null });
    await startSdkRun(h);
    await h.emit('provider_stream_event', sdkEvent(rejected(), model));
    const final = await finishSdkFailure(h);
    assert.equal(final.errorMessage, sdkFailure().errorMessage);
    assert.equal(h.timers.size, 0);
  }
  const unknown = { ...SDK, provider: 'claude-sdk-not-configured' };
  const h = harness({ model: unknown, at: null });
  await startSdkRun(h, unknown);
  await h.emit('provider_stream_event', sdkEvent(rejected(), unknown));
  await finishSdkFailure(h, { ...sdkFailure(), provider: unknown.provider });
  assert.equal(h.timers.size, 0);
});

test('Claude SDK warnings, overage billing, missing resets and later successful requests do not trigger recovery', async () => {
  for (const info of [
    rejected({ status: 'allowed_warning', utilization: 0.99 }),
    rejected({ rateLimitType: 'overage', errorCode: 'credits_required' }),
    rejected({ errorCode: 'credits_required' }), rejected({ limitScope: 'group_pool' }),
    rejected({ resetsAt: undefined }), rejected({ resetsAt: NaN }),
    rejected({ unifiedWindows: { seven_day: { utilization: 1 } } }),
  ]) {
    const h = harness({ model: SDK, at: null });
    await startSdkRun(h);
    await h.emit('provider_stream_event', sdkEvent(info));
    await finishSdkFailure(h);
    assert.equal(h.timers.size, 0, JSON.stringify(info));
  }
  const h = harness({ model: SDK, at: null });
  await startSdkRun(h);
  await h.emit('provider_stream_event', sdkEvent(rejected()));
  await h.emit('before_provider_request'); // A new request must not inherit a prior rejection.
  await finishSdkFailure(h, { ...sdkFailure(), errorMessage: 'Connection refused' });
  assert.equal(h.timers.size, 0);
});

test('an SDK-internal retry cannot reuse a rejected quota frame from an earlier response', async () => {
  const h = harness({ model: SDK, at: null });
  await startSdkRun(h);
  await h.emit('provider_stream_event', sdkEvent(rejected()));
  await h.emit('provider_stream_event', { provider: SDK.provider, model: SDK.id, api: SDK.api,
    data: { type: 'message_start', message: { id: 'internal-retry', model: SDK.id, usage: {} } } });
  const final = await finishSdkFailure(h, { ...sdkFailure(), errorMessage: 'Connection refused' });
  assert.equal(final.errorMessage, 'Connection refused');
  assert.equal(h.timers.size, 0);
});

test('automatic subagent notices and host alarms cannot erase an existing quota deadline', async () => {
  for (const model of [CODEX, SDK]) for (const source of ['subagent', 'host-alarm']) {
    const h = harness({ model });
    await h.emit('agent_settled');
    const deadline = h.saved().resumeAt;
    if (source === 'subagent') await h.emit('input', { source: 'extension', text: 'mina: subagent failed', streamingBehavior: 'steer' });
    await h.emit('agent_start');
    const message = { role: 'assistant', stopReason: 'error', errorMessage: 'usage limit reached' };
    await h.emit('turn_end', { message });
    await h.emit('agent_end', { messages: [message] });
    await h.emit('agent_settled');
    assert.equal(h.saved()?.resumeAt, deadline, source);
    h.tick(deadline);
    assert.equal(h.sent.length, 1, source);
    assert.deepEqual(h.resumedModels, [model]);
  }
});

test('an extension steer during active Codex work cannot prevent its next quota error from scheduling recovery', async () => {
  const requests = [];
  const h = harness({ model: CODEX, resolver: (ctx, error, options) => usageReset(ctx, error, { ...options,
    fetch: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 100, reset_at: (NOW + 5 * HOUR) / 1000 } } }) };
    },
  }) });
  h.ctx.modelRegistry = { isUsingOAuth: () => true, getApiKeyForProvider: async () => 'test-token' };
  h.setGoal({ id: 'g1', status: 'active' });
  await h.emit('agent_start');
  await h.emit('input', { source: 'extension', text: 'mina: subagent completed', streamingBehavior: 'steer' });
  await h.emit('before_provider_request');
  h.setGoal({ id: 'g1', status: 'usage_limited' });
  const message = { role: 'assistant', stopReason: 'error', errorMessage: 'Codex error: The usage limit has been reached' };
  await h.emit('turn_end', { message });
  await h.emit('agent_end', { messages: [message] });
  await h.emit('agent_settled');
  assert.equal(h.saved()?.resumeAt, NOW + 5 * HOUR + 60_000);
  assert.deepEqual(requests, ['https://chatgpt.com/backend-api/wham/usage']);
});

test('automatic notifications do not invalidate an in-flight reset lookup', async () => {
  let resolve;
  const h = harness({ resolver: () => new Promise((r) => { resolve = r; }) });
  const lookup = h.emit('agent_settled');
  await h.emit('input', { source: 'extension', text: 'mina: subagent finished' });
  await h.emit('agent_start');
  await h.emit('before_provider_request');
  const message = { role: 'assistant', stopReason: 'error', errorMessage: 'usage limit reached' };
  await h.emit('turn_end', { message });
  await h.emit('agent_end', { messages: [message] });
  await h.emit('agent_settled');
  resolve(NOW + 5 * HOUR);
  await lookup;
  assert.equal(h.saved()?.resumeAt, NOW + 5 * HOUR + 60_000);
});

test('manual cancellation of an active API-rate-limit wait cannot be undone by request rebinding', async () => {
  const h = harness();
  h.setGoal({ id: 'g1', status: 'active', waiting: { reason: 'Provider retries exhausted: 429 rate limit' } });
  await h.emit('after_provider_response', { status: 429, headers: { 'retry-after': '18000' } });
  await h.emit('agent_settled');
  assert.ok(h.saved());
  await h.emit('input', { source: 'interactive', text: 'leave the goal parked; answer a different question' });
  h.setGoal({ id: 'g1', status: 'active' }); // Upstream clears the old wait on human follow-up.
  await h.emit('agent_start');
  await h.emit('before_provider_request');
  const message = { role: 'assistant', stopReason: 'error', errorMessage: '429 rate limit reached; retry after 2h' };
  await h.emit('turn_end', { message });
  h.setGoal({ id: 'g1', status: 'active', waiting: { reason: 'Provider retries exhausted: 429 rate limit' } });
  await h.emit('agent_end', { messages: [message] });
  await h.emit('agent_settled');
  assert.equal(h.saved(), null);
  assert.equal(h.timers.size, 0);

  h.recovery.cancel(h.ctx); // The explicit /goal command boundary clears the cancellation barrier.
  h.setGoal({ id: 'g1', status: 'active' });
  await h.emit('agent_start');
  await h.emit('before_provider_request');
  await h.emit('turn_end', { message });
  h.setGoal({ id: 'g1', status: 'usage_limited' });
  await h.emit('agent_end', { messages: [message] });
  await h.emit('agent_settled');
  assert.ok(h.saved(), 'an explicit goal resume enables future quota recovery again');
});

test('human interactive and RPC input still cancel recovery before an unrelated model request', async () => {
  for (const source of ['interactive', 'rpc']) {
    const h = harness();
    await h.emit('agent_settled');
    await h.emit('input', { source, text: 'leave this goal parked' });
    await h.emit('agent_start');
    await h.emit('before_provider_request');
    const message = { role: 'assistant', stopReason: 'error', errorMessage: 'usage limit reached' };
    await h.emit('turn_end', { message });
    await h.emit('agent_end', { messages: [message] });
    await h.emit('agent_settled');
    h.tick(NOW + 6 * HOUR);
    assert.equal(h.saved(), null, source);
    assert.equal(h.sent.length, 0, source);
  }
});
