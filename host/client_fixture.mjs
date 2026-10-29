// Test-only bridge: real Mina extension and Unix transport, scripted UI, no model/provider calls.
import { readFileSync } from 'node:fs';
import minaHost from '../extensions/host/index.js';

const [socket, grantFile, cwd] = process.argv.slice(2);
const hooks = new Map();
let tool, confirmations = 0;
const pi = {
  registerTool(t) { tool = t; },
  on(event, fn) { hooks.set(event, fn); },
  sendMessage() {},
};
minaHost(pi, { env: { MINA_HOST_SOCKET: socket, MINA_HOST_GRANT_FILE: grantFile } });
try {
  const result = await tool.execute('socket-fixture', JSON.parse(readFileSync(0, 'utf8')), null, null, {
    cwd, hasUI: true, ui: { confirm: async () => { confirmations++; return true; } },
  });
  process.stdout.write(`${JSON.stringify({ confirmations, result })}\n`);
} finally {
  await hooks.get('session_shutdown')?.();
}
