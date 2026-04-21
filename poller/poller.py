#!/usr/bin/env python3
"""
WhatsApp polling daemon.

Watches the whatsapp-bridge SQLite DB for new messages and invokes
`claude -p` so Claude can reply via the send_message MCP tool.

DB schema assumptions (adjust if bridge schema changes):
  Table: messages
  Columns:
    id          TEXT  PRIMARY KEY
    chat_jid    TEXT  — full JID, e.g. "5491112223333@s.whatsapp.net"
    sender      TEXT  — JID of the sender (may equal chat_jid for 1-1 chats)
    content     TEXT  — message body
    timestamp   INTEGER — Unix epoch seconds
    is_from_me  INTEGER — 1 if sent by the local account, 0 otherwise

  Table: chats (optional, not required for core operation)
    jid   TEXT PRIMARY KEY
    name  TEXT
"""

import json
import logging
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Any
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration (env vars with defaults)
# ---------------------------------------------------------------------------

POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL_SECONDS", "10"))
HISTORY_MESSAGES = int(os.environ.get("HISTORY_MESSAGES", "10"))
BOT_WORKING_DIR = os.environ.get("BOT_WORKING_DIR", str(Path(__file__).parent.parent))
WA_DB_PATH = os.environ.get(
    "WA_DB_PATH", "/home/deet/whatsapp-mcp/whatsapp-bridge/store/messages.db"
)
STATE_PATH = os.environ.get("STATE_PATH", "./state.json")

CLAUDE_TIMEOUT = int(os.environ.get("CLAUDE_TIMEOUT_SECONDS", "60"))
SENT_IDS_CAP = 500

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("poller")

# ---------------------------------------------------------------------------
# State helpers
# ---------------------------------------------------------------------------


def load_state(path: str) -> dict:
    """Load persisted state or return empty dict on first run."""
    try:
        with open(path) as f:
            state = json.load(f)
        log.info("Loaded state from %s (last_seen_ts=%s)", path, state.get("last_seen_ts"))
        return state
    except FileNotFoundError:
        return {}
    except Exception as e:
        log.warning("Could not read state file %s: %s — starting fresh", path, e)
        return {}


