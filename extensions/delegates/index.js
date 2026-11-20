// Small native delegation. Children receive an explicit tool subset, never discovery or host grants.
import { Agent } from '@earendil-works/pi-agent-core';
import { isContextOverflow, isRetryableAssistantError, retryDelayMs } from '@earendil-works/pi-ai';
import { SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { runFileOperation } from '../../sandbox/worker-client.mjs';
import { createSandboxTools } from '../sandbox/tools.mjs';
import { validateTrustedResources, sandboxSettingsFromEnv } from '../../sandbox/sandbox.mjs';
import { createDelegateUI, renderAgentCall, renderAgentResult, renderChildCall, renderChildResult, clean } from './ui.mjs';

const KEY = Symbol.for('mina:delegates');
const MANAGER = Symbol.for('pi-subagents:manager');
const EGRESS = Symbol.for('mina:worker-egress');
// Read-oriented research tools a child may inherit from the parent session, and only when its role declares them.
const RESEARCH = new Set(['research_search', 'web_fetch', 'literature_search', 'paper_resolve', 'paper_get', 'citation_expand', 'literature_db', 'supplement_get']);
// The model reads `value`; `extra` is display-only detail for the tool rows.
const result = (value, extra = {}) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: { ...value, ...extra } });
const schema = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });
const text = { type: 'string' };
const assistantText = (m) => m?.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') ?? '';
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const RUN_ID = /^[\x21-\x7e]{1,128}$/;
// Every child gets this, whatever its role file says.
const JUDGMENT = 'Use your own technical judgment. The brief states the objective; a method it suggests is not necessarily the best one. '
  + 'Say when an assumption in the brief is wrong, and propose a better approach when you have one. Report uncertainty and any verification you did not complete. '
  + 'Do not override a constraint that the brief gives as the operator\'s: report the conflict instead.';

// ---- Tool receipts: what the child's tools reported, counted from structured results, never from its prose. ----
// A structured `details.status` (or, failing that, `details.outcome`, as literature_db reports it) maps onto a small outcome
// vocabulary; anything else is "other". Tools without a structured outcome (read, write, bash) count calls and errors only.
// Output paths and result text are never consulted. Tool names and statuses come from the child model or a tool, so every
// table keyed by them is a Map or has no prototype: "__proto__" or "constructor" is an ordinary name, never an inherited slot.
const OUTCOMES = new Map(Object.entries({ ok: 'ok', ok_partial_text: 'partial', partial: 'partial', fulltext_unavailable: 'unavailable',
  unavailable: 'unavailable', unsupported: 'unsupported', not_found: 'not_found', empty: 'empty', invalid: 'invalid', ambiguous: 'ambiguous',
  expired: 'expired', error: 'error' }));
const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const PAPER_TOOLS = new Set(['paper_get', 'paper_resolve', 'literature_search', 'citation_expand']);
const SAMPLES = 5, SAMPLE_CHARS = 200;
const clip = (value, n) => clean(value).replace(/\s+/g, ' ').trim().slice(0, n);
export function classifyToolResult(name, res, isError) {
  if (isError) return { outcome: 'error' };
  const d = res?.details;
  if (!d || typeof d !== 'object') return {};
  const out = {};
  const status = own(d, 'status'), reported = own(d, 'outcome');
  if (own(d, 'unsupported')) out.outcome = 'unsupported';
  else if (typeof status === 'string') out.outcome = OUTCOMES.get(status.toLowerCase()) ?? 'other';
  else if (typeof status === 'number') out.outcome = status >= 200 && status < 300 ? (d.truncated ? 'partial' : 'ok') : 'error';
  else if (Array.isArray(d.calls) && Array.isArray(d.results)) out.outcome = d.calls.some((c) => c?.status === 'ok') || !d.calls.length ? 'ok' : 'unavailable';
  else if (typeof reported === 'string') out.outcome = OUTCOMES.get(reported.toLowerCase()) ?? 'other';
  const list = [d.results, d.passages, d.sections].find(Array.isArray);
  if (list && out.outcome !== 'error') out.items = list.length;
  if (out.outcome === 'not_found' && PAPER_TOOLS.has(name)) out.missing = d.paper ? 'section' : 'paper';
  if (out.outcome === 'unavailable' && d.fulltext?.temporary) out.temporary = true;
  const failed = Array.isArray(d.coverage?.backends_failed) ? d.coverage.backends_failed.length
    : Array.isArray(d.calls) ? d.calls.filter((c) => c?.status && c.status !== 'ok').length : 0;
  if (failed) out.backendFailures = failed;
  return out;
}
// `tools` is a Map while the child runs; the published copy is a prototype-free object with own data properties only.
const emptyReceipts = () => ({ calls: 0, errors: 0, tools: new Map(), error_samples: [] });
function toolTable(tools) {
  const out = Object.create(null);
  for (const [k, v] of tools instanceof Map ? tools : Object.entries(tools ?? {}))
    Object.defineProperty(out, k, { value: { ...v }, enumerable: true, writable: true, configurable: true });
  return out;
}
function recordReceipt(receipts, name, res, isError) {
  const tool = clip(typeof name === 'string' ? name : '', 64) || 'unknown';
  const c = classifyToolResult(tool, res, isError);
  let t = receipts.tools.get(tool);
  if (!t) receipts.tools.set(tool, t = { calls: 0 });
  const add = (k, n = 1) => { t[k] = (t[k] ?? 0) + n; };
  receipts.calls++; add('calls');
  if (c.outcome) add(c.outcome);
  if (c.temporary) add('temporary');
  if (c.missing) add(`missing_${c.missing}`);
  if (c.items !== undefined) { add('items', c.items); if (c.items === 0 && c.outcome === 'ok') add('zero_items'); }
  if (c.backendFailures) add('backend_failures', c.backendFailures);
  if (c.outcome === 'error') {
    receipts.errors++;
    const message = clip((Array.isArray(res?.content) ? res.content : []).filter((x) => x?.type === 'text').map((x) => x.text).join(' ') || 'error', SAMPLE_CHARS);
    receipts.error_samples = [...receipts.error_samples, { tool, message }].slice(-SAMPLES);
  }
}
const receiptSummary = (r) => {
  const x = r.receipts ?? emptyReceipts();
  const unfinished = (r.toolUses ?? 0) - x.calls;
  return { ...x, tools: toolTable(x.tools), error_samples: [...x.error_samples],
    ...(unfinished > 0 ? { unfinished } : {}) };
};

