#!/usr/bin/env python3
"""Mina macOS feasibility probe (step 0 of the macOS port; see docs/macos.md).

Run on the Mac, from a Terminal, as your normal user (no sudo):

    /usr/bin/python3 -I scripts/macos-probe.py            # about 2-4 minutes
    /usr/bin/python3 -I scripts/macos-probe.py --keep     # keep the work folder for inspection

It tests the risky assumptions of the macOS design before any port code is written:
a deny-default Seatbelt profile (sandbox-exec) for each tool call, network only through a
localhost proxy port, frozen protected checks (option B), and one launchd job (one kernel
coalition) per Mina instance.

What it touches:
- It creates one work folder, ~/.mina-probe-XXXX, and deletes it at the end (unless --keep).
- It starts short-lived local servers on 127.0.0.1 only, and a test launchd job
  (label mina.probe.XXXX) that it removes again. macOS can show a "Background Items Added"
  notification for this job. That notification is one of the things under test.
- The network tests fetch https://example.com through its own small proxy.
- The escape tests try `open`, `launchctl submit`, the pasteboard and the Keychain from inside
  the sandbox. They are expected to fail. If one succeeds, the probe undoes it (it removes the
  job, and quits Calculator if the probe started it). It never reads clipboard contents or
  Keychain items: it records only exit codes.
- The job tries to list ~/Documents, to find out whether a launchd job inherits Terminal's
  privacy permissions. macOS can show a permission prompt. Either answer is a useful result.

The report (mina-macos-probe-<time>.json in the current folder) masks your home folder,
user name and host name. Send that file back.
"""
import argparse
import ctypes
import ctypes.util
import hashlib
import json
import os
import platform
import shutil
import signal
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HOME = Path.home().resolve()
USER = os.environ.get('USER') or HOME.name
HOST = socket.gethostname()
UID = os.getuid()
SANDBOX_EXEC = '/usr/bin/sandbox-exec'
RESULTS = []


# ---------------------------------------------------------------------------- reporting

def mask(value):
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    for secret, token in ((str(HOME), '~'), (HOST, '<host>'), (USER, '<user>')):
        if secret and len(secret) > 2:
            text = text.replace(secret, token)
    return text


def record(group, test_id, outcome, detail='', expect=''):
    """outcome: PASS / FAIL (expectation not met) / INFO / SKIP / ERROR."""
    detail = mask(detail)
    if len(detail) > 900:
        detail = detail[:900] + ' ...'
    RESULTS.append({'group': group, 'id': test_id, 'outcome': outcome, 'expect': expect, 'detail': detail})
    print(f'  {outcome:5} {group}/{test_id}: {detail[:160]}', flush=True)


def check(group, test_id, condition, detail='', expect=''):
    record(group, test_id, 'PASS' if condition else 'FAIL', detail, expect)
    return condition


def guarded(group):
    def wrap(fn):
        def run(*args, **kwargs):
            print(f'\n== {group}', flush=True)
            try:
                return fn(*args, **kwargs)
            except Exception as error:  # a failing group must not stop the other groups
                record(group, 'exception', 'ERROR', f'{type(error).__name__}: {error}')
        return run
    return wrap


def run(argv, timeout=60, env=None, cwd=None, stdin=None):
    t0 = time.monotonic()
    try:
        p = subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=timeout, env=env, cwd=cwd)
        return {'rc': p.returncode, 'out': p.stdout, 'err': p.stderr, 'timeout': False, 'ms': (time.monotonic() - t0) * 1000}
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or '')
        err = e.stderr.decode() if isinstance(e.stderr, bytes) else (e.stderr or '')
        return {'rc': None, 'out': out, 'err': err, 'timeout': True, 'ms': (time.monotonic() - t0) * 1000}
    except OSError as e:
        return {'rc': None, 'out': '', 'err': f'{type(e).__name__}: {e}', 'timeout': False, 'ms': 0}


def brief(r):
    if r['timeout']:
        return f'TIMEOUT after {r["ms"]:.0f} ms; err={r["err"].strip()[-300:]!r}'
    return f'rc={r["rc"]} out={r["out"].strip()[-200:]!r} err={r["err"].strip()[-300:]!r}'


# ---------------------------------------------------------------------------- libproc helpers

LIBC = ctypes.CDLL(ctypes.util.find_library('c') or '/usr/lib/libSystem.B.dylib', use_errno=True)
PROC_PIDCOALITIONINFO = 20  # xnu-12377.121.6 bsd/sys/proc_info_private.h; struct: uint64 coalition_id[2] + 3 reserved


def coalition_of(pid):
    buf = (ctypes.c_uint64 * 5)()
    n = LIBC.proc_pidinfo(ctypes.c_int(pid), ctypes.c_int(PROC_PIDCOALITIONINFO), ctypes.c_uint64(0), buf, ctypes.c_int(ctypes.sizeof(buf)))
    return int(buf[0]) if n == ctypes.sizeof(buf) else None


def start_time(pid):
    """pbi_start_tvsec of struct proc_bsdinfo (PROC_PIDTBSDINFO = 3, 136 bytes, the field at offset 120)."""
    buf = ctypes.create_string_buffer(136)
    n = LIBC.proc_pidinfo(ctypes.c_int(pid), ctypes.c_int(3), ctypes.c_uint64(0), buf, ctypes.c_int(136))
    return int.from_bytes(buf.raw[120:128], 'little') if n == 136 else None


def all_pids():
    n = LIBC.proc_listallpids(None, 0)
    buf = (ctypes.c_int * (n + 256))()
    n = LIBC.proc_listallpids(buf, ctypes.sizeof(buf))
    return [buf[i] for i in range(max(n, 0)) if buf[i] > 0]


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


# ---------------------------------------------------------------------------- the Seatbelt profile (draft v0)
# Based on OpenAI Codex's seatbelt base policy and `:minimal` platform defaults (codex-rs/sandboxing, Apache-2.0)
# and eugene1g/agent-safehouse profiles/10-system-runtime.sb (Apache-2.0), with the macOS 27 adjustments from the
# research. Paths go in as -D parameters, never interpolated into the text; only the proxy port is a literal.

SYSCTLS = '''(allow sysctl-read
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
(allow sysctl-write (sysctl-name "kern.grade_cputype"))'''

DEVICES = '''(allow file-read* file-test-existence file-write-data (literal "/dev/null") (literal "/dev/zero"))
(allow file-read* file-test-existence (literal "/dev/autofs_nowait") (literal "/dev/random") (literal "/dev/urandom"))
(allow file-read-data file-test-existence file-write-data (subpath "/dev/fd"))
(allow file-read* file-test-existence file-write-data file-ioctl (literal "/dev/dtracehelper"))
(allow file-read* file-write* file-ioctl (literal "/dev/tty") (literal "/dev/ptmx"))
(allow file-read* file-write* file-ioctl (regex #"^/dev/ttys[0-9]+$"))
(allow file-read-metadata (literal "/dev") (regex #"^/dev/.*$"))
(allow pseudo-tty)'''

SYSTEM_READ = ['/usr', '/bin', '/sbin', '/System/Library', '/System/Volumes/Preboot', '/System/Cryptexes', '/Library/Apple',
               '/Library/Frameworks', '/Library/Filesystems/NetFSPlugins', '/Library/Preferences/Logging',
               '/Library/Developer/CommandLineTools', '/opt/homebrew', '/private/var/db/timezone', '/private/etc/ssl']
