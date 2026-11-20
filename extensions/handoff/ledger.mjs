// The operator ledger: the user's standing instructions for the goal, in the user's own words (docs/architecture.md).
// In a long run the user steers through the conversation, not through the goal file. 2026-11-19 02:26 the user wrote
// "do not spin up GPT or Claude subagents"; compaction summaries weakened it to "GLM-only implementation children", the
// 11:10 in-place handoff dropped it, and 13 Claude subagents were started after it. Summaries paraphrase; this keeps the words.
// - Every message the user types is saved word for word (OPLOG entries, append-only), and so is every answer to a
//   question (mina_ask_user, and the ledger's own conflict questions). Messages from extensions and goal continuations
//   are not the user's.
// - The agent sorts them into entries with mina_ledger. Each entry quotes its message exactly (mina checks the quote), and
//   keeps the agent's reading in a separate field. Entries and messages belong to the goal that was current when the
//   message was typed: a new goal starts an empty ledger.
// - Active entries and unsorted messages are restated word for word after each compaction and in each handoff packet,
//   outside the packet's size limit.
// - A standing entry ends only by a later user message (quoted like a source) or by the user (/mina-ledger). A task also
//   ends when the agent records the evidence that it is done. A conflict is a question to the user, whose answer is logged.
// The session file is the store; .mina/operator-ledger.md is a mirror for the user. An edit of the mirror is set aside
// and reported, never read back.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from '../../sandbox/project-fs.mjs';
import { oneDialog } from '../../lib/dialog-lock.mjs';
import { lineage } from './recall.mjs';
import { ANSWER_EVENT } from '../goal/ask.mjs';

export const OPLOG = 'mina-operator-message';
export const LEDGER = 'mina-ledger';
export const LEDGER_FILE = join('.mina', 'operator-ledger.md');
export const KINDS = ['directive', 'constraint', 'priority', 'task', 'fact'];
export const UNSORTED_MAX_BYTES = 12_288;   // the unsorted messages in one restatement or packet; the newest are kept
export const MESSAGE_MAX_CHARS = 4000;      // one unsorted message as restated (pasted logs are not instructions)
export const OTHER = 'Other: type your own answer';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// The quote must be the user's words: a substring of the message, whitespace aside.
export const quoteIn = (quote, text) => { const q = norm(quote); return q.length > 0 && norm(text).includes(q); };
export const emptyLedger = (goal = null) => ({ goal, seq: 0, entries: [], sorted: [], carried: [] });
// "Later" compares these times, so the messages logged here get strictly increasing ones (an answer can arrive in the same
// millisecond as the message before it).
let lastAt = 0;
const nextAt = () => { lastAt = Math.max(Date.now(), lastAt + 1); return new Date(lastAt); };
export const newMessage = (text, goal = null, at = nextAt(), extra = {}) => ({ id: `U${randomBytes(4).toString('hex')}`, at: at.toISOString(), text, goal, ...extra });
const live = (e) => e.status === 'active' || e.status === 'disputed';
const when = (iso) => String(iso ?? '').slice(0, 16).replace('T', ' ');

// The goal's messages: those carried from earlier sessions, then this session's, oldest first.
export function goalMessages(ledger, log) {
  const seen = new Set(), out = [];
  for (const m of [...(ledger.carried ?? []), ...log.filter((x) => x.goal === ledger.goal)]) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
  return out;
}
export const unsorted = (ledger, log) => goalMessages(ledger, log).filter((m) => !ledger.sorted.includes(m.id));

