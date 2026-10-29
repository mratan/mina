// What the main agent needs to know about its subagents (pi-subagents): their limits, and how close each one is to them.
// A subagent runs without mina's layers (no compaction, no handoff, no goal rules), so when it outgrows its token budget
// or its turn limit it can fail or stop; saved files and partial reports remain. The live numbers come from pi-subagents'
// in-process registry (globalThis[Symbol.for('pi-subagents:manager')].getRecord(id)): the record's status, tool uses
// and compactions, and the child's own Pi session for its context size and turns.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync as readProjectFileSync } from '../../sandbox/project-fs.mjs';
import { validateTrustedResources, sandboxSettingsFromEnv } from '../../sandbox/sandbox.mjs';

export const WARN_AT = 0.8; // warn the main agent at 80% of a budget

export const manager = () => globalThis[Symbol.for('pi-subagents:manager')];

// The agent definition's front matter: the project's .pi/agents/<type>.md first, then the user's.
function frontMatter(type, { cwd, agentDir }) {
  if (!/^[A-Za-z0-9_-]+$/.test(type ?? '')) return null;
  const paths = [cwd && join(cwd, '.pi', 'agents', `${type}.md`), agentDir && join(agentDir, 'agents', `${type}.md`)];
  for (const [index, path] of paths.entries()) {
    if (!path) continue;
    try {
      if (index === 1 && process.env.MINA_SANDBOX === '1') validateTrustedResources([path], sandboxSettingsFromEnv(process.env, { cwd }).writable);
      return (index === 0 ? readProjectFileSync : readFileSync)(path, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    } catch { /* unavailable metadata cannot widen live limits */ }
  }
  return null;
}
export function maxTurnsFor(type, where) {
  const m = frontMatter(type, where)?.match(/^max_turns:\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}
// The subagent's tools (null: not stated, Pi's defaults), and whether it can write files.
export function toolsFor(type, where) {
  const m = frontMatter(type, where)?.match(/^tools:\s*(.+)$/m);
  return m ? m[1].split(',').map((t) => t.trim()).filter(Boolean) : null;
}
export const canWrite = (tools) => !tools || tools.some((t) => ['write', 'edit', 'bash'].includes(t));

// One child's numbers from its pi-subagents record.
export function childStatus(record, { budget = null, maxTurns = null } = {}) {
  const s = record?.session;
  let tokens = null, turns = null;
  try { tokens = s?.getContextUsage?.()?.tokens ?? null; } catch { /* session gone */ }
  try { turns = (s?.messages ?? []).filter((m) => m?.role === 'assistant').length; } catch { /* session gone */ }
  return { id: record?.id, description: record?.description ?? '', type: record?.type ?? '', status: record?.status ?? 'unknown',
    tokens, budget, turns, maxTurns: record?.maxTurns ?? maxTurns, toolUses: record?.toolUses ?? 0, compactions: record?.compactionCount ?? 0 };
}

// The levels a child has reached: 'tokens' and/or 'turns' at WARN_AT of their budgets.
export function nearLimits(c) {
  const out = [];
  if (c.budget && Number.isFinite(c.tokens) && c.tokens >= WARN_AT * c.budget) out.push('tokens');
  if (c.maxTurns && Number.isFinite(c.turns) && c.turns >= WARN_AT * c.maxTurns) out.push('turns');
  return out;
}

const k = (n) => (Number.isFinite(n) ? `${Math.round(n / 1000)}K` : '?');
export const describeChild = (c) => `"${c.description}" (${c.type}, ${c.status}): context ${k(c.tokens)}`
  + `${c.budget ? ` of its ${k(c.budget)} budget` : ''}, turn ${c.turns ?? '?'}${c.maxTurns ? ` of ${c.maxTurns}` : ' (no turn limit)'}`
  + `, ${c.toolUses} tool calls${c.compactions ? `, compacted ${c.compactions}x` : ''}`;

// How many pool reserves a child takes: at least one, more once it outgrows its reserve.
export const reserveUnits = (c, reserve) => (reserve && Number.isFinite(c.tokens) ? Math.max(1, Math.ceil(c.tokens / reserve)) : 1);

// The limits text added to an Agent result, so the main agent knows them when it starts a child.
export function limitsText({ budget, maxTurns, tools = null, minimal = false }) {
  if (minimal) {   // tuning goal_prompt "minimal": the facts only
    return 'mina: this subagent has no compaction, handoff or goal rules'
      + (tools && !canWrite(tools) ? `; tools: ${tools.join(', ')} (it cannot write files)` : '')
      + (budget ? `; its share of the server memory: ${k(budget)} tokens` : '')
      + (maxTurns ? `; it is stopped after ${maxTurns} turns; saved files and partial reports remain` : '; no turn limit') + '. mina_subagents shows its limits.';
  }
  return 'mina: this subagent runs without compaction, handoff or goal rules. '
    + (tools && !canWrite(tools) ? `It can only read (tools: ${tools.join(', ')}): it cannot write files, so it returns its result to you, `
      + 'and you save it where it belongs. ' : '')
    + (budget ? `Its share of this server's shared memory is ${k(budget)} tokens: past it the subagent keeps working, but if the requests `
      + 'together overflow the memory, all of them fail, this session\'s included. ' : '')
    + (maxTurns ? `It is stopped after ${maxTurns} turns; saved files and partial reports remain. ` : 'It has no turn limit. ')
    + (tools && !canWrite(tools) ? 'Keep its question focused. ' : 'Keep each task to one deliverable written to files it owns. ')
    + 'mina_subagents shows how close each subagent is to its limits, and mina warns you at 80%.';
}

// The warning sent to the main agent when a child reaches a level.
export function warningText(c, levels) {
  const parts = [];
  if (levels.includes('tokens')) parts.push(`its context is ${k(c.tokens)}, near its ${k(c.budget)} share of the shared memory: if it keeps `
    + 'growing next to this session, the requests can overflow the memory and all fail. Avoid growing this session meanwhile, and start no other subagent');
  if (levels.includes('turns')) parts.push(`it is at turn ${c.turns} of ${c.maxTurns}: at the limit it stops; saved files and partial reports remain`);
  return `mina: subagent "${c.description}": ${parts.join('; ')}. If it is close to done, let it finish; otherwise tell it to finish and `
    + 'report now (steer_subagent), or stop it and split the rest into a smaller task.';
}
