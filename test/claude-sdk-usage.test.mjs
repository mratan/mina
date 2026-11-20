// Replay Claude Code's structured quota frame through the carried provider, Mina, and pi-goal's real classifier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createJiti } from 'jiti';
import { createInitialSystemMessage } from '@earendil-works/pi-ai';
import { installUsageResume, USAGE_RESUME_ENTRY } from '../extensions/goal/usage-resume.mjs';

const jiti = createJiti(import.meta.url);
const { ClaudeSdkProvider } = await jiti.import('../node_modules/pi-claude-subscription/src/provider.ts');
const { AnchorRegistry } = await jiti.import('../node_modules/pi-claude-subscription/src/anchors.ts');
const { AsyncQueue } = await jiti.import('../node_modules/pi-claude-subscription/src/util.ts');
// This chunk is part of pinned pi-goal 0.54.8. The test must fail if its classifier contract changes.
const { isUsageLimitedGoalInterruption } = await jiti.import('../node_modules/@narumitw/pi-goal/dist/chunks/chunk-RNWM7MOG.ts');

test('a carried Claude SDK quota rejection reaches recovery and resumes on the same provider and model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mina-sdk-quota-'));
  const model = { provider: 'claude-sdk', id: 'claude-opus-5-5', api: 'claude-agent-sdk', maxTokens: 1024,
    reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let now = Date.parse('2026-01-01T12:00:00Z');
  const reset = now + 3_600_000;
  const handlers = {}, timers = new Map(), sent = [];
  const entries = [{ type: 'custom', customType: 'goal-state', data: { goal: { id: 'g1', status: 'active' } } }];
  const ctx = { model, modelRegistry: { isUsingOAuth: () => false, getApiKeyForProvider: () => assert.fail('no credential lookup') },
    sessionManager: { getBranch: () => entries }, isIdle: () => true, hasPendingMessages: () => false };
  installUsageResume({ on: (ev, fn) => (handlers[ev] ??= []).push(fn),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendUserMessage: (text) => sent.push({ text, provider: ctx.model.provider, model: ctx.model.id }),
    setModel: () => assert.fail('no model failover'),
  }, { now: () => now, claudeProfiles: [],
    setTimer: (fn) => { const id = randomUUID(); timers.set(id, fn); return id; }, clearTimer: (id) => timers.delete(id) });
  const emit = async (ev, event = {}) => { let result; for (const fn of handlers[ev] ?? []) result = await fn(event, ctx) ?? result; return result; };
  const frames = [
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset / 1000,
      overageStatus: 'rejected', overageDisabledReason: 'group_zero_credit_limit' } },
    { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your session limit · resets 5am (America/Los_Angeles)" }] } },
  ];
  const provider = new ClaudeSdkProvider({ configDir: root, cwd: () => root, registry: new AnchorRegistry(join(root, 'anchors.jsonl')),
    createSession: (spec, chain, count) => {
      const events = new AsyncQueue();
      let exited;
      const session = { spec, chain, count, systemPrompt: spec.systemPrompt, model: spec.model, sessionId: randomUUID(),
        busy: false, dead: false, lastUsed: Date.now(), awaiting: new Set(), servedByClaude: new Set(), events,
        exited: new Promise((r) => { exited = r; }), stderr: '', entryUuid: async () => randomUUID(),
        setModel: async () => assert.fail('no SDK model switch'), deliver() {}, interrupt: async () => {},
        close() { session.dead = true; events.close(); exited(); }, send() { frames.forEach((frame) => events.push(frame)); } };
      return session;
    } });
  try {
    await emit('agent_start');
    await emit('before_provider_request');
    const context = { messages: [createInitialSystemMessage('test', []), { role: 'user', content: 'continue the goal', timestamp: 1 }] };
    const message = await provider.streamSimple(model, context, {
      onProviderStreamEvent: (data, selected) => emit('provider_stream_event', { provider: selected.provider, model: selected.id, api: selected.api, data }),
    }).result();
    assert.equal(message.stopReason, 'error');
    assert.equal(isUsageLimitedGoalInterruption(message), false, 'the original localized error is a generic blocker');
    const replacement = await emit('message_end', { message });
    assert.ok(replacement?.message, 'Mina normalizes the evidenced renewable quota error before pi-goal classifies it');
    assert.equal(isUsageLimitedGoalInterruption(replacement.message), true);
    entries.push({ type: 'custom', customType: 'goal-state', data: { goal: { id: 'g1', status: 'usage_limited' } } });
    await emit('turn_end', { message: replacement.message });
    await emit('agent_end', { messages: [replacement.message] });
    await emit('agent_settled');
    assert.equal(entries.filter((e) => e.customType === USAGE_RESUME_ENTRY).at(-1).data.resumeAt, reset + 60_000);
    // Production replay: a second subagent failure arrived 11 seconds after the deadline was saved, started an
    // unrelated run, hit the same quota, and previously erased the scheduled resume permanently.
    now += 11_000;
    await emit('input', { source: 'extension', text: 'mina: subagent failed', streamingBehavior: 'steer' });
    await emit('agent_start');
    await emit('before_provider_request');
    const noticeReply = await provider.streamSimple(model, context, {
      onProviderStreamEvent: (data, selected) => emit('provider_stream_event', { provider: selected.provider, model: selected.id, api: selected.api, data }),
    }).result();
    const noticeFinal = (await emit('message_end', { message: noticeReply }))?.message ?? noticeReply;
    await emit('turn_end', { message: noticeFinal });
    await emit('agent_end', { messages: [noticeFinal] });
    await emit('agent_settled');
    assert.equal(entries.filter((e) => e.customType === USAGE_RESUME_ENTRY).at(-1).data?.resumeAt, reset + 60_000);
    now = reset + 60_000;
    const due = [...timers.values()]; timers.clear(); due.forEach((fn) => fn());
    assert.deepEqual(sent, [{ text: '/goal resume', provider: 'claude-sdk', model: 'claude-opus-5-5' }]);
  } finally {
    await emit('session_shutdown');
    provider.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
