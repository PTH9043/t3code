import * as NodeModule from "node:module";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Inspect the real node-pty helper launch.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);

it.skipIf(process.platform !== "win32")(
  "hides the real console-list helper when a Windows terminal is stopped",
  async () => {
    const entry = require.resolve("node-pty");
    const helperEntry = require.resolve("node-pty/lib/conpty_console_list_agent");
    const script = `
      const childProcess = require("node:child_process");
      const path = require("node:path");
      const original = childProcess.fork;
      let helperOptions;
      childProcess.fork = function(file, args, options) {
        if (String(file).includes("conpty_console_list_agent")) helperOptions = options;
        return original.apply(this, arguments);
      };
      const pty = require(${JSON.stringify(entry)});
      const terminal = pty.spawn(path.join(process.env.SystemRoot, "System32", "cmd.exe"), ["/d", "/c", "ping -n 20 127.0.0.1"], {
        cwd: process.cwd(), env: process.env, cols: 80, rows: 24, name: "xterm-color"
      });
      let started = false;
      let stopped = false;
      let childPid;
      const stopTerminal = () => {
        if (stopped) return;
        stopped = true;
        terminal.kill();
      };
      const deadline = setTimeout(() => {
        stopTerminal();
        console.error("Timed out waiting for the terminal or its child to exit");
        process.exitCode = 1;
      }, 10_000);
      terminal.onData(() => {
        if (started) return;
        started = true;
        const probe = original(${JSON.stringify(helperEntry)}, [String(terminal.pid)], { windowsHide: true, silent: true });
        probe.on("message", (message) => {
          childPid = message.consoleProcessList.find((pid) => pid !== terminal.pid && pid !== probe.pid);
          if (!childPid) {
            console.error("The running console child was not found");
            process.exitCode = 1;
          }
          stopTerminal();
        });
        probe.on("error", (error) => { console.error(error); stopTerminal(); process.exitCode = 1; });
        probe.on("exit", (code) => {
          if (code !== 0 && !childPid) { stopTerminal(); process.exitCode = 1; }
        });
      });
      terminal.onExit(() => {
        stopped = true;
        const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
        const interval = setInterval(() => {
          if (alive(terminal.pid) || (childPid && alive(childPid))) return;
          clearInterval(interval);
          clearTimeout(deadline);
          console.log(JSON.stringify({ helperOptions, childObserved: Boolean(childPid), terminated: true }));
        }, 50);
        interval.unref();
      });
    `;
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      process.execPath,
      ["-e", script],
      { windowsHide: true, timeout: 12_000 },
    );
    expect(JSON.parse(stdout.trim())).toMatchObject({
      helperOptions: { windowsHide: true },
      childObserved: true,
      terminated: true,
    });
  },
  15_000,
);
