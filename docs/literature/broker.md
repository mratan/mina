# Unified literature broker

The broker gives a Pi agent four tools for scholarly literature. It hides the provider work: which databases to ask, how
to word the query for each one, how to merge duplicates and versions, which full-text source to trust. It keeps the
provenance of every result.

| Tool | Use it to |
| --- | --- |
| `literature_search(query, mode)` | find papers, with a coverage report |
| `paper_get(ref, depth, query)` | read a paper: the passages that answer a question, by default |
| `paper_resolve(ref)` | identify a paper: its versions, lineage, retraction and correction status |
| `citation_expand(ref, direction)` | list a paper's references or citing papers |

The design comes from a retrieval evaluation of the literature servers. This document gives the measured reasons where they matter.
`literature_db` sends one allowlisted, read-only operation to one database. It is registered beside the four broker tools.

## Where it lives

```text
adapters/pi-literature-broker/index.js   the four tool schemas
extensions/literature/                   the Mina extension: the broker tools, literature_db, supplement_get
literature/broker/
  index.mjs      createBroker(): the four functions; citation_expand
  search.mjs     literature_search: routing, waves, families, fusion, expansion, selection, coverage
  resolve.mjs    paper_resolve: authority routing, lineage, retraction/correction
  get.mjs        paper_get: depths, the full-text acquisition chain
  expand.mjs     citation expansion primitives
  query.mjs      field classification and per-backend query forms
  family.mjs     work families and lineage confidence
  rank.mjs       rank fusion, role labels, coverage-aware selection
  validate.mjs   the broker's own completeness validator
  text.mjs       representations → documents with section offsets; arXiv HTML → text; LaTeXML bibliographies
  passages.mjs   BM25 passage index with section provenance
  runtime.mjs    cache, log, timeouts, pacing, health, OpenAlex budget
  providers.mjs  the live backends (the existing MCP servers, OpenAlex REST, research_search's Exa/SearXNG)
  format.mjs     the text the model sees
literature/lib/  identifier normalization and representation analysis
```

The five literature servers are also available through `literature_db`, for an operation that the broker does not offer.

## Search modes

| Mode | What it does | Backends (beyond the field core) |
| --- | --- | --- |
| `standard` | focused discovery; one ranked list | the field core |
| `landscape` | methods landscape and state of the art: two-hop citation expansion, named-method searches, grouped output | core (+ OpenAlex keyword for ML/CS) |
| `recent` | a date window (default: the last 12 months) | + Europe PMC (biomedical, general), arXiv newest-first (ML/CS, computational biology), bioRxiv/medRxiv only for a window of 3 months or less |
| `comprehensive` | every backend, several formulations, one hop of citation expansion | + Europe PMC, arXiv, SearXNG, Semantic Scholar when enabled and healthy |
| `novelty` | comprehensive + preprint servers + named-method searches + an absence statement | + arXiv, bioRxiv/medRxiv |

