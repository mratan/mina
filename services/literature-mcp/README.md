# literature-mcp

Pinned installs of the local literature MCP servers: PubMed/Europe PMC/Unpaywall, bioRxiv, arXiv and Semantic Scholar.
Each server runs in its own sandbox through `scripts/mcp-sandbox.mjs`, as configured in `.pi/mcp.json`.

Install with `npm run literature:install` from the repository root. That runs `npm ci --ignore-scripts` here and creates
the Python venv for the Semantic Scholar server and the PDF extractor (`requirements.lock.txt`).

Documentation: [docs/research-literature.md](../../docs/research-literature.md).
