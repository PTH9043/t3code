// @effect-diagnostics nodeBuiltinImport:off - The entry must not load anything before the environment is final.
import * as NodeProcess from "node:process";
import {
  applyWatchdogEnvironment,
  readWatchdogPipeArguments,
  receiveWatchdogPipeLaunch,
} from "./WatchdogPipe.ts";

/**
 * Entry of the detached worker process. A worker started outside the backend's process tree has
 * only a bare start environment, so the backend's environment arrives with the launch and is
 * applied here. The worker body, and with it every module that reads the environment while it
 * loads, is imported only afterwards; keep the static imports of this file to Node built-ins.
 */
const pipe = readWatchdogPipeArguments(NodeProcess.argv.slice(2));
// Without the launch there is nothing to run: the backend gave up on this start, and the state
// directory needed for the worker log is still unknown.
const launch = pipe
  ? await receiveWatchdogPipeLaunch(pipe).catch(() => NodeProcess.exit(1))
  : undefined;
if (launch) applyWatchdogEnvironment(launch.environment);
const { runWatchdogWorkerProcess } = await import("./WatchdogWorkerBody.ts");
await runWatchdogWorkerProcess(launch);
