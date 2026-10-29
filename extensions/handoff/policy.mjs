// mina handoff rules that need no Pi runtime: when a handoff is due, how hot-compact is configured for a model, and the
// handoff packet. The context policy: compaction is left to pi-hot-compact; a handoff is due at handoff_at tokens, or at compact_at tokens once the
// session has already been compacted max_compactions times.
import { formatStatus } from '../goal/checks.mjs';

export const PACKET_MAX_BYTES = 16_384;
export const PLAN_MAX_CHARS = 3000;
// The agent's plan file (.mina/plan.md), cut to a size the packet and the restatement can always carry.
export const planText = (text) => (text ? (text.length > PLAN_MAX_CHARS ? `${text.slice(0, PLAN_MAX_CHARS)}\n[… plan cut at ${PLAN_MAX_CHARS} characters; read .mina/plan.md]` : text).trim() : '');
export const GOAL_CONTINUATION_MARKER = /<!--\s*pi-goal-continuation:[^\s>]+\s*-->/;

// The tuning for the model that is running now. The launcher picks the tuning file for the model the session starts on,
// but the user can switch models (/model) and a handoff can follow: a tuning file that names another model does not
// apply, and that model's own file (from `read`, models/ in mina) is used instead (none: null, so the window ratios below apply). A tuning
// file without a model (a test or an experiment) applies to every model.
export function tuningForModel(tuning, model, read) {
  if (!model?.provider || !model?.id) return tuning;
  if (tuning && (!tuning.model || tuning.model === `${model.provider}/${model.id}`)) return tuning;
  return read(`${model.provider}__${model.id.replaceAll('/', '_')}.json`) ?? null;
}

// Thresholds for a model: the tuning file's, else 40% / 60% of the context window.
// Defaults are capped at 250K / 350K. A usage simulation from measured sessions (docs/threshold-economics.md,
// scripts/threshold-economics.py) put the cheapest compaction point near 250K on Opus's 1M window. Every request
// carries the whole context: past this, cached re-reads cost more than the compactions and handoffs they avoid.
export const COMPACT_CAP = 250_000, HANDOFF_CAP = 350_000;
export function thresholds(tuning, contextWindow) {
  const w = tuning?.context_window ?? contextWindow ?? null;
  return {
    compactAt: tuning?.compact_at_tokens ?? (w ? Math.min(Math.round(w * 0.4), COMPACT_CAP) : null),
    handoffAt: tuning?.handoff_at_tokens ?? (w ? Math.min(Math.round(w * 0.6), HANDOFF_CAP) : null),
    maxCompactions: tuning?.max_compactions ?? 2,
  };
}

// A server whose memory (KV cache) is one pool shared by every request in flight: the session's own context, its
// replies, a background compaction job, and each running subagent. The tuning file's `pool` describes it; without one,
// the model's context window is the session's alone and nothing here applies.
export function poolBudget(tuning) {
  const p = tuning?.pool;
  if (!p?.tokens) return null;
  return { tokens: p.tokens, reply: p.reply_reserve_tokens ?? 0, compaction: p.compaction_reserve_tokens ?? 0, subagent: p.subagent_reserve_tokens ?? 0 };
}

// The most this session's context may hold with `children` subagents running (or about to start).
export const poolCap = (pool, children = 0) => pool.tokens - pool.reply - pool.compaction - children * pool.subagent;

// Thresholds lowered to what the pool leaves for this session.
export function poolThresholds(t, pool, children = 0) {
  if (!pool || !t?.handoffAt) return t;
  const cap = poolCap(pool, children);
  const handoffAt = Math.max(1, Math.min(t.handoffAt, cap));
  return { ...t, handoffAt, compactAt: t.compactAt ? Math.min(t.compactAt, handoffAt) : t.compactAt };
}

// Whether one more subagent fits next to this session's `tokens` and the `children` already running.
export function spawnFits(pool, tokens, children = 0) {
  if (!pool || !Number.isFinite(tokens)) return { ok: true };
  const projected = tokens + pool.reply + pool.compaction + (children + 1) * pool.subagent;
  return { ok: projected <= pool.tokens, projected, pool: pool.tokens };
}

// 'handoff' or null. `tokens` null (unknown right after a compaction) is never pressure. `baseline` is the session's size
// after its first turn: a session must grow by 20% of handoff_at past it, so a successor that starts near the threshold
// (packet + prompt) does not hand off again at once, in a loop.
export function handoffDue({ tokens, compactions = 0, baseline = 0 }, t) {
  if (!Number.isFinite(tokens) || !t?.handoffAt) return null;
  if (tokens - (baseline ?? 0) < 0.2 * t.handoffAt) return null;
  if (tokens >= t.handoffAt) return 'handoff';
  if (t.compactAt && compactions >= t.maxCompactions && tokens >= t.compactAt) return 'handoff';
  return null;
}

