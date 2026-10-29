import { Text } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';

// Presentation only: never delegate to native previews or inspect the filesystem. Everything shown
// comes from the call arguments or the returned result, and is treated as untrusted text.
const clean = (text) => stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
const display = (text) => new Text(text, 0, 0);
const numeric = (value) => typeof value === 'number' && Number.isFinite(value);
const HEADER_CHARS = 16000;
const PREVIEW_LINES = 6;
const PREVIEW_CHARS = 1200;
const DIFF_PREVIEW_LINES = 20;
const DIFF_LINE_CHARS = 240;

// Pi's semantic tokens, applied through the theme the TUI passes in. Missing methods (or no theme)
// fall back to plain text so presentation can never break a tool row. Empty text is left unstyled.
function styler(theme) {
  const call = (method, ...args) => (typeof theme?.[method] === 'function' ? theme[method](...args) : args.at(-1));
  const fg = (token, text) => (text ? call('fg', token, text) : '');
  return { fg, bold: (text) => (text ? call('bold', text) : ''), title: (text) => fg('toolTitle', text ? call('bold', text) : '') };
}

export function renderSandboxCall(name, args, theme) {
  args ??= {};
  const s = styler(theme);
  let truncated = false;
  const part = (value) => {
    const text = clean(value);
    if (text.length <= HEADER_CHARS) return text;
    truncated = true;
    return text.slice(0, HEADER_CHARS);
  };
  const arg = (value, fallback) => (typeof value === 'string' ? part(value) : fallback);
  const target = (value, fallback = null) => {
    const text = arg(value, fallback);
    return text === null ? s.fg('toolOutput', '…') : s.fg('accent', text);
  };
  const title = s.title(name);
  let header;
  switch (name) {
    case 'bash': {
      const command = arg(args.command, null);
      header = `${title} ${command === null ? s.fg('toolOutput', '…') : s.title(command)}`
        + (numeric(args.timeout) ? s.fg('muted', ` (timeout: ${args.timeout}s)`) : '');
      break;
    }
    case 'read': {
      const range = ['offset', 'limit'].filter((key) => numeric(args[key])).map((key) => `${key}: ${args[key]}`);
      header = `${title} ${target(args.path)}${range.length ? s.fg('warning', ` (${range.join(', ')})`) : ''}`;
      break;
    }
    case 'write':
    case 'edit':
      header = `${title} ${target(args.path)}`;
      break;
    case 'grep': {
      const pattern = arg(args.pattern, null);
      header = `${title} ${pattern === null ? s.fg('toolOutput', '…') : s.fg('accent', pattern)}${s.fg('toolOutput', ` in ${arg(args.path, '.')}`)}`;
      break;
    }
    case 'find':
      header = `${title} ${target(args.path, '.')}${typeof args.pattern === 'string' ? s.fg('toolOutput', ` (pattern: ${part(args.pattern)})`) : ''}`;
      break;
    case 'ls':
      header = `${title} ${target(args.path, '.')}`;
      break;
    default:
      header = title;
  }
  return display(truncated ? `${header}\n${s.fg('muted', '[Call header truncated]')}` : header);
}

// Diff lines are pre-rendered by the edit tool (`details.diff`: "+12 text", "-12 text", " 12 text").
const diffToken = (line) => (line.startsWith('+') ? 'toolDiffAdded' : line.startsWith('-') ? 'toolDiffRemoved' : 'toolDiffContext');

function renderDiffBody(diff, expanded, s) {
  const lines = clean(diff).replace(/\t/g, '   ').split('\n');
  const style = (line) => s.fg(diffToken(line), line);
  if (expanded) return lines.map(style);
  const shown = lines.slice(0, DIFF_PREVIEW_LINES);
  const clipped = shown.some((line) => line.length > DIFF_LINE_CHARS);
  const hidden = lines.length - shown.length;
  const out = shown.map((line) => style(line.slice(0, DIFF_LINE_CHARS)));
  if (hidden > 0 || clipped) {
    const what = hidden > 0 ? `${hidden} more line${hidden === 1 ? '' : 's'}` : 'long lines clipped';
    out.push(s.fg('muted', `[Diff collapsed: ${what}; expand for full diff]`));
  }
  return out;
}

function receiptStyler(path, s) {
  // A write receipt names the path it was given; highlight that supplied path, as Pi's header does.
  return (line) => {
    const at = path ? line.lastIndexOf(path) : -1;
    if (at < 0) return s.fg('success', line);
    return s.fg('success', line.slice(0, at)) + s.fg('accent', path) + s.fg('success', line.slice(at + path.length));
  };
}

export function renderSandboxResult(name, result, { expanded = false } = {}, theme, context) {
  result ??= {};
  const s = styler(theme);
  const isError = Boolean(context?.isError ?? result.isError);
  const text = clean((result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
  // Paths are supplied metadata, not files to open (including retained output).
  const path = result.details?.fullOutputPath ?? result.structuredContent?.full_output_path;
  const pointer = typeof path === 'string' && path ? clean(`Retained output: ${path}`) : '';
  const tail = (value) => (value ? [s.fg('warning', value)] : []);

  const diff = result.details?.diff;
  if (!isError && typeof diff === 'string' && diff) {
    return display([...renderDiffBody(diff, expanded, s), ...tail(expanded ? pointer : pointer.slice(0, 512))].join('\n'));
  }

  const argPath = typeof context?.args?.path === 'string' ? clean(context.args.path) : '';
  const styleLine = isError ? (line) => s.fg('error', line)
    : name === 'write' ? receiptStyler(argPath, s) : (line) => s.fg('toolOutput', line);
  const lines = (body) => (body ? body.split('\n').map(styleLine) : []);
  if (expanded) return display([...lines(text), ...tail(pointer)].join('\n'));

  const preview = text.split('\n', PREVIEW_LINES + 1).slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS);
  const shortPointer = pointer.slice(0, 512);
  const hidden = preview.length < text.length || shortPointer.length < pointer.length;
  return display([...lines(preview), ...(hidden ? [s.fg('muted', '[Output collapsed; expand for full text]')] : []), ...tail(shortPointer)].join('\n'));
}
