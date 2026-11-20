import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLedger, newMessage, quoteIn, addEntry, retireEntry, resolveEntry, resolveFromMessage, sortMessages, ledgerSection, mirrorText, unsorted } from '../extensions/handoff/ledger.mjs';

// The user's words of 2026-11-19 02:26, which a summary weakened and an in-place handoff dropped.
const NO_GPT = 'Your task is to orchestrate your team of GLM subagents - you may do some work, but I would like you to prefer using them for implementation '
  + 'and even design with your guidance. Analysis and direction are your responsibility under the goal contract - do not spin up GPT or Claude subagents. ';
const at = (h) => new Date(`2026-11-19T${h}:00Z`);
const setup = () => {
  const log = [newMessage(NO_GPT, 'g', at('02:26')), newMessage('add a durable\n  ledger of fixes', 'g', at('06:28'))];
  const find = (id) => log.find((m) => m.id === id);
  return { log, find, ledger: emptyLedger('g') };
};

test('a quote must be the user\'s own words: a substring of the message, whitespace aside', () => {
  assert.equal(quoteIn('do not spin up GPT or Claude subagents', NO_GPT), true);
  assert.equal(quoteIn('add a durable ledger', 'add a durable\n  ledger of fixes'), true);
  assert.equal(quoteIn('GLM-only implementation children', NO_GPT), false, 'a paraphrase is not a quote');
  assert.equal(quoteIn('   ', NO_GPT), false);
});

test('add: an entry quotes its message exactly and keeps the agent\'s reading apart; a paraphrase is refused', () => {
  const { log, find, ledger } = setup();
  assert.throws(() => addEntry(ledger, { kind: 'constraint', message_id: log[0].id, quote: 'GLM-only implementation children', meaning: 'x' }, find), /not in message/);
  assert.throws(() => addEntry(ledger, { kind: 'rule', message_id: log[0].id, quote: 'do not', meaning: 'x' }, find), /kind must be/);
  assert.throws(() => addEntry(ledger, { kind: 'constraint', message_id: 'U0', quote: 'do not', meaning: 'x' }, find), /No user message U0/);
  const next = addEntry(ledger, { kind: 'constraint', message_id: log[0].id, quote: 'do not spin up GPT or Claude subagents', meaning: 'subagents run on GLM only' }, find);
  assert.deepEqual(next.entries.map((e) => [e.id, e.kind, e.status, e.source, e.quote]), [['L1', 'constraint', 'active', log[0].id, 'do not spin up GPT or Claude subagents']]);
  assert.equal(ledger.entries.length, 0, 'operations do not modify their input');
});

test('retire: a standing entry ends only by a later user message, quoted; only a task ends on recorded evidence', () => {
  const { log, find } = setup();
  let l = addEntry(emptyLedger('g'), { kind: 'constraint', message_id: log[1].id, quote: 'durable ledger', meaning: 'm' }, find);
  l = addEntry(l, { kind: 'task', message_id: log[1].id, quote: 'add a durable ledger of fixes', meaning: 'write the ledger' }, find);
  assert.throws(() => retireEntry(l, { id: 'L1', status: 'superseded', message_id: log[0].id, quote: 'do not spin up' }, find), /not later/);
  assert.throws(() => retireEntry(l, { id: 'L1', status: 'superseded', message_id: log[1].id, quote: 'durable ledger' }, find), /not later/);
  assert.throws(() => retireEntry(l, { id: 'L1', status: 'done', evidence: 'docs/ledger.md written' }, find), /only a task ends on evidence/);
  assert.throws(() => retireEntry(l, { id: 'L2', status: 'done', evidence: ' ' }, find), /Record the evidence/);
  const done = retireEntry(l, { id: 'L2', status: 'done', evidence: 'docs/ledger.md written, commit 1a2b3c' }, find);
  assert.deepEqual([done.entries[1].status, done.entries[1].ended.evidence], ['done', 'docs/ledger.md written, commit 1a2b3c']);
  log.push(newMessage('forget the ledger, it is not needed', 'g', at('07:00')));
  assert.throws(() => retireEntry(l, { id: 'L1', status: 'superseded', message_id: log[2].id, quote: 'not needed at all' }, find), /quote is not in message/);
  const sup = retireEntry(l, { id: 'L1', status: 'superseded', message_id: log[2].id, quote: 'forget the ledger' }, find);
  assert.deepEqual([sup.entries[0].status, sup.entries[0].ended.by], ['superseded', log[2].id]);
  assert.throws(() => retireEntry(sup, { id: 'L1', status: 'done', evidence: 'x' }, find), /not an active entry/);
});

