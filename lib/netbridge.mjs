// Network bridge: the wrapper of a sandboxed command at the 'packages' and 'open' network levels. It runs inside the
// sandbox, in the command's own network namespace (bwrap --unshare-net brings up only `lo`), so 127.0.0.1:3128 here is
// the sandbox's loopback, never the host's. Each connection is relayed to the egress proxy's Unix socket, bind-mounted at
// /run/mina-egress/proxy.sock; the proxy in the supervisor applies the policy. The bridge listens before the
// command starts, so the command's first request finds it, and it exits as soon as the command does, with the command's
// status: a bridge that outlived the command would keep the systemd scope populated and the task unquiescent. A
// descendant the command detached loses the bridge with it, and so its network. Dependency-free: only node: modules.
import { createServer, connect } from 'node:net';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

// MINA_EGRESS_SOCKET moves the socket: mina's inner sandbox runs inside a read-only outer layer where /run cannot take a
// new mount point, so it binds the socket under the outer layer's private /tmp. The default serves the MCP sandbox.
const SOCKET = process.env.MINA_EGRESS_SOCKET || '/run/mina-egress/proxy.sock';
const PORT = 3128;
const sep = process.argv.indexOf('--');
const argv = sep < 0 ? [] : process.argv.slice(sep + 1);
if (!argv.length) { process.stderr.write('netbridge: usage: netbridge.mjs -- command [args...]\n'); process.exit(125); }

const conns = new Set();
const server = createServer({ pauseOnConnect: true }, (client) => {
  const upstream = connect(SOCKET);
  conns.add(client); conns.add(upstream);
  const drop = () => { client.destroy(); upstream.destroy(); conns.delete(client); conns.delete(upstream); };
  client.on('error', drop); upstream.on('error', drop); client.on('close', drop); upstream.on('close', drop);
  client.pipe(upstream); upstream.pipe(client); client.resume();
});
server.maxConnections = 64;

// Fail closed: without its listener the command would run with proxy variables that lead nowhere, which hides the cause.
server.once('error', (error) => { process.stderr.write(`netbridge: cannot listen on 127.0.0.1:${PORT}: ${error.message}\n`); process.exit(125); });
server.listen(PORT, '127.0.0.1', () => {
  const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });
  // Signals the bridge receives go to the command; its exit decides the bridge's.
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { try { child.kill(s); } catch { /* gone */ } });
  child.once('error', (error) => { process.stderr.write(`netbridge: ${argv[0]}: ${error.message}\n`); process.exit(error.code === 'ENOENT' ? 127 : 126); });
  child.once('exit', (code, signal) => {
    server.close();
    for (const c of conns) c.destroy();
    process.exit(code ?? 128 + (constants.signals[signal] ?? 0));
  });
});
