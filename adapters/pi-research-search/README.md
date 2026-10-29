# pi-research-search

A Pi extension with two tools:

- `research_search`: search with an explicit mode. `discover` uses Exa, `literature` uses a local SearXNG with scholarly
  engines, `docs` and `exact` use Brave, and `verify` runs all three.
- `web_fetch`: reads one public web page as text. It refuses private, loopback and other non-public addresses.

Keys: `EXA_API_KEY` and `BRAVE_SEARCH_API_KEY`, from the environment or from key files in `PI_RESEARCH_KEYS_DIR`. A
backend without a key is reported as skipped. Keyless Exa is off by default; set `MINA_EXA_KEYLESS=1` to use it.

Mina's own requests, `web_fetch` included, identify as `Mina/<version> (+https://github.com/mratan/mina)`. Config
`fetch.userAgent: 'browser'` makes `web_fetch` send a desktop browser User-Agent instead.

This is a fork of `@bytetrue/pi-web-search` 0.5.1 (MIT). `ATTRIBUTION.md` explains what came from upstream, and
`pristine/` holds the unmodified upstream files.

Documentation: [docs/research-literature.md](../../docs/research-literature.md).
Tests: `node --test adapters/pi-research-search/test/`.
