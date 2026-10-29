// Host capabilities some tests need. Without them those tests are skipped, with the reason; with them they run in full.
// - bubblewrap with unprivileged user namespaces: mina's workers (sandbox/sandbox.mjs innerArgs) and the outer layer;
// - a systemd user session: instance scopes (lib/instance-runtime.mjs, systemd-run --user --scope).
import { spawnSync } from 'node:child_process';
import { BWRAP_PATH } from '../sandbox/sandbox.mjs';

const works = (command, args) => {
  try { return spawnSync(command, args, { stdio: 'ignore', timeout: 20_000 }).status === 0; } catch { return false; }
};

export const SANDBOX = works(BWRAP_PATH, ['--unshare-user', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--proc', '/proc', '--', '/bin/true']);
export const SYSTEMD_USER = works('systemctl', ['--user', 'show-environment']) && works('/usr/bin/systemd-run', ['--version']);

export const needsSandbox = SANDBOX ? false : 'needs bubblewrap (bwrap) with unprivileged user namespaces';
export const needsSystemd = SYSTEMD_USER ? false : 'needs a systemd user session (systemctl --user)';
// The real launcher runs Pi in the sandbox, inside an instance scope.
export const needsLauncher = needsSandbox || needsSystemd;
