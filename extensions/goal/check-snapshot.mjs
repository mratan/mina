// Run accepted checker bytes, not a mutable workspace pathname after a hash check.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { runFileOperationSync } from '../../sandbox/worker-client.mjs';
import { changedFiles } from './check-files.mjs';
const snapshots = new Map();
export function checkSnapshot(cwd, frozen, env) {
  if (!frozen || !Object.keys(frozen).length) return null;
  const key = createHash('sha256').update(JSON.stringify([cwd, frozen])).digest('hex');
  if (snapshots.has(key)) return snapshots.get(key);
  const bundle = runFileOperationSync('bundle', { path: join(cwd, '.mina', 'checks') }, { cwd, env });
  if (changedFiles(frozen, bundle.hashes).length) throw new Error('Protected check bytes changed before execution; no check ran.');
  const root = join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'mina', 'check-snapshots');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const source = mkdtempSync(join(root, 'accepted-'));
  for (const [path, data] of Object.entries(bundle.files)) {
    if (!path.startsWith('.mina/checks/') || path.split('/').some((part) => part === '.' || part === '..')) throw new Error('Invalid protected asset path.');
    const target = join(source, path.slice('.mina/checks/'.length));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, Buffer.from(data, 'base64'), { mode: 0o500 });
  }
  const snapshot = { source, target: join(cwd, '.mina', 'checks') };
  snapshots.set(key, snapshot);
  return snapshot;
}
