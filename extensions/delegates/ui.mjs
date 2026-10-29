// Presentation for mina's delegated children. The agent list above the editor, the fleet list below it and the
// conversation viewer are @tintinweb/pi-subagents' own components (MIT, pinned in package.json); the Agent tool rows
// follow its renderers. They read children only through the adapter below: live views of mina's records, an activity
// map fed from each child's events, and a session view whose messages have terminal controls stripped. Nothing here
// starts, discovers or loads anything; steer and stop go through the runtime's own owner checks.
import { Container, Text } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import { AgentWidget, SPINNER, describeActivity, fgPreservingNestedStyles, formatMs, formatTokens, formatTurns }
  from '@tintinweb/pi-subagents/dist/ui/agent-widget.js';
import { FleetList } from '@tintinweb/pi-subagents/dist/ui/fleet-list.js';
import { getAgentConfig, registerAgents } from '@tintinweb/pi-subagents/dist/agent-types.js';
import { hasAgentBadge, renderAgentName } from '@tintinweb/pi-subagents/dist/agent-color.js';

export const clean = (value) => stripVTControlCharacters(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
const lifetimeTotal = (u) => (u ? u.input + u.output + u.cacheWrite : 0);
const textOf = (message) => (Array.isArray(message?.content)
  ? message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : String(message?.content ?? ''));

// pi-subagents' statuses: a stop by the user is "stopped", the turn limit is "aborted", any other failure is "error".
export function viewStatus(r) {
  if (r.status === 'starting') return 'queued';
  if (r.status !== 'failed') return r.status;
  if (r.stopped) return 'stopped';
  return /turn limit/i.test(r.error ?? '') ? 'aborted' : 'error';
}

// A child's messages as the viewer shows them: copies with terminal controls removed, made once per message.
function sanitizedMessages(agent) {
  const cache = new WeakMap();
  const copy = (m) => {
    if (!m || typeof m !== 'object') return m;
    let out = cache.get(m);
    if (out) return out;
    const content = typeof m.content === 'string' ? clean(m.content) : Array.isArray(m.content)
      ? m.content.map((c) => (c?.type === 'text' ? { ...c, text: clean(c.text) } : c?.type === 'toolCall' ? { ...c, name: clean(c.name) } : c))
      : m.content;
    out = { ...m, content, ...(typeof m.command === 'string' ? { command: clean(m.command) } : {}),
      ...(typeof m.output === 'string' ? { output: clean(m.output) } : {}) };
    cache.set(m, out);
    return out;
  };
  return () => agent.state.messages.map(copy);
}

export function sessionView(agent) {
  const messages = sanitizedMessages(agent);
  return {
    get messages() { return messages(); },
    subscribe: (listener) => agent.subscribe(() => listener()),
    getSessionStats() {
      const assistant = agent.state.messages.filter((m) => m.role === 'assistant' && m.usage);
      const tokens = { input: 0, output: 0, cacheWrite: 0 };
      for (const { usage } of assistant) { tokens.input += usage.input; tokens.output += usage.output; tokens.cacheWrite += usage.cacheWrite; }
      const last = assistant.at(-1)?.usage;
      const window = agent.state.model?.contextWindow;
      const used = last ? last.input + last.output + last.cacheRead + last.cacheWrite : null;
      return { tokens, contextUsage: { percent: used !== null && window ? (100 * used) / window : null } };
    },
  };
}

export function createDelegateUI({ list, steer, stop }) {
  const activity = new Map();
  const views = new WeakMap();
  const types = new Map();
  const view = (r) => {
    let v = views.get(r);
    if (!v) {
      v = {
        get id() { return r.id; }, get type() { return r.type; }, get description() { return clean(r.description); },
        get status() { return viewStatus(r); }, get error() { return r.error === undefined ? undefined : clean(r.error); },
        get startedAt() { return r.startedAt ?? Date.now(); }, get completedAt() { return r.completedAt; },
        get toolUses() { return r.toolUses; }, get lifetimeUsage() { return r.lifetimeUsage; }, get compactionCount() { return 0; },
        get invocation() { return r.invocation; }, get isBackground() { return r.invocation?.runInBackground; },
        get session() { return r.view; },
      };
      views.set(r, v);
    }
    return v;
  };
  const manager = {
    listAgents: () => list().map(view).sort((a, b) => b.startedAt - a.startedAt),
    steer: (id, message) => { try { steer(id, message); } catch (error) { notify(error.message, 'warning'); } },
    abort: (id) => stop(id),
  };
  let ui;
  const notify = (message, level) => { try { ui?.notify(message, level); } catch { /* no UI */ } };
  const widget = new AgentWidget(manager, activity, () => 'all');
  const fleet = new FleetList(manager, activity);

  return {
    attach(ctx) {
      if (!ctx?.hasUI || !ctx.ui) return;
      ui = ctx.ui;
      widget.setUICtx(ctx.ui);
      fleet.setUICtx(ctx.ui);
    },
    turnStart() { widget.onTurnStart(); },
    // A child gets its display name (and an optional `color:`) from its type; pi-subagents' defaults stay registered.
    started(r) {
      if (!types.has(r.type)) {
        types.set(r.type, { name: r.type, displayName: r.type, color: r.color, description: '', extensions: false, skills: false, systemPrompt: '', promptMode: 'replace' });
        registerAgents(types);
      }
      if (!r.view) r.view = sessionView(r.agent);
      let a = activity.get(r.id);
      if (!a) {
        a = { activeTools: new Map(), responseText: '', get toolUses() { return r.toolUses; }, get turnCount() { return r.turns; },
          get maxTurns() { return r.maxTurns; }, get session() { return r.view; } };
        activity.set(r.id, a);
        r.agent.subscribe((event) => {
          if (event.type === 'tool_execution_start') a.activeTools.set(event.toolCallId, clean(event.toolName));
          else if (event.type === 'tool_execution_end') a.activeTools.delete(event.toolCallId);
          else if (event.type === 'message_start' && event.message?.role === 'assistant') a.responseText = '';
          else if (event.type === 'message_update' && event.message?.role === 'assistant') a.responseText = clean(textOf(event.message));
        });
      }
      a.activeTools.clear();
      a.responseText = '';
      widget.markRunning(r.id);
      // Without a UI the components never clear their repaint timers, which would keep the process alive.
      if (!ui) return;
      widget.ensureTimer();
      widget.update();
      fleet.ensureTimer();
      fleet.update();
    },
    finished(r) {
      activity.get(r.id)?.activeTools.clear();
      widget.markFinished(r.id);
      widget.update();
      fleet.onAgentFinished(r.id);
    },
    describe(id) { const a = activity.get(id); return a ? describeActivity(a.activeTools, a.responseText) : 'thinking…'; },
    dispose() { widget.dispose(); fleet.dispose(); },
  };
}

// ---- Tool rows (after pi-subagents' Agent renderers) ----

const short = (id) => clean(id).slice(0, 8);
// A type this process has not registered (a replayed session, a call still streaming) shows its own name, not "Agent".
const nameOf = (type, theme, style) => (getAgentConfig(type) ? renderAgentName(type, theme, style)
  : theme.fg(style.fallbackColor, style.bold ? theme.bold(type) : type));
const firstLine = (text, max = 160) => { const line = clean(text).split('\n').find((l) => l.trim())?.trim() ?? ''; return line.length > max ? `${line.slice(0, max)}…` : line; };

function stats(d, theme) {
  const parts = [];
  if (d.modelName) parts.push(clean(d.modelName));
  if (d.turns > 0) parts.push(formatTurns(d.turns, d.maxTurns));
  if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? '' : 's'}`);
  const tokens = lifetimeTotal(d.lifetimeUsage);
  if (tokens > 0) parts.push(formatTokens(tokens));
  return parts.map((p) => fgPreservingNestedStyles(theme, 'dim', p)).join(` ${theme.fg('dim', '·')} `);
}

export function renderAgentCall(args, theme, context) {
  const type = typeof args?.subagent_type === 'string' ? clean(args.subagent_type) : 'delegate';
  const rowBackground = hasAgentBadge(type) && typeof theme.getBgAnsi === 'function'
    ? theme.getBgAnsi(context?.isPartial ? 'toolPendingBg' : context?.isError ? 'toolErrorBg' : 'toolSuccessBg') : '';
  const description = typeof args?.description === 'string' ? clean(args.description) : '';
  const name = nameOf(type, theme, { fallbackColor: 'toolTitle', restoreBackground: rowBackground, bold: true });
  return new Text(`${rowBackground}▸ ${name}${description ? `  ${theme.fg('muted', description)}` : ''}`, 0, 0);
}

export function renderAgentResult(result, { expanded = false, isPartial = false } = {}, theme, context) {
  const d = result?.details;
  const text = clean(result?.content?.find((c) => c.type === 'text')?.text ?? '');
  if (context?.isError || !d?.status) return new Text(theme.fg(context?.isError ? 'error' : 'toolOutput', text), 0, 0);
  const s = stats(d, theme);
  const status = viewStatus(d);
  if (d.background && (status === 'running' || status === 'queued')) {
    return new Text(theme.fg('dim', `  ⎿  Running in background (ID: ${clean(d.id)})`), 0, 0);
  }
  if (isPartial || status === 'running' || status === 'queued') {
    const box = new Container();
    box.addChild(new Text(theme.fg('accent', SPINNER[(d.spinnerFrame ?? 0) % SPINNER.length]) + (s ? ` ${s}` : ''), 0, 0));
    box.addChild(new Text(theme.fg('dim', `  ⎿  ${clean(d.activity ?? 'thinking…')}`), 0, 0));
    return box;
  }
  const duration = d.startedAt && d.completedAt ? ` ${theme.fg('dim', '·')} ${theme.fg('dim', formatMs(d.completedAt - d.startedAt))}` : '';
  if (status === 'completed') {
    let line = theme.fg('success', '✓') + (s ? ` ${s}` : '') + duration;
    const body = clean(d.result ?? '');
    if (expanded && body) {
      const lines = body.split('\n');
      line += lines.slice(0, 50).map((l) => `\n${theme.fg('dim', `  ${l}`)}`).join('');
      if (lines.length > 50) line += `\n${theme.fg('muted', '  ... (get_subagent_result shows the full result)')}`;
    } else line += `\n${theme.fg('dim', '  ⎿  Done')}`;
    return new Text(line, 0, 0);
  }
  if (status === 'stopped') return new Text(`${theme.fg('dim', '■')}${s ? ` ${s}` : ''}${duration}\n${theme.fg('dim', '  ⎿  Stopped')}`, 0, 0);
  const why = status === 'aborted' ? theme.fg('warning', '  ⎿  Aborted (turn limit reached)') : theme.fg('error', `  ⎿  Error: ${firstLine(d.error ?? 'unknown', 400)}`);
  return new Text(`${theme.fg('error', '✗')}${s ? ` ${s}` : ''}${duration}\n${why}`, 0, 0);
}

// `label(id)` names a child this runtime knows ("delegate  description"); otherwise the row shows the short id.
export function renderChildCall(tool, args, theme, label) {
  const id = typeof args?.agent_id === 'string' ? args.agent_id : '';
  const known = id ? label(id) : null;
  const target = known ? `${nameOf(known.type, theme, { fallbackColor: 'accent' })}  ${theme.fg('muted', known.description)}`
    : theme.fg('accent', id ? short(id) : '…');
  const head = `${theme.fg('toolTitle', theme.bold(tool === 'steer_subagent' ? 'steer' : 'result'))} ${target}`;
  if (tool !== 'steer_subagent' || typeof args?.message !== 'string') return new Text(head, 0, 0);
  return new Text(`${head}\n${theme.fg('dim', `  ↳ ${firstLine(args.message)}`)}`, 0, 0);
}

export function renderChildResult(tool, result, { expanded = false } = {}, theme, context) {
  const d = result?.details;
  const text = clean(result?.content?.find((c) => c.type === 'text')?.text ?? '');
  if (context?.isError || !d) return new Text(theme.fg(context?.isError ? 'error' : 'toolOutput', firstLine(text, 400)), 0, 0);
  if (tool === 'steer_subagent') return new Text(theme.fg('dim', d.queued ? '  ⎿  Queued for the child' : `  ⎿  ${firstLine(text)}`), 0, 0);
  // get_subagent_result's other replies: a task's attempts, an unchanged revision, a page of the result.
  if (d.task) {
    const t = d.task, n = Array.isArray(t.attempts) ? t.attempts.length : 0;
    const by = Array.isArray(t.supersededBy) && t.supersededBy.length ? ` · superseded by ${t.supersededBy.map(clean).join(', ')}` : '';
    return new Text(theme.fg('dim', `  ⎿  Task ${clean(t.taskId)}: ${n} attempt${n === 1 ? '' : 's'}, latest ${clean(t.latest?.status ?? 'unknown')}${by}`), 0, 0);
  }
  if (d.unchanged) return new Text(theme.fg('dim', `  ⎿  Unchanged since revision ${Number(d.revision)} (${clean(d.status)})`), 0, 0);
  const row = renderAgentResult({ content: [], details: { ...d, background: false } }, { expanded }, theme, context);
  if (!Number.isSafeInteger(d.resultOffset) || typeof d.result !== 'string') return row;
  const end = d.resultOffset + d.result.length;
  const more = Number.isSafeInteger(d.nextOffset) ? `; more from offset ${d.nextOffset}` : '';
  const box = new Container();
  box.addChild(row);
  box.addChild(new Text(theme.fg('dim', `  ⎿  Characters ${d.resultOffset}–${end} of ${Number(d.resultChars)}${more}`), 0, 0));
  return box;
}
