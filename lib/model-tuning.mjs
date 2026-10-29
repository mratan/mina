// Shared model-tuning readers. A named launch profile applies only to that model;
// a profile without a model is an explicit model-independent experiment.
//
// Tuning files are named <provider>__<model>.json. They are looked up in the user's folder first ($MINA_MODELS_DIR, else
// ~/.config/mina/models/), then in the repository's models/. MINA_TUNING_FILE replaces the lookup for the launch model.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const REPO_MODELS_DIR = fileURLToPath(new URL('../models/', import.meta.url));

// The user's tuning folder: MINA_MODELS_DIR, else ~/.config/mina/models.
export const userModelsDir = (env = process.env, home = homedir()) => env.MINA_MODELS_DIR?.trim() || join(home, '.config', 'mina', 'models');
// The folders searched, in order: the user's, then the repository's.
export const modelDirs = (env = process.env, home = homedir()) => [userModelsDir(env, home), REPO_MODELS_DIR];

const json = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
export const loadTuning = (env = process.env) => env.MINA_TUNING_FILE ? json(env.MINA_TUNING_FILE) : null;

// The tuning file of a model. `dirs` is a folder or a list searched in order (default: the user's, then the repo's).
// Claude account profiles (provider claude-sdk-<profile>, from ~/.pi/agent/claude-sdk.json) use the claude-sdk file of
// the same model, so one file serves every account on every device. A profile's own file, in any folder, replaces it.
// When nothing exists, the path the first folder would hold is returned.
export function tuningPath(provider, model, dirs = modelDirs()) {
  const list = Array.isArray(dirs) ? dirs : [dirs];
  const name = (p) => `${p}__${model.replaceAll('/', '_')}.json`;
  const candidates = [provider, ...(/^claude-sdk-./.test(provider) ? ['claude-sdk'] : [])]
    .flatMap((p) => list.map((dir) => join(dir, name(p))));
  return candidates.find((file) => existsSync(file)) ?? candidates[0];
}

// The tuning of `provider/model`, or null. `model` names the model asked for, also when the file is shared.
export function modelTuning(provider, model, dirs = modelDirs()) {
  const file = tuningPath(provider, model, dirs), t = json(file);
  return t ? { file, ...t, model: `${provider}/${model}` } : null;
}

// By file name, `<provider>__<model>.json`, as the extensions ask for it.
export function readModelTuning(name, { env = process.env } = {}) {
  const dirs = modelDirs(env);
  const m = /^(.+?)__(.+)\.json$/.exec(name);
  if (!m) return dirs.map((dir) => json(join(dir, name))).find(Boolean) ?? null;
  const t = modelTuning(m[1], m[2], dirs);
  if (!t) return null;
  const { file, ...tuning } = t;
  return tuning;
}
