// @effect-diagnostics nodeBuiltinImport:off - The worker must open its own detached journal.
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import * as NodePath from "node:path";
import NodeProcess from "node:process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WatchdogJournal, type WatchdogWorkerOutcome } from "./WatchdogJournal.ts";
import type { WatchdogPipeLaunch } from "./WatchdogPipe.ts";
import {
  WATCHDOG_SEPARATE_TREE_FLAG,
  receiveWatchdogLaunch,
  relayWatchdogLaunch,
} from "./WatchdogProcess.ts";
import { runWatchdogWithProvider } from "./WatchdogProviderRuntime.ts";
import { WatchdogWorkerPayload, watchdogConfigFromSnapshot } from "./WatchdogWorkerProtocol.ts";

/**
 * The worker has no console and outlives the backend, so this file is the only place its own
 * failures can be read afterwards. Never write the launch payload here: it carries credentials.
 */
function makeWorkerLog(stateDir: string, jobId: string) {
  const directory = NodePath.join(stateDir, "logs");
  return (event: string, error?: unknown) => {
    try {
      mkdirSync(directory, { recursive: true });
      const detail =
        error === undefined
          ? ""
          : ` ${String(error instanceof Error ? (error.stack ?? error.message) : error).slice(0, 4000)}`;
      appendFileSync(
        NodePath.join(directory, "watchdog-worker.log"),
        // @effect-diagnostics-next-line globalDate:off - The detached process records its own wall-clock time.
        `${new Date().toISOString()} pid=${NodeProcess.pid} job=${jobId} ${event}${detail}\n`,
      );
    } catch {
      // Logging must never be the reason the worker stops.
    }
  };
}

const decodePayload = Schema.decodeUnknownSync(WatchdogWorkerPayload);

/** Pipe counterpart of `receiveWatchdogLaunch`: acknowledge only a payload that decodes. */
async function receivePipeLaunch(launch: WatchdogPipeLaunch) {
  const payload = decodePayload(launch.payload);
  await launch.acknowledge();
  return { jobId: launch.jobId, payload };
}

async function runWorker(pipeLaunch?: WatchdogPipeLaunch) {
  const { jobId, payload } = pipeLaunch
    ? await receivePipeLaunch(pipeLaunch)
    : await receiveWatchdogLaunch(decodePayload);
  const log = makeWorkerLog(payload.serverConfig.stateDir, jobId);
  // A stray socket error after the backend goes away must not end a turn whose state lives in
  // the journal. Without these, Node exits at once and nothing records why.
  NodeProcess.on("uncaughtException", (error) => log("uncaughtException", error));
  NodeProcess.on("unhandledRejection", (reason) => log("unhandledRejection", reason));
  log(pipeLaunch ? "started outside the backend process tree" : "started");
  const expectedJournal = NodePath.resolve(
    payload.serverConfig.stateDir,
    "watchdog-journal.sqlite",
  );
  if (NodePath.resolve(payload.journalPath) !== expectedJournal)
    throw new Error("Watchdog journal does not belong to this environment.");
  const journal = new WatchdogJournal(expectedJournal);
  const keys = generateKeyPairSync("ed25519");
  const worker = {
    workerId: randomUUID(),
    pid: NodeProcess.pid,
    attestation: {
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      sign: (message: Uint8Array) => sign(null, message, keys.privateKey),
    },
  };
  try {
    let outcome: WatchdogWorkerOutcome;
    try {
      outcome = await Effect.runPromise(
        runWatchdogWithProvider({
          journal,
          jobId,
          capability: payload.capability,
          providerInstanceId: payload.providerInstanceId,
          instance: payload.instance,
          serverConfig: watchdogConfigFromSnapshot(payload.serverConfig),
          settings: payload.settings,
          execution: payload.execution,
          start: payload.start,
          turn: payload.turn,
          worker,
          ...(payload.mcp ? { mcp: payload.mcp } : {}),
        }),
      );
    } catch (error) {
      outcome = "worker-error";
      NodeProcess.exitCode = 1;
      log("execution failed", error);
    }
    log(`outcome ${outcome}`);
    if (journal.worker(jobId)?.workerId === worker.workerId) {
      // @effect-diagnostics-next-line globalDate:off - Persist the detached process's actual exit time.
      const recordedAt = Date.now();
      try {
        journal.recordWorkerOutcome(
          jobId,
          payload.capability,
          worker.workerId,
          outcome,
          recordedAt,
        );
      } catch (error) {
        // An outcome the journal refuses still has to leave a result, or the job waits forever.
        log(`could not record outcome ${outcome}`, error);
        NodeProcess.exitCode = 1;
        if (!journal.workerOutcome(jobId))
          journal.recordWorkerOutcome(
            jobId,
            payload.capability,
            worker.workerId,
            "worker-error",
            recordedAt,
          );
      }
    }
  } catch (error) {
    log("worker stopped", error);
    throw error;
  } finally {
    journal.close();
  }
}

/**
 * Everything the worker process does once its environment is final. `pipeLaunch` is the launch a
 * worker started outside the backend's process tree already read from its pipe; without it the
 * launch arrives on the inherited IPC channel, directly or through the intermediate process.
 */
export async function runWatchdogWorkerProcess(pipeLaunch?: WatchdogPipeLaunch) {
  if (!pipeLaunch && NodeProcess.argv.includes(WATCHDOG_SEPARATE_TREE_FLAG)) {
    await relayWatchdogLaunch(NodeProcess.argv[1]!);
  } else {
    await runWorker(pipeLaunch);
  }
}
