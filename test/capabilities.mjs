// Host capabilities some tests need. Without them those tests are skipped, with the reason; with them they run in full.
// - Linux: bubblewrap with unprivileged user namespaces: mina's workers (sandbox/sandbox.mjs innerArgs) and the outer layer;
//   a systemd user session: instance scopes (lib/instance-runtime.mjs, systemd-run --user --scope).
// - macOS: the native helper (npm run macos:helpers). Each test process then starts its own sandbox supervisor
//   (sandbox/macos/supervisor.mjs), so the tests of real workers run through the macOS backend: each call is a launchd job.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { BWRAP_PATH, MACOS } from '../sandbox/sandbox.mjs';
import { HELPER } from '../sandbox/macos/launchd.mjs';
import { ensureSupervisor, privateSupervisorHome } from '../sandbox/macos/client.mjs';

const works = (command, args) => {
  try { return spawnSync(command, args, { stdio: 'ignore', timeout: 20_000 }).status === 0; } catch { return false; }
};

// A supervisor for this test process (sandbox/macos/client.mjs ensureSupervisor). Writes are allowed below the temporary
// folder and the home folder (the tests make their projects there); the supervisor stops when this process exits.
async function testSupervisor() {
  try {
    await ensureSupervisor({ allowedWrites: [tmpdir(), homedir()] });
    process.env.MINA_WORKER_HOME ??= await privateSupervisorHome();
    return true;
  } catch { return false; }
}

export const SANDBOX = MACOS
  ? existsSync(HELPER) && await testSupervisor()
  : works(BWRAP_PATH, ['--unshare-user', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--proc', '/proc', '--', '/bin/true']);
export const SYSTEMD_USER = !MACOS && works('systemctl', ['--user', 'show-environment']) && works('/usr/bin/systemd-run', ['--version']);
// macOS: instances are launchd jobs in the user's gui domain (sandbox/macos/launchd.mjs).
export const LAUNCHD = MACOS && existsSync(HELPER) && works('/bin/launchctl', ['print', `gui/${process.getuid()}`]);

export const needsSandbox = SANDBOX ? false : MACOS ? 'needs the macOS helper (npm run macos:helpers)' : 'needs bubblewrap (bwrap) with unprivileged user namespaces';
export const needsSystemd = SYSTEMD_USER ? false : 'needs a systemd user session (systemctl --user)';
// The real launcher runs Pi in the sandbox, inside an instance scope (Linux) or an instance job (macOS).
export const needsLauncher = MACOS ? (SANDBOX && LAUNCHD ? false : 'needs the macOS helper and a launchd gui session') : needsSandbox || needsSystemd;
