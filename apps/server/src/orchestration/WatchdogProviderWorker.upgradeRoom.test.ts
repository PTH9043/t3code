// @effect-diagnostics nodeBuiltinImport:off - The journal is a real SQLite file.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  GeminiSettings,
  ProviderDriverKind,
  ProviderExecutionContext,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { it as effectIt } from "@effect/vitest";
import { afterEach, expect, it } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { writeMockLauncher } from "../provider/acp/mockLauncher.test-support.ts";
import { makeGeminiAdapter } from "../provider/Layers/GeminiAdapter.ts";
import { drainWatchdogProjection, type ProjectionInput } from "./Layers/WatchdogEventProjection.ts";
import { chooseUpgradeRoomContinuity } from "./UpgradeRoomTurns.ts";
import { WATCHDOG_PROJECTION_CONSUMER, WatchdogJournal } from "./WatchdogJournal.ts";
import { canUseLocalWatchdogRelay } from "./WatchdogProviderRuntime.ts";
import {
  handleUpgradeRoomQuestion,
  recordUpgradeRoomResumeCursor,
  resolvePendingUpgradeRoomQuestions,
  runWatchdogProviderWorker,
  UPGRADE_ROOM_AWAY_ANSWER,
  UPGRADE_ROOM_BACKEND_STALE_MS,
} from "./WatchdogProviderWorker.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

const sessionId = ThreadId.make("job-1");

