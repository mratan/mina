# Research literature infrastructure

Mina can find scientific literature with high recall, select the few papers that matter, and read their text when an abstract is not enough.
This document describes the parts under the research tools: the search adapter, the literature broker, and the literature servers.
The agent's behavior comes from the research protocol in [skills/mina-research/SKILL.md](../skills/mina-research/SKILL.md).
For the tools and the keys from the user's side, read [research](usage.md#research) in the usage guide.

## Architecture

```text
Mina (Pi with Mina's layers)
  │
  ├── literature broker (preferred)    literature_search, paper_resolve, paper_get, citation_expand
  │      extensions/literature → literature/broker/   (docs/literature/broker.md)
  │      literature_db: one allowlisted read-only operation of a literature database
  │      supplement_get: one linked supplement file (docs/literature/supplements.md)
  │
  ├── web search                       research_search, web_fetch (adapters/pi-research-search)
  │      ├── Exa        semantic discovery
  │      ├── SearXNG    local literature meta-search (optional, http://127.0.0.1:18080)
  │      └── Brave      exact and documentation search
  │
  └── literature servers (MCP, .pi/mcp.json), each in its own sandbox
         ├── openalex          official remote server (OAuth)          discovery, citation graph, identifiers
         ├── pubmed            PubMed, PMC, Europe PMC, Unpaywall        biomedical search, MeSH, full text
         ├── biorxiv           bioRxiv, medRxiv                          preprints, versions, full text
         ├── semantic_scholar  Semantic Scholar Graph + Recommendations  citations, references, recommendations
         └── arxiv             arXiv API, HTML, ar5iv, PDF               search, metadata, full text
  +  literature/openalex-content.mjs                                       OpenAlex Content API: TEI full text
```

The research tools run in the trusted Mina process, not in the sandbox workers. The broker starts the local literature servers with the commands in `.pi/mcp.json`.

Research has two stages:

1. **Discovery and triage** use titles, metadata, abstracts, snippets, and citation links. They answer "what exists?" and "which papers matter?".
2. **Evidence** uses the text of the paper: selected passages or sections first, the whole paper when several parts matter.

An abstract is never treated as the full paper.

### Plain Pi in the Mina folder

If you start plain `pi` in the Mina folder and trust the folder with `/trust`, Pi reads `.pi/mcp.json` and loads the servers with `exposure: "codemode"`.
Then the model does not see the 60 or more server tools one by one. It writes a short `codemode` script that finds tools (`searchTools`, `describeNamespace`) and calls them as `tools.mcp__<server>__<tool>(...)`.
Mina itself does not load Pi's `mcp` and `codemode` extensions in the sandbox. In Mina, the agent reaches the servers through the broker tools and `literature_db`.

## The servers

