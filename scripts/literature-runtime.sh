#!/usr/bin/env bash
# Puts a Node and a Python for the literature servers in services/literature-mcp/.venv/runtime, for a host whose
# /usr/bin/node is older than 24 or whose /usr/bin/python3 is older than 3.10. The system Node and Python stay as they
# are. Then run npm run literature:install, which uses them.
# Usage: scripts/literature-runtime.sh [NODE_VERSION] [PYTHON_VERSION]    (defaults: v26.12.1 and 3.14)
set -euo pipefail
node_version="${1:-v26.12.1}"
python_version="${2:-3.14}"
runtime="$(cd "$(dirname "$0")/.." && pwd)/services/literature-mcp/.venv/runtime"
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "literature-runtime: unsupported machine $(uname -m)" >&2; exit 1 ;;
esac

tarball="node-$node_version-linux-$arch.tar.xz"
download="$(mktemp -d)"
trap 'rm -rf "$download"' EXIT
curl -fsSL -o "$download/$tarball" "https://nodejs.org/dist/$node_version/$tarball"
curl -fsSL -o "$download/SHASUMS256.txt" "https://nodejs.org/dist/$node_version/SHASUMS256.txt"
(cd "$download" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c --quiet -)
rm -rf "$runtime/node"
mkdir -p "$runtime/node"
tar -xf "$download/$tarball" -C "$runtime/node" --strip-components=1

UV_PYTHON_INSTALL_DIR="$runtime/python" uv python install -q --no-bin "$python_version"
echo "literature runtime: node $("$runtime/node/bin/node" --version), Python $python_version in $runtime/python"
