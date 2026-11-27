// @effect-diagnostics nodeBuiltinImport:off - Detached IPC must outlive the owning Effect scope.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import NodeProcess from "node:process";
import * as Schema from "effect/Schema";
import { launchWatchdogThroughWmi } from "./WatchdogPipe.ts";

const Launch = Schema.Struct({
  type: Schema.Literal("watchdog.start"),
  version: Schema.Literal(1),
  jobId: Schema.String,
  nonce: Schema.String,
  payload: Schema.Unknown,
});
const Acknowledgment = Schema.Struct({
  type: Schema.Literal("watchdog.received"),
  version: Schema.Literal(1),
  jobId: Schema.String,
  nonce: Schema.String,
});
const decodeLaunch = Schema.decodeUnknownSync(Launch);
const decodeAcknowledgment = Schema.decodeUnknownSync(Acknowledgment);

/** Worker argument for the short-lived intermediate process. */
export const WATCHDOG_SEPARATE_TREE_FLAG = "--t3-separate-process-tree";

export type WatchdogProcessLaunchResult =
  | { readonly status: "received"; readonly pid: number }
  | { readonly status: "not-started" }
  | { readonly status: "unknown"; readonly pid?: number };

/**
 * Hand off a single execution through the inherited private IPC channel. The
 * payload can contain provider and MCP credentials, so it is never put in the
 * command line, environment, or journal. An acknowledgment proves receipt only;
 * the journal remains authoritative about claiming and submitting the turn.
 *
 * On Windows a separated worker is instead created outside every job object
 * around the backend and reads the same message from a one-shot pipe (see
 * WatchdogPipe.ts), with the same rule about where the payload may appear.
 */
export function launchDetachedWatchdog(input: {
  readonly entry: string;
  readonly jobId: string;
  readonly payload: unknown;
  readonly signal?: AbortSignal;
  /**
   * Keep the worker alive when the backend's process tree or job object ends.
   * On Windows this starts the worker through WMI with a one-shot pipe first
   * and falls back to an intermediate detached process only if nothing was
   * handed over; elsewhere it uses the intermediate process directly.
   */
  readonly separateProcessTree?: boolean;
}): Promise<WatchdogProcessLaunchResult> {
  if (!input.jobId) throw new Error("Watchdog job identity is required.");
  if (input.signal?.aborted) return Promise.resolve({ status: "not-started" });
  // A job object around the backend (the dev task runner creates one) ends every process started
  // inside it, detached or not. Only a start that handed nothing over is repeated the usual way.
  if (input.separateProcessTree && NodeProcess.platform === "win32")
    return launchWatchdogThroughWmi({
      entry: input.entry,
      jobId: input.jobId,
      payload: input.payload,
      ...(input.signal ? { signal: input.signal } : {}),
    }).then((result) => {
      if (result.status !== "not-started") return result;
      NodeProcess.stderr.write(
        `[watchdog] WMI launch did not start for job ${input.jobId}; falling back to process-tree launch.\n`,
      );
      return launchThroughProcessTree(input);
    });
  return launchThroughProcessTree(input);
}

