import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { maxTurnsFor } from '../extensions/handoff/subagents.mjs';
import { mkdirSync } from 'node:fs';
import { createSandboxTools } from '../extensions/sandbox/tools.mjs';

const theme = new Proxy({}, { get: () => (...args) => args.at(-1) ?? '' });
const tools = createSandboxTools({ cwd: '/project', env: {} });
const toolNamed = (name) => tools.find((tool) => tool.name === name);
const renderedText = (component) => component.render(120).map((line) => line.trimEnd()).join('\n');
const renderCall = (name, args) => renderedText(toolNamed(name).renderCall(args, theme, { argsComplete: false }));

test('bash call renders command and optional timeout without a JSON wrapper', () => {
  assert.equal(renderCall('bash', { command: 'printf hello' }), 'bash printf hello');
  assert.equal(renderCall('bash', { command: 'sleep 1', timeout: 30 }), 'bash sleep 1 (timeout: 30s)');
  assert.doesNotMatch(renderCall('bash', { command: 'printf hello', timeout: 30 }), /[{}]|"command"|"timeout"/);
});

test('every sandbox tool uses Pi\'s boxed shell because its renderers draw no frame', () => {
  for (const tool of tools) assert.equal(tool.renderShell, 'default', tool.name);
});

test('file and search calls render useful data-only paths and ranges', () => {
  assert.equal(renderCall('read', { path: 'src/main.mjs', offset: 5, limit: 20 }), 'read src/main.mjs (offset: 5, limit: 20)');
  assert.equal(renderCall('read', { path: 'notes.txt', offset: 3 }), 'read notes.txt (offset: 3)');
  assert.equal(renderCall('read', { path: 'notes.txt', limit: 8 }), 'read notes.txt (limit: 8)');
  assert.equal(renderCall('write', { path: 'src/new.mjs', content: 'PRIVATE_BODY' }), 'write src/new.mjs');
  assert.equal(renderCall('edit', { path: 'src/old.mjs', edits: [{ oldText: 'PRIVATE_OLD', newText: 'PRIVATE_NEW' }] }), 'edit src/old.mjs');
  assert.equal(renderCall('grep', { pattern: 'TODO|FIXME', path: 'src' }), 'grep TODO|FIXME in src');
  assert.equal(renderCall('find', { path: 'src', pattern: '*.mjs' }), 'find src (pattern: *.mjs)');
  assert.equal(renderCall('ls', { path: 'src' }), 'ls src');
});

test('call headers tolerate incomplete arguments without exposing raw payloads', () => {
  for (const name of ['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls']) {
    for (const args of [undefined, null, {}, { path: null, command: {}, pattern: [], offset: '5', timeout: {} }]) {
      const text = renderCall(name, args);
      assert.ok(text.startsWith(name));
      assert.doesNotMatch(text, /undefined|null|\[object Object\]|[{}]/);
    }
  }
  assert.equal(renderCall('read', { path: 'part' }), 'read part');
  assert.equal(renderCall('bash', { command: 'printf' }), 'bash printf');
  assert.equal(renderCall('grep', { pattern: 'needle' }), 'grep needle in .');
  assert.equal(renderCall('find', {}), 'find .');
  assert.equal(renderCall('ls', {}), 'ls .');
});

test('call headers strip terminal controls from untrusted arguments', () => {
  assert.equal(renderCall('bash', { command: '\x1b[31mecho\x1b[0m\x00\r hello\x1b]0;hidden-title\x07' }), 'bash echo hello');
  assert.equal(renderCall('read', { path: '\x1b[2Jnotes.txt\x07' }), 'read notes.txt');
});

const renderResult = (name, result, options = {}) => renderedText(toolNamed(name).renderResult(result, options, theme, {}));

test('results stay concise when collapsed and expose all supplied text when expanded', () => {
  const text = Array.from({ length: 30 }, (_, i) => `output line ${i + 1}`).join('\n');
  const result = { content: [{ type: 'text', text }], details: { fullOutputPath: '/run/mina-outputs/command-example.log' } };
  const collapsed = renderResult('bash', result, { expanded: false });
  assert.match(collapsed, /output line 1\n/);
  assert.doesNotMatch(collapsed, /output line 30/);
  assert.match(collapsed, /expand/i);
  assert.ok(collapsed.split('\n').length <= 10);
  assert.match(collapsed, /Retained output: \/run\/mina-outputs\/command-example\.log/);
  const expanded = renderResult('bash', result, { expanded: true });
  assert.ok(expanded.startsWith(`${text}\n`));
  assert.match(expanded, /Retained output: \/run\/mina-outputs\/command-example\.log/);
  assert.doesNotMatch(expanded, /expand/i);
});

