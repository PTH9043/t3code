// @effect-diagnostics nodeBuiltinImport:off - Runs in the detached worker before anything else is imported.
// @effect-diagnostics globalTimers:off - A detached handoff is bounded by wall-clock time.
/**
 * Windows start of a watchdog worker outside every job object that encloses the backend, and the
 * one-shot pipe that replaces the inherited IPC channel for that start.
 *
 * Node built-ins only. The worker entry imports this file while it still has a bare start
 * environment, so nothing here may load a module that reads the environment as it is evaluated.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

/** Where the worker finds its launch. Both values are single-use and die with the handoff. */
export interface WatchdogPipeConnection {
  readonly pipe: string;
  readonly token: string;
}

export interface WatchdogPipeLaunch {
  readonly jobId: string;
  readonly payload: unknown;
  /** The backend's environment at launch. Apply it before importing anything that reads it. */
  readonly environment: Readonly<Record<string, string>>;
  /** Confirm receipt once the payload is known to be usable. Never rejects. */
  readonly acknowledge: () => Promise<void>;
}

export type WatchdogPipeLaunchResult =
  | { readonly status: "received"; readonly pid: number }
  /** Nothing was handed over and the token is dead: no worker can run this launch any more. */
  | { readonly status: "not-started" }
  | { readonly status: "unknown" };

const PIPE_ARGUMENT = "--t3-watchdog-pipe=";
const TOKEN_ARGUMENT = "--t3-watchdog-token=";
const CONNECT_TIMEOUT_MS = 3_000;
const ACKNOWLEDGE_TIMEOUT_MS = 30_000;
const RECEIVE_TIMEOUT_MS = 15_000;
const MAX_LAUNCH_BYTES = 64 * 1024 * 1024;
/** What Windows needs to start a process at all. The rest of the environment follows by pipe. */
const START_VARIABLES = ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP"];
/** Read by Node before the first line of the worker runs, so they cannot wait for the pipe. */
const NODE_START_VARIABLES = ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS"];

/** The worker arguments that carry a pipe connection. They are visible to same-user processes. */
export const watchdogPipeArguments = (connection: WatchdogPipeConnection) => [
  `${PIPE_ARGUMENT}${connection.pipe}`,
  `${TOKEN_ARGUMENT}${connection.token}`,
];

/** Read the pipe connection from a worker's own arguments, if it was started with one. */
export function readWatchdogPipeArguments(
  args: ReadonlyArray<string>,
): WatchdogPipeConnection | undefined {
  const value = (prefix: string) =>
    args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  const pipe = value(PIPE_ARGUMENT);
  const token = value(TOKEN_ARGUMENT);
  return pipe && token ? { pipe, token } : undefined;
}

/** Text that neither a command line nor a one-per-line variable list can carry. */
const unquotable = (text: string) =>
  ["\0", "\r", "\n"].some((character) => text.includes(character));

/**
 * Join a program and its arguments into one Windows command line for `CreateProcess`, quoted the
 * way the C runtime splits arguments. No shell reads the line, so `%`, `&`, `^` and parentheses are
 * ordinary characters. Throws for text no quoting can carry.
 */
export function buildWatchdogCommandLine(program: string, args: ReadonlyArray<string>): string {
  // The program name is read up to the next quote without escapes, so it cannot contain one.
  if (!program || program.includes('"') || unquotable(program))
    throw new Error("Watchdog program path cannot be quoted.");
  const quoted = args.map((argument) => {
    if (unquotable(argument)) throw new Error("Watchdog argument cannot be quoted.");
    // Backslashes are literal except before a quote, where each one is doubled.
    return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  });
  const line = [`"${program}"`, ...quoted].join(" ");
  if (line.length > 32_000) throw new Error("Watchdog command line is too long.");
  return line;
}

function environmentValue(environment: Readonly<Record<string, string | undefined>>, name: string) {
  const match = Object.keys(environment).find((key) => key.toUpperCase() === name.toUpperCase());
  return match === undefined ? undefined : environment[match];
}

/**
 * The complete environment the worker process is created with, as `NAME=value`: what Windows and
 * Node read before the worker's first line, and nothing secret, because the list travels in the
 * launcher script's own environment. Throws when a value cannot be carried or Windows is unknown.
 */
