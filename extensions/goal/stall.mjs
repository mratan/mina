// mina's no-effect guard for long-running goals. pi-goal's own guards count model responses (automaticTurns, which mina
// leaves unlimited: 2026-10-21, 100 responses paused a healthy goal after ~8 h of waiting on downloads) and identical
// tool-free replies (noProgressTurns). Neither tells a loop that calls tools but changes nothing from real work.
// Progress here is an effect outside the conversation: a file written or edited, a git HEAD or status change, a
// broker workload submitted, stopped or seen to finish, or the goal's checks or their results changed. A run that waits
// (goal_wait) while a broker workload it knows of is live is neutral: the job is the progress, bounded by its deadline.
// Only pi-goal's automatic runs count; any effect resets the count, and so does the user (pi-goal's safety epoch).
import { createHash } from 'node:crypto';

export const DEFAULT_STALL_RUNS = 3;
export const LIVE_WORKLOAD = new Set(['launching', 'starting', 'running', 'containment_unknown']);
const KEEP_WORKLOADS = 50;

// A broker workload record seen in a mina_host result. Returns the updated map and whether a live job was seen to end.
export function observeWorkload(workloads, result) {
  if (!result || typeof result !== 'object' || typeof result.id !== 'string' || typeof result.state !== 'string') return { workloads, finished: false };
  const before = workloads?.[result.id]?.state;
  const next = { ...(workloads ?? {}) };
  delete next[result.id];                                                       // re-insert last: pruning drops the oldest seen
  next[result.id] = { state: result.state, ...(Number.isFinite(result.deadline) ? { deadline: result.deadline } : {}) };
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - KEEP_WORKLOADS))) delete next[id];
  return { workloads: next, finished: LIVE_WORKLOAD.has(before) && !LIVE_WORKLOAD.has(result.state) };
}

// A known job that can still be running: live state and not past its broker deadline (epoch seconds).
export const liveWorkload = (workloads, nowS = Date.now() / 1000) =>
  Object.values(workloads ?? {}).some((w) => LIVE_WORKLOAD.has(w.state) && !(w.deadline <= nowS));

// The effect a tool result had, or null.
export function toolEffect(event) {
  if (!event || event.isError) return null;
  const name = event.toolName;
  if (name === 'write' || name === 'edit') return `${name} ${event.input?.path ?? ''}`.trim();
  if (name === 'mina_propose_checks') return 'checks proposed';
  if (name === 'mina_host' && ['workload_run', 'workload_stop'].includes(event.input?.action) && event.details?.ok) {
    return `${event.input.action} ${event.details.result?.id ?? ''}`.trim();
  }
  return null;
}

// HEAD and the set of changed paths, not their contents: broker jobs append to tracked logs (state-log.jsonl), which
// must not count as the agent's progress. --no-optional-locks keeps the agent's own git commands free of index.lock.
export async function gitSnapshot(exec, cwd) {
  try {
    const r = await exec('bash', ['-c', 'git rev-parse HEAD && git --no-optional-locks status --porcelain=v1 -z'], { cwd, timeout: 15_000 });
    return r.code === 0 ? createHash('sha256').update(String(r.stdout)).digest('hex') : null;
  } catch { return null; }
}

// One finished run. stall: { goalId, count, autoTurns }. goal: pi-goal's persisted goal. run: { automatic, effects, live }.
// Returns the next stall record and the run's class: effect | neutral | stalled | uncounted | reset.
export function nextStall(stall, goal, run) {
  const fresh = !stall || stall.goalId !== goal.id || goal.automaticModelTurns < (stall.autoTurns ?? 0);
  const base = { goalId: goal.id, count: fresh ? 0 : stall.count, autoTurns: goal.automaticModelTurns ?? 0 };
  if (run.effects.length) return { stall: { ...base, count: 0 }, kind: 'effect' };
  if (!run.automatic) return { stall: base, kind: fresh ? 'reset' : 'uncounted' };
  if (goal.waiting && run.live) return { stall: base, kind: 'neutral' };
  return { stall: { ...base, count: base.count + 1 }, kind: 'stalled' };
}
