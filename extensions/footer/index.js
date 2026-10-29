// A two-line footer in place of Pi's three lines. Line 1: folder (branch) • session name, with context use and the model
// on the right. Line 2: extension statuses, the goal first and labelled. Pi's token and cost totals are not shown.
// When pi-goal's status is missing, the goal comes from the session's latest goal-state entry.
// When Claude Code answers on its fallback model after a refusal, the model reads "selected → answering", and a notice
// and a claude-refusal entry record the refusal (vendor/patches/pi-claude-subscription-0.2.4-refusal-fallback.patch).
import { SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const GOAL_KEY = 'goal';
const REFUSAL_ENTRY = 'claude-refusal';
const REFUSAL_SUBTYPES = new Set(['model_refusal_fallback', 'model_refusal_no_fallback']);

// Pi's formatTokens.
export function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

export function formatCwd(cwd, home) {
  if (!home) return cwd;
  const rel = relative(resolve(home), resolve(cwd));
  if (rel === '') return '~';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return cwd;
  return `~${sep}${rel}`;
}

const clean = (text) => String(text).replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ').trim();

// The goal as the session last recorded it, for when pi-goal's status is not set. A finished or cleared goal shows nothing.
export function goalFromEntries(entries) {
  let goal = null;
  for (const e of entries) if (e?.type === 'custom' && e.customType === 'goal-state') goal = e.data?.goal ?? null;
  if (!goal || !goal.status || goal.status === 'complete') return undefined;
  return goal.waiting ? `${goal.status} · waiting` : goal.status;
}

// The model that answered the latest reply, when it is not the selected model. The provider records it as responseModel.
export function answeredBy(entries, model) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i]?.type === 'message' ? entries[i].message : null;
    if (m?.role !== 'assistant') continue;
    if (m.provider !== model?.provider || m.model !== model?.id || !m.responseModel || m.responseModel === m.model) return undefined;
    return m.responseModel;
  }
  return undefined;
}

// Claude Code's refusal notice (a model_refusal_fallback or model_refusal_no_fallback frame), as a session entry.
export function refusalRecord(provider, frame) {
  return { provider, subtype: frame.subtype, from: frame.original_model ?? null, to: frame.fallback_model ?? null,
    category: frame.api_refusal_category ?? null, scope: frame.scope ?? null };
}

export function refusalNotice(r) {
  const what = `Claude refusal${r.category ? ` [${r.category}]` : ''}: ${r.from ?? 'the model'} declined`;
  if (r.subtype === 'model_refusal_no_fallback' || !r.to) return `${what}, and no fallback model answered.`;
  return `${what}; ${r.to} answered instead${r.scope === 'local' ? ' (this reply only)' : ' and keeps answering in this Claude Code session'}.`;
}

// Line 2: the goal first (so a narrow terminal never cuts it off), then the other statuses by key, as Pi orders them.
// pi-goal's text starts with the goal's state ("active 37m · automatic 0/100", "paused · …", "waiting <reason> · …").
// An active goal reads "/goal mode active · 37m · automatic 0/100"; other states "/goal paused · …".
export function goalText(text) {
  const t = clean(text);
  if (t === 'active' || t.startsWith('active ')) {
    const rest = t.slice('active'.length).trim();
    return { label: '/goal mode active', rest: rest.startsWith('·') ? rest.slice(1).trim() : rest };
  }
  return { label: '/goal', rest: t };
}

export function statusLine(statuses, fallbackGoal, accent = (s) => s) {
  const goal = statuses.get(GOAL_KEY) ?? fallbackGoal;
  const rest = [...statuses.entries()].filter(([k, t]) => k !== GOAL_KEY && t).sort(([a], [b]) => a.localeCompare(b)).map(([, t]) => clean(t));
  const g = goal ? goalText(goal) : null;
  const shown = g ? [g.label === '/goal' ? `${accent(g.label)} ${g.rest}` : `${accent(g.label)}${g.rest ? ` · ${g.rest}` : ''}`] : [];
  return [...shown, ...rest].join('  ');
}

