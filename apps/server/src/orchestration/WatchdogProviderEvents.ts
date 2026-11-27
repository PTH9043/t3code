import {
  ProviderRuntimeEvent,
  type ProviderDriverKind,
  type ProviderExecutionContext,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { WatchdogJournal } from "./WatchdogJournal.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(ProviderRuntimeEvent));

interface WatchdogProviderEventsInput {
  readonly journal: WatchdogJournal;
  readonly jobId: string;
  readonly capability: string;
  readonly sessionId: ThreadId;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly execution: ProviderExecutionContext;
}

/**
 * Event types that may follow a terminal turn without meaning more work ran:
 * usage and metadata updates, session state and configuration notices, and
 * background-task wind-down while the session is being stopped. Claude emits
 * these after `turn.completed`; treating them as late work made finished room
 * turns end as `drain-unknown`.
 */
const BENIGN_LATE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "thread.token-usage.updated",
  "thread.metadata.updated",
  "session.exited",
  "session.configured",
  "session.state.changed",
  "task.progress",
  "task.completed",
]);

/**
 * OpenCode reports the abort caused by our own stop request as a runtime error
 * after the turn finished; it is the drain itself, not further work.
 */
function isStopAbortError(event: ProviderRuntimeEvent): boolean {
  if (event.type !== "runtime.error") return false;
  const detail: unknown = event.payload.detail;
  return (
    typeof detail === "object" &&
    detail !== null &&
    "name" in detail &&
    detail.name === "MessageAbortedError"
  );
}

/** Serially records the selected provider session's canonical events for replay. */
export class WatchdogProviderEvents {
  readonly input: WatchdogProviderEventsInput;
  readonly #seen = new Set<string>();
  readonly #pending = new Set<string>();
  #untrackedRequest = false;
  #unexpectedLateEvent = false;
  #completion: { readonly turnId: string | undefined } | undefined;
  #failedTurnAwaitingCompletion: string | undefined;

  constructor(input: WatchdogProviderEventsInput) {
    this.input = input;
    const job = input.journal.get(input.jobId);
    if (
      job?.executionId !== input.sessionId ||
      job.threadId !== input.execution.ownerThreadId ||
      String(input.execution.executionId) !== input.sessionId
    )
      throw new Error("Watchdog session does not match the recorded execution.");
  }

  get hasUnexpectedLateEvent(): boolean {
    return this.#unexpectedLateEvent;
  }

  /** Returns false for events from another session or provider instance. */
  record(event: ProviderRuntimeEvent): boolean {
    if (
      event.threadId !== this.input.sessionId ||
      event.provider !== this.input.provider ||
      (event.providerInstanceId !== undefined &&
        event.providerInstanceId !== this.input.providerInstanceId) ||
      (event.execution !== undefined &&
        (event.execution.executionId !== this.input.execution.executionId ||
          event.execution.ownerThreadId !== this.input.execution.ownerThreadId ||
          event.execution.runId !== this.input.execution.runId ||
          event.execution.nodeId !== this.input.execution.nodeId ||
          event.execution.attempt !== this.input.execution.attempt))
    )
      return false;
    // Native raw payloads can contain unrelated provider diagnostics or credentials.
    const { raw: _raw, ...rest } = event;
    const canonical = {
      ...rest,
      execution: this.input.execution,
      providerInstanceId: this.input.providerInstanceId,
    };
    const receipt = { id: event.eventId, kind: event.type, payload: encodeEvent(canonical) };
    const current = this.input.journal.get(this.input.jobId)?.state;
    if (current === "completed" || current === "failed" || current === "cancelled") {
      this.input.journal.append(this.input.jobId, this.input.capability, receipt);
      const closesFailedTurn =
        current === "failed" &&
        this.#failedTurnAwaitingCompletion !== undefined &&
        event.type === "turn.completed" &&
        event.turnId === this.#failedTurnAwaitingCompletion &&
        (event.payload.state === "failed" || event.payload.state === "interrupted");
      if (closesFailedTurn) this.#failedTurnAwaitingCompletion = undefined;
      if (
        !this.#seen.has(event.eventId) &&
        !closesFailedTurn &&
        !BENIGN_LATE_EVENT_TYPES.has(event.type) &&
        !isStopAbortError(event)
      )
        this.#unexpectedLateEvent = true;
      this.#seen.add(event.eventId);
      return true;
    }
    if (this.#seen.has(event.eventId)) {
      this.input.journal.append(this.input.jobId, this.input.capability, receipt);
      return true;
    }
    const request = event.requestId;
    if (event.type === "turn.started") this.#completion = undefined;
    if (
      event.type === "user-input.requested" ||
      (event.type === "request.opened" && event.payload.requestType !== "tool_user_input")
    ) {
      if (request) this.#pending.add(request);
      else this.#untrackedRequest = true;
    }
    let resolvedPending = false;
    if ((event.type === "request.resolved" || event.type === "user-input.resolved") && request) {
      resolvedPending = this.#pending.delete(request);
    }
    if (event.type === "turn.completed") {
      if (event.payload.state !== "completed") {
        this.input.journal.finish(this.input.jobId, this.input.capability, "failed", receipt);
        this.#seen.add(event.eventId);
        return true;
      }
      this.#completion = { turnId: event.turnId };
    }
    if (
      (event.type === "runtime.error" ||
        event.type === "session.exited" ||
        event.type === "turn.aborted") &&
      this.input.journal.get(this.input.jobId)?.state !== "cancel-requested"
    ) {
      if (event.type === "runtime.error") this.#failedTurnAwaitingCompletion = event.turnId;
      this.input.journal.finish(this.input.jobId, this.input.capability, "failed", receipt);
      this.#seen.add(event.eventId);
      return true;
    }
    if (
      event.type === "user-input.resolved" &&
      resolvedPending &&
      event.payload.reason &&
      this.#completion !== undefined
    ) {
      this.input.journal.finish(this.input.jobId, this.input.capability, "failed", receipt);
      this.#seen.add(event.eventId);
      return true;
    }
    const resolutionMatchesCompletion =
      event.type !== "user-input.resolved" && event.type !== "request.resolved"
        ? true
        : resolvedPending && event.turnId === this.#completion?.turnId;
    if (
      this.#completion &&
      this.#pending.size === 0 &&
      !this.#untrackedRequest &&
      resolutionMatchesCompletion
    ) {
      this.input.journal.finish(this.input.jobId, this.input.capability, "completed", receipt);
    } else {
      this.input.journal.append(this.input.jobId, this.input.capability, receipt);
    }
    this.#seen.add(event.eventId);
    return true;
  }
}