function runningRoomJob(offlineQuestions: "decide" | "wait") {
  const dir = mkdtempSync(NodePath.join(tmpdir(), "t3-room-worker-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const journal = new WatchdogJournal(NodePath.join(dir, "watchdog-journal.sqlite"));
  cleanup.push(() => journal.close());
  journal.create({
    id: "job-1",
    executionId: "job-1",
    threadId: "autousage-upgrade-room",
    capability: "cap",
    context: {
      runId: "upgrade-room",
      nodeId: "turn-1",
      attempt: 1,
      provider: "codex",
      providerInstanceId: "codex",
    },
  });
  journal.claim("job-1", "cap");
  journal.createUpgradeRoomJob({
    jobId: "job-1",
    turnEventId: "event-1",
    turnSequence: 1,
    request: "fix it",
    offlineQuestions,
    continuity: "fresh",
    projection: "{}",
    createdAt: 0,
  });
  return journal;
}

const question = (requestId: string) =>
  ({
    type: "user-input.requested",
    requestId,
    payload: { questions: [{ id: "q1", question: "Which file?" }] },
  }) as unknown as ProviderRuntimeEvent;

it("answers offline questions only when the backend heartbeat is stale and the policy decides", () => {
  const journal = runningRoomJob("decide");
  journal.writeUpgradeRoomBackendHeartbeat(1_000);
  const base = { journal, jobId: "job-1", capability: "cap", sessionId };

  expect(
    handleUpgradeRoomQuestion({
      ...base,
      event: question("r-live"),
      now: 1_000 + UPGRADE_ROOM_BACKEND_STALE_MS,
    }),
  ).toBeUndefined();
  expect(journal.getControl("job-1", "upgrade-room-offline:r-live")).toBeUndefined();

  const now = 1_000 + UPGRADE_ROOM_BACKEND_STALE_MS + 1;
  expect(handleUpgradeRoomQuestion({ ...base, event: question("r-away"), now })).toBe("decided");
  const control = journal.getControl("job-1", "upgrade-room-offline:r-away");
  expect(control?.kind).toBe("user-input");
  expect(control?.payload).toContain(UPGRADE_ROOM_AWAY_ANSWER);
  // The same request handled again never queues a second answer.
  expect(handleUpgradeRoomQuestion({ ...base, event: question("r-away"), now })).toBe("decided");
  expect(journal.listUpgradeRoomQuestions("job-1")).toEqual([
    expect.objectContaining({ requestId: "r-away", handledAs: "decided" }),
  ]);
});

it("leaves offline questions pending when the policy waits", () => {
  const journal = runningRoomJob("wait");
  expect(
    handleUpgradeRoomQuestion({
      journal,
      jobId: "job-1",
      capability: "cap",
      sessionId,
      event: question("r1"),
      now: 5_000,
    }),
  ).toBe("waiting");
  expect(journal.getControl("job-1", "upgrade-room-offline:r1")).toBeUndefined();
  expect(journal.listUpgradeRoomQuestions("job-1")).toEqual([
    expect.objectContaining({ requestId: "r1", handledAs: "waiting" }),
  ]);
});

it("rechecks a pending question once the live backend becomes stale", () => {
  const journal = runningRoomJob("decide");
  journal.writeUpgradeRoomBackendHeartbeat(1_000);
  const base = { journal, jobId: "job-1", capability: "cap", sessionId };
  const pending = new Map([["r-late", question("r-late")]]);
  const staleAt = 1_000 + UPGRADE_ROOM_BACKEND_STALE_MS;
  resolvePendingUpgradeRoomQuestions(pending, { ...base, now: staleAt });
  expect(pending.size).toBe(1);
  expect(journal.getControl("job-1", "upgrade-room-offline:r-late")).toBeUndefined();
  resolvePendingUpgradeRoomQuestions(pending, { ...base, now: staleAt + 1 });
  expect(pending.size).toBe(0);
  expect(journal.getControl("job-1", "upgrade-room-offline:r-late")?.state).toBe("queued");
});

it("records the provider resume cursor before the session stops", async () => {
  const journal = runningRoomJob("decide");
  const adapter = {
    listSessions: () =>
      Effect.succeed([
        { threadId: ThreadId.make("other"), resumeCursor: { thread: "wrong" } },
        { threadId: sessionId, resumeCursor: { thread: "provider-thread-7" } },
      ]),
  } as unknown as Parameters<typeof recordUpgradeRoomResumeCursor>[0]["adapter"];
  await Effect.runPromise(
    recordUpgradeRoomResumeCursor({
      journal,
      jobId: "job-1",
      capability: "cap",
      providerInstanceId: ProviderInstanceId.make("codex"),
      sessionId,
      adapter,
    }),
  );
  expect(journal.latestUpgradeRoomResume()).toEqual({
    jobId: "job-1",
    providerInstanceId: "codex",
    cursor: '{"thread":"provider-thread-7"}',
  });

  const failing = {
    listSessions: () => Effect.die("adapter gone"),
  } as unknown as Parameters<typeof recordUpgradeRoomResumeCursor>[0]["adapter"];
  await Effect.runPromise(
    recordUpgradeRoomResumeCursor({
      journal,
      jobId: "job-1",
      capability: "cap",
      providerInstanceId: ProviderInstanceId.make("codex"),
      sessionId,
      adapter: failing,
    }),
  );
  expect(journal.latestUpgradeRoomResume()?.cursor).toBe('{"thread":"provider-thread-7"}');
});

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const decodeGeminiSettings = Schema.decodeUnknownSync(GeminiSettings);
const decodeInstance = Schema.decodeUnknownSync(ProviderInstanceConfig);

it("enables the local watchdog MCP relay for Antigravity (gemini) instances", () => {
  const gemini = decodeInstance({ driver: "gemini", enabled: true });
  expect(canUseLocalWatchdogRelay(gemini, false)).toBe(true);
  expect(canUseLocalWatchdogRelay(gemini, true)).toBe(true);
});

function runGeminiUpgradeRoomScenario(options: {
  readonly envPrefix?: string;
  readonly promptInput?: string;
  readonly resumeCursor?: unknown;
  readonly existingJournal?: WatchdogJournal;
  readonly jobId?: string;
  readonly cancelAfterStart?: boolean;
}) {
  return Effect.gen(function* () {
    const dir = mkdtempSync(NodePath.join(tmpdir(), "t3-gemini-room-worker-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const journal =
      options.existingJournal ?? new WatchdogJournal(NodePath.join(dir, "watchdog-journal.sqlite"));
    if (!options.existingJournal) cleanup.push(() => journal.close());

    const mock = new URL("../../scripts/acp-mock-agent.ts", import.meta.url);
    const mockUrl = encodeString(mock.href);
    const jobId = options.jobId ?? "upgrade-room-turn-gemini-1";
    const sessionId = ThreadId.make(jobId);
    const provider = ProviderDriverKind.make("gemini");
    const providerInstanceId = ProviderInstanceId.make("gemini");
    const execution = ProviderExecutionContext.make({
      executionId: jobId as ProviderExecutionContext["executionId"],
      ownerThreadId: ThreadId.make("autousage-upgrade-room"),
      runId: "upgrade-room" as ProviderExecutionContext["runId"],
      nodeId: `turn-${jobId}` as ProviderExecutionContext["nodeId"],
      attempt: 1,
    });
    const modelSelection = {
      instanceId: providerInstanceId,
      model: "composer-2",
    };
    journal.create({
      id: jobId,
      executionId: jobId,
      threadId: execution.ownerThreadId,
      capability: "cap",
      context: {
        runId: execution.runId,
        nodeId: execution.nodeId,
        attempt: 1,
        provider,
        providerInstanceId,
      },
      upgradeRoom: {
        turnEventId: `event-${jobId}`,
        turnSequence: 1,
        request: options.promptInput ?? "Antigravity test",
        offlineQuestions: "decide",
        continuity: options.resumeCursor ? "resumed" : "fresh",
        projection: "{}",
        createdAt: 1,
      },
    });

    const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-gemini-wd-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
    );
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* writeMockLauncher(
          NodePath.join(dir, "fake-agy.mjs"),
          `${options.envPrefix ?? ""}\nawait import(${mockUrl});`,
        );
        const adapter = yield* makeGeminiAdapter(decodeGeminiSettings({ binaryPath }), {
          instanceId: providerInstanceId,
        });
        const workerEffect = runWatchdogProviderWorker({
          journal,
          jobId,
          capability: "cap",
          providerInstanceId,
          execution,
          adapter,
          start: {
            threadId: sessionId,
            execution,
            provider,
            providerInstanceId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
            modelSelection,
            ...(options.resumeCursor === undefined ? {} : { resumeCursor: options.resumeCursor }),
          },
          turn: {
            threadId: sessionId,
            input: options.promptInput ?? "Antigravity upgrade room turn",
            modelSelection,
            interactionMode: "default",
          },
        });
        if (!options.cancelAfterStart) {
          return yield* workerEffect;
        }
        const workerFiber = yield* Effect.forkChild(workerEffect);
        while (!journal.read(jobId, 0, 50).some((event) => event.kind === "turn.started")) {
          yield* Effect.sleep("25 millis");
        }
        journal.requestCancel(jobId);
        return yield* Fiber.join(workerFiber);
      }),
    ).pipe(Effect.provide(testLayer));
    return { journal, jobId, execution, modelSelection, provider, providerInstanceId, outcome };
  });
}