// pi-hot-compact settings for this model: the user's own file, then the tuning file's hot_compact settings, with
// compaction starting at compact_at unless one of them sets startPercent. pi-hot-compact's hardPercent is where it
// stops waiting for the model-written checkpoint and commits a deterministic one at the next turn boundary (no model
// call, the run is not interrupted). Its default (90%) lies past mina's handoff, so a session whose checkpoint calls
// fail (slow model, timeouts) would never compact: mina puts it halfway between compact_at and handoff_at.
export function hotCompactConfig(user = {}, tuning, contextWindow) {
  const t = thresholds(tuning, contextWindow);
  const w = tuning?.context_window ?? contextWindow;
  // debug: pi-hot-compact then logs each job, including why one failed, to ~/.pi/agent/hot-compact.log. Without it a
  // failed job left no reason anywhere (IV-1a: four failures in 4-5 s).
  const out = { debug: true, ...user, ...(tuning?.hot_compact ?? {}) };
  if (t.compactAt && w && out.startPercent === undefined) out.startPercent = Math.max(1, Math.min(85, Math.round((t.compactAt / w) * 100)));
  if (t.compactAt && t.handoffAt && w && out.hardPercent === undefined) {
    // Commit before the handoff threshold: a hard point past it hands the session off uncompacted (IV-1a, 1M window).
    const half = Math.round(((t.compactAt + t.handoffAt) / 2 / w) * 100);
    const beforeHandoff = Math.ceil((t.handoffAt / w) * 100) - 1;
    out.hardPercent = Math.min(90, beforeHandoff, Math.max(half, (out.startPercent ?? 0) + 1));
  }
  return out;
}

// Results of the subagents that finished in the earlier session (pi-subagents' `subagents:record` entries): the new
// session cannot ask pi-subagents for them, which only knows its own process's agents.
const subagentList = (records) => (records?.length ? `## Subagents that finished in the earlier session\n${records.map((r) =>
  `- "${r.description}" (${r.status}): ${String(r.result ?? r.error ?? '').replace(/\s+/g, ' ').slice(0, 1200)}`).join('\n')}\n`
  + 'Their full reports: mina_recall with the description.\n' : '');

const list = (title, items) => (items?.length ? `## ${title}\n${items.map((x) => `- ${x}`).join('\n')}\n` : '');

// The first message of the successor session. Sections are dropped from the end when the packet is too large; the
// header, the goal and the next actions always stay.
// The objective as the packet and the restatement show it. A file objective (an objective that was a path to a file,
// for instructions over pi-goal's 4,000-character limit) is named, not copied: the packet keeps its room for the note.
export const objectiveText = (goal) => (goal?.objective_file
  ? `The text of the file ${goal.objective_file} is the objective: read it again now, in full, before you continue.`
  : goal?.objective ?? '');

// The goal a handoff carries. mina's own record follows pi-goal only on completion and clear, so a goal that pi-goal
// blocked or paused still reads "active" there; handing that on restarted it in the successor with nobody resuming it
// (blocked, then active again seconds later). pi-goal's latest goal-state decides.
// Such a goal is carried as not active, marked so that the user's /goal resume in the successor continues it.
export function carriedGoal(goal, upstream) {
  if (!goal) return null;
  const st = upstream?.status;
  if (goal.status === 'active' && st && st !== 'active' && st !== 'complete') return { ...goal, status: st, resume_on_request: true };
  return { ...goal };
}