export function watchdogStartEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  electron: boolean,
): ReadonlyArray<string> {
  if (!environmentValue(environment, "SystemRoot"))
    throw new Error("Watchdog start environment has no SystemRoot.");
  const entries: string[] = [];
  for (const name of [...START_VARIABLES, ...NODE_START_VARIABLES]) {
    const value = environmentValue(environment, name);
    if (value === undefined || value === "") continue;
    if (unquotable(value)) throw new Error(`Watchdog start variable ${name} cannot be passed.`);
    entries.push(`${name}=${value}`);
  }
  // Electron only behaves as Node when this is set before the process starts.
  if (electron) entries.push("ELECTRON_RUN_AS_NODE=1");
  return entries;
}

/**
 * The launcher script that ships next to this module. The script host cannot read inside a
 * packaged `app.asar`, so there the unpacked copy of the same file is used.
 */
export const watchdogWmiScript = (moduleFile = NodeURL.fileURLToPath(import.meta.url)) =>
  NodePath.join(NodePath.dirname(moduleFile), "watchdog-wmi-launch.vbs").replace(
    /([\\/])app\.asar([\\/])/,
    "$1app.asar.unpacked$2",
  );

/**
 * Create one hidden process through WMI and resolve its process id. Resolves undefined when it
 * was not created: the script host is missing or failed, `Win32_Process.Create` refused, or
 * `signal` ended the attempt first.
 */
export function startWatchdogThroughWmi(input: {
  readonly command: string;
  readonly cwd: string;
  readonly startEnvironment: ReadonlyArray<string>;
  readonly systemRoot: string;
  readonly signal: AbortSignal;
}): Promise<number | undefined> {
  if (input.signal.aborted) return Promise.resolve(undefined);
  let host: ReturnType<typeof NodeChildProcess.spawn>;
  try {
    host = NodeChildProcess.spawn(
      NodePath.join(input.systemRoot, "System32", "cscript.exe"),
      ["//B", "//Nologo", watchdogWmiScript()],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        // Only what the constant script reads. The backend's own environment is not passed on.
        env: {
          SystemRoot: input.systemRoot,
          T3_WD_COMMAND: input.command,
          T3_WD_CWD: input.cwd,
          T3_WD_ENVIRONMENT: input.startEnvironment.join("\n"),
        },
      },
    );
  } catch {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    let output = "";
    const abort = () => host.kill();
    const finish = (created: number | undefined) => {
      input.signal.removeEventListener("abort", abort);
      resolve(created);
    };
    host.stdout?.on("data", (chunk) => {
      if (output.length < 256) output += String(chunk);
    });
    host.once("error", () => finish(undefined));
    host.once("close", (code) => {
      const created = /^t3-watchdog-created (\d+)\s*$/.exec(output);
      finish(code === 0 && created ? Number(created[1]) : undefined);
    });
    input.signal.addEventListener("abort", abort, { once: true });
  });
}