test('a conflict is recorded as disputed until the user decides; the answer decides which entry stands', () => {
  const { log, find } = setup();
  let l = addEntry(emptyLedger('g'), { kind: 'constraint', message_id: log[0].id, quote: 'do not spin up GPT or Claude subagents', meaning: 'GLM only' }, find);
  log.push(newMessage('use a Claude subagent for the audit', 'g', at('09:00')));
  assert.throws(() => addEntry(l, { kind: 'directive', message_id: log[2].id, quote: 'use a Claude subagent for the audit', meaning: 'm', conflicts_with: ['L1'] }, find), /Say in conflict/);
  assert.throws(() => addEntry(l, { kind: 'directive', message_id: log[2].id, quote: 'use a Claude subagent', meaning: 'm', conflicts_with: ['L9'], conflict: 'c' }, find), /L9 is not an active entry/);
  l = addEntry(l, { kind: 'directive', message_id: log[2].id, quote: 'use a Claude subagent for the audit', meaning: 'one Claude audit', conflicts_with: ['L1'], conflict: 'L1 forbids Claude subagents.' }, find);
  assert.equal(l.entries[1].status, 'disputed');
  assert.match(ledgerSection(l, log), /L2 \[directive; DISPUTED, the user has not decided: L1 forbids Claude subagents\.\]/);
  const answer = newMessage('Your newer instruction stands', 'g', at('09:05'), { question: 'Which stands?' });
  const won = resolveEntry(l, 'L2', 'new', answer);
  assert.deepEqual(won.entries.map((e) => e.status), ['superseded', 'active']);
  assert.match(ledgerSection(won, [...log, answer]), /The user's ruling on a conflict[^]*"Your newer instruction stands"/);
  assert.deepEqual(resolveEntry(l, 'L2', 'old', answer).entries.map((e) => e.status), ['active', 'superseded']);
  assert.deepEqual(resolveEntry(l, 'L2', 'both', answer).entries.map((e) => e.status), ['active', 'active']);
});

test('a dispute is settled from a later answer of the user, quoted; an answer shows the question it answers and who wrote its words', () => {
  const { log, find } = setup();
  let l = addEntry(emptyLedger('g'), { kind: 'constraint', message_id: log[0].id, quote: 'do not spin up GPT or Claude subagents', meaning: 'GLM only' }, find);
  log.push(newMessage('use a Claude subagent for the audit', 'g', at('09:00')));
  l = addEntry(l, { kind: 'directive', message_id: log[2].id, quote: 'use a Claude subagent for the audit', meaning: 'one exception', conflicts_with: ['goal', 'L1'], conflict: 'L1 and the goal say GLM only.' }, find);
  const p = { id: 'L2', outcome: 'new', message_id: log[0].id, quote: 'do not spin up' };
  assert.throws(() => resolveFromMessage(l, p, find), /not later/);
  assert.throws(() => resolveFromMessage(l, { ...p, id: 'L1' }, find), /L1 is not a disputed entry/);
  assert.throws(() => resolveFromMessage(l, { ...p, outcome: 'mine' }, find), /outcome must be/);
  const chosen = newMessage('2. Only the audit may use Claude (recommended)', 'g', at('09:10'), { question: 'Does the audit override GLM only?', typed: false });
  const typed = newMessage('yes, the audit only; everything else stays GLM', 'g', at('09:11'), { question: 'Does the audit override GLM only?', typed: true });
  log.push(chosen, typed);
  assert.throws(() => resolveFromMessage(l, { ...p, message_id: typed.id, quote: 'Claude is fine everywhere' }, find), /quote is not in message/);
  const done = resolveFromMessage(l, { ...p, message_id: typed.id, quote: 'the audit only; everything else stays GLM' }, find);
  assert.deepEqual(done.entries.map((e) => e.status), ['superseded', 'active']);
  assert.equal(done.entries[1].ruling.answer, 'the audit only; everything else stays GLM');
  const s = ledgerSection(l, log);
  assert.match(s, /\(\d{4}-\d\d-\d\d \d\d:\d\d, the user's answer to the question "Does the audit override GLM only\?"; an option that the agent wrote, chosen by the user\):\n  > 2\. Only the audit/);
  assert.match(s, /the user's answer to the question "Does the audit override GLM only\?"; typed by the user\):\n  > yes, the audit only/);
  const cited = addEntry(l, { kind: 'directive', message_id: typed.id, quote: 'everything else stays GLM', meaning: 'm' }, find);
  assert.match(ledgerSection(cited, log), /- L3 \[directive\] "everything else stays GLM" \(the user, [^)]*answering "Does the audit override GLM only\?"\)/);
});

test('the section: active entries verbatim, unsorted messages verbatim; the oldest unsorted are dropped first, and say so', () => {
  const { log, find } = setup();
  let l = addEntry(emptyLedger('g'), { kind: 'constraint', message_id: log[0].id, quote: 'do not spin up GPT or Claude subagents', meaning: 'GLM only' }, find);
  let s = ledgerSection(l, log);
  assert.match(s, /^## The user's standing instructions for this goal \(operator ledger, verbatim\)/);
  assert.match(s, /- L1 \[constraint\] "do not spin up GPT or Claude subagents" \(the user, 2026-11-19 02:26, message U[0-9a-f]+\)\n  Reading \(the agent's words, not the user's\): GLM only/);
  assert.match(s, /no entry relaxes a protected check/);
  assert.match(s, /## The user's messages not yet sorted[^]*do not spin up GPT or Claude subagents[^]*add a durable\n  >   ledger of fixes/);
  l = sortMessages(l, [log[0].id], find);
  assert.deepEqual(unsorted(l, log).map((m) => m.id), [log[1].id]);
  assert.throws(() => sortMessages(l, ['U0'], find), /No user message U0/);
  s = ledgerSection(l, log, { exclude: [log[1].id] });
  assert.doesNotMatch(s, /not yet sorted/);
  const many = [...log, ...Array.from({ length: 10 }, (_, i) => newMessage(`message ${i} ${'x'.repeat(300)}`, 'g', at('08:00')))];
  s = ledgerSection(emptyLedger('g'), many, { maxUnsorted: 1500 });
  assert.match(s, /\[\d+ older unsorted message\(s\) not shown here: mina_ledger list shows them\.\]/);
  assert.match(s, /message 9 /); assert.doesNotMatch(s, /do not spin up/);
  assert.equal(ledgerSection(emptyLedger('g'), []), '');
});

test('messages and entries belong to their goal; carried messages come first', () => {
  const { log } = setup();
  const other = newMessage('for another goal', 'h', at('03:00'));
  const carried = newMessage('from the earlier session', 'g', at('01:00'));
  const l = { ...emptyLedger('g'), carried: [carried] };
  assert.deepEqual(unsorted(l, [...log, other]).map((m) => m.text.slice(0, 10)), ['from the e', 'Your task ', 'add a dura']);
});

test('the mirror shows every entry by status and depends only on the ledger and the log', () => {
  const { log, find } = setup();
  let l = addEntry(emptyLedger('g'), { kind: 'task', message_id: log[1].id, quote: 'add a durable ledger', meaning: 'm' }, find);
  l = retireEntry(l, { id: 'L1', status: 'done', evidence: 'docs/ledger.md' }, find);
  const m = mirrorText(l, log);
  assert.match(m, /^# Operator ledger \(mirror\)/); assert.match(m, /## Active\n\(none\)/); assert.match(m, /## Ended\n- L1 \[task\][^]*evidence: docs\/ledger\.md/);
  assert.equal(mirrorText(l, log), m);
});