| Server | Package and version | Upstream | Keys | Role |
|---|---|---|---|---|
| `openalex` | Remote, `https://mcp.openalex.org/mcp` (Streamable HTTP). OurResearch sets the version. | [ourresearch/openalex-mcp-server](https://github.com/ourresearch/openalex-mcp-server) | OAuth: sign in once (`pi mcp login openalex`). Queries use the daily budget of your OpenAlex account. | Work search (keyword or semantic), work lookup by ID, citations and references, entities, and analysis. The tools that change your OpenAlex account are hidden (`toolExposure`). |
| `pubmed` | `@cyanheads/pubmed-mcp-server` 2.10.19 (npm) | [cyanheads/pubmed-mcp-server](https://github.com/cyanheads/pubmed-mcp-server) | `NCBI_API_KEY` (optional: 10 requests per second instead of 3). Contact addresses from `RESEARCH_EMAIL`, only when it is set. | PubMed search, metadata, MeSH, related and citing articles, ID conversion, Europe PMC, and full text: PMC, then Europe PMC, then Unpaywall. |
| `biorxiv` | `@cyanheads/biorxiv-mcp-server` 0.3.0 (npm) | [cyanheads/biorxiv-mcp-server](https://github.com/cyanheads/biorxiv-mcp-server) | None. `RESEARCH_EMAIL`, if set, goes into a polite User-Agent. | Search (through Europe PMC), recent preprints, metadata with revision history, the journal link, and the full text of a version. |
| `semantic_scholar` | `semantic-scholar-mcp` 0.4.0 (PyPI), with `mcp` 1.30.0 pinned below 2 | [hy20191108/semantic-scholar-mcp](https://github.com/hy20191108/semantic-scholar-mcp) | `SEMANTIC_SCHOLAR_API_KEY` (optional). Without it, requests share a global rate limit. | Search, lookup by DOI, PMID, or arXiv ID, references, citations, recommendations, snippets, and open-access PDF locations. |
| `arxiv` | `@cyanheads/arxiv-mcp-server` 1.5.3 (npm) | [cyanheads/arxiv-mcp-server](https://github.com/cyanheads/arxiv-mcp-server) | None | Search, metadata, and full text: arXiv HTML, then ar5iv, then PDF text. 3 seconds between API requests, as arXiv asks. |

### Installation

`npm run literature:install` installs the local servers from the lockfiles in `services/literature-mcp`:
`package-lock.json` for the npm packages, and `requirements.lock.txt` for a Python virtual environment in `.venv`, which git ignores.
The install uses exactly these versions. It never uses `@latest`.

The installer also installs PyMuPDF, pymupdf4llm, and pymupdf-layout, which convert PDF papers to text.
These packages are licensed under the GNU AGPL-3.0. They are not part of the Mina repository. Read [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) before you redistribute an installation or offer it as a network service.

The sandbox of a server shows it only `/usr` and `services/literature-mcp`. The servers start with `.venv/bin/node`, which the installer links to `/usr/bin/node`. The virtual environment uses `/usr/bin/python3`.
The npm servers need Node.js 24 or newer, and the Python server needs Python 3.10 or newer.
If your system versions are older, or another service needs the system Node.js, run `npm run literature:runtime` first.
It downloads Node.js, checked against the `SHASUMS256.txt` of the release, and a uv Python into `.venv/runtime`. The system Node.js and Python do not change.

### The sandbox of each local server

`.pi/mcp.json` does not start a server directly. It runs `node scripts/mcp-sandbox.mjs --name <server> ... -- <server command>`, which applies these limits:

- **Files:** the server runs under bubblewrap. It sees read-only `/usr` and `/etc`, the pinned installation read-only, a private writable home (`~/.cache/mina/mcp/<server>`), and an empty `/tmp`.
  It does not see the Mina folder, your home folder, `~/.pi`, your projects, or the key folder.
- **Network:** the server has its own network namespace. It reaches the internet only through an egress proxy (`lib/egress-proxy.mjs`), and only public hosts.
  Your own services, on loopback or a private network, are refused. Each connection goes to a log in `~/.cache/mina/mcp/<server>.egress.jsonl`.
- **Credentials:** the server gets only the variables that its entry names (`--secret NAME[=FALLBACK,...]`).
  They come from the key folder, or from the environment if a variable of that name is exported. They go through the process environment, never as arguments.
  A missing optional key is reported on standard error, and the server runs without it.

## Credentials

All keys are optional. Put each key in a file in the key folder, as `NAME=value` lines, with mode 600.
Mina uses the first of these folders:

1. `$PI_RESEARCH_KEYS_DIR`.
2. The `keys/` folder of the Mina checkout, if it exists. Git ignores it.
3. `~/.config/mina/keys`.

The agent's commands never see the key folder.

| Variable | Used by | Without it |
|---|---|---|
| `EXA_API_KEY` | `research_search`, the broker | Mina skips Exa, unless you set `MINA_EXA_KEYLESS=1` to use Exa without a key. |
| `BRAVE_SEARCH_API_KEY` | `research_search` | The `docs` and `exact` modes do not work. |
| `OPENALEX_API_KEY` | The OpenAlex Content API and REST calls | No OpenAlex full text, and lower REST limits. |
| OpenAlex OAuth sign-in | The `openalex` server | The remote server does not connect. The broker uses the REST API. |
| `NCBI_API_KEY` | `pubmed` | 3 requests per second instead of 10. |
| `SEMANTIC_SCHOLAR_API_KEY` | `semantic_scholar` | A shared global rate limit. |
| `RESEARCH_EMAIL` | The contact address for NCBI, Unpaywall, Europe PMC, bioRxiv, Crossref, OpenAlex, and doi.org (as `mailto:` in the User-Agent for the last two) | No contact address is sent. Mina skips the Unpaywall tier. |

Mina sends `RESEARCH_EMAIL` only when you set it, and only to the services in the table.
`NCBI_ADMIN_EMAIL`, `UNPAYWALL_EMAIL`, `EUROPEPMC_EMAIL`, and `BIORXIV_MAILTO` can replace it for one service.

The OpenAlex OAuth sign-in and `OPENALEX_API_KEY` are separate. The OpenAlex server refuses the API key as a bearer token (`401 invalid_token`).

### Keys on more than one machine

The key files hold static keys and a contact address, with no session state. You can copy them to another machine over SSH.
Do not copy them through git, a relay, a synced folder, or a chat.

Never copy state that you got from a browser sign-in: the OpenAlex sign-in (`~/.pi/agent/mcp-auth.json`), Pi's `auth.json`, or other OAuth state.
Two machines that share a refresh token can make each other's token invalid. Run `pi mcp login openalex` on each machine.
Machines that share a key also share its rate limit and its billing.

## Setup

1. If `/usr/bin/node` is older than 24 or `/usr/bin/python3` is older than 3.10, install a private runtime:

   ```bash
   npm run literature:runtime
   ```

2. Install the pinned servers:

   ```bash
   npm run literature:install
   ```

3. Optional: sign in to the OpenAlex server. This command opens or prints the authorization URL.

   ```bash
   pi mcp login openalex
   ```

4. Show each server, its state, and its tools:

   ```bash
   pi mcp list
   ```

Over SSH, the OpenAlex sign-in prints a URL. Open it in your browser and approve. Then paste the address that the browser went to (`http://127.0.0.1:<port>/callback?...`) at the prompt.

To examine the tools, use `pi mcp list`, which exits with code 1 when a server is not connected.
In a plain Pi session, `/mcp` shows the connections, the tools, the exposure, and the sign-in.

## Full text: paths and what they return

| Path | Tool | Representation | Notes |
|---|---|---|---|
| PMC | `pubmed_fetch_fulltext` (PMID, PMCID, or DOI) | Sections, tables, and figures (`source: pmc`) | Selective: `sections: ["Methods"]`. `viaSource` names the tier that answered. |
| Europe PMC | The same tool, second tier | Europe PMC full text | |
| Unpaywall | The same tool, third tier. Needs `RESEARCH_EMAIL`. | HTML or PDF text from the open copy | Best effort. Publishers can refuse (HTTP 403). |
| bioRxiv and medRxiv | `biorxiv_get_fulltext` (DOI and `version`) | Markdown from the article page, in pages (`offset`, `limit` up to 50,000) | `www.biorxiv.org` limits requests by IP address. Preprints that exist only as PDF return `fulltext_unavailable`. |
| arXiv | `arxiv_read_paper` | `arxiv_html`, then ar5iv, then PDF text. `Source:` names it. | Up to `max_characters` for each call. Page with `start`. |
| OpenAlex | `node scripts/openalex-content.mjs <ID\|DOI\|pmid:N\|PMCID> [--sections methods,results]` | GROBID TEI XML in sections, or the PDF with `--pdf FILE` | About USD 0.01 for each file, from the daily budget of the key. |

Each failure state is explicit:

- `pubmed_fetch_fulltext` returns an `unavailable` entry with the tiers that it tried, for example `pmc:no-body → europepmc:service-error → unpaywall:fetch-failed (403)`.
- The OpenAlex helper returns `FULLTEXT_UNAVAILABLE` or `NOT_FOUND`.
- bioRxiv returns `fulltext_unavailable` or `rate_limited`.

Each result of the OpenAlex helper carries its provenance: the identifiers, the source and representation, the content URL without the key, the cost, the retrieval time, and a completeness estimate.
The completeness is `likely` (sections like methods and results, and substantial text), `partial`, or `none`. It describes what came back. It is not a guarantee.

## Tests

| Command | What it does |
|---|---|
| `npm test` | All Node tests, also the literature tests in `literature/test/`: identifiers, TEI sections, completeness, keys, the sandbox, and the broker. No network. |
| `node --test literature/test/` | Only the literature tests. |
| `npm run literature:smoke` | Live checks A to H against the real services. It writes its report to the `.mina/` folder of the Mina checkout. |
| `npm run literature:smoke -- C` | One live check. |

| Check | What it shows |
|---|---|
| A | PubMed search: relevant papers with PMID, DOI, and abstract. |
| B | PubMed to PMC full text with Methods and Results. Methods alone. A DOI from the Unpaywall tier. A DOI where each tier fails, reported for each tier. |
| C | bioRxiv search, preprint, version, and full text. If the article page is rate-limited, the OpenAlex copy. |
| D | arXiv search, metadata, and full text with the representation named. |
| E | OpenAlex discovery and citation traversal, through the REST API, so it runs without the OAuth sign-in. |
| F | Semantic Scholar references, citations, and recommendations. |
| G | The identifiers of one paper agree across PubMed, Semantic Scholar, and OpenAlex. |
| H | OpenAlex Content API: TEI full text with provenance, and `FULLTEXT_UNAVAILABLE` for a closed paper. |

## Failure behavior

- **One server is not available**, for example after a rate limit or without the OpenAlex sign-in: the other servers continue to work.
- **A SearXNG engine is blocked:** `research_search` lists it as unresponsive and returns the results of the other engines.
- **Metadata without open text:** an explicit unavailable state, with the tiers tried.
- **The bioRxiv article page fails** (rate limit, PDF only, a challenge page): the tool reports it. Try the version later, or use the OpenAlex copy. Mina never scrapes paywalled publisher pages.
- **A key is missing:** the server runs without the key where it can, and the launcher tells which variable is missing.
- **Retries are limited:** NCBI up to 6 attempts within 60 seconds, Europe PMC 3, and the bioRxiv server obeys `Retry-After`. Nothing retries without end.

## Known limitations

- **Paywalled literature is out of scope.** Mina gets only open copies: PMC, Europe PMC, bioRxiv, medRxiv, arXiv, OpenAlex Content, Unpaywall, and open-access publisher copies.
  If institutional access is added in the future, it belongs in one acquisition layer after the open-access resolver, not in each server.
- **bioRxiv rate limits.** `www.biorxiv.org` limits requests by IP address. A burst of requests can block the article pages for several minutes. The API (`api.biorxiv.org`) is not affected.
- **The Unpaywall tier depends on the publisher.** Some publisher hosts refuse automated requests. It can also return a landing page as the article text. The broker validates the text before it uses it.
- **Semantic Scholar** throttles requests, also with a key. The broker thus uses it only in the `comprehensive` and `novelty` modes. Recommendations are empty for some papers. Version 0.4.0 needs the v1 MCP SDK, which the lockfile pins.
- **The OpenAlex server** depends on the version of the remote service, which OurResearch controls. Its queries use the free daily budget of your account.
- **GROBID text** flattens formulas and can merge or miss sections. The completeness field tells what came back.

These points matter when you use the tools directly:

- Send keywords, not sentences, to OpenAlex keyword search, PubMed, Europe PMC, bioRxiv, and arXiv (`all:t1 AND all:t2`).
- For a landscape question, expand the references of a review or a benchmark. A search alone can miss the methods that define a field.
- For arXiv records, trust arXiv, not OpenAlex. OpenAlex arXiv records can have wrong titles or be missing.
- OpenAlex search hides retracted works by default. Its free budget (USD 1 a day) runs out quickly with title or semantic searches (USD 0.001 each).
