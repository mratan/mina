// Reset-aware goal recovery. Only provider evidence can supply a deadline; never guess a five-hour wait.
import { createHash } from 'node:crypto';
import { applies, claudeApplies, fetchUsage, fetchClaudeUsage, claudeCodeLabels } from '../codex-usage/index.js';

export const USAGE_RESUME_ENTRY = 'mina-goal-usage-resume';
const MARGIN_MS = 60_000; // Rounded error messages and provider clock skew.
const BILLING = /billing|payment|insufficient[_\s-]*(?:quota|credits?)|out of credits|out of budget|available balance|(?:credit|balance).{0,32}(?:low|exhausted|depleted)/i;
const finiteTime = (n) => Number.isFinite(n) && n > 0 && n < 8.64e15 ? n : null;
const latest = (ctx, type) => (ctx?.sessionManager?.getBranch?.() ?? []).filter((e) => e.type === 'custom' && e.customType === type).at(-1)?.data;
const goal = (ctx) => latest(ctx, 'goal-state')?.goal;
const signature = (g) => createHash('sha256').update(JSON.stringify(g ?? null)).digest('hex');
const modelKey = (ctx) => {
  const m = ctx?.model;
  return JSON.stringify([m?.provider, m?.id, m?.baseUrl, !!(m && ctx.modelRegistry?.isUsingOAuth?.(m))]);
};
const parked = (g) => g?.status === 'usage_limited' || (g?.status === 'active' && String(g.waiting?.reason ?? '').startsWith('Provider retries exhausted'));
// pi-goal can save new usage counters on session_start without changing the objective or the wait.
const waitRevision = (g) => typeof g?.text === 'string' ? signature([g.id, g.text, g.status, g.tokenBudget, g.waiting?.reason, g.waiting?.resumeAt]) : null;
const matchesGoal = (g, record) => parked(g) && (record.goalRevision ? waitRevision(g) === record.goalRevision : signature(g) === record.goalSignature);
const matches = (ctx, record) => record.model === modelKey(ctx) && matchesGoal(goal(ctx), record);

function savedWait(ctx) {
  const deadline = latest(ctx, USAGE_RESUME_ENTRY);
  if (typeof deadline?.model !== 'string' || !finiteTime(deadline.resumeAt)) return null;
  const state = latest(ctx, 'goal-state');
  return matchesGoal(state?.goal, deadline) ? { state, deadline } : null;
}

// Handoff seeds these exact entries in the successor; an overdue deadline is still valid until consumed.
export function quotaHandoffState(ctx) {
  const saved = savedWait(ctx);
  return saved && ctx?.model && saved.deadline.model === modelKey(ctx) ? saved : null;
}

function durationMs(text) {
  const units = { ms: 1, s: 1000, sec: 1000, seconds: 1000, m: 60_000, min: 60_000, minutes: 60_000, h: 3_600_000, hours: 3_600_000 };
  const parts = [...String(text).matchAll(/(\d+(?:\.\d+)?)\s*(milliseconds|minutes|seconds|hours|ms|min|sec|[smh])/gi)];
  return parts.length ? parts.reduce((n, m) => n + Number(m[1]) * (units[m[2].toLowerCase()] ?? 1), 0) : null;
}

export function resetFromError(error, now = Date.now()) {
  const text = String(error ?? '');
  if (BILLING.test(text)) return null;
  const epoch = text.match(/"?resets?_at"?\s*[:=]\s*(\d{10,13})\b/i);
  if (epoch) return finiteTime(Number(epoch[1]) * (epoch[1].length === 13 ? 1 : 1000));
  const seconds = text.match(/"?resets?_in_seconds"?\s*[:=]\s*(\d+(?:\.\d+)?)/i);
  if (seconds) return finiteTime(now + Number(seconds[1]) * 1000);
  const relative = text.match(/(?:try again|retry|resets?)\s+(?:in|after)\s*~?\s*((?:\d+(?:\.\d+)?\s*(?:milliseconds|minutes|seconds|hours|ms|min|sec|[smh])\s*)+)/i);
  return relative ? finiteTime(now + durationMs(relative[1])) : null;
}

export function resetFromHeaders(event, now = Date.now()) {
  if (event?.status !== 429) return null;
  const h = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const times = [];
  if (h['retry-after']) {
    const v = h['retry-after'];
    times.push(/^\d+(?:\.\d+)?$/.test(v) ? now + Number(v) * 1000 : Date.parse(v));
  }
  for (const [key, value] of Object.entries(h)) {
    if (!key.includes('ratelimit') || !key.includes('reset')) continue;
    const remaining = h[key.replace('reset', 'remaining')];
    if (remaining === undefined || !Number.isFinite(Number(remaining)) || Number(remaining) > 0) continue;
    const duration = durationMs(value);
    times.push(/^\d{10,13}$/.test(value) ? Number(value) * (value.length === 13 ? 1 : 1000)
      : duration !== null ? now + duration : Date.parse(value));
  }
  const valid = times.filter((n) => finiteTime(n) !== null);
  return valid.length ? Math.max(...valid) : null;
}

