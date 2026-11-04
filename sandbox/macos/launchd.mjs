// launchd jobs and resource coalitions for Mina on macOS (docs/macos.md). Each Mina instance and each call is a launchd
// job in the user's gui domain; launchd gives each job its own resource coalition, which no process can leave.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const HELPER = join(REPO, 'build', 'macos', 'mina-instance');
export const HELPER_SOURCE = join(REPO, 'sandbox', 'macos', 'mina-instance.c');
export const LAUNCHCTL = '/bin/launchctl';
const ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

export const domain = (uid = process.getuid()) => `gui/${uid}`;
export const instanceLabel = (id) => `com.mina.instance.${id}`;
export const callLabelPrefix = (id) => `com.mina.call.${id}.`;

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A property list for a job that runs once: no KeepAlive, so launchd never starts it again.
export function plist(label, programArguments, { stdout = '/dev/null', stderr = '/dev/null', environment = {} } = {}) {
  const env = Object.entries(environment).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${programArguments.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/>
<key>LaunchOnlyOnce</key><true/>
<key>ProcessType</key><string>Interactive</string>
<key>StandardInPath</key><string>/dev/null</string>
<key>StandardOutPath</key><string>${xml(stdout)}</string>
<key>StandardErrorPath</key><string>${xml(stderr)}</string>
${env ? `<key>EnvironmentVariables</key><dict>${env}</dict>` : ''}
</dict></plist>
`;
}

const run = (args) => new Promise((done) => execFile(LAUNCHCTL, args, { env: ENV, timeout: 30_000 }, (error, stdout, stderr) =>
  done({ ok: !error, stdout: String(stdout), stderr: String(stderr), code: error?.code ?? 0 })));

export const bootstrap = (plistFile, uid) => run(['bootstrap', domain(uid), plistFile]);
export const bootout = (label, uid) => run(['bootout', `${domain(uid)}/${label}`]);

// The labels of the jobs whose label starts with `prefix` (launchctl list prints PID, status, label).
export function jobsWithPrefix(prefix) {
  let out = '';
  try { out = execFileSync(LAUNCHCTL, ['list'], { encoding: 'utf8', env: ENV, timeout: 10_000 }); } catch { return []; }
  return out.split('\n').map((l) => l.trim().split(/\s+/)[2]).filter((l) => l?.startsWith(prefix));
}

export function bootSession() {
  return execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', env: ENV, timeout: 10_000 }).trim();
}

const helper = (args) => execFileSync(HELPER, args, { encoding: 'utf8', env: ENV, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });

export const coalitionOf = (pid) => Number(helper(['coalition', String(pid)]).trim()) || null;

// The members of these coalitions: [{ pid, ppid, start, footprint, cpuNs, zombie, stopped, comm }].
export function members(cids) {
  const ids = cids.filter(Boolean).map(String);
  if (!ids.length) return [];
  return helper(['members', ...ids]).split('\n').filter(Boolean).map((line) => {
    const [pid, ppid, start, footprint, cpuNs, zombie, stopped, ...comm] = line.split(' ');
    return { pid: Number(pid), ppid: Number(ppid), start: Number(start), footprint: Number(footprint), cpuNs: Number(cpuNs), zombie: zombie === '1',
      stopped: stopped === '1', comm: comm.join(' ') };
  });
}

// Stops every member of these coalitions; true when none remains.
export function sweep(cids) {
  const ids = cids.filter(Boolean).map(String);
  if (!ids.length) return true;
  try { helper(['sweep', ...ids]); return true; } catch { return false; }
}

export const helperBuilt = () => existsSync(HELPER);
