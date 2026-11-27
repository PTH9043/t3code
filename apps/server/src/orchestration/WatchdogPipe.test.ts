// @effect-diagnostics nodeBuiltinImport:off - Exercises real pipes and child processes.
// @effect-diagnostics globalDate:off - Waits on real child processes.
// @effect-diagnostics globalTimers:off - Waits on real child processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { afterEach, expect, it } from "vite-plus/test";
import {
  applyWatchdogEnvironment,
  buildWatchdogCommandLine,
  launchWatchdogOverPipe,
  launchWatchdogThroughWmi,
  readWatchdogPipeArguments,
  receiveWatchdogPipeLaunch,
  startWatchdogThroughWmi,
  watchdogPipeArguments,
  watchdogStartEnvironment,
  watchdogWmiScript,
  type WatchdogPipeConnection,
} from "./WatchdogPipe.ts";

const moduleUrl = NodeURL.pathToFileURL(
  NodePath.resolve(import.meta.dirname, "WatchdogPipe.ts"),
).href;
const windows = NodeProcess.platform === "win32";
const dirs: string[] = [];
const children: NodeChildProcess.ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
  delete NodeProcess.env.T3_WATCHDOG_TEST_MARKER;
});

async function waitFor(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A stand-in worker that uses the real receive step. It reports next to its own file what it saw,
 * including whether the backend's environment replaced the one it was started with.
 */
function makeWorker() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-watchdog-pipe-"));
  dirs.push(dir);
  const entry = NodePath.join(dir, "worker.ts");
  NodeFS.writeFileSync(
    entry,
    `import { applyWatchdogEnvironment, readWatchdogPipeArguments, receiveWatchdogPipeLaunch } from ${JSON.stringify(moduleUrl)};
import { writeFileSync } from "node:fs";
const out = process.argv[1] + ".json";
try {
  const launch = await receiveWatchdogPipeLaunch(readWatchdogPipeArguments(process.argv.slice(2)), 5000);
  const before = process.env.T3_WATCHDOG_TEST_MARKER ?? null;
  applyWatchdogEnvironment(launch.environment);
  writeFileSync(out, JSON.stringify({
    pid: process.pid,
    ppid: process.ppid,
    jobId: launch.jobId,
    payload: launch.payload,
    before,
    marker: process.env.T3_WATCHDOG_TEST_MARKER ?? null,
    stale: process.env.T3_WATCHDOG_TEST_STALE ?? null,
  }));
  await launch.acknowledge();
} catch (error) {
  writeFileSync(out, JSON.stringify({ refused: String(error) }));
  process.exit(1);
}
`,
  );
  const out = `${entry}.json`;
  return {
    entry,
    report: () => JSON.parse(NodeFS.readFileSync(out, "utf8")),
    reported: () => NodeFS.existsSync(out),
    /** Started directly, so the handoff is exercised on every platform. */
    start: (connection: WatchdogPipeConnection) => {
      const { T3_WATCHDOG_TEST_MARKER: _marker, ...environment } = NodeProcess.env;
      const child = NodeChildProcess.spawn(
        NodeProcess.execPath,
        [entry, ...watchdogPipeArguments(connection)],
        {
          stdio: "ignore",
          windowsHide: true,
          env: { ...environment, T3_WATCHDOG_TEST_STALE: "worker-only" },
        },
      );
      children.push(child);
      return child;
    },
  };
}

/** Connect like a worker would, present `token`, optionally answer, and report what came back. */
function rawClient(
  connection: WatchdogPipeConnection,
  token: string,
  /** Called with the launch: return a reply to send, false to drop the connection, nothing to wait. */
  answer?: (launch: { jobId: string; nonce: string }) => string | false | void,
) {
  return new Promise<{ readonly data: string; readonly connected: boolean }>((resolve) => {
    const socket = NodeNet.connect(connection.pipe);
    let data = "";
    let connected = false;
    let answered = false;
    socket.once("connect", () => {
      connected = true;
      socket.write(`${token}\n`);
    });
    socket.on("data", (chunk) => {
      data += String(chunk);
      if (answered || !answer || !data.includes("\n")) return;
      answered = true;
      const reply = answer(JSON.parse(data));
      if (reply === false) socket.destroy();
      else if (typeof reply === "string") socket.write(`${reply}\n`);
    });
    socket.on("error", () => {});
    socket.on("close", () => resolve({ data, connected }));
  });
}

