# whatsapp-claude

WhatsApp auto-reply stack built from three pieces:
- `vendor/whatsapp-mcp/whatsapp-bridge` (Go bridge)
- `vendor/whatsapp-mcp/whatsapp-mcp-server` (Python MCP server)
- `poller/poller.py` (Claude poller in this repo)

## Install on a Linux server

Requirements:
- Go
- Python 3.11+
- systemd user services (`systemctl --user`)
- `claude` CLI on PATH and already authenticated
- git
- `timeout` (coreutils)

### 1. Clone

```bash
git clone --recurse-submodules https://github.com/bazfer/whatsapp-claude.git
cd whatsapp-claude
```

If you already cloned without submodules:

```bash
git submodule update --init --recursive
```

### 2. Fill `.env`

```bash
cp .env.example .env
$EDITOR .env
```

Important defaults:
- `BOT_WORKING_DIR` should point to this repo root
- `WA_DB_PATH` defaults to `store/messages.db` inside this repo
- `WHATSAPP_API_URL` should normally stay `http://127.0.0.1:8080/api`

### 3. Run install

```bash
./install.sh
```

The installer will:
- validate Go, Python 3.11+, `git`, `timeout`, `claude`, and `systemctl --user`
- build the Go bridge from the pinned submodule
- create a Python virtualenv for the MCP server
- install 3 user services: `whatsapp-bridge`, `whatsapp-mcp-server`, `whatsapp-poller`
- read configuration from repo-root `.env`
- create and use repo-local `store/` for WhatsApp bridge/session data

### 4. Scan QR

During install, it prints:

```text
Scan QR now
```

When that appears, scan the QR code with WhatsApp on the phone tied to the account.

### 5. Verify services

```bash
systemctl --user status whatsapp-bridge whatsapp-mcp-server whatsapp-poller
journalctl --user -u whatsapp-bridge -f
```

## Repo layout

- `install.sh` — Linux server bootstrap
- `poller/poller.py` — Claude polling daemon
- `vendor/whatsapp-mcp` — pinned upstream submodule
- `store/` — runtime WhatsApp bridge data

## Notes

- Services are installed as **user** services, not root services.
- The poller still expects Claude to send replies via MCP `send_message`.
- `BOT_WORKING_DIR` should stay pointed at the repo root so `claude -p` picks up `CLAUDE.md`.
