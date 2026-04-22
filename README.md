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
git clone --recurse-submodules https://github.com/Agent-Crafting-Table/whatsapp-claude.git
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

Key variables:

| Variable | Default | Notes |
|---|---|---|
| `BOT_WORKING_DIR` | *(set to repo root)* | `claude -p` picks up `CLAUDE.md` from here |
| `WA_DB_PATH` | `vendor/.../store/messages.db` | Written by the bridge |
| `WHATSAPP_API_URL` | `http://127.0.0.1:8080/api` | Bridge REST API |
| `ALLOWED_CHATS` | *(unset = reply to ALL chats)* | Comma-separated JIDs, e.g. `15551234567@s.whatsapp.net` |
| `POLL_INTERVAL_SECONDS` | `10` | How often to check for new messages |
| `HISTORY_MESSAGES` | `10` | Prior messages included in each Claude prompt |
| `CLAUDE_TIMEOUT_SECONDS` | `60` | Timeout per `claude -p` invocation |

> **Always set `ALLOWED_CHATS` in production.** If unset, the bot will reply to every active chat on the connected WhatsApp account.

### 3. Allow MCP tools in `~/.claude/settings.json`

The poller invokes `claude -p` (non-interactive). Claude Code cannot prompt for permissions in this mode — any tool not pre-allowed will silently fail without sending a reply.

Add the following to the `permissions.allow` array in `~/.claude/settings.json`:

```json
"mcp__whatsapp__send_message",
"mcp__whatsapp__list_messages",
"mcp__whatsapp__list_chats",
"mcp__whatsapp__search_contacts",
"mcp__whatsapp__get_chat",
"mcp__whatsapp__get_contact",
"mcp__whatsapp__get_last_interaction"
```

The repo ships a `.claude/settings.json` with empty hooks. This prevents any global `PreToolUse` hooks (e.g. a Discord typing indicator) from firing inside the WhatsApp bot subprocess.

### 4. Run install

```bash
./install.sh
```

The installer will:
- validate Go, Python 3.11+, `git`, `timeout`, `claude`, and `systemctl --user`
- build the Go bridge from the pinned submodule
- create a Python virtualenv for the MCP server
- install 3 user services: `whatsapp-bridge`, `whatsapp-mcp-server`, `whatsapp-poller`
- read configuration from repo-root `.env`
- create and use the bridge submodule `store/` directory for WhatsApp bridge/session data

### 5. Scan QR

During install, it prints:

```text
Scan QR now
```

When that appears, scan the QR code with WhatsApp on the phone tied to the account.

### 6. Verify services

```bash
systemctl --user status whatsapp-bridge whatsapp-mcp-server whatsapp-poller
journalctl --user -u whatsapp-bridge -f
```

## Repo layout

- `install.sh` — Linux server bootstrap
- `poller/poller.py` — Claude polling daemon
- `.claude/settings.json` — disables global hooks for subprocess invocations
- `vendor/whatsapp-mcp` — pinned upstream submodule
- `vendor/whatsapp-mcp/whatsapp-bridge/store/` — runtime WhatsApp bridge data

## Notes

- Services are installed as **user** services, not root services.
- The poller invokes Claude via `send_message` MCP tool — replies never go through stdout.
- `BOT_WORKING_DIR` must point at the repo root so `claude -p` picks up `CLAUDE.md`.
- WhatsApp typing indicators do not appear in self-chat (sender = receiver on the same account). This is a WhatsApp limitation — indicators work correctly when replying to a different user.
