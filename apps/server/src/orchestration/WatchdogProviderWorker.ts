import { isDeepStrictEqual } from "node:util";
import {
  ApprovalRequestId,
  ProviderRespondToUserInputInput,
  type ProviderExecutionContext,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ProviderAdapterError } from "../provider/Errors.ts";
import { withFullAccessExecutionPolicy } from "../provider/fullAccessExecutionPolicy.ts";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import { deliverNextWatchdogControl } from "./WatchdogControlDelivery.ts";
import { deliverWatchdogStop } from "./WatchdogStopDelivery.ts";
import { watchdogAttestationMessage, type WatchdogJournal } from "./WatchdogJournal.ts";
import { WatchdogProviderEvents } from "./WatchdogProviderEvents.ts";

export type WatchdogWorkerResult =
  | "completed"
  | "failed"
  | "cancelled"
  | "stop-sent"
  | "stop-unknown"
  | "start-unknown"
  | "submit-unknown"
  | "stream-unknown"
  | "drain-unknown";

/**
 * Runs inside the process that owns the adapter. The caller owns that process
 * and its adapter scope; an unknown result must never cause automatic replay.
 */
export function runWatchdogProviderWorker(input: {
  readonly journal: WatchdogJournal;
  readonly jobId: string;
  readonly capability: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly execution: ProviderExecutionContext;
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly start: ProviderSessionStartInput;
  readonly turn: ProviderSendTurnInput;
  readonly awaitTools?: () => Promise<boolean>;
  readonly drainTimeout?: Duration.Input;
  readonly worker?: {
    readonly workerId: string;
    readonly pid: number;
    readonly attestation?: {
      readonly publicKey: string;
      readonly sign: (message: Uint8Array) => Uint8Array;
    };
  };
}): Effect.Effect<WatchdogWorkerResult> {
  return Effect.scoped(
    Effect.gen(function* () {
      const sessionId = input.start.threadId;
      if (
        sessionId !== input.turn.threadId ||
        sessionId !== String(input.execution.executionId) ||
        input.start.providerInstanceId !== input.providerInstanceId ||
        input.start.modelSelection?.instanceId !== input.providerInstanceId ||
        input.turn.modelSelection?.instanceId !== input.providerInstanceId ||
        !isDeepStrictEqual(input.start.modelSelection, input.turn.modelSelection) ||
        (input.start.execution !== undefined &&
          !isDeepStrictEqual(input.start.execution, input.execution)) ||
        input.start.provider !== input.adapter.provider
      )
        throw new Error("Watchdog provider selection does not match its execution.");
      const recorder = new WatchdogProviderEvents({
        journal: input.journal,
        jobId: input.jobId,
        capability: input.capability,
        sessionId,
        provider: input.adapter.provider,
        providerInstanceId: input.providerInstanceId,
        execution: input.execution,
      });
      const claimed = input.worker
        ? input.journal.claimWithWorker(input.jobId, input.capability, {
            workerId: input.worker.workerId,
            pid: input.worker.pid,
            ...(input.worker.attestation ? { publicKey: input.worker.attestation.publicKey } : {}),
            startedAt: yield* Clock.currentTimeMillis,
          })
        : input.journal.claim(input.jobId, input.capability);
      if (!claimed) {
        if (input.journal.get(input.jobId)?.state === "cancelled") {
          input.journal.seal(input.jobId, input.capability);
          return "cancelled";
        }
        throw new Error("Watchdog execution was already claimed.");
      }
      const done = yield* Deferred.make<WatchdogWorkerResult>();
      const drained = yield* Deferred.make<void>();
      if (input.worker) {
        const workerId = input.worker.workerId;
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.sleep("10 seconds").pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  const timestamp = yield* Clock.currentTimeMillis;
                  if (!input.journal.heartbeat(input.jobId, input.capability, workerId, timestamp))
                    yield* Deferred.succeed(done, "stream-unknown");
                }),
              ),
            ),
          ).pipe(
            Effect.catchCause(() => Deferred.succeed(done, "stream-unknown").pipe(Effect.asVoid)),
          ),
          { startImmediately: true },
        );
      }
      // A restarted backend may challenge the worker while the provider is
      // still starting and discovering its MCP tools. Answer independently of
      // session startup so that discovery cannot deadlock on its own proof.
      if (input.worker?.attestation) {
        const worker = input.worker;
        const attestation = input.worker.attestation;
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              for (const challenge of input.journal.pendingAttestations(
                input.jobId,
                input.capability,
                worker.workerId,
              )) {
                const signature = attestation.sign(
                  watchdogAttestationMessage(
                    input.jobId,
                    worker.workerId,
                    challenge.challengeId,
                    challenge.nonce,
                  ),
                );
                input.journal.respondAttestation(
                  input.jobId,
                  input.capability,
                  worker.workerId,
                  challenge.challengeId,
                  signature,
                );
              }
              yield* Effect.sleep("250 millis");
            }),
          ).pipe(
            Effect.catchCause(() => Deferred.succeed(done, "stream-unknown").pipe(Effect.asVoid)),
          ),
          { startImmediately: true },
        );
      }
      let sessionReady = false;
      let turnStarted = false;
      let stoppingAfterTerminal = false;
      const pendingRoomQuestions = new Map<string, ProviderRuntimeEvent>();
      const roomJob = input.journal.upgradeRoomJob(input.jobId) !== undefined;
      yield* Effect.forkScoped(
        Stream.runForEach(input.adapter.streamEvents, (event) =>
          Effect.sync(() => {
            const current = input.journal.get(input.jobId)?.state;
            if (current === undefined) return undefined;
            if (!recorder.record(event)) return undefined;
            if (event.type === "turn.started") turnStarted = true;
            const state = input.journal.get(input.jobId)?.state;
            const terminal =
              state === "completed" || state === "failed" || state === "cancelled"
                ? state
                : undefined;
            return {
              terminal,
              drained:
                stoppingAfterTerminal && terminal !== undefined && event.type === "session.exited",
            };
          }).pipe(
            Effect.flatMap((result) =>
              result
                ? Effect.gen(function* () {
                    if (roomJob && event.requestId !== undefined) {
                      if (event.type === "user-input.requested" && result.terminal === undefined)
                        pendingRoomQuestions.set(event.requestId, event);
                      else if (event.type === "user-input.resolved")
                        pendingRoomQuestions.delete(event.requestId);
                    }
                    if (result.drained) yield* Deferred.succeed(drained, undefined);
                    if (result.terminal) yield* Deferred.succeed(done, result.terminal);
                  })
                : Effect.void,
            ),
          ),
        ).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (stoppingAfterTerminal && Exit.isSuccess(exit))
                yield* Deferred.succeed(drained, undefined);
              yield* Deferred.succeed(done, "stream-unknown");
            }),
          ),
          Effect.catchCause(() => Deferred.succeed(done, "stream-unknown").pipe(Effect.asVoid)),
        ),
        { startImmediately: true },
      );
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            if (input.journal.get(input.jobId)?.state === "cancel-requested") {
              if (!sessionReady) {
                yield* Deferred.succeed(done, "stop-unknown");
              } else {
                const stop = yield* Effect.promise(() =>
                  deliverWatchdogStop({
                    journal: input.journal,
                    jobId: input.jobId,
                    capability: input.capability,
                    sessionId,
                    adapter: input.adapter,
                  }),
                );
                if (stop === "stop-sent" || stop === "unknown")
                  yield* Deferred.succeed(done, stop === "unknown" ? "stop-unknown" : "stop-sent");
              }
            }
            yield* Effect.sleep("250 millis");
          }),
        ).pipe(
          Effect.catchCause(() => Deferred.succeed(done, "stream-unknown").pipe(Effect.asVoid)),
        ),
        { startImmediately: true },
      );
      const work = Effect.gen(function* () {
        const started = yield* Effect.raceFirst(
          input.adapter.startSession(input.start).pipe(Effect.result),
          Deferred.await(done).pipe(
            Effect.map((result) => ({ _tag: "terminal" as const, result })),
          ),
        );
        if (started._tag === "terminal") return started.result;
        if (started._tag === "Failure") return "start-unknown";
        sessionReady = true;

        if (input.awaitTools) {
          const available = yield* Effect.raceFirst(
            Effect.promise(input.awaitTools).pipe(
              Effect.timeoutOption("120 seconds"),
              Effect.map((result) => ({
                _tag: "ready" as const,
                value: Option.getOrElse(result, () => false),
              })),
            ),
            Deferred.await(done).pipe(
              Effect.map((result) => ({ _tag: "terminal" as const, result })),
            ),
          );
          if (available._tag === "terminal") return available.result;
          if (!available.value) return "start-unknown";
        }

        // The persisted state is checked before every delivery; an in-flight reply
        // with an unknown outcome blocks later replies instead of being resent.
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              if (input.journal.get(input.jobId)?.state === "running") {
                if (pendingRoomQuestions.size > 0) {
                  const now = yield* Clock.currentTimeMillis;
                  resolvePendingUpgradeRoomQuestions(pendingRoomQuestions, {
                    journal: input.journal,
                    jobId: input.jobId,
                    capability: input.capability,
                    sessionId,
                    now,
                  });
                }
                yield* Effect.promise(() =>
                  deliverNextWatchdogControl({
                    journal: input.journal,
                    jobId: input.jobId,
                    capability: input.capability,
                    sessionId,
                    adapter: input.adapter,
                  }),
                );
              }
              yield* Effect.sleep("250 millis");
            }),
          ).pipe(
            Effect.catchCause(() => Deferred.succeed(done, "stream-unknown").pipe(Effect.asVoid)),
          ),
          { startImmediately: true },
        );
        if (!input.journal.beginSubmission(input.jobId, input.capability)) {
          if (input.journal.get(input.jobId)?.state === "cancel-requested")
            return yield* Deferred.await(done);
          return "submit-unknown";
        }
        const submitted = yield* Effect.raceFirst(
          input.adapter
            .sendTurn({
              ...input.turn,
              input: withFullAccessExecutionPolicy(
                input.turn.input ?? "",
                input.start.runtimeMode,
                input.turn.interactionMode,
              ),
            })
            .pipe(Effect.result),
          Deferred.await(done).pipe(
            Effect.map((result) => ({ _tag: "terminal" as const, result })),
          ),
        );
        const isTurnTerminal = (outcome: WatchdogWorkerResult) =>
          outcome === "completed" || outcome === "failed" || outcome === "cancelled";
        const settleAcceptedIfSending = (outcome: WatchdogWorkerResult) => {
          if (isTurnTerminal(outcome) && input.journal.getSubmission(input.jobId) === "sending")
            input.journal.settleSubmission(input.jobId, input.capability, "accepted");
        };
        if (submitted._tag === "terminal") {
          settleAcceptedIfSending(submitted.result);
          return submitted.result;
        }
        if (submitted._tag === "Failure") {
          // Synchronous-turn adapters (e.g. ACP/Antigravity) keep sendTurn open
          // until the prompt finishes and emit turn.completed(failed) before
          // rejecting. Check for that terminal event before reporting submit-unknown.
          const polled = yield* Deferred.poll(done);
          if (Option.isSome(polled)) {
            const outcome = yield* polled.value;
            settleAcceptedIfSending(outcome);
            return outcome;
          }
          if (turnStarted) {
            const terminal = yield* Deferred.await(done).pipe(Effect.timeoutOption("2 seconds"));
            if (Option.isSome(terminal)) {
              settleAcceptedIfSending(terminal.value);
              return terminal.value;
            }
          }
          input.journal.settleSubmission(input.jobId, input.capability, "unknown");
          return "submit-unknown";
        }
        input.journal.settleSubmission(input.jobId, input.capability, "accepted");
        return yield* Deferred.await(done);
      });
      const result = yield* work;
      if (
        roomJob &&
        input.journal.isSealed(input.jobId) &&
        input.journal.get(input.jobId)?.state === "cancelled"
      )
        return "cancelled";
      if (result !== "completed" && result !== "failed" && result !== "cancelled") return result;
      // A cancellation before any session starts has no stream to drain.
      if (!sessionReady) return result;
      yield* recordUpgradeRoomResumeCursor({
        journal: input.journal,
        jobId: input.jobId,
        capability: input.capability,
        providerInstanceId: input.providerInstanceId,
        sessionId,
        adapter: input.adapter,
      });
      stoppingAfterTerminal = true;
      const stopped = yield* input.adapter
        .stopSession(sessionId)
        .pipe(Effect.timeoutOption(input.drainTimeout ?? "10 seconds"), Effect.result);
      if (stopped._tag === "Failure" || Option.isNone(stopped.success)) return "drain-unknown";
      if (input.adapter.capabilities.stopSessionDrainsEvents !== true) return "drain-unknown";
      const barrier = yield* Deferred.await(drained).pipe(
        Effect.timeoutOption(input.drainTimeout ?? "10 seconds"),
      );
      if (Option.isNone(barrier)) return "drain-unknown";
      if (recorder.hasUnexpectedLateEvent) return "drain-unknown";
      input.journal.seal(input.jobId, input.capability);
      return result;
    }),
  );
}

