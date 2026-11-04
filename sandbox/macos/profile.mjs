// Seatbelt profiles for macOS (docs/macos.md, "Linux parity design"). Each profile replaces one bwrap layer of Linux:
// - workerProfile: a command or file worker (sandbox/sandbox.mjs innerArgs), deny by default, then the roots;
// - outerProfile: the Pi process (sandbox/sandbox.mjs outerArgs): reads everywhere, writes only to the roots of the launch;
// - serviceProfile: a literature MCP server or the PDF converter (scripts/mcp-sandbox.mjs, literature/supplements/pdf-sandbox.mjs).
// Paths go in as -D parameters, never into the text of the profile. In Seatbelt the last matching rule wins, so the
// denies come last. The rule set comes from scripts/macos-probe.py, which tested it on macOS 27.2.
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

const canonical = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const contains = (root, p) => root === p || p.startsWith(root === '/' ? '/' : `${root}/`);

const SYSCTLS = `(allow sysctl-read
  (sysctl-name "hw.activecpu") (sysctl-name "hw.busfrequency_compat") (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cacheconfig") (sysctl-name "hw.cachelinesize_compat") (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency_compat") (sysctl-name "hw.cputype") (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat") (sysctl-name "hw.l2cachesize_compat") (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu_max") (sysctl-name "hw.machine") (sysctl-name "hw.model") (sysctl-name "hw.memsize")
  (sysctl-name "hw.ncpu") (sysctl-name "hw.nperflevels") (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_") (sysctl-name "hw.packages") (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.pagesize") (sysctl-name "hw.physicalcpu") (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.logicalcpu") (sysctl-name "hw.cpufrequency") (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit") (sysctl-name "machdep.cpu.brand_string") (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.maxproc")
  (sysctl-name "kern.osproductversion") (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status") (sysctl-name "kern.osversion") (sysctl-name "kern.secure_kernel")
  (sysctl-name "kern.sysv.semmns") (sysctl-name "kern.usrstack64") (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype") (sysctl-name "vm.loadavg") (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "kern.proc.pgrp.") (sysctl-name-prefix "kern.proc.pid.") (sysctl-name-prefix "net.routetable."))
(allow sysctl-write (sysctl-name "kern.grade_cputype"))`;

const DEVICES = `(allow file-read* file-test-existence file-write-data (literal "/dev/null") (literal "/dev/zero"))
(allow file-read* file-test-existence (literal "/dev/autofs_nowait") (literal "/dev/random") (literal "/dev/urandom"))
(allow file-read-data file-test-existence file-write-data (subpath "/dev/fd"))
(allow file-read* file-test-existence file-write-data file-ioctl (literal "/dev/dtracehelper"))
(allow file-read* file-write* file-ioctl (literal "/dev/tty") (literal "/dev/ptmx"))
(allow file-read* file-write* file-ioctl (regex #"^/dev/ttys[0-9]+$"))
(allow file-read-metadata (literal "/dev") (regex #"^/dev/.*$"))
(allow pseudo-tty)`;

// Read-only system software: the macOS counterpart of /usr and the selected /etc files of a Linux worker. Homebrew and
// /usr/local are where macOS keeps the packages that a Linux distribution keeps in /usr.
const SYSTEM_READ = ['/usr', '/bin', '/sbin', '/System/Library', '/System/Volumes/Preboot', '/System/Cryptexes', '/Library/Apple',
  '/Library/Frameworks', '/Library/Filesystems/NetFSPlugins', '/Library/Preferences/Logging', '/Library/Developer/CommandLineTools',
  '/opt/homebrew', '/usr/local', '/private/var/db/timezone', '/private/etc/ssl', '/Applications/Xcode.app'];
const SYSTEM_READ_LITERALS = ['/', '/Library/Preferences/.GlobalPreferences.plist', '/private/etc/hosts', '/private/etc/resolv.conf',
  '/private/etc/services', '/private/etc/protocols', '/private/etc/shells', '/private/etc/localtime', '/private/etc/passwd',
  '/private/etc/master.passwd', '/private/var/select/sh', '/private/var/select/developer_dir', '/private/var/db/xcode_select_link',
  '/private/var/db/DarwinDirectory/local/recordStore.data'];
const SYSTEM_METADATA_LITERALS = ['/etc', '/tmp', '/var', '/private', '/private/var', '/private/etc', '/private/tmp', '/Users',
  '/Library', '/Library/Developer', '/opt', '/Applications', '/pkg', '/pkg/env', '/pkg/env/global', '/System/Volumes', '/System/Volumes/Data'];