// A missing reset on an exhausted window is not evidence that another window's earlier reset will unblock the account.
function exhaustedReset(windows) {
  const full = windows.filter((w) => w.percent >= 100);
  if (!full.length || full.some((w) => !finiteTime(w.at))) return null;
  return Math.max(...full.map((w) => w.at));
}
export function codexReset(usage, now = Date.now()) {
  const limits = usage?.rate_limit;
  return exhaustedReset([limits?.primary_window, limits?.secondary_window].filter(Boolean).map((w) => ({
    percent: w.used_percent, at: typeof w.reset_at === 'number' ? w.reset_at * 1000
      : typeof w.reset_after_seconds === 'number' ? now + w.reset_after_seconds * 1000 : null,
  })));
}
function relevantClaudeWindow(name, model) {
  const id = String(model?.id ?? '').toLowerCase();
  return !/opus|sonnet|haiku/i.test(name) || ['opus', 'sonnet', 'haiku'].some((family) => name.toLowerCase().includes(family) && id.includes(family));
}
export function claudeReset(usage, model) {
  const relevant = (name) => relevantClaudeWindow(name, model);
  const windows = Array.isArray(usage?.limits)
    ? usage.limits.filter((w) => w && w.is_active !== false && relevant(String(w.scope?.model?.display_name ?? w.scope?.model?.id ?? '')))
      .map((w) => ({ percent: w.percent, at: Date.parse(w.resets_at) }))
    : Object.entries(usage ?? {}).filter(([key, w]) => /^(five_hour|seven_day(?:_opus|_sonnet)?)$/.test(key) && w && relevant(key))
      .map(([, w]) => ({ percent: w.utilization, at: Date.parse(w.resets_at) }));
  return exhaustedReset(windows);
}

// Claude Code authenticates independently of Pi's Anthropic OAuth. Use only its own forwarded stream frame.
// Overage can be disabled for lack of credits while the included five-hour quota still has a renewable reset.
const sdkBilling = (info) => info?.errorCode === 'credits_required' || info?.limitScope === 'group_pool' || info?.rateLimitType === 'overage';
export function claudeSdkReset(info, model) {
  const renewable = (name) => ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included'].includes(name)
    && relevantClaudeWindow(name, model);
  if (info?.status !== 'rejected' || sdkBilling(info) || (info.rateLimitType && !renewable(info.rateLimitType))) return null;
  const windows = Object.entries(info.unifiedWindows ?? {}).filter(([name]) => renewable(name) && name !== info.rateLimitType)
    .map(([, w]) => ({ percent: typeof w?.utilization === 'number' ? w.utilization * 100 : 0, at: w?.resetsAt * 1000 }));
  // A rejected named window is exhausted even when the producer omits its utilization.
  if (renewable(info.rateLimitType)) windows.push({ percent: 100, at: finiteTime(info.resetsAt * 1000)
    ?? finiteTime(info.unifiedWindows?.[info.rateLimitType]?.resetsAt * 1000) });
  return exhaustedReset(windows);
}

export async function usageReset(ctx, error, { now = Date.now(), fetch = globalThis.fetch } = {}) {
  if (BILLING.test(String(error ?? ''))) return null;
  let at = null;
  try {
    if (applies(ctx.model, ctx.modelRegistry)) at = codexReset(await fetchUsage(ctx.modelRegistry, { model: ctx.model, fetch }), now);
    else if (claudeApplies(ctx.model, ctx.modelRegistry)) at = claudeReset(await fetchClaudeUsage(ctx.modelRegistry, { model: ctx.model, fetch }), ctx.model);
  } catch { /* The error itself can still supply a reset time. */ }
  return at ?? resetFromError(error, now);
}

