// A minimal MCP stdio client for the literature smoke tests: newline-delimited JSON-RPC, initialize, tools/list,
// tools/call. It starts a server exactly as .pi/mcp.json does, so a test exercises the same sandboxed command Pi runs.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function serverConfig(name, configPath = join(repo, '.pi/mcp.json')) {
  const entry = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers?.[name];
  if (!entry) throw new Error(`no MCP server ${name} in ${configPath}`);
  return entry;
}

export async function connect(name, { cwd = repo, timeoutMs = 60000, onStderr = () => {} } = {}) {
  const cfg = serverConfig(name);
  if (!cfg.command) throw new Error(`${name} is not a stdio server`);
  const child = spawn(cfg.command, cfg.args ?? [], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(cfg.env ?? {}) } });
  child.stderr.on('data', (d) => onStderr(String(d)));
  let buffer = '', nextId = 1;
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(`${msg.error.code}: ${msg.error.message}`)) : p.resolve(msg.result); }
    }
  });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  const request = (method, params) => new Promise((resolveP, rejectP) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); rejectP(new Error(`${name} ${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolveP(v); }, reject: (e) => { clearTimeout(timer); rejectP(e); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const init = await Promise.race([request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mina-literature-smoke', version: '1' } }),
    exited.then((e) => { throw new Error(`${name} exited during initialize: ${JSON.stringify(e)}`); })]);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    info: init.serverInfo, instructions: init.instructions ?? null,
    async tools() { return (await request('tools/list', {})).tools; },
    async call(tool, args) { return request('tools/call', { name: tool, arguments: args }); },
    async close() { child.stdin.end(); child.kill('SIGTERM'); await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]); },
  };
}

// The text of a tool result (structured content when the server gives it).
export const resultText = (r) => (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
