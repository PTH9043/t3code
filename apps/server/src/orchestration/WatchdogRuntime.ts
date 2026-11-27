// @effect-diagnostics nodeBuiltinImport:off - The journal is shared with the detached worker.
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { WatchdogJournal } from "./WatchdogJournal.ts";
import type { executeDetachedWatchdog } from "./WatchdogExecutor.ts";

/** Only explicit cancellation/deletion calls this; server shutdown leaves the child running. */
export function cancelWatchdogsForRun(
  journal: WatchdogJournal,
  threadId: string,
  runId: string,
): number {
  const jobs = journal.listActiveForRun(threadId, runId);
  for (const job of jobs) journal.requestCancel(job.id);
  return jobs.length;
}

export class WatchdogRuntime extends Context.Service<
  WatchdogRuntime,
  { readonly journal: WatchdogJournal; readonly execute?: typeof executeDetachedWatchdog }
>()("t3/orchestration/WatchdogRuntime") {}

export const layer = Layer.effect(
  WatchdogRuntime,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const journal = yield* Effect.acquireRelease(
      Effect.sync(
        () => new WatchdogJournal(NodePath.resolve(config.stateDir, "watchdog-journal.sqlite")),
      ),
      (value) => Effect.sync(() => value.close()),
    );
    return WatchdogRuntime.of({ journal });
  }),
);
