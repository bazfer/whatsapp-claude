import os
import subprocess
import sys
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import webhook.server as server

ALLOWED_JID = "15551234567@s.whatsapp.net"
FORM_DATA = {"From": "whatsapp:+15551234567", "Body": "Hello"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = str(tmp_path / "test.db")
    monkeypatch.setattr(server, "WEBHOOK_DB_PATH", db_path)
    monkeypatch.setattr(server, "TWILIO_AUTH_TOKEN", "test_token")
    monkeypatch.setattr(server, "PUBLIC_WEBHOOK_URL", "https://example.com/webhook")
    monkeypatch.setattr(server, "ALLOWED_CHATS", set())
    monkeypatch.setattr(server, "BOT_WORKING_DIR", str(tmp_path))
    server._init_db(db_path)
    return TestClient(server.app)


def _mock_validator(valid: bool):
    mock_cls = MagicMock()
    mock_cls.return_value.validate.return_value = valid
    return mock_cls


def _mock_claude(stdout: str = "Hi!", returncode: int = 0):
    result = MagicMock()
    result.returncode = returncode
    result.stdout = stdout
    result.stderr = ""
    return result


def test_valid_post_allowed_returns_twiml(client):
    with (
        patch("webhook.server.RequestValidator", _mock_validator(True)),
        patch("subprocess.run", return_value=_mock_claude("Hello back!")),
    ):
        r = client.post(
            "/webhook",
            data=FORM_DATA,
            headers={"X-Twilio-Signature": "sig"},
        )
    assert r.status_code == 200
    assert "<Message>Hello back!</Message>" in r.text
    assert r.headers["content-type"].startswith("application/xml")


def test_valid_post_disallowed_jid_returns_empty(tmp_path, monkeypatch):
    db_path = str(tmp_path / "test.db")
    monkeypatch.setattr(server, "WEBHOOK_DB_PATH", db_path)
    monkeypatch.setattr(server, "TWILIO_AUTH_TOKEN", "test_token")
    monkeypatch.setattr(server, "PUBLIC_WEBHOOK_URL", "https://example.com/webhook")
    monkeypatch.setattr(server, "ALLOWED_CHATS", {"other@s.whatsapp.net"})
    monkeypatch.setattr(server, "BOT_WORKING_DIR", str(tmp_path))
    server._init_db(db_path)
    c = TestClient(server.app)

    with patch("webhook.server.RequestValidator", _mock_validator(True)):
        r = c.post("/webhook", data=FORM_DATA, headers={"X-Twilio-Signature": "sig"})

    assert r.status_code == 200
    assert r.text.strip() == server.EMPTY_TWIML


def test_wrong_signature_returns_403(client):
    with patch("webhook.server.RequestValidator", _mock_validator(False)):
        r = client.post(
            "/webhook",
            data=FORM_DATA,
            headers={"X-Twilio-Signature": "bad_sig"},
        )
    assert r.status_code == 403


def test_no_auth_token_skips_validation(tmp_path, monkeypatch):
    db_path = str(tmp_path / "test.db")
    monkeypatch.setattr(server, "WEBHOOK_DB_PATH", db_path)
    monkeypatch.setattr(server, "TWILIO_AUTH_TOKEN", None)
    monkeypatch.setattr(server, "ALLOWED_CHATS", set())
    monkeypatch.setattr(server, "BOT_WORKING_DIR", str(tmp_path))
    server._init_db(db_path)
    c = TestClient(server.app)

    with patch("subprocess.run", return_value=_mock_claude("Reply")):
        r = c.post("/webhook", data=FORM_DATA)

    assert r.status_code == 200
    assert "<Message>Reply</Message>" in r.text


def test_claude_timeout_returns_empty_response(client):
    with (
        patch("webhook.server.RequestValidator", _mock_validator(True)),
        patch(
            "subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="claude", timeout=60),
        ),
    ):
        r = client.post(
            "/webhook",
            data=FORM_DATA,
            headers={"X-Twilio-Signature": "sig"},
        )
    assert r.status_code == 200
    assert r.text.strip() == server.EMPTY_TWIML


def test_health_endpoint():
    c = TestClient(server.app)
    r = c.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
