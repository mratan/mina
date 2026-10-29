import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import delegates from '../extensions/delegates/index.js';
import { needsSandbox } from './capabilities.mjs';

async function fixture(responses) {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-child-project-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'mina-child-controller-'));
  const env = { PI_CODING_AGENT_DIR: agentDir, MINA_INSTANCE_ID: cwd, MINA_SANDBOX_PROJECT: cwd,
    MINA_SANDBOX_WRITE: JSON.stringify([cwd]), MINA_SANDBOX_NET: 'offline' };
  const faux = fauxProvider(); faux.setResponses(responses);
  const runtime = await ModelRuntime.create({ agentDir, modelsPath: null });
  runtime.registerNativeProvider(faux.provider);
  const tools = {}, handlers = {}, entries = [], events = new EventEmitter();
  const pi = { events, registerTool: (t) => { tools[t.name] = t; }, on: (e, h) => { handlers[e] = h; }, appendEntry: (type, data) => entries.push({ type, data }) };
  delegates(pi, { env });
  const ctx = { cwd, model: faux.getModel(), modelRegistry: new ModelRegistry(runtime), tools: [], thinkingLevel: 'off' };
  return { cwd, faux, tools, ctx, entries, shutdown: async () => { await handlers.session_shutdown(); rmSync(cwd, { recursive: true }); rmSync(agentDir, { recursive: true }); } };
}

test('a real delegated tool writes through the same worker and preserves its final report', { skip: needsSandbox }, async () => {
  const f = await fixture([fauxAssistantMessage(fauxToolCall('write', { path: 'child.txt', content: 'worker-written' }), { stopReason: 'toolUse' }), fauxAssistantMessage('Child report retained.')]);
  try {
    const out = await f.tools.Agent.execute('parent-call', { prompt: 'Write a file.', description: 'fixture', run_in_background: false }, null, null, f.ctx);
    assert.equal(out.details.status, 'completed', JSON.stringify(out));
    assert.equal(readFileSync(join(f.cwd, 'child.txt'), 'utf8'), 'worker-written');
    assert.equal(out.details.result, 'Child report retained.');
    assert.equal(f.entries[0].data.result, 'Child report retained.');
    assert.ok(!out.details.tools.includes('mina_host'));
  } finally { await f.shutdown(); }
});

test('a child turn limit preserves the partial report and reports the error separately', { skip: needsSandbox }, async () => {
  const f = await fixture([fauxAssistantMessage([{ type: 'text', text: 'Partial report.' }, fauxToolCall('write', { path: 'partial.txt', content: 'saved' })], { stopReason: 'toolUse' }), fauxAssistantMessage('must not run')]);
  try {
    const out = await f.tools.Agent.execute('bounded-call', { prompt: 'Work.', description: 'bounded', max_turns: 1, run_in_background: false }, null, null, f.ctx);
    assert.equal(out.details.status, 'failed');
    assert.match(out.details.error, /turn limit/);
    assert.equal(out.details.result, 'Partial report.');
    assert.equal(readFileSync(join(f.cwd, 'partial.txt'), 'utf8'), 'saved');
    assert.equal(f.faux.state.callCount, 1);
    const readback = await f.tools.get_subagent_result.execute('read', { agent_id: out.details.id });
    assert.match(readback.content[0].text, /turn limit/);
  } finally { await f.shutdown(); }
});

test('inherited dialogue does not replace the child role with its parent system policy', { skip: needsSandbox }, async () => {
  const f = await fixture([(context) => {
    assert.doesNotMatch(JSON.stringify(context.messages.filter((m) => m.role === 'system')), /PARENT_ONLY_POLICY/);
    return fauxAssistantMessage('Child role retained.');
  }]);
  f.ctx.sessionManager = { getBranch: () => [{ type: 'message', message: { role: 'system', content: 'PARENT_ONLY_POLICY', timestamp: 0 } }] };
  try {
    const out = await f.tools.Agent.execute('inherited', { prompt: 'Work.', description: 'inherit', inherit_context: true, run_in_background: false }, null, null, f.ctx);
    assert.equal(out.details.status, 'completed', JSON.stringify(out));
    assert.equal(out.details.result, 'Child role retained.');
  } finally { await f.shutdown(); }
});
