// Subscription usage in the footer: the 5-hour and weekly limits of the ChatGPT sign-in (Codex) and of pi's own Anthropic
// sign-in (Claude), each only while the session's model is that provider through OAuth (not an API key, not any other
// provider). The numbers come from the providers' usage endpoints: GETs that cost no model quota, so they show before the
// first prompt. Claude Code's login (the claude-sdk provider) is never read: its account can differ from pi's.
// Shared with plain pi: ~/.pi/agent/extensions/codex-usage links here, and mina --full then skips its own copy.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY = 'codex-usage';
const PROVIDER = 'openai-codex';
const CLAUDE_KEY = 'claude-usage';
const CLAUDE_PROVIDER = 'anthropic';
const CLAUDE_BASE_URL = 'https://api.anthropic.com';
const CLAUDE_CODE_KEY = 'claude-code-usage';
// Footer labels of the claude-sdk provider and its account profiles: claude-sdk-<id> is labelled "Claude <name>", as
// pi-claude-subscription names the profile's models. Profiles come only from the owner's claude-sdk.json in Pi's agent
// folder (never from the project); an unreadable file leaves claude-sdk alone.
export function claudeCodeLabels(profiles = readClaudeProfiles()) {
  const labels = new Map([['claude-sdk', 'Claude Code']]);
  for (const p of Array.isArray(profiles) ? profiles : []) {
    if (p && typeof p.id === 'string' && /^[\w.-]+$/.test(p.id)) labels.set(`claude-sdk-${p.id}`, `Claude ${typeof p.name === 'string' && p.name ? p.name : p.id}`);
  }
  return labels;
}
export function readClaudeProfiles(env = process.env) {
  const agent = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');
  try { return JSON.parse(readFileSync(join(agent, 'claude-sdk.json'), 'utf8')).profiles ?? []; } catch { return []; }
}
const BASE_URL = 'https://chatgpt.com/backend-api';
const FETCH_EVERY_MS = 5 * 60_000; // the footer's countdowns are redrawn every minute from the last reply
const AFTER_TURN_MS = 30_000; // a turn refetches, at most this often
const TIMEOUT_MS = 10_000;

export const applies = (model, registry) => model?.provider === PROVIDER && !!registry?.isUsingOAuth?.(model);

// The ChatGPT account (workspace) id inside the access token, for the chatgpt-account-id header.
export function accountId(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload['https://api.openai.com/auth']?.chatgpt_account_id ?? null;
  } catch { return null; }
}

export function duration(seconds) {
  const m = Math.max(0, Math.round(seconds / 60));
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
}

// "Codex 5h 42% ↺2h16m · wk 43% ↺6d0h" from the endpoint's reply; reset times count down from reset_at.
export function format(usage, now = Date.now()) {
  const limits = usage?.rate_limit;
  if (!limits) return undefined;
  const window = (label, w) => {
    if (!w || typeof w.used_percent !== 'number') return null;
    const left = typeof w.reset_at === 'number' ? w.reset_at - now / 1000 : w.reset_after_seconds;
    return `${label} ${Math.round(w.used_percent)}%${typeof left === 'number' ? ` ↺${duration(left)}` : ''}`;
  };
  const parts = [window('5h', limits.primary_window), window('wk', limits.secondary_window)].filter(Boolean);
  if (!parts.length) return undefined;
  return `Codex ${limits.limit_reached ? 'limit reached · ' : ''}${parts.join(' · ')}`;
}

