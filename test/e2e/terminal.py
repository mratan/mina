#!/usr/bin/env python3
"""End-to-end check of Mina's terminal UI, as a user runs it: an interactive shell in a pseudo-terminal starts mina with
a scripted provider (no sign-in, no network), then: a prompt and its tool call in a worker, Ctrl+Z (back to the shell),
fg (the TUI comes back), /quit (back to the shell), and no process of the instance left. Linux and macOS.
Run: python3 test/e2e/terminal.py. Exit status 0 when every check passes."""
import fcntl, json, os, pty, re, select, shutil, signal, struct, subprocess, sys, tempfile, termios, time
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
root = tempfile.mkdtemp(prefix='mina-tui-'); cwd = tempfile.mkdtemp(prefix='mina-tui-project-')
agent = os.path.join(root, 'agent'); os.makedirs(agent)
plugin = os.path.join(root, 'provider.mjs')
open(plugin, 'w').write(f"""import {{ fauxProvider, fauxAssistantMessage, fauxToolCall }} from {json.dumps('file://' + REPO + '/node_modules/@earendil-works/pi-ai/dist/index.js')};
export default function(pi) {{ const f = fauxProvider({{ provider: 'mina-fixture', models: [{{ id: 'fixture' }}] }});
  f.setResponses([fauxAssistantMessage(fauxToolCall('bash', {{ command: 'echo TOOL_RAN_$((40+2))' }}), {{ stopReason: 'toolUse' }}), fauxAssistantMessage('HELLO_FROM_FIXTURE')]);
  pi.registerProvider(f.provider); }}""")
config = os.path.join(root, 'sandbox.json'); open(config, 'w').write(json.dumps({'network': 'offline'}))
env = dict(os.environ, PI_CODING_AGENT_DIR=agent, MINA_HOST='0', MINA_SANDBOX_CONFIG=config, XDG_STATE_HOME=os.path.join(root, 'state'),
           XDG_CACHE_HOME=os.path.join(root, 'cache'), XDG_DATA_HOME=os.path.join(root, 'data'), TERM='xterm-256color', PS1='READY')
env['PS1'] = 'READY% ' if os.path.exists('/bin/zsh') else 'READY$ '
pid, fd = pty.fork()
SHELL = '/bin/zsh' if os.path.exists('/bin/zsh') else '/bin/bash'
NODE = shutil.which('node')
if pid == 0:
    os.chdir(cwd)
    os.execve(SHELL, [SHELL, '-f', '-i'] if SHELL.endswith('zsh') else [SHELL, '--norc', '--noprofile', '-i'], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
screen = b''
def pump(seconds, until=None):
    global screen
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if fd in r:
            try: data = os.read(fd, 65536)
            except OSError: return False
            if not data: return False
            screen += data
            if b'\x1b[6n' in data: os.write(fd, b'\x1b[1;1R')
            if b'\x1b[c' in data: os.write(fd, b'\x1b[?62;22c')
        if until and re.search(until, screen[mark:]): return True
    return until is None
mark = 0
results = []
pump(5, rb'READY')
mark = len(screen)
os.write(fd, f"{NODE} {REPO}/bin/mina.mjs --model mina-fixture/fixture -e {plugin}\r".encode())
mark = len(screen) + 200
results.append(pump(30, rb'\(auto\)')); print('started:', results[-1], flush=True); time.sleep(1)
os.write(fd, b'hi'); time.sleep(0.3); os.write(fd, b'\r')
results.append(pump(30, rb'HELLO_FROM_FIXTURE')); print('reply:', results[-1], flush=True)
mark = len(screen)
os.write(fd, b'\x1a')                                                  # Ctrl+Z, as a terminal without the kitty protocol sends it
results.append(pump(10, rb'suspended|Stopped')); print('suspend returns to the shell:', results[-1], flush=True)
mark = len(screen)
os.write(fd, b'fg\r')
results.append(pump(10, rb'\(auto\)')); print('fg brings the TUI back:', results[-1], flush=True); time.sleep(1)
os.write(fd, b'/quit\r')
mark = len(screen)
results.append(pump(15, rb'READY')); print('quit returns to the shell:', results[-1], flush=True)
os.write(fd, b'exit\r'); pump(2)
left = subprocess.run(['pgrep', '-f', plugin], capture_output=True, text=True).stdout.strip()
print('left:', left or 'none')
subprocess.run(['rm', '-rf', root, cwd])
sys.exit(0 if not left and all(results) else 1)
