import { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { resolve, join } from 'node:path';
import { copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { renderSandboxCall, renderSandboxResult } from './renderers.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { runFileOperation, workerBashOperations } from '../../sandbox/worker-client.mjs';

export function createSandboxTools({ cwd = process.cwd(), env = process.env, getEgressSocket = () => null } = {}) {
  const calls = new AsyncLocalStorage();
  const file = (action, args) => runFileOperation(action, args, { cwd, env, signal: calls.getStore() });
  const readFile = (path) => file('read', { path });
  const writeFile = (path, content) => file('write', { path, data: Buffer.from(content).toString('base64') });
  const access = (path) => file('access', { path });
  const detectImageMimeType = async (path) => {
    const data = await readFile(path);
    if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
    if (data.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
    if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
  };
  const tools = [
    createReadToolDefinition(cwd, { operations: { readFile, access, detectImageMimeType } }),
    createWriteToolDefinition(cwd, { operations: { writeFile, mkdir: (path) => file('mkdir', { path }) } }),
    createEditToolDefinition(cwd, { operations: { readFile, writeFile, access } }),
    createBashToolDefinition(cwd, { operations: workerBashOperations({ env, getEgressSocket }), exposeSessionEnvironment: false }),
  ];
  const bash = tools.find((tool) => tool.name === 'bash');
  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  for (const name of ['grep', 'find', 'ls']) tools.push({ name, label: name, description: `Read-only ${name} through the same isolated worker.`,
    parameters: { type: 'object', properties: { path: { type: 'string' }, pattern: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 1000 } }, required: name === 'grep' ? ['pattern'] : [] },
    execute: (id, args, signal, update, ctx) => {
      const path = quote(resolve(cwd, args.path ?? '.'));
      const limit = Math.min(1000, Math.max(1, args.limit ?? 100));
      const command = name === 'ls' ? `ls -la -- ${path}` : name === 'find'
        ? `find ${path} -type f -name ${quote(args.pattern ?? '*')}` : `grep -RnE -- ${quote(args.pattern)} ${path}`;
      return bash.execute(id, { command: `${command} | head -n ${limit} | head -c 40000` }, signal, update, ctx);
    } });
  return tools.map((tool) => { const execute = tool.execute;
    return { ...tool,
      // Native edit/write previews can read controller files before execution guards run.
      // These renderers return bare text, so Pi must draw the boxed shell (native edit sets renderShell: 'self').
      renderShell: 'default',
      renderCall: (args, theme) => renderSandboxCall(tool.name, args, theme),
      renderResult: (result, options, theme, context) => renderSandboxResult(tool.name, result, options, theme, context),
      execute: (id, args, signal, update, ctx) => calls.run(signal, async () => {
        let spill;
        const retain = async (source) => {
          if (!source || !env.MINA_WORKER_OUTPUTS) return null;
          const name = `command-${randomUUID()}.log`;
          const target = join(env.MINA_WORKER_OUTPUTS, name);
          await copyFile(source, target, constants.COPYFILE_EXCL);
          return { visible: `/run/mina-outputs/${name}`, target };
        };
        let out;
        try { out = await execute(id, args, signal, (partial) => { spill = partial.details?.fullOutputPath ?? spill; update?.(partial); }, ctx); }
        catch (error) {
          if (spill && env.MINA_WORKER_OUTPUTS) {
            try { const saved = await retain(spill); error.message += `\nPartial output retained at ${saved.visible} (host: ${saved.target}).`; }
            catch { error.message += '\nPartial-output retention failed; do not assume the command had no effects.'; }
          }
          throw error;
        }
        const source = out.details?.fullOutputPath ?? out.structuredContent?.full_output_path;
        if (!source || !env.MINA_WORKER_OUTPUTS) return out;
        try {
          const saved = await retain(source);
          return { ...out, content: out.content.map((c) => c.type === 'text' ? { ...c, text: c.text.replaceAll(source, saved.visible) } : c),
            details: { ...out.details, fullOutputPath: saved.visible, retainedOutput: saved.target },
            ...(out.structuredContent ? { structuredContent: { ...out.structuredContent,
              ...(out.structuredContent.full_output_path ? { full_output_path: saved.visible } : {}) } } : {}) };
        } catch (error) {
          return { ...out, isError: true, content: [...out.content, { type: 'text', text: `Command ran, but output retention failed: ${error.message}. Do not assume no effects.` }] };
        }
      }) };
  });
}