/** False only when the process is known to be gone. */
function processExists(pid: number) {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

const watchdogPipeName = () => {
  const name = `t3-watchdog-${NodeCrypto.randomBytes(16).toString("hex")}`;
  return NodeProcess.platform === "win32"
    ? `\\\\.\\pipe\\${name}`
    : NodePath.join(NodeOS.tmpdir(), `${name}.sock`);
};

/** Take one complete line off the front of what a socket has delivered so far. */
function takeLine(buffered: { data: Buffer }): Buffer | undefined {
  const end = buffered.data.indexOf(10);
  if (end < 0) return undefined;
  const line = buffered.data.subarray(0, end);
  buffered.data = buffered.data.subarray(end + 1);
  return line;
}

function acknowledgedPid(line: Buffer, jobId: string, nonce: string): number | undefined {
  try {
    const message: unknown = JSON.parse(line.toString("utf8"));
    if (typeof message !== "object" || message === null) return undefined;
    const { type, version, jobId: job, nonce: echoed, pid } = message as Record<string, unknown>;
    return type === "watchdog.received" &&
      version === 1 &&
      job === jobId &&
      echoed === nonce &&
      typeof pid === "number" &&
      Number.isSafeInteger(pid) &&
      pid > 0
      ? pid
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Backend side of the pipe handoff. Listens on a fresh pipe, asks `start` to create the worker,
 * accepts exactly one connection and sends nothing until that client presents the one-time token.
 * The launch (which carries credentials) and the backend's environment then go to that client only.
 *
 * `not-started` is returned only while nothing has been written: the pipe is closed and the token
 * dead, so a worker that shows up later is refused and the caller may launch another way. Once the
 * launch has been written the outcome is `received` or `unknown`, and is never retried.
 *
 * A created process that exits without connecting (for example a worker build that predates the
 * pipe) ends the wait at once instead of after the connect timeout.
 */
export function launchWatchdogOverPipe(input: {
  readonly jobId: string;
  readonly payload: unknown;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Create the worker with this connection. Resolve its process id, or undefined when it definitely was not created. */
  readonly start: (
    connection: WatchdogPipeConnection,
    signal: AbortSignal,
  ) => Promise<number | undefined>;
  readonly signal?: AbortSignal;
  readonly connectTimeoutMs?: number;
  readonly acknowledgeTimeoutMs?: number;
}): Promise<WatchdogPipeLaunchResult> {
  if (input.signal?.aborted) return Promise.resolve({ status: "not-started" });
  const connection = {
    pipe: watchdogPipeName(),
    token: NodeCrypto.randomBytes(32).toString("base64url"),
  };
  const expected = Buffer.from(connection.token);
  const nonce = NodeCrypto.randomUUID();
  let launch: string;
  try {
    launch = JSON.stringify({
      type: "watchdog.start",
      version: 1,
      jobId: input.jobId,
      nonce,
      payload: input.payload,
      environment: input.environment,
    });
  } catch {
    return Promise.resolve({ status: "not-started" });
  }
  return new Promise((resolve) => {
    const starting = new AbortController();
    const server = NodeNet.createServer();
    const buffered = { data: Buffer.alloc(0) };
    let socket: NodeNet.Socket | undefined;
    let handedOver = false;
    let done = false;
    let acknowledgeTimer: ReturnType<typeof setTimeout> | undefined;
    let exitWatch: ReturnType<typeof setInterval> | undefined;
    const finish = (result: WatchdogPipeLaunchResult) => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      clearTimeout(acknowledgeTimer);
      clearInterval(exitWatch);
      input.signal?.removeEventListener("abort", stop);
      starting.abort();
      socket?.destroy();
      server.close();
      resolve(result);
    };
    const stop = () => finish({ status: handedOver ? "unknown" : "not-started" });
    const connectTimer = setTimeout(() => {
      if (!handedOver) stop();
    }, input.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
    server.on("error", stop);
    server.on("connection", (incoming) => {
      if (socket || done) return void incoming.destroy();
      socket = incoming;
      // Exactly one client: the pipe stops existing for everyone else.
      server.close();
      incoming.on("error", stop);
      incoming.on("close", stop);
      incoming.on("data", (chunk: Buffer) => {
        if (done) return;
        buffered.data = Buffer.concat([buffered.data, chunk]);
        for (let line = takeLine(buffered); line; line = takeLine(buffered)) {
          if (handedOver) {
            const pid = acknowledgedPid(line, input.jobId, nonce);
            return finish(pid === undefined ? { status: "unknown" } : { status: "received", pid });
          }
          if (line.length !== expected.length || !NodeCrypto.timingSafeEqual(line, expected))
            return stop();
          handedOver = true;
          clearTimeout(connectTimer);
          acknowledgeTimer = setTimeout(stop, input.acknowledgeTimeoutMs ?? ACKNOWLEDGE_TIMEOUT_MS);
          incoming.write(`${launch}\n`, (error) => {
            if (error) stop();
          });
        }
        // Neither a token nor an acknowledgment is this long.
        if (buffered.data.length > 4096) stop();
      });
    });
    input.signal?.addEventListener("abort", stop, { once: true });
    server.listen(connection.pipe, () => {
      if (done) return;
      const notCreated = () => {
        if (!handedOver) stop();
      };
      // `start` may also throw before it returns a promise.
      new Promise<number | undefined>((created) =>
        created(input.start(connection, starting.signal)),
      ).then((pid) => {
        if (pid === undefined) return notCreated();
        if (done) return;
        // A worker that is gone before it connected can never ask for the launch.
        exitWatch = setInterval(() => {
          if (!socket && !processExists(pid)) stop();
        }, 100);
      }, notCreated);
    });
  });
}

function readPipeLaunch(line: Buffer) {
  const message: unknown = JSON.parse(line.toString("utf8"));
  if (typeof message !== "object" || message === null) throw new Error("Not a launch.");
  const { type, version, jobId, nonce, payload, environment } = message as Record<string, unknown>;
  if (type !== "watchdog.start" || version !== 1) throw new Error("Not a launch.");
  if (typeof jobId !== "string" || !jobId || typeof nonce !== "string" || !nonce)
    throw new Error("Missing watchdog identity.");
  if (typeof environment !== "object" || environment === null)
    throw new Error("Missing watchdog environment.");
  const variables: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment))
    if (typeof value === "string") variables[name] = value;
  return { jobId, nonce, payload, environment: variables };
}

/**
 * Worker side of the pipe handoff: connect, present the token, read the single launch. Rejects when
 * the pipe is gone, closes first or stays silent, which means the backend gave up on this start and
 * the worker must exit without running anything.
 */
export function receiveWatchdogPipeLaunch(
  connection: WatchdogPipeConnection,
  timeoutMs = RECEIVE_TIMEOUT_MS,
): Promise<WatchdogPipeLaunch> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.connect(connection.pipe);
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (message: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("Watchdog launch did not arrive in time."), timeoutMs);
    socket.once("connect", () => socket.write(`${connection.token}\n`));
    // Stays attached after receipt: losing the backend then must not end the worker.
    socket.on("error", () => fail("Watchdog launch pipe is not available."));
    socket.on("close", () => fail("Watchdog launch pipe closed before the execution arrived."));
    socket.on("data", (chunk: Buffer) => {
      if (done) return;
      const end = chunk.indexOf(10);
      const part = end < 0 ? chunk : chunk.subarray(0, end);
      chunks.push(part);
      size += part.length;
      if (size > MAX_LAUNCH_BYTES) return fail("Watchdog launch is too large.");
      if (end < 0) return;
      let launch: ReturnType<typeof readPipeLaunch>;
      try {
        launch = readPipeLaunch(Buffer.concat(chunks));
      } catch {
        return fail("Invalid watchdog launch payload.");
      }
      done = true;
      clearTimeout(timer);
      resolve({
        jobId: launch.jobId,
        payload: launch.payload,
        environment: launch.environment,
        acknowledge: () =>
          new Promise((resume) => {
            if (socket.destroyed || !socket.writable) return resume();
            // Sent or lost, the worker goes on: it never waits for the backend to answer.
            socket.once("close", () => resume());
            socket.end(
              `${JSON.stringify({ type: "watchdog.received", version: 1, jobId: launch.jobId, nonce: launch.nonce, pid: NodeProcess.pid })}\n`,
              () => resume(),
            );
          }),
      });
    });
  });
}

