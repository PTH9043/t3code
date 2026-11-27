"""One local RPC per process. Launch with -B -I -X utf8 and the account folder as cwd.

Server-only environment: T3_TELEGRAM_ENV_FILE and T3_TELEGRAM_SESSION_FILE
(absolute existing files). For read/search also set T3_TELEGRAM_PEER_ID to
the project's registered marked channel ID. T3_TELEGRAM_TARGET can supply its
registered @username if the original session has no cached channel access hash.

UTF-8 JSON stdin to EOF -> one stdout JSON envelope, exit 0 for protocol errors.
  {"op":"status"} -> {authorized}
  {"op":"list","targets":["@example"]} -> {peers:[{peerId,title}]}
  {"op":"read","peerId":"-1001234567890","cursor":0,"limit":100}
  {"op":"search","peerId":"-1001234567890","cursor":0,"limit":100,"query":"news"}
  -> {peerId,messages:[{id,date,editDate,text,link}],unavailableIds,endReached,continuation}
  Envelope: {"ok":true,"result":...} or {"ok":false,"error":{code,retryable,retryAfterSeconds?}}
Cursor is exclusive. Commit continuation with the whole page, including empty
placeholders. Poll from that same cursor after reaching the current end.
"""

import asyncio
from contextlib import closing, contextmanager
from datetime import timezone
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import sys


class BridgeError(Exception):
    def __init__(self, code, retryable=False, **details):
        super().__init__(code)
        self.packet = {"code": code, "retryable": retryable, **details}


def channel_id(value):
    return (isinstance(value, str) and re.fullmatch(r"-[1-9][0-9]{12,18}", value)
            and 10**12 < -int(value) <= 2**63 - 1)


def username(value):
    return isinstance(value, str) and re.fullmatch(r"@[A-Za-z][A-Za-z0-9_]{0,31}", value)


MAX_MESSAGE_ID = 2**31 - 1  # MTProto message/offset IDs are signed TL ints.


def validate(req, env):
    fields = {
        "status": {"op"},
        "lookup": {"op", "title"},
        "list": {"op", "targets"},
        "read": {"op", "peerId", "cursor", "limit"},
        "search": {"op", "peerId", "cursor", "limit", "query"},
    }
    op = req.get("op") if isinstance(req, dict) else None
    if not isinstance(op, str) or fields.get(op) != req.keys():
        raise BridgeError("invalid_request")
    if op == "lookup" and not (isinstance(req["title"], str) and req["title"].strip()
                               and not any(c in req["title"] for c in "\r\n\0")):
        raise BridgeError("invalid_request")
    if op == "list":
        targets = req["targets"]
        if not isinstance(targets, list) or not targets or not all(
            username(target) or channel_id(target) for target in targets
        ):
            raise BridgeError("invalid_request")
    if op in ("read", "search"):
        if not channel_id(req["peerId"]) or (
            type(req["cursor"]) is not int or not 0 <= req["cursor"] <= MAX_MESSAGE_ID
            or type(req["limit"]) is not int or req["limit"] <= 0
        ):
            raise BridgeError("invalid_request")
        if op == "search" and not (isinstance(req["query"], str) and req["query"].strip()):
            raise BridgeError("invalid_request")
        if req["peerId"] != env.get("T3_TELEGRAM_PEER_ID"):
            raise BridgeError("unregistered_peer")
        hint = env.get("T3_TELEGRAM_TARGET")
        if hint and not username(hint) and hint != req["peerId"]:
            raise BridgeError("invalid_config")


def configured_file(env, key):
    path = Path(env.get(key, ""))
    if not path.is_absolute() or not path.is_file():
        raise BridgeError("invalid_config")
    return path.resolve(strict=True)


@contextmanager
def session_reader(path):
    """Keep a Windows deny-write handle until the client has disconnected."""
    if sys.platform != "win32":
        raise BridgeError("unsupported_session_lock")
    import _winapi
    import ctypes
    from ctypes import wintypes
    import msvcrt

    # FILE_SHARE_READ lets SQLite open its read-only handle while excluding an
    # already-open writable Telethon connection, even between transactions.
    try:
        handle = _winapi.CreateFile(str(path), _winapi.GENERIC_READ, 1, 0,
                                    _winapi.OPEN_EXISTING, 0, 0)
    except OSError as exc:
        if exc.winerror in (32, 33):
            raise BridgeError("session_busy", True) from None
        raise BridgeError("session_unavailable") from None
    with os.fdopen(msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY), "rb") as guard:
        # Other read-only bridge instances must serialize on this file too.
        stat = os.fstat(guard.fileno())
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
        kernel.CreateMutexW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        name = f"Global\\T3TelegramSession-{stat.st_dev:x}-{stat.st_ino:x}"
        mutex = kernel.CreateMutexW(None, False, name)
        if not mutex:
            raise BridgeError("session_unavailable")
        try:
            if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
                raise BridgeError("session_busy", True)
            # SQLite may need to recover a journal or create/map WAL sidecars.
            # Leave all such work to the owner. Never use immutable/nolock.
            if any(Path(str(path) + ext).exists() for ext in ("-wal", "-shm", "-journal")):
                raise BridgeError("session_busy", True)
            header = guard.read(20)
            if header[:16] != b"SQLite format 3\0":
                raise BridgeError("invalid_session")
            if header[18:20] != b"\x01\x01":
                raise BridgeError("unsupported_session_format")
            with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0)) as db:
                yield db
        finally:
            kernel.CloseHandle(mutex)


