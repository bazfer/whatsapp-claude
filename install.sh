#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SUBMODULE_DIR="$REPO_ROOT/vendor/whatsapp-mcp"
BRIDGE_DIR="$SUBMODULE_DIR/whatsapp-bridge"
MCP_DIR="$SUBMODULE_DIR/whatsapp-mcp-server"
BIN_DIR="$REPO_ROOT/.local/bin"
VENV_DIR="$REPO_ROOT/.venvs/whatsapp-mcp-server"
STORE_DIR="$BRIDGE_DIR/store"
WHATSAPP_SUBMODULE_DB="$STORE_DIR/messages.db"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENV_FILE="$REPO_ROOT/.env"
BRIDGE_BIN="$BIN_DIR/whatsapp-bridge"
POLLER_BIN="${PYTHON_BIN:-python3}"

err() {
  echo "Error: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || err "missing required command: $1"
}

check_python() {
  need_cmd python3
  python3 - <<'PY' || exit 1
import sys
sys.exit(0 if sys.version_info >= (3, 11) else 1)
PY
  [ $? -eq 0 ] || err "python3 3.11+ is required"
}

check_go() {
  need_cmd go
}

check_required_tools() {
  need_cmd git
  need_cmd timeout
  need_cmd claude
}

check_systemd_user() {
  need_cmd systemctl
  systemctl --user --version >/dev/null 2>&1 || err "systemd user services are required (systemctl --user unavailable)"
}

ensure_env_file() {
  [ -f "$ENV_FILE" ] || err "missing $ENV_FILE. Copy .env.example to .env and fill it first."
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%%#*}
    line=$(printf '%s' "$line" | sed 's/[[:space:]]*$//')
    [ -z "$line" ] && continue

    if [[ "$line" =~ ^[A-Z_][A-Z0-9_]*= ]]; then
      key=${line%%=*}
      value=${line#*=}
      if [[ "$value" =~ ^".*"$ ]]; then
        value=${value:1:-1}
      elif [[ "$value" =~ ^'.*'$ ]]; then
        value=${value:1:-1}
      fi
      export "$key=$value"
    fi
  done < "$ENV_FILE"
}

sync_submodule() {
  git -C "$REPO_ROOT" submodule update --init --recursive
}

build_bridge() {
  mkdir -p "$BIN_DIR" "$STORE_DIR"
  echo "Building whatsapp bridge..."
  (
    cd "$BRIDGE_DIR"
    GOBIN="$BIN_DIR" go install .
  )
}

setup_mcp_venv() {
  echo "Setting up whatsapp-mcp-server virtualenv..."
  python3 -m venv "$VENV_DIR"
  "$VENV_DIR/bin/pip" install --upgrade pip setuptools wheel
  "$VENV_DIR/bin/pip" install "$MCP_DIR"
  # anyio 4.9.0 has a cancel scope regression that breaks MCP server startup.
  "$VENV_DIR/bin/pip" install "anyio<4.9"
}

write_service() {
  local name="$1"
  local content="$2"
  mkdir -p "$SYSTEMD_USER_DIR"
  printf '%s\n' "$content" > "$SYSTEMD_USER_DIR/$name.service"
}

install_services() {
  local bridge_port="${WHATSAPP_BRIDGE_PORT:-8080}"
  local api_url="${WHATSAPP_API_URL:-http://127.0.0.1:${bridge_port}/api}"
  local db_path="${WA_DB_PATH:-$WHATSAPP_SUBMODULE_DB}"
  local state_path="${STATE_PATH:-$REPO_ROOT/state.json}"
  local bot_dir="${BOT_WORKING_DIR:-$REPO_ROOT}"
  local bridge_store_dir
  bridge_store_dir=$(dirname "$db_path")

  write_service "whatsapp-bridge" "[Unit]
Description=WhatsApp bridge
After=network.target

[Service]
Type=simple
WorkingDirectory=$BRIDGE_DIR
EnvironmentFile=$ENV_FILE
Environment=WHATSAPP_BRIDGE_PORT=$bridge_port
Environment=STORE_PATH=$bridge_store_dir
ExecStart=$BRIDGE_BIN
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target"

  write_service "whatsapp-mcp-server" "[Unit]
Description=WhatsApp MCP server
After=whatsapp-bridge.service
Requires=whatsapp-bridge.service

[Service]
Type=simple
WorkingDirectory=$MCP_DIR
EnvironmentFile=$ENV_FILE
Environment=WHATSAPP_DB_PATH=$db_path
Environment=WHATSAPP_API_URL=$api_url
ExecStart=$VENV_DIR/bin/python $MCP_DIR/main.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target"

  write_service "whatsapp-poller" "[Unit]
Description=WhatsApp Claude poller
After=whatsapp-bridge.service whatsapp-mcp-server.service
Requires=whatsapp-bridge.service whatsapp-mcp-server.service

[Service]
Type=simple
WorkingDirectory=$REPO_ROOT
EnvironmentFile=$ENV_FILE
Environment=BOT_WORKING_DIR=$bot_dir
Environment=WA_DB_PATH=$db_path
Environment=STATE_PATH=$state_path
ExecStart=$POLLER_BIN $REPO_ROOT/poller/poller.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target"

  systemctl --user daemon-reload
  systemctl --user enable whatsapp-bridge.service whatsapp-mcp-server.service whatsapp-poller.service
}

first_auth() {
  mkdir -p "$STORE_DIR"
  if [ -f "$STORE_DIR/whatsmeow.db" ]; then
    echo "Existing WhatsApp session detected, skipping QR auth."
    return
  fi

  echo "Scan QR now"
  (
    cd "$BRIDGE_DIR"
    timeout 90s "$BRIDGE_BIN" || true
  )
}

start_services() {
  systemctl --user restart whatsapp-bridge.service
  sleep 2
  systemctl --user restart whatsapp-mcp-server.service whatsapp-poller.service
}

main() {
  check_go
  check_python
  check_required_tools
  check_systemd_user
  ensure_env_file
  sync_submodule
  build_bridge
  setup_mcp_venv
  install_services
  first_auth
  start_services
  echo "Install complete. Check status with: systemctl --user status whatsapp-bridge whatsapp-mcp-server whatsapp-poller"
}

main "$@"
