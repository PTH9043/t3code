import {
  ProviderRuntimeEvent,
  type ProviderExecutionContext,
  type ProviderInstanceId,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { WatchdogJournal, WatchdogJournalEvent } from "./WatchdogJournal.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(ProviderRuntimeEvent));

export function decodeWatchdogEvent(
  input: {
    readonly execution: ProviderExecutionContext;
    readonly provider: ProviderDriverKind;
    readonly providerInstanceId: ProviderInstanceId;
  },
  record: WatchdogJournalEvent,
): ProviderRuntimeEvent {
  const event = decodeEvent(record.payload);
  const execution = event.execution;
  if (
    event.eventId !== record.id ||
    event.type !== record.kind ||
    event.threadId !== String(input.execution.executionId) ||
    event.provider !== input.provider ||
    event.providerInstanceId !== input.providerInstanceId ||
    execution === undefined ||
    execution.executionId !== input.execution.executionId ||
    execution.ownerThreadId !== input.execution.ownerThreadId ||
    execution.runId !== input.execution.runId ||
    execution.nodeId !== input.execution.nodeId ||
    execution.attempt !== input.execution.attempt
  )
    throw new Error("Watchdog event does not match its owning execution.");
  return event;
}

/**
 * Apply a bounded page before advancing its durable cursor. The receiver must
 * use the event id as an idempotency key: a crash after application but before
 * acknowledgement can legitimately replay the same event.
 */
export async function replayWatchdogEvents(input: {
  readonly journal: WatchdogJournal;
  readonly jobId: string;
  readonly consumer: string;
  readonly execution: ProviderExecutionContext;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly apply: (event: ProviderRuntimeEvent, sequence: number) => Promise<void>;
  readonly limit?: number;
}): Promise<number> {
  const job = input.journal.get(input.jobId);
  if (
    job?.executionId !== input.execution.executionId ||
    job.threadId !== input.execution.ownerThreadId
  )
    throw new Error("Watchdog replay does not match its owning execution.");
  const cursor = input.journal.cursor(input.jobId, input.consumer);
  const records = input.journal.read(input.jobId, cursor, input.limit);
  for (const record of records) {
    const event = decodeWatchdogEvent(input, record);
    await input.apply(event, record.sequence);
    input.journal.acknowledge(input.jobId, input.consumer, record.sequence);
  }
  return records.length;
}
