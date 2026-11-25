// pi-goal owns the objective; Mina owns the checks and the stable ID used by the operator ledger.
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, statSync } from '../../sandbox/project-fs.mjs';

export function readObjective(objective, cwd) {
  if (/^\S+$/.test(objective)) {
    const file = resolve(cwd ?? '.', objective.replace(/^~(?=\/)/, homedir()));
    try {
      if (statSync(file).isFile() && statSync(file).size <= 65536) return { file, body: readFileSync(file, 'utf8').trim() };
    } catch { /* A missing or unreadable file is still the objective text, not an older path. */ }
  }
  return {};
}

export function nativeForContract(contract, native) {
  // Mina writes a new contract before starting its native run. Never use an earlier goal's run in that gap.
  return native?.startedAt < Date.parse(contract?.started_at) ? null : native;
}

export function reconcileObjective(contract, native, cwd) {
  native = nativeForContract(contract, native);
  if (!contract || contract.status === 'cleared' || !native?.text) return contract;
  const tokens = native.tokenBudget ?? null;
  const reactivated = contract.status === 'complete' && native.status === 'active';
  if (contract.objective === native.text && !reactivated) {
    return String(contract.tokens ?? '') === String(tokens ?? '') ? contract : { ...contract, tokens };
  }
  const { file } = readObjective(native.text, cwd);
  return { ...contract, objective: native.text, objective_file: file, tokens,
    ...(reactivated ? { status: 'active', completed_at: undefined } : {}), lastStatus: null, results: null, rejections: 0 };
}
