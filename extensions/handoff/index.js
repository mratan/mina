// mina handoff: when the context is nearly full, the agent writes a handoff note and the work continues in a fresh
// session that starts with a packet built from it (docs/architecture.md). It runs inside Pi, without a supervisor:
// - compaction is pi-hot-compact's (loaded beside this extension, its thresholds set by the launcher from the tuning file);
// - a handoff is due at handoff_at tokens, or at compact_at once the session was compacted max_compactions times;
// - it happens at a boundary: when the next input arrives (a pi-goal continuation, or the user's message), that input is
//   replaced by a request for the note; inside a long run, after a turn, the request goes in as a steering message. The agent then calls mina_handoff_note (its prompt cache is warm, so this
//   is cheap even on a local model). Without a note, the packet falls back to the last compaction summary;
// - /mina-handoff creates the successor with Pi's newSession (parentSession set), writes a marker, mina's goal state and
//   the packet, and continues an active goal there with `/goal mina-continue` (a fresh pi-goal run for the same
//   goal in the successor). Input that arrived during the handoff is carried over. Without a goal or carried input, a
//   run that the note request interrupted in its tool loop is resumed with RESUME_REQUEST, so the handoff is invisible;
// - mina_recall searches this session and the earlier ones for exact text.
// Pi re-creates extensions on newSession, so everything the successor needs is written into the new session file.
// Subagents run inside this Pi process and a new session stops them. So when subagents are running once the note is
// recorded, the handoff happens in place: at the next boundary mina commits a compaction that keeps nothing, followed by the
// packet, and the session, its goal run and its subagents carry on. A handoff that finds no subagent running opens a new
// session, so a fresh session file comes with the next handoff after the subagents are done; nothing waits for that.
// Only /mina-handoff, which asks for a new session, still waits for running subagents (or stops them with "force").
import { existsSync } from 'node:fs';
import { readdirSync, readFileSync } from '../../sandbox/project-fs.mjs';
import { join } from 'node:path';
import { loadTuning, readModelTuning } from '../../lib/model-tuning.mjs';
export { loadTuning } from '../../lib/model-tuning.mjs';
import { thresholds, carriedGoal, tuningForModel, poolBudget, poolThresholds, spawnFits, handoffDue, renderPacket, compactionRestatement, workInProgress, NOTE_REQUEST, GOAL_CONTINUATION_MARKER } from './policy.mjs';
import { installLedger, LEDGER } from './ledger.mjs';
import { oneDialog } from '../../lib/dialog-lock.mjs';
import { lineage, search, readEntry } from './recall.mjs';
import { hashCheckFiles, changedFiles } from '../goal/check-files.mjs';
import { manager, maxTurnsFor, toolsFor, childStatus, nearLimits, describeChild, reserveUnits, limitsText, warningText } from './subagents.mjs';
import { homedir } from 'node:os';
import { record } from './metrics.mjs';
import { stripOldReasoning } from './reasoning.mjs';

export const MARKER = 'mina-handoff';
export const NOTE_ENTRY = 'mina-handoff-note';
// A recorded note that a handoff to a new session used, or that the user discarded after a restart.
export const NOTE_SPENT = 'mina-handoff-note-spent';
// An in-place handoff: its marker (counting starts afresh after it) and the packet message that follows its compaction.
export const IN_PLACE = 'mina-handoff-in-place';
export const PACKET_ENTRY = 'mina-handoff-packet';
export const IN_PLACE_SUMMARY = 'mina: the context was full, so mina reset it in place (subagents were running). The handoff packet follows.';
// After an in-place handoff that interrupted a goal-less run in its tool loop (the in-place RESUME_REQUEST).
export const RESUME_IN_PLACE = 'mina: this session\'s context was reset in place in the middle of its work. Resume that work from the handoff packet above, '
  + 'starting with its next actions. If the next step needs a decision from the user, ask and stop.';
// A run that ignores a steered note request is reminded every REMIND_EVERY turns, at most REMINDERS times.
export const REMIND_EVERY = 5;
export const REMINDERS = 2;
// The successor's first input when mina interrupted a run mid-loop and nothing else continues it (no goal, no held input).
// IV-1g, 2026-10-19: a goal-less run handed off at 11:58 and the successor sat idle with only the packet.
export const RESUME_REQUEST = 'mina: the earlier session was handed off in the middle of its work. Resume that work from the handoff packet above, '
  + 'starting with its next actions. If the next step needs a decision from the user, ask and stop.';
const latestCustom = (ctx, type) => (ctx.sessionManager?.getBranch?.() ?? []).filter((e) => e.type === 'custom' && e.customType === type).at(-1)?.data ?? null;
const goalStates = (ctx) => (ctx.sessionManager?.getBranch?.() ?? []).filter((e) => e.type === 'custom' && e.customType === 'goal-state').map((e) => e.data ?? {});
// The branch since the last in-place handoff (all of it without one): what a new session would hold.
export function sinceLastReset(branch) {
  const at = branch.findLastIndex((e) => e.type === 'custom' && e.customType === IN_PLACE);
  return at < 0 ? branch : branch.slice(at + 1);
}

// The recorded note that still describes the session: none after a compaction or a model reply that came after it.
// 2026-11-19 02:24: a restart lost the pending handoff of 11-18 05:36, the new note call was aborted, and
// /mina-handoff carried the 21-hour-old note into the successor as the current state.
export function freshNote(branch) {
  const since = sinceLastReset(branch);
  const at = since.findLastIndex((e) => e.type === 'custom' && e.customType === NOTE_ENTRY);
  if (at < 0) return null;
  const moved = since.slice(at + 1).some((e) => e.type === 'compaction' || (e.type === 'message' && e.message?.role === 'assistant')
    || (e.type === 'custom' && e.customType === NOTE_SPENT));
  return moved ? null : { note: since[at].data ?? null, at: since[at].timestamp ?? null };
}

