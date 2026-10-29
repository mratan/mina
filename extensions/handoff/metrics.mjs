// Measurements for tuning files: one JSON line per compaction, failed compaction job, handoff, and session start and
// end, in ~/.cache/mina/metrics.jsonl (MINA_METRICS_FILE replaces it). compact_at, handoff_at and max_compactions are
// set from these (scripts/metrics-summary.mjs), not guessed. Writing never fails the session.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function metricsPath(env = process.env) {
  return env.MINA_METRICS_FILE || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'mina', 'metrics.jsonl');
}

export function record(event, path = metricsPath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  } catch { /* measurements are best effort */ }
}

export function readMetrics(path = metricsPath()) {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };

// Per model: what compaction saves and costs, how often it fails, when handoffs happen and how long sessions last.
export function summarize(events) {
  const by = new Map();
  const get = (m) => { if (!by.has(m)) by.set(m, { compactions: [], failures: [], handoffs: [], sessions: [] }); return by.get(m); };
  for (const e of events) {
    const s = get(e.model ?? 'unknown');
    if (e.kind === 'compaction') s.compactions.push(e);
    else if (e.kind === 'compaction_failed') s.failures.push(e);
    else if (e.kind === 'handoff') s.handoffs.push(e);
    else if (e.kind === 'session_end') s.sessions.push(e);
  }
  return [...by].map(([model, s]) => ({
    model,
    compactions: s.compactions.length,
    model_written: s.compactions.filter((c) => c.semantic).length,
    median_tokens_before: median(s.compactions.map((c) => c.tokens_before)),
    median_tokens_after: median(s.compactions.map((c) => c.tokens_after)),
    median_job_seconds: median(s.compactions.map((c) => c.job_s)),
    failed_jobs: s.failures.length,
    median_failed_job_seconds: median(s.failures.map((c) => c.job_s)),
    handoffs: s.handoffs.length,
    median_handoff_tokens: median(s.handoffs.map((h) => h.tokens)),
    median_compactions_at_handoff: median(s.handoffs.map((h) => h.compactions)),
    sessions: s.sessions.length,
    median_session_minutes: median(s.sessions.map((x) => x.duration_s / 60)),
    median_session_turns: median(s.sessions.map((x) => x.turns)),
  }));
}
