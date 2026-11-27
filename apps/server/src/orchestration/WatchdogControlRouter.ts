import {
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { WatchdogJournal } from "./WatchdogJournal.ts";

type Approval = typeof ProviderRespondToRequestInput.Type;
type UserInput = typeof ProviderRespondToUserInputInput.Type;

/** Queue only against this conversation's matching execution, without claiming delivery. */
export function queueWatchdogControl(input: {
  readonly journal: WatchdogJournal;
  readonly ownerThreadId: ThreadId;
  readonly commandId: string;
  readonly control:
    | { readonly kind: "approval"; readonly value: Approval }
    | { readonly kind: "user-input"; readonly value: UserInput };
}): "not-watchdog" | "queued" | "unavailable" {
  const job = input.journal.getByExecution(input.ownerThreadId, input.control.value.threadId);
  if (!job) return "not-watchdog";
  if (job.state !== "running" || input.journal.workerOutcome(job.id)) return "unavailable";
  const payload =
    input.control.kind === "approval"
      ? Schema.encodeSync(Schema.fromJsonString(ProviderRespondToRequestInput))(input.control.value)
      : Schema.encodeSync(Schema.fromJsonString(ProviderRespondToUserInputInput))(
          input.control.value,
        );
  // The offline policy and a returning user must not deliver two answers to one question.
  const id =
    input.control.kind === "user-input" && input.journal.upgradeRoomJob(job.id)
      ? `upgrade-room-offline:${input.control.value.requestId}`
      : input.commandId;
  input.journal.enqueueControl(job.id, { id, kind: input.control.kind, payload });
  return "queued";
}