/** Start the worker as a detached child of this process, directly or through the intermediate. */
function launchThroughProcessTree(
  input: Parameters<typeof launchDetachedWatchdog>[0],
): Promise<WatchdogProcessLaunchResult> {
  if (input.signal?.aborted) return Promise.resolve({ status: "not-started" });
  let child: ReturnType<typeof spawn>;
  try {
    const args = input.separateProcessTree
      ? [input.entry, WATCHDOG_SEPARATE_TREE_FLAG]
      : [input.entry];
    child = spawn(NodeProcess.execPath, args, {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
  } catch {
    return Promise.resolve({ status: "not-started" });
  }
  const nonce = randomUUID();
  return new Promise((resolve) => {
    let done = false;
    const finish = (status: "received" | "unknown") => {
      if (done) return;
      done = true;
      input.signal?.removeEventListener("abort", abort);
      child.removeListener("message", message);
      child.removeListener("exit", exited);
      child.removeListener("error", failed);
      child.on("error", ignoreLateError);
      if (child.connected) child.disconnect();
      child.unref();
      if (status === "received" && child.pid !== undefined) resolve({ status, pid: child.pid });
      else resolve({ status: "unknown", ...(child.pid === undefined ? {} : { pid: child.pid }) });
    };
    const abort = () => finish("unknown");
    const exited = () => finish("unknown");
    const failed = () => finish("unknown");
    const ignoreLateError = () => {};
    const message = (raw: unknown) => {
      try {
        const acknowledgment = decodeAcknowledgment(raw);
        if (acknowledgment.jobId === input.jobId && acknowledgment.nonce === nonce)
          finish("received");
      } catch {
        // Ignore unrelated or invalid messages; they do not establish receipt.
      }
    };
    child.on("message", message);
    child.once("exit", exited);
    child.once("error", failed);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) return finish("unknown");
    try {
      child.send(
        { type: "watchdog.start", version: 1, jobId: input.jobId, nonce, payload: input.payload },
        (error) => {
          if (error) finish("unknown");
        },
      );
    } catch {
      finish("unknown");
    }
  });
}

/**
 * Intermediate side of `separateProcessTree`: start the worker detached (so it
 * is not bound to this short-lived process), pass the single launch message
 * through, return the worker's acknowledgment, then exit. Without an
 * acknowledgment the caller sees this process exit and treats the launch as
 * unknown, which the journal resolves.
 */
export function relayWatchdogLaunch(entry: string): Promise<void> {
  return new Promise((resolve) => {
    let worker: ReturnType<typeof spawn> | undefined;
    const finish = () => {
      if (worker) {
        if (worker.connected) worker.disconnect();
        worker.unref();
      }
      if (NodeProcess.connected) NodeProcess.disconnect();
      resolve();
    };
    NodeProcess.once("disconnect", finish);
    NodeProcess.once("message", (launch: unknown) => {
      try {
        worker = spawn(NodeProcess.execPath, [entry], {
          detached: true,
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
      } catch {
        return finish();
      }
      worker.once("error", finish);
      worker.once("exit", finish);
      worker.once("message", (acknowledgment: unknown) => {
        worker!.removeListener("exit", finish);
        try {
          if (NodeProcess.send && NodeProcess.connected)
            NodeProcess.send(acknowledgment as never, () => finish());
          else finish();
        } catch {
          finish();
        }
      });
      try {
        worker.send(launch as never, (error) => {
          if (error) finish();
        });
      } catch {
        finish();
      }
    });
    if (!NodeProcess.connected) finish();
  });
}

/**
 * Child-side single-use IPC receiver. Parent loss after receipt does not cancel
 * the execution; its durable journal, not this channel, records the outcome.
 */
export function receiveWatchdogLaunch<A>(decode: (input: unknown) => A): Promise<{
  readonly jobId: string;
  readonly payload: A;
}> {
  return new Promise((resolve, reject) => {
    const disconnect = () => {
      NodeProcess.removeListener("message", message);
      reject(new Error("Watchdog parent disconnected before sending the execution."));
    };
    const message = (raw: unknown) => {
      let launch: typeof Launch.Type;
      let payload: A;
      try {
        launch = decodeLaunch(raw);
        if (!launch.jobId || !launch.nonce) throw new Error("Missing watchdog identity.");
        payload = decode(launch.payload);
      } catch {
        NodeProcess.removeListener("disconnect", disconnect);
        NodeProcess.removeListener("message", message);
        if (NodeProcess.connected) NodeProcess.disconnect();
        reject(new Error("Invalid watchdog launch payload."));
        return;
      }
      NodeProcess.removeListener("disconnect", disconnect);
      NodeProcess.removeListener("message", message);
      const resume = () => {
        if (NodeProcess.connected) NodeProcess.disconnect();
        resolve({ jobId: launch.jobId, payload });
      };
      try {
        if (NodeProcess.send && NodeProcess.connected)
          NodeProcess.send(
            { type: "watchdog.received", version: 1, jobId: launch.jobId, nonce: launch.nonce },
            resume,
          );
        else resume();
      } catch {
        resume();
      }
    };
    NodeProcess.once("disconnect", disconnect);
    NodeProcess.once("message", message);
    if (!NodeProcess.connected) disconnect();
  });
}