export function installUsageResume(pi, { notify, measure, now = () => Date.now(), resolveReset = usageReset, claudeProfiles,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const sdkProviders = claudeCodeLabels(claudeProfiles);
  let pending = null, timer = null, generation = 0, responseReset = null, sdkReset = null, failure = null, runGoalId = null, resolving = null;
  let manuallyParkedGoal = null, started = false, restoringModel = false;
  const currentSdkReset = (ctx) => sdkReset?.model === modelKey(ctx) ? sdkReset.at : null;
  const stop = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const clearRequest = () => { responseReset = null; sdkReset = null; failure = null; runGoalId = null; };
  const status = (ctx, at) => ctx?.ui?.setStatus?.(USAGE_RESUME_ENTRY, at ? `mina: goal resumes after ${new Date(at).toISOString()} · /goal pause cancels` : undefined);
  const cancel = (ctx, persist = true) => {
    generation++; stop(); resolving = null; clearRequest();
    if ((pending || restoringModel) && persist) pi.appendEntry(USAGE_RESUME_ENTRY, null);
    pending = null; restoringModel = false; status(ctx, null);
  };
  const recoveryCandidate = (ctx) => {
    const g = goal(ctx), interrupted = failure;
    // An inactive goal can remain in history during unrelated conversation. Only a fresh failure of its own run
    // can create a new schedule. Persisted schedules have a separate restoration path.
    if (!parked(g) || !interrupted || interrupted.goalId !== g.id || manuallyParkedGoal === g.id
      || (sdkReset?.model === modelKey(ctx) && sdkReset.billing) || BILLING.test(interrupted.error)) return null;
    const fromError = resetFromError(interrupted.error, interrupted.at), fromSdk = currentSdkReset(ctx);
    if (g.status !== 'usage_limited' && responseReset === null && fromError === null && fromSdk === null) return null;
    return { g, interrupted, fromError, fromSdk };
  };
  // A synchronous, session-local Pi event: the caller doesn't need to know how quota waits are represented.
  // Host can poll in session_start before our own handler, so check the branch then rather than requiring an armed timer.
  pi.events?.on?.('mina:automatic-turn-check', ({ ctx, sessionStartReason, suppress }) => {
    if (!started) {
      if (sessionStartReason === 'new' ? savedWait(ctx) : quotaHandoffState(ctx)) suppress();
      return;
    }
    if ((pending && matches(ctx, pending)) || (resolving && matches(ctx, resolving)) || (restoringModel && savedWait(ctx))
      || recoveryCandidate(ctx)) suppress();
  });
  const arm = (ctx) => {
    stop();
    const mine = generation;
    timer = setTimer(() => {
      timer = null;
      if (mine !== generation || !pending) return;
      try {
        if (!matches(ctx, pending)) { cancel(ctx); return; }
        // Chunk long waits to prevent Node's timeout overflow and handle sleep/wake or clock changes.
        if (now() < pending.resumeAt || ctx.isIdle?.() === false || ctx.hasPendingMessages?.()) { arm(ctx); return; }
        cancel(ctx);
        measure?.({ kind: 'usage_limit_resume' });
        pi.sendUserMessage('/goal resume', { expandPromptTemplates: true });
      } catch { cancel(ctx, false); /* Stale session context. Never resume a different session. */ }
    }, Math.min(60_000, Math.max(1000, pending.resumeAt - now())));
    timer?.unref?.();
  };
  const schedule = async (ctx) => {
    if (pending) return matches(ctx, pending);
    if (resolving || restoringModel) return false;
    const candidate = recoveryCandidate(ctx);
    if (!candidate) return false;
    const { g, interrupted, fromError, fromSdk } = candidate;
    const mine = generation, key = modelKey(ctx), sig = signature(g), fromResponse = responseReset;
    failure = null;
    resolving = { goalSignature: sig, model: key };
    try {
      const at = await resolveReset(ctx, interrupted.error, { now: now() });
      if (mine !== generation || key !== modelKey(ctx) || sig !== signature(goal(ctx))) return false;
      const evidence = [at, fromResponse, fromError, fromSdk].filter((n) => finiteTime(n) !== null && n >= now() - MARGIN_MS);
      if (!evidence.length) {
        notify?.(ctx, 'mina: no reset time is available for this usage limit. Run /goal resume when usage is available.', 'warning');
        return false;
      }
      const revision = waitRevision(g);
      pending = { goalSignature: sig, ...(revision ? { goalRevision: revision } : {}), model: key, resumeAt: Math.max(...evidence, now()) + MARGIN_MS };
      pi.appendEntry(USAGE_RESUME_ENTRY, pending);
      status(ctx, pending.resumeAt);
      notify?.(ctx, `mina: usage limit. The goal resumes after ${new Date(pending.resumeAt).toISOString()}. /goal pause cancels the automatic resume.`, 'warning');
      measure?.({ kind: 'usage_limit_wait', resume_at: pending.resumeAt });
      arm(ctx);
      return true;
    } finally { if (mine === generation) resolving = null; }
  };
  pi.on('agent_start', (_event, ctx) => {
    // Other extensions can still start a run while quota-parked. That does not revoke the pending resume.
    // Human input and goal/model/session changes cancel explicitly at their own boundaries.
    if ((pending && matches(ctx, pending)) || (resolving && matches(ctx, resolving)) || restoringModel) { clearRequest(); return; }
    cancel(ctx);
    const g = goal(ctx);
    runGoalId = g?.status === 'active' && g.id !== manuallyParkedGoal ? g.id : null;
  });
  pi.on('before_provider_request', (_event, ctx) => {
    clearRequest();
    // Extension steering can arrive inside one agent run. Bind the next request to the current goal, rather than
    // relying on run ownership captured before that input or a model switch.
    const g = goal(ctx);
    runGoalId = g?.status === 'active' && g.id !== manuallyParkedGoal ? g.id : null;
  });
  pi.on('after_provider_response', (event) => { responseReset = resetFromHeaders(event, now()); });
  pi.on('provider_stream_event', (event, ctx) => {
    if (!runGoalId || !sdkProviders.has(event.provider) || event.provider !== ctx.model?.provider || event.model !== ctx.model?.id) return;
    // Claude Code can retry internally without starting another outer provider request. A response that starts
    // afterward cannot inherit the rejected quota state of the earlier response.
    if (event.data?.type === 'message_start') { sdkReset = null; return; }
    if (event.data?.type !== 'rate_limit_event') return;
    const info = event.data.rate_limit_info;
    sdkReset = { model: modelKey(ctx), at: claudeSdkReset(info, ctx.model), billing: info?.status === 'rejected' && sdkBilling(info) };
  });
  pi.on('message_end', (event, ctx) => {
    const m = event.message;
    if (!runGoalId || m?.role !== 'assistant' || m.stopReason !== 'error' || !sdkProviders.has(m.provider)
      || m.provider !== ctx.model?.provider || m.model !== ctx.model?.id || currentSdkReset(ctx) === null || BILLING.test(String(m.errorMessage ?? ''))) return;
    // Claude Code says "session limit", which pi-goal otherwise treats as a generic blocker. Normalize only when
    // this exact request also supplied a renewable rejection; unrelated errors retain their original classification.
    if (!/usage[_\s-]*limit/i.test(String(m.errorMessage ?? ''))) {
      return { message: { ...m, errorMessage: `Claude Code usage limit reached: ${m.errorMessage ?? ''}` } };
    }
  });
  const observeAssistant = (message) => {
    if (message?.role !== 'assistant') return;
    failure = runGoalId && message.stopReason === 'error'
      ? { goalId: runGoalId, error: String(message.errorMessage ?? ''), at: now() } : null;
  };
  pi.on('turn_end', (event) => { observeAssistant(event.message); });
  pi.on('agent_end', (event) => {
    observeAssistant((event.messages ?? []).filter((m) => m?.role === 'assistant').at(-1));
  });
  pi.on('agent_settled', async (_event, ctx) => { await schedule(ctx); });
  pi.on('cache_warming_decision', () => pending || resolving || restoringModel ? { action: 'stop' } : undefined);
  pi.on('input', (event, ctx) => {
    if (event.source === 'extension') return;
    if (pending || resolving || restoringModel) manuallyParkedGoal = goal(ctx)?.id ?? null;
    cancel(ctx);
  });
  pi.on('model_select', (_event, ctx) => {
    if (restoringModel) return; // Handoff announces when its initial model selection is finished.
    manuallyParkedGoal = null; cancel(ctx);
  });
  const restore = (ctx, { deadline }) => {
    pending = deadline; status(ctx, pending.resumeAt); arm(ctx);
    notify?.(ctx, `mina: the goal resumes after ${new Date(pending.resumeAt).toISOString()}. /goal pause cancels the automatic resume.`, 'info');
  };
  pi.on('session_start', (event, ctx) => {
    started = true;
    manuallyParkedGoal = null;
    cancel(ctx, false);
    // Pi selects a default before newSession setup. Only a copied, matching goal wait can defer restore to handoff.
    const carried = quotaHandoffState(ctx);
    if (carried) restore(ctx, carried);
    else restoringModel = event?.reason === 'new' && !!savedWait(ctx);
  });
  pi.events?.on?.('mina:handoff-model-ready', (ctx) => {
    if (!restoringModel) return;
    const carried = quotaHandoffState(ctx);
    if (!carried) { cancel(ctx); return; }
    restoringModel = false;
    restore(ctx, carried);
  });
  // Branch navigation must not revive a schedule from a branch the user left.
  for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree']) pi.on(event, (_event, ctx) => cancel(ctx));
  pi.on('session_shutdown', (_event, ctx) => cancel(ctx, false)); // Keep the persisted deadline for /resume.
  return { cancel: (ctx) => { manuallyParkedGoal = null; cancel(ctx); }, schedule, waiting: () => !!(pending || resolving || restoringModel) };
}
