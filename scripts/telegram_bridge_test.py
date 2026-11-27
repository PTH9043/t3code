"""Offline regression suite. Run with the configured Telethon Python and -B -I."""
import asyncio
from contextlib import closing
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from telethon import errors, functions, types


SCRIPT = Path(__file__).with_name("telegram-bridge.py").resolve()
spec = importlib.util.spec_from_file_location("telegram_bridge", SCRIPT)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
MARKED = "-1000000000123"
DATE = datetime(2025, 1, 2, tzinfo=timezone.utc)


class MockTelegram:
    def __init__(self):
        self.channel = types.Channel(123, "Test channel", types.ChatPhotoEmpty(), DATE,
                                     access_hash=456, username="example")
        self.me = SimpleNamespace(bot=False)
        self.messages = []
        self.targets = []
        self.calls = []
        self.closed = False
        self.fail = None

    async def connect(self):
        pass

    async def disconnect(self):
        self.closed = True

    async def get_me(self):
        return self.me

    async def get_entity(self, target):
        self.targets.append(target)
        return self.channel

    async def __call__(self, req):
        assert isinstance(req, (functions.messages.GetHistoryRequest, functions.messages.SearchRequest))
        assert isinstance(req.peer, types.InputPeerChannel) and req.peer.channel_id == 123
        assert req.add_offset == -req.limit and 0 < req.limit <= 100
        self.calls.append(req)
        if self.fail and len(self.calls) == self.fail[0]:
            raise self.fail[1]
        rows = [msg for msg in self.messages if msg.id >= req.offset_id]
        if isinstance(req, functions.messages.SearchRequest):
            rows = [msg for msg in rows if req.q in (msg.message or "")]
        # Telegram returns newest first, sometimes fewer than requested even in
        # the middle of a channel. This also exercises a one-row lookahead.
        return SimpleNamespace(messages=list(reversed(rows[:min(3, req.limit)])))

    def append(self, mid, text="text"):
        self.messages.append(types.Message(mid, types.PeerChannel(123), date=DATE,
                                           edit_date=DATE, message=text))