// Line 1. `left` is the folder; `context` is the context-use text, already coloured; `model` and `provider` are plain.
// The right side keeps the context use and the model; the provider goes first, then the folder is shortened.
export function topLine({ left, context, model, provider, width, dim }) {
  const line = (m, l) => { const right = `${context}${dim(`  ${m}`)}`; return dim(l) + ' '.repeat(Math.max(2, width - visibleWidth(l) - visibleWidth(right))) + right; };
  const room = (m) => width - visibleWidth(context) - visibleWidth(`  ${m}`) - 2;
  if (provider && room(`(${provider}) ${model}`) >= visibleWidth(left)) return line(`(${provider}) ${model}`, left);
  if (room(model) >= Math.min(visibleWidth(left), 12)) return line(model, truncateToWidth(left, room(model), '...'));
  return truncateToWidth(`${context}${dim(`  ${model}`)}`, width, '');
}

export default function minaFooter(pi, { home = process.env.HOME || process.env.USERPROFILE } = {}) {
  let ctx = null;
  let autoCompact = true;
  let cache = null; // context usage and the fallback goal, recomputed when the session changes, as Pi's footer does

  const stats = (c) => {
    const sm = c.sessionManager;
    const key = [sm.getSessionId?.(), sm.getLeafId?.(), sm.getEntryCount?.(), c.model];
    if (cache && key.every((v, i) => v === cache.key[i])) return cache;
    const entries = sm.getBranch?.() ?? sm.getEntries?.() ?? [];
    return (cache = { key, usage: c.getContextUsage(), goal: goalFromEntries(entries), answered: answeredBy(entries, c.model) });
  };

  const render = (theme, footerData, width) => {
    const c = ctx;
    if (!c) return null;
    const dim = (s) => theme.fg('dim', s);
    const { usage, goal, answered } = stats(c);
    const model = c.model;

    let left = formatCwd(c.sessionManager.getCwd?.() ?? c.cwd, home);
    const branch = footerData.getGitBranch();
    if (branch) left += ` (${branch})`;
    const name = c.sessionManager.getSessionName?.();
    if (name) left += ` • ${name}`;

    const window = usage?.contextWindow ?? model?.contextWindow ?? 0;
    const percent = usage?.percent ?? 0;
    const shown = `${usage?.percent != null ? percent.toFixed(1) : '?'}%/${formatTokens(window)}${autoCompact ? ' (auto)' : ''}`;
    const context = percent > 90 ? theme.fg('error', shown) : percent > 70 ? theme.fg('warning', shown) : dim(shown);

    let modelText = (model?.id || 'no-model') + (answered ? ` → ${answered}` : '');
    if (model?.reasoning) {
      const level = pi.getThinkingLevel?.() ?? c.thinkingLevel ?? 'off';
      modelText += level === 'off' ? ' • thinking off' : ` • ${level}`;
    }
    const provider = footerData.getAvailableProviderCount() > 1 ? model?.provider : undefined;

    const lines = [topLine({ left, context, model: modelText, provider, width, dim })];
    const line2 = statusLine(footerData.getExtensionStatuses(), goal, (s) => theme.fg('accent', s));
    if (line2) lines.push(truncateToWidth(line2, width, dim('...')));
    return lines;
  };

  pi.on('session_start', (_event, c) => {
    ctx = c;
    cache = null;
    if (!c.hasUI || c.mode !== 'tui') return;
    try { autoCompact = SettingsManager.create(c.cwd, getAgentDir()).getCompactionEnabled(); } catch { autoCompact = true; }
    c.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      let last = [];
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width) {
          // A replaced session's context throws until session_start brings the new one; keep the last lines meanwhile.
          try { last = render(theme, footerData, width) ?? last; } catch { /* stale context */ }
          return last;
        },
      };
    });
  });
  let noticed = new Set();
  pi.on('provider_stream_event', (event, c) => {
    const frame = event?.data;
    if (frame?.type !== 'system' || !REFUSAL_SUBTYPES.has(frame.subtype)) return;
    const record = refusalRecord(event.provider, frame);
    pi.appendEntry?.(REFUSAL_ENTRY, record);
    // One notice per distinct refusal and fallback; every refusal is recorded.
    const key = JSON.stringify(Object.values(record));
    const ui = c ?? ctx;
    if (ui?.hasUI && !noticed.has(key)) { noticed.add(key); ui.ui.notify(refusalNotice(record), 'warning'); }
  });
  pi.on('session_shutdown', () => { ctx = null; cache = null; noticed = new Set(); });
}
