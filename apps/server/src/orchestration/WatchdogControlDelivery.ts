import { randomUUID } from "node:crypto";
import {
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ProviderAdapterError } from "../provider/Errors.ts";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import type { WatchdogJournal } from "./WatchdogJournal.ts";

const decodeApproval = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderRespondToRequestInput),
);
const decodeAnswer = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderRespondToUserInputInput),
);

/**
 * Deliver one persisted interactive reply to the exact provider session.
 * A provider error can happen after delivery, so it is recorded as unknown and
 * is not retried automatically. An invalid payload is rejected before sending.
 */
export async function deliverNextWatchdogControl(input: {
  readonly journal: WatchdogJournal;
  readonly jobId: string;
  readonly capability: string;
  readonly sessionId: ThreadId;
  readonly adapter: Pick<
    ProviderAdapterShape<ProviderAdapterError>,
    "respondToRequest" | "respondToUserInput"
  >;
}): Promise<"idle" | "accepted" | "rejected" | "unknown"> {
  if (input.journal.get(input.jobId)?.executionId !== input.sessionId)
    throw new Error("Watchdog session does not match the recorded execution.");
  const attempt = randomUUID();
  const command = input.journal.takeControl(input.jobId, input.capability, attempt);
  if (!command) return "idle";

  let request:
    | { kind: "approval"; value: typeof ProviderRespondToRequestInput.Type }
    | { kind: "user-input"; value: typeof ProviderRespondToUserInputInput.Type };
  try {
    if (command.kind === "approval") {
      const value = decodeApproval(command.payload);
      if (value.threadId !== input.sessionId) throw new Error("Mismatched provider session.");
      request = { kind: "approval", value };
    } else {
      const value = decodeAnswer(command.payload);
      if (value.threadId !== input.sessionId) throw new Error("Mismatched provider session.");
      request = { kind: "user-input", value };
    }
  } catch {
    input.journal.settleControl(input.jobId, input.capability, command.id, attempt, "rejected");
    return "rejected";
  }

  try {
    const send =
      request.kind === "approval"
        ? input.adapter.respondToRequest(
            input.sessionId,
            request.value.requestId,
            request.value.decision,
          )
        : input.adapter.respondToUserInput(
            input.sessionId,
            request.value.requestId,
            request.value.answers,
            request.value.images,
          );
    await Effect.runPromise(send);
  } catch {
    input.journal.settleControl(input.jobId, input.capability, command.id, attempt, "unknown");
    return "unknown";
  }
  input.journal.settleControl(input.jobId, input.capability, command.id, attempt, "accepted");
  return "accepted";
}