const EXEC_MAP = ['/usr/lib', '/usr/libexec', '/System/Library', '/Library/Apple', '/System/Volumes/Preboot', '/System/Cryptexes',
  '/Library/Developer/CommandLineTools', '/opt/homebrew', '/usr/local', '/Applications/Xcode.app'];
const MACH_BASE = ['com.apple.system.opendirectoryd.libinfo', 'com.apple.system.opendirectoryd.membership',
  'com.apple.system.DirectoryService.libinfo_v1', 'com.apple.logd', 'com.apple.logd.events', 'com.apple.system.logger',
  'com.apple.system.notification_center', 'com.apple.diagnosticd', 'com.apple.analyticsd', 'com.apple.analyticsd.messagetracer',
  'com.apple.secinitd', 'com.apple.bsd.dirhelper', 'com.apple.PowerManagement.control'];
// Certificate trust for TLS, only for workers with a network level (DNS stays in the proxy: no mDNSResponder).
const MACH_NETWORK = ['com.apple.trustd', 'com.apple.trustd.agent', 'com.apple.TrustEvaluationAgent', 'com.apple.SecurityServer', 'com.apple.ocspd'];

// Apple tools that write to fixed temporary paths and ignore TMPDIR. Apple diff copies a pipe input (diff <(...)) to
// /private/tmp/diff.XXXX. Each exception is as narrow as the tool allows (scripts/macos-probe.py tested them).
const TMP_EXCEPTIONS = ['^/private/tmp/diff\\.[^/]+$'];

// Each symlink on the path to `p`. Seatbelt checks resolved paths, so the link itself needs a read rule of its own.
export function symlinksOn(p) {
  const out = [];
  let current = '/';
  for (const part of resolve(p).split('/').filter(Boolean)) {
    current = join(current, part);
    let st;
    try { st = lstatSync(current); } catch { break; }
    if (st.isSymbolicLink()) { out.push(current); current = canonical(current); }
  }
  return out;
}

const ancestors = (p) => { const out = []; let d = dirname(p); while (d !== dirname(d)) { out.push(d); d = dirname(d); } return out; };

// A profile under construction: rules with (param "Pn") for each path.
class Builder {
  constructor() { this.lines = ['(version 1)']; this.params = new Map(); }
  param(path) {
    const value = String(path);
    if (value.includes('\0') || value.includes('\n')) throw new Error('mina sandbox: a path contains a control character');
    for (const [key, v] of this.params) if (v === value) return `(param "${key}")`;
    const key = `P${this.params.size}`;
    this.params.set(key, value);
    return `(param "${key}")`;
  }
  subpaths(paths) { return paths.map((p) => `(subpath ${this.param(p)})`).join(' '); }
  literals(paths) { return paths.map((p) => `(literal ${this.param(p)})`).join(' '); }
  add(...lines) { this.lines.push(...lines.filter(Boolean)); }
  result() { return { text: `${this.lines.join('\n')}\n`, params: Object.fromEntries(this.params) }; }
}

// The argument list of sandbox-exec for a profile file: -D for each parameter.
export function sandboxExecArgs(profileFile, params, argv) {
  return [SANDBOX_EXEC, '-f', profileFile, ...Object.entries(params).flatMap(([k, v]) => ['-D', `${k}=${v}`]), '--', ...argv];
}

// The base of every sandbox profile: deny by default, the process rules, system software, devices, a few Mach services.
function base(b, { tools = [] } = {}) {
  b.add('(deny default (with no-log))',
    '(allow process-exec)', '(allow process-fork)',
    // As in a PID namespace: signals and process information only inside the same sandbox.
    '(allow signal (target same-sandbox))', '(allow process-info* (target same-sandbox))', '(allow mach-priv-task-port (target same-sandbox))',
    SYSCTLS, DEVICES,
    '(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))',
    '(allow ipc-posix-sem)',
    '(allow ipc-posix-shm-read-data ipc-posix-shm-write-create ipc-posix-shm-write-unlink (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))',
    '(allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center"))',
    '(allow system-mac-syscall (mac-policy-name "vnguard"))',
    '(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))',
    '(allow network-outbound (literal "/private/var/run/syslog"))',
    `(allow file-read* file-test-existence ${SYSTEM_READ.map((p) => `(subpath "${p}")`).join(' ')} ${SYSTEM_READ_LITERALS.map((p) => `(literal "${p}")`).join(' ')})`,
    `(allow file-read-metadata (subpath "/System") (subpath "/private/var/run") ${SYSTEM_METADATA_LITERALS.map((p) => `(literal "${p}")`).join(' ')})`,
    `(allow file-map-executable ${EXEC_MAP.map((p) => `(subpath "${p}")`).join(' ')})`,
    `(allow mach-lookup ${MACH_BASE.map((m) => `(global-name "${m}")`).join(' ')})`,
    '(allow system-fsctl (fsctl-command FSIOC_CAS_BSDFLAGS))');
  if (tools.length) b.add(`(allow file-read* file-map-executable ${b.subpaths(tools)})`);
}

