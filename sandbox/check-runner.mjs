// Trusted protected-check entry point. Pin source objects, then give the checker a
// private directory topology. Host/workspace renames cannot move its checker mounts.
import { openSync, closeSync, fstatSync, readdirSync, readlinkSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, basename } from 'node:path';
import { constants as signals } from 'node:os';
import { innerArgs, BWRAP_PATH, EGRESS_BRIDGE, BRIDGE_NODE_FLAGS } from './sandbox.mjs';
const O_PATH = 0x200000, O_NOFOLLOW = 0x20000;
const fds = [], mountFds = [];
const mounts = [];
const pinned = (path) => {
  const fd = openSync(path, O_PATH | O_NOFOLLOW);
  fds.push(fd);
  return { fd, stat: fstatSync(fd) };
};
const at = (fd, name = '') => `/proc/self/fd/${fd}${name ? `/${name}` : ''}`;
try {
  const { command, options } = JSON.parse(Buffer.from(process.argv[2], 'base64').toString());
  const project = options.project || options.cwd;
  const target = options.protectedChecksSnapshot.target;
  const path = relative(project, dirname(target));
  if (path.startsWith('..') || path.startsWith('/')) throw new Error('Protected checker path is outside the project.');
  const parts = path.split('/').filter(Boolean);
  const base = options.env.MINA_WORKER_OUTPUTS || join(dirname(options.protectedChecksSnapshot.source), 'check-runs');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(base, 'check-'));
  const root = pinned(project);
  if (!root.stat.isDirectory()) throw new Error('Project root must be a directory, not a symlink.');
  mounts.push('--bind', staging, project);
  function layer(source, destination, backing, depth) {
    const protectedName = depth < parts.length ? parts[depth] : 'checks';
    for (const name of readdirSync(at(source.fd))) {
      if (name === protectedName) continue;
      const p = pinned(at(source.fd, name));
      if (p.stat.isSymbolicLink()) {
        // Recreate link text, never bind-follow an agent-controlled symlink on the host.
        symlinkSync(readlinkSync(at(source.fd, name)), join(backing, name));
      } else if (p.stat.isDirectory() || p.stat.isFile()) {
        const child = 3 + mountFds.length;
        mountFds.push(p.fd); // bwrap consumes these. Never inherit unused traversal descriptors.
        mounts.push('--bind-fd', String(child), join(destination, name));
      } else throw new Error('Protected check view contains a special file.');
    }
    if (depth < parts.length) {
      const next = pinned(at(source.fd, protectedName));
      if (!next.stat.isDirectory()) throw new Error('Protected checker ancestors must be real directories.');
      const local = join(backing, protectedName); mkdirSync(local, { mode: 0o700 });
      const dest = join(destination, protectedName);
      mounts.push('--bind', local, dest); // A private mountpoint cannot be renamed by candidate code.
      layer(next, dest, local, depth + 1);
    }
  }
  layer(root, project, staging, 0);
  const args = innerArgs({ ...options, projectionMounts: mounts });
  const argv = options.network === 'offline' ? ['/bin/bash', '--noprofile', '--norc', '-c', command]
    : ['/run/mina-node', ...BRIDGE_NODE_FLAGS, EGRESS_BRIDGE, '--', '/bin/bash', '--noprofile', '--norc', '-c', command];
  const visible = options.env.MINA_WORKER_OUTPUTS ? `/run/mina-outputs/${basename(staging)}` : staging;
  process.stderr.write(`mina: protected-check new root artifacts: ${visible} (retained host path: ${staging})\n`);
  const child = spawnSync(BWRAP_PATH, [...args, '--', ...argv], { env: { PATH: '/usr/bin:/bin' }, stdio: ['inherit', 'inherit', 'inherit', ...mountFds] });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 128 + (signals.signals[child.signal] ?? 0);
} catch (error) { process.stderr.write(`mina: protected check refused: ${error.message}\n`); process.exitCode = 126; }
finally { for (const fd of fds) { try { closeSync(fd); } catch {} } }
