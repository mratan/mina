# Models

Mina works with every model that Pi can use. This guide tells how Mina selects a model, how it sets the context
thresholds for each model, how to tune Mina for your own model, and how to use Claude through one or two Claude Code accounts.

## Select a model

Mina has no built-in default model. A new session starts on the first model in this list:

1. The `--model` option.
2. The `MINA_MODEL` environment variable.
3. Pi's own default: `defaultProvider` and `defaultModel` in `~/.pi/agent/settings.json`. In Pi, `/model` and `Ctrl+S` save this default.
4. If none of these is set, Pi selects the model: the standard model of a provider that you signed in to, else the first available model. With no sign-in, type `/login`.

```bash
mina --model claude-sdk/claude-opus-5-5          # one session
export MINA_MODEL=openai-codex/gpt-6.1-sol        # the default for every new Mina session
```

- `mina --continue` and `mina --resume` keep the model that answered last in the session.
- To move an open session to a different model, add `--model`: `mina -c --model claude-sdk/claude-opus-5-5`.
- In a session, `/model` changes the model. Mina then applies the thresholds of the new model.
- `mina --list-models` lists the models that your sign-ins make available.

Mina uses the sign-ins and model definitions of Pi in `~/.pi/agent`. To sign in to a built-in provider, type `/login` in Mina or Pi.

