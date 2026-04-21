# whatsapp-claude — WhatsApp Auto-Reply Poller

A Python daemon that watches the [whatsapp-mcp](https://github.com/deetbot/whatsapp-mcp) SQLite database for new messages and automatically replies via Claude using the `send_message` MCP tool.

---

## Architecture

```
WhatsApp ──► Go bridge ──► messages.db ◄── poller.py ──► claude -p
                                                              │
                                                        MCP server
                                                              │
                                                        send_message
                                                              │
                                                          WhatsApp
```

1. **Go bridge** (`whatsapp-mcp/whatsapp-bridge`) maintains the WhatsApp WebSocket connection and writes all messages to SQLite.
2. **Poller** (`poller/poller.py`) polls the DB every `POLL_INTERVAL_SECONDS`, detects new messages, and invokes `claude -p "<prompt>" --no-markdown`.
3. **Claude** reads `CLAUDE.md` for persona/instructions, then calls the **MCP server**'s `send_message` tool to send the reply — the poller does **not** parse stdout as the reply text.
4. After `claude -p` exits, the poller queries the DB for any messages that appeared during the invocation and records their IDs in `state.json` so they are not re-processed.

---

## Prerequisites

| Dependency | Notes |
|---|---|
| Python ≥ 3.11 | stdlib only, no pip install needed |
| `claude` CLI | Must be on `PATH` or bind-mounted in Docker |
| whatsapp-mcp | Bridge and MCP server running |
| SQLite DB | Written by the Go bridge |

---

## Running locally

```bash
# 1. Clone and configure
git clone https://github.com/DeetBot/whatsapp-claude.git
cd whatsapp-claude
cp .env.example .env
$EDITOR .env          # set WA_DB_PATH and BOT_WORKING_DIR

# 2. Source env and run
set -a && source .env && set +a
python3 poller/poller.py
```

The poller logs to stdout. On first run it writes `state.json` anchored to the current time so old messages are not replayed.

---

## Running with Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

> **Note:** The `claude` CLI is bind-mounted from the host at `/usr/local/bin/claude`. Adjust the path in `docker-compose.yml` if it lives elsewhere on your system. Poller state is stored in a named Docker volume, so you do not need to pre-create `state.json` on the host.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `POLL_INTERVAL_SECONDS` | `10` | Seconds between DB polls |
| `HISTORY_MESSAGES` | `10` | Prior messages included in the Claude prompt |
| `BOT_WORKING_DIR` | repo root | `cwd` for `claude -p`; must contain `CLAUDE.md` |
| `WA_DB_PATH` | `/home/deet/whatsapp-mcp/whatsapp-bridge/store/messages.db` | Path to the bridge SQLite DB |
| `STATE_PATH` | `./state.json` | Where to persist watermark and sent IDs |
| `CLAUDE_TIMEOUT_SECONDS` | `60` | Per-invocation timeout for `claude -p` |

---

## Expected DB path

```
/home/deet/whatsapp-mcp/whatsapp-bridge/store/messages.db
```

Set `WA_DB_PATH` in `.env` to override. The DB is opened read-only by the poller.

---

## state.json behaviour

```json
{
  "last_seen_ts": "2026-04-21T18:30:00",
  "sent_ids": ["ACxxxx", "ACyyyy"]
}
```

- **`last_seen_ts`** — ISO-8601 UTC timestamp with microseconds. Used as a coarse global floor only.
- **`sent_ids`** — IDs of outbound messages that Claude sent (detected by querying the DB after each invocation, filtered to the current chat and `is_from_me = 1`). Capped at the most recent **500** entries.
- **`seen_ids`** — IDs of inbound messages already processed successfully, also capped as a sliding window to avoid duplicate handling when timestamps collide.
- **`chat_watermarks`** — per-chat successful watermarks so one failing chat does not advance the others past unprocessed messages.

On a **fresh start** (no `state.json`), `last_seen_ts` is set to the current time so existing history is not replayed. To replay from a specific point, set `last_seen_ts` manually.

---

## How Claude sends replies

The poller passes the prompt to `claude -p` with `--no-markdown`. Claude is instructed (via `CLAUDE.md`) to call the `send_message` MCP tool with the recipient JID and reply text. The poller does **not** parse stdout; instead it detects the outbound messages by reading the DB after each invocation and recording the new IDs in `sent_ids`.

---

## Current assumptions and limitations

- **Single WhatsApp account.** The Go bridge and the phone share one account, so `is_from_me` alone cannot distinguish Claude's outbound echoes from genuine received messages. Deduplication relies entirely on `sent_ids` in `state.json`.
- **DB schema.** The poller assumes the schema described at the top of `poller/poller.py`. If the bridge changes its schema, update the SQL queries there.
- **One reply per poll cycle per chat.** If multiple chats receive messages in the same poll window, each gets one Claude invocation in sequence (not parallel).
- **`claude` CLI on PATH.** The poller shells out to `claude`. In Docker, the binary is bind-mounted from the host. Authentication (Anthropic API key / Claude subscription) must be configured for the host user.
- **MCP server must be reachable.** Claude discovers MCP servers via `~/.claude/` config or `.claude/settings.json` in `BOT_WORKING_DIR`. Make sure the whatsapp-mcp server is registered there.
- **No group-chat moderation.** The bot replies to every new message in every chat. Add filtering logic to `run()` in `poller.py` if you want to restrict which chats it responds to.
