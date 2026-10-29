// mina_recall: exact search over this session and the sessions it was handed off from (Pi session files, linked by
// their header's parentSession). It reads Pi's own files; nothing is copied or archived.
import { existsSync, readFileSync } from 'node:fs';

export function readSession(file) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const l of lines) { try { entries.push(JSON.parse(l)); } catch { /* a torn last line */ } }
  return { header: entries.find((e) => e.type === 'session') ?? null, entries };
}

// Current session first, then each parent. Stops at a missing file or a cycle.
export function lineage(file, maxDepth = 20) {
  const out = [], seen = new Set();
  let f = file;
  while (f && existsSync(f) && !seen.has(f) && out.length < maxDepth) {
    seen.add(f);
    const s = readSession(f);
    out.push({ file: f, ...s });
    f = s.header?.parentSession;
  }
  return out;
}

export function entryText(e) {
  if (e.type === 'message') {
    const m = e.message, c = m.content;
    const body = typeof c === 'string' ? c : (c ?? []).map((b) => b.text ?? b.thinking ?? (b.type === 'toolCall' ? `[tool ${b.name}] ${JSON.stringify(b.arguments)}` : '')).join('\n');
    return `${m.role}${m.toolName ? ` (${m.toolName})` : ''}: ${body}`;
  }
  if (e.type === 'compaction') return `compaction: ${e.summary ?? ''}`;
  if (e.type === 'custom_message') return `${e.customType}: ${typeof e.content === 'string' ? e.content : JSON.stringify(e.content)}`;
  // A finished subagent's report (pi-subagents' record): the model never sees this entry, so recall must find it.
  if (e.type === 'custom' && e.customType === 'subagents:record' && e.data) {
    const d = e.data;
    return `subagent ${d.id} (${d.description ?? d.type ?? ''}, ${d.status ?? ''}): ${d.error ? `ERROR: ${d.error}\n${d.result || ''}` : d.result || ''}`;
  }
  return '';
}

export function search(sessions, { query, regex = false, limit = 10, context = 300 }) {
  const re = regex ? new RegExp(query, 'i') : null, q = String(query).toLowerCase();
  const hits = [];
  for (const [depth, s] of sessions.entries()) {
    for (const e of s.entries) {
      const text = entryText(e);
      if (!text) continue;
      const at = re ? text.search(re) : text.toLowerCase().indexOf(q);
      if (at < 0) continue;
      hits.push({ session: depth === 0 ? 'current' : `earlier-${depth}`, entry_id: e.id, timestamp: e.timestamp,
        snippet: text.slice(Math.max(0, at - context / 2), at + context / 2) });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

export function readEntry(sessions, id, maxChars = 20_000) {
  for (const [depth, s] of sessions.entries()) {
    const e = s.entries.find((x) => x.id === id);
    if (e) { const t = entryText(e); return { session: depth === 0 ? 'current' : `earlier-${depth}`, entry_id: id, text: t.length > maxChars ? `${t.slice(0, maxChars)}\n[truncated]` : t }; }
  }
  return null;
}
