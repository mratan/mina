# Carried patches to dependencies

Mina pins its dependencies. One package carries local patches until upstream provides equivalent changes.

## pi-claude-subscription 0.2.4-mina.5

| Item | Value |
|---|---|
| Upstream | `pi-claude-subscription` 0.2.4 (npm; github.com/jkeskikangas/pi-claude-subscription), MIT, Copyright (c) 2026 Jarno Keskikangas |
| Carried build | `vendor/pi-claude-subscription-0.2.4-mina.5.tgz`, pinned with its integrity hash in `package-lock.json` |
| Rate-limit patch | `vendor/patches/pi-claude-subscription-0.2.4-rate-limit-event.patch` |
| Account-profile patch | `vendor/patches/pi-claude-subscription-0.2.4-account-profiles.patch` |
| Refusal patch | `vendor/patches/pi-claude-subscription-0.2.4-refusal-fallback.patch` |
| History patch | `vendor/patches/pi-claude-subscription-0.2.4-history-fidelity.patch` |
| Telemetry patch | `vendor/patches/pi-claude-subscription-0.2.4-telemetry-off.patch` |
| Rebuild | `scripts/vendor-pi-claude-subscription.sh`, then `npm install --ignore-scripts` |
| Upstream status | Local patches, not confirmed upstream |

### Rate-limit events

The first patch forwards Claude Code's `rate_limit_event` frames through Pi's `provider_stream_event` hook.
The frames need no extra request. The footer (`extensions/codex-usage`) shows the reported plan limits.
This patch first shipped in `0.2.4-mina.1`.

The footer reads no Claude Code credentials and makes no requests for these events.
It shows nothing until Claude Code sends a frame. `utilization` is a 0–1 fraction, and `resetsAt` uses epoch seconds.
`unifiedWindows` lists the account's reported windows.

### Account profiles

The second patch reads an optional `profiles` array from the owner's `claude-sdk.json` in Pi's agent directory.
Each entry specifies `id`, `name`, and an absolute `configDir`. Project configuration cannot select profiles.
The original `claude-sdk` provider remains unchanged. A profile adds `claude-sdk-<id>` with labeled model entries.

Each profile owns a separate `ClaudeSdkProvider`, child-process environment, session pool, and anchor registry.
Child environments select the profile directory and clear inherited authentication tokens and API-billing overrides.
Transcript lookup and synthesis use the same explicit directory. No code temporarily changes `process.env`.

The SDK's standalone `forkSession()` disk helper reads process-global configuration and accepts no per-call environment.
Profile forks therefore run that helper in a short-lived Node subprocess with the profile's `CLAUDE_CONFIG_DIR`.
This process only forks local transcript files. It makes no model request.
The original provider retains the upstream in-process helper.

Mina's controller mounts profile state as writable and hides it from workers.
The footer keeps independent limits for each account provider.
A profile uses the `claude-sdk` tuning file of the same model (`lib/model-tuning.mjs`), so one file serves every account. A profile's own file, if one exists, replaces it.

`test/claude-profiles.test.mjs` covers owner-only configuration, environment isolation, concurrent requests, separate pools, restart routing,
transcript lookup and synthesis, real SDK disk forks, separate anchors, registration, and the Claude prompt.
Sandbox, footer, and launcher tests cover their corresponding integration changes.
Live checks use context-free prompts and do not establish isolation between conversations that users explicitly move across accounts.

### Refusals and fallback models

The third patch handles replies that the API refuses (`stop_reason` `refusal`). This patch first shipped in `0.2.4-mina.3`.
Claude Code can retry a refused reply once on a fallback model. Opus 5.5 falls back to Opus 5, for example.
For a main-thread fallback, Claude Code then keeps the fallback model for the rest of its session.
Without the patch, Pi recorded a refusal as a normal stop, and the selected model appeared to give the fallback reply.

- The patch forwards Claude Code's `model_refusal_fallback` and `model_refusal_no_fallback` frames through `provider_stream_event`.
- When the fallback model retries, the patch drops the refused partial reply, as Claude Code does. Tool calls in that partial never reach Pi.
- `responseModel` names the model that answered. This includes a server-side `fallback` block inside one response.
- A refusal that no fallback model answers ends the turn with an error that names the category. Pi does not retry this error.

