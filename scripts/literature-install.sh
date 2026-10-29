#!/usr/bin/env bash
# Installs the pinned literature servers in services/literature-mcp: the npm packages, and the Python venv in .venv.
# The servers run in mina's sandbox, which sees /usr and this folder only. Their Node (.venv/bin/node) and the venv's
# Python therefore come from .venv/runtime when it exists (scripts/literature-runtime.sh puts them there, for a host
# whose system Node or Python is too old), and from /usr/bin otherwise.
set -euo pipefail
dir="$(cd "$(dirname "$0")/../services/literature-mcp" && pwd)"
venv="$dir/.venv"

npm ci --prefix "$dir" --ignore-scripts --no-audit --no-fund

python=/usr/bin/python3
for candidate in "$venv"/runtime/python/cpython-*/bin/python3; do [ -x "$candidate" ] && python="$candidate"; done
uv venv -q --allow-existing "$venv" --python "$python"
uv pip install -q --python "$venv/bin/python" -r "$dir/requirements.lock.txt"

if [ -x "$venv/runtime/node/bin/node" ]; then ln -sfn ../runtime/node/bin/node "$venv/bin/node"; else ln -sfn /usr/bin/node "$venv/bin/node"; fi
major="$("$venv/bin/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$major" -lt 24 ]; then
  echo "literature-install: the servers need Node 24 or newer; $venv/bin/node is not. Run scripts/literature-runtime.sh, then this again." >&2
  exit 1
fi
echo "literature servers: node $("$venv/bin/node" --version), $("$venv/bin/python" --version)"