test('single-line results are bounded only when collapsed, with no silent expanded clipping', () => {
  const text = `${'x'.repeat(20000)}TAIL_MARKER`;
  const result = { content: [{ type: 'text', text }], structuredContent: { full_output_path: '/run/mina-outputs/long.log' } };
  const collapsed = renderResult('read', result);
  assert.ok(collapsed.length < 1500);
  assert.match(collapsed, /expand/i);
  assert.doesNotMatch(collapsed, /TAIL_MARKER/);
  const expanded = renderResult('read', result, { expanded: true });
  assert.equal(expanded.replaceAll('\n', ''), `${text}Retained output: /run/mina-outputs/long.log`);
});

test('short, partial, and non-text results tolerate missing data and strip terminal controls', () => {
  const result = { content: [{ type: 'text', text: '\x1b[31mhello\x1b[0m\x00\r\x1b]0;hidden\x07' }, { type: 'image', data: 'PRIVATE_IMAGE' }], details: {} };
  for (const expanded of [false, true]) {
    assert.equal(renderResult('write', result, { expanded, isPartial: true }), 'hello');
    assert.equal(renderResult('edit', {}, { expanded }), '');
    assert.equal(renderResult('edit', { content: [] }, { expanded }), '');
  }
});

test('interactive file previews do not read a credential through a project symlink', async () => {
  initTheme('dark', false);
  const project = mkdtempSync(join(tmpdir(), 'mina-preview-project-'));
  const control = mkdtempSync(join(tmpdir(), 'mina-preview-control-'));
  writeFileSync(join(control, 'secret.txt'), 'PRIVATE_PREVIEW_CANARY needle PRIVATE_PREVIEW_CANARY\n');
  symlinkSync(join(control, 'secret.txt'), join(project, 'link.txt'));
  try {
    const fileTools = createSandboxTools({ cwd: project, env: { MINA_SANDBOX_PROJECT: project, MINA_SANDBOX_NET: 'offline' } });
    for (const name of ['read', 'write', 'edit']) {
      const tool = fileTools.find((t) => t.name === name);
      const args = { path: 'link.txt', content: 'replacement', oldText: 'needle', newText: 'replacement', edits: [{ oldText: 'needle', newText: 'replacement' }] };
      const ctx = { cwd: project, state: {}, argsComplete: true, args, invalidate() {} };
      const component = tool.renderCall(args, theme, ctx);
      assert.equal(renderedText(component), `${name} link.txt`);
      await new Promise((done) => setTimeout(done, 150));
      ctx.lastComponent = component;
      const refreshed = tool.renderCall(args, theme, ctx);
      assert.doesNotMatch(renderedText(refreshed), /PRIVATE_PREVIEW_CANARY/);
      for (const expanded of [false, true]) {
        const rendered = tool.renderResult({ content: [{ type: 'text', text: 'Operation refused.' }], details: {} }, { isPartial: false, expanded }, theme, ctx);
        assert.equal(renderedText(rendered), 'Operation refused.');
        assert.doesNotMatch(renderedText(rendered), /PRIVATE_PREVIEW_CANARY/);
      }
    }
  } finally { rmSync(project, { recursive: true }); rmSync(control, { recursive: true }); }
});

test('handoff metadata does not follow a replaced project agent definition outside the worker', () => {
  const project = mkdtempSync(join(tmpdir(), 'mina-role-project-'));
  const control = mkdtempSync(join(tmpdir(), 'mina-role-control-'));
  mkdirSync(join(project, '.pi', 'agents'), { recursive: true });
  writeFileSync(join(control, 'private.md'), '---\nmax_turns: 424242\ntools: read\n---\nprivate');
  symlinkSync(join(control, 'private.md'), join(project, '.pi', 'agents', 'probe.md'));
  const values = { MINA_SANDBOX: '1', MINA_SANDBOX_PROJECT: project, MINA_SANDBOX_WRITE: JSON.stringify([project]), MINA_SANDBOX_NET: 'offline' };
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    assert.equal(maxTurnsFor('probe', { cwd: project, agentDir: control }), null);
    mkdirSync(join(control, 'agents'));
    symlinkSync(join(project, '.pi', 'agents', 'probe.md'), join(control, 'agents', 'probe.md'));
    assert.equal(maxTurnsFor('probe', { cwd: project, agentDir: control }), null, 'a global-role alias through the writable project cannot bypass the reader');
  }
  finally {
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(project, { recursive: true }); rmSync(control, { recursive: true });
  }
});

