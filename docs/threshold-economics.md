# Compaction thresholds and plan usage

Compaction and handoff default to 40% and 60% of the context window, capped at 250K and 350K tokens.
This document gives the reason for the caps.

- Claude Opus 5.5 (1M window) compacts at 250K and hands off at 350K.
- `gpt-6.1-sol` (500K window) compacts at 200K and hands off at 265K, below its 272K API price tier.
- A local model on a shared server uses the values of its tuning file ([models](models.md#a-local-model-on-a-shared-server)).

Every request carries the full context. Past a certain size, the cached re-reads of a large context cost more than the compactions and handoffs that a smaller threshold causes.

## What plan usage costs

Neither provider publishes how subscription usage is counted. The best-supported model is cost-weighted usage with discounted cache reads.

| Source (fetched 2026-10-17) | Fact |
|---|---|
| platform.claude.com/docs/en/about-claude/pricing.md | Opus 5.5 per 1M tokens: input $4, 5-minute cache write $5, 1-hour cache write $8, cache read $0.20, output $20 |
| same | "Claude 4.6 and later models (except Claude Haiku 5.5)… include the full 1M token context window at standard pricing" |
| support.claude.com 9797557 | "cached portions count less against your limits than new content" (no weight given) |
| code.claude.com/docs/en/prompt-caching.md | Claude Code uses the 1-hour cache for the main conversation within a plan's included usage |
| developers.openai.com/api/docs/models/gpt-6.1-sol.md | `gpt-6.1-sol` per 1M: input $2, cached $0.10, output $10. Prompts over 272K input tokens: "2x input and cache rates and 1.5x output for the full request" |
| learn.chatgpt.com/docs/pricing.md | Codex credits for `gpt-6.1-sol`: 50 / 2.5 / 250 per 1M input / cached / output, no cache-write charge, no long-context tier listed. "Credit prices alone don't determine included subscription usage" |

A calibration on one plan window agreed with cost-weighted usage: the share of the window that the requests used matched their cost at API prices.
The value of one percent depends on the plan. If you need absolute numbers, calibrate it for your own plan.

## Model

`scripts/threshold-economics.py` simulates sessions from parameters measured in long agentic sessions, one on each model. The values are in `scripts/threshold-economics.json`:
- context growth per request: 2.6K (Claude), 1.9K (`gpt-6.1-sol`);
- output per request: 1.0K and 0.5K;
- a fresh session starts at about 40K and re-reads about 50K of inputs;
- compaction leaves about 38K + 25% of the context. Its summary request reads the whole context without a cache hit;
- after two compactions, the session hands off at the compaction threshold.

Each request re-reads the previous context from cache and writes its new tokens. Costs are compared per 1,000 work requests.

## Results (relative to 160K)

| Opus 5.5 case | 160K | 200K | 250K | 300K | 400K |
|---|---|---|---|---|---|
| Measured workload, API-equivalent | 1.00 | 0.94 | 0.93 | 0.94 | 0.99 |
| Summary request hits the cache | 1.00 | 0.98 | 0.99 | 1.03 | 1.13 |
| No reorientation after handoff | 1.00 | 1.00 | 1.02 | 1.06 | 1.15 |
| Reorientation of 100K | 1.00 | 0.86 | 0.80 | 0.79 | 0.81 |
| Growth at the median (1.6K) | 1.00 | 0.96 | 0.96 | 0.99 | 1.07 |
| Cache reads not counted | 1.00 | 0.88 | 0.81 | 0.77 | 0.73 |

At 250K, compactions and handoffs fall by half, from 32 and 16 to 16 and 8 per 1,000 work requests.
Across the cases, 250K is at most 2% worse than the best point.

| `gpt-6.1-sol`, Codex credits | 160K | 200K | 250K | 300K |
|---|---|---|---|---|
| Documented credit card | 1.00 | 1.00 | 1.05 | 1.11 |
| If the API 272K tier also applied | 1.00 | 1.00 | 1.05 | 1.44 |

Cheaper output makes cached re-reads matter more for `gpt-6.1-sol`, so its cheapest point is lower. 200K costs the same as 160K with 30% fewer interruptions.

## Limits

The weights inside the subscription windows are inferred, not documented. The model leaves out latency and long-context quality.
It also assumes that the hot compaction summary misses the cache. Rerun the simulation with new measurements when the workload changes.
`~/.cache/mina/metrics.jsonl` records compactions, handoffs and session baselines; transcripts record per-request token usage.
