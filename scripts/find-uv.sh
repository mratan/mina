# Sourced by the literature scripts: sets UV to the uv program. The uv installer puts it in ~/.local/bin (or ~/.cargo/bin
# for older versions), which a non-interactive shell (for example `ssh host 'command'`) often does not have on PATH.
UV="$(command -v uv || true)"
for candidate in "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv"; do
  if [ -z "$UV" ] && [ -x "$candidate" ]; then UV="$candidate"; fi
done
if [ -z "$UV" ]; then
  echo "$(basename "$0"): uv is not installed, or it is not on PATH. Install uv (https://docs.astral.sh/uv/getting-started/installation/)," >&2
  echo "or add the folder that contains uv to PATH. Then run this command again." >&2
  exit 1
fi