def save_state(path: str, state: dict) -> None:
    """Atomic write: write to .tmp then rename."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, path)


def now_iso() -> str:
    return ts_to_iso(float(int(time.time())))


def iso_to_ts(iso: str) -> float:
    """Parse ISO-8601 UTC string back to epoch seconds with sub-second precision."""
    return datetime.fromisoformat(iso).timestamp()


def ts_to_iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# DB queries
# ---------------------------------------------------------------------------


def _open_db(db_path: str) -> sqlite3.Connection:
    # Open read-only via URI; raises OperationalError if file missing
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def query_new_messages(
    db_path: str, since_ts: float, seen_ids: set[str] | None = None, chat_jid: str | None = None
) -> list[dict]:
    """Return unseen messages with timestamp >= since_ts, oldest first."""
    try:
        con = _open_db(db_path)
        sql = """
            SELECT id, chat_jid, sender, content, timestamp, is_from_me
            FROM messages
            WHERE timestamp >= ?
              AND is_from_me = 0
        """
        params: list[Any] = [since_ts]
        if chat_jid is not None:
            sql += " AND chat_jid = ?"
            params.append(chat_jid)
        sql += " ORDER BY timestamp ASC, id ASC"
        cur = con.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]
        if seen_ids:
            rows = [r for r in rows if r["id"] not in seen_ids]
        con.close()
        return rows
    except Exception as e:
        log.error("DB query (new messages) failed: %s", e)
        return []


def query_messages_since(
    db_path: str,
    since_ts: float,
    chat_jid: str | None = None,
    is_from_me: int | None = None,
    seen_ids: set[str] | None = None,
) -> list[dict]:
    """Return messages with timestamp >= since_ts, with optional chat/from-me filters."""
    try:
        con = _open_db(db_path)
        sql = """
            SELECT id, chat_jid, sender, content, timestamp, is_from_me
            FROM messages
            WHERE timestamp >= ?
        """
        params: list[Any] = [since_ts]
        if chat_jid is not None:
            sql += " AND chat_jid = ?"
            params.append(chat_jid)
        if is_from_me is not None:
            sql += " AND is_from_me = ?"
            params.append(is_from_me)
        sql += " ORDER BY timestamp ASC, id ASC"
        cur = con.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]
        if seen_ids:
            rows = [r for r in rows if r["id"] not in seen_ids]
        con.close()
        return rows
    except Exception as e:
        log.error("DB query (since) failed: %s", e)
        return []


def query_history(db_path: str, chat_jid: str, limit: int) -> list[dict]:
    """Return the last `limit` messages for a chat, oldest first."""
    try:
        con = _open_db(db_path)
        cur = con.execute(
            """
            SELECT id, sender, content, timestamp, is_from_me
            FROM messages
            WHERE chat_jid = ?
            ORDER BY timestamp DESC
            LIMIT ?
            """,
            (chat_jid, limit),
        )
        rows = list(reversed([dict(r) for r in cur.fetchall()]))
        con.close()
        return rows
    except Exception as e:
        log.error("DB history query failed for %s: %s", chat_jid, e)
        return []


def query_active_chats(db_path: str, since_ts: float) -> list[str]:
    """Return chat_jid values that have traffic at or after the coarse global floor."""
    try:
        con = _open_db(db_path)
        cur = con.execute(
            """
            SELECT DISTINCT chat_jid
            FROM messages
            WHERE timestamp >= ?
            ORDER BY chat_jid ASC
            """,
            (since_ts,),
        )
        rows = [r["chat_jid"] for r in cur.fetchall() if r["chat_jid"]]
        con.close()
        return rows
    except Exception as e:
        log.error("DB active chats query failed: %s", e)
        return []


# ---------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------


def _fmt_msg(msg: dict) -> str:
    ts = datetime.fromtimestamp(msg["timestamp"], tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    role = "me" if msg["is_from_me"] else msg.get("sender", "them")
    return f"[{ts}] {role}: {msg.get('content', '')}"


def build_prompt(recipient_jid: str, history: list[dict], new_msgs: list[dict]) -> str:
    history_text = "\n".join(_fmt_msg(m) for m in history) if history else "(no prior history)"
    new_text = "\n".join(_fmt_msg(m) for m in new_msgs)
    n = HISTORY_MESSAGES
    return (
        f"You are a WhatsApp assistant. A new message arrived. "
        f"Reply using the send_message MCP tool.\n\n"
        f"Recipient: {recipient_jid}\n\n"
        f"Recent conversation (last {n} messages):\n{history_text}\n\n"
        f"New message: {new_text}"
    )


# ---------------------------------------------------------------------------
# Claude invocation
# ---------------------------------------------------------------------------


def call_claude(prompt: str) -> bool:
    """
    Invoke `claude -p <prompt> --no-markdown` from BOT_WORKING_DIR.
    Claude is expected to call send_message via MCP; we do NOT parse stdout.
    Returns True if claude exited 0, False otherwise.
    """
    try:
        result = subprocess.run(
            ["claude", "-p", prompt, "--no-markdown"],
            cwd=BOT_WORKING_DIR,
            capture_output=True,
            text=True,
            timeout=CLAUDE_TIMEOUT,
        )
        if result.returncode != 0:
            log.error("claude exited %d: %s", result.returncode, result.stderr.strip()[:400])
            return False
        log.debug("claude stdout: %s", result.stdout.strip()[:200])
        return True
    except FileNotFoundError:
        log.error("`claude` CLI not found — is it on PATH?")
        return False
    except subprocess.TimeoutExpired:
        log.error("claude timed out after %ds (prompt truncated): %s…", CLAUDE_TIMEOUT, prompt[:80])
        return False
    except Exception as e:
        log.error("Unexpected error calling claude: %s", e)
        return False


# ---------------------------------------------------------------------------
# sent_ids management
# ---------------------------------------------------------------------------


def cap_sent_ids(ids: list) -> list:
    """Keep only the most recent SENT_IDS_CAP entries."""
    if len(ids) > SENT_IDS_CAP:
        return ids[-SENT_IDS_CAP:]
    return ids


# ---------------------------------------------------------------------------
# Per-chat processing
# ---------------------------------------------------------------------------


def process_chat(chat_jid: str, new_msgs: list[dict], state: dict) -> tuple[bool, float | None]:
    """
    Build prompt, call claude, then detect Claude's outbound replies by querying
    the DB for messages that appeared after the invocation started.
    Returns (success, watermark_ts_for_this_chat).
    """
    sent_ids: set = set(state.get("sent_ids", []))

    history = query_history(WA_DB_PATH, chat_jid, HISTORY_MESSAGES)
    # Always reply to the conversation JID. In group chats, sender is the participant, not the room.
    recipient_jid = chat_jid
    prompt = build_prompt(recipient_jid, history, new_msgs)

    invocation_start = datetime.now(timezone.utc).timestamp()
    log.info("Invoking claude for chat=%s (%d new message(s))", chat_jid, len(new_msgs))

    success = call_claude(prompt)
    if not success:
        return False, None

    # Detect Claude's replies: messages that appeared in the DB after invocation started
    # and are not already tracked. These are the outbound messages Claude sent via MCP.
    post_rows = query_messages_since(
        WA_DB_PATH, invocation_start, chat_jid=chat_jid, is_from_me=1, seen_ids=sent_ids
    )
    new_outbound = [
        r["id"] for r in post_rows
        if r["id"] not in sent_ids
    ]
    if new_outbound:
        log.info("Detected %d new outbound id(s) from Claude: %s", len(new_outbound), new_outbound)
        sent_ids.update(new_outbound)

    ids_list = cap_sent_ids(list(sent_ids))
    state["sent_ids"] = ids_list
    watermark_ts = max(msg["timestamp"] for msg in new_msgs)
    return True, watermark_ts


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def run() -> None:
    state = load_state(STATE_PATH)

    # On fresh start anchor to now so we don't replay history.
    # If state.json exists, last_seen_ts is already set.
    if "last_seen_ts" not in state:
        state["last_seen_ts"] = now_iso()
        log.info("Fresh start — anchoring last_seen_ts to %s", state["last_seen_ts"])
    if "sent_ids" not in state:
        state["sent_ids"] = []
    if "chat_watermarks" not in state:
        state["chat_watermarks"] = {}
    if "seen_ids" not in state:
        state["seen_ids"] = []

    save_state(STATE_PATH, state)

    log.info(
        "Poller started. DB=%s interval=%ds cwd=%s",
        WA_DB_PATH, POLL_INTERVAL, BOT_WORKING_DIR,
    )

    while True:
        try:
            coarse_floor_iso = state["last_seen_ts"]
            coarse_floor_ts = iso_to_ts(coarse_floor_iso)
            sent_ids = set(state.get("sent_ids", []))
            seen_ids = set(state.get("seen_ids", []))
            chat_watermarks_raw = state.get("chat_watermarks", {})
            chat_watermarks: dict[str, float] = {
                jid: iso_to_ts(ts) if isinstance(ts, str) else float(ts)
                for jid, ts in chat_watermarks_raw.items()
            }
            newly_seen_ids: set[str] = set()

            active_chats = (
                set(query_active_chats(WA_DB_PATH, coarse_floor_ts)) | set(chat_watermarks.keys())
            )

            for chat_jid in sorted(active_chats):
                try:
                    chat_since = chat_watermarks.get(chat_jid, coarse_floor_ts)
                    chat_seen_ids = sent_ids | seen_ids | newly_seen_ids
                    msgs = query_new_messages(
                        WA_DB_PATH,
                        chat_since,
                        seen_ids=chat_seen_ids,
                        chat_jid=chat_jid,
                    )
                    if not msgs:
                        continue

                    ok, watermark_ts = process_chat(chat_jid, msgs, state)
                    sent_ids = set(state.get("sent_ids", []))
                    if ok and watermark_ts is not None:
                        newly_seen_ids.update(msg["id"] for msg in msgs)
                        previous = chat_watermarks.get(chat_jid, coarse_floor_ts)
                        chat_watermarks[chat_jid] = max(previous, watermark_ts)
                    else:
                        log.warning(
                            "Claude invocation failed for %s; watermark unchanged, messages will retry",
                            chat_jid,
                        )
                except Exception as e:
                    log.error("Unhandled error processing chat %s: %s", chat_jid, e)

            state["chat_watermarks"] = {
                jid: ts_to_iso(ts) for jid, ts in chat_watermarks.items()
            }
            state["seen_ids"] = cap_sent_ids(list(seen_ids | newly_seen_ids))
            if chat_watermarks:
                state["last_seen_ts"] = ts_to_iso(min(chat_watermarks.values()))
            save_state(STATE_PATH, state)

        except Exception as e:
            log.error("Poll cycle error: %s", e)

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        log.info("Poller stopped by user")
        sys.exit(0)