/**
 * Make this process's environment the backend's. Variables the backend does not have are removed.
 * ELECTRON_RUN_AS_NODE survives even then: the worker's own children reuse this executable.
 */
export function applyWatchdogEnvironment(
  environment: Readonly<Record<string, string>>,
  target: Record<string, string | undefined> = NodeProcess.env,
) {
  const key = (name: string) => (NodeProcess.platform === "win32" ? name.toUpperCase() : name);
  const runAsNode = target.ELECTRON_RUN_AS_NODE;
  const incoming = new Set(Object.keys(environment).map(key));
  for (const name of Object.keys(target)) if (!incoming.has(key(name))) delete target[name];
  for (const [name, value] of Object.entries(environment)) target[name] = value;
  if (runAsNode !== undefined && target.ELECTRON_RUN_AS_NODE === undefined)
    target.ELECTRON_RUN_AS_NODE = runAsNode;
}

/**
 * Start `entry` as a worker of this executable through WMI and hand it one launch over a pipe, so
 * the worker outlives a job object around the backend. Windows only. See `launchWatchdogOverPipe`
 * for what each result allows the caller to do.
 */
export function launchWatchdogThroughWmi(input: {
  readonly entry: string;
  readonly jobId: string;
  readonly payload: unknown;
  readonly signal?: AbortSignal;
}): Promise<WatchdogPipeLaunchResult> {
  const environment = { ...NodeProcess.env };
  const systemRoot = environmentValue(environment, "SystemRoot");
  let startEnvironment: ReadonlyArray<string>;
  try {
    startEnvironment = watchdogStartEnvironment(
      environment,
      NodeProcess.versions.electron !== undefined,
    );
  } catch {
    return Promise.resolve({ status: "not-started" });
  }
  if (!systemRoot) return Promise.resolve({ status: "not-started" });
  return launchWatchdogOverPipe({
    jobId: input.jobId,
    payload: input.payload,
    environment,
    ...(input.signal ? { signal: input.signal } : {}),
    start: (connection, signal) => {
      let command: string;
      try {
        command = buildWatchdogCommandLine(NodeProcess.execPath, [
          input.entry,
          ...watchdogPipeArguments(connection),
        ]);
      } catch {
        return Promise.resolve(undefined);
      }
      return startWatchdogThroughWmi({
        command,
        cwd: NodeProcess.cwd(),
        startEnvironment,
        systemRoot,
        signal,
      });
    },
  });
}
