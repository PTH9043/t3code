"""Windows process identity, TCP ownership and a lease inherited by the server."""

import contextlib
import ctypes
from ctypes import wintypes as w
import msvcrt
import os
from pathlib import Path
import socket
import struct


kernel = ctypes.WinDLL("kernel32", use_last_error=True)


def api(name, result, *arguments):
    function = getattr(kernel, name)
    function.restype, function.argtypes = result, arguments
    return function


close = api("CloseHandle", w.BOOL, w.HANDLE)
open_process = api("OpenProcess", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
query_image = api("QueryFullProcessImageNameW", w.BOOL, w.HANDLE, w.DWORD, w.LPWSTR,
                  ctypes.POINTER(w.DWORD))
times = api("GetProcessTimes", w.BOOL, w.HANDLE, *([ctypes.POINTER(w.FILETIME)] * 4))
in_job = api("IsProcessInJob", w.BOOL, w.HANDLE, w.HANDLE, ctypes.POINTER(w.BOOL))
current = api("GetCurrentProcess", w.HANDLE)
open_file = api("CreateFileW", w.HANDLE, w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID,
                w.DWORD, w.DWORD, w.HANDLE)
tcp_table = ctypes.WinDLL("iphlpapi").GetExtendedTcpTable
tcp_table.argtypes = [w.LPVOID, ctypes.POINTER(w.DWORD), w.BOOL, w.ULONG, w.INT, w.ULONG]
tcp_table.restype = w.DWORD


def open_shared(path):
    # The server and launcher atomically replace their records. Python's
    # default Windows file open omits FILE_SHARE_DELETE and can block rename.
    handle = open_file(str(path), 0x80000000, 7, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    except Exception:
        close(handle)
        raise
    return os.fdopen(fd, "rb")


def process_identity(pid):
    if type(pid) is not int or not 0 < pid <= 0xffffffff:
        raise ValueError("invalid PID")
    handle = open_process(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        if ctypes.get_last_error() == 87:  # ERROR_INVALID_PARAMETER for a stale PID
            return None
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        length = w.DWORD(32768)
        image = ctypes.create_unicode_buffer(length.value)
        stamps = [w.FILETIME() for _ in range(4)]
        if not times(handle, *(ctypes.byref(stamp) for stamp in stamps)):
            raise ctypes.WinError(ctypes.get_last_error())
        if stamps[1].dwHighDateTime or stamps[1].dwLowDateTime:
            return None
        if not query_image(handle, 0, image, ctypes.byref(length)):
            error = ctypes.get_last_error()
            if times(handle, *(ctypes.byref(stamp) for stamp in stamps)) and (
                    stamps[1].dwHighDateTime or stamps[1].dwLowDateTime):
                return None
            raise ctypes.WinError(error)
        return Path(image.value), (stamps[0].dwHighDateTime << 32) | stamps[0].dwLowDateTime
    finally:
        close(handle)


def listener_matches(port, pid):
    # MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER, AF_INET.
    size = w.DWORD()
    while True:
        table = ctypes.create_string_buffer(size.value)
        rc = tcp_table(table, ctypes.byref(size), False, socket.AF_INET, 3, 0)
        if rc == 0:
            break
        if rc != 122:
            raise ctypes.WinError(rc)
    count, = struct.unpack_from("<I", table)
    rows = struct.iter_unpack("<I4sI4sII", table.raw[4:4 + count * 24])
    owners = [(address, owner) for _, address, local, _, _, owner in rows
              if socket.ntohs(local & 0xffff) == port and
              address in (socket.inet_aton("127.0.0.1"), bytes(4))]
    return owners == [(socket.inet_aton("127.0.0.1"), pid)]


def detach_flags():
    member = w.BOOL()
    if not in_job(current(), None, ctypes.byref(member)):
        raise ctypes.WinError(ctypes.get_last_error())
    # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP. Escape a parent job's
    # kill-on-close policy; fail explicitly when Windows forbids breakaway.
    return 0x8 | 0x200 | (0x01000000 if member.value else 0)


@contextlib.contextmanager
def exclusive_file(path):
    # The inherited handle is a lifetime lease, including the gap before T3
    # publishes its PID. Kernel release on exit makes crash recovery automatic.
    handle = open_file(str(path), 0x80000000, 0, None, 4, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        error = ctypes.get_last_error()
        if error != 32:
            raise ctypes.WinError(error)
        yield None
        return
    try:
        yield handle
    finally:
        close(handle)