@unittest.skipUnless(sys.platform == "win32", "Windows file sharing contract")
class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch("asyncio.BaseEventLoop.create_connection", side_effect=AssertionError("offline")))
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.file = self.root / "existing.session"
        self.dotenv = self.root / ".env"
        self.dotenv.write_text("TG_API_ID=123\nTG_API_HASH='" + "a" * 32 + "'\n", encoding="utf-8")
        with closing(sqlite3.connect(self.file)) as db:
            db.execute("CREATE TABLE sessions(dc_id, server_address, port, auth_key)")
            db.execute("CREATE TABLE entities(id, hash)")
            db.execute("INSERT INTO sessions VALUES(1,'127.0.0.1',443,zeroblob(256))")
            db.execute("INSERT INTO entities VALUES(-1000000000123,456)")
            db.commit()
        self.env = {"T3_TELEGRAM_SESSION_FILE": str(self.file), "T3_TELEGRAM_ENV_FILE": str(self.dotenv),
                    "T3_TELEGRAM_PEER_ID": MARKED}
        self.client = MockTelegram()
        self.factory = self.enterContext(patch.object(bridge, "existing_client", return_value=self.client))

    def packet(self, req):
        return asyncio.run(bridge.packet(json.dumps(req).encode(), self.env))

    def page(self, cursor=0, limit=3, **changes):
        return self.packet({"op": "read", "peerId": MARKED, "cursor": cursor, "limit": limit, **changes})

    def cli(self, raw, **config):
        # Keep all account settings independent of the caller's environment.
        proc = subprocess.run([sys.executable, "-B", "-I", "-X", "utf8", str(SCRIPT)], cwd=self.root,
                              env={**os.environ, **self.env, **config}, input=raw,
                              capture_output=True, check=True, timeout=10)
        self.assertEqual(proc.stderr, b"")
        return json.loads(proc.stdout)

    def test_paging_resume_at_end_then_new_post(self):
        for mid in (1, 5, 18, 19, 32, 97):
            self.client.append(mid, "테스트")
        first = self.page()["result"]
        self.assertEqual([m["id"] for m in first["messages"]], [1, 5, 18])
        self.assertFalse(first["endReached"])
        self.assertEqual(first["messages"][0], {"id": 1, "date": DATE.isoformat(), "text": "테스트",
                         "editDate": DATE.isoformat(), "link": "https://t.me/example/1"})
        last = self.page(first["continuation"])["result"]
        self.assertEqual([m["id"] for m in last["messages"]], [19, 32, 97])
        self.assertEqual((last["endReached"], last["continuation"]), (True, 97))
        self.assertEqual(self.page(97)["result"], {"messages": [], "endReached": True,
                         "continuation": 97, "peerId": MARKED, "unavailableIds": []})
        self.client.append(1001)
        self.assertEqual(self.page(97)["result"]["messages"][0]["id"], 1001)

    def test_unavailable_page_and_private_link(self):
        self.client.channel.username = None
        self.client.messages = [types.MessageEmpty(i, None) for i in (2, 4, 9)]
        self.client.append(11)
        first = self.page()["result"]
        self.assertEqual(first["messages"], [])
        self.assertEqual(first["unavailableIds"], [2, 4, 9])
        self.assertEqual((first["endReached"], first["continuation"]), (False, 9))
        last = self.page(9)["result"]
        self.assertEqual(last["messages"][0]["link"], "https://t.me/c/123/11")
        self.assertEqual(last["unavailableIds"], [])

    def test_search_scoped_and_no_total_history_cap(self):
        for mid in range(1, 253):
            self.client.append(mid, "match" if mid % 2 == 0 else "other")
        page = self.page(limit=125, op="search", query="match")["result"]
        self.assertEqual([m["id"] for m in page["messages"]], list(range(2, 251, 2)))
        self.assertFalse(page["endReached"])
        self.assertEqual(self.page(page["continuation"], op="search", query="match")["result"]
                         ["continuation"], 252)
        self.assertTrue(all(isinstance(call, functions.messages.SearchRequest) for call in self.client.calls))

    def test_status_listing_scope_and_binding(self):
        self.assertEqual(self.packet({"op": "status"})["result"], {"authorized": True})
        self.assertEqual(self.packet({"op": "list", "targets": ["@example", "@example"]})["result"],
                         {"peers": [{"peerId": MARKED, "title": "Test channel"}]})
        self.assertEqual(self.client.targets, ["@example"])
        self.env["T3_TELEGRAM_TARGET"] = "@renamed"
        self.client.channel.id += 1
        self.assertEqual(self.page()["error"]["code"], "peer_mismatch")
        self.assertEqual(self.client.calls, [])
        self.assertTrue(self.client.closed)
        self.client.me = None
        self.assertEqual(self.packet({"op": "status"})["result"], {"authorized": False})
        self.assertEqual(self.page()["error"]["code"], "unauthorized")

    def test_validation_before_session_access(self):
        for req in (None, [], {}, {"op": "send"}, {"op": "search"}, {"op": "list", "targets": []},
                    {"op": "list", "targets": ["+12345678"]}, {"op": "status", "session": str(self.file)}):
            self.assertEqual(self.packet(req)["error"]["code"], "invalid_request")
        for kwargs in ({"cursor": -1}, {"cursor": True}, {"limit": 0}, {"limit": False},
                       {"op": "search", "query": " "}, {"peerId": "@handle"}):
            self.assertEqual(self.page(**kwargs)["error"]["code"], "invalid_request")
        self.assertEqual(self.page(peerId="-1000000000124")["error"]["code"], "unregistered_peer")
        self.env.pop("T3_TELEGRAM_PEER_ID")
        self.assertEqual(self.page()["error"]["code"], "unregistered_peer")
        self.factory.assert_not_called()

    def test_errors_discard_partial_pages(self):
        for mid in range(1, 8):
            self.client.append(mid)
        for error, code, retry in [(errors.ChannelPrivateError(None), "access_denied", False),
                                  (errors.ChannelInvalidError(None), "peer_not_found", False),
                                  (errors.FloodWaitError(None, 17), "flood_wait", True),
                                  (errors.MessageIdInvalidError(None), "message_unavailable", False),
                                  (ConnectionError("private sentinel"), "network_unavailable", True)]:
            self.client.calls.clear()
            self.client.fail = (2, error)
            result = self.page(limit=5)
            expected = {"code": code, "retryable": retry}
            if code == "flood_wait":
                expected["retryAfterSeconds"] = 17
            self.assertEqual(result, {"ok": False, "error": expected})
            self.assertTrue(self.client.closed)

    def test_original_sqlite_open_and_concurrent_reader(self):
        import _winapi

        status = b'{"op":"status"}'
        busy = {"ok": False, "error": {"code": "session_busy", "retryable": True}}
        handle = _winapi.CreateFile(str(self.file), _winapi.GENERIC_READ, 0, 0,
                                    _winapi.OPEN_EXISTING, 0, 0)
        try:
            self.assertEqual(self.cli(status), busy)
        finally:
            _winapi.CloseHandle(handle)
        with closing(sqlite3.connect(self.file)) as owner:
            owner.execute("SELECT 1 FROM sessions").fetchone()  # idle between transactions
            self.assertEqual(self.cli(status), busy)
        with bridge.session_reader(self.file):
            self.assertEqual(self.cli(status), busy)
        self.assertEqual(self.packet({"op": "status"})["result"], {"authorized": True})

    def test_pending_journal_is_left_to_the_owner(self):
        journal = self.root / "existing.session-journal"
        journal.write_bytes(b"fixture")
        self.assertEqual(self.packet({"op": "status"})["error"],
                         {"code": "session_busy", "retryable": True})
        self.assertEqual(journal.read_bytes(), b"fixture")
        self.factory.assert_not_called()

    def test_read_only_session_and_no_sidecars(self):
        # Exercise the installed Telethon session interface without connecting.
        before = self.file.read_bytes()  # entirely synthetic fixture
        with bridge.session_reader(self.file) as db:
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("DELETE FROM entities")
            async def make_session():
                client = REAL_FACTORY(db, self.dotenv)
                self.assertEqual(client.session.get_input_entity(int(MARKED)).channel_id, 123)
                self.assertIsNotNone(client.session.auth_key)
                client.session.save()
                await client.disconnect()
            asyncio.run(make_session())
        self.assertEqual(self.file.read_bytes(), before)
        self.assertEqual(set(self.root.iterdir()), {self.file, self.dotenv})

    def test_protocol_errors_no_stderr_or_secret_echo(self):
        self.assertEqual(self.cli(b"private sentinel"), {"ok": False, "error":
                         {"code": "invalid_request", "retryable": False}})
        status = b'{"op":"status"}'
        self.assertEqual(self.cli(status, T3_TELEGRAM_ENV_FILE=".env")["error"]["code"], "invalid_config")
        self.assertEqual(self.cli(status, T3_TELEGRAM_SESSION_FILE=str(self.root / "absent"))["error"]
                         ["code"], "invalid_config")
        self.assertFalse((self.root / "absent").exists())
        with closing(sqlite3.connect(self.file)) as db:
            db.execute("UPDATE sessions SET auth_key=NULL")
            db.commit()
        self.assertEqual(self.cli(status), {"ok": True, "result": {"authorized": False}})
        self.dotenv.write_text("TG_API_ID=private-sentinel", encoding="utf-8")
        self.assertEqual(self.cli(status), {"ok": False, "error": {"code": "invalid_config",
                                                                    "retryable": False}})


REAL_FACTORY = bridge.existing_client

if __name__ == "__main__":
    unittest.main()
