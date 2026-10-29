// Asking the user for a decision (docs/architecture.md). In goal mode the agent cannot simply ask and
// stop: ending a turn starts the next one, and goal_wait / goal_blocked report to their tool result, not to the user.
// In a long run the agent needed an operator decision (fixed clocks or a measurement policy) and wrote it into a file
// and a goal_wait reason; nobody was asked, and pi-goal's 30-minute safety wake-ups re-waited.
// mina_ask_user puts the decision in front of the user (a banner and a selection) and waits for the answer.
export const ASK_TOOL = 'mina_ask_user';
export const WIDGET = 'mina-question';
export const OTHER = 'Other: type your own answer';
export const DETAILS = 'Show full details (context, consequences, commands)';

export function validateOperatorAction(p, optionCount) {
  if (!p) return;
  if (!Number.isInteger(p.option_index) || p.option_index < 0 || p.option_index >= optionCount) throw new Error('operator_action.option_index must identify the option that agrees to perform the action.');
  for (const key of ['target', 'effect', 'reason', 'commands', 'expected_output', 'stop_on_error']) {
    if (typeof p[key] !== 'string' || !p[key].trim()) throw new Error(`operator_action.${key} must be explicit; a file reference alone is not a procedure.`);
  }
  if (!Array.isArray(p.preconditions) || !p.preconditions.length || p.preconditions.some((x) => typeof x !== 'string' || !x.trim())) throw new Error('Give explicit operator preconditions.');
  if (p.restoration !== null && (!p.restoration || typeof p.restoration.when !== 'string' || !p.restoration.when.trim()
    || typeof p.restoration.commands !== 'string' || !p.restoration.commands.trim())) throw new Error('Give restoration.when and restoration.commands, or explicit null if no restoration is declared.');
  for (const command of [p.commands, p.restoration?.commands].filter(Boolean)) {
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) throw new Error('Operator commands must not contain terminal control characters.');
  }
}

const code = (s) => {
  const fence = '`'.repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${fence}sh\n${s}\n${fence}`;
};

export function operatorProcedure(p) {
  return [`# Operator action — mina does not execute these commands`, `Target: ${p.target}`, `Effect: ${p.effect}`, `Operator required: ${p.reason}`,
    `## Preconditions\n${p.preconditions.map((s) => `- ${s}`).join('\n')}`,
    `## Action commands\n${code(p.commands)}`, `## Return this output\n${p.expected_output}`,
    `## On error\n${p.stop_on_error}`,
    p.restoration ? `## Restoration — later, not now\nWhen: ${p.restoration.when}\n${code(p.restoration.commands)}`
      : 'Restoration: none declared by the agent.',
    'Agreement is not execution. Output still needs verification.'].join('\n\n');
}

export function questionLines({ question, context, options = [], recommended, why }) {
  const lines = [`mina: the agent asks you: ${question}`];
  if (context) lines.push(`  ${String(context).slice(0, 600)}`);
  options.forEach((o, i) => lines.push(`  ${i + 1}. ${o.label}${i === recommended ? '  (recommended)' : ''}${o.consequence ? ` - ${o.consequence}` : ''}`));
  if (why && Number.isInteger(recommended)) lines.push(`  Why ${recommended + 1}: ${why}`);
  return lines;
}
