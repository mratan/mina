// Resolve owner-installed skills with Pi's own package/filter rules. Do not load
// extensions, approve project resources, or install missing packages here.
import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateTrustedResources, insideAny, defaultHidden } from '../sandbox/sandbox.mjs';

export async function ownerSkills({ agentDir, home, writable, privateRoots = [] }) {
  const file = join(agentDir, 'settings.json');
  validateTrustedResources([file], writable);
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const { DefaultPackageManager, SettingsManager, loadSkills } = await import('@earendil-works/pi-coding-agent');
  const manager = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager: SettingsManager.inMemory(settings) });
  const path = process.env.PATH;
  process.env.PATH = (path || '/usr/local/bin:/usr/bin:/bin').split(':').filter(p => p.startsWith('/') && !insideAny(p, writable)).join(':');
  let resources;
  try { resources = await manager.resolve(async () => 'skip'); }
  finally { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; }
  const paths = resources.skills.filter(r => r.enabled && r.metadata.scope === 'user').map(r => r.path);
  const seen = new Set();
  const validate = (p) => {
    validateTrustedResources([p], writable);
    const real = realpathSync(p);
    if (seen.has(real)) return;
    seen.add(real);
    if (statSync(p).isDirectory()) for (const name of readdirSync(p)) {
      if (name !== 'node_modules' && !name.startsWith('.')) validate(join(p, name));
    }
  };
  paths.forEach(validate);
  const { skills } = loadSkills({ cwd: agentDir, agentDir, skillPaths: paths, includeDefaults: false });
  const files = skills.map(s => realpathSync(s.filePath));
  const directories = [...new Set(files.map(p => realpathSync(dirname(p))))];
  // A loose SKILL.md in the home/config directory must not expose credentials,
  // sessions, or all controller state as an accidental helper directory.
  const secrets = [agentDir, ...privateRoots, ...defaultHidden(home)];
  for (const root of directories) for (const secret of secrets) {
    if (insideAny(secret, [root])) throw new Error(`mina: skill helper directory contains private controller state: ${root}`);
  }
  return { files, directories };
}
