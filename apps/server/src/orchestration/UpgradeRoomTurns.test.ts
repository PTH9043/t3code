// @effect-diagnostics nodeBuiltinImport:off - The journal is a real SQLite file.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";
import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { it as effectIt } from "@effect/vitest";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { drainWatchdogProjection, type ProjectionInput } from "./Layers/WatchdogEventProjection.ts";
import {
  buildUpgradeRoomOfflineSummary,
  chooseUpgradeRoomContinuity,
  decideUpgradeRoomAdmission,
  isDetachedUpgradeRoomThread,
  makeUpgradeRoomTurns,
  upgradeRoomTurnIds,
  type UpgradeRoomTurnsDeps,
} from "./UpgradeRoomTurns.ts";
import { WATCHDOG_PROJECTION_CONSUMER, WatchdogJournal } from "./WatchdogJournal.ts";

const ROOM = "autousage-upgrade-room";
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

function tempJournal() {
  const dir = mkdtempSync(NodePath.join(tmpdir(), "t3-room-turns-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const journal = new WatchdogJournal(NodePath.join(dir, "watchdog-journal.sqlite"));
  cleanup.push(() => journal.close());
  return { dir, journal };
}

type TurnStart = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;
const turnStart = (eventId: string, sequence: number, threadId = ROOM) =>
  ({
    type: "thread.turn-start-requested",
    eventId,
    sequence,
    payload: { threadId, messageId: `message-${eventId}`, createdAt: "2026-11-19T00:00:00.000Z" },
  }) as unknown as TurnStart;

function harness(events: ReadonlyArray<TurnStart>, overrides: Partial<UpgradeRoomTurnsDeps> = {}) {
  const { dir, journal } = tempJournal();
  const dispatched: unknown[] = [];
  const enqueued: OrchestrationEvent[] = [];
  const engine = {
    dispatch: (command: unknown) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
    readEvents: (from: number, limit: number) =>
      Stream.fromIterable(events.filter((event) => event.sequence > from).slice(0, limit)),
  } as unknown as UpgradeRoomTurnsDeps["engine"];
  const turns = makeUpgradeRoomTurns({
    journal,
    engine,
    queries: { getThreadRuntimeContext: () => Effect.succeed(Option.none()) } as never,
    serverConfig: { stateDir: dir } as never,
    enqueue: (event) => Effect.sync(() => void enqueued.push(event)),
    ...overrides,
  });
  return { journal, turns, dispatched, enqueued };
}

it("owns only the primary T3's fixed room and derives one job per turn", () => {
  expect(isDetachedUpgradeRoomThread(undefined, ROOM)).toBe(true);
  expect(isDetachedUpgradeRoomThread({ port: 1 }, ROOM)).toBe(false);
  expect(isDetachedUpgradeRoomThread(undefined, "another-thread")).toBe(false);
  const ids = upgradeRoomTurnIds("event-1");
  expect(upgradeRoomTurnIds("event-1")).toEqual(ids);
  expect(upgradeRoomTurnIds("event-2").jobId).not.toBe(ids.jobId);
  expect(ids.jobId).toMatch(/^upgrade-room-turn-[0-9a-f]{32}$/);
  expect(ids.nodeId).toBe(ids.jobId.replace("upgrade-room-turn-", "turn-"));
});

it("decides admission without ever starting a turn twice", () => {
  const base = { jobExists: false, state: undefined, busy: false, unsettled: 0, olderPending: 0 };
  expect(decideUpgradeRoomAdmission(base)).toBe("start");
  expect(decideUpgradeRoomAdmission({ ...base, jobExists: true })).toBe("duplicate");
  expect(decideUpgradeRoomAdmission({ ...base, state: "dropped" })).toBe("duplicate");
  expect(decideUpgradeRoomAdmission({ ...base, state: "started", busy: true })).toBe("duplicate");
  expect(decideUpgradeRoomAdmission({ ...base, busy: true })).toBe("queued");
  expect(decideUpgradeRoomAdmission({ ...base, unsettled: 1 })).toBe("queued");
  expect(decideUpgradeRoomAdmission({ ...base, olderPending: 1 })).toBe("queued");
});

it("hands the previous cursor over only to the same provider instance", () => {
  const latest = { jobId: "job-1", providerInstanceId: "codex", cursor: '{"thread":"t-1"}' };
  expect(chooseUpgradeRoomContinuity(latest, "codex", true)).toEqual({
    continuity: "resumed",
    resumeCursor: { thread: "t-1" },
    detachedSession: { contextHandoff: false, hasNativeHistory: true },
  });
  expect(chooseUpgradeRoomContinuity(latest, "claude", true)).toMatchObject({
    continuity: "fresh",
    note: "instance-changed",
    detachedSession: { contextHandoff: true, hasNativeHistory: false },
  });
  expect(chooseUpgradeRoomContinuity(undefined, "codex", false)).toMatchObject({
    continuity: "fresh",
    note: "first-turn",
    detachedSession: { contextHandoff: false },
  });
});

it("queues turns while one runs and releases the next once the room is free", async () => {
  const first = turnStart("event-1", 3);
  const second = turnStart("event-2", 5);
  const { journal, turns, enqueued } = harness([first, second]);

  expect(await Effect.runPromise(turns.admit(first))).toBe("start");
  expect(await Effect.runPromise(turns.admit(second))).toBe("queued");
  expect(await Effect.runPromise(turns.admit(first))).toBe("duplicate");
  expect(journal.upgradeRoomTurnState("event-2")).toBe("queued");

  // The first turn failed before its job existed; the queued one is released once.
  await Effect.runPromise(turns.abandon(first));
  expect(enqueued).toEqual([second]);
  expect(turns.takeReleased("event-2")).toBe(true);
  expect(turns.takeReleased("event-2")).toBe(false);
  expect(await Effect.runPromise(turns.admit(second))).toBe("start");
  expect(journal.upgradeRoomTurnState("event-2")).toBe("started");
});

it("launches a detached, full-access worker with the deterministic job and the handed-over cursor", async () => {
  const event = turnStart("event-9", 9);
  const launches: Array<Record<string, unknown>> = [];
  const { journal, turns } = harness([event], {
    launch: ((input: Record<string, unknown>) =>
      Effect.sync(() => {
        launches.push(input);
        return { status: "not-started" as const };
      })) as unknown as NonNullable<UpgradeRoomTurnsDeps["launch"]>,
    entry: "worker.js",
  });
  expect(await Effect.runPromise(turns.admit(event))).toBe("start");
  const continuity = chooseUpgradeRoomContinuity(
    { jobId: "previous", providerInstanceId: "codex", cursor: '{"thread":"t-1"}' },
    "codex",
    true,
  );
  await Effect.runPromise(
    turns.launch({
      event,
      messageText: "\n  Fix the login bug\nmore detail",
      request: {
        input: "Fix the login bug",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        interactionMode: "default",
      } as never,
      cwd: "D:/repo",
      settings: {} as never,
      instance: { driver: "codex" } as never,
      continuity,
    }),
  );
  const { jobId, nodeId } = upgradeRoomTurnIds("event-9");
  expect(launches).toHaveLength(1);
  expect(launches[0]).toMatchObject({
    jobId,
    separateProcessTree: true,
    execution: {
      executionId: jobId,
      ownerThreadId: ROOM,
      runId: "upgrade-room",
      nodeId,
      attempt: 1,
    },
    start: { threadId: jobId, runtimeMode: "full-access", resumeCursor: { thread: "t-1" } },
    turn: { threadId: jobId, input: "Fix the login bug" },
  });
  // A launch that never started frees the turn instead of leaving it to be replayed.
  expect(journal.upgradeRoomTurnState("event-9")).toBe("dropped");
});

it("holds turn admission until a room rewind finishes", async () => {
  const event = turnStart("after-rewind", 9);
  const { journal, turns } = harness([event]);
  const owner = {
    threadId: ROOM,
    runId: "upgrade-room",
    consumer: WATCHDOG_PROJECTION_CONSUMER,
    jobIdForTurn: (id: string) => upgradeRoomTurnIds(id).jobId,
  };
  expect(journal.tryBeginUpgradeRoomRewind(owner)).toBe(true);
  expect(journal.tryBeginUpgradeRoomRewind(owner)).toBe(false);
  const waiting = Effect.runPromise(turns.admit(event));
  expect(journal.upgradeRoomTurnState(event.eventId)).toBeUndefined();
  journal.endUpgradeRoomRewind();
  expect(await waiting).toBe("start");
  expect(journal.tryBeginUpgradeRoomRewind(owner)).toBe(false);
});

effectIt.effect(
  "projects a detached job as one ordinary turn with scoped controls and no orchestra block",
  () =>
    Effect.gen(function* () {
      const event = turnStart("foreground", 10);
      const { turns, dispatched } = harness([event], {
        entry: "worker.js",
        launch: (input) =>
          Effect.gen(function* () {
            const { journal, jobId, execution } = input;
            const capability = "test-capability";
            journal.create({
              id: jobId,
              executionId: jobId,
              threadId: ROOM,
              capability,
              context: { ...execution, provider: "codex", providerInstanceId: "codex" },
              upgradeRoom: input.upgradeRoomJob!,
            });
            yield* input.beforeSpawn ?? Effect.void;
            journal.claim(jobId, capability);
            const write = (id: string, type: string, payload: unknown, requestId?: string) => {
              const receipt = {
                id,
                kind: type,
                payload: encodeReceipt({
                  eventId: id,
                  type,
                  payload,
                  ...(requestId ? { requestId } : {}),
                  provider: "codex",
                  providerInstanceId: "codex",
                  threadId: jobId,
                  turnId: "native-turn",
                  execution,
                  createdAt: event.payload.createdAt,
                }),
              };
              if (type === "turn.completed")
                journal.finish(jobId, capability, "completed", receipt);
              else journal.append(jobId, capability, receipt);
            };
            write("read", "item.completed", {
              itemType: "dynamic_tool_call",
              title: "Read README",
              data: { toolName: "Read" },
            });
            write(
              "question",
              "user-input.requested",
              { questions: [{ id: "q", header: "Question", question: "Which?", options: [] }] },
              "native-question",
            );
            write("answer", "content.delta", { streamKind: "assistant_text", delta: "Answer" });
            write("done", "turn.completed", { state: "completed" });
            journal.seal(jobId, capability);
            return { status: "received" as const, pid: 1 };
          }),
      });
      expect(yield* turns.admit(event)).toBe("start");
      yield* turns.launch({
        event,
        messageText: "Work",
        request: {
          input: "Work",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
        } as never,
        cwd: "D:/repo",
        settings: {} as never,
        instance: { driver: "codex" } as never,
        continuity: chooseUpgradeRoomContinuity(undefined, "codex", false),
      });
      const jobId = upgradeRoomTurnIds(event.eventId).jobId;
      const turnId = `upgrade-room:${jobId}`;
      expect(dispatched).toContainEqual(
        expect.objectContaining({
          type: "thread.session.set",
          turnRequest: {
            messageId: event.payload.messageId,
            requestedAt: event.payload.createdAt,
          },
          session: expect.objectContaining({ activeTurnId: turnId }),
        }),
      );
      expect(dispatched).toContainEqual(
        expect.objectContaining({
          type: "thread.message.assistant.delta",
          turnId,
          delta: "Answer",
        }),
      );
      expect(dispatched).toContainEqual(
        expect.objectContaining({ type: "thread.message.assistant.complete", turnId }),
      );
      expect(dispatched).toContainEqual(
        expect.objectContaining({
          activity: expect.objectContaining({
            kind: "user-input.requested",
            turnId,
            payload: expect.objectContaining({
              requestId: `${jobId}:native-question`,
              providerRequestId: "native-question",
              executionId: jobId,
            }),
          }),
        }),
      );
      const tool = dispatched.find(
        (value) => (value as { activity?: { kind?: string } }).activity?.kind === "tool.completed",
      ) as { activity: { turnId: string; payload: unknown } } | undefined;
      expect(tool?.activity.turnId).toBe(turnId);
      expect(tool?.activity.payload).not.toHaveProperty("executionId");
      expect(tool?.activity.payload).not.toHaveProperty("messageId");
      expect(dispatched).not.toContainEqual(
        expect.objectContaining({ activity: expect.objectContaining({ kind: "orchestra.block" }) }),
      );
    }),
);

const ANTIGRAVITY_LIST_QUESTION = [
  "작업 범위를 정해야 합니다.",
  "",
  "어느 쪽으로 진행할까요?",
  "",
  "- [1] (권장) 서버만 수정: 화면은 그대로 둡니다",
  "- [2] 서버와 화면 모두 수정",
].join("\n");

const roomQuestionJob = (provider: string, finalText: string, nativeQuestion = false) =>
  Effect.gen(function* () {
    const event = turnStart(`question-${provider}-${nativeQuestion}`, 10);
    const { jobId, nodeId } = upgradeRoomTurnIds(event.eventId);
    const turnId = `upgrade-room:${jobId}`;
    const execution = {
      executionId: jobId,
      ownerThreadId: ROOM,
      runId: "upgrade-room",
      nodeId,
      attempt: 1,
    };
    const { turns, dispatched } = harness([event], {
      entry: "worker.js",
      queries: {
        getThreadRuntimeContext: () =>
          Effect.succeed(
            Option.some({
              messages: [
                { id: `orchestra-message:${jobId}:1`, role: "assistant", text: finalText, turnId },
              ],
              activities: nativeQuestion ? [{ kind: "user-input.requested", turnId }] : [],
            }),
          ),
      } as never,
      launch: (input) =>
        Effect.gen(function* () {
          const { journal } = input;
          const capability = "test-capability";
          journal.create({
            id: jobId,
            executionId: jobId,
            threadId: ROOM,
            capability,
            context: { ...execution, provider, providerInstanceId: provider },
            upgradeRoom: input.upgradeRoomJob!,
          });
          yield* input.beforeSpawn ?? Effect.void;
          journal.claim(jobId, capability);
          journal.beginSubmission(jobId, capability);
          journal.settleSubmission(jobId, capability, "accepted");
          journal.finish(jobId, capability, "completed", {
            id: "done",
            kind: "turn.completed",
            payload: encodeReceipt({
              eventId: "done",
              type: "turn.completed",
              payload: { state: "completed" },
              provider,
              providerInstanceId: provider,
              threadId: jobId,
              turnId: "native-turn",
              execution,
              createdAt: event.payload.createdAt,
            }),
          });
          journal.seal(jobId, capability);
          return { status: "received" as const, pid: 1 };
        }),
    });
    expect(yield* turns.admit(event)).toBe("start");
    yield* turns.launch({
      event,
      messageText: "Work",
      request: { input: "Work", modelSelection: { instanceId: provider, model: "m" } } as never,
      cwd: "D:/repo",
      settings: {} as never,
      instance: { driver: provider } as never,
      continuity: chooseUpgradeRoomContinuity(undefined, provider, false),
    });
    const cards = dispatched
      .map(
        (value) =>
          (
            value as {
              activity?: {
                kind?: string;
                turnId?: string;
                payload?: { requestId?: string; questions?: unknown };
              };
            }
          ).activity,
      )
      .filter((activity) => activity?.kind === "user-input.requested");
    return { turnId, cards, dispatched };
  });

effectIt.effect("opens a question card when an Antigravity room answer ends with a question", () =>
  Effect.gen(function* () {
    const { turnId, cards, dispatched } = yield* roomQuestionJob(
      "gemini",
      ANTIGRAVITY_LIST_QUESTION,
    );
    expect(cards).toEqual([
      expect.objectContaining({
        turnId,
        payload: expect.objectContaining({
          requestId: `text-question:${turnId}`,
          questions: [
            expect.objectContaining({
              question: "어느 쪽으로 진행할까요?",
              options: [
                { label: "(권장) 서버만 수정", description: "화면은 그대로 둡니다" },
                { label: "서버와 화면 모두 수정", description: "" },
              ],
            }),
          ],
        }),
      }),
    ]);
    // The card opens before the room is marked ready for the answer.
    const cardIndex = dispatched.findIndex(
      (value) =>
        (value as { activity?: { kind?: string } }).activity?.kind === "user-input.requested",
    );
    const readyIndex = dispatched.findIndex(
      (value) =>
        (value as { type?: string; session?: { status?: string } }).type === "thread.session.set" &&
        (value as { session?: { status?: string } }).session?.status === "ready",
    );
    expect(cardIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeGreaterThan(cardIndex);
  }),
);

effectIt.effect(
  "opens no room card for other providers, plain answers or turns that already asked natively",
  () =>
    Effect.gen(function* () {
      expect((yield* roomQuestionJob("codex", ANTIGRAVITY_LIST_QUESTION)).cards).toEqual([]);
      expect(
        (yield* roomQuestionJob("gemini", "작업을 마쳤습니다. 테스트 12개가 통과했습니다.")).cards,
      ).toEqual([]);
      expect((yield* roomQuestionJob("gemini", ANTIGRAVITY_LIST_QUESTION, true)).cards).toEqual([]);
    }),
);

effectIt.effect(
  "recovers a room blocked by an unsealed terminal worker without replaying its request",
  () =>
    Effect.gen(function* () {
      const interrupted = turnStart("interrupted", 10);
      const first = turnStart("first-waiting", 11);
      const second = turnStart("second-waiting", 12);
      const { journal, turns, enqueued, dispatched } = harness([interrupted, first, second]);
      const { jobId, nodeId } = upgradeRoomTurnIds(interrupted.eventId);
      const execution = {
        executionId: jobId,
        ownerThreadId: ROOM,
        runId: "upgrade-room",
        nodeId,
        attempt: 1,
      };
      journal.create({
        id: jobId,
        executionId: jobId,
        threadId: ROOM,
        capability: "cap",
        context: { ...execution, provider: "opencode", providerInstanceId: "opencode" },
        upgradeRoom: {
          turnEventId: interrupted.eventId,
          turnSequence: interrupted.sequence,
          request: "Interrupted work",
          offlineQuestions: "decide",
          continuity: "fresh",
          createdAt: 0,
          projection: encodeReceipt({
            execution,
            modelSelection: { instanceId: "opencode" },
            turnRequest: {
              messageId: interrupted.payload.messageId,
              requestedAt: interrupted.payload.createdAt,
            },
            startedAt: interrupted.payload.createdAt,
          }),
        },
      });
      journal.claimWithWorker(jobId, "cap", { workerId: "worker", pid: 1, startedAt: 0 });
      journal.recordUpgradeRoomResumeCursor(jobId, "cap", {
        providerInstanceId: "opencode",
        cursor: "{}",
        recordedAt: 0,
      });
      journal.finish(jobId, "cap", "failed", { id: "terminal", kind: "terminal", payload: "{}" });
      journal.acknowledge(jobId, WATCHDOG_PROJECTION_CONSUMER, journal.read(jobId, 0)[0]!.sequence);
      journal.recordWorkerOutcome(jobId, "cap", "worker", "drain-unknown", 1);
      expect(yield* turns.admit(first)).toBe("queued");
      expect(yield* turns.admit(second)).toBe("queued");

      yield* turns.startup();
      // Wait on the release receipt rather than assuming the recovery fiber ran immediately.
      yield* Effect.yieldNow;
      expect(enqueued).toEqual([first]);
      expect(journal.workerOutcome(jobId)?.outcome).toBe("drain-unknown");
      expect(journal.isSealed(jobId)).toBe(false);
      expect(journal.listReconciliationContexts(WATCHDOG_PROJECTION_CONSUMER)).toEqual([]);
      expect(turns.continuity("opencode", true)).toMatchObject({
        continuity: "fresh",
        note: "no-cursor",
      });
      expect(dispatched).toContainEqual(
        expect.objectContaining({ session: expect.objectContaining({ status: "error" }) }),
      );
      expect(() =>
        journal.append(jobId, "cap", { id: "unexpected-late", kind: "test", payload: "{}" }),
      ).toThrow();
      expect(yield* turns.admit(interrupted)).toBe("duplicate");
      expect(yield* turns.admit(first)).toBe("start");
      yield* turns.abandon(first);
      expect(enqueued).toEqual([first, second]);
    }),
);

effectIt.effect("keeps draining when the worker appends and seals between terminal checks", () =>
  Effect.gen(function* () {
    const { journal } = tempJournal();
    const jobId = "seal-race";
    const execution = {
      executionId: jobId,
      ownerThreadId: ROOM,
      runId: "upgrade-room",
      nodeId: "race",
      attempt: 1,
    };
    journal.create({ id: jobId, executionId: jobId, threadId: ROOM, capability: "cap" });
    journal.claim(jobId, "cap");
    const sealed = journal.isSealed.bind(journal);
    vi.spyOn(journal, "isSealed").mockImplementationOnce((id) => {
      journal.finish(id, "cap", "completed", { id: "late-event", kind: "test", payload: "{}" });
      journal.seal(id, "cap");
      return sealed(id);
    });
    const projection = {
      journal,
      jobId,
      consumer: WATCHDOG_PROJECTION_CONSUMER,
      worker: {
        execution,
        modelSelection: { instanceId: "codex", model: "gpt-5" },
      },
      providerInstanceId: "codex",
    } as unknown as ProjectionInput;
    expect(yield* drainWatchdogProjection(projection)).toEqual({ status: "open", applied: 0 });
  }),
);

effectIt.effect(
  "does not report uncertainty when the drained worker seals and records completion concurrently",
  () =>
    Effect.gen(function* () {
      const { journal } = tempJournal();
      const jobId = "outcome-race";
      const execution = {
        executionId: jobId,
        ownerThreadId: ROOM,
        runId: "upgrade-room",
        nodeId: "race",
        attempt: 1,
      };
      journal.create({ id: jobId, executionId: jobId, threadId: ROOM, capability: "cap" });
      journal.claimWithWorker(jobId, "cap", { workerId: "worker", pid: 1, startedAt: 0 });
      journal.finish(jobId, "cap", "completed", { id: "terminal", kind: "test", payload: "{}" });
      journal.acknowledge(jobId, WATCHDOG_PROJECTION_CONSUMER, journal.read(jobId, 0)[0]!.sequence);
      const sealed = journal.isSealed.bind(journal);
      vi.spyOn(journal, "isSealed").mockImplementationOnce((id) => {
        const observed = sealed(id);
        journal.seal(id, "cap");
        journal.recordWorkerOutcome(id, "cap", "worker", "completed", 1);
        return observed;
      });
      const projection = {
        journal,
        jobId,
        consumer: WATCHDOG_PROJECTION_CONSUMER,
        worker: {
          execution,
          modelSelection: { instanceId: "codex", model: "gpt-5" },
        },
        providerInstanceId: "codex",
      } as unknown as ProjectionInput;
      expect(yield* drainWatchdogProjection(projection)).toEqual({ status: "open", applied: 0 });
      expect(journal.workerOutcome(jobId)?.outcome).toBe("completed");
    }),
);

effectIt.effect("reports a delivered stop as a stop, not as a failed job", () =>
  Effect.gen(function* () {
    const { journal } = tempJournal();
    const appended: Array<{ readonly tone: string; readonly summary: string }> = [];
    const drain = (jobId: string, stop: boolean) =>
      Effect.gen(function* () {
        const execution = {
          executionId: jobId,
          ownerThreadId: ROOM,
          runId: "upgrade-room",
          nodeId: jobId,
          attempt: 1,
        };
        journal.create({ id: jobId, executionId: jobId, threadId: ROOM, capability: "cap" });
        journal.claimWithWorker(jobId, "cap", { workerId: "worker", pid: 1, startedAt: 0 });
        if (stop) {
          journal.requestCancel(jobId);
          journal.takeStop(jobId, "cap", "attempt");
          journal.settleStop(jobId, "cap", "attempt", "sent");
        }
        journal.recordWorkerOutcome(jobId, "cap", "worker", "drain-unknown", 1);
        return yield* drainWatchdogProjection({
          engine: {
            dispatch: (command: { activity?: { tone: string; summary: string } }) =>
              Effect.sync(() => {
                if (command.activity) appended.push(command.activity);
              }),
          },
          journal,
          jobId,
          consumer: WATCHDOG_PROJECTION_CONSUMER,
          worker: { execution, modelSelection: { instanceId: "opencode", model: "gpt" } },
          providerInstanceId: "opencode",
          workerExists: () => true,
        } as unknown as ProjectionInput);
      });
    expect(yield* drain("stopped-by-user", true)).toEqual({
      status: "unknown",
      applied: 0,
      outcome: "drain-unknown",
      stopped: true,
    });
    expect(yield* drain("ended-uncertain", false)).toEqual({
      status: "unknown",
      applied: 0,
      outcome: "drain-unknown",
    });
    expect(appended.map((activity) => activity.tone)).toEqual(["info", "error"]);
    expect(appended[0]?.summary).toContain("요청에 따라 작업을 중지했습니다");
  }),
);

effectIt.effect("ends a job whose worker process vanished without a result, and only then", () =>
  Effect.gen(function* () {
    const { journal } = tempJournal();
    const jobId = "vanished-worker";
    const execution = {
      executionId: jobId,
      ownerThreadId: ROOM,
      runId: "upgrade-room",
      nodeId: "vanished",
      attempt: 1,
    };
    journal.create({ id: jobId, executionId: jobId, threadId: ROOM, capability: "cap" });
    journal.claimWithWorker(jobId, "cap", { workerId: "worker", pid: 4242, startedAt: 0 });
    const appended: Array<{ readonly kind: string; readonly summary: string }> = [];
    let exists = true;
    const projection = {
      engine: {
        dispatch: (command: { activity?: { kind: string; summary: string } }) =>
          Effect.sync(() => {
            if (command.activity) appended.push(command.activity);
          }),
      },
      journal,
      jobId,
      consumer: WATCHDOG_PROJECTION_CONSUMER,
      worker: { execution, modelSelection: { instanceId: "opencode", model: "gpt" } },
      providerInstanceId: "opencode",
      workerExists: () => exists,
    } as unknown as ProjectionInput;

    // A quiet but running process, and a process that only just stopped beating, both keep waiting.
    yield* TestClock.adjust("5 minutes");
    expect(yield* drainWatchdogProjection(projection)).toEqual({ status: "open", applied: 0 });
    exists = false;
    journal.heartbeat(jobId, "cap", "worker", 5 * 60_000 - 10_000);
    expect(yield* drainWatchdogProjection(projection)).toEqual({ status: "open", applied: 0 });
    expect(journal.get(jobId)?.state).toBe("running");

    yield* TestClock.adjust("1 minute");
    expect(yield* drainWatchdogProjection(projection)).toEqual({
      status: "unknown",
      applied: 0,
      outcome: "worker-error",
    });
    expect(journal.get(jobId)?.state).toBe("failed");
    expect(appended).toEqual([
      expect.objectContaining({
        kind: "watchdog.uncertain",
        summary: expect.stringContaining("자동으로 다시 실행하지 않습니다"),
      }),
    ]);
  }),
);

it("summarizes only room work that ran or finished while the backend was away", () => {
  const record = (jobId: string, createdAt: number) => ({
    jobId,
    turnEventId: `event-${jobId}`,
    turnSequence: 1,
    request: `request ${jobId}`,
    offlineQuestions: "decide" as const,
    continuity: "fresh" as const,
    projection: "{}",
    createdAt,
  });
  const summary = buildUpgradeRoomOfflineSummary({
    from: 10_000,
    to: 20_000,
    jobs: [
      {
        record: record("old", 1_000),
        state: "completed",
        outcome: { outcome: "completed", recordedAt: 5_000 },
        unsettledAtStartup: false,
        questions: [],
      },
      {
        record: record("done", 9_000),
        state: "completed",
        outcome: { outcome: "completed", recordedAt: 15_000 },
        unsettledAtStartup: true,
        questions: [
          {
            jobId: "done",
            requestId: "r",
            questionId: "q",
            question: "Which?",
            handledAs: "decided",
            recordedAt: 12_000,
          },
        ],
      },
      { record: record("live", 11_000), state: "running", unsettledAtStartup: true, questions: [] },
    ],
  });
  expect(summary.from).toBe("1970-01-01T00:00:10.000Z");
  expect(summary.items.map((item) => [item.jobId, item.status])).toEqual([
    ["done", "completed"],
    ["live", "running"],
  ]);
  expect(summary.items[0]).toMatchObject({
    finishedAt: "1970-01-01T00:00:15.000Z",
    questions: [{ question: "Which?", handledAs: "decided" }],
  });
  expect(summary.items[1]).not.toHaveProperty("finishedAt");
});
