import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import minaHandoff from '../extensions/handoff/index.js';

const nextStep = 'Inspect the existing receipt for j42 before submitting anything.';
const oldStep = 'Start a new job for the earlier approach.';

test('pinned Pi restores the latest continuation selection from disk without a provider call at startup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mina-continuation-reopen-'));
  const cwd = join(root, 'project'), agentDir = join(root, 'agent'), sessions = join(root, 'sessions');
  for (const path of [cwd, agentDir, sessions]) mkdirSync(path);
  const sm = SessionManager.create(cwd, sessions);
  sm.appendCustomEntry('mina-goal', { id: 'goal', objective: 'Finish the fixture campaign', status: 'active' });
  sm.appendCustomEntry('mina-operator-message', {
    id: 'U-old', at: '2026-11-24T00:00:00Z', goal: 'goal', text: 'Run the old experiment',
  });
  sm.appendCustomEntry('mina-operator-message', {
    id: 'U-new', at: '2026-11-24T00:01:00Z', goal: 'goal', text: 'Inspect job j42 instead',
  });

  const provider = fauxProvider({ provider: 'mina-continuation-fixture' });
  const options = { cwd, agentDir, model: provider.getModel(), settingsManager: SettingsManager.inMemory(),
    modelRuntime: await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), refreshOnCreate: false }) };
  const open = async (manager) => {
    const resourceLoader = new DefaultResourceLoader({ ...options, noExtensions: true, noSkills: true, noContextFiles: true,
      noPromptTemplates: true, noThemes: true, extensionFactories: [
        (pi) => minaHandoff(pi, { tuning: null, readTuning: () => null, measure: () => {} }),
        (pi) => pi.registerProvider(provider.provider),
      ] });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ ...options, resourceLoader, sessionManager: manager });
    await session.bindExtensions({});
    return session;
  };
  let session;
  const close = async () => {
    if (!session) return;
    await session.extensionRunner.emit({ type: 'session_shutdown' });
    session.dispose();
    session = null;
  };
  const call = (input) => fauxAssistantMessage(fauxToolCall('mina_ledger', input), { stopReason: 'toolUse' });
  try {
    provider.setResponses([
      call({ action: 'add', kind: 'task', message_id: 'U-old', quote: 'Run the old experiment', meaning: 'Earlier approach' }),
      call({ action: 'focus', id: 'L1', next_step: oldStep }),
      call({ action: 'add', kind: 'task', message_id: 'U-new', quote: 'Inspect job j42 instead', meaning: 'Read the retained result' }),
      call({ action: 'retire', id: 'L1', status: 'superseded', message_id: 'U-new', quote: 'Inspect job j42 instead' }),
      call({ action: 'focus', id: 'L2', next_step: nextStep, waiting: true }),
      fauxAssistantMessage('I recorded the next step.'),
    ]);
    session = await open(sm);
    await session.prompt('Thanks for the update.');
    await close();

    let firstRequest;
    provider.setResponses([(context) => {
      firstRequest = context;
      return fauxAssistantMessage('Resumed.');
    }]);
    session = await open(SessionManager.open(sm.getSessionFile(), sessions, cwd));
    assert.equal(firstRequest, undefined);
    await session.prompt('Continue.');
    assert.ok(firstRequest, 'the explicit prompt reached the provider');
    // The recent transcript can still mention L1. The authoritative prompt section must not select it.
    const wire = JSON.stringify({ systemPrompt: firstRequest.systemPrompt, messages: firstRequest.messages });
    const section = wire.match(/## Continuation to check[^"]*L2 \(waiting; user message U-new\)[\s\S]*?This record grants no permission and does not resume the goal\./)?.[0];
    assert.ok(section, 'the provider receives the restored selection as a continuation section');
    assert.ok(section.includes(nextStep));
    assert.ok(!section.includes(oldStep));
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});