SYSTEM_READ_LITERALS = ['/', '/Library/Preferences/.GlobalPreferences.plist', '/private/etc/hosts', '/private/etc/resolv.conf',
                        '/private/etc/services', '/private/etc/protocols', '/private/etc/shells', '/private/etc/localtime',
                        '/private/etc/passwd', '/private/etc/master.passwd', '/private/var/select/sh',
                        '/private/var/select/developer_dir', '/private/var/db/xcode_select_link',
                        '/private/var/db/DarwinDirectory/local/recordStore.data']
SYSTEM_METADATA_LITERALS = ['/etc', '/tmp', '/var', '/private', '/private/var', '/private/etc', '/private/tmp', '/Users',
                            '/Library', '/Library/Developer', '/opt', '/Applications', '/pkg', '/pkg/env', '/pkg/env/global',
                            '/System/Volumes', '/System/Volumes/Data']
EXEC_MAP = ['/usr/lib', '/System/Library', '/Library/Apple', '/System/Volumes/Preboot', '/System/Cryptexes',
            '/Library/Developer/CommandLineTools', '/opt/homebrew']
MACH_BASE = ['com.apple.system.opendirectoryd.libinfo', 'com.apple.system.opendirectoryd.membership',
             'com.apple.system.DirectoryService.libinfo_v1', 'com.apple.logd', 'com.apple.logd.events',
             'com.apple.system.logger', 'com.apple.system.notification_center', 'com.apple.diagnosticd',
             'com.apple.analyticsd', 'com.apple.analyticsd.messagetracer', 'com.apple.secinitd', 'com.apple.bsd.dirhelper',
             'com.apple.PowerManagement.control']
MACH_NETWORK = ['com.apple.trustd', 'com.apple.trustd.agent', 'com.apple.TrustEvaluationAgent']

# Rules whose syntax is not confirmed on macOS 27. Each one is compiled alone first; the main profile uses it only if it compiles.
OPTIONAL_RULES = {
    'file-link': '(deny file-link (subpath "/nonexistent-mina-probe"))',
    'netsrc': '(allow network-outbound (control-name "com.apple.netsrc"))',
    'lsopen': '(deny lsopen)',
    'appleevent-send': '(deny appleevent-send)',
    'iokit-user-client-class': '(deny iokit-open (iokit-user-client-class "AGXDeviceUserClient"))',
}
# Rules taken from Codex/safehouse/Nix sources; compiled alone too, so a failure names the rule.
KNOWN_RULES = {
    'no-log': '(deny file-read* (literal "/nonexistent-mina-probe") (with no-log))',
    'process-info-pidinfo': '(deny process-info-pidinfo)',
    'procargs-regex': '(deny sysctl-read (sysctl-name-regex #"procargs"))',
    'xpc-service-name-prefix': '(deny mach-lookup (xpc-service-name-prefix ""))',
    'system-fcntl': '(deny system-fcntl (fcntl-command 80 110))',
    'unlink-dir-literal': '(deny file-write-unlink (require-all (literal "/nonexistent-mina-probe") (vnode-type DIRECTORY)))',
    'remote-ip-localhost-port': '(allow network-outbound (remote ip "localhost:3128"))',
    'path-ancestors': '(allow file-read-metadata (path-ancestors "/usr/bin"))',
    'param': '(allow file-read* (subpath (param "MINA_PROBE_P")))',
    'fsctl-cas-bsdflags': '(allow system-fsctl (fsctl-command FSIOC_CAS_BSDFLAGS))',
}


def symlinks_in(path):
    """Each symlink on the way to `path`. Seatbelt checks resolved paths, so a link itself needs its own read rule."""
    out, p = [], Path('/')
    for part in Path(path).parts[1:]:
        p = p / part
        if p.is_symlink():
            out.append(str(p))
            p = Path(os.path.realpath(p))
    return out


def ancestors(path):
    out = []
    p = Path(path)
    while p.parent != p:
        p = p.parent
        out.append(str(p))
    return out


class Profile:
    def __init__(self, name, text, params, path):
        self.name, self.text, self.params, self.path = name, text, params, path


