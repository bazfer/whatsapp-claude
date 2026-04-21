import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from poller.poller import cap_sent_ids, ts_to_iso, iso_to_ts, _fmt_msg


def test_cap_sent_ids_under_limit():
    ids = list(range(10))
    assert cap_sent_ids(ids) == ids


def test_cap_sent_ids_over_limit():
    ids = list(range(600))
    result = cap_sent_ids(ids)
    assert len(result) == 500
    assert result == ids[-500:]


def test_ts_iso_roundtrip():
    ts = 1745272200.0
    assert abs(iso_to_ts(ts_to_iso(ts)) - ts) < 1


def test_fmt_msg_from_me():
    msg = {"timestamp": 1745272200, "is_from_me": 1, "content": "hi", "sender": "me@s.whatsapp.net"}
    line = _fmt_msg(msg)
    assert "me:" in line
    assert "hi" in line


def test_fmt_msg_from_them():
    sender = "5491234@s.whatsapp.net"
    msg = {"timestamp": 1745272200, "is_from_me": 0, "content": "hello", "sender": sender}
    line = _fmt_msg(msg)
    assert sender in line
    assert "hello" in line
