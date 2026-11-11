# MI->NA | Mapping Information to Next Actions

Mina adds research tools, checked goals, long sessions, and a sandbox to the [Pi](https://pi.dev) coding agent.
It works with Pi's model providers, including Claude, OpenAI Codex, and local models.
You can use it for software development, literature research, and controlled jobs on shared GPU machines.

**Enterprise Claude:** Many enterprise deployments require the **Claude Agent SDK** route (`claude-sdk/*`), rather than Pi's direct Anthropic OAuth.
The [Claude setup](#claude-including-enterprise-accounts) explains installation, sign-in, and the difference between these routes.
Your organization must permit Claude Code and SDK use.

> [!NOTE]
> The name honors astronomer Williamina Fleming and her work on stellar classification.
> Mina connects literature research to checked, sandboxed engineering work.

## Install

### Requirements

Mina supports these systems:

| System | Requirements |
|---|---|
| Linux | A systemd user session, cgroup v2, and [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) |
| macOS | macOS 27 "Golden Gate", version 27.2 or later, on Apple silicon, with the Command Line Tools (`xcode-select --install`) |

The core requires Node.js 22 or newer on Linux, or Node.js 24 or newer on macOS.
The research tools require [uv](https://docs.astral.sh/uv/) and Node.js 24 or newer.
[SearXNG](https://docs.searxng.org/) also requires [Podman](https://podman.io).
On macOS, Homebrew supplies these packages: `brew install node uv podman`.

Mina's macOS tests use macOS 27.2.
Version 27.2 includes fixes for Sandbox escapes.
See the [macOS guide](docs/macos.md) for platform differences and privacy permissions.

### 1. Install Mina

Clone the repository:

```bash
git clone https://github.com/mratan/mina.git
cd mina
```

Install the pinned dependencies:

```bash
npm ci
```

This command installs Mina's pinned Pi, the Claude SDK provider, and the Claude Agent SDK.
A separate global Pi installation is not necessary.
Mina uses your existing Pi sign-ins and configuration in `~/.pi/agent`.

On macOS, build the sandbox helpers:

```bash
npm run macos:helpers
```

Put `mina` on your PATH:

```bash
mkdir -p ~/.local/bin
ln -s "$PWD/bin/mina.mjs" ~/.local/bin/mina
```

If `~/.local/bin` is absent from your PATH, add this line to your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

The usual profile on macOS is `~/.zshrc`.

### 2. Configure a model provider

#### Claude, including enterprise accounts

The `claude-sdk/*` provider sends model requests through Claude Code and the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript).
Pi still controls the agent loop, tools, goals, and context.
Claude Code supplies the authenticated model connection.

The two Claude routes have different billing behavior:

| Route | Sign-in | Usage |
|---|---|---|
| `claude-sdk/*` | Your local Claude Code login | The Claude plan of that account, subject to Anthropic's terms and organization policy |
| `anthropic/*` | Pi's `/login` for Anthropic | Anthropic can charge requests to extra usage instead of plan limits |

For enterprise Claude accounts that require SDK access, select `claude-sdk/*`.
Pi's Anthropic `/login` does not configure this route.
Without an extra-usage budget, the direct OAuth route can fail with `400 Third-party apps now draw from extra usage, not plan limits`.
The SDK route does not bypass your organization's access controls or grant a Claude Code entitlement.
See Anthropic's [Agent SDK plan guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

1. If Claude Code is absent, install it with the [Claude Code instructions](https://code.claude.com/docs/en/setup).
   The native installer supports Linux and macOS:

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```

   On macOS, Homebrew is an alternative:

   ```bash
   brew install --cask claude-code
   ```

2. Sign in to the intended Claude account:

   ```bash
   claude auth login --claudeai
   ```

3. Check the active account:

   ```bash
   claude auth status --text
   ```

4. Start Mina from your project folder with the SDK provider:

   ```bash
   mina --model claude-sdk/claude-opus-5-5
   ```

On macOS, Claude Code keeps its login in the Keychain.
If macOS asks whether `claude` can use that login, select **Always Allow**.

Mina also supports separate work and personal Claude accounts.
Each profile has its own environment, session pool, transcripts, and usage display.
An account error does not send requests to the other account.
See [two Claude accounts](docs/models.md#two-claude-accounts).

This provider uses Claude Code account authentication, not Bedrock, Vertex AI, or Foundry credentials.
For other provider routes, see the [models guide](docs/models.md).

#### OpenAI Codex and other models

For Codex, start Mina with this model:

```bash
mina --model openai-codex/gpt-6.1-sol
```

Then type `/login` and select ChatGPT.
Other providers use Pi's API keys or model configuration.
The [models guide](docs/models.md#add-a-tuning-file-for-your-own-model) includes a local llama.cpp example.

To set the model for new sessions, add `MINA_MODEL` to your shell profile:

```bash
export MINA_MODEL=claude-sdk/claude-opus-5-5
```

Without `--model` or `MINA_MODEL`, Pi selects the model from its configuration and available sign-ins.
`mina --continue` and `mina --resume` keep the model that answered last in the saved session.
`mina --list-models` lists available models.

### 3. Install the research tools

From the Mina checkout, install the literature servers:

```bash
npm run literature:install
```

If the system Node.js or Python is too old, install private runtimes first:

```bash
npm run literature:runtime
npm run literature:install
```

These runtimes stay in the installation folder.
They do not replace system versions.
On macOS, the literature installer supplies its own Python automatically.

The installer includes PyMuPDF for PDF conversion.
PyMuPDF uses the GNU AGPL-3.0 license, not Mina's MIT license.
See [third-party notices](THIRD_PARTY_NOTICES.md).

For additional literature search sources, install SearXNG:

```bash
npm run searxng:install
```

SearXNG runs in Podman and listens only on `127.0.0.1:18080`.
It starts at login.
If no Podman VM exists on macOS, the installer creates one with a download of about 1 GB.
Mina works without SearXNG, but some searches then cover fewer sources.
See [SearXNG](docs/usage.md#searxng).

All research keys are optional.
Without keys, OpenAlex, PubMed, arXiv, and bioRxiv work.
Keys add Exa and Brave search, higher rate limits, and additional full-text sources.
The [keys and services guide](docs/usage.md#keys-and-services) lists the files and limits.

For goals without research tools, use `mina --lean`.

## A first session

1. Go to your project folder, not the Mina checkout or your home folder itself:

   ```bash
   cd ~/projects/report
   ```

2. Start Mina with your model:

   ```bash
   mina --model claude-sdk/claude-opus-5-5
   ```

3. Give the agent a goal:

   ```text
   /goal Add a command-line interface to report.py, with tests
   ```

The agent writes checks, does the work, and requests completion.
Mina runs the checks itself.
A failed check returns its output to the agent for another attempt.

For checks that the agent cannot change without approval, start the goal with `--protect-checks`:

```text
/goal Add a command-line interface to report.py, with tests --protect-checks
```

Long goals also depend on turn and token budgets.
The default limit is 25 automatic responses, including tool loops.
See [goal limits](docs/usage.md#when-a-goal-pauses) before unattended work.

## Features

### Goals with checks and human decisions

Mina keeps the goal and check results in the session.
The project's `.mina/` folder holds plans, check scripts, and research briefs.
The objective can be text or the path of an instructions file.

Mina supports these controls:

- **Working checks:** The agent can revise its checks. Your requirements remain binding.
- **Protected checks:** `--check "COMMAND"` or `--protect-checks` requires your approval. Later changes require an approved amendment.
- **Budgets:** A goal can have a token budget and limits on automatic responses.
- **Questions:** The agent can request a decision through a dialog with a recommendation and alternatives.
- **Operator procedures:** The agent records commands for steps that require a person. Approval does not run those commands.
- **Reopen:** `/goal reopen <reason>` reopens a completed goal with its existing checks.

Mina pauses a goal after three automatic runs with no observable progress.
It retries transient provider errors after 2, 5, and 15 minutes.

If the provider reports a usage reset time, Mina waits until that time plus one minute and resumes the goal.
This recovery keeps the selected provider, model, checks, and cumulative usage.
It does not switch accounts or providers to escape a limit.
Mina must remain open for automatic recovery.
Billing errors and unknown reset times leave the goal paused.

A passed check proves only what the check examines.
Mina does not automatically commission an independent reviewer or certify scientific results.
See [goals](docs/usage.md#goals).

### Long sessions with access to the original history

Mina prepares context summaries in the background.
Older turns become a checkpoint with references to the original entries (`event://N`).
Recent turns stay unchanged.
Long tool outputs can also shrink in the model's context.
The session file retains the original messages and tool outputs.

Near the context limit, Mina continues the goal in a new session with a handoff note, the plan, and the checks.
Broker jobs and monitors continue across the handoff.
Messages that you type during the handoff go to the new session.

The agent can retrieve details that a summary omits:

| Tool or command | Available history |
|---|---|
| `context_recall`, `/recall <query>` | The original history of the current session |
| `mina_recall` | The current session and earlier sessions in its handoff chain |
| `mina_subagents` | Retained reports from completed subagents |

Each model has context thresholds and optional tuning files.
Prompt modes control what Mina loads:

| Mode | Loaded resources |
|---|---|
| `--full` | Mina tools, research, your Pi skills, and the project's `AGENTS.md` and `CLAUDE.md` |
| `--fast` | Mina tools and research, without your skills or project instructions |
| `--lean` | Core tools, goals, compaction, and handoff, without research |

For local servers, Mina can reserve shared context memory for replies, compaction, and subagents.
It refuses subagents that exceed the configured pool budget.
This budget covers one Mina instance, not other clients of the server.
See [long sessions](docs/usage.md#long-sessions) and [model tuning](docs/models.md).

### Web and literature research

Mina combines web search with scholarly databases and access to open-access papers.
Search modes cover focused questions, recent work, field surveys, broad searches, and novelty searches.
The broker adapts queries for each database, combines rankings, and groups preprint and journal versions.
Coverage reports identify failed sources and searches with no results.

| Tool | Capability |
|---|---|
| `research_search` | Web search through Exa, SearXNG, and Brave |
| `web_fetch` | Public web pages as text |
| `literature_search` | Combined scholarly search, with coverage reports |
| `paper_resolve` | Paper versions, retractions, and corrections |
| `paper_get` | Question-relevant passages from open-access full text |
| `citation_expand` | References and papers that cite a study |
| `literature_db` | Direct read-only requests to PubMed, bioRxiv, arXiv, Semantic Scholar, or OpenAlex |
| `supplement_get` | Selected rows, sheets, archive members, or text from linked CSV, TSV, XLSX, ZIP, or PDF supplements |

Paper passages retain section, version, source, and completeness information.
The broker tries several open-access sources and labels partial text.
It does not bypass paywalls or guarantee full-text access.
Supplement retrieval records hashes and source information, but does not run macros or recalculate formulas.

Large research results remain available as read-only files that the agent can read in pages.
The files include hashes and explicit truncation notices.
Their handles work within the current Mina instance, including its subagents, but not after a restart.
See [retained tool results](docs/retained-tool-results.md) for retention limits.

The research skill requires full-text evidence for substantive claims and a novelty search before a novelty claim.
It records sources, searches, and coverage gaps in `.mina/briefs/`.
Titles and abstracts serve as selection aids, not substitutes for the paper.
The protocol treats fetched text as data, not instructions.

A novelty search records what Mina searched.
It does not prove that no related work exists.
These are instructions to the model, not guarantees that every answer follows them.

The literature servers have separate sandboxes and connection logs.
PDF conversion runs without network access.
See [research](docs/usage.md#research), [the literature broker](docs/literature/broker.md), and [supplements](docs/literature/supplements.md).

### A sandbox for agent commands

The sandbox is on by default.
Every agent command and file operation runs in a fresh sandbox with these resources:

- The project folder, writable
- Extra folders that you grant with `--sandbox-read PATH` or `--sandbox-write PATH`
- System software, read-only
- A private home folder for the Mina instance.

The sandbox hides host credentials, including SSH keys, cloud credentials, Claude logins, and research keys.
Commands have no host GPU devices, desktop access, or session bus.
A request for additional read access requires your approval.

Command network access has three modes:

| Flag | Access |
|---|---|
| `--sandbox-net open` | Public hosts on ports 80 and 443 through a proxy. Private, LAN, and loopback destinations stay blocked. This is the default. |
| `--sandbox-net packages` | Package sources only |
| `--sandbox-net offline` | No network for agent commands |

These flags govern commands, not the separate model and research connections.
Resource limits apply to each instance.
`mina status` lists instances, and `mina stop ID` stops an instance and its processes.

Mina also checks git storage at startup.
It refuses hard-linked git objects and git data outside the visible folders.
For local clones, `git clone --no-hardlinks SOURCE DEST` prevents shared objects.
`mina sandbox unlink-git-objects DIR` repairs existing hard links.
Worktrees and shared clones require explicit access to their source repository.

The sandbox has important limits:

- The agent can change or delete files in the project and other writable folders.
- Project data can leave through model requests, research tools, and permitted public web requests.
- Host workloads and `--nosandbox` sessions have separate, broader access.

See [the sandbox boundary](docs/sandbox.md) for the threat model and [sandbox usage](docs/usage.md#the-sandbox) for controls.

### Host operations and shared GPUs

The optional `mina-hostd` broker runs registered jobs outside the command sandbox.
It can manage service status, logs, restarts, GPU jobs, monitors, and alarms under a host policy.

To configure the broker, run this command in your terminal:

```bash
mina host setup
```

For each project, `mina host access` selects `look`, `ask`, `trusted`, or `none`.
The setup shows a policy diff before you approve it.
The agent cannot grant itself a project access level.
Agent proposals for other policy changes require approval of the exact diff.

Jobs share machine-wide lock files across projects.
They can queue for resources, retain output for later inspection, and report completion separately from output retrieval.
Monitors can deliver alarms to the conversation after a handoff.
Coordination covers one machine, not several machines on a network.

Host policies can pin scripts, validate parameters, limit job admissions, and require fresh deployments.
Admission budgets count job admissions and reserved time, not actual GPU usage or money.
Registered monitors can detect service failures, stale files, log patterns, and sensor thresholds.
External alarm delivery requires a configured notifier.

Direct git pushes are blocked in the sandbox.
A registered push job can use host authentication through a gate that refuses force pushes and scans for secrets with gitleaks.
See [host operations](docs/usage.md#host-operations), [host setup](docs/host-profile.md#set-up), and [shared GPUs](docs/host-profile.md#share-the-gpus-of-a-machine).

### Subagents

The agent can delegate to general workers, read-only reviewers, and researchers.
Up to four subagents run concurrently, with a limit of 64 launches per Mina instance.
Subagents run in the sandbox and have no host access.

Each role has an explicit tool set.
The parent can steer a running subagent and read its paged results.
Mina records their tool calls so that the parent can inspect evidence, not only their final reports.
Completed reports remain available after context compaction.
See [subagents](docs/usage.md#subagents) and [delegation](docs/delegation.md).

### No telemetry

Mina disables Pi install reports, automatic model-catalog downloads, and version checks during sessions.
For Claude SDK providers, it disables Claude Code telemetry, error reports, update checks, and connector-list requests.
It also removes inherited telemetry exporters.
PDF conversion disables onnxruntime telemetry and runs without network access.

Model requests still carry your conversation to the selected provider.
Claude Code still retrieves organization settings and policy limits.
Research tools send queries and identifiers to their target services and retrieve papers from publishers.
The footer shows provider usage limits and the answering model after a Claude refusal fallback.

Model catalogs update only on request:

```bash
mina update --models
```

This command retrieves model lists from `pi.dev` for providers with active sign-ins.
It does not select a new model for your session.

The live tests check network destinations.
The [privacy guide](docs/usage.md#privacy-and-network) describes the remaining gaps, including provider selection by subagents and compaction jobs.
No telemetry does not mean no network traffic or no data disclosure.

## Built on

Mina combines these projects with its own goal checks, handoffs, literature broker, sandbox, and host policy:

| Project | Role in Mina |
|---|---|
| [Pi](https://github.com/earendil-works/pi) | Agent loop, model providers, terminal UI, tools, and session storage |
| [pi-goal](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-goal) | Goal loop and continuation controls |
| [pi-hot-compact](https://github.com/cheetahbyte/pi-kit/tree/main/packages/pi-hot-compact) | Background context compaction and session recall |
| [pi-subagents](https://github.com/tintinweb/pi-subagents) | Delegation UI components and role presentation. Mina supplies the sandboxed child runtime and evidence records. |
| [pi-claude-subscription](https://github.com/jkeskikangas/pi-claude-subscription) and [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) | Claude Code authentication and model transport |
| [pi-web-search](https://github.com/ByteTrue/pi-package-mono/tree/main/packages/pi-web-search) and [rpiv-web-tools](https://github.com/juicesharp/rpiv-mono) | The basis of Mina's web-search adapter and page extraction |
| [PubMed MCP](https://github.com/cyanheads/pubmed-mcp-server), [arXiv MCP](https://github.com/cyanheads/arxiv-mcp-server), and [bioRxiv MCP](https://github.com/cyanheads/biorxiv-mcp-server) | Local adapters for scholarly databases and open-access text |
| [Semantic Scholar MCP](https://github.com/hy20191108/semantic-scholar-mcp) | Semantic Scholar search, citation links, and paper metadata |
| [SearXNG](https://docs.searxng.org/) and [Podman](https://podman.io) | Local meta-search service and its container runtime |
| [bubblewrap](https://github.com/containers/bubblewrap) and systemd | Linux isolation and resource limits |
| macOS Seatbelt and launchd | macOS isolation and process control |
| [PyMuPDF](https://github.com/pymupdf/pymupdf) and [PyMuPDF4LLM](https://github.com/pymupdf/pymupdf4llm) | PDF conversion in a separate sandbox |
| [gitleaks](https://github.com/gitleaks/gitleaks) | Secret detection in the optional git-push gate |

The literature tools use [PubMed](https://pubmed.ncbi.nlm.nih.gov/), [arXiv](https://arxiv.org/), [bioRxiv](https://www.biorxiv.org/),
[OpenAlex](https://openalex.org/), and [Semantic Scholar](https://www.semanticscholar.org/).
Mina calls the OpenAlex REST API directly. It does not require OpenAlex MCP authentication.
With configured keys, the web tools use [Exa](https://exa.ai/) and [Brave Search](https://brave.com/search/api/).
[uv](https://docs.astral.sh/uv/) installs the Python runtimes and literature packages.

Mina carries patches to the Claude provider and a fork of the web-search adapter.
The macOS sandbox also adapts rules from [OpenAI Codex](https://github.com/openai/codex) and [agent-safehouse](https://github.com/eugene1g/agent-safehouse).
See [vendor patches](docs/vendor-patches.md), [web-search attribution](adapters/pi-research-search/ATTRIBUTION.md), and [third-party notices](THIRD_PARTY_NOTICES.md) for origins and licenses.

## Documentation

| Guide | Contents |
|---|---|
| [Usage](docs/usage.md) | Modes, commands, goals, research, privacy, and troubleshooting |
| [Models](docs/models.md) | Provider selection, Claude accounts, local models, and context thresholds |
| [Sandbox boundary](docs/sandbox.md) | Trust assumptions, protections, limits, and stop procedures |
| [Host profile](docs/host-profile.md) | Setup, project access, GPU coordination, jobs, and monitors |
| [Delegation](docs/delegation.md) | Subagent evidence and reports |
| [macOS](docs/macos.md) | Native helpers, privacy permissions, and platform differences |
| [Architecture](docs/architecture.md) | Components, tuning keys, and trust boundaries |
| [Research infrastructure](docs/research-literature.md) | Literature services and data sources |
| [Literature broker](docs/literature/broker.md) and [supplements](docs/literature/supplements.md) | Full-text retrieval and supplementary data |
| [Threshold economics](docs/threshold-economics.md) | Context size, cached requests, and compaction costs |
| [Retained tool results](docs/retained-tool-results.md) | Access to large outputs |
| [Contributing](CONTRIBUTING.md) | Code layout, development tests, and change requirements |

## Development

```bash
npm run test:mina     # Mina tests
npm test             # All Node tests
npm run test:e2e     # Live sessions and network checks, using signed-in models
```

Tests that require bubblewrap, user namespaces, or a systemd user session skip without those facilities.
On slow hosts, `MINA_TEST_TIMEOUT_SCALE=3` extends timeouts for tests that use the real launcher.
See [CONTRIBUTING.md](CONTRIBUTING.md) for broker tests and development procedures.

## License

Mina uses the [MIT license](LICENSE).
Third-party components retain their own licenses.
The literature installer adds PyMuPDF packages under GNU AGPL-3.0.
SearXNG also uses GNU AGPL-3.0.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before distribution or service deployment.