// Recording theme: styling becomes observable markers; renders wide so markers do not wrap.
const tag = (name) => (text) => `<${name}>${text}</${name}>`;
const recording = { fg: (token, text) => tag(token)(text), bg: (token, text) => tag(`bg:${token}`)(text), bold: tag('bold'),
  italic: tag('italic'), underline: tag('underline'), inverse: tag('inverse'), dim: tag('dim') };
const styled = (component) => component.render(4000).map((line) => line.trimEnd()).join('\n');
const styledCall = (name, args, t = recording) => styled(toolNamed(name).renderCall(args, t, { argsComplete: true, state: {} }));
const styledResult = (name, result, options = {}, ctx = {}, t = recording) =>
  styled(toolNamed(name).renderResult(result, { expanded: false, isPartial: false, ...options }, t, { state: {}, args: {}, isError: false, ...ctx }));
const title = (name) => `<toolTitle><bold>${name}</bold></toolTitle>`;

test('call headers style the tool name as a bold tool title and the target as accent, like Pi', () => {
  assert.equal(styledCall('read', { path: 'src/main.mjs' }), `${title('read')} <accent>src/main.mjs</accent>`);
  assert.equal(styledCall('read', { path: 'a.txt', offset: 5, limit: 20 }), `${title('read')} <accent>a.txt</accent><warning> (offset: 5, limit: 20)</warning>`);
  assert.equal(styledCall('edit', { path: 'src/old.mjs', edits: [{ oldText: 'PRIVATE_OLD', newText: 'x' }] }), `${title('edit')} <accent>src/old.mjs</accent>`);
  assert.equal(styledCall('write', { path: 'src/new.mjs', content: 'PRIVATE_BODY' }), `${title('write')} <accent>src/new.mjs</accent>`);
  assert.equal(styledCall('bash', { command: 'printf hi' }), `${title('bash')} <toolTitle><bold>printf hi</bold></toolTitle>`);
  assert.equal(styledCall('bash', { command: 'sleep 1', timeout: 30 }), `${title('bash')} <toolTitle><bold>sleep 1</bold></toolTitle><muted> (timeout: 30s)</muted>`);
  assert.equal(styledCall('grep', { pattern: 'TODO', path: 'src' }), `${title('grep')} <accent>TODO</accent><toolOutput> in src</toolOutput>`);
  assert.equal(styledCall('find', { path: 'src', pattern: '*.mjs' }), `${title('find')} <accent>src</accent><toolOutput> (pattern: *.mjs)</toolOutput>`);
  assert.equal(styledCall('ls', {}), `${title('ls')} <accent>.</accent>`);
});

test('styled headers still strip terminal controls before styling', () => {
  const text = styledCall('bash', { command: '\x1b[31mecho\x1b[0m\x07 hi' });
  assert.equal(text, `${title('bash')} <toolTitle><bold>echo hi</bold></toolTitle>`);
  assert.doesNotMatch(text, /\x1b|\x07/);
});

test('bash and read results render each output line in tool-output style with a muted expansion notice', () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  for (const name of ['bash', 'read', 'grep', 'find', 'ls']) {
    const collapsed = styledResult(name, { content: [{ type: 'text', text }], details: {} });
    assert.match(collapsed, /^<toolOutput>line 1<\/toolOutput>\n<toolOutput>line 2<\/toolOutput>/);
    assert.doesNotMatch(collapsed, /line 30/);
    assert.match(collapsed, /<muted>\[Output collapsed; expand for full text\]<\/muted>/);
    const expanded = styledResult(name, { content: [{ type: 'text', text }], details: {} }, { expanded: true });
    assert.match(expanded, /<toolOutput>line 30<\/toolOutput>$/);
    assert.doesNotMatch(expanded, /expand/i);
  }
  const retained = styledResult('bash', { content: [{ type: 'text', text: 'ok' }], details: { fullOutputPath: '/run/mina-outputs/c.log' } });
  assert.equal(retained, '<toolOutput>ok</toolOutput>\n<warning>Retained output: /run/mina-outputs/c.log</warning>');
});