const launchInput = {
  jobId: "job-1",
  payload: { secret: "credential", nested: { text: '한글 & % "quoted"\nline' } },
  environment: { T3_WATCHDOG_TEST_MARKER: "from-the-backend", PATH: NodeProcess.env.PATH },
};

it("quotes a command line with spaces, shell characters, Korean and trailing backslashes", () => {
  const program = String.raw`C:\Users\홍길동\App Data & (x86) %TEMP%\node.exe`;
  const line = buildWatchdogCommandLine(program, [
    String.raw`D:\dir with space\a&b %PATH% (1)\워커.mjs`,
    String.raw`--t3-watchdog-pipe=\\.\pipe\t3-watchdog-ab`,
    'say "hi"',
    "ends with slash\\",
    'slashes before quote\\\\"x',
    "",
  ]);
  expect(line).toBe(
    [
      String.raw`"C:\Users\홍길동\App Data & (x86) %TEMP%\node.exe"`,
      String.raw`"D:\dir with space\a&b %PATH% (1)\워커.mjs"`,
      String.raw`"--t3-watchdog-pipe=\\.\pipe\t3-watchdog-ab"`,
      String.raw`"say \"hi\""`,
      String.raw`"ends with slash\\"`,
      String.raw`"slashes before quote\\\\\"x"`,
      `""`,
    ].join(" "),
  );
  expect(() => buildWatchdogCommandLine('C:\\a"b\\node.exe', [])).toThrow();
  expect(() => buildWatchdogCommandLine("node.exe", ["two\nlines"])).toThrow();
  expect(() => buildWatchdogCommandLine("node.exe", ["x".repeat(40_000)])).toThrow();
});

