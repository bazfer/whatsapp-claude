import logging
import os
import sqlite3
import subprocess
import uuid
from datetime import datetime, timezone
from xml.sax.saxutils import escape

from fastapi import FastAPI, HTTPException, Request, Response
from twilio.request_validator import RequestValidator

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

TWILIO_AUTH_TOKEN: str | None = os.getenv("TWILIO_AUTH_TOKEN")
PUBLIC_WEBHOOK_URL: str = os.getenv("PUBLIC_WEBHOOK_URL", "")
WEBHOOK_DB_PATH: str = os.getenv("WEBHOOK_DB_PATH", "webhook_messages.db")
HISTORY_MESSAGES: int = int(os.getenv("HISTORY_MESSAGES", "10"))
BOT_WORKING_DIR: str = os.getenv("BOT_WORKING_DIR", ".")
CLAUDE_TIMEOUT: int = int(os.getenv("CLAUDE_TIMEOUT_SECONDS", "60"))
_allowed_raw = os.getenv("ALLOWED_CHATS", "")
ALLOWED_CHATS: set[str] = (
    {c.strip() for c in _allowed_raw.split(",") if c.strip()} if _allowed_raw else set()
)

EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>'

app = FastAPI()


def _init_db(path: str) -> None:
    con = sqlite3.connect(path)
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            chat_jid TEXT,
            sender TEXT,
            content TEXT,
            timestamp INTEGER,
            is_from_me INTEGER
        )
        """
    )
    con.commit()
    con.close()


def _normalize_jid(from_field: str) -> str:
    num = from_field.removeprefix("whatsapp:").lstrip("+")
    return f"{num}@s.whatsapp.net"


def _fmt_msg(msg: dict) -> str:
    ts = datetime.fromtimestamp(float(msg["timestamp"]), tz=timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    role = "me" if msg["is_from_me"] else msg.get("sender", "them")
    return f"[{ts}] {role}: {msg.get('content', '')}"


def _build_prompt(recipient_jid: str, history: list[dict], new_msg: dict) -> str:
    n = HISTORY_MESSAGES
    history_text = "\n".join(_fmt_msg(m) for m in history) if history else "(no prior history)"
    new_text = _fmt_msg(new_msg)
    return (
        f"You are a WhatsApp assistant. A new message arrived. "
        f"Print your reply as plain text to stdout. Do not call any MCP tools.\n\n"
        f"Recipient: {recipient_jid}\n\n"
        f"Recent conversation (last {n} messages):\n{history_text}\n\n"
        f"New message: {new_text}"
    )


def _insert_message(
    path: str,
    msg_id: str,
    chat_jid: str,
    sender: str,
    content: str,
    timestamp: int,
    is_from_me: int,
) -> None:
    con = sqlite3.connect(path)
    con.execute(
        "INSERT OR IGNORE INTO messages (id, chat_jid, sender, content, timestamp, is_from_me)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (msg_id, chat_jid, sender, content, timestamp, is_from_me),
    )
    con.commit()
    con.close()


def _query_history(path: str, chat_jid: str, exclude_id: str) -> list[dict]:
    con = sqlite3.connect(path)
    rows = con.execute(
        """
        SELECT id, chat_jid, sender, content, timestamp, is_from_me
        FROM messages
        WHERE chat_jid = ? AND id != ?
        ORDER BY timestamp DESC
        LIMIT ?
        """,
        (chat_jid, exclude_id, HISTORY_MESSAGES),
    ).fetchall()
    con.close()
    rows.reverse()
    return [
        {
            "id": r[0],
            "chat_jid": r[1],
            "sender": r[2],
            "content": r[3],
            "timestamp": r[4],
            "is_from_me": r[5],
        }
        for r in rows
    ]


def _twiml_message(body: str) -> str:
    escaped_body = escape(body)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"<Response><Message>{escaped_body}</Message></Response>"
    )


@app.on_event("startup")
async def startup() -> None:
    _init_db(WEBHOOK_DB_PATH)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/webhook")
async def webhook(request: Request) -> Response:
    form_data = dict(await request.form())

    if TWILIO_AUTH_TOKEN:
        signature = request.headers.get("X-Twilio-Signature", "")
        validator = RequestValidator(TWILIO_AUTH_TOKEN)
        if not validator.validate(PUBLIC_WEBHOOK_URL, form_data, signature):
            raise HTTPException(status_code=403, detail="Invalid Twilio signature")
    else:
        log.warning("TWILIO_AUTH_TOKEN is not set — skipping signature validation")

    from_field = str(form_data.get("From", ""))
    body = str(form_data.get("Body", ""))
    chat_jid = _normalize_jid(from_field)

    if ALLOWED_CHATS and chat_jid not in ALLOWED_CHATS:
        log.info("Ignoring message from disallowed JID: %s", chat_jid)
        return Response(content=EMPTY_TWIML, media_type="application/xml")

    now = int(datetime.now(tz=timezone.utc).timestamp())
    msg_id = str(uuid.uuid4())
    _insert_message(WEBHOOK_DB_PATH, msg_id, chat_jid, chat_jid, body, now, 0)

    history = _query_history(WEBHOOK_DB_PATH, chat_jid, msg_id)
    inbound = {
        "id": msg_id,
        "chat_jid": chat_jid,
        "sender": chat_jid,
        "content": body,
        "timestamp": now,
        "is_from_me": 0,
    }
    prompt = _build_prompt(chat_jid, history, inbound)

    try:
        result = subprocess.run(
            ["claude", "-p", prompt],
            cwd=BOT_WORKING_DIR,
            capture_output=True,
            text=True,
            timeout=CLAUDE_TIMEOUT,
        )
        if result.returncode != 0:
            log.error("claude exited %d: %s", result.returncode, result.stderr.strip()[:400])
            return Response(content=EMPTY_TWIML, media_type="application/xml")
        reply = result.stdout.strip()
    except subprocess.TimeoutExpired:
        log.error("claude timed out after %ds", CLAUDE_TIMEOUT)
        return Response(content=EMPTY_TWIML, media_type="application/xml")
    except FileNotFoundError:
        log.error("`claude` CLI not found — is it on PATH?")
        return Response(content=EMPTY_TWIML, media_type="application/xml")
    except Exception as e:
        log.error("Unexpected error calling claude: %s", e)
        return Response(content=EMPTY_TWIML, media_type="application/xml")

    if not reply:
        log.error("claude returned empty stdout")
        return Response(content=EMPTY_TWIML, media_type="application/xml")

    out_id = str(uuid.uuid4())
    _insert_message(
        WEBHOOK_DB_PATH,
        out_id,
        chat_jid,
        "me",
        reply,
        int(datetime.now(tz=timezone.utc).timestamp()),
        1,
    )

    return Response(content=_twiml_message(reply), media_type="application/xml")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app, host=os.getenv("WEBHOOK_HOST", "0.0.0.0"), port=int(os.getenv("WEBHOOK_PORT", "8000"))
    )
