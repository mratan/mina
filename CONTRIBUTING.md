# Contributing to Mina

Thank you for your interest in Mina. This guide gives the code layout, the tests, and the rules for changes.
Read [the architecture](docs/architecture.md) first. It tells how the parts fit together.

By contributing, you agree that your contribution is licensed under the [MIT license](LICENSE) of this repository.

## The rule for changes: normal Pi with layers

Mina is Pi with layers on top. Each change must keep this rule:

- Do not change Pi's code. Add behavior through Pi's extension API, its hooks, and its command-line flags.
- Do not replace a Pi feature with a Mina version. `/model`, `/resume`, `/login`, packages, and Pi's subcommands must work as in Pi.
- If a carried package needs a change, make it a patch in `vendor/patches/` ([vendor patches](docs/vendor-patches.md)).
- Code in a project must not load into the trusted Pi process. The agent's commands run in the sandbox workers.
- A protection that is not available must cause a refusal, not a silent fallback.

## Code layout

| Path | What it contains |
|---|---|
| `bin/mina.mjs` | The launcher. It selects the mode and the tuning file, opens the instance scope and the sandbox, and starts the pinned Pi with the layers (`-e` and `--skill`). |
| `models/` | Tuning files, one for each model (`<provider>__<model id>.json`). |
| `extensions/goal/` | `/goal`: the unmodified `pi-goal` with Mina's checks. `index.js` loads pi-goal, `mina-goal.mjs` holds the logic, `checks.mjs` holds the pure rules, `ask.mjs` gives `mina_ask_user`, `stall.mjs` is the no-effect guard. |
| `extensions/handoff/` | Handoff: `index.js` (the input boundary, `mina_handoff_note`, `/mina-handoff`, `mina_recall`), `policy.mjs` (thresholds, packet, compaction settings), `recall.mjs` (search over the session chain), `reasoning.mjs`, `subagents.mjs`, `metrics.mjs`. |
| `extensions/compact/` | The adapter around the unmodified `pi-hot-compact`. |
| `extensions/literature/` | The literature tools and `supplement_get`. |
| `extensions/sandbox/` | The sandboxed `read`, `write`, `edit`, and `bash` tools, their renderers, and `mina_sandbox_request`. |
| `extensions/delegates/` | The `Agent` tool, child records and receipts, and the subagent display. |
| `extensions/host/` | The `mina_host` client of the host broker. |
| `extensions/identity/`, `extensions/footer/`, `extensions/codex-usage/` | The identity prompt section, the footer, and the plan limits. |
| `sandbox/` | The sandbox rules (`sandbox.mjs`), the worker and its client, project file access for trusted code, and the protected check runner. |
| `lib/` | Shared modules: the instance scope, model tuning, the egress proxy and network bridge, dialogs, question receipts, retained tool results, skill resolution, and the literature tool wrappers. |
| `adapters/pi-research-search/` | `research_search` and `web_fetch`, a small fork of `@bytetrue/pi-web-search` ([attribution](adapters/pi-research-search/ATTRIBUTION.md)). `pristine/` holds the unmodified upstream files. |
| `adapters/pi-literature-broker/` | The schemas of the four literature broker tools. |
| `literature/` | The literature broker (`broker/`), supplement parsing (`supplements/`), the OpenAlex content helper, the smoke suite, and their tests. |
| `services/literature-mcp/` | The lockfiles of the literature MCP servers. |
| `.pi/mcp.json` | How the literature MCP servers start, each in its own sandbox. |
| `host/` | The host broker (`hostd.py`), the workload lock holder (`lockrun.py`), the push gate, the budget and confirmation modules, and the broker tests. |
| `skills/mina-research/` | The research protocol and the format of the context brief. |
| `scripts/` | Install scripts for the literature servers, the MCP sandbox and client, the measurement summary, the threshold simulation, the vendor build, and `goal-rpc.py` (one goal in Pi's RPC mode). |
| `vendor/` | The carried build of `pi-claude-subscription` and its patches. |
| `test/` | Mina's own tests. `test/e2e/` holds the end-to-end privacy test. |
| `docs/` | The documentation. |

## Run the tests

Install the pinned packages first:

```bash
npm ci
```

| Command | What it tests |
|---|---|
| `npm run test:mina` | Mina's own tests in `test/`. |
| `npm test` | All Node tests: Mina, the research search adapter, and the literature broker. |
| `python3 host/test_hostd.py` | The host broker, with an isolated broker, real systemd units, cgroups, and file locks. |
| `python3 host/test_policy.py` | The host policy: validation, changes, risk flags, the atomic write, and agent proposals with an isolated broker. |
| `python3 host/test_git_push_gate.py` | The push gate, with real git repositories and gitleaks. |
| `npm run test:e2e` | Real sessions with real models and research services. |

Some tests need bubblewrap, user namespaces, or a systemd user session. Without them, these tests skip and tell you why.
The broker tests use their own state and lock files. They do not touch a broker that is installed.

On a slow host, set `MINA_TEST_TIMEOUT_SCALE` to make the timeouts of the real-launcher tests longer:

```bash
MINA_TEST_TIMEOUT_SCALE=3 npm test
```

### The end-to-end test

`npm run test:e2e` starts real `mina` sessions. Each scenario checks two things: the feature works, and no traffic goes to hosts other than the model provider and the research services.

- It needs providers that you signed in to. It skips the scenarios for providers that are not set up.
- It uses a small amount of model usage and takes a few minutes.
- With `strace` installed, it records each connection and each name lookup. Without `strace`, it examines only the research logs and the onnxruntime files.

### The literature smoke suite

`npm run literature:smoke` runs live checks against the real research services. It needs the literature servers (`npm run literature:install`).
It writes its report to the `.mina/` folder of the checkout, which git ignores.

## Carried patches

Mina carries local patches to `pi-claude-subscription`. The patches are in `vendor/patches/`, and the build is in `vendor/`.
To change a patch, edit it and rebuild with `scripts/vendor-pi-claude-subscription.sh`. Then run `npm install --ignore-scripts` and `npm test`.
[Vendor patches](docs/vendor-patches.md) gives each patch, its reason, and the steps to remove it when upstream gives the same function.

## Documentation

The documentation follows Simplified Technical English (ASD-STE100), in its pragmatic form:

- Write short sentences: 20 words or fewer in a procedure, 25 words or fewer in a description.
- Use the active voice and simple tenses.
- Use one term for one concept in all documents.
- Tell the reader why, not only what.
- Write procedures as commands. Put a condition before its command.
- Keep code, commands, paths, and quoted errors exact.

Write about the current state of the code. Do not add history, dates of past runs, or the names of your own machines, paths, or projects.
Use placeholders such as `/home/you/work/myproject` in examples.
If a change alters behavior, update the guide that describes it in the same change.

## Before you open a pull request

1. Run `npm test`. If you changed `host/`, also run the two Python test files.
2. If you changed the launcher, the sandbox, or the network settings, run `npm run test:e2e` if you can.
3. Add a test that fails without your change.
4. Update the documentation.