export async function fetchUsage(registry, { model, fetch = globalThis.fetch } = {}) {
  const token = await registry.getApiKeyForProvider(PROVIDER);
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}`, originator: 'pi', accept: 'application/json' };
  const account = accountId(token);
  if (account) headers['chatgpt-account-id'] = account;
  const base = (model?.baseUrl || BASE_URL).replace(/\/+$/, '').replace(/\/codex(\/.*)?$/, '');
  const res = await fetch(`${base}/wham/usage`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`codex usage: HTTP ${res.status}`);
  return res.json();
}

export const claudeApplies = (model, registry) => model?.provider === CLAUDE_PROVIDER && !!registry?.isUsingOAuth?.(model);

// "Claude 5h 4% ↺4h20m" from /api/oauth/usage. The reply's `limits` list names the limits that apply to this account (a
// session window, weekly windows, some scoped to a model or surface); inactive ones are hidden. Older replies have only
// five_hour / seven_day / seven_day_opus / seven_day_sonnet.
export function formatClaude(usage, now = Date.now()) {
  if (!usage || typeof usage !== 'object') return undefined;
  const scope = (s) => s?.model?.display_name ?? s?.surface?.display_name;
  const windows = Array.isArray(usage.limits)
    ? usage.limits.filter((l) => l && l.is_active !== false && typeof l.percent === 'number').map((l) => ({
      label: [l.group === 'session' ? '5h' : l.group === 'weekly' ? 'wk' : l.kind ?? l.group, scope(l.scope)].filter(Boolean).join(' '),
      percent: l.percent, resets: l.resets_at }))
    : [['5h', usage.five_hour], ['wk', usage.seven_day], ['wk Opus', usage.seven_day_opus], ['wk Sonnet', usage.seven_day_sonnet]]
      .filter(([, w]) => typeof w?.utilization === 'number').map(([label, w]) => ({ label, percent: w.utilization, resets: w.resets_at }));
  if (!windows.length) return undefined;
  const parts = windows.map((w) => {
    const at = Date.parse(w.resets ?? '');
    return `${w.label} ${Math.round(w.percent)}%${Number.isFinite(at) ? ` ↺${duration((at - now) / 1000)}` : ''}`;
  });
  return `Claude ${windows.some((w) => w.percent >= 100) ? 'limit reached · ' : ''}${parts.join(' · ')}`;
}

export async function fetchClaudeUsage(registry, { model, fetch = globalThis.fetch } = {}) {
  const token = await registry.getApiKeyForProvider(CLAUDE_PROVIDER);
  if (!token) return null;
  const base = (model?.baseUrl || CLAUDE_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, '');
  const res = await fetch(`${base}/api/oauth/usage`, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20',
    accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`claude usage: HTTP ${res.status}`);
  return res.json();
}

// "Claude Code 5h 22% ↺1h10m · wk 96% ↺1d15h" from Claude Code's rate_limit_event (SDKRateLimitInfo): utilization is a
// 0-1 fraction and resetsAt epoch seconds. unifiedWindows lists every window of the account; without it, the single
// window the event names.
const CODE_WINDOWS = { five_hour: '5h', seven_day: 'wk', seven_day_opus: 'wk Opus', seven_day_sonnet: 'wk Sonnet' };
export function formatClaudeCode(info, now = Date.now(), label = 'Claude Code') {
  if (!info || typeof info !== 'object') return undefined;
  const entries = info.unifiedWindows && typeof info.unifiedWindows === 'object'
    ? Object.entries(info.unifiedWindows)
    : info.rateLimitType ? [[info.rateLimitType, { utilization: info.utilization, resetsAt: info.resetsAt }]] : [];
  const order = Object.keys(CODE_WINDOWS);
  const parts = entries.filter(([, w]) => typeof w?.utilization === 'number')
    .sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    .map(([k, w]) => `${CODE_WINDOWS[k] ?? k} ${Math.round(w.utilization * 100)}%${typeof w.resetsAt === 'number' ? ` ↺${duration(w.resetsAt - now / 1000)}` : ''}`);
  if (!parts.length) return undefined;
  return `${label} ${info.status === 'rejected' ? 'limit reached · ' : ''}${parts.join(' · ')}`;
}

export default function usageFooters(pi, options = {}) {
  footer(pi, { key: KEY, applies, fetchUsage, format }, options);
  footer(pi, { key: CLAUDE_KEY, applies: claudeApplies, fetchUsage: fetchClaudeUsage, format: formatClaude }, options);
  claudeCodeFooter(pi, options);
}

// claude-sdk and its explicit account aliases run on Claude Code logins, separate from pi's own Anthropic OAuth. Claude Code
// reports that account's limits as rate_limit_event frames on the live transport; the carried pi-claude-subscription
// forwards them as provider_stream_event (docs/vendor-patches.md). No request is made and no credential is read.
function claudeCodeFooter(pi, { now = () => Date.now(), claudeProfiles } = {}) {
  const CLAUDE_CODE_LABELS = claudeCodeLabels(claudeProfiles ?? readClaudeProfiles());
  let ctx = null, selected = null, timer = null;
  const infoByProvider = new Map();
  const provider = () => (selected ?? ctx?.model)?.provider;
  const active = () => !!ctx?.hasUI && CLAUDE_CODE_LABELS.has(provider());
  const show = () => {
    if (!ctx?.hasUI) return;
    const info = infoByProvider.get(provider());
    ctx.ui.setStatus(CLAUDE_CODE_KEY, active() && info ? formatClaudeCode(info, now(), CLAUDE_CODE_LABELS.get(provider())) : undefined);
  };
  const sync = () => {
    show();
    if (active() && !timer) { timer = setInterval(show, 60_000); timer.unref?.(); }
    else if (!active() && timer) { clearInterval(timer); timer = null; }
  };
  pi.on('session_start', (_event, c) => { ctx = c; selected = null; sync(); });
  pi.on('model_select', (event, c) => { ctx = c ?? ctx; selected = event.model ?? null; sync(); });
  pi.on('provider_stream_event', (event, c) => {
    if (!CLAUDE_CODE_LABELS.has(event?.provider) || event.data?.type !== 'rate_limit_event' || !event.data.rate_limit_info) return;
    infoByProvider.set(event.provider, event.data.rate_limit_info);
    if (event.provider !== provider()) return;
    ctx = c ?? ctx; sync();
  });
  pi.on('session_shutdown', () => {
    if (timer) clearInterval(timer); timer = null;
    if (ctx?.hasUI) ctx.ui.setStatus(CLAUDE_CODE_KEY, undefined);
    ctx = null;
  });
}

// One footer status: shown while `spec.applies` to the session's model, refetched every five minutes and after turns.
function footer(pi, spec, { fetch = globalThis.fetch, now = () => Date.now() } = {}) {
  const { key: KEY, applies, fetchUsage, format } = spec;
  let ctx = null, selected = null, usage = null, fetchedAt = 0, inFlight = null, timer = null, generation = 0;

  const model = () => selected ?? ctx?.model;
  const active = () => !!ctx?.hasUI && applies(model(), ctx.modelRegistry);
  const show = () => { if (ctx?.hasUI) ctx.ui.setStatus(KEY, active() && usage ? format(usage, now()) : undefined); };

  const refresh = (minAge = 0) => {
    if (!active() || inFlight || now() - fetchedAt < minAge) return inFlight;
    const mine = generation;
    inFlight = fetchUsage(ctx.modelRegistry, { model: model(), fetch })
      .then((u) => { if (mine === generation && u) { usage = u; fetchedAt = now(); } })
      .catch(() => { /* keep the last reply; the next tick retries */ })
      .finally(() => { inFlight = null; show(); });
    return inFlight;
  };

  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const start = () => {
    if (timer || !active()) return;
    timer = setInterval(() => { show(); refresh(FETCH_EVERY_MS); }, 60_000);
    timer.unref?.();
  };

  // A new session or another model: start over, and show nothing unless the spec's provider is used through OAuth.
  const reset = (c, m = null) => {
    ctx = c; selected = m; generation++; usage = null; fetchedAt = 0;
    show();
    if (active()) { start(); refresh(); } else stop();
  };

  pi.on('session_start', (_event, c) => reset(c));
  pi.on('model_select', (event, c) => {
    if (event.model?.provider === event.previousModel?.provider && event.model?.id === event.previousModel?.id) return;
    reset(c, event.model);
  });
  pi.on('agent_end', (_event, c) => { ctx = c; refresh(AFTER_TURN_MS); });
  pi.on('session_shutdown', () => { stop(); generation++; if (ctx?.hasUI) ctx.ui.setStatus(KEY, undefined); ctx = null; });
}