| Provider | Sign-in | Plan limits |
|---|---|---|
| `openai-codex/*` | `/login` (ChatGPT) | The ChatGPT plan |
| `claude-sdk/*` | The local Claude Code login (`claude auth login --claudeai`) | The Claude plan of that login |
| `anthropic/*` | `/login` (Pi's own Anthropic OAuth) | Anthropic can bill this route as extra usage |
| Other providers | As in Pi (`~/.pi/agent/models.json`, API keys) | As the provider sets |

## Context thresholds

Mina compacts the context when it grows, and hands off to a new session when it is nearly full ([usage guide](usage.md#long-sessions)).
The thresholds come from the context window of the model: compaction at 40% and handoff at 60%.
The caps are 250,000 tokens for compaction and 350,000 tokens for handoff.
Every request carries the full context, so past these caps the cached re-reads cost more than the compactions ([threshold economics](threshold-economics.md)).

A tuning file can set the default mode, the context window, and explicit thresholds for one model.
The repository includes these tuning files:

| Model | Default mode | Window | Compaction | Handoff |
|---|---|---|---|---|
| `openai-codex/gpt-6.1-sol` | `--full` | 500,000 | 200,000 tokens | 265,000 tokens (less than the 272K price tier of the API) |
| `claude-sdk/claude-opus-5-5` | `--full` | 1,000,000 | 250,000 tokens | 350,000 tokens |
| `claude-sdk/claude-haiku-5-5` | `--full` | 1,000,000 | 70,000 tokens | 95,000 tokens (less than the 100K price tier of Haiku) |
| Other models | `--full` | From Pi | 40% of the window, maximum 250,000 | 60% of the window, maximum 350,000 |

The Claude tuning files set `collapse_tool_outputs`, because each collapse alone makes the provider rebuild its Claude Code session without the prompt cache.

### Tuning files

The file name is `<provider>__<model id>.json`. Mina looks for it in these folders, in this order:

1. `$MINA_MODELS_DIR`, else `~/.config/mina/models/`.
2. The `models/` folder of the Mina checkout.

Thus, your own file replaces the file of the repository for the same model.
The Claude account profiles (`claude-sdk-<profile>`) use the `claude-sdk` file of the same model. A file for a profile, if it exists, replaces the shared file.
`MINA_TUNING_FILE=path.json` replaces the tuning file for one launch, for experiments.
`mina --mina-dry-run` shows which tuning file applies.

[The architecture](architecture.md#model-tuning-files) lists all keys and their defaults.

### Compaction details

Hot compaction starts at the compaction threshold. It must commit a checkpoint before the handoff threshold.
At the hard threshold, it stops waiting for a model summary and commits a deterministic checkpoint at the next turn boundary.
Without explicit percentages, Mina derives the start from the compaction threshold.
Mina sets the hard threshold at the midpoint toward the handoff threshold, always before the handoff.
The job log of the compaction engine, with the reason for each failed job, is in `~/.pi/agent/hot-compact.log`.

Mina records each compaction, failed compaction job, handoff, and session in `~/.cache/mina/metrics.jsonl`.
This file stays on your machine. `node scripts/metrics-summary.mjs` gives a summary for each model.
Use these measurements to set the thresholds of a tuning file.

## Add a tuning file for your own model

This example uses a local model on a llama.cpp server. The same steps apply to other providers.

1. Start the server with its OpenAI-compatible endpoint, for example `llama-server -m model.gguf -c 131072 --port 8080`.

2. Define the model in `~/.pi/agent/models.json`, as for plain Pi:

   ```json
   {
     "providers": {
       "my-llama": {
         "baseUrl": "http://127.0.0.1:8080/v1",
         "api": "openai-completions",
         "apiKey": "none",
         "models": [{ "id": "my-model", "contextWindow": 131072 }]
       }
     }
   }
   ```

3. Make the folder for your tuning files:

   ```bash
   mkdir -p ~/.config/mina/models
   ```

4. Write `~/.config/mina/models/my-llama__my-model.json`:

   ```json
   {
     "model": "my-llama/my-model",
     "context_window": 131072,
     "default_mode": "fast",
     "compact_at_tokens": 50000,
     "handoff_at_tokens": 80000,
     "keep_reasoning_turns": 3
   }
   ```

5. Show the plan without a start of Pi:

   ```bash
   mina --model my-llama/my-model --mina-dry-run
   ```

6. Start Mina with the model, and measure. After some sessions, run `node scripts/metrics-summary.mjs` and adjust the thresholds.

These choices suit a local model:

- **`--fast` or `--lean`.** A local model reads its first prompt slowly. `--fast` leaves out your own skills and the project's `AGENTS.md` and `CLAUDE.md`. `--lean` also leaves out the research tools.
- **Lower thresholds.** A smaller context makes each request faster on a local server, and it leaves room in the server memory for compaction jobs and subagents.
- **`keep_reasoning_turns`.** Some chat templates put the reasoning of each earlier turn into the prompt. Then old reasoning can fill a large part of the context, and compaction frees less.
  This key keeps reasoning only in the last N assistant messages of each request. The session file keeps all of it. The cost is one break of the prompt cache for each turn.
- **`hot_compact`.** If single turns are large compared to the gap between the start and the hard threshold of compaction, a model-written summary often cannot finish in time.
  A lower `startPercent` gives the summary job more room. A slow server can also need a longer `jobTimeoutMs`.

## A local model on a shared server

Some local inference servers have N slots that share one memory pool (KV cache).
The session, its replies, a background compaction job, and each running subagent then share this pool.
If the requests in flight together use more than the pool, the server stops all of them.

The `pool` key of a tuning file tells Mina about this memory:

```json
"pool": {
  "tokens": 131072,
  "reply_reserve_tokens": 20000,
  "compaction_reserve_tokens": 20000,
  "subagent_reserve_tokens": 20000
}
```

Mina then keeps room in the pool for one reply, one compaction job, and each running subagent:

- The context of the session can use at most `tokens` minus the reserves. Each running subagent lowers this cap by its reserve.
- Mina hands off earlier while subagents run.
- Mina refuses a subagent that does not fit.
- Mina waits for running subagents before a handoff.

In the example, the cap is 91,072 tokens without subagents, 71,072 with one, and 51,072 with two.
Mina cannot see other Mina instances or other clients of the server. Thus, run only one Mina instance at a time on such a server.

## Claude through the Claude Agent SDK

`claude-sdk/*` models run through the carried `pi-claude-subscription` package and the Claude Agent SDK.
The SDK uses the local Claude Code login, so requests count against the plan limits of that login.
Mina carries local patches to this package ([vendor patches](vendor-patches.md)).

To change the default account:

1. Sign in: `claude auth login --claudeai`.
2. Show the account: `claude auth status --text`.
3. Restart Mina and Pi.

The trusted controller of Mina can write the Claude Code state (`~/.claude`, `~/.claude.json`). The agent's commands never see it.

### Two Claude accounts

Account profiles give two Claude accounts at the same time, for example a work account and a personal account.
Only your own configuration in `~/.pi/agent/claude-sdk.json` can add profiles. A project cannot select them.

1. Make a private folder for the second login:

   ```bash
   mkdir -p -m 700 "$HOME/.claude-personal"
   ```

2. Sign in to the second account:

   ```bash
   CLAUDE_CONFIG_DIR="$HOME/.claude-personal" claude auth login --claudeai
   ```

3. Show both accounts:

   ```bash
   CLAUDE_CONFIG_DIR="$HOME/.claude-personal" claude auth status --text
   claude auth status --text
   ```

4. Add the profiles to `~/.pi/agent/claude-sdk.json`. Replace `/home/YOU` with the absolute path of your home folder.
   Keep the other fields of the file.

   ```json
   {
     "profiles": [
       { "id": "work", "name": "Work", "configDir": "/home/YOU/.claude" },
       { "id": "personal", "name": "Personal", "configDir": "/home/YOU/.claude-personal" }
     ]
   }
   ```

   The IDs and names are examples. Select your own.

5. Restart Mina and Pi. In `/model`, select `claude-sdk-work/claude-opus-5-5` or `claude-sdk-personal/claude-opus-5-5`.
   All Claude models have an entry for each account.

Each profile has its own process environment, session pool, transcripts, and resume anchors.
The controller can write the profile folders, and the agent's commands do not see them.
A profile folder must be in your home folder, outside the Mina and Pi folders.
If the sign-in or the quota of one account fails, no request goes to the other account.

- Do not export `CLAUDE_CONFIG_DIR` globally.
- Do not put credentials in `claude-sdk.json`.
- Keep work that must stay in one account in separate sessions. When you change the account in a session, the conversation goes to the new account.

To remove an account, remove its profile from `claude-sdk.json` and restart Mina and Pi.
The login folder and the saved transcripts stay on disk.

## Plan limits in the footer

The footer shows the plan limits of the sign-in of the session:

| Provider | Footer | Source |
|---|---|---|
| `openai-codex/*` | `Codex 5h … · wk …` | The usage endpoint of the sign-in. It uses no model quota. |
| `anthropic/*` | `Claude 5h …` | The usage endpoint of Pi's Anthropic sign-in. |
| `claude-sdk/*` and its profiles | `Claude Code 5h …`, one line for each account | The limits that Claude Code sends with its replies. The line shows after the first reply of a session. |

Anthropic can send requests from Pi's own Anthropic OAuth to extra usage instead of plan limits.
If the account has no extra-usage budget, requests fail with `400 Third-party apps now draw from extra usage, not plan limits`.
Use `claude-sdk/*` for plan limits.

The `claude-sdk` route can show the same error when the request does not carry the Claude Code system prompt of the provider.
An extension that returns a complete `systemPrompt` from `before_agent_start` causes this: Pi then uses that prompt and drops the prompt options of all other layers.
Mina's own layers add prompt sections and never replace the system prompt. Extensions that you load must do the same.