export function renderPacket({ note = null, goal = null, fallback = null, parentFile, briefs = [], subagents = [], plan = '', minimal = false }, maxBytes = PACKET_MAX_BYTES) {
  const head = ['# mina handoff packet',
    minimal ? 'This session continues an earlier one, handed off when its context was full. mina_recall searches the earlier sessions.'
      : 'This session continues an earlier one that was handed off because its context was full. This packet is a summary written at '
    + 'the handoff, not proof: for exact earlier text (commands, outputs, decisions), use mina_recall, which searches the earlier sessions.',
    `Earlier session: ${parentFile ?? 'unknown'}`, ''].join('\n');
  const goalPart = goal?.status && goal.status !== 'active' ? `## Goal (not active)\n${objectiveText(goal)}\nStatus: ${goal.status} in the earlier session. `
    + 'There is no active goal: do not resume work on it unless the user asks.'
    + (goal.resume_on_request ? ' The user continues it here with /goal resume.' : '') + '\n'
    : goal ? `## Goal\n${objectiveText(goal)}\nStatus: ${goal.status}${goal.unverified ? ', UNVERIFIED (no checks)' : ''}\n`
    + 'The goal continues in this session as a new pi-goal run with a new goal_id: any goal_id written below or in the earlier session is stale. '
    + 'Use the goal_id from the current Goal contract.\n'
    + (goal.checks?.length ? `${goal.checkPolicy === 'working' ? 'Agent-selected working checks (editable; not independent qualification)' : 'Accepted checks'} (mina reruns them on goal_complete):\n${goal.checks.map((c) => `- ${c.id}: ${c.command}`).join('\n')}\n` : '')
    + (goal.checks?.length ? `Check approval: ${goal.checkApproval ?? 'legacy, not recorded'}. Protection alone is not independent qualification.\n` : '')
    + (goal.lastStatus ? `${formatStatus(goal.lastStatus)}\nRecorded status only. Handoff did not run these checks. Use mina_checks for fresh results.\n` : '')
    + (planText(plan) ? `## Plan (.mina/plan.md, kept by the agent)\n${planText(plan)}\n` : '')
    : '';
  const required = [head, goalPart];
  const optional = [];
  if (note) {
    required.push(`## State\n${note.state ?? ''}\n`, list('Next actions', note.next_actions));
    optional.push(list('Decisions', note.decisions), list('Facts (with their source)', note.facts), list('Failed approaches', note.failed_approaches),
      list('Open questions', note.open_questions), list('Files changed', note.files), list('Research briefs', briefs), subagentList(subagents));
  } else if (fallback) {
    required.push('## State (automatic summary: the agent did not write a handoff note)\n', fallback, '\n');
    optional.push(list('Research briefs', briefs), subagentList(subagents));
  }
  let text = [...required, ...optional].join('\n');
  while (Buffer.byteLength(text) > maxBytes && optional.length) { optional.pop(); text = [...required, ...optional].join('\n'); }
  if (Buffer.byteLength(text) > maxBytes) text = `${Buffer.from(text).subarray(0, maxBytes - 40).toString()}\n[packet truncated at ${maxBytes} bytes]`;
  return text;
}

export const NOTE_REQUEST = [
  'mina: this session\'s context is nearly full, so it will be handed off to a fresh session now.',
  'Pause the conversation and call mina_handoff_note once. Running broker jobs, monitors and background processes keep going',
  'under their own supervision, and their alarms reach the next session: do not stop, cancel or wait for them.',
  'Write the note for a capable colleague who has not seen this session:',
  'the current state, including running jobs and monitors with their IDs and how to check them, decisions with their reasons,',
  'facts with their source (file, command, paper), approaches that failed and why, open questions, the exact next actions,',
  'and the files you changed. Preserve explicit owner instructions for standing task autonomy, their source and limits; historical receipts do not renew authority or attempts.',
  'Be specific and short: at most about 500 words. Start no new task before the note.',
].join(' ');

// After a compaction, the active goal is restated right after the summary: pi-hot-compact's summary is not goal-aware
// (its goal section reads user messages only), and mina's accepted checks are not in pi-goal's own contract.
export function goalRestatement(goal, briefs = [], plan = '') {
  if (!goal || goal.status !== 'active') return null;
  return ['mina: the context was just compacted. The active goal, restated:', `Objective: ${goal.objective_file ? objectiveText(goal).replace(/^The text/, 'the text') : goal.objective}`,
    goal.checks?.length ? `${goal.checkPolicy === 'working' ? 'Agent-selected working checks (editable; not independent qualification)' : 'Accepted checks (protected; .mina/checks/ is frozen)'} (mina reruns them on goal_complete):\n${goal.checks.map((c) => `- ${c.id}: ${c.command}`).join('\n')}`
      : (goal.settled === false ? (goal.checkPolicy === 'working' ? 'Working checks: register with mina_propose_checks before completion; ordinary edits are allowed.' : 'Checks: not settled yet (call mina_propose_checks before writing files outside .mina/).') : 'Checks: none (UNVERIFIED).'),
    goal.checks?.length ? `Check approval: ${goal.checkApproval ?? 'legacy, not recorded'}. Protection alone is not independent qualification.` : '',
    goal.lastStatus ? `${formatStatus(goal.lastStatus)}\n(mina_checks runs them again.)` : '',
    planText(plan) ? `Your plan (.mina/plan.md):\n${planText(plan)}` : 'No .mina/plan.md yet: write the remaining steps there.',
    briefs.length ? `Research briefs: ${briefs.join(', ')}` : '',
    'For exact earlier text, use context_recall (this session) or mina_recall (earlier sessions).'].filter(Boolean).join('\n');
}
