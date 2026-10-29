# literature

Mina's scholarly literature stack:

- `broker/`: the unified literature broker (search, resolution, full text with validation, citation expansion). It runs
  over OpenAlex, PubMed/Europe PMC, bioRxiv/medRxiv, arXiv, Semantic Scholar, Exa and SearXNG.
- `supplements.mjs` and `supplements/`: `supplement_get` reads one linked supplementary file (CSV/TSV, XLSX, ZIP or PDF)
  and keeps a record of where it came from.
- `openalex-content.mjs`: full text from the OpenAlex Content API.
- `lib/`: shared normalization and representation analysis.
- `smoke.mjs` and `broker-integration.mjs`: live suites. They write reports to `.mina/literature/` (git-ignored) or
  `--out DIR`.
- `test/`: offline unit tests (`node --test literature/test/`).

A contact address for the polite-pool APIs (OpenAlex, Crossref, Unpaywall, NCBI, Europe PMC, bioRxiv) is sent only when
you set `RESEARCH_EMAIL`. Without it, Unpaywall is skipped.

Documentation: [docs/research-literature.md](../docs/research-literature.md),
[docs/literature/broker.md](../docs/literature/broker.md),
[docs/literature/broker-cancellation.md](../docs/literature/broker-cancellation.md) and
[docs/literature/supplements.md](../docs/literature/supplements.md).