**Field core** (`field="auto"` infers it from the query's vocabulary):

| Field | Backends | Query form |
| --- | --- | --- |
| biomedical | Exa, OpenAlex semantic, OpenAlex keyword, PubMed | sentence → Exa and OpenAlex semantic; keywords → the others |
| computational biology | as biomedical; Semantic Scholar optional after the keyed rerun | as biomedical |
| ML/CS | Exa, OpenAlex semantic, arXiv | arXiv gets `all:t1 AND all:t2` |
| general | as biomedical | as biomedical |

Why: in the evaluation, Exa, OpenAlex and PubMed were the core; SearXNG added 66 relevant papers and no sentinels
over everything else; direct bioRxiv search added little over Europe PMC/OpenAlex for freshness; arXiv matters for ML/CS
and recency.

## Query transformation

Every backend gets its own form, and every form sent is recorded in `coverage.queries_executed`:

- **Semantic engines** (Exa, OpenAlex semantic): the question as written.
- **Lexical engines** (OpenAlex keyword, PubMed, Europe PMC, SearXNG, bioRxiv): compact keywords. A sentence collapsed
  their precision (OpenAlex keyword P@20 0.51 → 0.14). OpenAlex gets no wildcards.
- **arXiv:** `all:t1 AND all:t2`. A bare sentence is OR-ed by the arXiv API.
- **Synonyms:** pass `synonyms: [["persister","dormant cells"]]` and lexical engines also get an OR-formulation.
- **comprehensive / novelty:** at least three formulations (sentence, keywords, synonyms or a short core), plus a
  feedback formulation built from the title terms the semantic engines' top results share and the query lacks. This is
  deterministic terminology expansion; no model call.

You can pass your own `keywords`; they are used as given.

## Landscape mode

Search relevance is not scientific importance. Engines rank papers whose titles echo the question; the field-defining
methods often do not. In the evaluation, agents retrieved those papers and then dropped them. Landscape mode
compensates:

1. Run the field core.
2. Pick anchors among the top results: up to three reviews or benchmarks, and central primary methods.
3. Expand each anchor: its references (OpenAlex; for arXiv papers, the paper's own LaTeXML bibliography, because
   OpenAlex arXiv records carry no reference lists), PubMed references for PMID-bearing anchors, and citing papers of the
   method anchors.
4. Count, for each candidate, how many anchors reference it.
5. Search for method names the neighborhood mentions but no result introduces (`Name: …` titles, tool-like names in
   anchor abstracts).
6. Group, fuse, label roles, and select with reserved capacity.

**Roles** (each with `role_signals` you can inspect):

| Role | Evidence |
| --- | --- |
| `seminal` / `foundational` | referenced by ≥ 3 anchors, or by ≥ 2 and highly cited within the candidate set, and on topic. Never from age or citation count alone. |
| `review`, `benchmark` | publication type and title wording |
| `current_method` | introduces a named method ("Name: …", "we present / introduce / propose") |
| `recent_development` | published within the last two years |
| `application` | applies a method rather than introducing one |

**Selection** reserves capacity: foundational 30 %, benchmarks and reviews 20 %, current methods 30 %, recent 20 %; the
rest by fused score. Output is grouped in that order.

## Rank fusion

Reciprocal-rank fusion (k = 60) over work families, one vote per backend: a family's best rank in each backend across all
formulations. The same article seen by three databases is one family with three votes. Citation-expansion lists vote at
half weight; they are not relevance rankings. Retracted papers are demoted (× 0.3) unless the query names them. Each
result shows its fusion parts.

## Coverage report

Every search returns `coverage`:

- `backends_attempted`, `backends_succeeded`, `backends_failed` (with reason: `rate_limited`, `budget_exhausted`,
  `timeout`, `error`, `skipped_unhealthy`), `backends_not_routed` (with the reason they were not used);
- `queries_executed`: backend, formulation, the exact query sent, outcome, results returned, total, latency;
- `searches_with_zero_results`: searched and found nothing, kept apart from backends that never ran;
- `expansion`: anchors, edges, kept candidates, named-method searches;
- `candidates`: raw records, families, returned, overflow; `exa_mode`; `semantic_scholar` state; OpenAlex budget;
- `coverage_notes`; in `novelty` mode an `absence_statement` that lists what was searched.

## Work families

A family groups the records of one research work: preprint versions, the version of record, the database records of
each. It counts as one study.

| Link | Source | Confidence |
| --- | --- | --- |
| `same_record` | identifiers on one record (DOI + PMID) | authoritative |
| `preprint_of` | bioRxiv API published DOI; PubMed UpdateOf | authoritative |
| `preprint_of` | arXiv journal DOI; OpenAlex listing the preprint as a location of the work | strong |
| `preprint_of` | exact title (≥ 30 characters), years within 2, preprint server ↔ journal | probable |
| `same_title_unverified` | exact title otherwise (two journal records, a Zenodo or figshare deposit) | not merged, reported |
| `corrected_by`, `retracted_by` | PubMed ErratumIn / RetractionIn | authoritative |

The canonical record is the version of record when one exists, else the latest preprint version. Records with no
persistent identifier (web results) join a family by exact title.

## Identity resolution

| Input | Authority | Then |
| --- | --- | --- |
| arXiv id (± version) | arXiv | OpenAlex only when its title matches arXiv's; otherwise a reported `conflict` |
| PMID, PMCID | NCBI (ID converter, PubMed record) | OpenAlex; retraction, corrections, UpdateOf links |
| bioRxiv/medRxiv DOI (± version) | bioRxiv API (versions, published DOI) | OpenAlex; a PubMed exact-title search when the API lists no publication (probable) |
| DOI | OpenAlex record, else doi.org metadata | PubMed retraction/corrections; preprint versions from OpenAlex locations and Europe PMC, confirmed by the bioRxiv API |
| OpenAlex id | OpenAlex | as DOI |
| `s2:` id | Semantic Scholar (when enabled) | re-resolved by its DOI/arXiv/PMID |
| URL | identifiers in the URL, else the page's `citation_*` meta tags | as above |
| title | OpenAlex title search, retracted works included | ambiguous titles return candidates, not an answer |

`confidence`: `exact` (a second source agrees), `single_source`, `title_match`, `ambiguous`, `conflict`.

## Reading papers: `paper_get`

| Depth | Returns |
| --- | --- |
| `metadata` | the family, identifiers, versions, status, abstract, and the full-text representations known from metadata. Downloads nothing. |
| `evidence` (default) | BM25 passages for `query`, ≤ 6,000 characters, k ≤ 8 (in the evaluation, 94 % correct answers against 96 % for the full text, at a twelfth of the tokens). Each passage: `section`, `subsection`, `section_path`, `offset_start`/`offset_end` into the representation text, `representation`, `version`, `source_tier`, `completeness`. `exclude` gives the next passages. |
| `sections` | the sections you name (titles or ids from `section_outline`). Never chosen for you: keyword-chosen sections answered only half the questions. |
| `full` | the whole representation, paged (`offset`, `max_chars` ≤ 100k), with the section outline. |

A passage's section comes from the representation's own headings. When a representation has none, `section` is null
and `section_status` is `unavailable`.

### Full-text acquisition order

| Tier | Source | Notes |
| --- | --- | --- |
| 1 | PMC / Europe PMC structured article (`pubmed_fetch_fulltext`) | JATS sections |
| 2 | Native preprint text: arxiv.org/html → clean text (ar5iv when there is no HTML; `arxiv_read_paper` with markup stripped as fallback); bioRxiv/medRxiv article page (paced 20 s) | math kept as `$latex$` |
| 3 | OpenAlex-hosted copy: PDF → text preferred; GROBID TEI only without a PDF, and validated | USD 0.01 per file |
| 4 | Unpaywall copy returned by the PubMed chain | accepted only after validation |
| 5 | Other open-access PDFs OpenAlex lists (repository and author copies), and the arXiv PDF | no guessed URLs |
| – | `FULLTEXT_UNAVAILABLE` | with every tier tried and why |

Every tier's text goes through the broker's validator; the first `complete` or `likely_complete` text wins. A `partial`
text is used only when nothing better exists, and is labelled.

**Archive and author copies.** Accepted: author manuscripts and institutional or repository copies that OpenAlex
lists as open-access locations. Not used in this version: web archives (the provenance is rarely clear), guessed URLs,
authenticated routes, anything that works around a publisher's access control.

### Completeness states

The broker never trusts a provider's "full text" label; the label is recorded as `claim`.

| State | Meaning |
| --- | --- |
| `complete` | methods-like and results-like sections, a discussion/conclusion, > 15k body characters |
| `likely_complete` | methods-like and results-like sections, > 8k body characters |
| `partial` | body text, but missing major sections, short, or < 50 % of an alternate copy's length |
| `landing_page` | a landing or record page, a cookie/JavaScript interstitial, navigation-heavy HTML, or abstract + references only. Rejected; the chain continues. |
| `unavailable` | nothing returned |
| `unknown` | text without section structure to judge |

## Caching

Under `~/.cache/mina/literature` (`LIT_BROKER_CACHE_DIR` overrides), one JSON file per entry:

| Namespace | Key | Lifetime |
| --- | --- | --- |
| `search`, `backend` | backend, operation, arguments | 1 day |
| `meta`, `idmap` | backend, operation, identifier | 7 / 30 days |
| `expand` | anchor, direction | 7 days |
| `fulltext` | family, version, representation (+ provenance, retrieval time) | permanent |
| `fulltext_unavailable` | family, version | 7 days (open-access copies appear later) |
| `index` | family, representation, version | permanent |
| `budget` | UTC day | OpenAlex spend and exhaustion |
| `continuation` | search | 1 day |

Failures are never cached. Paper text in the cache is not redistributable; the cache is outside the repository.

## Limits, budgets and failures

- **Timeouts:** every backend call has a hard timeout outside the provider (Semantic Scholar 25 s; most 30 s; full text
  60–120 s). Calls run with `Promise.allSettled`; one failure never aborts a search.
- **Health:** tracked per lane. A rate limit benches that lane (Semantic Scholar 10 minutes, others 1 minute); two hard
  timeouts in a row bench it. The bioRxiv article pages and the bioRxiv API are separate lanes.
- **Retries:** one, and only for transient faults (5xx, upstream timeouts). Nothing retries in a loop.
- **OpenAlex budget:** USD 1/day by default (`LIT_BROKER_OPENALEX_BUDGET_USD`). The broker tracks spend, keeps a reserve,
  remembers a "budget exhausted" answer until midnight UTC, and continues with the other backends with a coverage note.
  Gets by id are free; searches USD 0.001; batch filters USD 0.0001; content files USD 0.01.
- **Keys:** Exa and Brave keys come from the environment, else from the key folder: `PI_RESEARCH_KEYS_DIR`, else `<repo>/keys` if it
  exists, else `~/.config/mina/keys`. Without an Exa key, the broker skips Exa, unless `MINA_EXA_KEYLESS=1` turns on keyless Exa.
  The coverage report tells which case applied.

### Cancellation, deadlines, and cost

- Each tool call runs in a runtime scope (`runtime.scoped`). Each backend call inside it inherits the abort signal of the tool and its overall deadline (`TOOL_DEADLINE_MS` in `literature/broker/index.mjs`).
  An aborted call fails with `CANCELLED`, and nothing that waits in its queue starts after it.
- HTTP requests get the abort signal. MCP requests cannot be cancelled upstream. An abandoned MCP request is reported as `upstream: 'abandoned_not_stopped'`, and it holds its lane until it settles, at most `ABANDONED_HOLD_MAX_MS` (190 s).
- While an abandoned request holds a lane, each call on that lane fails at once with `skipped_busy`, with `held_by`. Otherwise one hung request can stall all work on that backend for minutes.
  `skipped_busy` is not evidence about the backend. It does not bench the lane. It is a temporary outcome, so `paper_get` never caches a result that depends on it, and the coverage report lists it as a failed backend.
- A shared request runs under the deadline of its owner. A caller with a later deadline does not join a request that ends earlier. It runs its own request after the first one, and it uses the cached answer of the first one if that answer succeeded.
- A request that waited past its deadline in the queue is reported as `queued` and `deadline_truncated`. This does not change the health of the backend.
- Cost is the sum over the attempts that ran. A cache hit reports `cost_usd: 0`, and `original_cost_usd` keeps the stored cost. A request that the provider already received can still be billed, so its estimate is recorded.
- `paper_get` never caches an acquisition that was cancelled or went past its deadline. It does not cache a `partial` result if a tier failed with a temporary outcome. It returns it with `temporary: true`, so a later call tries the failed tiers again.
- The bioRxiv article-page wait (20 to 65 s after a rate limit) ends early when the call is cancelled, and it is skipped when the deadline comes first. Only a completed wait clears the bench of the `biorxiv_page` lane.
- Budget reservations apply only in one process. Nothing enforces the OpenAlex budget across processes or machines.

## Semantic Scholar

Semantic Scholar is behind a provider boundary with the states `enabled_keyed`, `enabled_keyless`, `disabled`, and `temporarily_unhealthy`.
The service throttles requests, also with a key. Thus, the broker routes it only in the `comprehensive` and `novelty` modes.
`config.semantic_scholar` selects the modes and fields, for example `['comprehensive','novelty','computational_biology']`. No API change is necessary to route it more widely.

## Observability

Structured JSON lines in `<cache>/logs/<date>.jsonl`, secrets scrubbed: every backend call (lane, operation, outcome,
latency, attempts, cost, cache hit), every search (backends, failures, candidate and family counts, roles selected,
expansion counts), every full-text acquisition (tiers attempted with outcomes, chosen representation), every evidence
retrieval (passages, characters).

## Testing

```bash
npm test                                   # all Node tests, also the broker tests (no network)
node --test literature/test/               # only the literature tests
node literature/broker-integration.mjs     # live: search, resolution, and full text against the real services
```