it.runIf(windows)("builds a command line that Windows splits back into the same arguments", () => {
  const args = [
    String.raw`D:\dir with space\a&b %PATH% %TEMP% (1)\워커.mjs`,
    String.raw`--t3-watchdog-pipe=\\.\pipe\t3-watchdog-ab`,
    'say "hi"',
    "ends with slash\\",
    'slashes before quote\\\\"x',
    "^caret! 100%",
  ];
  const line = buildWatchdogCommandLine(NodeProcess.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    ...args,
  ]);
  const prefix = `"${NodeProcess.execPath}" `;
  expect(line.startsWith(prefix)).toBe(true);
  // Verbatim: Node passes the rest of the line through untouched, as WMI does.
  const result = NodeChildProcess.spawnSync(NodeProcess.execPath, [line.slice(prefix.length)], {
    argv0: `"${NodeProcess.execPath}"`,
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  expect(JSON.parse(result.stdout)).toEqual(args);
});

it("starts the worker with only the variables a process needs before its first line", () => {
  const environment = {
    systemroot: "C:\\Windows",
    TEMP: "C:\\Users\\홍길동\\Temp & (x) %A%",
    NODE_OPTIONS: '--require "C:\\with space\\hook.cjs"',
    NODE_EXTRA_CA_CERTS: "C:\\certs\\ca.pem",
    ANTHROPIC_API_KEY: "secret",
    PATH: "C:\\bin",
  };
  expect(watchdogStartEnvironment(environment, true)).toEqual([
    "SystemRoot=C:\\Windows",
    "TEMP=C:\\Users\\홍길동\\Temp & (x) %A%",
    'NODE_OPTIONS=--require "C:\\with space\\hook.cjs"',
    "NODE_EXTRA_CA_CERTS=C:\\certs\\ca.pem",
    "ELECTRON_RUN_AS_NODE=1",
  ]);
  expect(watchdogStartEnvironment({ SystemRoot: "C:\\Windows" }, false)).toEqual([
    "SystemRoot=C:\\Windows",
  ]);
  expect(() => watchdogStartEnvironment({ TEMP: "C:\\Temp" }, false)).toThrow();
  expect(() =>
    watchdogStartEnvironment({ SystemRoot: "C:\\Windows", NODE_OPTIONS: "a\nb" }, false),
  ).toThrow();
});

it("reads the pipe connection back from worker arguments", () => {
  const connection = { pipe: String.raw`\\.\pipe\t3-watchdog-ab`, token: "to-ken_1" };
  expect(readWatchdogPipeArguments(watchdogPipeArguments(connection))).toEqual(connection);
  expect(readWatchdogPipeArguments(["--t3-separate-process-tree"])).toBeUndefined();
  expect(readWatchdogPipeArguments([watchdogPipeArguments(connection)[0]!])).toBeUndefined();
});

it("replaces the worker environment with the backend's and keeps Electron running as Node", () => {
  const target: Record<string, string | undefined> = {
    ELECTRON_RUN_AS_NODE: "1",
    SystemRoot: "C:\\Windows",
    ONLY_IN_WORKER: "x",
  };
  applyWatchdogEnvironment({ SystemRoot: "C:\\Windows", API_KEY: "k" }, target);
  expect(target).toEqual({ ELECTRON_RUN_AS_NODE: "1", SystemRoot: "C:\\Windows", API_KEY: "k" });
});

it("hands the launch and the backend environment to a real worker and reports its pid", async () => {
  const worker = makeWorker();
  let child: NodeChildProcess.ChildProcess | undefined;
  const result = await launchWatchdogOverPipe({
    ...launchInput,
    start: async (connection) => {
      child = worker.start(connection);
      return child.pid;
    },
  });
  expect(result).toEqual({ status: "received", pid: child?.pid });
  await waitFor(() => child?.exitCode !== null);
  expect(worker.report()).toEqual({
    pid: child?.pid,
    ppid: NodeProcess.pid,
    jobId: "job-1",
    payload: launchInput.payload,
    before: null,
    marker: "from-the-backend",
    stale: null,
  });
});

it("gives a client with the wrong token nothing and does not count it as a launch", async () => {
  for (const wrong of [(token: string) => "x".repeat(token.length), () => "short"]) {
    let seen: WatchdogPipeConnection | undefined;
    let reply: ReturnType<typeof rawClient> | undefined;
    const result = await launchWatchdogOverPipe({
      ...launchInput,
      start: async (connection) => {
        seen = connection;
        reply = rawClient(connection, wrong(connection.token));
        return NodeProcess.pid;
      },
    });
    expect(result).toEqual({ status: "not-started" });
    expect(await reply).toEqual({ data: "", connected: true });
    // The pipe is gone with the failed attempt: the right token is worth nothing now.
    expect((await rawClient(seen!, seen!.token)).data).toBe("");
  }
});

it("accepts one connection only", async () => {
  let second: ReturnType<typeof rawClient> | undefined;
  const result = await launchWatchdogOverPipe({
    ...launchInput,
    start: async (connection) => {
      void rawClient(connection, connection.token, () => {
        second = rawClient(connection, connection.token);
        return false;
      });
      return NodeProcess.pid;
    },
  });
  expect(result).toEqual({ status: "unknown" });
  expect((await second)?.data).toBe("");
});

it("resolves the launcher script outside app.asar for packaged desktop builds", () => {
  expect(
    watchdogWmiScript(String.raw`C:\Program Files\T3\resources\app.asar\apps\server\dist\bin.mjs`),
  ).toBe(
    String.raw`C:\Program Files\T3\resources\app.asar.unpacked\apps\server\dist\watchdog-wmi-launch.vbs`,
  );
  expect(watchdogWmiScript("/opt/t3/resources/app.asar/apps/server/dist/bin.mjs")).toContain(
    "app.asar.unpacked",
  );
  expect(watchdogWmiScript(String.raw`D:\repo\apps\server\dist\bin.mjs`)).toBe(
    String.raw`D:\repo\apps\server\dist\watchdog-wmi-launch.vbs`,
  );
});

it("reports not-started only while nothing has been handed over", async () => {
  const signals: AbortSignal[] = [];
  const notCreated = await launchWatchdogOverPipe({
    ...launchInput,
    start: async (_connection, signal) => {
      signals.push(signal);
      return undefined;
    },
  });
  expect(notCreated).toEqual({ status: "not-started" });
  expect(signals[0]?.aborted).toBe(true);

  const failed = await launchWatchdogOverPipe({
    ...launchInput,
    start: () => Promise.reject(new Error("no script host")),
  });
  expect(failed).toEqual({ status: "not-started" });

  const threwSync = await launchWatchdogOverPipe({
    ...launchInput,
    start: () => {
      throw new Error("sync failure");
    },
  });
  expect(threwSync).toEqual({ status: "not-started" });

  const silent = await launchWatchdogOverPipe({
    ...launchInput,
    connectTimeoutMs: 100,
    start: async () => NodeProcess.pid,
  });
  expect(silent).toEqual({ status: "not-started" });

  const aborting = new AbortController();
  const aborted = await launchWatchdogOverPipe({
    ...launchInput,
    signal: aborting.signal,
    start: async () => {
      aborting.abort();
      return NodeProcess.pid;
    },
  });
  expect(aborted).toEqual({ status: "not-started" });
});

it("reports unknown, never not-started, once the launch has been written", async () => {
  const token = (connection: WatchdogPipeConnection) => connection.token;
  // The worker read the launch and died.
  let dropped: ReturnType<typeof rawClient> | undefined;
  const closed = await launchWatchdogOverPipe({
    ...launchInput,
    start: async (connection) => {
      dropped = rawClient(connection, token(connection), () => false);
      return NodeProcess.pid;
    },
  });
  expect(closed).toEqual({ status: "unknown" });
  expect(JSON.parse((await dropped)!.data)).toMatchObject({
    type: "watchdog.start",
    version: 1,
    jobId: "job-1",
    payload: launchInput.payload,
    environment: { T3_WATCHDOG_TEST_MARKER: "from-the-backend" },
  });

  // The worker never answers, and creation is reported as failed afterwards.
  const silent = await launchWatchdogOverPipe({
    ...launchInput,
    acknowledgeTimeoutMs: 150,
    start: async (connection) => {
      await new Promise<void>(
        (arrived) => void rawClient(connection, token(connection), () => arrived()),
      );
      return undefined;
    },
  });
  expect(silent).toEqual({ status: "unknown" });

  // An acknowledgment for another launch proves nothing.
  const mismatched = await launchWatchdogOverPipe({
    ...launchInput,
    start: async (connection) => {
      void rawClient(connection, token(connection), (launch) =>
        JSON.stringify({ ...launch, type: "watchdog.received", nonce: "other", pid: 1 }),
      );
      return NodeProcess.pid;
    },
  });
  expect(mismatched).toEqual({ status: "unknown" });

  const aborting = new AbortController();
  const aborted = await launchWatchdogOverPipe({
    ...launchInput,
    signal: aborting.signal,
    start: async (connection) => {
      void rawClient(connection, token(connection), () => aborting.abort());
      return NodeProcess.pid;
    },
  });
  expect(aborted).toEqual({ status: "unknown" });
});

it("stops waiting as soon as the created worker is gone without having connected", async () => {
  const started = Date.now();
  const result = await launchWatchdogOverPipe({
    ...launchInput,
    connectTimeoutMs: 20_000,
    // A worker build that predates the pipe: it starts, finds no IPC channel and exits.
    start: async () => {
      const child = NodeChildProcess.spawn(NodeProcess.execPath, ["-e", ""], {
        stdio: "ignore",
        windowsHide: true,
      });
      children.push(child);
      return child.pid;
    },
  });
  expect(result).toEqual({ status: "not-started" });
  expect(Date.now() - started).toBeLessThan(10_000);
});

it("refuses a worker that connects after the launch was given up, and that worker exits", async () => {
  const worker = makeWorker();
  let late: WatchdogPipeConnection | undefined;
  const result = await launchWatchdogOverPipe({
    ...launchInput,
    connectTimeoutMs: 100,
    // Creation succeeded, but the worker is still starting when the backend stops waiting.
    start: async (connection) => {
      late = connection;
      return NodeProcess.pid;
    },
  });
  expect(result).toEqual({ status: "not-started" });
  const child = worker.start(late!);
  await waitFor(() => child.exitCode !== null);
  expect(child.exitCode).toBe(1);
  expect(Object.keys(worker.report())).toEqual(["refused"]);
});

it("reports a worker that was not created", async () => {
  const signal = new AbortController().signal;
  const input = { command: '"node.exe"', cwd: NodeOS.tmpdir(), startEnvironment: [], signal };
  expect(
    await startWatchdogThroughWmi({
      ...input,
      systemRoot: NodePath.join(NodeOS.tmpdir(), "t3-watchdog-no-windows-here"),
    }),
  ).toBeUndefined();
  expect(
    await startWatchdogThroughWmi({
      ...input,
      systemRoot: NodeProcess.env.SystemRoot ?? "",
      signal: AbortSignal.abort(),
    }),
  ).toBeUndefined();
});

it.runIf(windows)("reports a refused WMI process creation", async () => {
  const systemRoot = NodeProcess.env.SystemRoot!;
  expect(
    await startWatchdogThroughWmi({
      command: buildWatchdogCommandLine(String.raw`C:\t3-watchdog-missing\none.exe`, []),
      cwd: NodeOS.tmpdir(),
      startEnvironment: watchdogStartEnvironment({ SystemRoot: systemRoot }, false),
      systemRoot,
      signal: new AbortController().signal,
    }),
  ).toBeUndefined();
});

it("does not block worker acknowledge when the backend stops closing the pipe", async () => {
  const pipe =
    NodeProcess.platform === "win32"
      ? String.raw`\\.\pipe\t3-watchdog-ack-${NodeCrypto.randomBytes(6).toString("hex")}`
      : NodePath.join(
          NodeOS.tmpdir(),
          `t3-watchdog-ack-${NodeCrypto.randomBytes(6).toString("hex")}.sock`,
        );
  const token = "ack-token-1";
  const sockets: NodeNet.Socket[] = [];
  const server = NodeNet.createServer((socket) => {
    sockets.push(socket);
    let sawToken = false;
    socket.on("data", () => {
      if (sawToken) return;
      sawToken = true;
      socket.write(
        `${JSON.stringify({
          type: "watchdog.start",
          version: 1,
          jobId: "job-ack",
          nonce: "n-1",
          payload: { ok: true },
          environment: {},
        })}\n`,
      );
      // Deliberately keep the backend side open without closing on acknowledgment.
    });
  });
  await new Promise<void>((resolve) => server.listen(pipe, resolve));
  try {
    const launch = await receiveWatchdogPipeLaunch({ pipe, token }, 5_000);
    const started = Date.now();
    await launch.acknowledge();
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.runIf(windows)(
  "starts a hidden worker through WMI that is not this process's child",
  async () => {
    const worker = makeWorker();
    NodeProcess.env.T3_WATCHDOG_TEST_MARKER = "from-the-backend";
    const result = await launchWatchdogThroughWmi({
      entry: worker.entry,
      jobId: "job-wmi",
      payload: launchInput.payload,
    });
    await waitFor(worker.reported);
    const report = worker.report();
    expect(result).toEqual({ status: "received", pid: report.pid });
    expect(report).toMatchObject({
      jobId: "job-wmi",
      payload: launchInput.payload,
      // The marker is absent at WMI start and arrives with the backend's environment over the pipe.
      before: null,
      marker: "from-the-backend",
    });
    expect(report.ppid).not.toBe(NodeProcess.pid);
  },
  30_000,
);