// The assistant's latest text in the branch (or in the message that ends this turn), for the restatement.
export function latestAssistantText(branch, message = null) {
  const text = (m) => (typeof m?.content === 'string' ? m.content : (m?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')).trim();
  if (message?.role === 'assistant' && text(message)) return text(message);
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === 'compaction') return '';
    if (e.type === 'message' && e.message?.role === 'assistant' && text(e.message)) return text(e.message);
  }
  return '';
}

// pi-goal's goal for the handoff. When mina stopped an active goal's run during the handoff, pi-goal blocked (or
// paused) it; that goal is carried as active. A later change of the goal (the user resumed or paused it) is kept.
export function stoppedByMina(states, stopped) {
  const goal = states.at(-1)?.goal;
  if (!stopped || !goal || goal.id !== stopped.id || goal.status === 'active') return goal;
  const since = states.slice(stopped.entries).map((s) => s.goal);
  return since.length && since.every((g) => g?.id === goal.id && g.status === goal.status) ? { ...goal, status: 'active' } : goal;
}

// Without a note: the last compaction summary (its end, from a line start), then the assistant's text since that
// compaction, which the summary does not cover. Without a compaction: the last three assistant messages.
export function fallbackSummary(branch, maxChars = 8000) {
  const at = branch.findLastIndex((e) => e.type === 'compaction');
  const text = (e) => (e.message.content ?? []).map((b) => b.text ?? '').join('').trim();
  const recent = branch.slice(at + 1).filter((e) => e.type === 'message' && e.message?.role === 'assistant').map(text).filter(Boolean).slice(-3);
  const tail = (s, n) => { if (s.length <= n) return s; const cut = s.slice(-n); const nl = cut.indexOf('\n'); return nl >= 0 && nl < n / 2 ? cut.slice(nl + 1) : cut; };
  const later = recent.length ? tail(recent.join('\n\n'), at >= 0 ? maxChars / 2 : maxChars) : '';
  if (at < 0) return later || null;
  // An in-place handoff's compaction only points at the packet after it: the packet is the summary.
  const packet = branch[at].details?.minaHandoff ? branch.slice(at + 1).find((e) => e.type === 'custom_message' && e.customType === PACKET_ENTRY) : null;
  const own = packet ? (typeof packet.content === 'string' ? packet.content : (packet.content ?? []).map((b) => b.text ?? '').join('')) : null;
  const summary = tail(own ?? branch[at].summary ?? '', maxChars - later.length);
  return later ? `${summary}\n\n### Since that summary (the assistant's latest messages)\n${later}` : summary;
}

// A handoff that has not started this long after mina asked for it has stalled: the user's held messages are delivered
// in this session. Seen in a long run: the note was written, the handoff never ran (a stale running-
// subagent count, or the queued /mina-handoff lost in the compaction of the same second), and every message the user
// typed for 40 minutes was held.
export const HANDOFF_STALL_MS = 120_000;
const LIVE = new Set(['queued', 'running', 'steered']);
// Other mina extensions ask whether a handoff is under way (the host extension then keeps its alarms for the new session).
export const HANDOFF_STATE = Symbol.for('mina:handoff');

