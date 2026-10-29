import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import minaFooter, { answeredBy, formatCwd, goalFromEntries, goalText, refusalNotice, refusalRecord, statusLine, topLine } from '../extensions/footer/index.js';

const plain = (s) => s;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const theme = { fg: (_c, s) => s };

test('the folder is shown relative to home', () => {
  assert.equal(formatCwd('/home/u/work/x', '/home/u'), '~/work/x');
  assert.equal(formatCwd('/home/u', '/home/u'), '~');
  assert.equal(formatCwd('/srv/x', '/home/u'), '/srv/x');
});

test('the goal comes from the latest goal-state; a finished or cleared goal shows nothing', () => {
  const state = (goal) => ({ type: 'custom', customType: 'goal-state', data: { goal } });
  assert.equal(goalFromEntries([state({ status: 'paused' }), state({ status: 'active' })]), 'active');
  assert.equal(goalFromEntries([state({ status: 'active', waiting: { reason: 'x' } })]), 'active · waiting');
  assert.equal(goalFromEntries([state({ status: 'active' }), state({ status: 'complete' })]), undefined);
  assert.equal(goalFromEntries([state({ status: 'active' }), state(undefined)]), undefined);
  assert.equal(goalFromEntries([]), undefined);
});

test('the status line puts the goal first and labels it; pi-goal\'s own text wins over the fallback', () => {
  const statuses = new Map([['goal', 'active 34m · automatic 0/100'], ['claude-code-usage', 'Claude Home 5h 22%'], ['a', 'first']]);
  assert.equal(statusLine(statuses, 'paused'), '/goal mode active · 34m · automatic 0/100  first  Claude Home 5h 22%');
  assert.equal(statusLine(new Map([['x', 'y']]), 'active'), '/goal mode active  y');
  assert.equal(statusLine(new Map([['goal', 'paused · automatic 3/100']])), '/goal paused · automatic 3/100');
  assert.equal(statusLine(new Map([['goal', 'active 1m']]), undefined, (s) => `<${s}>`), '</goal mode active> · 1m');
  assert.equal(statusLine(new Map(), undefined), '');
});

test('an active goal reads "/goal mode active"; other states keep pi-goal\'s words', () => {
  assert.deepEqual(goalText('active 18k/100k · automatic 12/25'), { label: '/goal mode active', rest: '18k/100k · automatic 12/25' });
  assert.deepEqual(goalText('active · waiting'), { label: '/goal mode active', rest: 'waiting' });
  assert.deepEqual(goalText('waiting review monitor · automatic 12/25'), { label: '/goal', rest: 'waiting review monitor · automatic 12/25' });
  assert.deepEqual(goalText('complete'), { label: '/goal', rest: 'complete' });
});

test('line 1 keeps context use and model on the right; the provider goes before the folder is shortened', () => {
  const args = { left: '~/work/my-project (feature-x)', context: '10.1%/1.0M (auto)', model: 'claude-opus-5-5 • high', provider: 'claude-sdk-home', dim: plain };
  const wide = topLine({ ...args, width: 120 });
  assert.equal(visibleWidth(wide), 120);
  assert.match(wide, /^~\/work\/my-project \(feature-x\) +10\.1%\/1\.0M \(auto\)  \(claude-sdk-home\) claude-opus-5-5 • high$/);
  const mid = topLine({ ...args, width: 85 });
  assert.match(mid, /^~\/work\/my-project \(feature-x\) +10\.1%\/1\.0M \(auto\)  claude-opus-5-5 • high$/);
  const narrow = strip(topLine({ ...args, width: 60 }));
  assert.ok(visibleWidth(narrow) <= 60);
  assert.match(narrow, /^~\/work.*\.\.\. +10\.1%\/1\.0M \(auto\)  claude-opus-5-5 • high$/);
  assert.ok(visibleWidth(topLine({ ...args, width: 20 })) <= 20);
});

test('the footer renders two lines with no token or cost totals, and keeps its lines after the session is gone', () => {
  const handlers = {};
  const pi = { on: (name, fn) => { (handlers[name] ??= []).push(fn); }, getThinkingLevel: () => 'high' };
  minaFooter(pi, { home: '/home/u' });
  let factory = null;
  const entries = [{ type: 'custom', customType: 'goal-state', data: { goal: { status: 'active' } } }];
  const ctx = {
    hasUI: true, mode: 'tui', cwd: '/home/u/work/x',
    model: { id: 'claude-opus-5-5', provider: 'claude-sdk-home', reasoning: true, contextWindow: 1_000_000 },
    sessionManager: { getCwd: () => '/home/u/work/x', getSessionId: () => 's', getLeafId: () => 'l', getEntryCount: () => 1, getSessionName: () => undefined, getBranch: () => entries },
    getContextUsage: () => ({ tokens: 101_000, contextWindow: 1_000_000, percent: 10.1 }),
    ui: { setFooter: (f) => { factory = f; } },
  };
  for (const fn of handlers.session_start) fn({}, ctx);
  const footerData = { getGitBranch: () => 'feature-x', getAvailableProviderCount: () => 2, onBranchChange: () => () => {},
    getExtensionStatuses: () => new Map([['claude-code-usage', 'Claude Home 5h 22%']]) };
  const footer = factory({ requestRender() {} }, theme, footerData);
  const lines = footer.render(120);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^~\/work\/x \(feature-x\) +10\.1%\/1\.0M \(auto\)  \(claude-sdk-home\) claude-opus-5-5 • high$/);
  assert.equal(lines[1], '/goal mode active  Claude Home 5h 22%');
  assert.doesNotMatch(lines.join('\n'), /↑|↓|\$|CH\d/);
  for (const fn of handlers.session_shutdown) fn({}, ctx);
  assert.deepEqual(footer.render(120), lines);
});

