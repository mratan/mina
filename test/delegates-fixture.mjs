// Shared stand-in for pi used by focused delegation tests (and by the child process of the prototype test).
// Same shape as the fixture in delegates-receipts.test.mjs: tool results and custom entries land on `state.branch`.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { fauxProvider } from '@earendil-works/pi-ai';
import delegates from '../extensions/delegates/index.js';

export const LEDGER = Symbol.for('mina:delegates');
export const fakeTool = (name, run) => ({ name, label: name, description: `fake ${name}`,
  parameters: { type: 'object', properties: {}, additionalProperties: true },
  execute: async (_id, params) => run(params) });

// `sessionManager: false` gives the minimal embedding without a branch (compatibility mode).
export async function fixture(responses, { tools = [], files = {}, dirs = [], sessionManager = true } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-audit-project-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'mina-audit-controller-'));
  for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), body); }
  for (const path of dirs) mkdirSync(join(cwd, path), { recursive: true });
  const env = { PI_CODING_AGENT_DIR: agentDir, MINA_INSTANCE_ID: cwd, MINA_SANDBOX_PROJECT: cwd,
    MINA_SANDBOX_WRITE: JSON.stringify([cwd]), MINA_SANDBOX_NET: 'offline' };
  const faux = fauxProvider(); faux.setResponses(responses);
  const runtime = await ModelRuntime.create({ agentDir, modelsPath: null });
  runtime.registerNativeProvider(faux.provider);
  const state = { branch: [], n: 0 };
  const push = (entry) => { entry.id = `e${++state.n}`; state.branch = [...state.branch, entry]; return entry; };
  const sm = { getBranch: () => state.branch, getLeafId: () => state.branch.at(-1)?.id ?? null };
  const runtimes = [];
  const load = (instance = cwd) => {
    const registered = {}, handlers = {};
    const pi = { events: new EventEmitter(), registerTool: (t) => { registered[t.name] = t; }, on: (e, h) => { handlers[e] = h; },
      appendEntry: (customType, data) => push({ type: 'custom', customType, data }) };
    delegates(pi, { env: { ...env, MINA_INSTANCE_ID: instance } });
    runtimes.push(handlers);
    return registered;
  };
  const ctx = { cwd, model: faux.getModel(), modelRegistry: new ModelRegistry(runtime), tools, thinkingLevel: 'off', ...(sessionManager ? { sessionManager: sm } : {}) };
  let registered = load();
  const call = async (name, args) => {
    push({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name }] } });
    const out = await registered[name].execute(`call-${state.n}`, args, null, null, ctx);
    push({ type: 'message', message: { role: 'toolResult', toolName: name, content: out.content, details: out.details } });
    return out;
  };
  const reject = async (name, args, pattern) => {
    push({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name }] } });
    await assert.rejects(registered[name].execute('bad', args, null, null, ctx), pattern);
  };
  return { cwd, faux, ctx, state, call, reject, ledger: () => globalThis[LEDGER],
    reload: (instance) => { registered = load(instance); },
    shutdown: async () => { for (const h of runtimes) await h.session_shutdown?.(); rmSync(cwd, { recursive: true }); rmSync(agentDir, { recursive: true }); } };
}
export const body = (out) => JSON.parse(out.content[0].text);
export const until = async (check) => { for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(check()); };
export const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: e.message }));
export { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