export default function minaHandoff(pi, { tuning = loadTuning(), readTuning = readModelTuning, measure = record, now = Date.now, stallMs = HANDOFF_STALL_MS } = {}) {
  let phase = null; // null | 'note-requested' | 'handing-off'
  let handingOffSince = null;
  let requestedBy = null; // 'steer' (inside a run) | 'input' (at a boundary)
  let turnsSinceRequest = 0, reminders = 0;
  let interrupted = false; // the steered note request arrived while the run was in its tool loop
  let note = null, noteRetried = false;
  // An in-place handoff waiting for its boundary ({ fallback }: without a note), and, after one, no handoff decision
  // until the reset context has a size of its own (its first turn).
  let inPlace = null, awaitingBaseline = false;
  // Subagents running now, and spawns allowed this turn that have not started yet. A new session stops every running
  // subagent at session_shutdown: with them running, the handoff happens in place (and /mina-handoff waits for them).
  const running = new Set();
  let reserved = 0, handoffWaiting = false;
  let lastPool = poolBudget(tuning), lastCwd = process.cwd(), watch = null;
  const warned = new Set(); // `${id}:${level}` already reported to the main agent
  // Measurements (metrics.mjs): this session's turns, peak size and compactions, and pi-hot-compact's job timing.
  const m = { model: null, file: null, startedAt: Date.now(), reason: null, turns: 0, peak: 0, compactions: 0, jobStartedAt: null, pending: null, baselineLogged: false };
  const measureEvent = (kind, data) => measure({ kind, model: m.model, session: m.file, ...data });
  const secondsSince = (t) => (t ? Math.round((Date.now() - t) / 1000) : null);
  const agentDir = () => process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');
  const limitsOf = (type) => ({ budget: lastPool?.subagent ?? null, maxTurns: maxTurnsFor(type, { cwd: lastCwd, agentDir: agentDir() }),
    tools: toolsFor(type, { cwd: lastCwd, agentDir: agentDir() }) });
  const children = () => [...running].map((id) => manager()?.getRecord?.(id)).filter(Boolean).map((r) => childStatus(r, limitsOf(r.type)));
  // Pool reserves taken by subagents: one each, more for a child that outgrew its reserve, plus spawns not started yet.
  const childUnits = () => {
    const list = children(); // a running subagent the registry cannot show counts as one reserve
    return list.reduce((n, c) => n + reserveUnits(c, lastPool?.subagent), 0) + (running.size - list.length) + reserved;
  };
  // Tell the main agent when a subagent nears a limit (once per subagent and limit). Runs at each of its turns and on a
  // timer, so a warning also arrives while the main agent waits.
  const checkChildren = () => {
    for (const c of children()) {
      const fresh = nearLimits(c).filter((l) => !warned.has(`${c.id}:${l}`));
      if (!fresh.length) continue;
      fresh.forEach((l) => warned.add(`${c.id}:${l}`));
      pi.sendUserMessage(warningText(c, fresh), { deliverAs: 'steer' });
    }
  };
  const stopWatch = () => { if (watch) { clearInterval(watch); watch = null; } };
  const startWatch = () => { if (!watch) { watch = setInterval(() => { try { checkChildren(); } catch { /* best effort */ } }, 30_000); watch.unref?.(); } };
  let baseline = null; // context size after the session's first turn
  const carried = []; // inputs that arrived during the handoff, delivered in the successor
  // The goal as it was when mina last stopped a run during the handoff: pi-goal records that stop as an error and blocks
  // the goal, which the successor must not inherit. `entries`: the goal-state entries in the branch at that moment.
  let stopped = null;
  globalThis[HANDOFF_STATE] = { pending: () => phase === 'handing-off' };

  const notify = (ctx, text, level = 'info') => { if (ctx?.hasUI) ctx.ui.notify(text, level); };
  // Before this extension's own input handler (see ledger.mjs).
  const ledger = installLedger(pi, { notify, measure: (kind, data) => measureEvent(kind, data) });
  const compactions = (ctx) => sinceLastReset(ctx.sessionManager?.getBranch?.() ?? []).filter((e) => e.type === 'compaction').length;
  const usage = (ctx) => ctx.getContextUsage?.() ?? null;
  const liveTuning = (ctx) => tuningForModel(tuning, ctx.model, readTuning);
  const due = (ctx) => {
    if (awaitingBaseline) return null;
    const u = usage(ctx);
    const t = liveTuning(ctx);
    // A tuning file's context_window describes its own model; the running model's window wins. On a shared-pool server,
    // the thresholds also leave room for replies, a compaction job and the subagents running beside this session.
    const base = thresholds(t && { ...t, context_window: u?.contextWindow ?? t.context_window }, u?.contextWindow);
    lastPool = poolBudget(t);
    return u ? handoffDue({ tokens: u.tokens, compactions: compactions(ctx), baseline: baseline ?? 0 }, poolThresholds(base, lastPool, childUnits())) : null;
  };
  const readPlan = (cwd) => { try { return readFileSync(join(cwd, '.mina', 'plan.md'), 'utf8'); } catch { return ''; } };
  const briefs = (cwd) => { try { return readdirSync(join(cwd, '.mina', 'briefs')).filter((n) => n.endsWith('.md')).map((n) => `.mina/briefs/${n}`); } catch { return []; } };
  const sendHandoff = () => pi.sendUserMessage('/mina-handoff now', { expandPromptTemplates: true, deliverAs: 'followUp' });
  // Subagents the registry no longer shows as live: a missed finish event must not keep a handoff waiting forever.
  const pruneRunning = () => {
    const reg = manager();
    if (!reg?.getRecord) return;
    for (const id of [...running]) { const r = reg.getRecord(id); if (!r || !LIVE.has(r.status)) running.delete(id); }
    if (!running.size) stopWatch();
  };
  const handoffNow = (ctx) => {
    handingOffSince = now();
    pruneRunning();
    if (!running.size) { sendHandoff(); return; }
    handoffWaiting = true;
    notify(ctx, `mina: the handoff waits for ${running.size} running subagent(s): handing off now would stop them.`);
  };
  // The goal as the packet carries it. Recorded check results only: a handoff never runs checks, and a read-only
  // integrity check must not present an old PASS as current for altered protected scripts.
  const handoffGoal = (ctx) => {
    const goal = carriedGoal(latestCustom(ctx, 'mina-goal'), stoppedByMina(goalStates(ctx), stopped));
    if (goal?.status === 'active' && goal.checks?.length && goal.checkPolicy !== 'working'
        && changedFiles(goal.frozen, hashCheckFiles(ctx.cwd)).length) {
      goal.lastStatus = { at: new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z',
        lines: goal.checks.map((c) => `${c.id}: NOT RUN — protected check files changed after acceptance`) };
    }
    return goal;
  };
  // Subagents running now, for the packet of an in-place handoff.
  const liveChildren = () => [...running].map((id) => {
    const r = manager()?.getRecord?.(id);
    return r ? { ...childStatus(r, limitsOf(r.type)), taskId: r.taskId } : { id };
  });
  const extensionSection = (list) => (list.length ? `\n## Messages from extensions that arrived during the handoff\n${list.map((c) => `- ${c.text.slice(0, 1500)}`).join('\n')}\n` : '');

  // The in-place handoff, at a boundary: a compaction that keeps nothing, a marker, and the packet. A checkpoint that
  // pi-hot-compact drafted at the same boundary is dropped: the packet replaces everything before it. The session, the
  // goal's pi-goal run (which continues the goal after this run, as after any run) and the subagents carry on.
  function commitInPlace(event, ctx) {
    inPlace = null;
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    const goal = handoffGoal(ctx);
    if (goal) delete goal.resume_on_request;   // pi-goal's own /goal resume works in this session
    const goalActive = goal?.status === 'active';
    const subagents = sinceLastReset(branch).filter((e) => e.type === 'custom' && e.customType === 'subagents:record').map((e) => e.data ?? {})
      .filter((r) => !carried.some((c) => c.text.includes(`"${r.description}"`)));
    const file = ctx.sessionManager?.getSessionFile?.() ?? null;
    const userCarried = carried.filter((c) => c.source !== 'extension');
    let packet = renderPacket({ note, goal, fallback: note ? null : fallbackSummary(branch), parentFile: file, briefs: briefs(ctx.cwd), subagents,
      running: liveChildren(), plan: readPlan(ctx.cwd), minimal: liveTuning(ctx)?.goal_prompt === 'minimal', inPlace: true, ledger: ledger.section(ctx) });
    packet += extensionSection(carried.filter((c) => c.source === 'extension'));
    const resume = requestedBy === 'steer' && interrupted && !goalActive && !userCarried.length;
    const u = usage(ctx), at = new Date().toISOString();
    measureEvent('handoff', { mode: 'in-place', tokens: u?.tokens ?? null, compactions: compactions(ctx), note: Boolean(note), subagents_running: running.size });
    const entries = [...(event?.entries ?? []).filter((e) => e.type !== 'compaction'),
      { type: 'compaction', summary: IN_PLACE_SUMMARY, firstKeptEntryId: null, details: { minaHandoff: 'in-place', at } },
      { type: 'custom', customType: IN_PLACE, data: { at, tokens_at_handoff: u?.tokens ?? null, note: Boolean(note), packet_bytes: Buffer.byteLength(packet), subagents_running: [...running] } },
      { type: 'custom_message', customType: PACKET_ENTRY, content: packet, display: true }];
    phase = null; requestedBy = null; interrupted = false; note = null; handingOffSince = null; handoffWaiting = false; stopped = null;
    turnsSinceRequest = 0; reminders = 0; carried.length = 0; baseline = null; awaitingBaseline = true;
    // Queued behind this run: Pi commits the entries above before it takes them.
    for (const c of userCarried) pi.sendUserMessage(c.text, { deliverAs: 'followUp' });
    if (resume) pi.sendUserMessage(RESUME_IN_PLACE, { deliverAs: 'followUp' });
    notify(ctx, `mina: handed off in place: the context now starts from the handoff packet; ${running.size} subagent(s) keep running.`);
    return { entries };
  }
  const onEvent = (channel, fn) => pi.events?.on?.(channel, (data) => { try { fn(data ?? {}); } catch { /* a stale or odd event is not fatal */ } });
  onEvent('subagents:started', ({ id }) => { running.add(id); reserved = Math.max(0, reserved - 1); startWatch(); });
  const finished = ({ id, description, status, result, error }) => {
    running.delete(id);
    if (!running.size) stopWatch();
    // While a handoff is pending, the result also goes into the packet: the successor would not see it otherwise.
    if (phase !== null) carried.push({ source: 'extension', text: `Subagent "${description ?? id}" ${status ?? 'finished'}: ${String(error ? `ERROR: ${error}\n${result || '(no partial report)'}` : result || '(no result)')}` });
    if (!running.size && handoffWaiting) { handoffWaiting = false; handingOffSince = now(); sendHandoff(); }
    // pi-subagents delivers a result itself, but can hold it forever: in a batch whose other result was taken with
    // get_subagent_result, the batch never completes (seen in a test run: a confirmed audit finding was never seen).
    // So mina always says where the result is. If pi-subagents delivered it too, this is one short line more.
    if (phase === null) {
      const failed = status && status !== 'completed';
      const summary = failed && error ? String(error).trim().split('\n')[0]
        : String(result ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '';
      pi.sendUserMessage(`mina: subagent "${description ?? id}" (${id}) ${failed ? 'failed' : 'finished'}: ${summary.slice(0, 200)} `
        + `Read its full result with mina_subagents (id ${id}).`, { deliverAs: 'steer' });
    }
  };
  onEvent('subagents:completed', finished);
  onEvent('subagents:failed', finished);
  // pi-hot-compact's footer state: when a job starts, and when one fails.
  onEvent('pi-footer:update-widget', ({ widgetId, value }) => {
    if (widgetId !== 'hot_compact_job') return;
    if (value === 'compacting…') m.jobStartedAt ??= Date.now();
    else if (value === 'failed') { measureEvent('compaction_failed', { job_s: secondsSince(m.jobStartedAt) }); m.jobStartedAt = null; }
  });

  // Before a subagent starts: on a shared-pool server, refuse it when it would not fit beside this session.
  pi.on('tool_call', (event, ctx) => {
    if (event.toolName !== 'Agent') return undefined;
    const pool = poolBudget(liveTuning(ctx));
    if (!pool) return undefined;
    const u = usage(ctx);
    lastPool = pool;
    const fit = spawnFits(pool, u?.tokens, childUnits());
    if (fit.ok) { reserved++; return undefined; }
    return { block: true, reason: `mina: not started. This server shares one ${fit.pool}-token memory pool among all requests, and this subagent would bring `
      + `the total to about ${fit.projected} tokens (this session ${u.tokens}, ${running.size} subagent(s) running and ${reserved} starting, room kept for replies and compaction). `
      + 'Wait for a running subagent to finish, or do the work yourself; do not start several at once.' };
  });

  const request = (by) => { phase = 'note-requested'; requestedBy = by; turnsSinceRequest = 0; reminders = 0; interrupted = false; noteRetried = false; };

  // A successor starts on Pi's default model (newSession does not carry the model over): it switches back to the model
  // and thinking level the earlier session was using, which the marker records. Pi emits session_start after the
  // handoff's setup wrote the marker.
  // The main agent learns a subagent's limits when it starts one.
  pi.on('tool_result', (event, ctx) => {
    if (event.toolName !== 'Agent' || event.isError) return undefined;
    const type = event.input?.subagent_type ?? 'general-purpose';
    let minimal = false;
    try { minimal = liveTuning(ctx)?.goal_prompt === 'minimal'; } catch { /* no model in this context */ }
    return { content: [...(event.content ?? []), { type: 'text', text: limitsText({ ...limitsOf(type), ...(event.details?.maxTurns ? { maxTurns: event.details.maxTurns, tools: event.details.tools } : {}), minimal }) }] };
  });
  // Once the note is recorded the session is handing off: a run that starts now (a subagent's completion message
  // starts one) would restart work in the full session. mina stops it; the message's content goes into the packet.
  pi.on('agent_start', (_event, ctx) => {
    if (phase !== 'handing-off' || inPlace) return;   // an in-place handoff commits at this run's next boundary
    const states = goalStates(ctx), goal = states.at(-1)?.goal;
    if (goal?.status === 'active') stopped = { id: goal.id, entries: states.length };
    notify(ctx, 'mina: a handoff is pending, so this run is stopped; what arrived goes to the new session.');
    try { ctx.abort(); } catch { /* nothing to stop */ }
  });

  pi.on('session_shutdown', () => {
    stopWatch();
    measureEvent('session_end', { duration_s: secondsSince(m.startedAt), turns: m.turns, peak_tokens: m.peak, compactions: m.compactions, reason: m.reason });
  });

  // A restart between the note and the handoff loses the pending handoff (it lives in memory). The note is still fresh
  // (freshNote): the user decides, without blocking the start, to hand off with it now or to discard it.
  function offerPendingHandoff(ctx) {
    const pending = freshNote(ctx?.sessionManager?.getBranch?.() ?? []);
    if (!pending?.note || !ctx?.hasUI || !ctx.ui?.confirm) return;
    const at = pending.at ? ` (${String(pending.at).slice(0, 16).replace('T', ' ')})` : '';
    oneDialog(() => ctx.ui.confirm('Finish the pending handoff?', `mina stopped after the agent wrote a handoff note${at} and before the handoff. `
      + 'Yes: hand off to a new session now with that note. No: discard the note; the work continues in this session.'))
      .then((yes) => {
        if (yes) { pi.sendUserMessage('/mina-handoff now', { expandPromptTemplates: true }); return; }
        if (yes === false) { pi.appendEntry(NOTE_SPENT, { at: new Date().toISOString(), discarded: true }); notify(ctx, 'mina: the pending handoff note was discarded; mina_recall still finds it.'); }
      }).catch(() => { /* the session ended first */ });
  }

  pi.on('session_start', async (event, ctx) => {
    phase = null; requestedBy = null; interrupted = false; note = null; noteRetried = false; baseline = null; carried.length = 0; handingOffSince = null; handoffWaiting = false;
    stopped = null; inPlace = null; awaitingBaseline = false; running.clear(); reserved = 0; handoffWaiting = false; warned.clear(); stopWatch();
    if (ctx?.cwd) lastCwd = ctx.cwd;
    Object.assign(m, { startedAt: Date.now(), reason: event?.reason ?? null, turns: 0, peak: 0, compactions: 0, jobStartedAt: null, pending: null, baselineLogged: false,
      file: ctx?.sessionManager?.getSessionFile?.() ?? null, model: ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : null });
    if (event?.reason !== 'new') { offerPendingHandoff(ctx); return; }
    const from = latestCustom(ctx, MARKER)?.model;
    if (!from?.provider || !from?.id) return;
    if (ctx.model?.provider !== from.provider || ctx.model?.id !== from.id) {
      const model = ctx.modelRegistry?.find?.(from.provider, from.id);
      const ok = model ? await pi.setModel(model).catch(() => false) : false;
      if (!ok) { notify(ctx, `mina: could not switch this session to ${from.provider}/${from.id}, the model of the earlier session; it runs on ${ctx.model?.provider}/${ctx.model?.id}.`, 'warning'); return; }
    }
    if (from.thinkingLevel) pi.setThinkingLevel(from.thinkingLevel);
    m.model = `${from.provider}/${from.id}`;
  });
  // Measurements name the model that runs, also after /model or the switch back above.
  pi.on('model_select', (event) => { if (event?.model) m.model = `${event.model.provider}/${event.model.id}`; });
  // Inside a run: a long tool loop can outgrow the window without ever reaching an input boundary. After each turn, if a
  // handoff is due, the note request goes in as a steering message (delivered before the next model call of this run).
  // A run that keeps working instead is reminded; a request that is no longer due (a compaction freed the context) is
  // withdrawn. The first turn's size is the session's baseline (see handoffDue).
  // Old reasoning out of each request (reasoning.mjs), when the running model's tuning asks for it.
  pi.on('context', (event, ctx) => {
    const keep = liveTuning(ctx)?.keep_reasoning_turns;
    if (keep === undefined || keep === null) return undefined;
    const { messages, dropped } = stripOldReasoning(event.messages, keep);
    return dropped ? { messages } : undefined;
  });

  pi.on('turn_end', (event, ctx) => {
    if (inPlace) return commitInPlace(event, ctx);
    const restated = restateAfterCompaction(event, ctx);
    const u = usage(ctx);
    reserved = 0; // spawns allowed in this turn have started (or been queued) by now
    m.turns++;
    if (ctx?.model) m.model = `${ctx.model.provider}/${ctx.model.id}`;
    if (Number.isFinite(u?.tokens)) {
      m.peak = Math.max(m.peak, u.tokens);
      // A compaction committed at an earlier boundary: its effect shows in this turn's size.
      if (m.pending && m.turns > m.pending.afterTurn) { const { afterTurn, ...p } = m.pending; measureEvent('compaction', { ...p, tokens_after: u.tokens }); m.pending = null; }
      if (!m.baselineLogged) { m.baselineLogged = true; measureEvent('session_start', { reason: m.reason, baseline_tokens: u.tokens, handed_off: Boolean(latestCustom(ctx, MARKER)) }); }
    }
    if (running.size) checkChildren();
    if (baseline === null) { if (Number.isFinite(u?.tokens)) { baseline = u.tokens; awaitingBaseline = false; } return restated; }
    // A compaction committed at this very boundary: the size above is from before it, and the next turn shows the real
    // one. Deciding now would hand off a session that has just been made small.
    if ((event?.entries ?? []).some((e) => e.type === 'compaction')) return restated;
    if (phase === 'note-requested' && requestedBy === 'steer') {
      if (!due(ctx)) { phase = null; requestedBy = null; return restated; }
      if (++turnsSinceRequest % REMIND_EVERY === 0 && reminders < REMINDERS) { reminders++; pi.sendUserMessage(NOTE_REQUEST, { deliverAs: 'steer' }); }
      return restated;
    }
    if (phase !== null || !due(ctx)) return restated;
    request('steer');
    // A turn that ended in tool calls continues the run: the agent is mid-loop, not finishing or waiting for the user.
    interrupted = event?.message?.role === 'assistant' && event.message.stopReason === 'toolUse';
    notify(ctx, `mina: context at ${u.tokens} of ${u.contextWindow} tokens during the run; the agent writes a handoff note, then the work continues in a new session.`);
    pi.sendUserMessage(NOTE_REQUEST, { deliverAs: 'steer' });
    return restated;
  });
  // The run's last boundary: an in-place handoff not committed yet commits here. A run that was asked for the note and ends
  // without one (see agent_settled) hands off here with the fallback summary when subagents are running.
  pi.on('agent_before_settle', (event, ctx) => {
    if (inPlace) return commitInPlace(event, ctx);
    if (phase === 'note-requested' && !note && !(requestedBy === 'steer' && !carried.length)) {
      pruneRunning();
      if (running.size) {
        phase = 'handing-off'; inPlace = { fallback: true };
        notify(ctx, 'mina: no handoff note was written; handing off in place with the last compaction summary.', 'warning');
        return commitInPlace(event, ctx);
      }
    }
    return restateAfterCompaction(event, ctx);
  });

  // A compaction proposed at this boundary (by pi-hot-compact, which loads before this extension) is followed by the goal
  // restatement in the same commit. Boundary results replace the list, so earlier drafts are passed through.
  function restateAfterCompaction(event, ctx) {
    const c = (event.entries ?? []).find((e) => e.type === 'compaction');
    if (!c) return undefined;
    m.compactions++;
    // Measured at the next turn, when the compacted context is what the model sees.
    // The boundary's draft has no tokensBefore (Pi adds it when it saves the entry): the size now is the size before.
    m.pending = { tokens_before: c.tokensBefore ?? usage(ctx)?.tokens ?? null, semantic: /\[Semantic Checkpoint\]/.test(c.summary ?? ''), source: c.details?.source ?? null,
      job_s: secondsSince(m.jobStartedAt), afterTurn: m.turns + 1 };
    m.jobStartedAt = null;
    const user = ledger.latest(ctx);
    const text = compactionRestatement({ goal: latestCustom(ctx, 'mina-goal'), briefs: briefs(ctx.cwd), plan: readPlan(ctx.cwd),
      ledger: ledger.section(ctx, { exclude: user ? [user.id] : [] }),
      work: workInProgress({ user, assistant: latestAssistantText(ctx.sessionManager?.getBranch?.() ?? [], event.message) }) });
    return text ? { entries: [...event.entries, { type: 'custom_message', customType: 'mina-goal', content: text, display: false }] } : undefined;
  }

  // The boundary: the next input after the context passed the threshold.
  pi.on('input', (event, ctx) => {
    if (phase === 'handing-off') {
      const typed = event.source !== 'extension';
      if (handoffWaiting) { pruneRunning(); if (!running.size) { handoffWaiting = false; handingOffSince = now(); sendHandoff(); } }
      // Waiting for subagents the registry still shows running is no stall: they can run for an hour.
      const waiting = handoffWaiting && running.size > 0 && Boolean(manager()?.getRecord);
      if (typed && !waiting && handingOffSince !== null && now() - handingOffSince > stallMs) {
        // Stalled: back to normal. The held messages go to this session, before this one.
        const held = carried.splice(0).filter((c) => c.source !== 'extension');
        phase = null; requestedBy = null; note = null; handingOffSince = null; handoffWaiting = false; inPlace = null;
        notify(ctx, `mina: the handoff did not start within ${Math.round(stallMs / 1000)} s, so it was abandoned; `
          + `${held.length} held message(s) are delivered here now.`, 'warning');
        measureEvent('handoff_stalled', { held: held.length });
        for (const c of held) pi.sendUserMessage(c.text, { deliverAs: 'steer' });
        return undefined;
      }
      // Also while the handoff waits for subagents: a run started here would be stopped at once (agent_start below), and
      // the message would be lost with it.
      if (typed || !GOAL_CONTINUATION_MARKER.test(event.text)) carried.push({ source: event.source, text: event.text });
      if (typed) notify(ctx, waiting
        ? `mina: the handoff waits for ${running.size} running subagent(s); your message is held and delivered in the new session. "/mina-handoff force" hands off now and stops them.`
        : 'mina: a handoff is in progress; your message is held and delivered in the new session.');
      return { action: 'handled' };
    }
    // While the note is pending, the user's messages are held for the successor: delivered now, they would restart work
    // in the full session (Pi delivers queued messages even after the note tool ends the run). mina's own inputs (the
    // note request, a goal continuation) pass.
    if (phase === 'note-requested') {
      if (event.source === 'extension') return undefined;
      carried.push({ source: event.source, text: event.text });
      notify(ctx, 'mina: a handoff is in progress; your message is held and delivered in the new session.');
      return { action: 'handled' };
    }
    if (!due(ctx)) return undefined;
    const u = usage(ctx);
    request('input');
    if (!(event.source === 'extension' && GOAL_CONTINUATION_MARKER.test(event.text))) carried.push({ source: event.source, text: event.text });
    notify(ctx, `mina: context at ${u.tokens} of ${u.contextWindow} tokens; the agent writes a handoff note, then the work continues in a new session.`);
    return { action: 'transform', text: NOTE_REQUEST };
  });

  // The agent finished without a note. A request steered into a run is asked again at the next input (the run may have
  // ended because the work is done, e.g. goal_complete: then nothing is continued unless the user writes again). A
  // request made at an input boundary was the agent's turn to write it: hand off with the fallback summary.
  pi.on('agent_settled', (event, ctx) => {
    if (phase !== 'note-requested' || note) return;
    // The note call itself was cut off (2026-11-19 02:24: an emergency compaction aborted it): asked once more.
    if (event?.aborted && !noteRetried) {
      noteRetried = true;
      notify(ctx, 'mina: the handoff note was interrupted; the agent is asked for it once more.', 'warning');
      pi.sendUserMessage(NOTE_REQUEST, { deliverAs: 'followUp' });
      return;
    }
    if (requestedBy === 'steer' && !carried.length) { phase = null; requestedBy = null; return; }
    phase = 'handing-off'; notify(ctx, 'mina: no handoff note was written; handing off with the last compaction summary.', 'warning'); handoffNow(ctx);
  });

  pi.registerTool({
    name: 'mina_handoff_note',
    label: 'Handoff note',
    description: 'Only when mina asks for it: record the handoff note for the fresh context that continues this work.',
    parameters: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'Where the work stands now, in a few sentences, including running broker jobs and monitors with their IDs (they keep running across the handoff).' },
        next_actions: { type: 'array', items: { type: 'string' }, description: 'The exact next steps, in order.' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions made, each with its reason.' },
        facts: { type: 'array', items: { type: 'string' }, description: 'Established facts, each with its source (file, command, paper).' },
        failed_approaches: { type: 'array', items: { type: 'string' }, description: 'What was tried and failed, and why.' },
        open_questions: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'string' }, description: 'Files changed, with one line each on what changed.' },
      },
      required: ['state', 'next_actions'],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      note = params;
      pi.appendEntry(NOTE_ENTRY, note);
      phase = 'handing-off';
      pruneRunning();
      if (running.size) {
        // A new session would stop them: the handoff happens in place, at this run's next boundary.
        inPlace = { fallback: false }; handingOffSince = now();
        notify(ctx, `mina: handoff note recorded; ${running.size} subagent(s) are running, so this context is reset in place and they keep running.`);
        return { content: [{ type: 'text', text: 'Handoff note recorded. Stop here: the context is reset in place (subagents are running and keep running), '
          + 'and the work continues from the handoff packet.' }], details: { note, mode: 'in-place' }, terminate: true };
      }
      handoffNow(ctx);
      notify(ctx, 'mina: handoff note recorded.');
      return { content: [{ type: 'text', text: 'Handoff note recorded. Stop here: the work continues in a new session.' }], details: { note }, terminate: true };
    },
  });

  pi.registerCommand('mina-handoff', {
    description: 'Hand this session off to a fresh one (the agent writes a handoff note first; "/mina-handoff now" skips the note; "force" also stops running subagents)',
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const force = String(args ?? '').trim() === 'force';
      if (running.size && !force) {
        handoffWaiting = true;
        notify(ctx, `mina: ${running.size} subagent(s) are running, and a handoff would stop them. mina hands off when they finish; "/mina-handoff force" hands off now.`, 'warning');
        return;
      }
      // A note recorded earlier in this session (for example before mina was restarted) is used rather than lost, if it
      // is still fresh: not one that an in-place handoff used, and not one the work has moved past.
      note ??= freshNote(ctx.sessionManager?.getBranch?.() ?? [])?.note ?? null;
      if (!note && !['now', 'force'].includes(String(args ?? '').trim())) {
        phase = 'note-requested'; noteRetried = false;
        pi.sendUserMessage(NOTE_REQUEST);
        return;
      }
      const parent = ctx.sessionManager.getSessionFile?.();
      if (!parent) { phase = null; notify(ctx, 'mina: this session is not saved to a file, so it cannot be handed off.', 'error'); return; }
      // A copy (the check status is added for the successor), with pi-goal's own status when it is blocked or paused.
      const goal = handoffGoal(ctx);
      const decisions = latestCustom(ctx, 'mina-decisions');
      const goalActive = goal?.status === 'active';
      const branch = ctx.sessionManager.getBranch?.() ?? [];
      const fallback = note ? null : fallbackSummary(branch);
      const subagents = sinceLastReset(branch).filter((e) => e.type === 'custom' && e.customType === 'subagents:record').map((e) => e.data ?? {})
        .filter((r) => !carried.some((c) => c.text.includes(`"${r.description}"`)));
      let packet = renderPacket({ note, goal, fallback, parentFile: parent, briefs: briefs(ctx.cwd), subagents, plan: readPlan(ctx.cwd), minimal: liveTuning(ctx)?.goal_prompt === 'minimal',
        ledger: ledger.section(ctx) });
      const nextLedger = ledger.successor(ctx);
      const userCarried = carried.filter((c) => c.source !== 'extension');
      const resume = requestedBy === 'steer' && interrupted && !goalActive && !userCarried.length;
      const otherCarried = carried.filter((c) => c.source === 'extension');
      packet += extensionSection(otherCarried);
      // Everything read from ctx is read here: by the time setup runs, Pi has replaced the session and this ctx is stale
      // (any access throws, and Pi exits on the error).
      const u = usage(ctx);
      const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, thinkingLevel: ctx.thinkingLevel ?? null } : null;
      // Right after a restart Pi has no usage reading yet: the last model reply's size stands in for it.
      const lastReply = (ctx.sessionManager.getBranch?.() ?? []).filter((e) => e.type === 'message' && e.message?.role === 'assistant' && e.message.usage?.totalTokens).at(-1);
      measureEvent('handoff', { mode: 'new', tokens: u?.tokens ?? lastReply?.message.usage.totalTokens ?? null, compactions: compactions(ctx), note: Boolean(note), subagents_running: running.size });
      if (note) pi.appendEntry(NOTE_SPENT, { at: new Date().toISOString(), to: 'new-session' });
      const result = await ctx.newSession({
        parentSession: parent,
        setup: async (sm) => {
          sm.appendCustomEntry(MARKER, { from: parent, at: new Date().toISOString(), tokens_at_handoff: u?.tokens ?? null, note: Boolean(note), packet_bytes: Buffer.byteLength(packet), model });
          if (goal) sm.appendCustomEntry('mina-goal', goal);
          if (decisions) sm.appendCustomEntry('mina-decisions', decisions);
          sm.appendCustomEntry(LEDGER, nextLedger);
          sm.appendMessage({ role: 'user', content: packet, timestamp: Date.now() });
        },
        withSession: async (next) => {
          if (next.hasUI) next.ui.notify(`mina: handed off from ${parent}. mina_recall searches the earlier session.`, 'info');
          if (goalActive) await next.sendUserMessage('/goal mina-continue', { expandPromptTemplates: true });
          for (const c of userCarried) await next.sendUserMessage(c.text, goalActive ? { deliverAs: 'followUp' } : undefined);
          if (resume) await next.sendUserMessage(RESUME_REQUEST);
        },
      });
      if (result?.cancelled) { phase = null; notify(ctx, 'mina: the handoff was cancelled.', 'warning'); }
    },
  });

  pi.registerTool({
    name: 'mina_subagents',
    label: 'Subagents',
    description: 'How close each running subagent is to its limits (context tokens against its budget, turns against its turn limit), '
      + 'and how full this server\'s shared memory is. Subagents have no compaction or handoff. At a limit they stop; saved files and partial reports remain. '
      + 'Also lists the subagents that finished in this session; give `id` to read one\'s full result (also after "Agent not found").',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'A finished subagent\'s id: returns its full result.' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // pi-subagents keeps a finished subagent's result only in a `subagents:record` entry, which the model does not see,
      // and forgets the agent itself after a while ("Agent not found... cleaned up"). A test run lost an audit
      // report this way. So mina lists the finished ones and returns a result by id.
      const records = (ctx.sessionManager?.getBranch?.() ?? []).filter((e) => e.type === 'custom' && e.customType === 'subagents:record').map((e) => e.data ?? {});
      if (params?.id) {
        const r = records.filter((d) => d.id === params.id).at(-1);
        if (!r) return { content: [{ type: 'text', text: `No finished subagent ${params.id} in this session. Finished: ${records.map((d) => d.id).join(', ') || 'none'}.` }] };
        return { content: [{ type: 'text', text: `Subagent ${r.id} (${r.description ?? r.type}, ${r.status}):\n${r.error ? `ERROR: ${r.error}\n${r.result || '(no partial report)'}` : r.result || '(no result recorded)'}` }], details: { record: r } };
      }
      const list = children();
      const u = usage(ctx);
      const lines = list.length ? list.map((c) => `- ${describeChild(c)}${nearLimits(c).length ? '  <- near its limit' : ''}`) : ['No subagent is running.'];
      if (lastPool) {
        const used = (u?.tokens ?? 0) + list.reduce((n, c) => n + (c.tokens ?? 0), 0);
        lines.push(`Shared memory: about ${Math.round(used / 1000)}K of ${Math.round(lastPool.tokens / 1000)}K in use (this session ${Math.round((u?.tokens ?? 0) / 1000)}K, `
          + `subagents ${Math.round((used - (u?.tokens ?? 0)) / 1000)}K), plus room kept for replies and compaction.`);
      }
      const done = new Map(records.map((d) => [d.id, d]));               // the last record of each subagent
      if (done.size) {
        lines.push(`Finished in this session (read one in full: mina_subagents with its id):`);
        for (const d of done.values()) {
          const tail = String(d.error || d.result || '').trim().split('\n').filter(Boolean).at(-1) ?? '';
          lines.push(`- ${d.id} "${d.description ?? d.type}" (${d.status}): ${tail.slice(0, 160)}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }], details: { children: list } };
    },
  });

  pi.registerTool({
    name: 'mina_recall',
    label: 'Recall',
    description: 'Exact search over this session and the earlier sessions it was handed off from: give `query` (text, or a regex with regex=true) '
      + 'to find entries, or `entry_id` to read one entry in full. Use it when the handoff packet is not specific enough.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' }, regex: { type: 'boolean' }, entry_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 30 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const file = ctx.sessionManager?.getSessionFile?.();
      if (!file || !existsSync(file)) throw new Error('This session has no file yet, so there is nothing to recall.');
      const sessions = lineage(file);
      if (params.entry_id) {
        const r = readEntry(sessions, params.entry_id);
        if (!r) throw new Error(`No entry ${params.entry_id} in this session or the ${sessions.length - 1} earlier one(s).`);
        return { content: [{ type: 'text', text: `[${r.session} ${r.entry_id}]\n${r.text}` }], details: r };
      }
      if (!params.query) throw new Error('Give query or entry_id.');
      const hits = search(sessions, { query: params.query, regex: Boolean(params.regex), limit: params.limit ?? 10 });
      const text = hits.length ? hits.map((h) => `[${h.session} ${h.entry_id}] …${h.snippet}…`).join('\n\n')
        : `No match in this session or the ${sessions.length - 1} earlier one(s).`;
      return { content: [{ type: 'text', text }], details: { hits: hits.length, sessions: sessions.length } };
    },
  });
}
