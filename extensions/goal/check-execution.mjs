// Goal checks use the same positive-mount, positive-environment command boundary.
import { checkSnapshot } from './check-snapshot.mjs';
import { sandboxSettings } from '../sandbox/index.js';
import { bwrapAvailable, wrapCommand } from '../../sandbox/sandbox.mjs';

export function checkCommand(command, cwd, { env = process.env, available, frozen } = {}) {
  const box = sandboxSettings({ ...env, MINA_SANDBOX_PROJECT: env.MINA_SANDBOX_PROJECT || cwd || process.cwd() });
  if (!box.on) return command;
  if (!(available ?? bwrapAvailable())) return 'echo "mina sandbox: bubblewrap (bwrap) is not available, so the test is refused." >&2; exit 126';
  // No extension-owned package proxy is available here. Never fall back to open networking.
  const egressSocket = env === process.env ? globalThis[Symbol.for('mina:worker-egress')]?.() : null;
  const protectedChecksSnapshot = checkSnapshot(cwd ?? process.cwd(), frozen, env);
  return wrapCommand(command, { ...box, cwd: cwd ?? process.cwd(), env, protectedChecksSnapshot,
    network: egressSocket ? box.network : 'offline', egressSocket });
}