The footer (`extensions/footer`) shows the answering model as `selected → answering` when they differ.
For each refusal frame, the footer adds a `claude-refusal` session entry. It shows one warning for each distinct refusal.
`test/claude-refusal.test.mjs` replays the frame sequences. `test/footer.test.mjs` covers the display.

Known limit: Pi stores no `fallback` content block. If thinking flanks a server-side fallback boundary, the API can reject a session that the provider synthesizes from Pi's transcript.
The live and resumed routes replay Claude Code's own transcript, which keeps the block.

### History fidelity

The fourth patch keeps the model's own replies in the conversation that Claude Code sends. This patch first shipped in `0.2.4-mina.4`.
When Pi rewrites an earlier message, the provider cannot continue its live Claude Code process. pi-hot-compact's tool-output collapse is one such rewrite.
Upstream then resumed Claude Code's session from the newest anchor that still matched, and sent the rest of Pi's transcript as one user turn.
A user turn carries only user messages and tool results, so the model's later replies and tool calls were dropped without an error.
The model answered old questions again and repeated its calls. Sessions showed this as a loop, with Haiku and Opus.

- An anchor can resume only when no assistant message follows it. Otherwise the provider synthesizes the session from Pi's transcript.
- A user turn that contains an assistant message is an error, not a silent loss.
- Anchors written by earlier builds are ignored, because they can point at sessions that already lost replies. Each conversation is synthesized once after the update.
- Before it closes a Claude Code process that still waits for Pi's tool results, the provider interrupts the turn. Otherwise Claude Code recorded the results as interrupted and made more full-context requests before it exited.

`test/claude-history.test.mjs` replays a collapse in the middle of a session and checks each change.
Mina also collapses tool outputs only together with a compaction for Claude models (tuning `collapse_tool_outputs`), so the provider does not rebuild its session after every turn.

### Telemetry off

The fifth patch stops the Claude Code process from sending telemetry. This patch first shipped in `0.2.4-mina.5`.
Upstream sets only `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. The patch also sets each opt-out that the bundled Claude Code reads:
`DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES`, `DISABLE_BUG_COMMAND`, `DISABLE_FEEDBACK_COMMAND`, and `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`.
It sets `ENABLE_CLAUDEAI_MCP_SERVERS=false`, so Claude Code does not get the claude.ai connector list (`GET /v1/mcp_servers`).
It removes inherited exporters (`OTEL_*`, `CLAUDE_CODE_ENABLE_TELEMETRY`, and the beta tracing variables), so a shell setting cannot send session data to a collector.

The model requests and the organization settings and policy limits stay. `test/claude-profiles.test.mjs` checks the environment, and `npm run test:e2e` checks the traffic. See [Privacy and network](usage.md#privacy-and-network).

### Where the package loads

- Mina explicitly loads `node_modules/pi-claude-subscription` in its trusted layers.
- Plain Pi can load the same carried build from a local path: `pi install <mina>/node_modules/pi-claude-subscription`. This writes the path to `~/.pi/agent/settings.json`.

Then both commands use the same carried build and the same profile configuration in `~/.pi/agent/claude-sdk.json`.
In unsandboxed `--full` mode, Mina skips its own copy when your settings already load the package.
See [Two Claude accounts](models.md#two-claude-accounts) for login, selection, and temporary-profile removal.

### When upstream provides equivalent support

1. Check that the upstream release forwards rate-limit events and refusal notices, handles refused replies, keeps assistant messages when it resumes, turns telemetry off, and isolates account environments, transcripts, pools, anchors, and forks.
2. Replace the carried dependency with that release in `package.json`.
3. Run `npm install --ignore-scripts` and `npm test`.
4. Adapt the owner profile configuration and tests to the upstream interface.
5. Remove only the patches that upstream replaces, their build script entries, and the unused tarball.
6. Check both account providers and their footer limits in Mina and plain Pi.

If you change plain Pi to an npm package source, update `~/.pi/agent/settings.json` and run `pi update`.
If upstream changes the event shape, adapt `formatClaudeCode()` and its tests before you remove the rate-limit patch.