test('error results render in the error style', () => {
  for (const name of ['bash', 'read', 'edit', 'write']) {
    const out = styledResult(name, { content: [{ type: 'text', text: 'Could not find text\nsecond' }], details: { diff: '+1 x' } }, {}, { isError: true });
    assert.equal(out, '<error>Could not find text</error>\n<error>second</error>');
  }
});

const diff = [' 1 keep', '-2 old line', '+2 new line', ' 3 keep', '     ...', '+9 added'].join('\n');
test('edit results render the supplied diff with added, removed, and context lines styled', () => {
  const result = { content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in a.mjs.' }], details: { diff, firstChangedLine: 2 } };
  const out = styledResult('edit', result, {}, { args: { path: 'a.mjs' } });
  assert.equal(out, [
    '<toolDiffContext> 1 keep</toolDiffContext>', '<toolDiffRemoved>-2 old line</toolDiffRemoved>',
    '<toolDiffAdded>+2 new line</toolDiffAdded>', '<toolDiffContext> 3 keep</toolDiffContext>',
    '<toolDiffContext>     ...</toolDiffContext>', '<toolDiffAdded>+9 added</toolDiffAdded>'].join('\n'));
  assert.equal(styledResult('edit', result, { expanded: true }), out);
});

test('large edit diffs are bounded when collapsed with an explicit notice and complete when expanded', () => {
  const big = Array.from({ length: 200 }, (_, i) => `+${i + 1} added ${i + 1}`).join('\n');
  const result = { content: [{ type: 'text', text: 'ok' }], details: { diff: `${big}\n+201 ${'y'.repeat(5000)}DIFF_TAIL` } };
  const collapsed = styledResult('edit', result);
  assert.ok(collapsed.split('\n').length <= 25);
  assert.ok(collapsed.length < 6000);
  assert.doesNotMatch(collapsed, /DIFF_TAIL|added 200/);
  assert.match(collapsed, /<muted>\[Diff collapsed: \d+ more lines?; expand for full diff\]<\/muted>$/);
  const expanded = styledResult('edit', result, { expanded: true });
  assert.match(expanded, /<toolDiffAdded>\+200 added 200<\/toolDiffAdded>/);
  assert.match(expanded, /DIFF_TAIL<\/toolDiffAdded>$/);
  assert.doesNotMatch(expanded, /expand/i);
});

test('edit diff text is untrusted: terminal controls are stripped before styling', () => {
  const out = styledResult('edit', { content: [], details: { diff: '+1 \x1b[2Jhi\x1b]0;t\x07\tx' } }, { expanded: true });
  assert.equal(out, '<toolDiffAdded>+1 hi   x</toolDiffAdded>');
});

test('write results keep a styled receipt with the path in accent', () => {
  const result = { content: [{ type: 'text', text: 'Successfully wrote 12 bytes to src/new.mjs' }], details: undefined };
  assert.equal(styledResult('write', result, {}, { args: { path: 'src/new.mjs' } }),
    '<success>Successfully wrote 12 bytes to </success><accent>src/new.mjs</accent>');
  assert.equal(styledResult('write', result), '<success>Successfully wrote 12 bytes to src/new.mjs</success>');
});

test('renderers tolerate a theme lacking styling methods', () => {
  assert.equal(styledCall('read', { path: 'a' }, {}), 'read a');
  assert.equal(styledCall('bash', { command: 'x' }, null), 'bash x');
  assert.equal(styledResult('edit', { content: [], details: { diff } }, { expanded: true }, {}, { fg: 'not a function' }), diff);
  assert.equal(styledResult('bash', { content: [{ type: 'text', text: 'e' }] }, {}, { isError: true }, {}), 'e');
});

test('sandbox renderers import no filesystem or native preview code', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../extensions/sandbox/renderers.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['@earendil-works/pi-tui', 'node:util']);
  assert.doesNotMatch(source, /\b(fs|stat|lstat|realpath|readFile|computeEditsDiff|renderDiff|import\()\b/);
});
