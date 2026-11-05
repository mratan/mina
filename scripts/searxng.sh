#!/bin/bash
# Mina's private SearXNG (the literature meta-search of research_search and literature_search) in a Podman container
# on 127.0.0.1 only, with the settings of services/searxng/settings.yml and a pinned image.
# Usage: scripts/searxng.sh install | start | status | remove
#   install  copy the settings, create the secret, pull the image, (re)create the container, start it at login
#   start    start the Podman machine (macOS) and the container
#   status   show the container and make one JSON search
#   remove   remove the container, its cache volume, the settings and the login start (Podman itself stays)
# MINA_SEARXNG_PORT changes the port (default 18080). Mina then needs SEARXNG_URL=http://127.0.0.1:PORT.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
image="docker.io/searxng/searxng:2026.10.2-19ffbcd30@sha256:c642712fcedcdaa78fac44f71eada86aff510745826ba1bd1a368211fea2ce7f"
name=mina-searxng
port="${MINA_SEARXNG_PORT:-18080}"
conf="${XDG_CONFIG_HOME:-$HOME/.config}/mina/searxng"
os="$(uname -s)"
agent="$HOME/Library/LaunchAgents/com.mina.searxng.plist"
unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/mina-searxng.service"

die() { echo "searxng: $*" >&2; exit 1; }
need_podman() {
  command -v podman >/dev/null || die "Podman is not installed (macOS: brew install podman; Linux: your package manager)"
}

# macOS: containers run in Podman's Linux VM. Use the default machine; create it if there is none.
machine_up() {
  [ "$os" = Darwin ] || return 0
  if [ -z "$(podman machine list --format '{{.Name}}' 2>/dev/null)" ]; then
    echo "searxng: creating the Podman machine (a Linux VM; one download of about 1 GB)"
    podman machine init
  fi
  if [ "$(podman machine inspect --format '{{.State}}' 2>/dev/null | head -1)" != running ]; then
    podman machine start
  fi
}

search_ok() {
  curl -fsS -m 20 "http://127.0.0.1:$port/search?q=CRISPR&format=json" 2>/dev/null | grep -q '"results"'
}

wait_ready() {
  for _ in $(seq 1 60); do search_ok && return 0; sleep 1; done
  podman logs --tail 30 "$name" >&2 || true
  die "SearXNG does not answer at http://127.0.0.1:$port"
}

autostart() {
  if [ "$os" = Darwin ]; then
    # launchd starts the machine and the container at login. Only podman runs: no file of the checkout, which can be in a
    # folder that macOS protects (~/Documents) from launchd jobs. The VM outlives the job (AbandonProcessGroup): else
    # launchd kills it when the job exits.
    local pod; pod="$(command -v podman)"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    cat > "$agent.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.mina.searxng</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>"\$0" machine start; "\$0" start $name</string><string>$pod</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$pod"):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/mina-searxng.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/mina-searxng.log</string>
</dict>
</plist>
EOF
    mv -f "$agent.tmp" "$agent"
    launchctl bootout "gui/$(id -u)/com.mina.searxng" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$agent"
  else
    # systemd starts the container at login (with lingering: at boot).
    mkdir -p "$(dirname "$unit")"
    cat > "$unit" <<EOF
[Unit]
Description=Mina's private SearXNG (127.0.0.1:$port, Podman)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$(command -v podman) start $name
ExecStop=$(command -v podman) stop $name

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable mina-searxng.service >/dev/null 2>&1
  fi
}

case "${1:-}" in
  install)
    need_podman
    machine_up
    if ! podman container exists "$name" 2>/dev/null && curl -s -m 3 -o /dev/null "http://127.0.0.1:$port/"; then
      die "port $port is in use. Set MINA_SEARXNG_PORT, and SEARXNG_URL for Mina"
    fi
    # The settings in a folder of their own, mounted read-only on /etc/searxng (a volume of the image: a mounted file
    # would leave an anonymous volume at each run). The secret stays outside the container's folders.
    mkdir -p "$conf/etc"; chmod 700 "$conf"
    cp "$repo/services/searxng/settings.yml" "$conf/etc/settings.yml.tmp" && mv -f "$conf/etc/settings.yml.tmp" "$conf/etc/settings.yml"
    if [ ! -s "$conf/env" ]; then
      (umask 077; printf 'SEARXNG_SECRET=%s\n' "$(head -c 48 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 48)" > "$conf/env")
    fi
    podman pull "$image"
    podman run -d --replace --name "$name" --restart always \
      -p "127.0.0.1:$port:$port" --env-file "$conf/env" -e "SEARXNG_PORT=$port" -e FORCE_OWNERSHIP=false \
      -v "$conf/etc:/etc/searxng:ro" -v "$name-data:/var/cache/searxng" "$image" >/dev/null
    autostart
    wait_ready
    echo "searxng: running at http://127.0.0.1:$port"
    [ "$port" = 18080 ] || echo "searxng: set SEARXNG_URL=http://127.0.0.1:$port for Mina"
    ;;
  start)
    need_podman; machine_up; podman start "$name" >/dev/null; wait_ready; echo "searxng: running at http://127.0.0.1:$port" ;;
  status)
    need_podman
    podman ps -a --filter "name=^$name\$" --format '{{.Names}}  {{.Status}}  {{.Ports}}' 2>/dev/null || true
    if search_ok; then echo "searxng: answers at http://127.0.0.1:$port"; else echo "searxng: does not answer at http://127.0.0.1:$port"; exit 1; fi ;;
  remove)
    need_podman
    if [ "$os" = Darwin ]; then
      launchctl bootout "gui/$(id -u)/com.mina.searxng" 2>/dev/null || true; rm -f "$agent"
    elif [ -f "$unit" ]; then
      systemctl --user disable mina-searxng.service >/dev/null 2>&1 || true; rm -f "$unit"; systemctl --user daemon-reload
    fi
    podman rm -f -v "$name" >/dev/null 2>&1 || true
    podman volume rm "$name-data" >/dev/null 2>&1 || true
    rm -rf "$conf"
    echo "searxng: removed (Podman, its machine and the image stay)" ;;
  *) echo "usage: scripts/searxng.sh install | start | status | remove" >&2; exit 2 ;;
esac