effectIt.live(
  "completes, seals, resumes, and projects an Antigravity (gemini) upgrade room turn without errors",
  () =>
    Effect.gen(function* () {
      const first = yield* runGeminiUpgradeRoomScenario({
        envPrefix: 'process.env.T3_ACP_PROMPT_RESPONSE_TEXT="Antigravity detached reply 1";',
        promptInput: "First Antigravity turn",
        jobId: "upgrade-room-turn-gemini-1",
      });
      expect(first.outcome).toBe("completed");
      expect(first.journal.get(first.jobId)?.state).toBe("completed");
      expect(first.journal.isSealed(first.jobId)).toBe(true);
      expect(first.journal.getSubmission(first.jobId)).toBe("accepted");
      const recordedKinds = first.journal.read(first.jobId, 0, 100).map((event) => event.kind);
      expect(recordedKinds).toContain("turn.started");
      expect(recordedKinds).toContain("content.delta");
      expect(recordedKinds).toContain("turn.completed");
      expect(recordedKinds.at(-1)).toBe("session.exited");

      // Saved resume cursor hands continuity over to the next Antigravity turn.
      const latestResume = first.journal.latestUpgradeRoomResume();
      expect(latestResume?.providerInstanceId).toBe("gemini");
      const continuity = chooseUpgradeRoomContinuity(latestResume, "gemini", true);
      expect(continuity.continuity).toBe("resumed");
      expect(continuity.resumeCursor).toMatchObject({
        harness: "antigravity",
        schemaVersion: 2,
        instanceId: "gemini",
      });

      // Project Turn 1 as a normal foreground upgrade-room turn.
      const dispatched: Array<Record<string, unknown>> = [];
      const projection: ProjectionInput = {
        engine: {
          dispatch: (command: Record<string, unknown>) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
        } as never,
        queries: { getThreadRuntimeContext: () => Effect.succeed(Option.none()) } as never,
        journal: first.journal,
        jobId: first.jobId,
        consumer: WATCHDOG_PROJECTION_CONSUMER,
        provider: first.provider,
        providerInstanceId: first.providerInstanceId,
        foregroundTurnId: TurnId.make(`upgrade-room:${first.jobId}`),
        worker: {
          execution: first.execution,
          modelSelection: first.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          prompt: "",
          title: "First Antigravity turn",
          displayName: "composer-2",
          role: "implementer",
          kind: "implementation",
          startedAt: "2026-11-20T00:00:00.000Z",
        },
      };
      let status: string = "open";
      while (status === "open") {
        status = (yield* drainWatchdogProjection(projection)).status;
      }
      expect(status).toBe("finished");
      expect(dispatched).toContainEqual(
        expect.objectContaining({
          type: "thread.message.assistant.delta",
          delta: "Antigravity detached reply 1",
        }),
      );
      expect(dispatched).toContainEqual(
        expect.objectContaining({ type: "thread.message.assistant.complete" }),
      );
      expect(dispatched).not.toContainEqual(
        expect.objectContaining({ activity: expect.objectContaining({ kind: "orchestra.block" }) }),
      );

      // Turn 2 resumes the recorded Antigravity session cursor and completes cleanly.
      const second = yield* runGeminiUpgradeRoomScenario({
        envPrefix: 'process.env.T3_ACP_PROMPT_RESPONSE_TEXT="Antigravity resumed reply 2";',
        promptInput: "Second Antigravity turn",
        resumeCursor: continuity.resumeCursor,
        existingJournal: first.journal,
        jobId: "upgrade-room-turn-gemini-2",
      });
      expect(second.outcome).toBe("completed");
      expect(second.journal.isSealed(second.jobId)).toBe(true);
    }),
);