/** The backend writes its heartbeat about every 10 seconds. */
export const UPGRADE_ROOM_BACKEND_STALE_MS = 30_000;
export const UPGRADE_ROOM_AWAY_ANSWER =
  "사용자가 지금 자리에 없어 답할 수 없습니다. 작업 범위 안에서 스스로 합리적으로 판단해 진행하고, 무엇을 왜 선택했는지 최종 보고에 적어 주세요.";

/** Questions seen just before or after shutdown are reconsidered until resolved. */
export function resolvePendingUpgradeRoomQuestions(
  pending: Map<string, ProviderRuntimeEvent>,
  input: Omit<Parameters<typeof handleUpgradeRoomQuestion>[0], "event">,
): void {
  for (const [id, event] of pending) {
    if (handleUpgradeRoomQuestion({ ...input, event }) !== undefined) pending.delete(id);
  }
}

/**
 * Applies the upgrade room's offline-question policy while the backend is away.
 * The answer goes through the journal's control queue so delivery is recorded
 * once and never repeated. Returns undefined when the policy does not apply.
 */
export function handleUpgradeRoomQuestion(input: {
  readonly journal: WatchdogJournal;
  readonly jobId: string;
  readonly capability: string;
  readonly sessionId: ThreadId;
  readonly event: ProviderRuntimeEvent;
  readonly now: number;
}): "decided" | "waiting" | undefined {
  const { event } = input;
  if (event.type !== "user-input.requested" || event.requestId === undefined) return undefined;
  try {
    const room = input.journal.upgradeRoomJob(input.jobId);
    if (!room) return undefined;
    const heartbeat = input.journal.upgradeRoomBackendHeartbeat();
    if (heartbeat !== undefined && input.now - heartbeat <= UPGRADE_ROOM_BACKEND_STALE_MS)
      return undefined;
    const handledAs = room.offlineQuestions === "wait" ? "waiting" : "decided";
    const requestId = String(event.requestId);
    if (handledAs === "decided") {
      const payload = encodeUserInputAnswer({
        threadId: input.sessionId,
        requestId: ApprovalRequestId.make(requestId),
        answers: Object.fromEntries(
          event.payload.questions.map((question) => [question.id, UPGRADE_ROOM_AWAY_ANSWER]),
        ),
      });
      input.journal.enqueueControl(input.jobId, {
        id: `upgrade-room-offline:${requestId}`,
        kind: "user-input",
        payload,
      });
    }
    for (const question of event.payload.questions)
      input.journal.recordUpgradeRoomQuestion(input.jobId, input.capability, {
        requestId,
        questionId: question.id,
        question: question.question,
        handledAs,
        recordedAt: input.now,
      });
    return handledAs;
  } catch {
    // The question stays visible and answerable; a policy failure must not end the stream.
    return undefined;
  }
}

/** Keeps the provider conversation for the next room turn; failure only means a fresh start. */
export const recordUpgradeRoomResumeCursor = (input: {
  readonly journal: WatchdogJournal;
  readonly jobId: string;
  readonly capability: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly sessionId: ThreadId;
  readonly adapter: Pick<ProviderAdapterShape<ProviderAdapterError>, "listSessions">;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!input.journal.upgradeRoomJob(input.jobId)) return;
    const sessions = yield* input.adapter.listSessions();
    const cursor = sessions.find((session) => session.threadId === input.sessionId)?.resumeCursor;
    if (cursor === undefined || cursor === null) return;
    const recordedAt = yield* Clock.currentTimeMillis;
    yield* Effect.sync(() =>
      input.journal.recordUpgradeRoomResumeCursor(input.jobId, input.capability, {
        providerInstanceId: input.providerInstanceId,
        cursor: encodeCursor(cursor),
        recordedAt,
      }),
    );
  }).pipe(
    Effect.timeoutOption("5 seconds"),
    Effect.asVoid,
    Effect.catchCause(() => Effect.void),
  );

const encodeCursor = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeUserInputAnswer = Schema.encodeSync(
  Schema.fromJsonString(ProviderRespondToUserInputInput),
);