// The denies of every sandbox profile, last: XPC services, other processes' information and arguments, the fcntl commands
// that change a file through a read-only descriptor, the launchd listener sockets (ssh-agent), the GPU, and AppleEvents.
function denies(b) {
  b.add('(deny mach-lookup (xpc-service-name-prefix ""))',
    '(deny process-info-pidinfo)', '(allow process-info-pidinfo (target same-sandbox))',
    '(deny sysctl-read (sysctl-name-regex #"procargs"))',
    '(deny system-fcntl (fcntl-command 80 110))',
    '(deny file-read* file-write* file-read-metadata (regex #"^/private/tmp/com\\.apple\\.launchd\\.[^/]+/Listeners$") (regex #"^/private/var/run/com\\.apple\\.launchd\\.[^/]+/Listeners$"))',
    '(deny lsopen)', '(deny appleevent-send)',
    '(deny iokit-open (iokit-user-client-class "AGXDeviceUserClient") (iokit-user-client-class "IOSurfaceRootUserClient"))');
}

// Metadata access to each parent folder of the roots (stat, realpath), without folder listings; and read access to each
// symlink on the way to a root, because Seatbelt checks the resolved path.
function reachable(b, roots) {
  const anc = [...new Set(roots.flatMap((r) => ancestors(r)))].filter((a) => a !== '/');
  if (anc.length) b.add(`(allow file-read-metadata ${b.literals(anc)})`);
  const links = [...new Set(roots.flatMap((r) => symlinksOn(r)))];
  if (links.length) b.add(`(allow file-read* ${b.literals(links)})`);
}

/**
 * The profile of a command or file worker. `roots` is the result of workerRoots (sandbox/sandbox.mjs). Also:
 * home (the instance home, writable), tmp (this call's TMPDIR, writable), outputs (retained outputs, read-only),
 * runtime (files of Mina's that the worker runs: the file worker and Node), egressPort (network levels open/packages),
 * frozen (the .mina/checks folders of the protected checks that run now: they and their parents cannot change).
 */