effectIt.live(
  "seals a failed Antigravity (gemini) prompt cleanly as failed instead of submit-unknown",
  () =>
    Effect.gen(function* () {
      const failed = yield* runGeminiUpgradeRoomScenario({
        envPrefix: 'process.env.T3_ACP_FAIL_PROMPT="1";',
        promptInput: "Fail this prompt",
        jobId: "upgrade-room-turn-gemini-fail",
      });
      expect(failed.outcome).toBe("failed");
      expect(failed.journal.get(failed.jobId)?.state).toBe("failed");
      expect(failed.journal.isSealed(failed.jobId)).toBe(true);
      expect(failed.journal.getSubmission(failed.jobId)).toBe("accepted");
    }),
);

effectIt.live("delivers user cancellation to an active Antigravity (gemini) detached worker", () =>
  Effect.gen(function* () {
    const cancelled = yield* runGeminiUpgradeRoomScenario({
      envPrefix: 'process.env.T3_ACP_HANG_PROMPT_FOREVER="1";',
      promptInput: "Hang until stopped",
      jobId: "upgrade-room-turn-gemini-cancel",
      cancelAfterStart: true,
    });
    expect(cancelled.outcome).toBe("stop-sent");
    expect(cancelled.journal.getStop(cancelled.jobId)?.state).toBe("sent");
  }),
);
