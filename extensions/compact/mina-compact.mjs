// Keep the pinned upstream compacter unchanged. Reinitialize only its own runtime
// after /model, cancelling its old job and restoring compaction/recall from the branch.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hotCompactConfig, tuningForModel } from '../handoff/policy.mjs';
import { loadTuning, readModelTuning } from '../../lib/model-tuning.mjs';

const json = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
const modelKey = (model) => model ? `${model.provider}/${model.id}` : '';

export function createMinaCompact(pi, { hotCompact, env = process.env, tuning = loadTuning(env), readTuning = readModelTuning }) {
  const managed = env.MINA_HOT_COMPACT_MANAGED === '1';
  const originalConfig = env.PI_HOT_COMPACT_CONFIG;
  let configDir = null, configFile = null, started = false, selectedModel = '', manualEnabled;
  let startHandler, stopHandler;

  const configure = (ctx, model = ctx.model) => {
    if (!managed) return; // An explicit PI_HOT_COMPACT_CONFIG belongs to the user.
    if (!configDir) {
      const cache = join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'mina');
      mkdirSync(cache, { recursive: true });
      configDir = mkdtempSync(join(cache, 'hot-compact-session-'));
      configFile = join(configDir, 'config.json');
    }
    const userFile = join(env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent'), 'hot-compact.json');
    const live = tuningForModel(tuning, model, readTuning);
    const window = model?.contextWindow ?? live?.context_window;
    const config = hotCompactConfig(json(userFile), live && { ...live, context_window: window }, window);
    if (manualEnabled !== undefined) config.enabled = manualEnabled;
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    env.PI_HOT_COMPACT_CONFIG = configFile;
  };
  const silent = (ctx) => new Proxy(ctx, {
    get(target, key) {
      if (key === 'ui') return new Proxy(target.ui, { get(ui, name) { return name === 'notify' ? () => {} : Reflect.get(ui, name); } });
      return Reflect.get(target, key);
    },
  });
  const stop = async (ctx) => { if (started && stopHandler) await stopHandler('off', silent(ctx)); };
  // Tuning collapse_tool_outputs "with_compaction": an old tool output is collapsed only when a compaction rewrites the
  // history anyway. A collapse on its own rewrites an earlier message, and a provider that keeps the conversation
  // server-side (claude-sdk: a live Claude Code process) must then rebuild it, uncached. Uncommitted collapses stay
  // planned for the next boundary.
  const withCompactionOnly = (event, result, ctx) => {
    if (!result?.entries || result.entries.some((e) => e.type === 'compaction')) return result;
    let live;
    try { live = tuningForModel(tuning, ctx.model, readTuning); } catch { return result; }
    if (live?.collapse_tool_outputs !== 'with_compaction') return result;
    const entries = result.entries.filter((e) => e.type !== 'context_edit' || event.entries?.includes(e));
    return entries.length === result.entries.length ? result : { ...result, entries };
  };

  const proxy = new Proxy(pi, {
    get(target, key) {
      if (key === 'on') return (event, handler) => {
        if (event === 'turn_end' || event === 'agent_before_settle') return target.on(event, async (e, ctx) => withCompactionOnly(e, await handler(e, ctx), ctx));
        if (event !== 'session_start') return target.on(event, handler);
        startHandler = handler;
        return target.on(event, async (event, ctx) => {
          configure(ctx);
          await handler(event, ctx);
          selectedModel = modelKey(ctx.model);
          started = true;
        });
      };
      if (key === 'registerCommand') return (name, command) => {
        if (name !== 'hot-compact') return target.registerCommand(name, command);
        stopHandler = command.handler;
        return target.registerCommand(name, { ...command, handler: async (args, ctx) => {
          const result = await command.handler(args, ctx);
          const cmd = String(args ?? '').trim().split(/\s+/)[0];
          if (cmd === 'on' || cmd === 'off') manualEnabled = cmd === 'on';
          return result;
        } });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  hotCompact(proxy);

  pi.on('model_select', async (event, ctx) => {
    const model = event.model ?? ctx.model;
    if (!started || modelKey(model) === selectedModel) return;
    await stop(ctx); // Upstream's off command cancels the old manager's semantic job.
    configure(ctx, model);
    await startHandler({ reason: 'reload' }, ctx); // Only the compacter, not other session extensions.
    if (!managed && manualEnabled !== undefined) await stopHandler(manualEnabled ? 'on' : 'off', silent(ctx));
    selectedModel = modelKey(model);
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    try { await stop(ctx); }
    finally {
      started = false;
      if (configDir) {
        if (env.PI_HOT_COMPACT_CONFIG === configFile) {
          if (originalConfig === undefined) delete env.PI_HOT_COMPACT_CONFIG;
          else env.PI_HOT_COMPACT_CONFIG = originalConfig;
        }
        rmSync(configDir, { recursive: true, force: true });
        configDir = configFile = null;
      }
    }
  });
}
