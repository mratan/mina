// mina /goal: the unmodified @narumitw/pi-goal 0.54.8 (pinned in package.json), plus mina's goal rules, enforced in
// this process without a separate supervisor (docs/architecture.md):
// - new goals use editable, agent-selected working checks. Requirements remain binding.
// - --check CMD and --protect-checks opt into protected acceptance checks; pre-upgrade contracts stay protected.
// - protected check files are hash-guarded. Changing working tests needs no approval; changing a protected contract does.
// - when the model calls goal_complete, mina reruns every check in the project folder; a failure refuses the call and
//   the output goes back to the model as rejection feedback.
// - a wrong check can be replaced only with the user's consent: the model asks through mina_propose_checks with a reason,
//   or the user uses /goal add-check, withdraw-check, edit-checks.
// - research first, through the mina-research skill, unless --no-research.
// pi-goal is loaded through a proxy that wraps only its /goal command handler; the rest of pi-goal is unchanged.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync, renameSync } from '../../sandbox/project-fs.mjs';
import { join, relative, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { checkCommand } from './check-execution.mjs';
import { hashCheckFiles, changedFiles } from './check-files.mjs';
import { DEFAULT_STALL_RUNS, observeWorkload, liveWorkload, toolEffect, gitSnapshot, nextStall } from './stall.mjs';
export { hashCheckFiles, changedFiles } from './check-files.mjs';
import { record } from '../handoff/metrics.mjs';
import { tuningForModel } from '../handoff/policy.mjs';
import { loadTuning, readModelTuning } from '../../lib/model-tuning.mjs';
import { ASK_TOOL, WIDGET, OTHER, DETAILS, questionLines, validateOperatorAction, operatorProcedure } from './ask.mjs';
import { instanceDecisions } from '../../lib/instance-decisions.mjs';
import { oneDialog, serialUi } from '../../lib/dialog-lock.mjs';
import { parseGoalArgs, goalCommandSuggestion, upstreamArgs, numberChecks, formatChecks, parseCheckLines, goalInstructions, rejectionFeedback, isMinaPath, isCheckPath, checkScriptsIn, unusedCheckScripts, dryRunVerdict, proposalSummary, statusLine, formatStatus, stripGoalPrompts, goalInstructionsMinimal, minimizeGoalRules } from './checks.mjs';

export const ENTRY = 'mina-goal';
export const DRAFTS = '.mina/checks-proposed'; // revised check scripts waiting for the user (not frozen)
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
export const DRY_RUN_TIMEOUT_MS = 60 * 1000; // the proposal-time run of each check
// How long the dialog for replacing accepted checks waits before mina queues the request for the user (who may be away:
// in one overnight test run, the agent worked around two broken checks rather than block on the dialog).
export const AMEND_WAIT_MS = 5 * 60 * 1000;
const OUTPUT_KEEP = 4000;

// A new goal archives the previous goal's working files under .mina/archive/<time>/. An old plan.md would otherwise
// be shown after every compaction. briefs/
// (research context) stays, and so does checks/: old check scripts are shown to the user at the next proposal, to be
// revised or dropped. Returns the archive folder (relative), or null when there was nothing to move.
// host-capabilities.json is the host broker's report on the host (extensions/host), not the goal's: it stays.
const KEEP = new Set(['briefs', 'archive', 'checks', 'host-capabilities.json']);
export function archivePreviousGoal(cwd, { now = new Date() } = {}) {
  const dir = join(cwd ?? '.', '.mina');
  let names; try { names = readdirSync(dir); } catch { return null; }
  const move = names.filter((n) => !KEEP.has(n));
  if (!move.length) return null;
  const rel = join('.mina', 'archive', now.toISOString().slice(0, 19).replace(/[:T]/g, '-'));
  mkdirSync(join(cwd, rel), { recursive: true });
  for (const n of move) renameSync(join(dir, n), join(cwd, rel, n));
  return rel;
}

export function createMinaGoal(pi, { goalExtension, env = process.env, sandboxAvailable, tuning = loadTuning(env), measure = record, amendWaitMs = AMEND_WAIT_MS, readTuning = readModelTuning,
  snapshot = (cwd) => gitSnapshot((...a) => pi.exec(...a), cwd) }) {
  let state = null;
  let upstreamGoal = null; // pi-goal's own /goal handler: the no-effect guard pauses through it
  const decisions = instanceDecisions(env.MINA_INSTANCE_ID);
  const saveDecisions = () => pi.appendEntry?.('mina-decisions', decisions.snapshot());
  const operatorStatus = (ctx) => {
    const pending = decisions.operators().filter((r) => !r.historical && r.operatorStatus === 'awaiting_execution');
    ctx?.ui?.setStatus?.('mina-operator', pending.length ? `mina: waiting for operator output (${pending.length}) · /goal actions` : undefined);
  };
  // Missing policy denotes a pre-upgrade protected contract, never an editable default.
  const protectedChecks = () => state?.checkPolicy !== 'working';
  const liveTuning = (ctx) => tuningForModel(tuning, ctx?.model, readTuning);
  // Resolve at each operation: /model changes settings without replacing the goal or its checks.
  const minimalPrompts = (ctx) => liveTuning(ctx)?.goal_prompt === 'minimal';
  const instructions = (s, ctx) => (minimalPrompts(ctx) ? goalInstructionsMinimal(s) : goalInstructions(s));
  // Checks run in the sandbox's inner layer like the agent's bash (credentials
  // and mina's code hidden). That layer's packages proxy belongs to the bash tool, so here that level runs offline.
  const sandboxed = (command, cwd) => checkCommand(command, cwd, { env, available: sandboxAvailable,
    frozen: protectedChecks() && state?.settled !== false ? state?.frozen : null });
  let uiContext = null;
  const amendmentWidget = () => {
    if (!uiContext?.hasUI) return;
    const pending = state?.pendingAmendment && !['complete', 'cleared'].includes(state.status);
    uiContext.ui.setWidget?.('mina-amendment', pending
      ? [`mina: check change pending — ${state.pendingAmendment.reason}`, 'Decide with /goal amendment.'] : undefined);
  };
  const save = () => { pi.appendEntry(ENTRY, state); amendmentWidget(); };
  const notify = (ctx, text, level = 'info') => { if (ctx?.hasUI) ctx.ui.notify(text, level); };
  const settle = (checks, cwd, extra = {}) => {
    state = { ...state, ...extra, checks, settled: true, unverified: !checks.length, frozen: protectedChecks() ? hashCheckFiles(cwd) : {}, results: null };
    save();
  };

  function describe() {
    if (!state) return 'mina: no goal in this session.';
    const head = `mina goal (${state.status}${state.unverified ? ', UNVERIFIED' : ''}${protectedChecks() ? '' : ', agent-selected working checks'}): ${state.objective}`;
    if (state.mode === 'plan' && !state.settled) return `${head}\nChecks: not proposed yet.`;
    if (!state.checks.length) return `${head}\nChecks: none.`;
    const uncovered = state.uncovered?.length ? `\nNot covered by any check:\n${state.uncovered.map((u) => `  - ${u}`).join('\n')}` : '';
    const last = new Map((state.results ?? []).map((r) => [r.id, r]));
    return `${head}\nChecks:\n${state.checks.map((c) => {
      const r = last.get(c.id);
      return `  ${c.id}: ${c.command}${r ? `  [last run: ${r.code === 0 ? 'pass' : `fail, exit ${r.killed ? 'timeout' : r.code}`}]` : ''}`;
    }).join('\n')}${uncovered}`;
  }

  // Shell syntax errors in proposed commands (bash -n). Returns a list of problems.
  async function syntaxProblems(checks, cwd) {
    const out = [];
    for (const c of checks) {
      const r = await pi.exec('bash', ['-n', '-c', c.command], { cwd, timeout: 10_000 });
      if (r.code !== 0) out.push(`${c.id}: ${String(r.stderr || r.stdout).trim().split('\n')[0]}`);
    }
    return out;
  }

  // Show each check's observed proposal-time result; nonzero output alone cannot prove its logic is broken.
  async function dryRun(checks, cwd, pendingScripts = false) {
    const out = [];
    for (const c of checks) {
      // A frozen script can import another proposed script. Do not grade old content as the candidate.
      if (pendingScripts && checkScriptsIn(c.command).length) {
        out.push({ id: c.id, status: 'not-run', text: 'NOT RUN: proposed replacement scripts are not installed until approval. The current frozen scripts are not the proposal.' });
        continue;
      }
      const r = await pi.exec('bash', ['-c', sandboxed(c.command, cwd)], { cwd, timeout: DRY_RUN_TIMEOUT_MS });
      out.push({ id: c.id, ...dryRunVerdict(r) });
    }
    return out;
  }

  // The check scripts' contents, for the user to read before deciding.
  function scriptText(checks, files, cwd) {
    const pending = new Map(files.map((f) => [relative(cwd ?? '.', resolve(cwd ?? '.', f.path)), f.content]));
    const paths = [...new Set(checks.flatMap((c) => checkScriptsIn(c.command)))];
    return paths.map((p) => {
      let text = pending.get(p);
      if (text === undefined) { try { text = readFileSync(join(cwd ?? '.', p), 'utf8'); } catch { text = '(unreadable)'; } }
      return `===== ${p}\n${text}`;
    }).join('\n\n') || 'No check names a script under .mina/checks/.';
  }

  // The user's own changes to the checks: /goal add-check "CMD", withdraw-check ID, edit-checks.
  async function userEdit(sub, rest, ctx) {
    if (!state || state.status !== 'active') { notify(ctx, 'mina: no active goal.', 'error'); return; }
    let checks = state.checks;
    if (sub === 'add-check') {
      if (!rest) { notify(ctx, 'Usage: /goal add-check "CMD"', 'error'); return; }
      checks = numberChecks([...checks, { command: rest, proves: 'added by the user' }]);
    } else if (sub === 'withdraw-check') {
      if (!checks.some((c) => c.id === rest)) { notify(ctx, `mina: no check ${rest}. ${describe()}`, 'error'); return; }
      checks = numberChecks(checks.filter((c) => c.id !== rest));
    } else {
      if (!ctx?.hasUI) { notify(ctx, 'mina: edit-checks needs the interactive editor.', 'error'); return; }
      const edited = await oneDialog(() => ctx.ui.editor('Edit the checks: one command per line, "R1: command" form; # lines are ignored', formatChecks(checks)));
      if (edited === undefined) return;
      checks = parseCheckLines(edited);
    }
    settle(checks, ctx.cwd, { mode: checks.length ? (state.mode === 'none' ? 'given' : state.mode) : 'none', checkApproval: 'user', rejections: 0 });
    pi.sendMessage({ customType: ENTRY, display: true, content: checks.length
      ? `The user changed the checks for this goal:\n${formatChecks(checks)}\nmina reruns these when you call goal_complete.`
      : 'The user removed every check. Your completion will be marked UNVERIFIED.' }, { triggerTurn: false });
    notify(ctx, describe());
  }

  // The user decides a queued check change (mina_propose_checks queued it when nobody answered).
  async function decideAmendment(ctx) {
    const a = state?.pendingAmendment;
    if (!a) { notify(ctx, 'mina: no check change is waiting.', 'info'); return; }
    if (!ctx?.hasUI) { notify(ctx, 'mina: /goal amendment needs the interactive dialog.', 'error'); return; }
    const title = `The agent asked (${a.at.slice(0, 16).replace('T', ' ')}Z) to replace the accepted checks.\nReason: ${a.reason}\n\n`
      + `Current:\n${formatChecks(state.checks)}\n\n${proposalSummary({ restated: a.restated ?? state.objective, checks: a.checks,
        dryRuns: a.dryRuns ?? [], uncovered: a.uncovered ?? [], unused: a.unused ?? [], requirements: a.requirements })}`
      + a.files.map((f) => `\n\nNew content for ${f.path}:\n${f.content.length > 3000 ? `${f.content.slice(0, 3000)}\n[… ${f.content.length - 3000} more characters]` : f.content}`).join('');
    let edited;
    const choice = await oneDialog(async () => {
      const picked = await ctx.ui.select(title, ['Accept the new checks', 'Edit', 'Keep the current checks']);
      if (picked === 'Edit') edited = await ctx.ui.editor('Edit the checks: one command per line, "R1: command" form; # lines are ignored', formatChecks(a.checks));
      return picked;
    });
    if (choice === undefined) return;                                                  // closed: still waiting
    let checks = a.checks;
    if (choice === 'Edit') {
      const parsed = parseCheckLines(edited ?? '');
      if (!parsed.length) return;
      checks = parsed;
    }
    if (choice === 'Keep the current checks') {
      state = { ...state, pendingAmendment: undefined }; save();
      pi.sendMessage({ customType: ENTRY, display: true, content: `The user kept the current checks (your change: ${a.reason}).\n${formatChecks(state.checks)}\n`
        + 'Make the work pass them, or call goal_blocked if you cannot.' }, { triggerTurn: true });
      return;
    }
    for (const f of a.files) { const p = resolve(ctx.cwd ?? '.', f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }
    for (const d of a.draftPaths ?? []) { try { rmSync(join(ctx.cwd ?? '.', d)); } catch { /* already gone */ } }
    state = { ...state, pendingAmendment: undefined };
    settle(checks, ctx.cwd, { mode: checks.length ? (state.mode === 'none' ? 'given' : state.mode) : 'none', checkApproval: 'user', rejections: 0, uncovered: a.uncovered ?? state.uncovered,
      ...(a.requirements ? { requirements: a.requirements } : {}) });
    pi.sendMessage({ customType: ENTRY, display: true, content: `The user accepted the check change you asked for (${a.reason}):\n${formatChecks(checks)}\n`
      + 'mina reruns these when you call goal_complete.' }, { triggerTurn: true });
  }

  const lastEntry = (ctx) => (ctx?.sessionManager?.getBranch?.() ?? []).filter((e) => e.type === 'custom' && e.customType === ENTRY).at(-1)?.data ?? null;

  function wrapGoalCommand(options) {
    upstreamGoal = options.handler;
    return {
      ...options,
      description: 'Run a goal with editable working checks: /goal [--check CMD | --protect-checks | --no-check] [--no-research] [--tokens N] <objective>; '
        + 'also /goal actions | checks | add-check "CMD" | withdraw-check ID | edit-checks | amendment | reopen <reason>',
      handler: async (args, ctx) => {
        uiContext = ctx;
        const suggestion = goalCommandSuggestion(args);
        if (suggestion) {
          const word = String(args).trim();
          const message = `Did you mean /goal ${suggestion}? Starting a new goal named "${word}" replaces the current goal and archives its working files.`;
          if (!ctx?.hasUI || !ctx.ui.confirm || !(await oneDialog(() => ctx.ui.confirm('Start a new goal?', message)))) {
            notify(ctx, `mina: no goal changed. ${message} Use a longer objective or a goal file if this word is intentional.`, 'warning');
            return;
          }
        }
        let p = parseGoalArgs(args);
        // A goal that a handoff carried as blocked or paused has no pi-goal run in this session to resume: /goal resume
        // continues it the way the handoff would have, now that the user asked.
        const carried = p.pass && String(args ?? '').trim() === 'resume' ? lastEntry(ctx) : null;
        if (carried?.resume_on_request && carried.status !== 'active') p = { sub: 'mina-continue', rest: '', resumed: carried.status };
        if (p.pass) {
          const first = String(args ?? '').trim().split(/\s+/, 1)[0];
          await options.handler(args, serialUi(ctx));
          if ((first === 'clear' || first === 'stop') && state?.status === 'active') { state = { ...state, status: 'cleared' }; save(); }
          return;
        }
        if (p.sub === 'checks') { notify(ctx, describe()); return; }
        if (p.sub === 'actions') {
          const actions = decisions.operators();
          if (!actions.length) { notify(ctx, 'mina: no operator actions recorded in this instance.'); return; }
          if (!ctx?.hasUI) { notify(ctx, 'mina: /goal actions needs an interactive terminal.', 'warning'); return; }
          const labels = actions.map((r) => `${r.id}: ${r.operatorStatus}${r.historical ? ' (recovered history, not current authorization)' : ''}`);
          await oneDialog(async () => {
            const choice = await ctx.ui.select('Operator actions — view commands and recorded status', labels);
            const action = actions[labels.indexOf(choice)];
            if (action) await ctx.ui.editor('Operator procedure (view/copy; edits are not saved)',
              (action.historical ? 'Recovered history: review current state and authority before acting.\n\n' : '') + operatorProcedure(action.scope.operator_action));
          });
          return;
        }
        if (p.sub === 'mina-continue' || p.sub === 'reopen') {
          // mina-continue: internal, sent by mina's handoff into the successor session (the handoff wrote the goal state
          // there). reopen: the user's, for a goal whose completion they no longer accept; its checks and metadata carry over.
          const found = lastEntry(ctx);
          const last = p.resumed ? { ...found, status: 'active', resume_on_request: undefined, resumed: { at: new Date().toISOString(), from: p.resumed } } : found;
          const reopen = p.sub === 'reopen';
          if (!last || last.status !== (reopen ? 'complete' : 'active')) {
            notify(ctx, reopen ? `mina: no completed goal to reopen in this session${last?.status === 'active' ? ' (the goal is still active: /goal mina-continue)' : ''}.`
              : `mina: no active goal to continue in this session${last?.status === 'complete' ? ' (it is complete: /goal reopen <reason> makes it active again)' : ''}.`, 'warning');
            return;
          }
          const now = new Date().toISOString();
          const reason = String(p.rest ?? '').trim() || 'the user does not accept the completion';
          state = { ...last, research: false, continued_at: now, generation: (last.generation ?? 1) + 1,
            ...(reopen ? { status: 'active', completed_at: undefined, rejections: 0, reopened: { at: now, reason } } : {}) };
          save();
          const why = reopen ? `mina: the user reopened this goal: ${reason}. Its earlier completion no longer counts; finish it again.\n\n` : '';
          pi.sendMessage({ customType: ENTRY, content: `${why}${instructions(state, ctx)}`, display: true, details: { goal: state.id } }, { triggerTurn: false });
          await options.handler(upstreamArgs({ objective: state.objective, tokens: state.tokens }), serialUi(ctx));
          return;
        }
        if (p.sub === 'amendment') { await decideAmendment(ctx); return; }
        if (p.sub) { await userEdit(p.sub, p.rest, ctx); return; }
        if (p.errors.length) { notify(ctx, p.errors.join('\n'), 'error'); return; }
        const mode = p.noCheck ? 'none' : p.checks.length ? 'given' : p.protectChecks ? 'plan' : 'working';
        // An objective that is only a path to a file: the instructions are in the file (pi-goal limits an objective to
        // 4,000 characters, and its error says to do this). pi-goal keeps the path; mina gives the agent the text.
        let objectiveFile = null, objectiveBody = null;
        if (/^\S+$/.test(p.objective)) {
          const abs = resolve(ctx?.cwd ?? '.', p.objective.replace(/^~(?=\/)/, homedir()));
          try { if (statSync(abs).isFile() && statSync(abs).size <= 65536) { objectiveFile = abs; objectiveBody = readFileSync(abs, 'utf8').trim(); } } catch { /* not a file */ }
        }
        let archived = null;
        try { archived = archivePreviousGoal(ctx?.cwd); } catch { /* best effort */ }
        state = { id: randomUUID(), objective: p.objective, mode, completionPolicy: 'checks-only', checkPolicy: mode === 'working' ? 'working' : 'protected',
          checks: numberChecks(p.checks), checkApproval: mode === 'given' ? 'user' : null, settled: mode !== 'plan' && mode !== 'working',
          research: !p.noResearch, unverified: mode === 'none', status: 'active', rejections: 0, results: null,
          // Checks given with --check are accepted now: their scripts are frozen now (an empty snapshot refused every completion).
          frozen: mode === 'given' ? hashCheckFiles(ctx?.cwd) : {}, tokens: p.tokens,
          started_at: new Date().toISOString(), ...(archived ? { archived } : {}), ...(objectiveFile ? { objective_file: objectiveFile } : {}) };
        save();
        const moved = archived ? `mina moved the previous goal's working files (files in .mina/; check scripts stay in .mina/checks/) to ${archived}/. `
          + 'They are a record of that goal, not part of this one: read them only if this objective builds on them.\n\n' : '';
        const body = objectiveFile ? `The objective is the text of the file ${objectiveFile}:\n\n<objective_file>\n${objectiveBody}\n</objective_file>\n\n` : '';
        pi.sendMessage({ customType: ENTRY, content: `${moved}${body}${instructions(state, ctx)}`, display: true, details: { goal: state.id } }, { triggerTurn: false });
        await options.handler(upstreamArgs(p), serialUi(ctx));
      },
    };
  }

  // pi-goal sees the real API, except that its /goal handler is wrapped.
  const proxy = new Proxy(pi, {
    get(target, key) {
      if (key === 'registerCommand') return (name, options) => target.registerCommand(name, name === 'goal' ? wrapGoalCommand(options) : options);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  goalExtension(proxy);

  // When a run ends, the input box must not hold pi-goal's own prompt (see stripGoalPrompts): Pi returns queued
  // messages there when pi-goal aborts a turn to stop a goal.
  // pi-goal's rule block, in the messages as sent to the model only. The session keeps pi-goal's own text, which its
  // prompt tracking matches by marker and by a fingerprint of the whole text, so rewriting the input would break it.
  pi.on('context', (event, ctx) => {
    const minimal = minimalPrompts(ctx);
    let changed = false;
    const fix = (text, message) => {
      let next = minimal ? minimizeGoalRules(text) : text;
      // Kickoff instructions already in history must follow a mid-goal switch too. Keep objective/file prefixes.
      if (state && message.customType === ENTRY && (!message.details?.goal || message.details.goal === state.id)) {
        const at = next.search(/mina goal (?:rules for this goal|machinery):/);
        if (at >= 0) next = next.slice(0, at) + instructions(state, ctx);
      }
      if (next !== text) changed = true;
      return next;
    };
    const messages = (event.messages ?? []).map((m) => {
      if (typeof m?.content === 'string') return { ...m, content: fix(m.content, m) };
      if (!Array.isArray(m?.content)) return m;
      return { ...m, content: m.content.map((b) => b?.type === 'text' ? { ...b, text: fix(b.text, m) } : b) };
    });
    return changed ? { messages } : undefined;
  });

  // Provider errors (2026-10-13 23:33: one transient Codex error parked the goal until a person noticed, hours later).
  // When pi-goal has parked the goal after Pi's own retries were exhausted, mina resumes it after a backoff
  // (tuning provider_retry.delays_s, default 2, 5 and 15 minutes), and stops after the last one. A usage limit is a
  // different state (usage_limited) and is not retried: it only spends calls until the quota resets.
  let retryTimer = null, retryCount = 0;
  const latestGoalState = (ctx) => (ctx?.sessionManager?.getBranch?.() ?? []).filter((e) => e.type === 'custom' && e.customType === 'goal-state').at(-1)?.data?.goal ?? null;
  const scheduleProviderRetry = (ctx) => {
    const retryDelaysMs = (liveTuning(ctx)?.provider_retry?.delays_s ?? [120, 300, 900]).map((s) => s * 1000);
    const g = latestGoalState(ctx);
    const reason = String(g?.waiting?.reason ?? '');
    if (!g || g.status !== 'active' || !reason.startsWith('Provider retries exhausted')) return;
    if (retryTimer) return;
    if (retryCount >= retryDelaysMs.length) {
      notify(ctx, `mina: the goal is still parked after ${retryCount} automatic resumes (${reason.slice(0, 160)}). Run /goal resume when the provider works again.`, 'warning');
      return;
    }
    const delay = retryDelaysMs[retryCount++];
    notify(ctx, `mina: provider error (${reason.slice(0, 160)}); the goal resumes by itself in ${Math.round(delay / 60000)} min (attempt ${retryCount} of ${retryDelaysMs.length}).`, 'warning');
    measure({ kind: 'provider_retry', attempt: retryCount, delay_s: delay / 1000 });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const now = latestGoalState(ctx);
      if (now?.status === 'active' && String(now?.waiting?.reason ?? '').startsWith('Provider retries exhausted')) {
        pi.sendUserMessage('/goal resume', { expandPromptTemplates: true });
      }
    }, delay);
    retryTimer.unref?.();
  };
  pi.on('agent_settled', (_event, ctx) => { const t = setTimeout(() => { try { scheduleProviderRetry(ctx); } catch { /* stale */ } }, 1000); t.unref?.(); });
  pi.on('turn_end', (event) => { if (event?.message?.role === 'assistant' && event.message.stopReason !== 'error') retryCount = 0; return undefined; });
  pi.on('session_shutdown', () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (uiContext?.hasUI) uiContext.ui.setWidget?.('mina-amendment', undefined);
    uiContext?.ui?.setStatus?.('mina-operator', undefined);
    uiContext = null;
  });

  // No-effect guard (stall.mjs): pi-goal labels each run automatic or not; mina records the run's effects and, after
  // the configured number of automatic runs in a row without one, pauses the goal before pi-goal dispatches the next
  // continuation (pi-goal does that at agent_settled; its agent_end handler runs before this one).
  let run = null, workloads = null, stallNotice = null;
  const noteEffect = (what) => { if (run) run.effects.push(what); };
  pi.on('agent_start', (_event, ctx) => {
    const goal = latestGoalState(ctx);
    run = state?.status === 'active' && goal?.status === 'active'
      ? { goalId: goal.id, autoTurns: goal.automaticModelTurns ?? 0, effects: [], before: snapshot(ctx?.cwd) } : null;
  });
  pi.on('tool_result', (event) => {
    const effect = toolEffect(event);
    if (effect) noteEffect(effect);
    if (event?.toolName === 'mina_host' && !event.isError && state) {
      const seen = observeWorkload(workloads ?? state.workloads, event.details?.result);
      workloads = seen.workloads;
      if (seen.finished) noteEffect(`workload ${event.details.result.id} ${event.details.result.state}`);
    }
    return undefined;
  });
  pi.on('agent_end', async (_event, ctx) => {
    const r = run;
    run = null;
    if (!r || state?.status !== 'active') return;
    const goal = latestGoalState(ctx);
    if (goal?.status !== 'active') return;                                   // pi-goal already completed, blocked or paused it
    const [before, after] = await Promise.all([r.before, snapshot(ctx?.cwd)]);
    if (before && after && before !== after) r.effects.push('git HEAD or changed-path set');
    const known = workloads ?? state.workloads;
    const automatic = goal.id === r.goalId && (goal.automaticModelTurns ?? 0) > r.autoTurns;
    const { stall, kind } = nextStall(state.stall, goal, { automatic, effects: r.effects, live: liveWorkload(known) });
    const tuned = liveTuning(ctx)?.goal_stall_runs;
    const limit = tuned === null ? null : (Number.isSafeInteger(tuned) && tuned > 0 ? tuned : DEFAULT_STALL_RUNS);
    const stalled = kind === 'stalled' && limit !== null && stall.count >= limit;
    // Saved when it matters on restart or handoff, not every run: each entry carries the whole goal state.
    if (stalled || stall.goalId !== state.stall?.goalId || stall.count !== state.stall?.count || known !== state.workloads) {
      state = { ...state, stall: stalled ? { ...stall, count: 0, paused_at: new Date().toISOString() } : stall, workloads: known };
      save();
    }
    if (!stalled) return;
    const why = `${stall.count} automatic runs in a row changed nothing outside the conversation (no file written or edited, `
      + 'no git commit or change to the set of changed files, no broker workload submitted, stopped or seen to finish, no check change), '
      + 'and none of them waited on a live broker workload';
    measure({ kind: 'goal_stall_pause', runs: stall.count, limit });
    stallNotice = why;
    await upstreamGoal?.('pause', serialUi(ctx));
    notify(ctx, `mina: goal paused: ${why}. /goal resume continues it.`, 'warning');
  });

  pi.on('agent_settled', (_event, ctx) => {
    if (stallNotice) {
      pi.sendMessage({ customType: ENTRY, display: true, content: `mina paused this goal: ${stallNotice}. `
        + 'If the work is waiting on something, wait on it with goal_wait (a broker workload you started or checked keeps the goal alive); '
        + 'if it cannot progress, say why and call goal_blocked.' }, { triggerTurn: false });
      stallNotice = null;
    }
    const ui = ctx?.ui;
    if (!ui?.getEditorText || !ui?.setEditorText) return;
    const r = stripGoalPrompts(ui.getEditorText());
    if (r.removed) {
      ui.setEditorText(r.text);
      notify(ctx, `mina: removed ${r.removed} goal prompt(s) that Pi put back in the input box when the goal stopped. `
        + 'They were not yours; /goal resume continues the goal.', 'warning');
    } else if (r.unrecognized) {
      notify(ctx, 'mina: the input box holds a pi-goal prompt marker (<!-- pi-goal-... -->). It is probably a goal prompt Pi put back '
        + 'when the goal stopped, not your text: check it before sending.', 'warning');
    }
  });

  pi.on('session_start', (_event, ctx) => {
    uiContext = ctx;
    const entries = ctx.sessionManager?.getBranch?.() ?? [];
    const last = entries.filter((e) => e.type === 'custom' && e.customType === ENTRY).at(-1);
    state = last?.data ?? null;
    workloads = null; run = null; stallNotice = null;
    if (state?.status === 'active' && state.completionPolicy !== 'checks-only') {
      notify(ctx, 'mina: recovered a legacy active goal. Completion requires the matching legacy runtime; use that runtime '
        + 'or explicitly start a new goal. The existing contract has not been upgraded.', 'warning');
    }
    const recovered = decisions.recover(entries.filter((e) => e.type === 'custom' && e.customType === 'mina-decisions').at(-1)?.data);
    if (recovered) notify(ctx, 'mina: recovered operator procedures need review; /goal actions shows them. Historical receipts do not renew access.', 'warning');
    operatorStatus(ctx);
    amendmentWidget();
    if (state?.pendingAmendment) notify(ctx, `mina: the agent asked to replace the accepted checks (${state.pendingAmendment.reason}). Decide with /goal amendment.`, 'warning');
  });

  pi.registerTool({
    name: 'mina_propose_checks',
    label: 'Propose checks',
    description: 'During a mina /goal: register or repair agent-owned working checks without a dialog. For an explicitly protected '
      + 'contract, propose acceptance checks or request a replacement with a reason; the user decides. Commands run from the project folder. '
      + 'Passing working tests does not prove complete requirement coverage or scientific qualification.',
    parameters: {
      type: 'object',
      properties: {
        restated_objective: { type: 'string', description: 'The objective in your own words, one or two sentences.' },
        uncovered: { type: 'array', items: { type: 'string' }, description: 'Requirements of the objective that no proposed check tests (empty only if every requirement is tested).' },
        requirements: { type: 'array', description: 'Every explicit requirement of the objective (what it says must be done, reported or tested), each with '
          + 'the check that enforces it (R1, R2...) or "uncovered: <why>". The user sees this map; leave nothing out.',
          items: { type: 'object', properties: { requirement: { type: 'string' }, enforced_by: { type: 'string' } }, required: ['requirement', 'enforced_by'], additionalProperties: false } },
        checks: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', properties: {
          command: { type: 'string', description: 'Shell command run with bash -c from the project folder. Put long logic in a script under .mina/checks/.' },
          proves: { type: 'string', description: 'One line: what passing this check shows.' },
        }, required: ['command', 'proves'], additionalProperties: false } },
        reason: { type: 'string', description: 'Only when replacing accepted checks: why the current check cannot pass whatever the work does.' },
        drafts: { type: 'array', maxItems: 5, items: { type: 'string' }, description: 'When replacing accepted checks: paths of revised scripts you wrote under '
          + `${DRAFTS}/ (writable at any time). Each replaces the script with the same name under .mina/checks/ once the user accepts. `
          + 'Prefer this to `files`: it keeps long scripts out of this call.' },
        files: { type: 'array', maxItems: 5, description: 'Check scripts to write under .mina/checks/ (full content). When replacing accepted checks, mina writes them after the user accepts; for long scripts use `drafts` instead.',
          items: { type: 'object', properties: { path: { type: 'string', description: 'A path under .mina/checks/.' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
      },
      required: ['restated_objective', 'checks', 'requirements'],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      uiContext = ctx;
      if (!state || state.status !== 'active') throw new Error('No mina goal is active.');
      const protectedContract = protectedChecks();
      const amending = protectedContract && state.settled;
      if (amending && !params.reason) throw new Error('The checks are already accepted. To replace a wrong check, call again with a reason.');
      const files = (params.files ?? []).map((f) => ({ path: String(f.path ?? ''), content: String(f.content ?? '') }));
      // Drafts: a revised script written to .mina/checks-proposed/<name> replaces .mina/checks/<name>.
      const draftPaths = [];
      for (const d of params.drafts ?? []) {
        const rel = relative(ctx?.cwd ?? '.', resolve(ctx?.cwd ?? '.', String(d)));
        if (!rel.startsWith(`${DRAFTS}/`)) throw new Error(`drafts must be under ${DRAFTS}/: ${d}`);
        let content;
        try { content = readFileSync(join(ctx?.cwd ?? '.', rel), 'utf8'); } catch { throw new Error(`draft not found: ${d}. Write it first, then propose again.`); }
        files.push({ path: `.mina/checks/${rel.slice(DRAFTS.length + 1)}`, content });
        draftPaths.push(rel);
      }
      const outside = files.filter((f) => !isCheckPath(relative(ctx?.cwd ?? '.', resolve(ctx?.cwd ?? '.', f.path)), ctx?.cwd));
      if (outside.length) throw new Error(`files must be under .mina/checks/: ${outside.map((f) => f.path).join(', ')}`);
      const writeFiles = () => { for (const f of files) { const p = resolve(ctx?.cwd ?? '.', f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); } };
      // Before acceptance .mina/checks/ is writable anyway: write now, so the existence check below sees the files.
      if (!amending) writeFiles();
      let checks = numberChecks((params.checks ?? []).filter((c) => String(c.command ?? '').trim()).map((c) => ({ command: c.command.trim(), proves: String(c.proves ?? '').trim() })));
      if (!checks.length) throw new Error('No usable check: each needs a command.');
      const proposed = new Set(files.map((f) => relative(ctx?.cwd ?? '.', resolve(ctx?.cwd ?? '.', f.path))));
      const missing = checks.flatMap((c) => checkScriptsIn(c.command).filter((f) => !proposed.has(f) && !existsSync(join(ctx?.cwd ?? '.', f))).map((f) => `${c.id}: ${f}`));
      if (missing.length) throw new Error(`These check scripts do not exist yet:\n${missing.join('\n')}\nWrite them first (.mina/checks/ is writable until the checks are accepted, and frozen after), then propose again.`);
      const bad = await syntaxProblems(checks, ctx?.cwd);
      if (bad.length) throw new Error(`These checks are not valid shell (bash -n):\n${bad.join('\n')}\nFix the quoting, or put the logic in a script under .mina/checks/, and propose again.`);
      const changed = amending ? changedFiles(state.frozen, hashCheckFiles(ctx?.cwd)) : [];
      const uncovered = (params.uncovered ?? []).map((u) => String(u).trim()).filter(Boolean);
      const requirements = Array.isArray(params.requirements)
        ? params.requirements.map((r) => ({ requirement: String(r?.requirement ?? '').trim(), enforced_by: String(r?.enforced_by ?? '').trim() })).filter((r) => r.requirement)
        : null;
      const unused = unusedCheckScripts([...Object.keys(hashCheckFiles(ctx?.cwd)), ...proposed], checks);
      // Command-only amendments can run now. Replacement scripts remain frozen until acceptance, so checks naming
      // that namespace are explicitly unrun; executing obsolete content can reject the repair it needs.
      const dryRuns = await dryRun(checks, ctx?.cwd, amending && files.length > 0);
      const broken = dryRuns.filter((d) => d.status === 'crashed' && d.env);
      if (broken.length) {
        throw new Error(`Not shown to the user: ${broken.length} check(s) cannot run in this environment:\n${broken.map((d) => `${d.id}: ${d.text}`).join('\n')}\n`
          + 'The command is probably wrong, not the work: check the interpreter and paths (for Python, the project\'s own environment, '
          + 'e.g. ./.venv/bin/python; packages cannot be installed outside the project). Fix it and propose again.');
      }
      // A replacement nobody is there to answer is queued: the agent keeps working against the current checks, and
      // goal_complete waits for the user's decision (/goal amendment).
      const queue = (why) => {
        state = { ...state, pendingAmendment: { at: new Date().toISOString(), reason: params.reason, checks, files, draftPaths, uncovered,
          requirements, dryRuns, unused, restated: params.restated_objective } };
        save();
        notify(ctx, `mina: the agent asks to replace the accepted checks (${params.reason}). Decide with /goal amendment.`, 'warning');
        return { content: [{ type: 'text', text: `${why} mina queued your proposed check change; the user decides with /goal amendment. Keep working `
          + 'against the current checks meanwhile, but do not adapt the work or the data to the check you say is faulty: say in your notes what '
          + 'it gets wrong. goal_complete waits until the user has decided.' }], details: { decision: 'queued' } };
      };
      if (amending && !ctx?.hasUI) return queue('There is no interactive user.');
      let decision = 'accepted by harness (agent-selected; no interactive approval)';
      if (protectedContract && ctx?.hasUI) {
        const full = amending
          ? `The agent asks to replace the accepted checks.\nReason: ${params.reason}\n\nCurrent:\n${formatChecks(state.checks)}`
            + `\n\n${proposalSummary({ restated: params.restated_objective, checks, dryRuns, uncovered, unused, requirements })}`
            + (changed.length ? `\n\nCheck files changed since acceptance: ${changed.join(', ')}` : '')
            + files.map((f) => `\n\nNew content for ${f.path}:\n${f.content.length > 3000 ? `${f.content.slice(0, 3000)}\n[… ${f.content.length - 3000} more characters]` : f.content}`).join('')
          : proposalSummary({ restated: params.restated_objective, checks, dryRuns, uncovered, unused, requirements });
        // The selection title does not scroll: a long proposal (IV-1b) hid everything, choices included. The title keeps the
        // objective and one line per check with its proposal-time run; the rest opens in the scrollable editor view.
        const viewer = typeof ctx.ui.editor === 'function';
        const clip = (text, n) => { const s = String(text ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
        const runs = new Map(dryRuns.map((d) => [d.id, d]));
        const warning = full.split('\n').find((l) => l.startsWith('WARNING:'));
        const short = [amending ? `The agent asks to replace the accepted checks. Reason: ${clip(params.reason, 300)}` : `Proposed checks for: ${clip(params.restated_objective, 300)}`,
          ...(warning ? [clip(warning, 240)] : []),
          ...(requirements?.length ? [] : ['The agent mapped no requirements to checks: compare the objective with the checks yourself.']),
          ...checks.map((c) => `${c.id}: ${clip(c.command, 100)}${runs.get(c.id) ? ` — now: ${clip(runs.get(c.id).text, 160)}` : ''}`),
          'Show the full proposal for the requirement map, uncovered items, old scripts and file contents.'].join('\n');
        const title = viewer ? short : full;
        const FULL = 'Show the full proposal (requirements, uncovered, old scripts, file contents)';
        const SHOW = 'Show the check scripts';
        const REQUEST = 'Request changes (your feedback goes back to the agent)';
        const options = [amending ? 'Accept the new checks' : 'Accept', ...(viewer ? [FULL] : []), SHOW, REQUEST, 'Edit',
          amending ? 'Keep the current checks' : 'Decline (the goal becomes UNVERIFIED)'];
        let choice, feedback = null, first = true, unanswered = false, edited;
        await oneDialog(async () => { for (;;) {                                      // the timeout starts when the dialog shows
          const t0 = Date.now();
          choice = await ctx.ui.select(title, options, amending && first ? { timeout: amendWaitMs } : undefined);
          if (amending && first && choice === undefined && Date.now() - t0 >= amendWaitMs - 50) { unanswered = true; return; }
          first = false;
          if (choice === FULL) {
            await ctx.ui.editor('The full proposal (to read; changes here are not saved; close to choose)', full);
          } else if (choice === SHOW) {
            await ctx.ui.editor('The check scripts (to read; changes here are not saved: use Request changes or Edit)', scriptText(checks, files, ctx?.cwd));
          } else if (choice === REQUEST) {
            feedback = String(await ctx.ui.editor('What should the agent change? (sent to the agent; nothing is settled)', '') ?? '').trim();
            if (feedback) break;
          } else break;
        }
        if (choice === 'Edit') edited = await ctx.ui.editor('Edit the checks: one command per line, "R1: command" form; # lines are ignored', formatChecks(checks));
        });
        if (unanswered) return queue(`Nobody answered within ${Math.round(amendWaitMs / 60000) || 1} minute(s).`);
        // Sent back, or the dialog was closed without a choice: nothing is settled (an accepted check stays in force).
        if (choice === REQUEST || choice === undefined) {
          const asked = feedback ? `The user asked for changes:\n${feedback}\n` : 'The user closed the dialog without deciding.\n';
          const text = amending
            ? `${asked}The accepted checks stay in force. To revise your request, call mina_propose_checks again with a reason and the corrected files.`
            : `${asked}Nothing is settled yet. Revise the check scripts (.mina/checks/ is writable until the checks are accepted) and call mina_propose_checks again.`;
          return { content: [{ type: 'text', text }], details: { decision: feedback ? 'changes requested' : 'no decision', feedback } };
        }
        if (choice === 'Edit') {
          const parsed = parseCheckLines(edited ?? '');
          if (parsed.length) { checks = parsed; decision = 'edited by the user'; } else if (amending) { decision = 'kept (the edit left no check)'; checks = null; } else { checks = []; decision = 'declined (the edit left no check)'; }
        } else if (choice === options[0]) decision = 'accepted by the user';
        else if (amending) { decision = 'kept by the user'; checks = null; } else { checks = []; decision = 'declined by the user'; }
      }
      // The user answered this proposal: any earlier queued one is settled by the same answer.
      if (amending && state.pendingAmendment) { state = { ...state, pendingAmendment: undefined }; save(); }
      if (checks === null) {
        return { content: [{ type: 'text', text: `The user kept the current checks:\n${formatChecks(state.checks)}\nMake the work pass them, or call goal_blocked if you cannot.` }], details: { decision } };
      }
      if (amending) { writeFiles(); for (const d of draftPaths) { try { rmSync(join(ctx?.cwd ?? '.', d)); } catch { /* already gone */ } } }
      settle(checks, ctx?.cwd, { mode: checks.length ? (state.mode === 'none' ? 'given' : state.mode) : 'none', checkApproval: protectedContract && ctx?.hasUI ? 'user' : 'none', rejections: 0, uncovered,
        ...(requirements ? { requirements } : {}) });
      const runs = dryRuns.length ? `\nProposal-time runs:\n${dryRuns.map((d) => `- ${d.id}: ${d.text}`).join('\n')}` : '';
      const notRun = unusedCheckScripts([...Object.keys(hashCheckFiles(ctx?.cwd))], checks);
      const text = checks.length && !protectedContract
        ? `Agent-selected working checks registered:\n${formatChecks(checks)}${runs}\nYou can repair these tests without approval. Requirements remain binding. Passing them is not independent acceptance or scientific qualification.`
        : checks.length
        ? `Checks ${decision}:\n${formatChecks(checks)}${runs}\nYou may change files (not .mina/checks/, which is now frozen). mina reruns only these checks when you call goal_complete.`
          + (notRun.length ? ` These scripts in .mina/checks/ are not checks for this goal and do not run: ${notRun.join(', ')}.` : '')
        : `Checks ${decision}. There are no checks: your completion will be marked UNVERIFIED. You may now change files.`;
      return { content: [{ type: 'text', text }], details: { checks, decision } };
    },
  });

  pi.registerTool({
    name: ASK_TOOL,
    exposure: 'model-only',
    label: 'Ask the user',
    description: 'Ask for a decision outside existing authority, not permission for each ordinary authorized edit, test, read-only inventory or output-recovery step. '
      + 'Respect explicit attempt limits; check status before retrying uncertain effects. Do not turn existing standing task authorization into an invented one-operation limit. '
      + 'Use a stable request_id when referring to the same decision again; '
      + 'an identical answered request returns its existing receipt, not new authority or another attempt. For an operator-only step, '
      + 'include operator_action with exact commands, target, preconditions, output and restoration; do not give only a file reference. '
      + 'Agreement to act is not execution. Give 2 to 4 options, consequences and a recommendation.',
    parameters: {
      type: 'object',
      properties: {
        request_id: { type: 'string', minLength: 1, maxLength: 120, description: 'Stable identity of this exact decision within the mina instance. A different scope needs a new id.' },
        operator_action: { type: 'object', additionalProperties: false, properties: {
          option_index: { type: 'integer', minimum: 0, maximum: 3 }, target: { type: 'string', minLength: 1 }, effect: { type: 'string', minLength: 1, description: 'Plain-language effect and material risks of the commands.' }, reason: { type: 'string', minLength: 1 },
          preconditions: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }, commands: { type: 'string', minLength: 1 },
          expected_output: { type: 'string', minLength: 1 }, stop_on_error: { type: 'string', minLength: 1 },
          restoration: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
            when: { type: 'string', minLength: 1 }, commands: { type: 'string', minLength: 1 } }, required: ['when', 'commands'] }] },
        }, required: ['option_index', 'target', 'effect', 'reason', 'preconditions', 'commands', 'expected_output', 'stop_on_error', 'restoration'] },
        question: { type: 'string', description: 'The decision, in one sentence.' },
        context: { type: 'string', description: 'What the user needs to know to decide, briefly (where details are, e.g. a file).' },
        options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: {
          label: { type: 'string' }, consequence: { type: 'string', description: 'What happens if the user picks it.' } }, required: ['label'] } },
        recommended: { type: 'number', description: 'Index (0-based) of the option you recommend.' },
        why: { type: 'string', description: 'Why you recommend it.' },
      },
      required: ['question', 'options', 'recommended', 'why'],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      validateOperatorAction(params.operator_action, params.options?.length ?? 0);
      const id = params.request_id ?? randomUUID();
      const lines = questionLines(params);
      if (!ctx?.hasUI && decisions.get(id)?.status !== 'answered') {
        return { content: [{ type: 'text', text: `No one can answer here (no interactive terminal). The question was:\n${lines.join('\n')}\n`
          + 'Record it where the user will look (for example .mina/plan.md), and call goal_blocked if you cannot continue without it.' }], isError: true };
      }
      const { request_id: _requestId, ...scope } = params;
      const result = await decisions.ask(id, { ...scope, project: ctx?.cwd }, async () => {
        // Neither the widget nor the dialog title scrolls: a long request (an operator procedure, ~1,700 characters)
        // overflowed the screen. The dialog stays short; the whole request opens in Pi's
        // scrollable editor view and the choice is shown again afterwards.
        notify(ctx, `mina: the agent asks you: ${params.question}`, 'warning');
        const labels = params.options.map((o, i) => `${i + 1}. ${o.label}${i === params.recommended ? ' (recommended)' : ''}`);
        const viewer = typeof ctx.ui.editor === 'function';
        const recommended = Number.isInteger(params.recommended) && params.options[params.recommended]
          ? `\nRecommended: ${params.recommended + 1}. ${params.options[params.recommended].label}${params.why ? ` - ${String(params.why).slice(0, 240)}` : ''}` : '';
        const title = viewer ? `${params.question}${recommended}`
          : `${params.question}${recommended}${params.operator_action ? `\n\n${operatorProcedure(params.operator_action)}` : ''}`;
        const details = [...lines, ...(params.context && String(params.context).length > 600 ? ['', 'Full context:', String(params.context)] : []),
          ...(params.operator_action ? ['', operatorProcedure(params.operator_action)] : [])].join('\n');
        return oneDialog(async () => {
          try { ctx.ui.setWidget?.(WIDGET, [lines[0]]); } catch { /* no widget support */ }
          try {
            let choice;
            for (;;) {
              choice = await ctx.ui.select(title, [...labels, ...(viewer ? [DETAILS] : []), OTHER]);
              if (choice !== DETAILS) break;
              await ctx.ui.editor('Question details (to read and copy; edits are not saved; close to choose)', details);
            }
            if (choice === OTHER) choice = await ctx.ui.input('Your answer:', '');
            return choice;
          } finally { try { ctx.ui.setWidget?.(WIDGET, undefined); } catch { /* gone */ } }
        });
      }, (record) => {
        pi.appendEntry?.('mina-question', { question: params.question, options: params.options, recommended: params.recommended,
          answer: record.answer, request_id: id, instance_id: decisions.instanceId, at: record.answeredAt ?? record.at });
        saveDecisions();
      });
      const { record: receipt, reused } = result;
      measure({ kind: 'ask_user', options: params.options.length, answered: Boolean(receipt.answer), reused });
      if (!reused && receipt.operatorStatus) pi.sendMessage({ customType: 'mina-operator-action', display: true,
        content: operatorProcedure(params.operator_action), details: { request_id: id, instance_id: decisions.instanceId } }, { triggerTurn: false });
      operatorStatus(ctx);
      const text = (reused ? 'Previously answered request. No new authorization or execution allowance was created.\n' : '')
        + (receipt.answer ? `The user answered: ${receipt.answer}` : 'The user closed the question without answering.')
        + (receipt.operatorStatus === 'awaiting_execution' ? '\nThe user agreed to perform the action; mina has not executed the commands. Await output and verify it before dependent work.'
          : receipt.operatorStatus ? `\nOperator status: ${receipt.operatorStatus} (not independently verified).` : '');
      return { content: [{ type: 'text', text }], details: { answer: receipt.answer, request_id: id, reused, operator_status: receipt.operatorStatus } };
    },
  });

  pi.registerTool({
    name: 'mina_operator_status',
    label: 'Operator status',
    description: 'Call with {} to list operator steps and IDs, or with request_id alone to view its commands. '
      + 'With request_id, status and evidence, record that an agreed operator step produced output, or was not performed. Give supporting evidence from the conversation. '
      + 'This is an agent assessment, NOT independent verification or authorization. It clears the waiting-for-output indicator, not any acceptance check or execution restriction.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      request_id: { type: 'string' }, status: { type: 'string', enum: ['output_received', 'not_performed'] }, evidence: { type: 'string', minLength: 1 },
    } },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!params.status && !params.evidence) {
        const records = decisions.operators().filter((r) => !params.request_id || r.id === params.request_id);
        const text = params.request_id ? records.map((r) => `${r.historical ? 'Recovered history, not current authorization.\n' : ''}Status: ${r.operatorStatus}\n${operatorProcedure(r.scope.operator_action)}`).join('\n\n')
          : records.map((r) => `${r.id}: ${r.operatorStatus}${r.historical ? ' (recovered history)' : ''} — ${r.scope.operator_action.target}`).join('\n');
        return { content: [{ type: 'text', text: text || 'No matching operator actions.' }], details: { records } };
      }
      const record = decisions.reportOperator(params.request_id, params.status, params.evidence);
      saveDecisions(); operatorStatus(ctx);
      return { content: [{ type: 'text', text: `Operator status: ${record.operatorStatus} (agent-reported, not independently verified). No authority or acceptance criteria changed.` }], details: record };
    },
  });

  pi.registerTool({
    name: 'mina_checks',
    label: 'Check status',
    description: 'During a mina /goal: run the working or protected checks now and get one line per check (PASS, or FAIL with the reason). '
      + 'Use it to see what is still missing instead of reading the check scripts.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_id, _params, signal, _onUpdate, ctx) {
      if (!state || state.status !== 'active') throw new Error('No mina goal is active.');
      if (!state.checks?.length) return { content: [{ type: 'text', text: 'This goal has no checks.' }] };
      if (protectedChecks() && changedFiles(state.frozen, hashCheckFiles(ctx?.cwd)).length) throw new Error('Protected check files changed since acceptance. Restore them or request an amendment before running them.');
      const results = [];
      for (const c of state.checks) {
        const r = await pi.exec('bash', ['-c', sandboxed(c.command, ctx?.cwd)], { cwd: ctx?.cwd, timeout: CHECK_TIMEOUT_MS, signal });
        results.push({ id: c.id, code: r.code, killed: r.killed, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') });
      }
      const lines = results.map(statusLine);
      if (JSON.stringify(lines) !== JSON.stringify(state.lastStatus?.lines ?? null)) noteEffect('check results changed');
      state = { ...state, lastStatus: { at: new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z', lines } };
      save();
      return { content: [{ type: 'text', text: formatStatus(state.lastStatus) }], details: { status: state.lastStatus } };
    },
  });

  pi.on('tool_call', async (event, ctx) => {
    if (!state || state.status !== 'active') return undefined;
    if (event.toolName === 'write' || event.toolName === 'edit') {
      const path = event.input?.path;
      if (state.mode === 'plan' && !state.settled && !isMinaPath(path, ctx.cwd)) {
        return { block: true, reason: 'mina: the checks for this goal are not settled. Call mina_propose_checks first. Writes and edits outside .mina/ are refused until the user decides.' };
      }
      if (protectedChecks() && state.settled && isCheckPath(path, ctx.cwd)) {
        return { block: true, reason: 'mina: .mina/checks/ is frozen since the user accepted the checks. Fix the work, not the checks. If a check script is wrong, '
          + `write the corrected script to ${DRAFTS}/<same name> and call mina_propose_checks with a reason and its path in \`drafts\`: mina replaces the script if the user accepts.` };
      }
      return undefined;
    }
    if (event.toolName !== 'goal_complete') return undefined;
    const tampered = protectedChecks() && state.settled !== false ? changedFiles(state.frozen, hashCheckFiles(ctx.cwd)) : [];
    if (tampered.length) {
      notify(ctx, `mina: completion refused, check files changed since acceptance: ${tampered.join(', ')}`, 'warning');
      return { block: true, reason: `goal_complete was REFUSED: these check files changed after the user accepted them: ${tampered.join(', ')}. `
        + 'Restore them (for example with git checkout), or ask the user to accept new checks through mina_propose_checks with a reason.' };
    }
    if (state.completionPolicy !== 'checks-only') {
      return { block: true, reason: 'goal_complete was REFUSED: this legacy goal has no checks-only completion policy. '
        + 'Continue it with the matching legacy runtime, or explicitly start a new goal. Existing contracts are not upgraded automatically.' };
    }
    if (['plan', 'working'].includes(state.mode) && !state.settled) return { block: true, reason: 'mina: register the checks with mina_propose_checks before you complete the goal.' };
    if (state.pendingAmendment) {
      return { block: true, reason: `goal_complete was REFUSED: your check change (${state.pendingAmendment.reason}) is waiting for the user's decision `
        + '(they decide with /goal amendment). Continue other work, or call goal_blocked to wait for the user.' };
    }
    if (!state.checks.length) return undefined;
    notify(ctx, `mina: rerunning ${state.checks.length} check(s) before accepting completion…`);
    const results = [];
    for (const c of state.checks) {
      const r = await pi.exec('bash', ['-c', sandboxed(c.command, ctx.cwd)], { cwd: ctx.cwd, timeout: CHECK_TIMEOUT_MS, signal: ctx.signal });
      results.push({ ...c, code: r.code, killed: r.killed, stdout: String(r.stdout ?? '').slice(-OUTPUT_KEEP), stderr: String(r.stderr ?? '').slice(-OUTPUT_KEEP) });
    }
    const feedback = rejectionFeedback(results, { working: !protectedChecks() });
    if (JSON.stringify(results.map(statusLine)) !== JSON.stringify(state.lastStatus?.lines ?? null)) noteEffect('check results changed');
    state = { ...state, results, rejections: feedback ? state.rejections + 1 : 0,
      lastStatus: { at: new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z', lines: results.map(statusLine) } };
    save();
    if (feedback) {
      notify(ctx, `mina: completion refused, ${results.filter((r) => r.code !== 0).length} of ${results.length} check(s) failed (rejection ${state.rejections}).`, 'warning');
      return { block: true, reason: feedback };
    }
    notify(ctx, `mina: all ${results.length} check(s) passed.`);
    return undefined;
  });

  pi.on('tool_result', (event, ctx) => {
    // pi-goal returns its own refusals (stale goal id, goal not active) as ordinary results; only "Goal complete:" is a completion.
    const text = (event.content ?? []).map((c) => c.text ?? '').join('');
    if (event.toolName !== 'goal_complete' || event.isError || !text.startsWith('Goal complete:') || state?.status !== 'active') return undefined;
    state = { ...state, status: 'complete', completed_at: new Date().toISOString() };
    save();
    notify(ctx, state.unverified ? 'mina: goal complete, UNVERIFIED (no checks): this rests on the model\'s claim.'
      : !protectedChecks() ? 'mina: goal complete; agent-selected working checks passed, not independent verification.'
        : `mina: goal complete; protected checks passed (approval: ${state.checkApproval ?? 'legacy, not recorded'}). Qualification is limited to their coverage.`,
      state.unverified ? 'warning' : 'info');
    return undefined;
  });
}