// ---- Command receipts: each bash run of the child, from the tool's structured result, never from the child's prose. ----
// `exited` with `exit_code` is what the shell reported. Exit 0 is not a test verdict: the assertions are in the output, which
// get_subagent_result returns for a run_id. Only the latest runs are listed; the counts cover every run.
const RECENT_RUNS = 8, COMMAND_CHARS = 200, CHILD_RETRIES = 2;
const emptyCommands = () => ({ total: 0, exited_0: 0, exited_nonzero: 0, no_exit: 0, runs: [] });
function startCommand(commands, runId, args) {
  commands.total++;
  commands.runs = [...commands.runs, { run_id: String(runId), command: clip(typeof args?.command === 'string' ? args.command : '', COMMAND_CHARS), status: 'running' }].slice(-RECENT_RUNS);
}
// A run without an exit status is interrupted when the child's run was aborted; otherwise it is classified from the status
// line that Pi's bash tool appends to the end of its error.
function endCommand(commands, runId, res, isError, aborted) {
  const s = res?.structuredContent;
  const tail = (Array.isArray(res?.content) ? res.content : []).filter((x) => x?.type === 'text').map((x) => x.text).join('\n').slice(-600);
  const exited = Number.isInteger(s?.exit_code);
  const status = exited ? 'exited' : aborted || /Command aborted/.test(tail) ? 'interrupted' : /Command timed out after/.test(tail) ? 'timed_out'
    : /terminated without an exit code/.test(tail) ? 'killed' : isError ? 'error' : 'no_exit_status';
  if (!exited) commands.no_exit++;
  else if (s.exit_code === 0) commands.exited_0++;
  else commands.exited_nonzero++;
  const run = commands.runs.find((x) => x.run_id === String(runId));
  if (run) Object.assign(run, { status, ...(exited ? { exit_code: s.exit_code } : {}),
    ...(typeof s?.wall_time_seconds === 'number' ? { seconds: s.wall_time_seconds } : {}),
    ...(typeof s?.full_output_path === 'string' ? { log: s.full_output_path } : {}) });
}
const commandSummary = (r) => (r.commands?.total ? { cwd: r.cwd, ...r.commands, runs: r.commands.runs.map((x) => ({ ...x })) } : undefined);
// One bash run in a list of messages: its command and its tool result.
function findRun(messages, runId) {
  let command, out;
  for (const m of messages) {
    if (m?.role === 'assistant' && Array.isArray(m.content)) for (const c of m.content) if (c?.type === 'toolCall' && c.id === runId) command = c.arguments?.command;
    if (m?.role === 'toolResult' && m.toolCallId === runId) out = m;
  }
  return out ? { command, out } : null;
}

// ---- Bounded result reads ----
// Offsets count UTF-16 code units (JavaScript string indices); a page never starts or ends inside a surrogate pair.
function page(textValue, offset, maxChars) {
  const total = textValue.length;
  if (offset > total) throw new Error(`offset ${offset} is beyond the result (${total} characters).`);
  const high = (i) => { const c = textValue.charCodeAt(i); return c >= 0xd800 && c <= 0xdbff; };
  const low = (i) => { const c = textValue.charCodeAt(i); return c >= 0xdc00 && c <= 0xdfff; };
  if (offset > 0 && offset < total && low(offset) && high(offset - 1))
    throw new Error(`offset ${offset} falls inside a surrogate pair (one astral character). Read from offset ${offset - 1}, or follow nextOffset from an earlier page.`);
  let end = maxChars === undefined ? total : Math.min(total, offset + maxChars);
  if (end < total && end > offset && high(end - 1)) end = end - 1 > offset ? end - 1 : end + 1;
  return { slice: textValue.slice(offset, end), next: end < total ? end : null };
}

