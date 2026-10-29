// Loads the adapter directory as an extension in the staged Pi 0.99.2 SDK (no model, no network) and checks that
// research_search and web_fetch register without errors. Skipped when the staged SDK is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ADAPTER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ADAPTER, '..', '..');
const SDK = join(REPO, 'staging/pi-0.99.2/node_modules/@earendil-works/pi-coding-agent/dist/index.js');

test('extension loads in staged Pi 0.99.2 and registers both tools', { skip: !existsSync(SDK) && 'staged Pi 0.99.2 not present' }, async () => {
  const sdk = await import(pathToFileURL(SDK));
  const scratch = join(REPO, '.tmp', 'pi-research-search-load');
  const agentDir = join(scratch, 'agent');
  mkdirSync(agentDir, { recursive: true });
  const loader = new sdk.DefaultResourceLoader({
    cwd: scratch, agentDir, settingsManager: sdk.SettingsManager.inMemory({}), eventBus: sdk.createEventBus(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [ADAPTER],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
  assert.equal(loaded.extensions.length, 1);
  const ext = loaded.extensions[0];
  const tools = ext.tools instanceof Map ? [...ext.tools.values()] : Object.values(ext.tools ?? {});
  const byName = Object.fromEntries(tools.map((t) => [t.definition?.name ?? t.name, t.definition ?? t]));
  assert.deepEqual(Object.keys(byName).sort(), ['research_search', 'web_fetch']);
  assert.equal(byName.research_search.parameters.properties.mode.enum.join(','), 'auto,discover,literature,docs,exact,verify');
  assert.ok(byName.research_search.promptGuidelines.length >= 4);
  assert.equal(typeof byName.web_fetch.execute, 'function');
});
