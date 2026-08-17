/**
 * SessionRecoveryReactor - one-shot startup sweep that recovers work the
 * previous server process took down with it.
 *
 * Provider CLI sessions are stdio children of the server, so a restart —
 * a rebuild picked up by the dev watcher, an update, a crash — kills them
 * mid-turn. Nothing else corrects the projection afterwards: the session row
 * stays `running` forever and the thread wears a permanent spinner.
 *
 * The sweep does two things per stranded thread:
 *  1. settles the phantom session (`thread.session.stop`), and
 *  2. when a turn was actually in flight, starts a recovery turn that tells
 *     the seat to pick the work back up. The provider session restarts from
 *     its persisted `resumeCursor`, so it returns with the full prior
 *     conversation and can continue rather than start over.
 *
 * Threads owned by a resumable collaboration run are settled but NOT given a
 * recovery turn — the collaboration reactor re-drives those itself, and a
 * second driver would race it.
 *
 * @module SessionRecoveryReactor
 */
import { CommandId, MessageId, type OrchestrationThreadShell } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { forkParked } from "../../serverActivation.ts";
import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  SessionRecoveryReactor,
  type SessionRecoveryReactorShape,
} from "../Services/SessionRecoveryReactor.ts";

const RECOVERY_TURN_TEXT = [
  "[자동 복구] 서버가 재시작되면서 직전 턴이 중단되었습니다.",
  "중단 전까지의 대화와 작업 상태를 직접 확인한 뒤, 끝나지 않은 작업이 있으면 이어서 완료해 주세요.",
  "이미 완료된 작업은 반복하지 말고, 확인 결과와 이어서 한 작업을 정리해 보고해 주세요.",
].join(" ");

const isInterruptedSessionStatus = (status: string): boolean =>
  status === "starting" || status === "running";

export const makeSessionRecoveryReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const runRepository = yield* ProjectionWorkspaceCollaborationRunRepository;
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const done = yield* Deferred.make<void>();

  const recoverThread = Effect.fn("SessionRecoveryReactor.recoverThread")(function* (
    thread: OrchestrationThreadShell,
    startRecoveryTurn: boolean,
  ) {
    // Settle the phantom session first; the provider process behind it died
    // with the previous server. Domain commands process in order, so the
    // recovery turn below always sees the released binding.
    yield* engine.dispatch({
      type: "thread.session.stop",
      commandId: CommandId.make(yield* randomUUID),
      threadId: thread.id,
      createdAt: yield* nowIso,
    });
    if (!startRecoveryTurn) return;

    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(yield* randomUUID),
      threadId: thread.id,
      message: {
        messageId: MessageId.make(yield* randomUUID),
        role: "user",
        text: RECOVERY_TURN_TEXT,
        attachments: [],
      },
      inputOrigin: "automation",
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: yield* nowIso,
    });
    yield* Effect.logInfo("recovered an interrupted turn after restart", {
      threadId: thread.id,
      projectId: thread.projectId,
    });
  });

  const sweep = Effect.gen(function* () {
    const snapshot = yield* snapshotQuery.getShellSnapshot();
    const stranded = snapshot.threads.filter(
      (thread) => thread.session !== null && isInterruptedSessionStatus(thread.session.status),
    );
    if (stranded.length === 0) return;

    // Threads a resumable collaboration run holds get settled only — the
    // collaboration reactor restarts that work itself.
    const resumableRuns = yield* runRepository.listResumable();
    const runOwnedThreadIds = new Set(
      resumableRuns.flatMap((run) => (run.meeting?.threadId ? [run.meeting.threadId] : [])),
    );

    yield* Effect.logInfo("settling sessions stranded by the previous server process", {
      threads: stranded.length,
    });
    for (const thread of stranded) {
      const hadTurnInFlight = thread.session?.activeTurnId != null;
      yield* recoverThread(thread, hadTurnInFlight && !runOwnedThreadIds.has(thread.id)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to recover a stranded thread", {
            threadId: thread.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
  });

  const start: SessionRecoveryReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      sweep.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("session recovery sweep failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.ensuring(Deferred.succeed(done, undefined)),
      ),
    );
  });

  return {
    start,
    drain: Deferred.await(done),
  } satisfies SessionRecoveryReactorShape;
});

export const SessionRecoveryReactorLive = Layer.effect(
  SessionRecoveryReactor,
  makeSessionRecoveryReactor,
);