const opus = { id: 'claude-opus-5-5', provider: 'claude-sdk-work' };
const reply = (responseModel, extra = {}) => ({ type: 'message', message: { role: 'assistant', provider: opus.provider, model: opus.id, responseModel, ...extra } });

test('the answering model shows only when the latest reply of the selected model came from another model', () => {
  const tool = { type: 'message', message: { role: 'toolResult' } };
  assert.equal(answeredBy([reply('claude-opus-5'), tool], opus), 'claude-opus-5');
  assert.equal(answeredBy([reply('claude-opus-5'), reply('claude-opus-5-5')], opus), undefined, 'an Opus 5.5 reply clears it');
  assert.equal(answeredBy([reply('claude-opus-5'), reply(undefined)], opus), undefined, 'an error reply names no model');
  assert.equal(answeredBy([reply('claude-opus-5')], { ...opus, provider: 'claude-sdk-home' }), undefined, 'another provider was selected since');
  assert.equal(answeredBy([reply('claude-opus-5')], { ...opus, id: 'claude-opus-5' }), undefined);
  assert.equal(answeredBy([], opus), undefined);
});

test('a refusal frame becomes a session entry and one notice per distinct refusal; other frames are ignored', () => {
  const handlers = {}, appended = [], notices = [];
  const pi = { on: (name, fn) => { (handlers[name] ??= []).push(fn); }, appendEntry: (type, data) => appended.push([type, data]) };
  minaFooter(pi, { home: '/home/u' });
  const ctx = { hasUI: true, mode: 'print', ui: { notify: (text, level) => notices.push([text, level]) } };
  for (const fn of handlers.session_start) fn({}, ctx);
  const emit = (data, provider = opus.provider) => { for (const fn of handlers.provider_stream_event) fn({ type: 'provider_stream_event', provider, data }, ctx); };
  const fallback = { type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry', scope: 'session',
    original_model: 'claude-opus-5-5', fallback_model: 'claude-opus-5', api_refusal_category: 'bio', content: 'notice text' };
  emit({ type: 'rate_limit_event', rate_limit_info: {} });
  emit({ type: 'system', subtype: 'informational', content: 'x' });
  emit(fallback);
  emit(fallback);
  emit({ type: 'system', subtype: 'model_refusal_no_fallback', original_model: 'claude-opus-5-5', api_refusal_category: null, content: 'y' });
  const record = { provider: opus.provider, subtype: 'model_refusal_fallback', from: 'claude-opus-5-5', to: 'claude-opus-5', category: 'bio', scope: 'session' };
  assert.deepEqual(appended.map(([t]) => t), ['claude-refusal', 'claude-refusal', 'claude-refusal']);
  assert.deepEqual(appended[0][1], record);
  assert.deepEqual(notices, [
    ['Claude refusal [bio]: claude-opus-5-5 declined; claude-opus-5 answered instead and keeps answering in this Claude Code session.', 'warning'],
    ['Claude refusal: claude-opus-5-5 declined, and no fallback model answered.', 'warning'],
  ]);
  assert.equal(refusalNotice({ ...record, scope: 'local' }), 'Claude refusal [bio]: claude-opus-5-5 declined; claude-opus-5 answered instead (this reply only).');
  assert.deepEqual(refusalRecord('p', { subtype: 'model_refusal_fallback' }), { provider: 'p', subtype: 'model_refusal_fallback', from: null, to: null, category: null, scope: null });
});

test('line 1 reads "selected \u2192 answering" after a fallback reply', () => {
  const handlers = {};
  const pi = { on: (name, fn) => { (handlers[name] ??= []).push(fn); }, getThinkingLevel: () => 'high' };
  minaFooter(pi, { home: '/home/u' });
  let factory = null;
  const ctx = {
    hasUI: true, mode: 'tui', cwd: '/home/u/notes',
    model: { ...opus, reasoning: true, contextWindow: 1_000_000 },
    sessionManager: { getCwd: () => '/home/u/notes', getSessionId: () => 's', getLeafId: () => 'l', getEntryCount: () => 1, getSessionName: () => undefined, getBranch: () => [reply('claude-opus-5')] },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 1_000_000, percent: 0.1 }),
    ui: { setFooter: (f) => { factory = f; } },
  };
  for (const fn of handlers.session_start) fn({}, ctx);
  const footerData = { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() };
  const [line] = factory({ requestRender() {} }, theme, footerData).render(100);
  assert.match(line, /  claude-opus-5-5 \u2192 claude-opus-5 \u2022 high$/);
});
