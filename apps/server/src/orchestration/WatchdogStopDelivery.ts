import { randomUUID } from "node:crypto";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ProviderAdapterError } from "../provider/Errors.ts";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import type { WatchdogJournal } from "./WatchdogJournal.ts";

/** A failed or interrupted provider stop remains uncertain and is never retried automatically. */
export async function deliverWatchdogStop(input: {
  readonly journal: WatchdogJournal;
  readonly jobId: string;
  readonly capability: string;
  readonly sessionId: ThreadId;
  readonly adapter: Pick<ProviderAdapterShape<ProviderAdapterError>, "stopSession">;
}): Promise<"idle" | "stop-sent" | "already-finished" | "unknown"> {
  if (input.journal.get(input.jobId)?.executionId !== input.sessionId)
    throw new Error("Watchdog session does not match the recorded execution.");
  const attempt = randomUUID();
  if (!input.journal.takeStop(input.jobId, input.capability, attempt)) return "idle";
  try {
    await Effect.runPromise(input.adapter.stopSession(input.sessionId));
  } catch {
    input.journal.settleStop(input.jobId, input.capability, attempt, "unknown");
    return "unknown";
  }
  input.journal.settleStop(input.jobId, input.capability, attempt, "sent");
  const state = input.journal.get(input.jobId)?.state;
  if (state === "completed" || state === "failed" || state === "cancelled")
    return "already-finished";
  // Several adapters perform only a best-effort remote abort. Returning from
  // stopSession is not proof that a remote operation has actually stopped.
  return "stop-sent";
}
