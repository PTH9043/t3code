"""Windows host integration with a disposable packaged-server double, no user UI."""

from concurrent.futures import ThreadPoolExecutor
import contextlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import warnings
from unittest import mock
from urllib.parse import parse_qs, urlsplit
import psutil

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("upgrade_host", HERE.parent / "upgrade-room-runtime.py")
host_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host_module)
sys.path.insert(0, str(HERE.parent))
from windows_watchdog_restart import restart_descendants

FAKE_SERVER = """
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const home = args[args.indexOf("--base-dir") + 1];
if (home !== process.env.T3CODE_HOME || !home.includes("upgrade-fake-")) process.exit(3);
const data = path.join(home, "userdata");
fs.mkdirSync(data, {recursive:true});
const store = new DatabaseSync(path.join(data, "state.sqlite"));
if (args[0] === "auth") {
  const token = randomUUID();
  store.prepare("INSERT INTO tokens VALUES (?)").run(token);
  process.stdout.write(JSON.stringify({credential:token}));
} else {
  const port = Number(args[args.indexOf("--port")+1]);
  const origin = "http://127.0.0.1:" + port;
  store.exec("CREATE TABLE IF NOT EXISTS tokens(token TEXT); CREATE TABLE IF NOT EXISTS projection_projects(project_id TEXT PRIMARY KEY, workspace_root TEXT, deleted_at TEXT); CREATE TABLE IF NOT EXISTS projection_threads(thread_id TEXT, project_id TEXT, deleted_at TEXT, archived_at TEXT)");
  store.prepare("INSERT OR IGNORE INTO projection_projects VALUES (?,?,NULL)").run("autousage-upgrade-project",process.env.T3CODE_UPGRADE_PROJECT_ROOT);
  const environmentId = "test-environment";
  fs.writeFileSync(path.join(data,"environment-id"),environmentId);
  const auth = {authenticated:false,auth:{policy:"loopback-browser",bootstrapMethods:["one-time-token"]}};
  const server = createServer(async(req,res) => {
    if(req.url === "/api/auth/browser-session") {
      let body = ""; for await (const part of req) body += part;
      res.statusCode = store.prepare("DELETE FROM tokens WHERE token=?").run(JSON.parse(body).credential).changes ? 200 : 401;
      res.end(); return;
    }
    res.end(JSON.stringify(req.url === "/.well-known/t3/environment" ? {environmentId} : auth));
  });
  server.listen(port,"127.0.0.1",() => fs.writeFileSync(path.join(data,"server-runtime.json"),
    JSON.stringify({version:1,pid:process.pid,port,host:"127.0.0.1",origin})));
  setInterval(() => {
    if(fs.existsSync(path.join(home,"finish-fixture"))) process.exit(0);
  },50);
}
"""

# Run the shipped bootstrap script against the listening fixture without a browser.
BOOTSTRAP_CHECK = """
const vm = require("node:vm"), fs = require("node:fs");
const url = new URL(fs.readFileSync(0,"utf8"));
let stripped = false, destination = "", message = {textContent:""};
const location = {hostname:url.hostname,pathname:url.pathname,hash:url.hash,
  replace(path) { destination = path; }};
const history = {replaceState(_state,_title,path) { stripped = path === url.pathname; }};
const sandbox = {location,history,URLSearchParams,document:{querySelector:()=>message},
  fetch(path,options) {
    if (!stripped || !path.startsWith("/") || path.includes("?") || path.includes("#")) throw Error();
    return fetch(new URL(path,url.origin),options);
  }};
vm.runInNewContext(fs.readFileSync(process.argv[1],"utf8"),sandbox).then(()=>{
  if (destination !== "/test-environment/autousage-upgrade-room" || message.textContent) process.exitCode = 1;
});
"""