export function workerProfile(roots, { network = 'offline', egressPort = null, home, tmp, outputs = null, runtime = [], tools = [],
  frozen = null } = {}) {
  if (network !== 'offline' && !Number.isInteger(egressPort)) throw new Error(`mina sandbox: ${network} network needs the egress proxy`);
  const b = new Builder();
  base(b, { tools });
  const writes = [...roots.writes, ...[home, tmp].filter(Boolean).map(canonical)];
  const reads = [...roots.reads, ...(outputs ? [canonical(outputs)] : []), ...runtime.map(canonical)];
  reachable(b, [...writes, ...reads]);
  b.add(`(allow file-read* file-write* file-map-executable ${b.subpaths(writes)})`);
  if (reads.length) b.add(`(allow file-read* file-map-executable ${b.subpaths(reads)})`);
  b.add(`(allow file-read* file-write* ${TMP_EXCEPTIONS.map((r) => `(regex #"${r}")`).join(' ')})`);
  if (network !== 'offline') {
    b.add(`(allow network-outbound (remote ip "localhost:${egressPort}"))`,
      '(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))',
      `(allow mach-lookup ${MACH_NETWORK.map((m) => `(global-name "${m}")`).join(' ')})`);
  }
  denies(b);
  // Read-only parts of writable roots, the hidden credential paths, then what stays visible inside them.
  if (roots.readOnly?.length) b.add(`(deny file-write* ${b.subpaths(roots.readOnly)})`);
  if (outputs) b.add(`(deny file-write* ${b.subpaths([canonical(outputs)])})`);
  if (roots.hidden.length) b.add(`(deny file-read* file-write* ${b.subpaths(roots.hidden)})`);
  if (roots.exposed.length) b.add(`(allow file-read* file-map-executable ${b.subpaths(roots.exposed)})`, `(deny file-write* ${b.subpaths(roots.exposed)})`);
  if (runtime.length) b.add(`(allow file-read* file-map-executable ${b.subpaths(runtime.map(canonical))})`);
  // A writable root cannot be renamed or deleted: a worker could otherwise put another folder at its path.
  b.add(...writes.map((w) => `(deny file-write-unlink (require-all (literal ${b.param(w)}) (vnode-type DIRECTORY)))`));
  // While a protected check runs, its folder cannot change, and neither it nor a parent folder can be renamed.
  for (const checks of [frozen ?? []].flat().map(canonical)) {
    b.add(`(deny file-write* ${b.subpaths([checks])})`);
    b.add(...[dirname(checks), ...ancestors(dirname(checks))].filter((a) => writes.some((w) => contains(w, a)))
      .map((p) => `(deny file-write-unlink (require-all (literal ${b.param(p)}) (vnode-type DIRECTORY)))`));
  }
  return b.result();
}

/**
 * The profile of the Pi process, the outer layer of Linux: the root is readable (bwrap --ro-bind / /), writes go only to
 * the roots of the launch, the private TMPDIR and the terminal; /private/tmp and the user's temporary folder (the
 * private /tmp and runtime folder of Linux) are hidden, and only the named Unix sockets are reachable (the supervisor,
 * the broker). As on Linux, Pi has the host network and no clipboard (the terminal copies with OSC 52).
 */
export function outerProfile({ writable = [], tmp, sockets = [], hiddenDirs = [], readable = [], stdio = [] }) {
  const b = new Builder();
  b.add('(allow default)');
  b.add('(deny file-write*)');
  // As the outer bwrap layer: the private folders hide the host's, then the writable roots come back on top of them (a
  // project under the temporary folder stays visible).
  if (hiddenDirs.length) b.add(`(deny file-read* file-write* ${b.subpaths(hiddenDirs.map(canonical))})`);
  const writes = [...new Set([...writable, tmp].filter(Boolean).map(canonical))];
  reachable(b, writes);
  b.add(`(allow file-read* file-write* ${b.subpaths(writes)})`,
    '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/ptmx") (literal "/dev/dtracehelper") (regex #"^/dev/ttys[0-9]+$") (subpath "/dev/fd"))');
  if (readable.length) b.add(`(allow file-read* ${b.subpaths(readable.map(canonical))})`);
  // The files of the inherited standard input and output: their metadata only (fstat of the open descriptors).
  if (stdio.length) b.add(`(allow file-read-metadata ${b.literals(stdio)})`);
  // Name resolution goes through mDNSResponder's socket on macOS: Pi has DNS, as on Linux (the workers do not).
  b.add('(deny network-outbound (remote unix-socket))',
    `(allow network-outbound (literal "/private/var/run/syslog") (literal "/private/var/run/mDNSResponder")${sockets.length ? ` ${b.literals(sockets.map(canonical))}` : ''})`,
    '(deny mach-lookup (global-name "com.apple.pasteboard.1"))', '(deny lsopen)', '(deny appleevent-send)',
    // As the hidden user bus of Linux (no systemctl --user for Pi): Pi does not control launchd jobs (the instance,
    // the broker, other instances). The supervisor, outside this profile, starts and stops the calls.
    '(deny process-exec (literal "/bin/launchctl"))');
  return b.result();
}

/**
 * The profile of a literature MCP server or of the PDF converter: system software, `reads` read-only, `writes` writable,
 * and at most one network endpoint (the server's own egress proxy).
 */
export function serviceProfile({ reads = [], writes = [], egressPort = null }) {
  const b = new Builder();
  base(b);
  const w = writes.map(canonical), r = reads.map(canonical);
  reachable(b, [...w, ...r]);
  if (w.length) b.add(`(allow file-read* file-write* file-map-executable ${b.subpaths(w)})`);
  if (r.length) b.add(`(allow file-read* file-map-executable ${b.subpaths(r)})`);
  if (egressPort) {
    b.add(`(allow network-outbound (remote ip "localhost:${egressPort}"))`,
      '(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))',
      `(allow mach-lookup ${MACH_NETWORK.map((m) => `(global-name "${m}")`).join(' ')})`);
  }
  denies(b);
  b.add(...w.map((p) => `(deny file-write-unlink (require-all (literal ${b.param(p)}) (vnode-type DIRECTORY)))`));
  return b.result();
}

// The PATH of a worker: only folders that the worker can read, so that a command lookup never stops at a denied folder
// (Node's spawn fails with EPERM there, where a Linux worker gets ENOENT and tries the next folder).
export function visiblePath(path, visibleRoots) {
  const roots = [...SYSTEM_READ, ...visibleRoots].map(canonical);
  return String(path || '').split(':').filter((d) => d.startsWith('/') && existsSync(d) && roots.some((r) => contains(r, canonical(d)))).join(':')
    || '/usr/bin:/bin:/usr/sbin:/sbin';
}

// The real folders behind the installation of Node (a Homebrew Cellar, nvm, or a tarball), for the worker's runtime.
export function nodeRuntime(execPath = process.execPath) {
  const real = canonical(execPath);
  return [dirname(dirname(real))];
}