class Ctx:
    def __init__(self, base):
        self.base = base
        self.project = base / 'project'
        self.data = base / 'data-ro'
        self.outside = base / 'outside'
        self.ihome = base / 'home'
        self.tmp = base / 'tmp'
        self.profiles = base / 'profiles'
        self.hidden = [self.project / 'secrets']
        self.checks = self.project / '.mina' / 'checks'
        self.tool_roots = []
        self.tool_links = []
        self.sdkroot = None
        self.tools = {}
        self.optional_ok = set()
        self.known_bad = set()
        self.proxy_port = None
        for d in (self.project, self.data, self.outside, self.ihome, self.tmp, self.profiles, self.checks, *self.hidden):
            d.mkdir(parents=True, exist_ok=True)

    def inner_path(self, extra_front=()):
        dirs = list(extra_front) + ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
        if Path('/opt/homebrew/bin').is_dir():
            dirs.append('/opt/homebrew/bin')
        for key in ('node', 'python'):
            if self.tools.get(key):
                dirs.append(str(Path(self.tools[key]).parent))
        seen = []
        for d in dirs:
            if d not in seen:
                seen.append(d)
        return ':'.join(seen)

    def env(self, network=False, extra=None):
        e = {'PATH': self.inner_path(), 'HOME': str(self.ihome), 'TMPDIR': f'{self.tmp}/', 'TMPPREFIX': f'{self.tmp}/zsh',
             'USER': USER, 'LOGNAME': USER, 'SHELL': '/bin/bash', 'TERM': 'dumb', 'LANG': os.environ.get('LANG', 'en_US.UTF-8'),
             'GIT_CONFIG_NOSYSTEM': '1', 'SWIFTPM_DISABLE_SANDBOX': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
        if self.sdkroot:
            e['SDKROOT'] = self.sdkroot  # xcrun cannot write its cache in the sandbox; the controller resolves the SDK
        if network and self.proxy_port:
            url = f'http://127.0.0.1:{self.proxy_port}'
            e.update({'HTTPS_PROXY': url, 'https_proxy': url, 'HTTP_PROXY': url, 'http_proxy': url, 'NODE_USE_ENV_PROXY': '1',
                      'NO_PROXY': '', 'no_proxy': ''})
        if extra:
            e.update(extra)
        return e

    def build(self, name, network=False, freeze=False, log=False, tmp_compat=(), var_folders=None):
        params = {'PROJECT': str(self.project), 'DATA_RO': str(self.data), 'IHOME': str(self.ihome), 'TMP': str(self.tmp)}
        rw = ['PROJECT', 'IHOME', 'TMP']
        for i, root in enumerate(self.tool_roots):
            params[f'TOOL_{i}'] = root
        anc = sorted({a for p in (self.project, self.data, self.ihome, self.tmp, *self.tool_roots) for a in ancestors(p)})
        for i, a in enumerate(anc):
            params[f'ANC_{i}'] = a
        for i, link in enumerate(self.tool_links):
            params[f'LINK_{i}'] = link
        for i, h in enumerate(self.hidden):
            params[f'HIDDEN_{i}'] = str(h)
        q = lambda key: f'(param "{key}")'
        bad = self.known_bad
        lines = ['(version 1)', '(deny default)' if log or 'no-log' in bad else '(deny default (with no-log))',
                 '(allow process-exec)', '(allow process-fork)', '(allow signal (target same-sandbox))',
                 '(allow process-info* (target same-sandbox))', '(allow mach-priv-task-port (target same-sandbox))',
                 SYSCTLS, DEVICES,
                 '(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))',
                 '(allow ipc-posix-sem)',
                 '(allow ipc-posix-shm-read-data ipc-posix-shm-write-create ipc-posix-shm-write-unlink (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))',
                 '(allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center"))',
                 '(allow system-mac-syscall (mac-policy-name "vnguard"))',
                 '(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))',
                 '(allow network-outbound (literal "/private/var/run/syslog"))',
                 '(allow file-read* file-test-existence ' + ' '.join(f'(subpath "{p}")' for p in SYSTEM_READ)
                 + ' ' + ' '.join(f'(literal "{p}")' for p in SYSTEM_READ_LITERALS) + ')',
                 '(allow file-read-metadata (subpath "/System") (subpath "/private/var/run") '
                 + ' '.join(f'(literal "{p}")' for p in SYSTEM_METADATA_LITERALS) + ')',
                 '(allow file-map-executable ' + ' '.join(f'(subpath "{p}")' for p in EXEC_MAP) + ')',
                 '(allow mach-lookup ' + ' '.join(f'(global-name "{m}")' for m in MACH_BASE) + ')']
        if Path('/Applications/Xcode.app').exists():
            lines.append('(allow file-read* file-map-executable (subpath "/Applications/Xcode.app"))')
        if anc:
            lines.append('(allow file-read-metadata ' + ' '.join(f'(literal {q(f"ANC_{i}")})' for i in range(len(anc))) + ')')
        tools = ' '.join(f'(subpath {q(f"TOOL_{i}")})' for i in range(len(self.tool_roots)))
        if tools:
            lines.append(f'(allow file-read* file-map-executable {tools})')
        if self.tool_links:
            lines.append('(allow file-read* ' + ' '.join(f'(literal {q(f"LINK_{i}")})' for i in range(len(self.tool_links))) + ')')
        lines.append('(allow file-read* file-write* file-map-executable ' + ' '.join(f'(subpath {q(k)})' for k in rw) + ')')
        lines.append(f'(allow file-read* file-map-executable (subpath {q("DATA_RO")}))')
        compat = {'sh-thd': '(regex #"^/private/var/tmp/sh-thd")', 'zsh': '(regex #"^/private/tmp/zsh")', 'diff': '(regex #"^/private/tmp/diff\\.")'}
        if tmp_compat:
            lines.append('(allow file-read* file-write* ' + ' '.join(compat[k] for k in tmp_compat) + ')')
        if var_folders:
            params['DUT'] = var_folders
            lines.append(f'(allow file-read* file-write* (subpath {q("DUT")}))')
        if network and self.proxy_port:
            lines.append(f'(allow network-outbound (remote ip "localhost:{self.proxy_port}"))')
            lines.append('(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))')
            lines.append('(allow mach-lookup ' + ' '.join(f'(global-name "{m}")' for m in MACH_NETWORK) + ')')
            if 'netsrc' in self.optional_ok:
                lines.append(OPTIONAL_RULES['netsrc'])
        if 'fsctl-cas-bsdflags' not in bad:
            lines.append('(allow system-fsctl (fsctl-command FSIOC_CAS_BSDFLAGS))')
        # Denies come last: in Seatbelt the last matching rule wins.
        unlink_ok = 'unlink-dir-literal' not in bad
        if unlink_ok:
            for k in rw:
                lines.append(f'(deny file-write-unlink (require-all (literal {q(k)}) (vnode-type DIRECTORY)))')
        if 'xpc-service-name-prefix' not in bad:
            lines.append('(deny mach-lookup (xpc-service-name-prefix ""))')
        if 'process-info-pidinfo' not in bad:
            lines += ['(deny process-info-pidinfo)', '(allow process-info-pidinfo (target same-sandbox))']
        if 'procargs-regex' not in bad:
            lines.append('(deny sysctl-read (sysctl-name-regex #"procargs"))')
        if 'system-fcntl' not in bad:
            lines.append('(deny system-fcntl (fcntl-command 80 110))')
        lines += ['(deny file-read* file-write* file-read-metadata (regex #"^/private/tmp/com\\.apple\\.launchd\\.[^/]+/Listeners$") '
                  '(regex #"^/private/var/run/com\\.apple\\.launchd\\.[^/]+/Listeners$"))']
        for opt in ('lsopen', 'appleevent-send', 'iokit-user-client-class'):
            if opt in self.optional_ok:
                lines.append(OPTIONAL_RULES[opt].replace('(deny iokit-open (iokit-user-client-class "AGXDeviceUserClient"))',
                             '(deny iokit-open (iokit-user-client-class "AGXDeviceUserClient") (iokit-user-client-class "IOSurfaceRootUserClient"))'))
        for i in range(len(self.hidden)):
            lines.append(f'(deny file-read* file-write* (literal {q(f"HIDDEN_{i}")}) (subpath {q(f"HIDDEN_{i}")}))')
        if freeze:
            params['CHECKS'] = str(self.checks)
            params['MINADIR'] = str(self.checks.parent)
            lines.append(f'(deny file-write* (literal {q("CHECKS")}) (subpath {q("CHECKS")}))')
            if unlink_ok:
                lines.append(f'(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal {q("MINADIR")})))')
            if 'file-link' in self.optional_ok:
                lines.append(f'(deny file-link (subpath {q("CHECKS")}))')
        text = '\n'.join(lines) + '\n'
        path = self.profiles / f'{name}.sb'
        path.write_text(text)
        os.chmod(path, 0o600)
        return Profile(name, text, params, path)


def sb(profile, argv, ctx, timeout=60, network=False, cwd=None, extra_env=None, stdin=None):
    cmd = [SANDBOX_EXEC, '-f', str(profile.path)] + [f'-D{k}={v}' for k, v in profile.params.items()] + ['--'] + list(argv)
    return run(cmd, timeout=timeout, env=ctx.env(network, extra_env), cwd=str(cwd or ctx.project), stdin=stdin)


def denied(r):
    """The command failed, and not by a timeout."""
    return (not r['timeout']) and r['rc'] not in (0, None)


# ---------------------------------------------------------------------------- local servers (127.0.0.1 only)

ALLOWED_CONNECT = {('example.com', 443), ('www.example.com', 443)}


class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        data = b''
        while b'\r\n\r\n' not in data and len(data) < 8192:
            chunk = self.request.recv(4096)
            if not chunk:
                return
            data += chunk
        line = data.split(b'\r\n', 1)[0].decode('latin-1').split()
        if len(line) < 2 or line[0] != 'CONNECT':
            self.request.sendall(b'HTTP/1.1 405 Only CONNECT\r\n\r\n')
            return
        host, _, port = line[1].rpartition(':')
        if (host, int(port or 0)) not in ALLOWED_CONNECT:
            self.request.sendall(b'HTTP/1.1 403 Forbidden\r\n\r\n')
            return
        upstream = socket.create_connection((host, int(port)), timeout=10)
        self.request.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
        pair = [(self.request, upstream), (upstream, self.request)]

        def pump(src, dst):
            try:
                while True:
                    b = src.recv(65536)
                    if not b:
                        break
                    dst.sendall(b)
            except OSError:
                pass
            finally:
                for s in (src, dst):
                    try:
                        s.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
        threads = [threading.Thread(target=pump, args=p, daemon=True) for p in pair]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        upstream.close()


class Quiet(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.sendall(b'host-service\n')


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def start_server(handler, host='127.0.0.1'):
    srv = Server((host, 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ---------------------------------------------------------------------------- groups

@guarded('environment')
def environment(ctx):
    sw = run(['/usr/bin/sw_vers'])
    record('environment', 'sw_vers', 'INFO', sw['out'].replace('\n', '; '))
    ver = run(['/usr/bin/sw_vers', '-productVersion'])['out'].strip()
    parts = [int(x) for x in ver.split('.')[:2] if x.isdigit()] + [0, 0]
    check('environment', 'macos-27.2-or-later', (parts[0], parts[1]) >= (27, 2), ver, '27.2+ (fixes Sandbox escapes)')
    check('environment', 'arm64', platform.machine() == 'arm64', platform.machine(), 'arm64')
    record('environment', 'model', 'INFO', run(['/usr/sbin/sysctl', '-n', 'hw.model', 'machdep.cpu.brand_string'])['out'].replace('\n', '; '))
    record('environment', 'rosetta-running', 'INFO', 'oahd running' if run(['/usr/bin/pgrep', '-q', 'oahd'])['rc'] == 0 else 'oahd not running')
    if not check('environment', 'sandbox-exec-present', Path(SANDBOX_EXEC).exists(), SANDBOX_EXEC):
        return False
    cs = run(['/usr/bin/codesign', '-dv', SANDBOX_EXEC])
    ident = [l for l in cs['err'].splitlines() if l.startswith(('Identifier=', 'Authority=', 'Platform', 'TeamIdentifier'))]
    record('environment', 'sandbox-exec-signature', 'INFO', '; '.join(ident) or brief(cs))
    record('environment', 'xcode-select', 'INFO', brief(run(['/usr/bin/xcode-select', '-p'])))
    record('environment', 'bash', 'INFO', run(['/bin/bash', '--version'])['out'].splitlines()[0])
    record('environment', 'pkg-dir', 'INFO', f'/pkg exists={Path("/pkg").exists()}; /pkg/env/global exists={Path("/pkg/env/global").exists()}')
    record('environment', 'login-PATH', 'INFO', os.environ.get('PATH', ''))
    node = shutil.which('node')
    uv = shutil.which('uv') or next((str(p) for p in (HOME / '.local/bin/uv', HOME / '.cargo/bin/uv', Path('/opt/homebrew/bin/uv')) if p.exists()), None)
    py = None
    if uv:
        r = run([uv, 'python', 'find'], timeout=30)
        py = r['out'].strip() or None
    py = py or sys.executable
    for key, path in (('node', node), ('python', py), ('git', '/usr/bin/git')):
        if not path:
            record('environment', f'{key}-found', 'SKIP', 'not on PATH')
            continue
        real = os.path.realpath(path)
        ctx.tools[key] = path
        arch = run(['/usr/bin/file', '-b', real])['out'].strip()
        version = run([path, '--version'], timeout=20)
        record('environment', f'{key}-found', 'INFO', f'{path} -> {real}; {arch}; {(version["out"] or version["err"]).strip()[:80]}')
        check('environment', f'{key}-arm64', 'x86_64' not in arch or 'arm64' in arch, arch, 'arm64 (no Rosetta)')
        if key in ('node', 'python'):
            prefix = str(Path(real).parent.parent)
            if prefix not in ('/usr', '/') and not prefix.startswith(('/System', '/Library/Developer')):
                ctx.tool_roots.append(prefix)
                ctx.tool_links += [l for l in symlinks_in(path) if l not in ctx.tool_links]
    clang = run(['/usr/bin/xcrun', '-f', 'clang'], timeout=30)
    ctx.tools['clang'] = clang['out'].strip() if clang['rc'] == 0 else None
    sdk = run(['/usr/bin/xcrun', '--show-sdk-path'], timeout=30)
    ctx.sdkroot = sdk['out'].strip() if sdk['rc'] == 0 else None
    swiftc = run(['/usr/bin/xcrun', '-f', 'swiftc'], timeout=30)
    ctx.tools['swiftc'] = swiftc['out'].strip() if swiftc['rc'] == 0 else None
    record('environment', 'clang/swiftc', 'INFO', f'clang={ctx.tools["clang"]}; swiftc={ctx.tools["swiftc"]}')
    return True


@guarded('syntax')
def syntax(ctx):
    r = run([SANDBOX_EXEC, '-p', '(version 1)(allow default)', '/usr/bin/true'])
    if not check('syntax', 'sandbox-exec-runs', r['rc'] == 0, brief(r), 'a trivial profile runs /usr/bin/true'):
        return False
    for group, rules in (('known', KNOWN_RULES), ('optional', OPTIONAL_RULES)):
        for name, rule in rules.items():
            r = run([SANDBOX_EXEC, '-DMINA_PROBE_P=/tmp', '-p', f'(version 1)(allow default){rule}', '/usr/bin/true'])
            ok = r['rc'] == 0
            if group == 'optional':
                if ok:
                    ctx.optional_ok.add(name)
                record('syntax', f'{group}:{name}', 'INFO', 'compiles' if ok else f'does not compile: {r["err"].strip()[:200]}')
            else:
                if not ok:
                    ctx.known_bad.add(name)  # the main profile leaves this rule out
                check('syntax', f'{group}:{name}', ok, 'compiles' if ok else r['err'].strip()[:300], 'compiles')
    return True


@guarded('profile')
def profile_compiles(ctx):
    p = ctx.build('base')
    r = sb(p, ['/usr/bin/true'], ctx)
    if not check('profile', 'base-profile-runs-true', r['rc'] == 0, brief(r), 'the main draft profile compiles and runs /usr/bin/true'):
        record('profile', 'base-profile-text', 'INFO', p.text[-800:])
        return None
    return p


@guarded('toolchain')
def toolchain(ctx, base):
    (ctx.project / 'hello.c').write_text('#include <stdio.h>\nint main(void){puts("hello");return 0;}\n')
    tests = [
        ('echo', ['/bin/echo', 'ok']),
        ('sh', ['/bin/sh', '-c', 'echo $((40+2))']),
        ('bash-heredoc', ['/bin/bash', '--noprofile', '--norc', '-c', 'cat <<EOF\nheredoc-ok\nEOF']),
        ('zsh-heredoc', ['/bin/zsh', '-f', '-c', 'cat <<EOF\nheredoc-ok\nEOF']),
        ('bash-process-substitution', ['/bin/bash', '--noprofile', '--norc', '-c', 'diff <(echo a) <(echo b) >/dev/null; test $? -eq 1']),
        ('diff-files', ['/bin/sh', '-c', 'echo a > a.txt; echo b > b.txt; /usr/bin/diff a.txt b.txt >/dev/null; test $? -eq 1']),
        ('pwd-P', ['/bin/sh', '-c', 'pwd -P']),
        ('git-init-commit', ['/bin/sh', '-c', 'git init -q . && git add hello.c && git -c user.name=p -c user.email=p@p commit -qm init && git status --short | head -3']),
        ('date-id', ['/bin/sh', '-c', 'date >/dev/null && id -un']),
    ]
    if ctx.tools.get('node'):
        tests.append(('node', [ctx.tools['node'], '-e', 'console.log(process.version, process.arch)']))
        tests.append(('node-spawn-git', [ctx.tools['node'], '-e', 'const r=require("child_process").spawnSync("git",["--version"]);console.log(r.error?String(r.error):r.stdout.toString().trim())']))
    if ctx.tools.get('python'):
        tests.append(('python', [ctx.tools['python'], '-I', '-c', 'import ssl,sqlite3,json,multiprocessing,time,pwd,os;time.localtime();pwd.getpwuid(os.getuid());print(ssl.OPENSSL_VERSION)']))
        tests.append(('python-venv', ['/bin/sh', '-c', f'"{ctx.tools["python"]}" -I -m venv .venv && .venv/bin/python -c "import sys;print(sys.prefix)"']))
        tests.append(('python-multiprocessing', [ctx.tools['python'], '-I', '-c', 'from concurrent.futures import ProcessPoolExecutor as P\nwith P(2) as p: print(sum(p.map(abs,[-1,-2])))']))
    if ctx.tools.get('clang'):
        tests.append(('xcrun-clang', ['/bin/sh', '-c', f'/usr/bin/xcrun clang hello.c -o "$TMPDIR/hello" && "$TMPDIR/hello"']))
        tests.append(('clang-direct', ['/bin/sh', '-c', f'"{ctx.tools["clang"]}" hello.c -o "$TMPDIR/hello2" && "$TMPDIR/hello2"']))
        tests.append(('make', ['/bin/sh', '-c', 'printf "all:\\n\\t@echo make-ok\\n" > Makefile && /usr/bin/make']))
    if Path('/opt/homebrew/bin/brew').exists():
        tests.append(('brew-version', ['/opt/homebrew/bin/brew', '--version']))
    failed = []
    for name, argv in tests:
        r = sb(base, argv, ctx, timeout=120)
        if not check('toolchain', name, r['rc'] == 0, brief(r), 'exit 0 under the base profile'):
            failed.append((name, argv))
    # Diagnose failures: does a temp-folder exception fix them?
    if failed:
        dut = run(['/usr/bin/getconf', 'DARWIN_USER_TEMP_DIR'])['out'].strip()
        variants = [('tmp-diff-only', ctx.build('tmp-diff', tmp_compat=('diff',))),
                    ('tmp-compat', ctx.build('tmp-compat', tmp_compat=('sh-thd', 'zsh', 'diff'))),
                    ('var-folders', ctx.build('var-folders', var_folders=os.path.realpath(dut) if dut else None)),
                    ('logging', ctx.build('logging', log=True))]
        for name, argv in failed:
            for vname, prof in variants:
                r = sb(prof, argv, ctx, timeout=120)
                record('toolchain', f'{name}@{vname}', 'INFO', ('fixed: ' if r['rc'] == 0 else 'still fails: ') + brief(r))
        record('toolchain', 'hint', 'INFO', 'For denials, run: log show --last 5m --style compact --predicate \'eventMessage CONTAINS "Sandbox:"\'')


@guarded('path-lookup')
def path_lookup(ctx, base):
    node = ctx.tools.get('node')
    if not node:
        record('path-lookup', 'node', 'SKIP', 'no node')
        return
    code = 'const r=require("child_process").spawnSync("git",["--version"]);console.log(r.error?r.error.code:"ok")'
    for name, front, expect in (('denied-dir-first', [str(ctx.outside)], 'EPERM expected (libuv stops at a denied PATH dir)'),
                                ('pkg-env-first', ['/pkg/env/global/bin'], 'ok expected (metadata of /pkg/env/global allowed)'),
                                ('stripped', [], 'ok expected')):
        r = sb(base, [node, '-e', code], ctx, extra_env={'PATH': ctx.inner_path(front)})
        record('path-lookup', name, 'INFO', f'{expect}; got {r["out"].strip() or brief(r)}')
    r = sb(base, [node, '-e', code], ctx, extra_env={'PATH': os.environ.get('PATH', '')})
    record('path-lookup', 'real-login-PATH', 'INFO', f'got {r["out"].strip() or brief(r)}')


@guarded('hang')
def hang(ctx):
    for log in (False, True):
        prof = ctx.build(f'hang-{"log" if log else "nolog"}', log=log)
        hangs, fails, times = 0, 0, []
        for _ in range(20):
            r = sb(prof, ['/bin/sh', '-c', 'date >/dev/null; id -un >/dev/null; /bin/ls / >/dev/null'], ctx, timeout=10)
            hangs += r['timeout']
            fails += (not r['timeout']) and r['rc'] != 0
            times.append(r['ms'])
        times.sort()
        check('hang', f'cold-start-x20-{"reporting" if log else "no-log"}', hangs == 0,
              f'hangs={hangs} failures={fails} median={times[len(times) // 2]:.0f} ms max={times[-1]:.0f} ms', 'no hang (FB25399545)')


@guarded('filesystem')
def filesystem(ctx, base):
    (ctx.project / 'in.txt').write_text('project\n')
    (ctx.data / 'data.txt').write_text('data\n')
    (ctx.outside / 'secret.txt').write_text('outside\n')
    (ctx.hidden[0] / 'key.txt').write_text('hidden\n')
    try:
        os.symlink(ctx.outside / 'secret.txt', ctx.project / 'link-out')
    except FileExistsError:
        pass
    sh = lambda cmd: sb(base, ['/bin/sh', '-c', cmd], ctx, timeout=20)
    # Output goes to /dev/null: if a read is not denied, its contents must not reach the report.
    cases = [
        ('read-project', 'cat in.txt >/dev/null', True), ('write-project', 'echo x > new.txt', True),
        ('read-data-ro', f'cat "{ctx.data}/data.txt" >/dev/null', True), ('write-data-ro', f'echo x > "{ctx.data}/w.txt"', False),
        ('read-outside', f'cat "{ctx.outside}/secret.txt" >/dev/null', False), ('write-outside', f'echo x > "{ctx.outside}/w.txt"', False),
        ('read-via-symlink', 'cat link-out >/dev/null', False), ('read-hidden-in-project', 'cat secrets/key.txt >/dev/null', False),
        ('list-hidden-in-project', 'ls secrets >/dev/null', False), ('write-hidden-in-project', 'echo x > secrets/w.txt', False),
        ('list-real-home', f'ls "{HOME}" >/dev/null', False), ('list-ssh', f'ls "{HOME}/.ssh" >/dev/null', False),
        ('read-pi-auth', f'cat "{HOME}/.pi/agent/auth.json" >/dev/null', False),
        ('list-documents', f'ls "{HOME}/Documents" >/dev/null', False), ('list-var-folders', 'ls /private/var/folders >/dev/null', False),
        ('write-private-tmp', 'echo x > /private/tmp/mina-probe-w', False), ('list-private-tmp', 'ls /private/tmp >/dev/null', False),
        ('write-instance-home', 'echo x > "$HOME/h.txt"', True), ('write-tmpdir', 'echo x > "$TMPDIR/t.txt"', True),
        ('write-launchagents', f'touch "{HOME}/Library/LaunchAgents/mina-probe-escape.plist"', False),
        ('read-keychains-dir', f'ls "{HOME}/Library/Keychains" >/dev/null', False),
        ('read-mail', f'ls "{HOME}/Library/Mail" >/dev/null', False),
        ('rename-project-root', f'mv "{ctx.project}" "{ctx.project}.moved"', False),
        ('hardlink-data-into-project', f'ln "{ctx.data}/data.txt" hl-data && echo x >> hl-data', False),
    ]
    for name, cmd, allowed in cases:
        r = sh(cmd)
        check('filesystem', name, (r['rc'] == 0) if allowed else denied(r), brief(r), 'allowed' if allowed else 'denied')
    for stray in (HOME / 'Library/LaunchAgents/mina-probe-escape.plist', Path('/private/tmp/mina-probe-w')):
        if stray.exists():
            stray.unlink()
    if Path(f'{ctx.project}.moved').exists():
        os.rename(f'{ctx.project}.moved', ctx.project)
    record('filesystem', 'data-ro-after-hardlink', 'INFO', (ctx.data / 'data.txt').read_text().strip())


@guarded('network')
def network(ctx):
    proxy = start_server(Relay)
    other = start_server(Quiet)
    ctx.proxy_port = proxy.server_address[1]
    other_port = other.server_address[1]
    prof = ctx.build('network', network=True)
    py = ctx.tools.get('python')
    try:
        if py:
            code = ('import socket,json,sys\nres={}\n'
                    'def t(n,fam,addr):\n'
                    '  s=socket.socket(fam,socket.SOCK_STREAM);s.settimeout(4)\n'
                    '  try: s.connect(addr);res[n]="connected"\n'
                    '  except Exception as e: res[n]=type(e).__name__+":"+str(e)[:60]\n'
                    '  finally: s.close()\n'
                    f't("proxy-v4",socket.AF_INET,("127.0.0.1",{ctx.proxy_port}))\n'
                    f't("proxy-mapped-v6",socket.AF_INET6,("::ffff:127.0.0.1",{ctx.proxy_port}))\n'
                    f't("other-loopback-port",socket.AF_INET,("127.0.0.1",{other_port}))\n'
                    't("internet-ip",socket.AF_INET,("1.1.1.1",443))\n'
                    't("lan-gateway-guess",socket.AF_INET,("192.168.1.1",80))\n'
                    'try: socket.getaddrinfo("example.com",443);res["dns"]="resolved"\n'
                    'except Exception as e: res["dns"]=type(e).__name__\n'
                    'try:\n  s=socket.socket();s.bind(("127.0.0.1",0));s.listen(1);res["listen"]="listening"\n'
                    'except Exception as e: res["listen"]=type(e).__name__\n'
                    'print(json.dumps(res))')
            r = sb(prof, [py, '-I', '-c', code], ctx, network=True, timeout=60)
            try:
                res = json.loads(r['out'].strip().splitlines()[-1])
            except Exception:
                record('network', 'socket-tests', 'ERROR', brief(r))
                res = {}
            # A connect that Seatbelt denies fails at once with PermissionError; a timeout proves nothing.
            for key, want in (('proxy-v4', 'allowed'), ('other-loopback-port', 'PermissionError'), ('internet-ip', 'PermissionError'),
                              ('lan-gateway-guess', 'PermissionError'), ('dns', 'failure'), ('listen', 'PermissionError')):
                if key in res:
                    got = res[key]
                    ok = (got in ('connected', 'resolved', 'listening')) if want == 'allowed' else \
                        (got not in ('connected', 'resolved', 'listening')) if want == 'failure' else got.startswith('PermissionError')
                    check('network', key, ok, got, want)
            if 'proxy-mapped-v6' in res:
                record('network', 'proxy-mapped-v6', 'INFO', f'{res["proxy-mapped-v6"]} (srt#494: may not match localhost)')
        curl = sb(prof, ['/usr/bin/curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '20', 'https://example.com/'], ctx, network=True)
        check('network', 'https-curl-via-proxy', curl['out'].strip() == '200', brief(curl), 'HTTP 200')
        blocked = sb(prof, ['/usr/bin/curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', 'https://pypi.org/'], ctx, network=True)
        check('network', 'proxy-refuses-unlisted-host', blocked['rc'] != 0, brief(blocked), 'refused by the proxy')
        direct = sb(prof, ['/usr/bin/curl', '-sS', '--noproxy', '*', '--max-time', '10', '-o', '/dev/null', 'https://example.com/'], ctx, network=True)
        check('network', 'https-curl-bypassing-proxy', denied(direct), brief(direct), 'denied')
        if py:
            r = sb(prof, [py, '-I', '-c', 'import urllib.request;print(urllib.request.urlopen("https://example.com/",timeout=20).status)'], ctx, network=True)
            check('network', 'https-python-via-proxy', r['out'].strip() == '200', brief(r), 'HTTP 200 (TLS trust store under the sandbox)')
        if ctx.tools.get('node'):
            r = sb(prof, [ctx.tools['node'], '-e', 'fetch("https://example.com/").then(r=>console.log(r.status),e=>{console.log(String(e.cause||e));process.exit(1)})'], ctx, network=True)
            check('network', 'https-node-via-proxy', r['out'].strip() == '200', brief(r), 'HTTP 200 (NODE_USE_ENV_PROXY needs Node 24+)')
        off = ctx.build('offline')
        r = sb(off, ['/usr/bin/curl', '-sS', '--max-time', '10', '-o', '/dev/null', 'https://example.com/'], ctx, network=True)
        check('network', 'offline-profile-blocks-proxy', denied(r), brief(r), 'denied')
    finally:
        proxy.shutdown()
        other.shutdown()


@guarded('processes')
def processes(ctx, base):
    victim = subprocess.Popen(['/bin/sleep', '300'])
    try:
        r = sb(base, ['/bin/sh', '-c', f'kill -0 {victim.pid}'], ctx)
        check('processes', 'signal-outside-process', denied(r) and victim.poll() is None, brief(r), 'denied')
        r = sb(base, ['/bin/sh', '-c', f'kill -0 {os.getpid()}'], ctx)
        check('processes', 'signal-probe-itself', denied(r), brief(r), 'denied')
        py = ctx.tools.get('python')
        if py:
            code = ('import ctypes,json\nL=ctypes.CDLL("/usr/lib/libSystem.B.dylib",use_errno=True)\n'
                    f'pid={victim.pid}\nres={{}}\n'
                    'mib=(ctypes.c_int*3)(1,49,pid);size=ctypes.c_size_t(262144);buf=ctypes.create_string_buffer(262144)\n'
                    'rc=L.sysctl(mib,3,buf,ctypes.byref(size),None,0);res["procargs2"]="read %d bytes"%size.value if rc==0 else "errno %d"%ctypes.get_errno()\n'
                    'b=ctypes.create_string_buffer(1024);n=L.proc_pidinfo(pid,3,ctypes.c_uint64(0),b,1024);res["pidinfo-bsd"]="ok" if n>0 else "errno %d"%ctypes.get_errno()\n'
                    'p=L.proc_pidpath;pb=ctypes.create_string_buffer(4096);res["pidpath"]="ok" if p(pid,pb,4096)>0 else "errno %d"%ctypes.get_errno()\n'
                    'n=L.proc_listallpids(None,0);res["listallpids"]=n\n'
                    'print(json.dumps(res))')
            r = sb(base, [py, '-I', '-c', code], ctx)
            try:
                res = json.loads(r['out'].strip().splitlines()[-1])
                check('processes', 'procargs2-of-outside-process', not res['procargs2'].startswith('read'), res['procargs2'], 'denied')
                check('processes', 'pidinfo-of-outside-process', res['pidinfo-bsd'] != 'ok', res['pidinfo-bsd'], 'denied')
                record('processes', 'pidpath-of-outside-process', 'INFO', res['pidpath'])
                record('processes', 'listallpids-visible-count', 'INFO', str(res['listallpids']))
            except Exception:
                record('processes', 'libproc-tests', 'ERROR', brief(r))
        r = sb(base, ['/bin/ps', '-p', str(victim.pid)], ctx)
        record('processes', 'ps-outside-process', 'INFO', brief(r))
    finally:
        victim.kill()


@guarded('escapes')
def escapes(ctx, base, appleevents):
    label = f'mina.probe.escape.{os.getpid()}'
    marker = ctx.outside / 'escaped-submit'
    calculator_before = run(['/usr/bin/pgrep', '-x', 'Calculator'])['rc'] == 0
    try:
        r = sb(base, ['/usr/bin/open', '-g', '-j', '-a', 'Calculator'], ctx, timeout=20)
        time.sleep(2)
        started = (not calculator_before) and run(['/usr/bin/pgrep', '-x', 'Calculator'])['rc'] == 0
        check('escapes', 'open-app', denied(r) and not started, brief(r), 'denied (LaunchServices)')
        if started:
            run(['/usr/bin/pkill', '-x', 'Calculator'])
        r = sb(base, ['/bin/launchctl', 'submit', '-l', label, '--', '/bin/sh', '-c', f'touch "{marker}"; sleep 30'], ctx, timeout=20)
        time.sleep(2)
        check('escapes', 'launchctl-submit', not marker.exists(), brief(r) + f'; marker={marker.exists()}', 'no job runs')
        r = sb(base, ['/bin/sh', '-c', '/usr/bin/pbpaste >/dev/null'], ctx, timeout=20)
        check('escapes', 'pasteboard-read', denied(r), f'rc={r["rc"]} (contents not recorded)', 'denied')
        # list-keychains prints only keychain file names; the output is discarded and only the exit code is kept.
        outside = run(['/bin/sh', '-c', '/usr/bin/security list-keychains >/dev/null'], timeout=20)
        inside = sb(base, ['/bin/sh', '-c', '/usr/bin/security list-keychains >/dev/null'], ctx, timeout=20)
        check('escapes', 'keychain-search-list', outside['rc'] == 0 and inside['rc'] not in (0, None),
              f'outside rc={outside["rc"]}; inside rc={inside["rc"]} {inside["err"].strip()[:160]!r}',
              'works outside, fails inside (the Keychain is unreachable)')
        r = sb(base, ['/bin/sh', '-c', 'crontab -l >/dev/null'], ctx, timeout=20)
        record('escapes', 'crontab', 'INFO', brief(r))
        if appleevents:
            r = sb(base, ['/usr/bin/osascript', '-e', 'tell application "Finder" to get version'], ctx, timeout=30)
            check('escapes', 'appleevent-finder', denied(r), brief(r), 'denied')
    finally:
        run(['/bin/launchctl', 'remove', label])
        if marker.exists():
            marker.unlink()


@guarded('freeze')
def freeze(ctx):
    run_sh = ctx.checks / 'run.sh'
    run_sh.write_text('#!/bin/sh\necho accepted-check\n')
    (ctx.project / 'other.sh').write_text('#!/bin/sh\necho EVIL\n')
    before = hashlib.sha256(run_sh.read_bytes()).hexdigest()
    prof = ctx.build('freeze', freeze=True)
    attempts = '''
t() { n=$1; shift; if "$@" >/dev/null 2>&1; then echo "$n=ALLOWED"; else echo "$n=blocked"; fi; }
t append sh -c 'echo x >> .mina/checks/run.sh'
t truncate sh -c ': > .mina/checks/run.sh'
t overwrite_cp cp other.sh .mina/checks/run.sh
t clone_over cp -c other.sh .mina/checks/run.sh
t rm rm -f .mina/checks/run.sh
t new_file sh -c 'echo x > .mina/checks/new.sh'
t mkdir mkdir .mina/checks/sub
t chmod chmod 777 .mina/checks/run.sh
t xattr xattr -w com.mina.probe 1 .mina/checks/run.sh
t touch_times touch -t 200001010000 .mina/checks/run.sh
t rename_into sh -c 'cp other.sh evil.sh && mv -f evil.sh .mina/checks/run.sh'
t rename_checks mv .mina/checks .mina/checks-moved
t rename_mina mv .mina .mina-moved
t rm_mina rm -rf .mina
t hardlink ln .mina/checks/run.sh hl
t write_via_hardlink sh -c 'test -f hl && echo EVIL >> hl'
t symlink_swap ln -sf /etc/hosts .mina/checks/run.sh
t write_other_mina_file sh -c 'echo goal > .mina/goal-notes.txt'
t run_check bash .mina/checks/run.sh
'''
    r = sb(prof, ['/bin/bash', '--noprofile', '--norc', '-c', attempts], ctx, timeout=60)
    results = dict(line.split('=', 1) for line in r['out'].split() if '=' in line)
    allowed_ok = {'write_other_mina_file', 'run_check'}
    for name, outcome in results.items():
        if name == 'write_via_hardlink' and results.get('hardlink') == 'blocked':
            continue
        want = 'ALLOWED' if name in allowed_ok else 'blocked'
        check('freeze', name, outcome == want, outcome, want)
    if not results:
        record('freeze', 'attempts', 'ERROR', brief(r))
    intact = run_sh.exists() and not run_sh.is_symlink() and hashlib.sha256(run_sh.read_bytes()).hexdigest() == before
    nlink = run_sh.stat().st_nlink if run_sh.exists() else None
    check('freeze', 'integrity-after-attempts', intact and nlink == 1, f'same bytes={intact}; nlink={nlink}', 'unchanged, nlink 1')


@guarded('gpu')
def gpu(ctx, base):
    if not ctx.tools.get('swiftc'):
        record('gpu', 'metal', 'SKIP', 'no swiftc (Xcode or CLT Swift)')
        return
    src = ctx.base / 'metal.swift'
    exe = ctx.data / 'metal-probe'
    src.write_text('import Metal\nprint(MTLCreateSystemDefaultDevice() == nil ? "no-device" : "device")\n')
    c = run(['/usr/bin/xcrun', 'swiftc', '-O', str(src), '-o', str(exe)], timeout=300)
    if c['rc'] != 0:
        record('gpu', 'compile', 'SKIP', brief(c))
        return
    outside = run([str(exe)], timeout=30)
    inside = sb(base, [str(exe)], ctx, timeout=30)
    record('gpu', 'metal-outside', 'INFO', brief(outside))
    check('gpu', 'metal-inside', 'device' != inside['out'].strip(), brief(inside), 'no Metal device (or a crash)')


@guarded('timing')
def timing(ctx, base):
    def median(argv, n, sandboxed):
        times = []
        for _ in range(n):
            r = sb(base, argv, ctx) if sandboxed else run(argv, env=ctx.env())
            times.append(r['ms'])
        times.sort()
        return times[len(times) // 2]
    bare, boxed = median(['/usr/bin/true'], 30, False), median(['/usr/bin/true'], 30, True)
    record('timing', 'true', 'INFO', f'bare {bare:.1f} ms, sandboxed {boxed:.1f} ms (+{boxed - bare:.1f})')
    if ctx.tools.get('node'):
        bare, boxed = median([ctx.tools['node'], '-e', '0'], 10, False), median([ctx.tools['node'], '-e', '0'], 10, True)
        record('timing', 'node-e-0', 'INFO', f'bare {bare:.1f} ms, sandboxed {boxed:.1f} ms (+{boxed - bare:.1f})')
    record('timing', 'profile-size', 'INFO', f'{len(base.text)} bytes, {len(base.params)} params')


@guarded('launchd')
def launchd(ctx):
    label = f'mina.probe.{os.getpid()}'
    d = ctx.base / 'launchd'
    d.mkdir(exist_ok=True)
    py = sys.executable
    uvpy = ctx.tools.get('python') or py
    script = d / 'job.sh'
    script.write_text(f'''#!/bin/sh
D="{d}"
echo $$ > "$D/main.pid"
/bin/sleep 600 & echo $! > "$D/child.pid"
"{py}" -I -c 'import os,sys,time
if os.fork(): sys.exit(0)
os.setsid()
if os.fork(): sys.exit(0)
open(sys.argv[1],"w").write(str(os.getpid())); time.sleep(600)' "$D/escaped.pid"
( /bin/ls "$HOME/Documents" >/dev/null 2>&1; echo $? > "$D/documents.rc" )
( "{uvpy}" -I -c 'print("uv-python-ok")' > "$D/uvpy.out" 2>&1; echo $? > "$D/uvpy.rc" ) &
exec /bin/sleep 600
''')
    os.chmod(script, 0o700)
    plist = d / f'{label}.plist'
    plist.write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{label}</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>{script}</string></array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>{HOME}</string></dict>
<key>RunAtLoad</key><true/>
<key>StandardErrorPath</key><string>{d}/stderr.log</string>
</dict></plist>
''')
    run(['/usr/bin/xattr', '-d', 'com.apple.quarantine', str(plist)])
    domain = f'gui/{UID}'
    pids = {}
    t0 = int(time.time()) - 1

    def ours(p):
        """Started after the bootstrap: never a pre-existing process that happens to share a coalition or a reused pid."""
        s = start_time(p)
        return s is not None and s >= t0 and p != os.getpid()
    try:
        r = run(['/bin/launchctl', 'bootstrap', domain, str(plist)], timeout=30)
        if not check('launchd', 'bootstrap', r['rc'] == 0, brief(r), 'loads without root'):
            return
        deadline = time.time() + 20
        while time.time() < deadline and not all((d / f).exists() for f in ('main.pid', 'child.pid', 'escaped.pid')):
            time.sleep(0.5)
        for name in ('main', 'child', 'escaped'):
            f = d / f'{name}.pid'
            if f.exists() and f.read_text().strip().isdigit():
                pids[name] = int(f.read_text())
        mine = coalition_of(os.getpid())
        coal = {n: coalition_of(p) for n, p in pids.items()}
        record('launchd', 'coalitions', 'INFO', f'probe={mine}; job={coal}')
        job = coal.get('main')
        check('launchd', 'fresh-coalition', job is not None and job != mine, f'probe={mine} job={job}', 'job coalition differs from the probe')
        check('launchd', 'setsid-child-stays-in-coalition', job is not None and coal.get('escaped') == job,
              f'escaped={coal.get("escaped")} job={job}', 'the double-forked setsid process is still a member')
        members = [p for p in all_pids() if coalition_of(p) == job] if job else []
        record('launchd', 'coalition-members', 'INFO', f'{len(members)} processes in the job coalition')
        time.sleep(8)  # give the uv-python test time
        rc = (d / 'documents.rc').read_text().strip() if (d / 'documents.rc').exists() else 'no result'
        record('launchd', 'documents-from-job', 'INFO', f'ls ~/Documents rc={rc} (0 = the job can read it; 1 = privacy denied)')
        uvrc = (d / 'uvpy.rc').read_text().strip() if (d / 'uvpy.rc').exists() else None
        check('launchd', 'python-under-launchd', uvrc == '0', f'rc={uvrc} (None = still hanging, uv#22915)', 'starts and exits 0')
        run(['/bin/launchctl', 'bootout', f'{domain}/{label}'], timeout=30)
        time.sleep(2)
        survivors = {n: p for n, p in pids.items() if alive(p) and coalition_of(p) == job}
        record('launchd', 'survivors-after-bootout', 'INFO', f'{sorted(survivors)} (launchd kills the process group only)')
        leftover = [p for p in all_pids() if job and job != mine and coalition_of(p) == job]
        foreign = [p for p in leftover if not ours(p)]
        if foreign or len(leftover) > 12:
            record('launchd', 'coalition-sweep-empties-it', 'FAIL',
                   f'not swept: {len(foreign)} of {len(leftover)} members started before the job (the coalition is shared)',
                   'the job coalition holds only the job')
            leftover = []
        for p in leftover:
            try:
                os.kill(p, signal.SIGSTOP)
            except OSError:
                pass
        for p in leftover:
            try:
                os.kill(p, signal.SIGKILL)
            except OSError:
                pass
        time.sleep(1)
        if leftover:
            remaining = [p for p in all_pids() if coalition_of(p) == job]
            check('launchd', 'coalition-sweep-empties-it', not remaining, f'swept {len(leftover)}, remaining {len(remaining)}',
                  'the stop-by-coalition sweep leaves no member')
    finally:
        run(['/bin/launchctl', 'bootout', f'{domain}/{label}'], timeout=30)
        for p in pids.values():
            if alive(p) and ours(p):
                try:
                    os.kill(p, signal.SIGKILL)
                except OSError:
                    pass
        btm = run(['/usr/bin/sfltool', 'dumpbtm'], timeout=30)
        record('launchd', 'btm-mentions-probe', 'INFO', f'label in sfltool dumpbtm: {label in btm["out"]} (rc={btm["rc"]})')


# ---------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--keep', action='store_true', help='keep the work folder')
    ap.add_argument('--appleevents', action='store_true', help='also test AppleEvents (can show an Automation prompt)')
    ap.add_argument('--only', action='append', default=[], help='run only these groups (repeatable); environment and syntax always run')
    args = ap.parse_args()
    want = lambda g: not args.only or g in args.only
    if sys.platform != 'darwin':
        print('This probe runs only on macOS.', file=sys.stderr)
        return 2
    base = Path(tempfile.mkdtemp(prefix='.mina-probe-', dir=str(HOME))).resolve()
    ctx = Ctx(base)
    print(f'mina macOS probe; work folder {mask(str(base))}', flush=True)
    try:
        if environment(ctx) and syntax(ctx):
            base_profile = profile_compiles(ctx)
            if base_profile:
                for group, call in (('toolchain', lambda: toolchain(ctx, base_profile)), ('path-lookup', lambda: path_lookup(ctx, base_profile)),
                                    ('hang', lambda: hang(ctx)), ('filesystem', lambda: filesystem(ctx, base_profile)),
                                    ('network', lambda: network(ctx)), ('processes', lambda: processes(ctx, base_profile)),
                                    ('escapes', lambda: escapes(ctx, base_profile, args.appleevents)), ('freeze', lambda: freeze(ctx)),
                                    ('gpu', lambda: gpu(ctx, base_profile)), ('timing', lambda: timing(ctx, base_profile))):
                    if want(group):
                        call()
            if want('launchd'):
                launchd(ctx)
    finally:
        out = Path.cwd() / f'mina-macos-probe-{time.strftime("%Y%m%d-%H%M%S")}.json'
        counts = {k: sum(r['outcome'] == k for r in RESULTS) for k in ('PASS', 'FAIL', 'ERROR', 'INFO', 'SKIP')}
        base_text = (base / 'profiles' / 'base.sb').read_text() if (base / 'profiles' / 'base.sb').exists() else ''
        out.write_text(json.dumps({'probe': 'mina-macos-probe/1', 'counts': counts, 'results': RESULTS,
                                   'profile_text': mask(base_text)}, indent=1))
        if args.keep:
            print(f'\nkept {mask(str(base))}')
        else:
            shutil.rmtree(base, ignore_errors=True)
        print(f'\n{counts}\nreport: {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
