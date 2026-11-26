# Architecture

This document tells what Mina is, how its parts fit together, and why the design is as it is.
For daily use, read [the usage guide](usage.md). For the code layout and the tests, read [CONTRIBUTING.md](../CONTRIBUTING.md).

- [What Mina is and is not](#what-mina-is-and-is-not)
- [The parts](#the-parts)
- [Goals](#goals)
- [Compaction and handoff](#compaction-and-handoff)
- [Model tuning files](#model-tuning-files)
- [The trust boundary](#the-trust-boundary)

## What Mina is and is not

Mina is the [Pi](https://pi.dev) coding agent with layers on top. The layers add four things:

- Goals that end only when checks pass.
- Background compaction and a handoff to a new session.
- Scholarly and web research tools, with a research protocol.
- A sandbox for each command of the agent, and an optional broker for host operations.

Mina is not a fork of Pi. It does not change Pi's code, and plain `pi` stays available as a fallback.
Mina is not a supervisor that approves each step of the agent. The agent selects its own workflow. Mina controls authority and continuity.
A passed check is not an independent acceptance or a scientific qualification. It proves only what the check examines.

### The rule: normal Pi with layers

The `mina` command starts the Pi version that `package.json` pins. It starts Pi with these items:

- Your normal agent folder `~/.pi/agent`: sign-ins, `settings.json`, `models.json`, packages, agents, and skills.
- The folder that you are in, as the working folder.
- Mina's layers, added with Pi's own flags: `-e <path>` for each extension and `--skill <path>` for each skill.

Mina must not replace a Pi feature with its own version. `/model`, `/resume`, `/login`, and Pi's subcommands work as in Pi.
If you already load a package that Mina also carries, for example your own `pi-goal`, Mina does not load its copy. It tells you which copy it skipped.

The sandbox adds one exception to this rule. In the sandbox, Pi starts with `--no-extensions`, so executable project configuration (`.pi/` extensions, project prompt templates) does not load.
Mina then loads only its own explicit layers, and in `--full` mode also your global skills, read-only. The reason is simple: project code that loads into the trusted Pi process runs outside the sandbox.

## The parts

| Part | Where | What it does |
|---|---|---|
| Launcher | `bin/mina.mjs` | Selects the mode and the tuning file, opens the instance scope and the outer sandbox layer, opens a host session, and starts Pi with the layers. |
| Goal layer | `extensions/goal/` | Wraps the unmodified `pi-goal` package. It adds checks, check runs at completion, questions to the user, operator procedures, provider-error recovery, reset-aware usage recovery, and the no-effect guard. |
| Compaction | `extensions/compact/` | Wraps the unmodified `pi-hot-compact` package. It applies the thresholds of the live model, also after `/model`. |
| Handoff | `extensions/handoff/` | Writes the handoff packet, starts the successor session, holds typed messages, keeps the operator ledger, and gives `mina_recall`. |
| Research | `adapters/pi-research-search/`, `extensions/literature/`, `literature/` | `research_search`, `web_fetch`, the literature broker tools, `literature_db`, and `supplement_get`. See [research literature](research-literature.md). |
| Sandbox | `sandbox/`, `extensions/sandbox/`, `lib/instance-runtime.mjs` | The worker for each command and file operation, the protected check runner, and the systemd scope of the instance. See [the sandbox boundary](sandbox.md). |
| Subagents | `extensions/delegates/` | The `Agent` tool: bounded children with a fixed tool set and recorded receipts. See [delegation](delegation.md). |
| Host client | `extensions/host/` | The `mina_host` tool, the capability list in the system prompt, and alarm delivery. |
| Host broker | `host/` | `mina-hostd`, a user service outside the sandbox. It does only registered operations. See [the host profile](host-profile.md). |
| Identity and footer | `extensions/identity/`, `extensions/footer/`, `extensions/codex-usage/` | An `<identity>` section in the system prompt, the two-line footer, and the plan limits. |
| Claude provider | `vendor/` | A carried build of `pi-claude-subscription` that runs Claude through the Claude Agent SDK. See [vendor patches](vendor-patches.md). |

### How the parts fit

1. The launcher makes a new instance ID and a systemd scope for the instance. The scope holds the CPU, memory, and process limits.
2. Pi runs as the trusted controller inside an outer bubblewrap layer. This layer has a read-only root and a private `/tmp` and runtime folder.
3. Each command and file operation of the agent runs in a new worker. The worker is a second bubblewrap namespace that contains only the project, the declared folders, and read-only system software.
4. The workers reach the network only through an egress proxy that the controller runs (`lib/egress-proxy.mjs`). The proxy refuses private, LAN, and loopback addresses.
5. The research tools run in the controller. The literature servers run in their own bubblewrap sandboxes, each behind its own proxy.
6. The model provider runs in the controller. For `claude-sdk` models, the controller starts the Claude Code binary of the SDK.
7. If the project is registered with the host broker, the launcher binds only the broker socket folder and a grant file for this launch into the outer layer. The workers do not see them.

The agent cannot read Mina's own code from a worker, except its skills and Pi's documentation.
A gate whose source the agent can read is a gate that the agent can learn to satisfy without the work. Thus, a refusal from Mina must tell the agent what it needs.

## Goals

`/goal` uses the unmodified `pi-goal` package for the goal loop: continuation, pause, resume, and `goal_complete`.
Mina wraps only the `/goal` command, through a proxy of the extension API. Pi runs slash commands before its `input` hook, so a wrapper of the command is the only way to add flags.
Pi's `tool_call` hook lets Mina block `goal_complete` until the checks pass.

### Minimal goal prompts

A tuning file can set `goal_prompt: "minimal"`. Then the model gets the facts of the goal machinery, not instructions about how to behave:

- pi-goal repeats a rule block of about 2,700 characters with each continuation. Mina replaces it, in the copy that goes to the model, with one line.
- Mina's own goal instructions give only operational facts: the checks, `mina_checks`, `.mina/plan.md`, and how Mina judges completion.
- The session file keeps pi-goal's original text, because pi-goal finds its prompts by a marker and a fingerprint.

The reason is measured behavior. With the full rule block, one model spent most of the turns after each continuation in reading, and it ran no measurements until the user intervened.
Behavior is better left to the model and to the deterministic gates. This follows the spirit of Pi's own small prompt.

### Provider errors

When Pi's own retries of a provider error are exhausted, pi-goal parks the goal until someone resumes it. One transient error can then stop a run for hours.
Mina resumes such a goal after a backoff: 2, 5, and 15 minutes by default (tuning key `provider_retry.delays_s`). It tells the user at each attempt and stops after the last one.

For a usage-limit error (`usage_limited`), Mina waits for a reset time from the provider, then resumes the same goal.
Codex OAuth and Anthropic OAuth use their quota-free usage endpoints, including exhausted weekly limits and applicable model limits.
Claude SDK uses reset events from its own account, including configured account profiles. It reads no credentials and makes no usage request.
API models use explicit reset information in the error or a 429 response header, when the provider exposes it.

Mina adds one minute for clock differences and rounded reset times. Billing errors and unknown reset times leave the goal parked.

The session stores the pending deadline. Mina restores it when you reopen that session with `/resume`.
A handoff to a new session carries the deadline if the parked goal and the model still match.
Mina must remain open to resume automatically. It does not start a closed process.

Human input, a model change, session navigation, or `/goal pause` cancels the pending resume.
Subagent notifications and host alarms do not cancel the pending resume.
During a quota wait, Mina records broker alarms in the conversation and shows them to the operator without starting a model turn.
Before the resume, Mina checks the goal, model, idle state, and pending messages. The normal goal budgets and checks still apply.
The resume keeps the selected provider and model. This recovery never switches from Claude to Codex, or from one Claude account to another.

### The no-effect guard

pi-goal has two guards of its own: a limit on automatic replies (`automaticTurns`) and a limit on identical replies without tools (`noProgressTurns`).
A loop that calls tools but changes nothing passes both guards. A healthy goal that waits for long downloads can still hit the reply limit.
Thus, Mina adds a guard (`extensions/goal/stall.mjs`) that counts automatic runs without an effect outside the conversation. These are the effects:

- A successful `write` or `edit`.
- A change of git HEAD or of the set of changed paths. A change of file contents alone does not count, because broker jobs append to tracked logs.
- A broker workload that starts, stops, or is seen to end.
- A change to the checks or their results.

A run that ends in `goal_wait` while a known broker workload is live, and within its deadline, is neutral.
Runs that the user or an alarm started do not count. A new goal or a reset by the user sets the count to zero.
At `goal_stall_runs` runs (3 by default, `null` disables the guard), Mina pauses the goal and tells the agent why.

### Questions and operator steps

In goal mode, the agent cannot ask a question and stop: the end of a turn starts the next turn. Thus, `mina_ask_user` shows a dialog with the question, a recommendation, and two to four choices, and waits for the answer.
An answer applies to one exact question in one running instance. It does not give execution authority or more attempts.
An operator procedure (`operator_action`) gives exact commands, preconditions, expected output, and restoration steps. Mina never runs these commands. Your agreement only records that the procedure waits for you.

## Compaction and handoff

Mina uses the unmodified `pi-hot-compact` package for compaction. The launcher writes its settings for each model, and the compaction adapter reloads it after a model change.
Hot compaction starts at the compaction threshold. Its hard threshold is always before the handoff threshold, so a session compacts before it hands off.

A handoff occurs at the handoff threshold, or at the compaction threshold after `max_compactions` compactions.
It occurs only at a safe point: no tool runs and no queued input waits.
The agent writes a note with `mina_handoff_note`. Mina then starts a linked successor session with a packet of at most 16 KB: the note, the goal, the checks with their recorded results, the plan, and the research briefs.
A handoff does not run the checks again. A protected check whose script changed shows NOT RUN, not PASS.
If you change the objective with `/goal edit`, Mina carries the latest accepted objective. The operator ledger and approved checks stay with the goal. An objective edit discards recorded check results, not the checks.
The successor starts on the model and thinking level of the earlier session. The packet is a summary, not proof. For exact detail, the agent uses `mina_recall`.

Subagents run in the Pi process of the session, and a new session stops them. Thus, if subagents run when the note is recorded, the handoff occurs in place:

- At the next boundary of the run, Mina adds a compaction that keeps no earlier entries, and then the packet as a message. The packet also lists the running subagents with their IDs.
- The session, the pi-goal run of the goal, and the subagents continue. Their results arrive as usual.
- The count of compactions for the next handoff starts again after the handoff. Mina makes no handoff decision until the reset context has a size of its own.
- The next handoff that finds no running subagent starts a new session. Nothing waits for that time.

Only `/mina-handoff` asks for a new session. It waits for running subagents, or stops them with `force`.

### Continuity of the work in progress

After each compaction, Mina adds one message after the summary. It contains the goal and its checks, the operator ledger, and, at the end, the work in progress.
The work in progress is the latest message of the user, word for word, and the latest words of the agent.
The message tells the agent to continue that work. The goal restatement is a reminder, not a new start.
The reason: the model follows the last instruction in its context. An order to read the goal file again pushed an open request of the user aside.

The agent can select one active operator task with `mina_ledger` action `focus`.
The record links the task to the user’s words and stores a short next step or blocker.
Compaction and handoff show this record after the summary. A reopened session uses it on the next run without starting a turn.
New messages do not clear the selection. The user can still redirect the work. A closed or superseded task loses its selection.
The record does not start work on its own, verify a receipt, or grant access.

A recorded handoff note describes the session only at the time when the agent wrote it.
Thus `/mina-handoff` uses a recorded note only if no compaction and no model reply came after it, and no handoff used it.
Otherwise, the packet uses the automatic summary.
If the run that writes the note is interrupted, Mina asks for the note one more time.
If Mina stops between the note and the handoff, the next start asks you to finish the handoff with that note or to discard the note.

### The operator ledger

In a long run you steer through the conversation, not through the goal file. A summary paraphrases, and a paraphrase can weaken or drop an instruction.
The operator ledger keeps your instructions in your own words:

- Mina saves each message that you type, word for word, in the session file. Mina also saves each answer that you give to a question of the agent (`mina_ask_user`), with the question.
  An answer shows if you typed it or if you chose an option that the agent wrote. Messages from extensions and goal continuations are not saved there.
- The agent sorts the messages with `mina_ledger` into entries: directive, constraint, priority, task, or fact. Each entry quotes its message. Mina refuses a quote that is not in the message. The reading of the agent is a separate field.
- After each compaction and in each handoff packet, Mina restates the active entries and the unsorted messages word for word. The packet size limit does not apply to them.
- An entry ends only when a later message of yours replaces it. The agent must quote that message. A task also ends when the agent records the evidence that it is done.
- If an entry seems to conflict with another entry or with the goal text, the agent records the conflict. Mina then asks you. Your answer is saved as a message, and it decides which entry stands.
  If no terminal is available, the entry stays disputed. When you answer later, for example to `mina_ask_user`, the agent settles the entry. It must quote your answer.
- The ledger belongs to the goal. A new goal starts an empty ledger.

The goal text and its checks stay the acceptance bar. No ledger entry relaxes a protected check.
The session file is the store. Mina writes a copy to `.mina/operator-ledger.md` for you to read.
Mina never reads that file back. If it changed outside Mina, Mina moves the changed copy aside and tells you. To change the ledger, use `/mina-ledger`.

## Model tuning files

A tuning file sets the behavior of Mina for one model. The file name is `<provider>__<model id>.json`, with each `/` in the model ID replaced by `_`.
Mina looks for the file in these folders, in this order:

1. `$MINA_MODELS_DIR`, else `~/.config/mina/models/`.
2. The `models/` folder of the repository.

A Claude account profile (`claude-sdk-<profile>`) uses the `claude-sdk` file of the same model, unless the profile has its own file.
`MINA_TUNING_FILE=path.json` replaces the tuning file for one launch.
A model without a tuning file uses the defaults in the table that follows.

| Key | What it sets | Default |
|---|---|---|
| `model` | The `provider/id` that the file is for. Information only. | None |
| `context_window` | The context window in tokens, for the launcher. In a session, the window that Pi reports for the running model takes priority. | From Pi |
| `default_mode` | `full`, `fast`, or `lean`. A flag overrides it. | `full` |
| `compact_at_tokens` | The compaction threshold. | 40% of the window, maximum 250,000 |
| `handoff_at_tokens` | The handoff threshold. | 60% of the window, maximum 350,000 |
| `max_compactions` | The number of compactions before a handoff at the compaction threshold. | 2 |
| `hot_compact` | Settings for pi-hot-compact, for example `startPercent`, `hardPercent`, `jobTimeoutMs`, `debug`. They override `~/.pi/agent/hot-compact.json`. | None |
| `goal_prompt` | `"minimal"` gives the model only the facts of the goal machinery. | Full instructions |
| `goal_stall_runs` | Automatic runs without effect before Mina pauses a goal. `null` disables the guard. | 3 |
| `provider_retry` | `{ "delays_s": [...] }`: the waits before Mina resumes a goal after a provider error. | `[120, 300, 900]` |
| `collapse_tool_outputs` | `"with_compaction"` collapses old tool outputs only together with a compaction. | pi-hot-compact collapses them at any turn |
| `keep_reasoning_turns` | Keeps reasoning blocks only in the last N assistant messages of each request. | All |
| `pool` | The shared memory of a local server: `tokens`, `reply_reserve_tokens`, `compaction_reserve_tokens`, `subagent_reserve_tokens`. | None |

Keys that end in `_note` are comments. Mina ignores them.
[The models guide](models.md#add-a-tuning-file-for-your-own-model) tells how to add a file for your own model.

## The trust boundary

Mina has a trusted control plane and an untrusted tool plane.

- **The trusted control plane** holds credentials, approval records, budgets, the protected check snapshots, and the verification policy.
  It includes Pi, Mina's layers, the model provider, the research tools, and the host broker.
- **The untrusted tool plane** runs repository code, package installation scripts, commands that the model writes, and the tool calls of subagents.
  It runs in the workers.

Only explicit capabilities connect the two planes: the declared folders, the network level, and the registered host operations.
The tool plane gets the same file, credential, process, IPC, device, and network limits in each place where it runs: the main agent's commands, the subagents, and the checks.
Your configuration and the installed extensions stay outside the agent's write access.
Code in the project must not become trusted code at a reload or a restart.

A registered broker capability does not open the same access for the ordinary shell.
For example, a GPU workload that the broker runs does not give every command access to the GPU devices.

### Why git is not sufficient recovery

Git can restore committed, tracked files while its object store and references are intact. It does not restore other things:

- Uncommitted work, untracked files, ignored artifacts, databases, and large raw data.
- The `.git` folder itself. The agent can change `.git` in a writable checkout. A linked worktree also shares metadata outside its folder.
- Effects outside the computer: a network request, a leaked secret, a hardware change, a charge for resources, or a published conclusion.

Recovery needs a protected copy outside the agent's write access. A copy must not share writable hard-linked inodes with the original.
Publication, for example a push, is a separate permission from local edits and local commits. In Mina, a push goes through the [push gate](host-profile.md#pushing).

### Rules that the design keeps

- The authority of a subagent is never more than the authority of its parent.
- Budgets of an instance count all attempts. A new goal, a retry, a model change, or a handoff does not reset them.
- A protection that is not available causes a refusal, not a silent fallback. For example, without bubblewrap the sandbox refuses to start.
- Policy and approval records stay outside the agent's write access.
- The end of an instance does not stop broker jobs or start a destructive cleanup. A job continues under its own deadline.
- Open operator duties, for example a restoration procedure, stay visible across handoffs.
- Uncertainty does not become success. For example, after a broker restart, an unknown budget blocks new launches.
- A human decision concerns a real change of scope or consequence, not a routine action inside the approved scope.

Mina does not yet give capability grants for a full instance. A registered host operation with `allow` applies to each session of the project.
