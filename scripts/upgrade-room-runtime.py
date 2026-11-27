"""Install and run the independent packaged AutoUsage upgrade room on Windows."""

import contextlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlencode

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "upgrade-room"))
import windows_host as win

PRIMARY = Path("E:/NewAutoUsage")
PROJECT = Path("D:/__NewAutoUsage")
PROJECT_ID = "autousage-upgrade-project"
THREAD_ID = "autousage-upgrade-room"
LOOPBACK = "127.0.0.1"
HOST_SCRIPT = "upgrade-room-runtime.py"
VBS = "upgrade-room-launch.vbs"
REQUIRED = ("bin.mjs", "service-launcher.mjs", "watchdog-worker.mjs", "codex-watch-stdio.mjs",
            "client/index.html")


class HostError(Exception):
    """Public diagnostic. Never use child output or credentials in this message."""


def read_json(path):
    with win.open_shared(path) as source:
        return json.load(source)


def write_json(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
        temporary = Path(out.name)
        out.write(json.dumps(data, ensure_ascii=True).encode("ascii"))
    try:
        # Even a concurrent Windows GetFinalPathNameByHandleW/stat can
        # temporarily prevent ReplaceFile/rename. Keep publication atomic.
        deadline = time.monotonic() + 3
        while True:
            try:
                temporary.replace(path)
                break
            except PermissionError as error:
                if error.winerror not in (5, 32) or time.monotonic() >= deadline:
                    raise
                time.sleep(0.025)
    finally:
        temporary.unlink(missing_ok=True)


def exact(path):
    if path.resolve() != path.absolute():
        raise HostError("Unexpected redirected host path")
    return path


def plain_tree(path):
    # Check before copying a bundle and before activating the independent install.
    # Hoisted/copy packaging must not retain a junction to the source or pnpm store.
    exact(path)
    for root, directories, files in os.walk(path):
        for name in directories + files:
            info = (Path(root) / name).lstat()
            if info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise HostError("Release contains a filesystem link")


def child_env():
    # Do not pass main-server origin, home, IPC, telemetry, launch hooks or
    # API credentials across the boundary. Provider credentials stay in T3.
    keys = ("SystemRoot", "SystemDrive", "ComSpec", "USERPROFILE", "USERNAME", "USERDOMAIN",
            "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ProgramFiles", "ProgramFiles(x86)",
            "ProgramData", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS")
    return {key: os.environ[key] for key in keys if key in os.environ}


def run_private(argv, cwd, env, *, timeout, error, capture=False):
    try:
        result = subprocess.run(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW,
                                timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise HostError(error) from None
    if result.returncode != 0:
        raise HostError(error)
    return result.stdout


def package_release(stage, scripts):
    source = exact(scripts.parent / "apps/server/dist")
    if not all((source / name).is_file() for name in REQUIRED):
        raise HostError("Build the official T3 web and server CLI bundles before installing")
    plain_tree(source)
    release = stage / "release"
    release.mkdir()
    shutil.copytree(source, release / "dist")
    for name in ("open-room.html", "open-room.js"):
        target = release / "dist/client" / name
        if target.exists():
            raise HostError("Room entry page collides with a packaged asset")
        shutil.copyfile(scripts / "upgrade-room" / name, target)
    node = Path(os.environ["ProgramFiles"]) / "nodejs/node.exe"
    shutil.copyfile(node, release / "node.exe")
    env = child_env()
    run_private([release / "node.exe", scripts / "upgrade-room/stage.mjs"], release, env,
                timeout=900, error="Frozen T3 production dependency installation failed")
    plain_tree(release)
    run_private([release / "node.exe", release / "dist/bin.mjs", "--version"], release, env,
                timeout=60, error="The private packaged T3 CLI failed its startup check")


def stage_launcher(stage, scripts, python):
    pythonw = python.with_name("pythonw.exe")
    if not python.is_absolute() or python.name.lower() != "python.exe" or not pythonw.is_file():
        raise HostError("Install using the Windows console Python interpreter")
    shutil.copyfile(scripts / HOST_SCRIPT, stage / HOST_SCRIPT)
    (stage / "upgrade-room").mkdir()
    shutil.copyfile(scripts / "upgrade-room/windows_host.py", stage / "upgrade-room/windows_host.py")
    template = (scripts / VBS).read_text(encoding="utf-8")
    if template.count("__INSTALLED_PYTHONW__") != 1:
        raise HostError("Run install from the integrated checkout")
    (stage / VBS).write_text(template.replace("__INSTALLED_PYTHONW__", str(pythonw)), encoding="utf-16")
    write_json(stage / "install.json", {"version": 2, "python": str(python)})


def install(host):
    if not host.manifest.exists():
        scripts = HERE
        parent = exact(host.tools.parent)
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent, prefix=".upgrade-room-") as staging:
            stage = Path(staging) / "install"
            stage.mkdir()
            if host.tools.exists():
                raise HostError("Existing install directory has no install manifest")
            stage_launcher(stage, scripts, Path(sys.executable).resolve())
            package_release(stage, scripts)
            try:
                stage.rename(host.tools)
            except FileExistsError:  # Concurrent installer activated its complete stage first.
                if not host.manifest.is_file():
                    raise
    record = read_json(exact(host.manifest))
    if record.get("version") == 1:
        # The first launcher spawned Node in the requesting desktop's tree.
        # Publish backwards-compatible dependencies before the new entry point.
        # A retry can finish any partial update while keeping the same release.
        with tempfile.TemporaryDirectory(dir=exact(host.tools.parent), prefix=".upgrade-room-") as temp:
            stage = Path(temp)
            stage_launcher(stage, HERE, Path(record["python"]))
            for name in ("upgrade-room/windows_host.py", VBS, HOST_SCRIPT, "install.json"):
                (stage / name).replace(exact(host.tools / name))
    host.check_release()
    cscript = Path(os.environ["SystemRoot"]) / "System32/cscript.exe"
    run_private([cscript, "//B", "//Nologo", host.tools / VBS, "install-shortcut"],
                host.tools, child_env(), timeout=15, error="Desktop shortcut installation failed")
    return {"ok": True, "status": "installed", "launcher": str(host.tools / HOST_SCRIPT)}


def replace_release(host):
    host.check_release()
    host.check_home()
    if not host.lease.is_file() or host.status()["status"] != "stopped":
        raise HostError("The initialized independent server must be stopped before replacing its release")
    backup = exact(host.tools / "release.previous")
    if backup.exists():
        raise HostError("An existing rollback release must be retained or moved before replacing again")

    with tempfile.TemporaryDirectory(dir=exact(host.tools), prefix=".release-stage-") as temporary:
        stage = Path(temporary)
        package_release(stage, HERE)
        # The installed broker uses the same lease across process startup. Do
        # not rename its executable or web assets if it started during staging.
        with win.exclusive_file(host.lease) as lease:
            if lease is None:
                raise HostError("The independent server started during release staging")
            host.check_release()
            current = exact(host.release)
            current.rename(backup)
            try:
                (stage / "release").rename(current)
            except OSError:
                backup.rename(current)
                raise
    return {"ok": True, "status": "replaced", "rollbackRelease": str(backup)}


def http_json(port, path):
    with contextlib.closing(http.client.HTTPConnection(LOOPBACK, port, timeout=2)) as conn:
        conn.request("GET", path)
        response = conn.getresponse()
        if response.status != 200:
            raise HostError("Room health endpoint is unavailable")
        return json.loads(response.read(65537))


def available_port(preferred):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        if preferred is not None:
            try:
                sock.bind((LOOPBACK, preferred))
            except OSError:
                pass
            else:
                return preferred
        sock.bind((LOOPBACK, 0))
        return sock.getsockname()[1]


class Host:
    def __init__(self, primary=PRIMARY, project=PROJECT):
        self.primary = primary
        self.project = project
        self.tools = primary / "tools/upgrade-room"
        self.manifest = self.tools / "install.json"
        self.release = self.tools / "release"
        self.node = self.release / "node.exe"
        self.cli = self.release / "dist/bin.mjs"
        self.home = primary / "upgrade-room"
        self.data = self.home / "userdata"
        self.record = self.home / "launcher-state.json"
        self.runtime = self.data / "server-runtime.json"
        self.lease = self.home / "server.lease"

    def check_release(self):
        if read_json(exact(self.manifest)).get("version") != 2 or not all(
            exact(path).is_file() for path in (self.node, self.cli, self.tools / VBS,
                                               self.release / "dist/client/open-room.html",
                                               self.release / "dist/client/open-room.js")
        ):
            raise HostError("Independent T3 release is incomplete")

    def check_home(self):
        # Reject redirected state and hard-linked sqlite before any writable open.
        for path in (self.home, self.data, self.record, self.runtime, self.lease,
                     self.data / "environment-id", self.data / "secrets",
                     *(self.data / ("state.sqlite" + tail) for tail in ("", "-wal", "-shm", "-journal"))):
            exact(path)
            if path.is_file() and path.stat().st_nlink != 1:
                raise HostError("Independent state contains a hard link")

    def env(self):
        env = child_env()
        env["PATH"] = str(self.release) + os.pathsep + env.get("PATH", "")
        return {**env, "T3CODE_HOME": str(self.home),
                "T3CODE_UPGRADE_PROJECT_ROOT": self.project.as_posix(),
                "T3CODE_UPGRADE_PRIMARY_HOME": self.primary.as_posix(),
                "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD": "false",
                "T3CODE_NO_BROWSER": "true", "T3CODE_LOG_LEVEL": "Error",
                "T3CODE_TRACE_MIN_LEVEL": "Error", "NO_COLOR": "1"}

    def has_room(self):
        database = self.data / "state.sqlite"
        if not database.is_file():
            return False
        # Use mode=ro while still observing committed WAL transactions.
        with contextlib.closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
            projects = db.execute("SELECT project_id, workspace_root, deleted_at FROM projection_projects LIMIT 2").fetchall()
            threads = db.execute("SELECT thread_id, project_id, deleted_at, archived_at FROM projection_threads LIMIT 2").fetchall()
        if not projects:
            return False
        if (len(projects) != 1 or projects[0][0] != PROJECT_ID or projects[0][2] is not None
            or Path(projects[0][1]) != self.project or
            threads not in ([], [(THREAD_ID, PROJECT_ID, None, None)])):
            raise HostError("Independent read model does not match the reserved upgrade room")
        # The user's initial model choice creates the thread. Requiring its row
        # on first launch would prevent reaching the model picker.
        return True

    def status(self):
        base = {"ok": True, "projectId": PROJECT_ID, "threadId": THREAD_ID}
        if not exact(self.manifest).is_file():
            return {**base, "status": "uninstalled"}
        self.check_release()
        self.check_home()
        # Open an existing lease without creating anything during read-only status.
        if not self.lease.exists():
            return {**base, "status": "stopped"}
        with win.exclusive_file(self.lease) as free:
            if free is not None:
                return {**base, "status": "stopped"}
        starting = {**base, "status": "starting"}
        if not self.runtime.is_file() or not self.record.is_file():
            return starting
        state, record = read_json(self.runtime), read_json(self.record)
        pid, port = state.get("pid"), state.get("port")
        if type(port) is not int or not 0 < port < 65536:
            raise HostError("Invalid server endpoint")
        origin = f"http://{LOOPBACK}:{port}"
        if (state.get("version") != 1 or state.get("host") != LOOPBACK or
            state.get("origin") != origin or "devUrl" in state):
            raise HostError("Unexpected server endpoint")
        if port != record.get("port") or not win.listener_matches(port, pid):
            return starting
        identity = win.process_identity(pid)
        if not identity or identity[0] != self.node:
            raise HostError("Loopback listener does not belong to the installed server")
        if "pid" in record and (pid != record["pid"] or identity[1] != record.get("birth")):
            return starting
        environment = (self.data / "environment-id").read_text(encoding="utf-8").strip()
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", environment):
            raise HostError("Invalid persisted environment identity")
        try:
            descriptor = http_json(port, "/.well-known/t3/environment")
            session = http_json(port, "/api/auth/session")
            if not self.has_room():
                return starting
        except (OSError, http.client.HTTPException, sqlite3.OperationalError):
            return starting
        if descriptor.get("environmentId") != environment:
            raise HostError("Server environment identity does not match independent userdata")
        if (session.get("authenticated") is not False or
            session.get("auth", {}).get("policy") != "loopback-browser" or
            "one-time-token" not in session["auth"].get("bootstrapMethods", [])):
            raise HostError("Server is not using loopback one-time pairing")
        if not win.listener_matches(port, pid) or win.process_identity(pid) != identity:
            return starting
        return {**base, "status": "ready", "pid": pid, "environmentId": environment, "origin": origin}

    def start(self, handle):
        old = read_json(self.record) if self.record.is_file() else {}
        port = available_port(old.get("port"))
        write_json(self.record, {"port": port})
        startup = subprocess.STARTUPINFO()
        startup.lpAttributeList = {"handle_list": [handle]}
        os.set_handle_inheritable(handle, True)
        try:
            server = subprocess.Popen(
                [self.node, self.cli, "serve", "--mode", "web", "--base-dir", self.home,
                 "--host", LOOPBACK, "--port", str(port), "--no-browser"],
                cwd=self.release, env=self.env(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, creationflags=win.detach_flags(), startupinfo=startup,
                close_fds=True,
            )
        finally:
            os.set_handle_inheritable(handle, False)
        identity = win.process_identity(server.pid)
        if identity is None or identity[0] != self.node:
            raise HostError("Cannot verify the new independent process")
        write_json(self.record, {"port": port, "pid": server.pid, "birth": identity[1]})
        return server

    def start_from_broker(self):
        if not exact(self.manifest).is_file():
            raise HostError("Install the independent upgrade room first")
        self.check_release()
        self.check_home()
        self.home.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + 75
        server = None
        # The kernel shares the lease with only the spawned server, so even an
        # interrupted bootstrap cannot create a second writer on a retry.
        while time.monotonic() < deadline:
            if server is not None and server.poll() is not None:
                raise HostError("The packaged server exited during startup")
            state = self.status()
            if state["status"] == "ready":
                return state
            if state["status"] == "stopped":
                with win.exclusive_file(self.lease) as handle:
                    if handle is not None:
                        if server is not None:
                            raise HostError("The independent server released its startup lease")
                        server = self.start(handle)
            time.sleep(0.2)
        raise HostError("Timed out waiting for the verified server and dedicated room")

    def ensure(self):
        state = self.status()
        if state["status"] == "uninstalled":
            raise HostError("Install the independent upgrade room first")
        if state["status"] == "ready":
            return state

        cscript = Path(os.environ["SystemRoot"]) / "System32/cscript.exe"
        reply = run_private([cscript, "//B", "//Nologo", self.tools / VBS, "start-host"],
                            self.tools, child_env(), timeout=20, capture=True,
                            error="Windows could not start the independent room broker")
        if not re.fullmatch(rb"[1-9][0-9]{0,9}", reply.strip()):
            raise HostError("Windows returned an invalid room broker PID")
        pid = int(reply)
        identity = win.process_identity(pid)
        expected = Path(read_json(self.manifest)["python"]).with_name("pythonw.exe")
        if identity and identity[0] != expected:
            raise HostError("Windows room broker identity mismatch")
        deadline = time.monotonic() + 75
        while time.monotonic() < deadline:
            if identity is None or win.process_identity(pid) != identity:
                state = self.status()
                if state["status"] == "ready":
                    return state
                raise HostError("Independent room broker exited before the room became ready")
            time.sleep(0.2)
        raise HostError("Timed out waiting for the independent room broker")

    def link(self):
        state = self.ensure()
        output = run_private([self.node, self.cli, "auth", "pairing", "create",
                              "--base-dir", self.home, "--json"], self.release, self.env(),
                             timeout=45, error="T3 could not issue the one-time pairing link", capture=True)
        credential = json.loads(output).get("credential")
        if not isinstance(credential, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", credential):
            raise HostError("Unexpected T3 pairing response")
        if self.status() != state:
            raise HostError("Server identity changed during pairing")
        fragment = urlencode({"token": credential})
        return {**state, "url": state["origin"] + "/open-room.html#" + fragment}


def dispatch(verb, host):
    if verb == "_start-host":
        if HERE != exact(host.tools) or Path(sys.executable).name.lower() != "pythonw.exe":
            raise HostError("Expected the installed Windows room broker")
        return host.start_from_broker()
    if verb == "install":
        return install(host)
    if verb == "replace-release":
        return replace_release(host)
    if verb == "status":
        return host.status()
    if verb == "ensure":
        return host.ensure()
    if verb == "link":
        return host.link()
    if verb == "open":
        result = host.link()
        os.startfile(result.pop("url"))
        return result
    raise HostError("Expected install, replace-release, ensure, open, link, or status")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise HostError("Expected exactly one upgrade room command")
        result = dispatch(sys.argv[1], Host())
    except HostError as error:
        result = {"ok": False, "error": str(error)}
    except Exception as error:
        # A JSON parse/subprocess error can contain a credential. Emit only
        # the exception class and Windows error code to the calling backend.
        result = {"ok": False, "error": type(error).__name__, "winerror": getattr(error, "winerror", None)}
    if sys.stdout is not None:  # pythonw.exe has no standard streams.
        print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    sys.exit(0 if result["ok"] else 1)