# Inject this barrier into the disposable installed script only. Both windows
# precede publication of the durable Node PID/creation-time record.
BROKER_BARRIER = '''
if sys.argv[-1] == "_start-host":
    fixture = PRIMARY.parent
    phase = (fixture / "phase").read_text()
    publish = write_json
    def pause_for_restart(node=None):
        whoami = Path(os.environ["SystemRoot"]) / "System32/whoami.exe"
        groups = subprocess.check_output([whoami, "/groups", "/fo", "csv", "/nh"],
                                         creationflags=subprocess.CREATE_NO_WINDOW)
        integrity = int(re.search(rb"S-1-16-([0-9]+)", groups)[1])
        publish(fixture / "paused.json", {"broker": os.getpid(), "server": node,
                                         "integrity": integrity, "appData": os.environ["APPDATA"]})
        deadline = time.monotonic() + 25
        while not (fixture / "resume").exists():
            if time.monotonic() >= deadline:
                raise HostError("Fixture restart did not release broker")
            time.sleep(.03)
    if phase == "before-lease":
        pause_for_restart()
    else:
        def write_json(path, value):
            if path.name == "launcher-state.json" and "birth" in value:
                pause_for_restart(value)
            return publish(path, value)
'''


def wait_json(path, process):
    deadline = time.monotonic() + 15
    while not path.exists():
        if process.poll() is not None or time.monotonic() >= deadline:
            raise AssertionError("Fixture exited or timed out before the broker barrier")
        time.sleep(.03)
    return host_module.read_json(path)


class WindowsRoomTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="upgrade-fake-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.assertEqual(self.root.drive.lower(), "c:")
        self.host = host_module.Host(self.root / "AutoUsage", self.root / "project")
        self.host.project.mkdir()
        self.desktop = self.root / "desktop"
        self.desktop.mkdir()

    def install(self):
        def package(stage, scripts):
            release = stage / "release"
            (release / "dist/client").mkdir(parents=True)
            shutil.copyfile(Path(os.environ["ProgramFiles"]) / "nodejs/node.exe", release / "node.exe")
            (release / "dist/bin.mjs").write_text(FAKE_SERVER, encoding="utf-8")
            for name in ("open-room.html", "open-room.js"):
                shutil.copyfile(HERE / name, release / "dist/client" / name)

        # Execute the real WSH shortcut code with only the fixture desktop substituted.
        original_run = host_module.run_private
        def private(args, *rest, **kwargs):
            if Path(args[0]).name == "cscript.exe":
                target = self.host.tools / "fixture-shortcut.vbs"
                source = (self.host.tools / host_module.VBS).read_text(encoding="utf-16")
                target.write_text(source.replace('sh.SpecialFolders("Desktop")', '"' + str(self.desktop) + '"')
                                  .replace("Q(WScript.ScriptFullName)", 'Q("' + str(self.host.tools / host_module.VBS) + '")'),
                                  encoding="utf-16")
                args = [*args[:3], target, *args[4:]]
            return original_run(args, *rest, **kwargs)
        with mock.patch.object(host_module, "package_release", side_effect=package), \
             mock.patch.object(host_module, "run_private", side_effect=private):
            result = host_module.install(self.host)
        # The isolated WMI worker loads the installed entry point in its own process.
        # Keep its canonical paths inside the fixture as well as the caller's.
        installed = self.host.tools / host_module.HOST_SCRIPT
        source = installed.read_text(encoding="utf-8")
        source = source.replace('PRIMARY = Path("E:/NewAutoUsage")', "PRIMARY = Path(" + repr(str(self.host.primary)) + ")")
        source = source.replace('PROJECT = Path("D:/__NewAutoUsage")', "PROJECT = Path(" + repr(str(self.host.project)) + ")")
        source = source.replace('    if sys.stdout is not None:', '''    if sys.argv[-1] == "_start-host" and not result["ok"]:
        (PRIMARY.parent / "fixture-start-error.json").write_text(json.dumps(result))
    if sys.stdout is not None:''')
        installed.write_text(source, encoding="utf-8")
        return result

    def stop(self):
        if not self.host.home.is_dir():
            return
        marker = self.host.home / "finish-fixture"
        marker.touch()
        deadline = time.monotonic() + 10
        while self.host.lease.exists() and time.monotonic() < deadline:
            with host_module.win.exclusive_file(self.host.lease) as lease:
                if lease is not None:
                    break
            time.sleep(.05)
        marker.unlink()
        self.assertEqual(self.host.status()["status"], "stopped")

    def test_replace_release_preserves_room_data_and_old_release(self):
        h = self.host
        self.install()
        h.home.mkdir()
        h.lease.touch()
        h.data.mkdir()
        marker = h.data / "state.sqlite"
        marker.write_bytes(b"untouched room data")
        old_cli = h.cli.read_bytes()
        backup = h.tools / "release.previous"

        def package(stage, scripts):
            shutil.copytree(h.release, stage / "release")
            (stage / "release/dist/bin.mjs").write_bytes(b"updated package")

        with mock.patch.object(host_module, "package_release", side_effect=package) as stage:
            with host_module.win.exclusive_file(h.lease) as lease:
                self.assertIsNotNone(lease)
                with self.assertRaisesRegex(host_module.HostError, "stopped"):
                    host_module.dispatch("replace-release", h)
            stage.assert_not_called()
            result = host_module.dispatch("replace-release", h)
            with self.assertRaisesRegex(host_module.HostError, "rollback"):
                host_module.dispatch("replace-release", h)
            stage.assert_called_once()

        self.assertEqual(result["status"], "replaced")
        self.assertEqual(h.cli.read_bytes(), b"updated package")
        self.assertEqual((backup / "dist/bin.mjs").read_bytes(), old_cli)
        self.assertEqual(marker.read_bytes(), b"untouched room data")
        self.assertEqual(h.status()["status"], "stopped")

    def test_replace_release_restores_original_if_publication_fails(self):
        h = self.host
        self.install()
        h.home.mkdir()
        h.lease.touch()
        old_cli = h.cli.read_bytes()
        rename = Path.rename

        def package(stage, scripts):
            shutil.copytree(h.release, stage / "release")

        def fail_publication(source, destination):
            if source.parent.name.startswith(".release-stage-"):
                raise OSError("fixture publication failed")
            return rename(source, destination)

        with mock.patch.object(host_module, "package_release", side_effect=package), \
             mock.patch.object(Path, "rename", fail_publication):
            with self.assertRaisesRegex(OSError, "fixture publication failed"):
                host_module.dispatch("replace-release", h)

        self.assertEqual(h.cli.read_bytes(), old_cli)
        self.assertFalse((h.tools / "release.previous").exists())
        self.assertEqual(list(h.tools.glob(".release-stage-*")), [])

    def test_install_concurrency_identity_pairing_and_restart(self):
        h = self.host
        self.assertEqual(h.status()["status"], "uninstalled")
        self.assertFalse(h.primary.exists())
        self.install()
        self.install()
        self.assertEqual(list(self.desktop.iterdir()), [self.desktop / "AutoUsage Upgrade Room.lnk"])
        self.assertEqual(host_module.read_json(h.manifest)["python"], str(Path(sys.executable).resolve()))
        self.assertEqual(h.status()["status"], "stopped")
        self.addCleanup(self.stop)
        # The caller exits. The detached server must survive it.
        parent = subprocess.run([sys.executable, "-I", "-B", __file__, "fixture-ensure", self.root],
                                capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=85)
        error = self.root/"fixture-start-error.json"
        self.assertEqual(parent.returncode, 0, error.read_text() if error.exists() else parent.stderr.decode(errors="replace"))
        state = h.status()
        self.assertEqual(state["status"], "ready")
        self.assertNotIn("url", state)
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: h.ensure(), range(4)))
        self.assertEqual(results, [state] * 4)
        link = h.link()["url"]
        parts = urlsplit(link)
        fields = parse_qs(parts.fragment)
        self.assertFalse(host_module.win.listener_matches(parts.port, os.getpid()))
        self.assertEqual((parts.hostname, parts.path, parts.query, set(fields)),
                         ("127.0.0.1", "/open-room.html", "", {"token"}))
        token = fields["token"][0]
        self.assertNotEqual(token, parse_qs(urlsplit(h.link()["url"]).fragment)["token"][0])
        bootstrap = subprocess.run([h.node, "-e", BOOTSTRAP_CHECK, h.release/"dist/client/open-room.js"],
                                   input=link.encode(), capture_output=True, timeout=8,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(bootstrap.returncode, 0)
        with contextlib.closing(http.client.HTTPConnection(parts.hostname, parts.port)) as conn:
            conn.request("POST", "/api/auth/browser-session", json.dumps({"credential":token}))
            self.assertEqual(conn.getresponse().status, 401)
        with mock.patch.object(os, "startfile") as opener:
            opened = host_module.dispatch("open", h)
            self.assertNotIn("url", opened)
            opener.assert_called_once()
        with mock.patch.object(host_module.win, "listener_matches", return_value=False):
            self.assertEqual(h.status()["status"], "starting")
        identity = h.data / "environment-id"
        identity.write_text("wrong-environment", encoding="utf-8")
        with self.assertRaisesRegex(host_module.HostError, "identity"):
            h.status()
        identity.write_text(state["environmentId"], encoding="utf-8")
        with contextlib.closing(sqlite3.connect(h.data / "state.sqlite")) as db:
            db.execute("INSERT INTO projection_threads VALUES (?,?,NULL,NULL)",(host_module.THREAD_ID,host_module.PROJECT_ID))
            db.commit()
        self.stop()
        with socket.socket() as occupant:
            occupant.bind(("127.0.0.1",parts.port))
            occupant.listen()
            # Concurrent callers on a cold restart and reuse of an occupied previous port.
            with warnings.catch_warnings(), ThreadPoolExecutor(max_workers=4) as pool:
                # A detached child outlives its short-lived launcher by design.
                warnings.filterwarnings("ignore", category=ResourceWarning, module="subprocess")
                ready = list(pool.map(lambda _: h.ensure(), range(4)))
        self.assertEqual(ready, [ready[0]] * 4)
        self.assertNotEqual(ready[0]["origin"], state["origin"])
        self.assertEqual(ready[0]["threadId"], state["threadId"])
        self.assertFalse((h.primary/"userdata").exists())

    def test_separate_state_and_child_configuration(self):
        h = self.host
        primary_db = h.primary / "userdata/state.sqlite"
        primary_db.parent.mkdir(parents=True)
        primary_db.write_bytes(b"fake production database")
        h.data.mkdir(parents=True)
        os.link(primary_db, h.data / "state.sqlite")
        with self.assertRaisesRegex(host_module.HostError, "hard link"):
            h.check_home()
        self.assertEqual(primary_db.read_bytes(), b"fake production database")
        with mock.patch.dict(os.environ, {"NODE_OPTIONS":"--invalid", "T3CODE_HOME":"another home",
                                         "VITE_DEV_SERVER_URL":"http://invalid", "OPENAI_API_KEY":"dummy"}):
            env = h.env()
        self.assertEqual(env["T3CODE_HOME"], str(h.home))
        self.assertEqual(env["T3CODE_UPGRADE_PROJECT_ROOT"], h.project.as_posix())
        self.assertEqual(env["T3CODE_UPGRADE_PRIMARY_HOME"], h.primary.as_posix())
        self.assertFalse({"NODE_OPTIONS", "VITE_DEV_SERVER_URL", "OPENAI_API_KEY"}.intersection(env))

    def test_primary_tree_restart_during_cold_link(self):
        self.install()
        h = self.host
        installed = h.tools / host_module.HOST_SCRIPT
        source = installed.read_text(encoding="utf-8")
        installed.write_text(source.replace('if __name__ == "__main__":', BROKER_BARRIER + '\nif __name__ == "__main__":'),
                             encoding="utf-8")
        for phase in ("before-lease", "before-pid-record"):
            with self.subTest(phase=phase):
                gate = self.root / "resume"
                marker = self.root / "paused.json"
                caller = self.root / "primary-child.json"
                for path in (gate, marker, caller):
                    path.unlink(missing_ok=True)
                (self.root / "phase").write_text(phase)
                main = subprocess.Popen([sys.executable, "-I", "-B", __file__, "fixture-primary", self.root],
                                        creationflags=subprocess.CREATE_NO_WINDOW,
                                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                launcher = broker = None
                try:
                    launcher = psutil.Process(wait_json(caller, main)["pid"])
                    paused = wait_json(marker, main)
                    broker = psutil.Process(paused["broker"])
                    self.assertEqual(broker.parent().name().lower(), "wmiprvse.exe")
                    self.assertEqual(broker.username().lower(), launcher.username().lower())
                    groups = subprocess.check_output([Path(os.environ["SystemRoot"]) / "System32/whoami.exe",
                                                      "/groups", "/fo", "csv", "/nh"],
                                                     creationflags=subprocess.CREATE_NO_WINDOW)
                    self.assertEqual(paused["integrity"], int(re.search(rb"S-1-16-([0-9]+)", groups)[1]))
                    self.assertEqual(paused["appData"], os.environ["APPDATA"])
                    self.assertEqual(launcher.ppid(), main.pid)
                    if phase == "before-lease":
                        self.assertFalse(h.lease.exists())
                    else:
                        self.assertNotIn("pid", host_module.read_json(h.record))
                        server = paused["server"]
                        self.assertEqual(psutil.Process(server["pid"]).ppid(), broker.pid)
                        self.assertEqual(host_module.win.process_identity(server["pid"]), (h.node, server["birth"]))

                    # Wait until the short-lived WMI client has returned. The
                    # request itself is still in flight, blocked on room readiness.
                    deadline = time.monotonic() + 5
                    while any(p.name().lower() == "cscript.exe" for p in launcher.children()) and time.monotonic() < deadline:
                        time.sleep(.03)
                    selected = restart_descendants(psutil.Process(main.pid), self.root, psutil)
                    self.assertIn(launcher.pid, [p.pid for p in selected])
                    self.assertNotIn(broker.pid, [p.pid for p in selected])
                    if paused["server"]:
                        self.assertNotIn(paused["server"]["pid"], [p.pid for p in selected])
                    # The invisible console hosts exit with their owner.
                    self.assertEqual([p.name().lower() for p in selected if p.pid != launcher.pid],
                                     ["conhost.exe"] * (len(selected) - 1))
                    launcher.terminate()
                    main.terminate()
                    main.wait(timeout=5)
                    launcher.wait(timeout=5)
                    self.assertTrue(broker.is_running())
                    gate.touch()
                    broker.wait(timeout=15)

                    # A replacement primary uses the normal click path. Link
                    # output stays in a pipe and is never written to disk.
                    result = subprocess.run([sys.executable, "-I", "-B", installed, "link"],
                                            capture_output=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
                    self.assertEqual(result.returncode, 0)
                    reply = json.loads(result.stdout)
                    self.assertEqual(reply["status"], "ready")
                    if paused["server"]:
                        self.assertEqual(reply["pid"], paused["server"]["pid"])
                    self.assertEqual(host_module.read_json(h.record)["pid"], reply["pid"])
                finally:
                    gate.touch()
                    if launcher and launcher.is_running():
                        launcher.terminate()
                        launcher.wait(timeout=5)
                    if main.poll() is None:
                        main.terminate()
                        main.wait(timeout=5)
                    if broker and broker.is_running():
                        broker.wait(timeout=15)
                    self.stop()

    def test_first_launcher_updates_in_place(self):
        self.install()
        h = self.host
        node = h.node.stat()
        h.home.mkdir()
        sentinel = h.home / "preserved"
        sentinel.write_bytes(b"existing independent state")
        record = host_module.read_json(h.manifest)
        host_module.write_json(h.manifest, {**record, "version": 1})
        (h.tools / host_module.VBS).write_text("' old launcher", encoding="utf-16")
        self.install()
        self.assertEqual(host_module.read_json(h.manifest), record)
        self.assertEqual(record["version"], 2)
        self.assertIn("Win32_Process", (h.tools / host_module.VBS).read_text(encoding="utf-16"))
        self.assertEqual((h.node.stat().st_ino, h.node.stat().st_mtime_ns), (node.st_ino, node.st_mtime_ns))
        self.assertEqual(sentinel.read_bytes(), b"existing independent state")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] in ("fixture-ensure", "fixture-primary"):
        directory = Path(sys.argv[2])
        assert directory.name.startswith("upgrade-fake-")
        h = host_module.Host(directory/"AutoUsage", directory/"project")
        if sys.argv[1] == "fixture-primary":
            with subprocess.Popen([sys.executable, "-I", "-B", h.tools / host_module.HOST_SCRIPT, "link"],
                                  stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                  creationflags=subprocess.CREATE_NO_WINDOW) as child:
                host_module.write_json(directory / "primary-child.json", {"pid":child.pid})
                sys.exit(child.wait(timeout=45))
        h.ensure()
    else:
        unittest.main()