// The pure operations. Each returns a new ledger or throws an Error whose message goes back to the agent.
export function addEntry(ledger, p, find, now = new Date()) {
  if (!KINDS.includes(p.kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}.`);
  const msg = find(p.message_id);
  if (!msg) throw new Error(`No user message ${p.message_id}. mina_ledger with action list shows the message ids.`);
  if (!quoteIn(p.quote, msg.text)) throw new Error(`The quote is not in message ${msg.id}. Quote the user's exact words from it (whitespace may differ); put your reading in meaning.`);
  if (!norm(p.meaning)) throw new Error('Give your reading of the quote in meaning.');
  const conflicts = [...new Set(p.conflicts_with ?? [])];
  for (const id of conflicts) if (id !== 'goal' && !ledger.entries.some((e) => e.id === id && live(e))) throw new Error(`conflicts_with: ${id} is not an active entry (use "goal" for the goal text).`);
  if (conflicts.length && !norm(p.conflict)) throw new Error('Say in conflict what the conflict is: the user decides it.');
  const entry = { id: `L${ledger.seq + 1}`, kind: p.kind, status: conflicts.length ? 'disputed' : 'active', source: msg.id, source_at: msg.at,
    quote: norm(p.quote), meaning: norm(p.meaning), at: now.toISOString(), ...(msg.question ? { source_question: msg.question, source_typed: Boolean(msg.typed) } : {}), ...(conflicts.length ? { conflict: { with: conflicts, text: norm(p.conflict) } } : {}) };
  return { ...ledger, seq: ledger.seq + 1, entries: [...ledger.entries, entry] };
}

export function retireEntry(ledger, p, find, now = new Date()) {
  const e = ledger.entries.find((x) => x.id === p.id);
  if (!e || !live(e)) throw new Error(`${p.id} is not an active entry.`);
  let change;
  if (p.status === 'superseded') {
    const msg = find(p.message_id);
    if (!msg) throw new Error(`No user message ${p.message_id}: an entry is superseded only by a later message of the user, quoted.`);
    if (msg.id === e.source || !(msg.at > e.source_at)) throw new Error(`Message ${msg.id} is not later than ${e.id}'s source ${e.source}: only a later message of the user supersedes it.`);
    if (!quoteIn(p.quote, msg.text)) throw new Error(`The quote is not in message ${msg.id}. Quote the user's exact words that replace ${e.id}.`);
    change = { status: 'superseded', ended: { by: msg.id, quote: norm(p.quote), at: now.toISOString() } };
  } else if (p.status === 'done') {
    if (e.kind !== 'task') throw new Error(`${e.id} is a ${e.kind}: only a task ends on evidence. A ${e.kind} ends by a later user message (status superseded, with its quote) or by the user (/mina-ledger).`);
    if (!norm(p.evidence)) throw new Error('Record the evidence that the task is done (a file, a command and its output, a check result).');
    change = { status: 'done', ended: { evidence: norm(p.evidence), at: now.toISOString() } };
  } else throw new Error('status must be superseded or done.');
  return { ...ledger, entries: ledger.entries.map((x) => (x === e ? { ...x, ...change } : x)) };
}

// The user's answer to a conflict. outcome: 'new' (the disputed entry stands; the entries it conflicts with end), 'old'
// (it ends), 'both', or 'other' (the typed answer stands beside the entry). message: the answer, as logged; quote: the
// words of it that decide (all of it by default).
export function resolveEntry(ledger, id, outcome, message, now = new Date(), quote = message.text) {
  const e = ledger.entries.find((x) => x.id === id);
  const ruling = { answer: quote, message: message.id, at: now.toISOString() };
  const ended = { by: message.id, quote, at: now.toISOString() };
  return { ...ledger, entries: ledger.entries.map((x) => {
    if (x === e) return outcome === 'old' ? { ...x, status: 'superseded', ruling, ended } : { ...x, status: 'active', ruling };
    if (outcome === 'new' && live(x) && e.conflict?.with.includes(x.id)) return { ...x, status: 'superseded', ended };
    return x;
  }) };
}

// The agent settles a disputed entry from a later message of the user: usually the answer to its mina_ask_user question.
export function resolveFromMessage(ledger, p, find, now = new Date()) {
  const e = ledger.entries.find((x) => x.id === p.id);
  if (!e || e.status !== 'disputed') throw new Error(`${p.id} is not a disputed entry.`);
  if (!['new', 'old', 'both'].includes(p.outcome)) throw new Error('outcome must be new (the entry stands, the ones it conflicts with end), old (it ends) or both.');
  const msg = find(p.message_id);
  if (!msg) throw new Error(`No user message ${p.message_id}: a dispute is settled only by the user's answer, quoted.`);
  if (msg.id === e.source || !(msg.at > e.source_at)) throw new Error(`Message ${msg.id} is not later than ${e.id}'s source: only a later answer of the user settles it.`);
  if (!quoteIn(p.quote, msg.text)) throw new Error(`The quote is not in message ${msg.id}. Quote the user's exact words that settle ${e.id}.`);
  return resolveEntry(ledger, e.id, p.outcome, msg, now, norm(p.quote));
}

export function sortMessages(ledger, ids, find) {
  for (const id of ids ?? []) if (!find(id)) throw new Error(`No user message ${id}.`);
  return { ...ledger, sorted: [...new Set([...ledger.sorted, ...(ids ?? [])])] };
}

const entryLine = (e) => `- ${e.id} [${e.kind}${e.status === 'disputed' ? `; DISPUTED, the user has not decided: ${e.conflict.text}` : ''}] "${e.quote}" `
  + `(the user, ${when(e.source_at)}, message ${e.source}${e.source_question ? `, answering "${e.source_question}"` : ''})\n  Reading (the agent's words, not the user's): ${e.meaning}`
  + (e.ruling ? `\n  The user's ruling on a conflict (${when(e.ruling.at)}): "${e.ruling.answer}"` : '')
  + (e.conflict?.with.includes('goal') && e.status === 'active' ? '\n  The user ruled on its conflict with the goal text: the ruling decides.' : '');
const shown = (m) => (m.text.length > MESSAGE_MAX_CHARS ? `${m.text.slice(0, MESSAGE_MAX_CHARS)}\n[… ${m.text.length - MESSAGE_MAX_CHARS} more characters: mina_ledger list]` : m.text);
const origin = (m) => (m.question ? `, the user's answer to the question "${m.question}"; ${m.typed ? 'typed by the user' : 'an option that the agent wrote, chosen by the user'}` : '');
const messageLine = (m) => `- ${m.id} (${when(m.at)}${origin(m)}):\n${shown(m).replace(/^/gm, '  > ')}`;

// The section that follows every compaction and is in every handoff packet. Empty when there is nothing.
export function ledgerSection(ledger, log, { exclude = [], maxUnsorted = UNSORTED_MAX_BYTES } = {}) {
  const active = ledger.entries.filter(live);
  const open = unsorted(ledger, log).filter((m) => !exclude.includes(m.id));
  const parts = [];
  if (active.length) parts.push('## The user\'s standing instructions for this goal (operator ledger, verbatim)\n'
    + 'The quotes are the user\'s own words from the conversation. They bind how you work. The goal text and its checks remain the '
    + 'acceptance bar, and no entry relaxes a protected check. Where an entry seems to conflict with the goal or another entry, do not '
    + 'choose: give conflicts_with to mina_ledger, which asks the user.\n'
    + active.map(entryLine).join('\n'));
  if (open.length) {
    const kept = [];
    let bytes = 0;
    for (const m of [...open].reverse()) {
      const line = messageLine(m), b = Buffer.byteLength(line);
      if (kept.length && bytes + b > maxUnsorted) break;
      kept.unshift(line); bytes += b;
    }
    parts.push('## The user\'s messages not yet sorted into the ledger (verbatim, oldest first)\n'
      + 'Record what stands in each (mina_ledger, action add), then mark it sorted (action sort).\n'
      + (open.length > kept.length ? `[${open.length - kept.length} older unsorted message(s) not shown here: mina_ledger list shows them.]\n` : '')
      + kept.join('\n'));
  }
  return parts.join('\n\n');
}

// The mirror the user reads. It depends only on the ledger and the log, so a restarted session writes the same text.
export function mirrorText(ledger, log) {
  const by = (s) => ledger.entries.filter((e) => e.status === s);
  const ended = (e) => `${entryLine(e)}\n  Ended ${when(e.ended?.at)}: ${e.ended?.evidence ? `evidence: ${e.ended.evidence}` : `by ${e.ended?.by ?? 'the user'}: "${e.ended?.quote ?? ''}"`}`;
  const open = unsorted(ledger, log);
  return ['# Operator ledger (mirror)', '',
    `mina keeps this ledger in the session file and rewrites this file from it. An edit here is not read back: mina moves an edited copy aside. Use /mina-ledger. Goal: ${ledger.goal ?? 'none'}.`, '',
    '## Active', ...(by('active').length ? by('active').map(entryLine) : ['(none)']), '',
    '## Disputed (waiting for the user)', ...(by('disputed').length ? by('disputed').map(entryLine) : ['(none)']), '',
    '## Unsorted messages', ...(open.length ? open.map(messageLine) : ['(none)']), '',
    '## Ended', ...(by('done').length + by('superseded').length ? [...by('done'), ...by('superseded')].map(ended) : ['(none)']), ''].join('\n');
}

const MINA_LEDGER_DESCRIPTION = 'The user\'s standing instructions for this goal, in the user\'s own words. mina saves every message the user types. '
  + 'For each, record what stands in it (a directive, constraint, priority, task or fact) with action add: message_id, quote (the user\'s exact words '
  + 'from that message; mina checks them) and meaning (your reading). Then mark the message sorted (action sort). Active entries and unsorted messages '
  + 'are restated word for word after each compaction and in each handoff. An entry ends only by a later user message (action retire, status '
  + 'superseded, with that message\'s id and quote); a task also ends when you record the evidence that it is done (status done, evidence). '
  + 'If a message seems to conflict with an active entry or with the goal text, add it with conflicts_with and conflict: mina asks the user. '
  + 'The user\'s answers to mina_ask_user are logged as messages too: quote them like any message. A disputed entry that the user settled in '
  + 'such an answer (or in a later message) is settled with action resolve: id, outcome, message_id and quote. '
  + 'Action list shows the entries and the unsorted messages with their ids.';

export function installLedger(pi, { notify = () => {}, measure = () => {} } = {}) {
  let log = [], ledger = emptyLedger(), written = null, sessionFile = null;
  const goalOf = (ctx) => (ctx?.sessionManager?.getBranch?.() ?? []).filter((e) => e.type === 'custom' && e.customType === 'mina-goal').at(-1)?.data?.id ?? null;
  // A new goal starts an empty ledger: entries belong to the goal they were given for.
  const sync = (ctx) => { const g = goalOf(ctx); if (ledger.goal !== g) ledger = emptyLedger(g); };
  // Messages from earlier sessions of the handoff chain that were sorted there (and so not carried).
  const older = (id) => {
    if (!sessionFile) return null;
    try {
      for (const s of lineage(sessionFile).slice(1)) {
        const e = s.entries.find((x) => x.type === 'custom' && x.customType === OPLOG && x.data?.id === id);
        if (e) return e.data;
      }
    } catch { /* unreadable: not found */ }
    return null;
  };
  const find = (id) => goalMessages(ledger, log).find((m) => m.id === id) ?? log.find((m) => m.id === id) ?? older(id);
  const mirror = (ctx) => {
    if (!ledger.goal || !ctx?.cwd) return;
    const path = join(ctx.cwd, LEDGER_FILE), text = mirrorText(ledger, log);
    try {
      if (existsSync(path)) {
        const now = readFileSync(path, 'utf8');
        if (now === text) { written = text; return; }
        if (written !== null && now !== written) {
          const aside = `${path}.edited-${new Date().toISOString().replace(/[:.]/g, '-')}`;
          renameSync(path, aside);
          measure('ledger_mirror_edited', {});
          notify(ctx, `mina: ${LEDGER_FILE} was changed outside mina. mina does not read it back; the edited copy is ${aside}. Use /mina-ledger to change the ledger.`, 'warning');
        }
      }
      mkdirSync(join(ctx.cwd, '.mina'), { recursive: true });
      writeFileSync(path, text);
      written = text;
    } catch { /* the mirror is a convenience: the session file is the store */ }
  };
  const save = (ctx) => { pi.appendEntry(LEDGER, ledger); mirror(ctx); };
  const logMessage = (ctx, text, extra) => {
    const m = newMessage(text, ledger.goal, undefined, extra);
    log.push(m);
    pi.appendEntry(OPLOG, m);
    return m;
  };

  pi.on('session_start', (_event, ctx) => {
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    sessionFile = ctx?.sessionManager?.getSessionFile?.() ?? null;
    log = branch.filter((e) => e.type === 'custom' && e.customType === OPLOG).map((e) => e.data).filter(Boolean);
    ledger = branch.filter((e) => e.type === 'custom' && e.customType === LEDGER).at(-1)?.data ?? emptyLedger(goalOf(ctx));
    sync(ctx);
    written = mirrorText(ledger, log);   // what this session's store last wrote, as far as mina can know
  });
  // Registered before the handoff's own input handler: Pi stops at a handler that returns "handled", and the messages
  // a handoff holds are the user's too.
  pi.on('input', (event, ctx) => {
    if (event?.source === 'extension' || !String(event?.text ?? '').trim()) return undefined;
    sync(ctx);
    logMessage(ctx, event.text);
    mirror(ctx);
    return undefined;
  });
  // An answer to mina_ask_user (extensions/goal): a new answer only, never a reused receipt.
  pi.events?.on?.(ANSWER_EVENT, (d) => {
    try {
      if (!String(d?.answer ?? '').trim()) return;
      sync(d.ctx);
      logMessage(d.ctx, String(d.answer), { question: String(d.question ?? ''), typed: Boolean(d.typed), request_id: d.request_id ?? null });
      mirror(d.ctx);
    } catch { /* a stale context: the answer is still in the mina-question entry */ }
  });

  async function ask(ctx, entry) {
    const others = entry.conflict.with.map((id) => (id === 'goal' ? 'the goal text' : `${id} "${ledger.entries.find((e) => e.id === id)?.quote}"`)).join(' and ');
    const question = `Your instruction "${entry.quote}" seems to conflict with ${others}: ${entry.conflict.text} Which stands?`;
    const options = [`Your newer instruction stands: "${entry.quote.slice(0, 100)}"`, `The earlier ${entry.conflict.with.includes('goal') ? 'goal text / instruction' : 'instruction'} stands`,
      'Both stand: they do not conflict', OTHER];
    let choice = await oneDialog(() => ctx.ui.select(question, options));
    const typed = choice === OTHER;
    if (typed) choice = await oneDialog(() => ctx.ui.input('Your answer:', ''));
    if (!choice) return null;
    const outcome = ['new', 'old', 'both'][options.indexOf(choice)] ?? 'other';
    return { outcome, message: logMessage(ctx, choice, { question, typed }) };
  }

  pi.registerTool({
    name: 'mina_ledger',
    label: 'Operator ledger',
    description: MINA_LEDGER_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'retire', 'resolve', 'sort'] },
        outcome: { type: 'string', enum: ['new', 'old', 'both'], description: 'resolve: new (the disputed entry stands; the entries it conflicts with end), old (it ends), or both stand.' },
        kind: { type: 'string', enum: KINDS, description: 'add: what the quote is.' },
        message_id: { type: 'string', description: 'add: the message quoted. retire with status superseded: the later message that replaces the entry. resolve: the user\'s answer.' },
        quote: { type: 'string', description: 'The user\'s exact words from that message.' },
        meaning: { type: 'string', description: 'add: your reading of the quote.' },
        conflicts_with: { type: 'array', items: { type: 'string' }, description: 'add: entry ids, or "goal", that this seems to conflict with. mina asks the user.' },
        conflict: { type: 'string', description: 'add with conflicts_with: the conflict, in one sentence.' },
        id: { type: 'string', description: 'retire, resolve: the entry id (L1, L2, ...).' },
        status: { type: 'string', enum: ['superseded', 'done'] },
        evidence: { type: 'string', description: 'retire a task with status done: the recorded evidence (a file, a command and its output, a check result).' },
        message_ids: { type: 'array', items: { type: 'string' }, description: 'sort: messages whose standing content is recorded (or that have none).' },
      },
      required: ['action'],
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      sync(ctx);
      const reply = (text, isError = false) => ({ content: [{ type: 'text', text }], details: { ledger }, ...(isError ? { isError: true } : {}) });
      try {
        if (params.action === 'list') {
          const all = goalMessages(ledger, log), open = unsorted(ledger, log);
          return reply([ledgerSection(ledger, log, { maxUnsorted: Infinity }) || 'The ledger is empty and every message is sorted.',
            `${all.length} message(s) for this goal, ${open.length} unsorted. Ended entries: ${ledger.entries.filter((e) => !live(e)).map((e) => `${e.id} ${e.status}`).join(', ') || 'none'}.`].join('\n\n'));
        }
        if (params.action === 'sort') { ledger = sortMessages(ledger, params.message_ids, find); save(ctx); return reply(`Sorted: ${(params.message_ids ?? []).join(', ')}.`); }
        if (params.action === 'retire') { ledger = retireEntry(ledger, params, find); save(ctx); return reply(`${params.id} is ${params.status}.`); }
        if (params.action === 'resolve') {
          ledger = resolveFromMessage(ledger, params, find); save(ctx);
          return reply(`${params.id} is ${ledger.entries.find((e) => e.id === params.id).status}, by the user's words in ${params.message_id}.`);
        }
        if (params.action !== 'add') return reply('action must be list, add, retire, resolve or sort.', true);
        ledger = addEntry(ledger, params, find);
        const entry = ledger.entries.at(-1);
        save(ctx);
        if (entry.status !== 'disputed') return reply(`Recorded ${entry.id}. Mark message ${entry.source} sorted when everything standing in it is recorded.`);
        measure('ledger_conflict', { with: entry.conflict.with.length });
        if (!ctx?.hasUI) return reply(`Recorded ${entry.id} as DISPUTED: no one can answer here (no interactive terminal). It travels as disputed. `
          + 'Ask the user in your reply, and call goal_blocked if you cannot continue without the answer. When the user answers, settle it with action resolve.');
        const answer = await ask(ctx, entry);
        if (!answer) return reply(`The user closed the question. ${entry.id} stays DISPUTED and travels as such: do not act on either side of the conflict without asking.`);
        ledger = resolveEntry(ledger, entry.id, answer.outcome, answer.message);
        save(ctx);
        const result = ledger.entries.find((e) => e.id === entry.id);
        return reply(`The user answered: "${answer.message.text}". ${entry.id} is ${result.status}`
          + `${answer.outcome === 'new' ? `; ${entry.conflict.with.filter((x) => x !== 'goal').join(', ') || 'the goal text'} gives way to it` : ''}. The answer is logged as message ${answer.message.id}.`);
      } catch (err) { return reply(String(err?.message ?? err), true); }
    },
  });

  pi.registerCommand('mina-ledger', {
    description: 'The operator ledger: your standing instructions for this goal. /mina-ledger shows it; "retire L3 [reason]", "restore L3", "add <instruction>"',
    handler: async (args, ctx) => {
      sync(ctx);
      const [sub, id, ...rest] = String(args ?? '').trim().split(/\s+/);
      if (!sub || sub === 'list') {
        const text = mirrorText(ledger, log);
        if (ctx?.hasUI && ctx.ui.editor) await oneDialog(() => ctx.ui.editor('Operator ledger (to read; edits are not saved)', text));
        else notify(ctx, text);
        return;
      }
      if (sub === 'add') {
        const text = String(args).trim().slice(3).trim();
        if (!text) { notify(ctx, 'mina: /mina-ledger add <instruction>', 'warning'); return; }
        const m = logMessage(ctx, text);
        ledger = sortMessages(addEntry(ledger, { kind: 'directive', message_id: m.id, quote: text, meaning: '(added by the user with /mina-ledger)' }, find), [m.id], find);
        save(ctx); notify(ctx, `mina: recorded ${ledger.entries.at(-1).id}.`);
        return;
      }
      const e = ledger.entries.find((x) => x.id === id);
      if (!e || !['retire', 'restore'].includes(sub)) { notify(ctx, 'mina: /mina-ledger [list | retire <id> [reason] | restore <id> | add <instruction>]', 'warning'); return; }
      const at = new Date().toISOString();
      const change = sub === 'retire' ? { status: 'superseded', ended: { by: 'the user (/mina-ledger)', quote: rest.join(' '), at } } : { status: 'active', ended: undefined, restored: at };
      ledger = { ...ledger, entries: ledger.entries.map((x) => (x === e ? { ...x, ...change } : x)) };
      save(ctx); notify(ctx, `mina: ${e.id} is ${change.status}.`);
    },
  });

  return {
    // The section for a restatement or a packet (exclude: message ids shown elsewhere in the same text).
    section: (ctx, opts) => { sync(ctx); return ledgerSection(ledger, log, opts); },
    latest: (ctx) => { sync(ctx); return goalMessages(ledger, log).at(-1) ?? null; },
    // The ledger a successor session starts with: the entries, and the unsorted messages carried word for word.
    successor: (ctx) => { sync(ctx); return { ...ledger, carried: unsorted(ledger, log), sorted: [] }; },
  };
}