export default function minaDelegates(pi, { env = process.env } = {}) {
  const instance = env.MINA_INSTANCE_ID ?? `direct-${process.pid}`;
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');
  let ledger = globalThis[KEY];
  if (!ledger || ledger.instance !== instance) globalThis[KEY] = ledger = { instance, admissions: 0, records: new Map() };
  const owner = randomUUID();
  const records = ledger.records;
  globalThis[MANAGER] = { getRecord: (id) => records.get(id) };
  let retired = false;
  // Lifecycle status is process state. Task and evidence completion are never inferred from the narrative or the receipts.
  // `termination` says how the child's run ended (normal, or the failure cause); it says nothing about the task.
  const outcome = (r) => ({ lifecycle: r.status, ...(r.termination ? { termination: r.termination } : {}), task: 'unknown', evidence: 'unknown' });
  const terminationOf = (r, last, thrown) => r.stopped ? 'stopped' : retired ? 'shutdown' : r.turnLimit ? 'turn_limit' : thrown ? 'exception'
    : last?.stopReason === 'length' ? 'output_limit' : last?.stopReason === 'aborted' ? 'aborted'
    : last?.stopReason === 'error' ? (isContextOverflow(last, r.agent?.state.model?.contextWindow ?? 0) ? 'context_overflow'
      : isRetryableAssistantError(last) ? 'transport' : 'provider_error') : 'other';
  const published = (r) => ({ id: r.id, description: r.description, type: r.type, status: r.status,
    result: r.result, error: r.error, stopReason: r.stopReason, maxTurns: r.maxTurns, requestedMaxTurns: r.requestedMaxTurns, maxTurnsNote: r.maxTurnsNote,
    turns: r.turns, tools: r.tools, transcript: r.transcript,
    requiredTools: r.requiredTools, taskId: r.taskId, supersedes: r.supersedes, revision: r.revision, resultRevision: r.resultRevision,
    receipts: receiptSummary(r), commands: commandSummary(r), retries: r.retries?.length ? r.retries.map((x) => ({ ...x })) : undefined, outcome: outcome(r) });
  const display = (r) => ({ startedAt: r.startedAt, completedAt: r.completedAt, toolUses: r.toolUses, lifetimeUsage: r.lifetimeUsage,
    stopped: r.stopped, modelName: r.invocation?.modelName });

  // The steer tool passes the session context: a child launched on another branch is not steered from this one. The viewer
  // (a person) passes none and may steer or stop any running child of this runtime.
  // Each refusal names its reason: a bare "no live child" made a parent conclude that its live children were lost.
  function steerChild(id, message, ctx) {
    const r = records.get(id);
    if (retired) throw new Error('No live child owned by this runtime: this runtime is shutting down.');
    if (!r) throw new Error(`No child or task "${id}" in this runtime. Steer with the id from the Agent receipt ("id"), or pass task_id.`);
    if (r.owner !== owner) throw new Error(`No live child owned by this runtime: ${id} belongs to an earlier runtime (a reload or another process), so it cannot be steered. Read it with get_subagent_result.`);
    if (r.status !== 'running') throw new Error(`Child ${id} is not running (${r.status}): there is nothing to steer. Read it with get_subagent_result.`);
    if (ctx && !branchView(ctx).launches.has(id)) throw new Error('This child was launched on another branch. Return to that branch to steer it, or start a new child here.');
    r.agent.steer({ role: 'user', content: [{ type: 'text', text: message }], timestamp: Date.now() });
  }
  // A stop from the viewer: only a running child of this runtime, and its partial work stays.
  function stopChild(id) {
    const r = records.get(id);
    if (retired || r?.owner !== owner || r.status !== 'running') return false;
    r.stopped = true;
    r.agent.abort();
    r.wake?.();
    return true;
  }
  const ui = createDelegateUI({ list: () => [...records.values()].filter((r) => r.owner === owner && r.agent), steer: steerChild, stop: stopChild });

  async function definition(type, cwd) {
    if (!/^[A-Za-z0-9_-]+$/.test(type)) throw new Error('Invalid agent type.');
    let body;
    // A project symlink must not read a controller credential as an agent definition.
    try { body = (await runFileOperation('read', { path: join(cwd, '.pi', 'agents', `${type}.md`) }, { cwd, env })).toString(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (body === undefined) {
      const path = join(agentDir, 'agents', `${type}.md`);
      validateTrustedResources([path], sandboxSettingsFromEnv(env, { cwd }).writable);
      try { body = readFileSync(path, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (body === undefined && !['delegate', 'independent', 'general-purpose', 'researcher'].includes(type)) throw new Error(`Unknown agent type: ${type}`);
    const front = body?.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const tools = front.match(/^tools:\s*(.+)$/m)?.[1].split(',').map((s) => s.trim());
    const turns = front.match(/^max_turns:\s*(\d+)\s*$/m)?.[1];
    return { prompt: body?.replace(/^---\n[\s\S]*?\n---\s*/, '') ?? 'Complete the assigned task. Report actual results and uncertainties.',
      tools: tools ?? (type === 'independent' ? ['read', 'grep', 'find', 'ls'] : type === 'researcher'
        ? ['read', 'grep', 'find', 'ls', ...RESEARCH] : ['read', 'write', 'edit', 'bash', ...RESEARCH]),
      maxTurns: Number(turns ?? 100), turnsFromFile: turns !== undefined, color: front.match(/^color:\s*(.+)$/m)?.[1].trim() };
  }

  // ---- Tasks on the current branch ----
  // A launch receipt (the Agent tool result's details) names its task and what it supersedes; a finished child leaves a
  // `subagents:record` entry. Both follow the branch, so an abandoned branch contributes nothing. A child of this runtime
  // whose launch result is not on the branch yet (a sibling call in the same turn) counts when the entry it was launched
  // from is on the branch. Live records add their current status but never make a historical child live again.
  // Without a session manager that reports both the branch and its leaf (some embeddings and tests), there is no branch to
  // consult: every child of this runtime counts as on the branch, and children of earlier runtimes never do.
  function branchView(ctx) {
    const sm = ctx?.sessionManager;
    const tracked = typeof sm?.getBranch === 'function' && typeof sm?.getLeafId === 'function';
    const branch = (typeof sm?.getBranch === 'function' ? sm.getBranch() : null) ?? [];
    const ids = new Set(branch.map((e) => e.id).filter(Boolean));
    const launches = new Map(), finished = new Map();
    for (const e of branch) {
      const m = e.type === 'message' ? e.message : null;
      if (m?.role === 'toolResult' && m.toolName === 'Agent' && typeof m.details?.id === 'string') {
        const d = m.details;
        if (!launches.has(d.id)) launches.set(d.id, { id: d.id, taskId: typeof d.taskId === 'string' ? d.taskId : d.id,
          supersedes: Array.isArray(d.supersedes) ? d.supersedes.filter((s) => typeof s === 'string') : [], record: d });
      } else if (e.type === 'custom' && e.customType === 'subagents:record' && typeof e.data?.id === 'string') finished.set(e.data.id, e.data);
    }
    for (const r of records.values()) {
      if (r.owner === owner && !launches.has(r.id) && (!tracked || (r.anchor && ids.has(r.anchor)))) launches.set(r.id, { id: r.id, taskId: r.taskId, supersedes: r.supersedes ?? [], record: r });
    }
    const tasks = new Map();
    const task = (id) => { let t = tasks.get(id); if (!t) tasks.set(id, t = { taskId: id, attempts: [], supersedes: [], supersededBy: [] }); return t; };
    for (const l of launches.values()) {
      const t = task(l.taskId);
      t.attempts.push(l.id);
      for (const s of l.supersedes) if (!t.supersedes.includes(s)) t.supersedes.push(s);
    }
    for (const t of tasks.values()) for (const s of t.supersedes) { const o = tasks.get(s); if (o && !o.supersededBy.includes(t.taskId)) o.supersededBy.push(t.taskId); }
    // The freshest view of a child: its live record, else its finished record on this branch, else its launch receipt.
    const current = (live) => (live.owner === owner ? published(live) : { ...published(live), historical: true });
    const latest = (id) => { const live = records.get(id); if (live && launches.has(id)) return current(live);
      return finished.get(id) ?? launches.get(id)?.record ?? null; };
    return { tracked, launches, finished, tasks, latest };
  }

  // The task or child each supersedes id names, or an actionable error. Refused before any reservation or request.
  function validateTask(args, ctx) {
    if (args.task_id !== undefined && (typeof args.task_id !== 'string' || !TASK_ID.test(args.task_id)))
      throw new Error('task_id must be 1-64 letters, digits, ".", "_", ":" or "-", starting with a letter or digit.');
    if (args.supersedes === undefined) return [];
    if (!Array.isArray(args.supersedes) || args.supersedes.length > 16 || args.supersedes.some((s) => typeof s !== 'string' || !TASK_ID.test(s)))
      throw new Error('supersedes must be an array of at most 16 task or child ids.');
    const view = branchView(ctx);
    // Only tasks and children on the current branch; a child of this runtime launched on another branch has no say here.
    const known = (s) => view.tasks.has(s) ? s : view.launches.get(s)?.taskId;
    const unknown = args.supersedes.filter((s) => !known(s));
    if (unknown.length) throw new Error(`Unknown task or child id in supersedes: ${unknown.join(', ')}. Name tasks recorded on the current branch. No child was started.`);
    const resolved = [...new Set(args.supersedes.map(known))];
    if (args.task_id && resolved.includes(args.task_id)) throw new Error('A task cannot supersede itself. Reuse task_id for a retry, or choose a new task_id.');
    // A direct or indirect cycle (B supersedes A, then A supersedes B) would leave every task in it looking obsolete.
    if (args.task_id) for (const root of resolved) {
      const seen = new Set(), stack = [[root, [root]]];
      while (stack.length) {
        const [s, path] = stack.pop();
        if (seen.has(s)) continue;
        seen.add(s);
        for (const next of view.tasks.get(s)?.supersedes ?? []) {
          if (next === args.task_id) throw new Error(`Supersession cycle: ${[args.task_id, ...path, next].join(' -> ')}. Task ${root} already supersedes ${args.task_id}. Retry ${args.task_id} without supersedes, or start a new task_id. No child was started.`);
          stack.push([next, [...path, next]]);
        }
      }
    }
    return resolved;
  }

  function validateRequired(args) {
    if (args.required_tools === undefined) return undefined;
    if (!Array.isArray(args.required_tools) || args.required_tools.length > 32 || args.required_tools.some((n) => typeof n !== 'string' || !TOOL_NAME.test(n)))
      throw new Error('required_tools must be an array of tool names (at most 32). No child was started.');
    return [...new Set(args.required_tools)];
  }
  // Compares the requirement with the tools the child will actually have. Never adds a tool.
  function checkRequired(required, actual, type, declared) {
    const missing = (required ?? []).filter((n) => !actual.includes(n));
    if (!missing.length) return;
    const undeclared = missing.filter((n) => !declared?.includes(n)), unavailable = missing.filter((n) => declared?.includes(n));
    const parts = [`Child type "${type}" lacks required tools: ${missing.join(', ')}. Its tools: ${actual.join(', ') || 'none'}.`];
    if (unavailable.length) parts.push(`Declared by the role but not available in this session: ${unavailable.join(', ')}.`);
    if (undeclared.length) parts.push(`${undeclared.some((n) => RESEARCH.has(n)) ? 'For literature or web research use subagent_type "researcher", or ' : 'Use '}a project/user role whose tools: line lists ${undeclared.join(', ')}.`);
    parts.push('No child was started and no model request was made.');
    throw new Error(parts.join(' '));
  }

  // A task id is reserved from the first synchronous check until its child record exists, so two simultaneous launches (or a
  // launch and a resume) of one task cannot both pass the running-child check while a definition loads.
  const reserved = new Set();
  function taskBusy(taskId, except) {
    if (reserved.has(taskId)) throw new Error(`Task ${taskId} already has a child starting. Wait for its launch receipt; steer, wait for or stop it before a retry.`);
    const busy = [...records.values()].find((x) => x.owner === owner && x.taskId === taskId && x.status === 'running' && x.id !== except);
    if (busy) throw new Error(`Task ${taskId} already has a running child (${busy.id}). Steer it, wait for it, or stop it before a retry.`);
  }

  async function launch(args, ctx, onUpdate) {
    if (retired) throw new Error('This delegation runtime is retired.');
    if (args.isolation && args.isolation !== 'off') throw new Error('Automatic worktree isolation is not supported. Assign separate files or prepare a worktree first.');
    const required = validateRequired(args);
    const live = [...records.values()].filter((r) => r.status === 'running');
    if (live.length + (ledger.pending ?? 0) >= 4) throw new Error('Four children already run in this instance. Wait for one to finish.');
    let r = args.resume && records.get(args.resume);
    if (args.resume && (!r || r.owner !== owner)) throw new Error('Cannot resume a historical child as live authority. Start a new child within the instance allowance.');
    if (r?.status === 'running') throw new Error('Child still runs. Use steer_subagent.');
    if (r) {
      if (!branchView(ctx).launches.has(r.id)) throw new Error('This child was launched on another branch and has no authority here. Start a new child on this branch. No model request was made.');
      if (args.task_id !== undefined && args.task_id !== r.taskId) throw new Error(`A resumed child keeps its task (${r.taskId}). Start a new child for another task.`);
      if (args.supersedes !== undefined) throw new Error('A resumed child cannot supersede tasks. Start a new child with supersedes.');
      taskBusy(r.taskId, r.id);
      if (r.turns >= r.maxTurns) throw new Error(`Child ${r.id} has no turns remaining (${r.turns}/${r.maxTurns}). `
        + `Start a new child with task_id: "${r.taskId}" and brief it on the partial work. No model request was made.`);
      checkRequired(required, r.tools, r.type, r.declaredTools);
      if (required) r.requiredTools = required;
      const asked = args.max_turns !== undefined && args.max_turns !== r.maxTurns;
      r.requestedMaxTurns = asked ? args.max_turns : undefined;
      r.maxTurnsNote = asked ? `max_turns ${args.max_turns} was ignored: a resumed child keeps the turn limit of its first launch `
        + `(${r.maxTurns}, ${r.turns} used). For a different limit, start a new child with the same task_id, within the role's ceiling.` : undefined;
    } else {
      let supersedes = validateTask(args, ctx);
      const taskId = args.task_id;
      if (taskId) taskBusy(taskId);
      if (ledger.admissions >= 64) throw new Error('Instance child-start allowance exhausted (64). A handoff does not reset it.');
      // Reserve before async definition loading so concurrent starts cannot evade the cap or share a task. Any failure before
      // the child record exists returns the admission (no child, no provider request) and frees the task id.
      ledger.admissions++;
      ledger.pending = (ledger.pending ?? 0) + 1;
      if (taskId) reserved.add(taskId);
      let created = false;
      try {
      const type = args.subagent_type ?? 'delegate';
      const d = await definition(type, ctx.cwd);
      if (retired) throw new Error('Delegation runtime retired before launch.');
      // Another task's launch may have committed while the definition loaded (B supersedes A beside A supersedes B). Check the
      // graph again now; nothing below awaits before the record is committed, so the next launch to resume sees this one.
      supersedes = validateTask(args, ctx);
      // The role sets the ceiling; a call can only lower it. A request above it is reduced, and the receipt says so.
      const ceiling = Math.min(200, d.maxTurns);
      const maxTurns = Math.min(ceiling, args.max_turns ?? ceiling);
      if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('max_turns must be a positive integer.');
      const reduced = args.max_turns > maxTurns;
      const why = d.maxTurns > 200 ? "Mina's 200-turn maximum" : d.turnsFromFile ? 'max_turns in its role file'
        : "Mina's default for a role whose file sets no max_turns";
      const model = args.model ? (() => {
        const slash = args.model.indexOf('/');
        return ctx.modelRegistry.find(slash < 0 ? ctx.model.provider : args.model.slice(0, slash), slash < 0 ? args.model : args.model.slice(slash + 1));
      })() : ctx.model;
      if (!model) throw new Error('Requested child model is unavailable. No provider request was made.');
      const defs = createSandboxTools({ cwd: ctx.cwd, env, getEgressSocket: () => globalThis[EGRESS]?.() ?? null });
      const tools = defs.filter((t) => d.tools.includes(t.name));
      // Existing research transports remain intact. Only these read-oriented tools can be inherited.
      for (const t of ctx.tools ?? []) if (RESEARCH.has(t.name) && d.tools.includes(t.name)) tools.push(t);
      // A requirement the selected tools do not meet refuses the launch here, before any transcript or provider request.
      // The refused launch is not a child start, so its reservation is returned (below).
      checkRequired(required, tools.map((t) => t.name), type, d.tools);
      // A bare Agent skips Pi's session request setup. Use the parent session's effective settings and Pi's timeout precedence.
      const settings = SettingsManager.inMemory(pi.getSettings?.() ?? {});
      const idle = settings.getHttpIdleTimeoutMs();
      const timeoutMs = settings.getProviderRetrySettings().timeoutMs ?? (idle === 0 ? 2_147_483_647 : idle);
      const websocketConnectTimeoutMs = settings.getWebSocketConnectTimeoutMs();
      const store = SessionManager.create(ctx.cwd, join(agentDir, 'mina-subagents'));
      const id = randomUUID();
      r = { id, owner, type, description: args.description ?? type, status: 'starting', maxTurns,
        requestedMaxTurns: reduced ? args.max_turns : undefined,
        maxTurnsNote: reduced ? `max_turns ${args.max_turns} was reduced to ${maxTurns}: the ${type} role allows at most ${ceiling} turns `
          + `(${why}). A call can lower a role's turn limit, never raise it.` : undefined,
        turns: 0, toolUses: 0, compactionCount: 0, tools: tools.map((t) => t.name), transcript: store.getSessionFile(), color: d.color,
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 }, declaredTools: d.tools, requiredTools: required,
        taskId: taskId ?? id, supersedes, revision: 0, resultRevision: 0, receipts: emptyReceipts(), anchor: ctx.sessionManager?.getLeafId?.() ?? null,
        cwd: ctx.cwd, commands: emptyCommands(), retry: settings.getRetrySettings() };
      const record = r;
      const agent = new Agent({ initialState: { model, thinkingLevel: args.thinking ?? ctx.thinkingLevel ?? 'off', tools,
        systemPrompt: `${d.prompt}\nYou are a bounded child in ${ctx.cwd}. Use only your declared tools. You have no host grants, compaction or handoff. Preserve partial work and report it.\n${JUDGMENT}`,
        messages: args.inherit_context ? (ctx.sessionManager.getBranch() ?? []).filter((e) => e.type === 'message' && e.message?.role !== 'system').map((e) => e.message) : [] },
        streamFn: (m, c, options) => {
          if (retired || record.turns >= record.maxTurns) {
            record.turnLimit = !retired;
            throw new Error(`Child turn limit reached (${record.maxTurns}); partial results retained.`);
          }
          record.turns++;
          return ctx.modelRegistry.streamSimple(m, c, { ...options, timeoutMs: options?.timeoutMs ?? timeoutMs,
            websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs ?? websocketConnectTimeoutMs });
        } });
      r.agent = agent;
      r.session = { get messages() { return agent.state.messages; },
        getContextUsage: () => { const m = agent.state.messages.filter((v) => v.role === 'assistant').at(-1);
          return { tokens: m?.usage ? m.usage.input + m.usage.output + m.usage.cacheRead + m.usage.cacheWrite : null }; },
        abort: async () => { agent.abort(); await agent.waitForIdle(); } };
      agent.subscribe((event) => {
        // Tool progress is observable (toolUses, receipts, unfinished), so it moves the revision; the result text does not change.
        if (event.type === 'tool_execution_start') { record.toolUses++; record.revision++; if (event.toolName === 'bash') startCommand(record.commands, event.toolCallId, event.args); }
        if (event.type === 'tool_execution_end') {
          recordReceipt(record.receipts, event.toolName, event.result, event.isError);
          if (event.toolName === 'bash') endCommand(record.commands, event.toolCallId, event.result, event.isError, record.agent?.signal?.aborted === true);
          record.revision++;
        }
        if (event.type === 'message_end') store.appendMessage(event.message);
        const usage = event.type === 'message_end' && event.message?.role === 'assistant' ? event.message.usage : null;
        if (usage) for (const k of ['input', 'output', 'cacheWrite', 'cacheRead']) record.lifetimeUsage[k] += usage[k] ?? 0;
        if (usage?.cost?.total) record.lifetimeUsage.cost += usage.cost.total;
      });
      r.invocation = { modelName: model.name ?? model.id, modelId: `${model.provider}/${model.id}`, thinking: agent.state.thinkingLevel,
        maxTurns, inheritContext: !!args.inherit_context, runInBackground: args.run_in_background !== false };
      records.set(r.id, r);
      created = true;
      } finally {
        ledger.pending--;
        if (taskId) reserved.delete(taskId);
        if (!created) ledger.admissions--;
      }
    }
    r.status = 'running'; r.error = undefined; r.stopReason = undefined; r.stopped = false; r.startedAt = Date.now(); r.completedAt = undefined; r.revision++;
    r.termination = undefined; r.turnLimit = false; r.retries = [];
    if (r.invocation) r.invocation.runInBackground = args.run_in_background !== false;
    pi.events.emit('subagents:started', { id: r.id });
    ui.attach(ctx);
    ui.started(r);
    const record = r;
    const start = r.agent.state.messages.length;
    const finish = (error) => {
      // Inspect this run only: an earlier report (or an inherited parent message) is not a new result.
      const replies = record.agent.state.messages.slice(start).filter((m) => m.role === 'assistant');
      const last = replies.at(-1);
      record.stopReason = last?.stopReason;
      const cutoff = record.stopReason === 'length';
      record.result = cutoff ? assistantText(last) : replies.map(assistantText).filter(Boolean).at(-1) ?? '';
      const recovery = record.turns < record.maxTurns
        ? `Use Agent with resume: "${record.id}" to continue this child.`
        : `No turns remain. Start a new child with task_id: "${record.taskId}" and brief it on the partial work.`;
      record.error = error || record.agent.state.errorMessage || last?.errorMessage
        || (record.stopped ? 'Stopped by the user; partial results retained.' : undefined)
        || (cutoff ? `The model hit its output limit. ${recovery}` : undefined)
        || (record.stopReason === 'error' ? 'The model request failed.' : undefined)
        || (record.stopReason === 'aborted' ? 'The model request was aborted.' : undefined);
      record.status = record.error ? 'failed' : 'completed';
      record.termination = record.error ? terminationOf(record, last, error) : 'normal';
    };
    r.run = drive(record, () => record.agent.prompt(args.prompt)).then(() => finish(), (error) => finish(error?.message || String(error))).finally(() => {
      record.completedAt = Date.now();
      record.revision++;
      record.resultRevision = record.revision;
      pi.appendEntry('subagents:record', published(record));
      pi.events.emit(record.status === 'completed' ? 'subagents:completed' : 'subagents:failed', published(record));
      ui.finished(record);
    });
    if (args.run_in_background === false) {
      let frame = 0;
      const tick = () => onUpdate?.({ content: [{ type: 'text', text: '' }],
        details: { ...published(record), ...display(record), spinnerFrame: frame++, activity: ui.describe(record.id) } });
      const timer = onUpdate ? setInterval(tick, 120) : null;
      try { await r.run; } finally { if (timer) clearInterval(timer); }
      return result(published(r), display(r));
    }
    return result({ ...published(r), message: 'Started in background. Completion notification follows; do not poll.' }, { ...display(r), background: true });
  }

  // A model request that failed in transport (Pi's own classification; never a context overflow, a usage limit or the
  // turn limit) is sent again, at most CHILD_RETRIES times, after Pi's backoff. A failed reply ran none of its tool calls:
  // only that reply is dropped from the child's context, and its completed tool results stay. The transcript keeps it.
  // A retried request does not use a turn. A stop or a shutdown during the backoff ends the run with the failure.
  async function drive(record, first) {
    await first();
    const policy = record.retry ?? { enabled: false };
    const max = policy.enabled ? Math.min(CHILD_RETRIES, policy.maxRetries ?? CHILD_RETRIES) : 0;
    for (let attempt = 1; attempt <= max; attempt++) {
      const messages = record.agent.state.messages, last = messages.at(-1);
      if (retired || record.stopped || record.turnLimit || last?.role !== 'assistant' || !isRetryableAssistantError(last)
        || isContextOverflow(last, record.agent.state.model?.contextWindow ?? 0)) return;
      record.retries.push({ attempt, error: clip(last.errorMessage, SAMPLE_CHARS) });
      record.revision++;
      await new Promise((done) => { const t = setTimeout(done, retryDelayMs(policy, attempt)); record.wake = () => { clearTimeout(t); done(); }; });
      record.wake = undefined;
      if (retired || record.stopped) return;
      record.agent.state.messages = messages.slice(0, -1);
      record.turns--;
      await record.agent.continue();
    }
  }

  // ---- get_subagent_result ----
  const nonNegative = (v, name, min = 0) => { if (v !== undefined && (!Number.isSafeInteger(v) || v < min)) throw new Error(`${name} must be an integer of at least ${min}.`); };
  async function readResult(args, ctx) {
    if (args.task_id !== undefined) {
      if (args.agent_id !== undefined) throw new Error('Give agent_id or task_id, not both.');
      return readTask(args.task_id, ctx);
    }
    if (typeof args.agent_id !== 'string' || !args.agent_id) throw new Error('Give agent_id or task_id.');
    nonNegative(args.offset, 'offset'); nonNegative(args.max_chars, 'max_chars', 1);
    if (args.run_id !== undefined) {
      if (typeof args.run_id !== 'string' || !RUN_ID.test(args.run_id)) throw new Error('run_id must be a run_id from the child\'s commands receipt.');
      if (args.summary_only || args.since_revision !== undefined || args.revision !== undefined) throw new Error('run_id reads one command\'s output; drop summary_only, since_revision and revision.');
    }
    nonNegative(args.since_revision, 'since_revision'); nonNegative(args.revision, 'revision');
    const paged = args.offset !== undefined || args.max_chars !== undefined;
    if (args.summary_only && paged) throw new Error('summary_only returns no result text; drop offset and max_chars, or drop summary_only.');
    const live = records.get(args.agent_id);
    const view = branchView(ctx);
    let value, extra;
    if (live?.owner === owner && view.launches.has(live.id)) {
      if (args.wait) await live.run;
      value = published(live); extra = display(live);
    } else if (live?.owner === owner) {
      // This runtime's child from another branch: readable for diagnostics, never live authority here (no wait, steer or resume).
      value = { ...published(live), historical: true, off_branch: true }; extra = display(live);
    } else {
      // A child of an earlier runtime (another process, or a reload of this one): its last record on the current branch,
      // read-only. It cannot be resumed, steered or waited on. Another runtime's in-memory record is shown only when this
      // branch launched it, or when there is no branch to consult.
      const old = view.finished.get(args.agent_id) ?? (live && (view.launches.has(live.id) || !view.tracked) ? published(live) : null);
      if (!old) throw new Error('Child not found in this instance or on the current branch. Consult the recorded transcript.');
      value = { ...old, historical: true }; extra = {};
    }
    if (args.run_id !== undefined) return readRun(args, value, live?.owner === owner ? live : null, extra);
    const full = typeof value.result === 'string' ? value.result : '';
    const resultChars = full.length;
    if (args.since_revision !== undefined && value.revision !== undefined && args.since_revision === value.revision)
      return result({ id: value.id, status: value.status, revision: value.revision, resultChars, unchanged: true }, extra);
    if (args.summary_only) { const { result: _omit, ...rest } = value; return result({ ...rest, resultChars }, extra); }
    if (!paged) return result({ ...value, resultChars }, extra);
    // Tool progress moves `revision` without touching the result text; `resultRevision` marks the last change of the text. A
    // page read at revision N stays consistent while N >= resultRevision. Older records without the mark need an exact match.
    if (args.revision !== undefined && value.revision !== undefined
      && (args.revision > value.revision || args.revision < (Number.isSafeInteger(value.resultRevision) ? value.resultRevision : value.revision)))
      throw new Error(`The result changed (revision ${args.revision} is now ${value.revision}). Read again from offset 0.`);
    const offset = args.offset ?? 0;
    const { slice, next } = page(full, offset, args.max_chars);
    return result({ ...value, result: slice, resultOffset: offset, resultChars, nextOffset: next }, extra);
  }
  // The full output of one bash run: from the live child's context, else from the child's transcript under mina-subagents.
  function readRun(args, value, live, extra) {
    let messages = live?.agent?.state.messages;
    let found = messages && findRun(messages, args.run_id);
    if (!found && typeof value.transcript === 'string') {
      const root = resolve(agentDir, 'mina-subagents'), path = resolve(value.transcript), rel = relative(root, path);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
        try {
          messages = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter((e) => e?.type === 'message').map((e) => e.message);
          found = findRun(messages, args.run_id);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    if (!found) throw new Error(`No command run ${args.run_id} in child ${value.id}. Use a run_id from its commands receipt.`);
    const output = (Array.isArray(found.out.content) ? found.out.content : []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
    const receipt = value.commands?.runs?.find((x) => x.run_id === args.run_id);
    const { slice, next } = page(output, args.offset ?? 0, args.max_chars);
    return result({ id: value.id, run_id: args.run_id, command: typeof found.command === 'string' ? found.command : undefined,
      ...(receipt ? { status: receipt.status, exit_code: receipt.exit_code, log: receipt.log } : {}), isError: found.out.isError === true,
      output: slice, outputOffset: args.offset ?? 0, outputChars: output.length, nextOffset: next }, extra);
  }
  function readTask(taskId, ctx) {
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw new Error('task_id is not a valid task id.');
    const view = branchView(ctx);
    const t = view.tasks.get(taskId);
    if (!t) throw new Error(`No task ${taskId} on the current branch.`);
    const brief = (id) => { const d = view.latest(id) ?? { id };
      return { id, status: d.status, ...(d.error ? { error: clip(d.error, 400) } : {}), description: d.description, revision: d.revision }; };
    const last = view.latest(t.attempts.at(-1));
    const { result: text, ...latest } = last ?? {};
    const attempts = t.attempts.slice(-20).map(brief);
    return result({ task: { taskId, supersedes: t.supersedes, supersededBy: t.supersededBy,
      attempts, ...(t.attempts.length > 20 ? { olderAttempts: t.attempts.length - 20 } : {}),
      latest: { ...latest, resultChars: typeof text === 'string' ? text.length : 0, outcome: latest.outcome ?? { lifecycle: latest.status, task: 'unknown', evidence: 'unknown' } } } });
  }

  // A delegate's name and description for the steer/result rows, when this runtime knows the child.
  const label = (id) => { const r = records.get(id); return r ? { type: clean(r.type), description: clean(r.description) } : null; };

  pi.registerTool({ name: 'Agent', label: 'Agent',
    description: 'Run delegate, independent, researcher, or a project/user role. Children use explicit safe tools. Four concurrent children, 64 starts per launcher. No child host access or executable resource discovery. '
      + 'For literature or web research use subagent_type "researcher" or pass required_tools (for example ["literature_search","paper_get"]): a launch whose child would lack a required tool fails before any model request. '
      + 'The receipt lists the actual tools, tool receipts (counts by outcome) and a lifecycle status; completed means the child stopped, not that its task or evidence is complete. '
      + 'outcome.termination is normal or the failure cause (output_limit, transport, provider_error, context_overflow, turn_limit, stopped, aborted, shutdown, exception). '
      + 'A transport failure is retried twice at most, without replaying tool calls; retries lists them. '
      + 'commands lists the latest bash runs with status and exit_code: exit 0 is not a verified test pass; read the output with get_subagent_result run_id. '
      + 'Brief a child with the objective, the constraints (include the operator\'s standing constraints that apply) and the evidence you want; leave the method to the child unless it is a constraint. The child may disagree with the brief. '
      + 'task_id names a task (reuse it for a retry); supersedes records that this child replaces earlier tasks without changing their history.',
    parameters: schema({ prompt: text, description: text, subagent_type: text, model: text, thinking: text,
      max_turns: { type: 'integer', minimum: 1, maximum: 200, description: "Turn limit for the child. The role's max_turns (default 100, at most 200) is a ceiling: "
        + 'a call can lower it, never raise it. A larger request runs at the ceiling and the receipt shows requestedMaxTurns and maxTurnsNote. '
        + 'A resumed child keeps the limit of its first launch.' }, run_in_background: { type: 'boolean' },
      inherit_context: { type: 'boolean' },
      resume: { ...text, description: 'Child id from this runtime and branch. Continue with its existing context, tools, and remaining turns. Use task_id for a new attempt if no turns remain.' },
      isolation: text,
      required_tools: { type: 'array', items: text, maxItems: 32, description: 'Tools the child must have. Checked against its actual tools before launch; never grants a tool.' },
      task_id: { ...text, description: 'Stable task id (1-64 of A-Z a-z 0-9 . _ : -). Defaults to the child id. Reuse for a retry of the same task.' },
      supersedes: { type: 'array', items: text, maxItems: 16, description: 'Task or child ids on the current branch that this child replaces. Their records stay; they are not marked done.' } },
    ['prompt', 'description']),
    renderCall: renderAgentCall,
    renderResult: renderAgentResult,
    execute: (_id, args, _signal, update, ctx) => launch(args, ctx, update) });
  pi.registerTool({ name: 'get_subagent_result', label: 'Child result',
    description: 'Read a child result. Background completion sends a notification; do not poll. For a status check use summary_only (status, receipts, revision, result length; no text). '
      + 'Default returns the full result. Large results: page with offset and max_chars, follow nextOffset until null and pass revision to refuse a page from a changed result. '
      + 'since_revision returns a short "unchanged" reply when nothing changed. task_id returns a task\'s attempts and supersession on the current branch. '
      + 'run_id (from the commands receipt) returns that bash run\'s command and output, paged with offset and max_chars.',
    parameters: schema({ agent_id: text, task_id: text, wait: { type: 'boolean' },
      run_id: { ...text, description: 'A run_id from the child\'s commands receipt: return that bash run\'s output instead of the result.' },
      summary_only: { type: 'boolean', description: 'Omit the result text; return status, receipts, revision and resultChars.' },
      offset: { type: 'integer', minimum: 0, description: 'Start of a result page, in UTF-16 code units.' },
      max_chars: { type: 'integer', minimum: 1, description: 'Page length; the reply gives nextOffset (null at the end) and resultChars.' },
      since_revision: { type: 'integer', minimum: 0, description: 'Revision you already hold; an unchanged child returns only its status.' },
      revision: { type: 'integer', minimum: 0, description: 'With offset: the revision of earlier pages. A changed result fails instead of mixing pages.' } }),
    execute: async (_id, args, _signal, _update, ctx) => readResult(args, ctx),
    renderCall: (args, theme) => renderChildCall('get_subagent_result', args, theme, label),
    renderResult: (res, options, theme, context) => renderChildResult('get_subagent_result', res, options, theme, context) });
  pi.registerTool({ name: 'steer_subagent', label: 'Steer child', description: 'Queue guidance for a running child without changing its authority or limits.',
    parameters: schema({ agent_id: { ...text, description: 'The child id from the Agent receipt. A task id also works: it steers that task\'s latest child.' },
      task_id: { ...text, description: 'Steer the latest child of this task on the current branch.' }, message: text }, ['message']),
    execute: async (_id, args, _signal, _update, ctx) => {
      if (args.agent_id !== undefined && args.task_id !== undefined) throw new Error('Give agent_id or task_id, not both.');
      const key = args.task_id ?? args.agent_id;
      if (typeof key !== 'string' || !key) throw new Error('Give agent_id or task_id.');
      // A task id resolves to its latest child on this branch; a child id is used as it is.
      const task = args.task_id !== undefined || !records.has(key) ? branchView(ctx ?? {}).tasks.get(key) : null;
      if (args.task_id !== undefined && !task) throw new Error(`No task "${key}" on the current branch.`);
      const id = task ? task.attempts.at(-1) : key;
      steerChild(id, args.message, ctx ?? {});
      return result({ queued: true, agent_id: id, ...(task ? { task_id: key } : {}) });
    },
    renderCall: (args, theme) => renderChildCall('steer_subagent', args, theme, label),
    renderResult: (res, options, theme, context) => renderChildResult('steer_subagent', res, options, theme, context) });
  // The list and fleet need the session's UI; a parent tool call also ages finished rows out of the list.
  pi.on('session_start', (_event, ctx) => { ui.attach(ctx); });
  pi.on('tool_execution_start', (_event, ctx) => { ui.attach(ctx); ui.turnStart(); });
  pi.on('session_shutdown', async () => {
    retired = true;
    ui.dispose();
    const owned = [...records.values()].filter((r) => r.owner === owner && r.status === 'running');
    for (const r of owned) { r.agent.abort(); r.wake?.(); }
    await Promise.all(owned.map((r) => r.run));
  });
}
