# Third-party notices

Mina is MIT-licensed (see `LICENSE`). This file lists the third-party code in this repository, and the third-party
software that Mina installs or runs.

## Code in this repository

| Component | Where | Origin | License |
|---|---|---|---|
| pi-claude-subscription 0.2.4, with Mina's patches | `vendor/pi-claude-subscription-0.2.4-mina.5.tgz`, `vendor/patches/` | npm `pi-claude-subscription`, github.com/jkeskikangas/pi-claude-subscription, Copyright (c) 2026 Jarno Keskikangas | MIT. The license text is in the tgz (`package/LICENSE`). [Vendor patches](docs/vendor-patches.md) describes the changes |
| pi-research-search | `adapters/pi-research-search/` | A fork of npm `@bytetrue/pi-web-search` 0.5.1, Copyright (c) 2026 byte (ByteTrue). `pristine/` holds the unchanged upstream files | MIT, see `adapters/pi-research-search/LICENSE` and `ATTRIBUTION.md` |
| Seatbelt profile rules (sysctl, device, platform, and deny lists) | `sandbox/macos/profile.mjs`, `scripts/macos-probe.py` | Adapted from github.com/openai/codex `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl` and `seatbelt_read_only_platform_defaults.sbpl` (commit `3a2788e`), Copyright OpenAI, and from github.com/eugene1g/agent-safehouse `profiles/10-system-runtime.sb` (v0.12.0, commit `0812967`) | Apache-2.0, see https://www.apache.org/licenses/LICENSE-2.0 |
| HTML extraction, URL guard, Brave and Exa clients | in `adapters/pi-research-search/` | Ported by the upstream above from npm `@juicesharp/rpiv-web-tools`, github.com/juicesharp/rpiv-mono, Copyright (c) 2026 juicesharp | MIT, see `adapters/pi-research-search/LICENSE` |

## Software that Mina installs or runs

These packages are not in this repository. `npm install`, `scripts/literature-install.sh` and `scripts/searxng.sh`
download them, and their own licenses apply.

- **npm dependencies** in `package-lock.json` and `services/literature-mcp/package-lock.json`, for example the Pi
  coding agent, `@cyanheads/pubmed-mcp-server`, `@cyanheads/arxiv-mcp-server` and `@cyanheads/biorxiv-mcp-server`.
  They use MIT, ISC, BSD or Apache-2.0 licenses.
- **Python packages** in `services/literature-mcp/requirements.lock.txt`, for example `semantic-scholar-mcp` (MIT)
  and `onnxruntime` (MIT).
- **PyMuPDF, pymupdf4llm and pymupdf-layout** (`services/literature-mcp/requirements.lock.txt`) convert PDF papers to
  text. Artifex licenses them under the **GNU AGPL-3.0**, or under a commercial license. Mina runs them as a separate
  process in its PDF sandbox and does not include their code. If you distribute an installation that contains them, or
  offer it as a network service, read the AGPL terms first.
- **SearXNG** (the image `docker.io/searxng/searxng`, pinned in `scripts/searxng.sh`) is licensed under the
  **GNU AGPL-3.0**. Mina runs the unchanged image in a Podman container on `127.0.0.1` only, with its own settings
  (`services/searxng/settings.yml`), and does not include its code.