def existing_client(db, env_file):
    from dotenv import dotenv_values
    from telethon import TelegramClient
    from telethon.crypto import AuthKey
    from telethon.sessions import SQLiteSession

    config = dotenv_values(env_file, encoding="utf-8-sig", interpolate=False)
    api_id = (config.get("TG_API_ID") or "").strip()
    api_hash = (config.get("TG_API_HASH") or "").strip()
    if not re.fullmatch(r"[1-9][0-9]*", api_id) or not re.fullmatch(r"[a-fA-F0-9]{32}", api_hash):
        raise BridgeError("invalid_config")

    class SessionView(SQLiteSession):
        # Use the original read-only connection. SQLiteSession.__init__ would
        # create/upgrade schema, and the normal setters write on connect.
        def __init__(self, row):
            self._conn = db
            self._dc_id, self._server_address, self._port = row[:3]
            self._auth_key = AuthKey(row[3])
            self._takeout_id = self._tmp_auth_key = None
            self.save_entities = False

        @SQLiteSession.auth_key.setter
        def auth_key(self, value):
            if value is not self._auth_key:
                raise BridgeError("session_changed")

        def set_dc(self, dc_id, server_address, port):
            raise BridgeError("session_changed")

        def clone(self, to_instance=None):
            raise BridgeError("session_changed")

        def delete(self):
            raise BridgeError("session_changed")

        def set_update_state(self, entity_id, state):
            pass  # A one-shot reader never checkpoints Telegram updates.

        def close(self):
            pass  # session_reader owns the connection and file lease.

    class ChannelReader(TelegramClient):
        async def _on_login(self, user):
            # The 1.x connect hook normally fetches account-wide differences.
            # This short-lived reader never subscribes or catches up on updates.
            return user

    row = db.execute("SELECT dc_id, server_address, port, auth_key FROM sessions").fetchone()
    if not row or not row[3]:
        raise BridgeError("unauthorized")
    if not row[0] or not row[1] or not row[2] or len(row[3]) != 256:
        raise BridgeError("invalid_session")
    return ChannelReader(SessionView(row), int(api_id), api_hash, use_ipv6=":" in row[1],
                         receive_updates=False, catch_up=False, auto_reconnect=False,
                         request_retries=0, connection_retries=0, flood_sleep_threshold=0,
                         raise_last_call_error=True)


async def resolve_channel(client, target):
    from telethon import types, utils

    try:
        entity = await client.get_entity(int(target) if channel_id(target) else target)
    except ValueError:
        raise BridgeError("peer_not_found") from None
    if isinstance(entity, types.ChannelForbidden):
        raise BridgeError("access_denied")
    if not isinstance(entity, types.Channel):
        raise BridgeError("not_a_channel")
    marked = str(utils.get_peer_id(entity))
    if channel_id(target) and target != marked:
        raise BridgeError("peer_mismatch")
    return entity, marked


async def history_page(client, entity, peer_id, req):
    from telethon import functions, types, utils

    peer = utils.get_input_peer(entity)
    prefix = f"https://t.me/{entity.username}" if entity.username else f"https://t.me/c/{entity.id}"
    messages, unavailable = [], []
    cursor = req["cursor"]
    end = False
    # Use the raw peer-scoped operations: iter_messages discards MessageEmpty,
    # losing the offset if a whole Telegram response consists of placeholders.
    while cursor < MAX_MESSAGE_ID:
        remaining = req["limit"] - len(messages) - len(unavailable)
        batch = min(100, remaining + 1)  # Telegram accepts 100 rows per RPC.
        args = dict(peer=peer, offset_id=cursor + 1, add_offset=-batch, limit=batch,
                    min_id=0, max_id=0, hash=0)
        if req["op"] == "search":
            call = functions.messages.SearchRequest(**args, q=req["query"],
                       filter=types.InputMessagesFilterEmpty(), min_date=None, max_date=None)
        else:
            call = functions.messages.GetHistoryRequest(**args, offset_date=None)
        response = await client(call)
        rows = {msg.id: msg for msg in response.messages if msg.id > cursor}
        if not rows:
            end = True
            break
        for mid in sorted(rows)[:remaining]:
            msg = rows[mid]
            if msg.peer_id is not None and utils.get_peer_id(msg.peer_id) != int(peer_id):
                raise BridgeError("peer_mismatch")
            if isinstance(msg, types.MessageEmpty):
                unavailable.append(mid)
            else:
                edit = getattr(msg, "edit_date", None)
                messages.append({"id": mid, "date": msg.date.astimezone(timezone.utc).isoformat(),
                                 "editDate": edit.astimezone(timezone.utc).isoformat() if edit else None,
                                 "text": getattr(msg, "message", "") or "", "link": f"{prefix}/{mid}"})
            cursor = mid
        if len(rows) > remaining:
            break
    return {"peerId": peer_id, "messages": messages, "unavailableIds": unavailable,
            "endReached": end or cursor == MAX_MESSAGE_ID, "continuation": cursor}


