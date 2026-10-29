# Retained tool results

`lib/retained-tool-results.mjs` keeps oversized research-tool results out of Claude Code's private spill directory.

## Problem

The `claude-sdk` provider forwards every Pi tool result to Claude Code through an in-process MCP server.
Claude Code persists a result into `~/.claude/projects/<project>/<session>/tool-results/` and gives the model only that path when:

- the text blocks total more than 50,000 characters (`.length`), and
- the result contains no image or document block.

There is also a 200,000-character aggregate budget per message.
The bundled CLI shipped with `@anthropic-ai/claude-agent-sdk` 0.3.302 contains these values.
The path the model receives is inside private Claude state, which mina deliberately hides from workers.
Reads of that path from a worker fail with `ENOENT`, so the model loses the result.

## Fix

`withRetainedOutput(tool, options)` wraps the tool's `execute`. It never reads a path chosen by a tool, its arguments or the model.
Credential-bearing URL parameters in argument metadata are redacted before the sidecar is written.
This does not erase the original tool-call entry or older artifacts. The retained output text remains the tool's produced text.

**Small results.** If the text blocks total `maxInlineBytes` UTF-8 bytes or less (default 32,000), the result is returned by identity.

**Oversized results.** Otherwise the tool's own text is written to a private store:

- The text blocks are joined with `\n`, and byte offsets are recorded.
- The store receives two files, `tool-result-<uuid>.txt` and `tool-result-<uuid>.meta.json`.
- Both files are created with `O_CREAT|O_EXCL|O_NOFOLLOW` and mode 0600, then synced to disk.

The model receives a single bounded text block in place of the text blocks. Non-text blocks keep their position and are never truncated. The block contains:

- a trusted notice with the path, sha256, byte count, completeness and paging advice: `read` with an `offset`/`limit` sized under the cap, or `bash head -c` for long lines;
- a code-point-safe preview inside the tool's own `<<<UNTRUSTED …>>>` boundary, or a generic boundary.

`details.retainedResult` records `{ path, hostPath, bytes, originalBytes, complete, sha256, blocks, lines, longestLineBytes, pageLines }`.

**Errors and statuses.** Thrown errors larger than the cap are retained the same way. The original error object is rethrown with a bounded message, its class and `code`, and `error.retainedResult`. The message in `error.stack` is replaced literally, so `$&`, `$'` and `` $` `` in it are not expanded. A stack still over the cap plus 16 KiB is cut to `name: message`.
A thrown value that is not an `Error` (a string, or an object with its own `toString`) is measured as `String(value)`, which is what Pi reports. An oversized one is retained as that string and replaced by a new bounded `Error` with `cause` set to the original value. Small values are rethrown unchanged.
`isError` and the tool's `details` and statuses pass through unchanged.

**Cancellation.** Nothing is written after the call's signal aborts.

## Store

| Environment | Store | Model-visible handle |
| --- | --- | --- |
| `MINA_WORKER_OUTPUTS` set (mina sandbox) | that directory (instance artifacts), never created by the helper | `/run/mina-outputs/<name>`, the existing read-only worker mount |
| sandbox variables without `MINA_WORKER_OUTPUTS` | none: visible failure | none |
| no sandbox | `$XDG_CACHE_HOME/mina/tool-results` (or `~/.cache/...`), created 0700 | the local path |

The store is refused in these cases:

- it is a symlink, not a directory, or not owned by the user;
- it is group- or other-writable;
- it is `/`, or it contains or equals the home directory;
- it overlaps a private root: `~/.claude*`, `CLAUDE_CONFIG_DIR`, the Pi agent directory, `~/.pi`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/{gh,pi-research,mina}`, or the repository's `keys/`;
- it overlaps a root in the sandbox's private set: the hidden credential paths of `sandbox/sandbox.mjs` (`defaultHidden`), including every Claude profile `configDir` listed in the owner's `claude-sdk.json` (`claudeState`), and each path in `MINA_SANDBOX_PRIVATE` when it is set.

An invalid `claude-sdk.json`, an unsafe profile `configDir`, or a `MINA_SANDBOX_PRIVATE` that is not a JSON array of absolute paths also refuses the store. Without profiles or that variable, the checks are the fixed list above.

If retention fails, the model gets a bounded preview with `isError: true` and `details.retentionError`, never the oversized text.

## Limits and lifetime

- Retention is capped at `maxRetainedBytes`, 16 MiB by default and 64 MiB at most (the worker file-read limit). A larger result is retained as a prefix. The cut is disclosed in the notice and marked `complete: false`, and `originalSha256` covers the whole result.
- `/run/mina-outputs` handles are valid for the instance that produced them, including its children, which share the instance's outputs directory. A restarted instance gets a new outputs directory, so old handles do not resolve there. The files stay on the host under the instance artifacts until the owner deletes them.
- There is no automatic cleanup.
- The wrapper enforces Claude Code's per-result threshold (50,000 characters) for each wrapped result. It does not enforce Claude Code's aggregate budget of 200,000 characters per message. Results under the inline cap are returned untouched, so seven parallel results of 31,999 characters each (223,993 in all) can still exceed that budget and be spilled. This is a residual limit. The default cap keeps six full-size results under the budget.
- The wrapper retains what the tool returns. If a tool truncates before returning, the truncated part is already gone. For example, `literature_db` cuts its body at `MAX_DB_CHARS` (50,000).
- Results that spilled before this change remain in Claude state and are not recovered.

## Integration

```js
// extensions/literature/index.js
import { withRetainedOutput } from '../../lib/retained-tool-results.mjs';
export default function minaLiterature(pi) {
  for (const t of createMinaLiteratureTools()) pi.registerTool(withRetainedOutput(t));
}

// adapters/pi-research-search/index.js (default export used by bin/mina.mjs)
import { withRetainedOutput } from '../../lib/retained-tool-results.mjs';
export default function piResearchSearch(pi) {
  const { tools } = createResearchTools({ config: loadConfig(), keys: loadKeys(), http: createNodeHttpClient() });
  for (const tool of tools) pi.registerTool(withRetainedOutput(tool));
}
```

Children inherit the registered tool objects through `ctx.tools`, so they get the same wrapper and the same `MINA_WORKER_OUTPUTS`.
The environment is read at call time.
Wrapping twice is a no-op.
