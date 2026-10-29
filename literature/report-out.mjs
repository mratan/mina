// Where the live literature suites (smoke.mjs, broker-integration.mjs) write their reports: --out DIR (or --out=DIR),
// else <repo>/.mina/literature, which git ignores. Live output never goes into tracked files by default.
import { resolve } from 'node:path';

/** argv (without node and the script) → { out, only }: the report directory and the upper-cased check ids to run. */
export function reportArgs(argv, repo) {
  let out = null; const only = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { out = argv[++i]; if (!out) throw new Error('--out needs a directory'); }
    else if (a.startsWith('--out=')) out = a.slice(6);
    else only.push(a.toUpperCase());
  }
  return { out: out ? resolve(out) : resolve(repo, '.mina', 'literature'), only };
}