async def dispatch(req, env):
    validate(req, env)
    env_file = configured_file(env, "T3_TELEGRAM_ENV_FILE")
    session_file = configured_file(env, "T3_TELEGRAM_SESSION_FILE")
    with session_reader(session_file) as db:
        client = existing_client(db, env_file)
        try:
            await client.connect()
            me = await client.get_me()
            authorized = me is not None and not me.bot
            if req["op"] == "status":
                return {"authorized": authorized}
            if not authorized:
                raise BridgeError("unauthorized")
            if req["op"] == "lookup":
                rows = db.execute("SELECT id, name FROM entities WHERE id < ? AND name = ? ORDER BY id",
                                  (-10**12, req["title"].strip()))
                return {"peers": [{"peerId": str(peer_id), "title": name} for peer_id, name in rows]}
            if req["op"] == "list":
                peers = {}
                for target in dict.fromkeys(req["targets"]):
                    entity, marked = await resolve_channel(client, target)
                    peers[marked] = {"peerId": marked, "title": entity.title}
                return {"peers": list(peers.values())}
            try:
                entity, marked = await resolve_channel(client, req["peerId"])
            except BridgeError as exc:
                hint = env.get("T3_TELEGRAM_TARGET")
                if exc.packet["code"] != "peer_not_found" or not username(hint):
                    raise
                entity, marked = await resolve_channel(client, hint)
            if marked != req["peerId"]:
                raise BridgeError("peer_mismatch")
            return await history_page(client, entity, marked, req)
        finally:
            await client.disconnect()


def classify(exc):
    if isinstance(exc, BridgeError):
        return exc
    if isinstance(exc, sqlite3.Error):
        if getattr(exc, "sqlite_errorcode", 0) & 255 in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
            return BridgeError("session_busy", True)
        return BridgeError("invalid_session")
    if isinstance(exc, ImportError):
        return BridgeError("dependency_missing")
    if isinstance(exc, (ConnectionError, TimeoutError)):
        return BridgeError("network_unavailable", True)
    if isinstance(exc, OSError):
        return BridgeError("io_error")
    from telethon import errors

    if isinstance(exc, errors.FloodError):
        seconds = getattr(exc, "seconds", None)
        details = {"retryAfterSeconds": seconds} if isinstance(seconds, int) else {}
        return BridgeError("flood_wait", True, **details)
    if isinstance(exc, (errors.UnauthorizedError, errors.AuthKeyDuplicatedError)):
        return BridgeError("unauthorized")
    if isinstance(exc, (errors.ForbiddenError, errors.ChannelPrivateError, errors.ChannelBannedError)):
        return BridgeError("access_denied")
    if isinstance(exc, (errors.ChannelInvalidError, errors.PeerIdInvalidError,
                        errors.UsernameInvalidError, errors.UsernameNotOccupiedError)):
        return BridgeError("peer_not_found")
    if isinstance(exc, (errors.MessageIdInvalidError, errors.MsgIdInvalidError)):
        return BridgeError("message_unavailable")
    if isinstance(exc, errors.ServerError):
        return BridgeError("telegram_unavailable", True)
    return BridgeError("bridge_error")


async def packet(raw, env):
    try:
        try:
            req = json.loads(raw.decode("utf-8"))
        except (ValueError, RecursionError):
            raise BridgeError("invalid_request") from None
        return {"ok": True, "result": await dispatch(req, env)}
    except Exception as exc:
        error = classify(exc)
        if error.packet["code"] == "unauthorized" and req["op"] == "status":
            return {"ok": True, "result": {"authorized": False}}
        return {"ok": False, "error": error.packet}


if __name__ == "__main__":
    # Third-party logging, warnings and tracebacks can contain account details.
    with open(os.devnull, "w") as silence:
        os.dup2(silence.fileno(), 2)
        logging.disable(logging.CRITICAL)
        try:
            if len(sys.argv) != 1:
                reply = {"ok": False, "error": {"code": "invalid_request", "retryable": False}}
            else:
                reply = asyncio.run(packet(sys.stdin.buffer.read(), os.environ))
        except Exception:
            reply = {"ok": False, "error": {"code": "bridge_error", "retryable": False}}
        print(json.dumps(reply, ensure_ascii=True, separators=(",", ":")))
