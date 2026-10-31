import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  type OrchestrationCommand,
  type WorkspaceCollaborationRun,
  type WorkspaceTaskRecipeDefinition,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  WorkspaceTaskInboxStore,
  layer as StoreLayer,
} from "../persistence/WorkspaceTaskInboxStore.ts";
import type { ProcessRunInput, ProcessRunner } from "../processRunner.ts";
import { makeWorkspaceTaskInbox } from "./WorkspaceTaskInbox.ts";

const at = "2026-10-15T00:00:00.000Z";
const definition: WorkspaceTaskRecipeDefinition = {
  id: "research",
  name: "조사",
  enabled: true,
  parameters: [{ name: "topic", label: "주제", required: true, defaultValue: "" }],
  taskTemplate: "{{topic}} 자료를 조사하세요.",
  execution: "agent",
  script: "",
  precheck: { kind: "none" },
  artifacts: [],
  verificationCommands: [],
  executionProfile: null,
};
let sequence = 0;
const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const result = (stdout = "", code = 0) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});
const suite = it.layer(
  Layer.mergeAll(StoreLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)), NodeServices.layer),
);
const setup = Effect.fn("TaskInboxTest.setup")(function* (
  options: {
    recipe?: Partial<WorkspaceTaskRecipeDefinition>;
    run?: ProcessRunner["Service"]["run"];
    loseDispatchReply?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped();
  const projectId = ProjectId.make(`inbox-test-${++sequence}`);
  const store = yield* WorkspaceTaskInboxStore;
  const runs = new Map<string, WorkspaceCollaborationRun>();
  const commands: OrchestrationCommand[] = [];
  const processes: ProcessRunInput[] = [];
  const deps = {
    store: {
      ...store,
      pending: store.pending.pipe(
        Effect.map((tasks) => tasks.filter((task) => task.projectId === projectId)),
      ),
    },
    query: {
      getProjectShellById: (requested: ProjectId) =>
        Effect.succeed(
          requested === projectId
            ? Option.some({
                id: projectId,
                title: "Test",
                workspaceRoot: cwd,
                defaultModelSelection: null,
                scripts: [],
                createdAt: at,
                updatedAt: at,
              })
            : Option.none(),
        ),
    },
    engine: {
      streamDomainEvents: Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.gen(function* () {
          commands.push(command);
          if (command.type === "project.collaboration.run.request") {
            runs.set(command.runId, {
              id: command.runId,
              projectId,
              source: "automation",
              scheduleId: null,
              incidentId: null,
              task: command.task,
              status: "running",
              steps: [],
              graph: null,
              meeting: null,
              orchestra: null,
              finalOutput: null,
              error: null,
              createdAt: at,
              updatedAt: at,
            });
            if (options.loseDispatchReply)
              return yield* Effect.die("Reply lost after durable dispatch");
          }
          if (command.type === "project.collaboration.run.cancel") {
            const run = runs.get(command.runId);
            if (run) runs.set(run.id, { ...run, status: "cancelled" });
          }
          return { sequence: commands.length };
        }),
    },
    runs: {
      getById: ({ runId }: { runId: string }) =>
        Effect.succeed(Option.fromNullishOr(runs.get(runId))),
      list: () =>
        Effect.succeed(
          [...runs.values()].filter((run) =>
            ["queued", "running", "cancel-requested"].includes(run.status),
          ),
        ),
    },
    runner: {
      run: (request: ProcessRunInput) => {
        processes.push(request);
        return options.run ? options.run(request) : Effect.succeed(result());
      },
    },
  };
  const inbox = yield* makeWorkspaceTaskInbox(deps);
  const recipe = yield* inbox.saveRecipe({
    projectId,
    recipe: { ...definition, ...options.recipe },
  });
  const submit = (externalId = "event-1", topic = "자료") =>
    inbox.submit({
      projectId,
      recipeId: recipe.id,
      source: "github",
      externalId,
      inputs: { topic },
    });
  return { inbox, store, recipe, projectId, cwd, fs, runs, commands, processes, deps, submit };
});

suite("WorkspaceTaskInbox", (it) => {
  it.effect(
    "stops new deliveries to old recipe revisions when disabled and preserves accepted work",
    () =>
      Effect.gen(function* () {
        const test = yield* setup({ recipe: { execution: "script", script: "node work.cjs" } });
        const accepted = yield* test.submit();
        yield* test.inbox.saveRecipe({
          projectId: test.projectId,
          recipe: { ...test.recipe, enabled: false },
        });
        expect(
          (yield* Effect.exit(
            test.inbox.submit({
              projectId: test.projectId,
              recipeId: test.recipe.id,
              recipeRevision: 1,
              source: "github",
              externalId: "new-event",
              inputs: { topic: "資料" },
            }),
          ))._tag,
        ).toBe("Failure");
        yield* test.inbox.tick;
        expect((yield* test.inbox.get(test.projectId, accepted.id))?.status).toBe("completed");
      }).pipe(Effect.scoped),
  );
  it.effect("publishes typed snapshots for task changes without polling", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      const received = yield* Queue.unbounded<number>();
      yield* test.inbox.subscribe(test.projectId).pipe(
        Stream.runForEach((overview) => Queue.offer(received, overview.totalTasks)),
        Effect.forkChild,
      );
      expect(yield* Queue.take(received)).toBe(0);
      yield* test.submit();
      expect(yield* Queue.take(received)).toBe(1);
    }).pipe(Effect.scoped),
  );
  it.effect("deduplicates concurrent deliveries and preserves the original recipe revision", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      const delivered = yield* Effect.all([test.submit(), test.submit(), test.submit()], {
        concurrency: "unbounded",
      });
      expect(new Set(delivered.map((task) => task.id)).size).toBe(1);
      yield* test.inbox.saveRecipe({
        projectId: test.projectId,
        recipe: { ...definition, taskTemplate: "수정한 양식 {{topic}}" },
      });
      expect((yield* test.submit()).recipe.revision).toBe(1);
      expect((yield* test.inbox.overview(test.projectId)).totalTasks).toBe(1);
      expect((yield* Effect.exit(test.submit("event-1", "다른 입력")))._tag).toBe("Failure");
      expect(
        (yield* Effect.exit(test.inbox.get(ProjectId.make("other-project"), delivered[0]!.id)))
          ._tag,
      ).toBe("Failure");
    }).pipe(Effect.scoped),
  );
  it.effect("validates required inputs and command interpolation before any execution", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      expect((yield* Effect.exit(test.submit("missing", "")))._tag).toBe("Failure");
      expect(
        (yield* Effect.exit(
          test.inbox.saveRecipe({
            projectId: test.projectId,
            recipe: { ...definition, script: "echo {{topic}}" },
          }),
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* Effect.exit(
          test.inbox.saveRecipe({
            projectId: test.projectId,
            recipe: { ...definition, script: "pwsh.exe job.ps1" },
          }),
        ))._tag,
      ).toBe("Failure");
      expect(test.processes).toHaveLength(0);
    }).pipe(Effect.scoped),
  );
  it.effect("skips AI and script work when a successful precheck reports no change", () =>
    Effect.gen(function* () {
      const test = yield* setup({
        recipe: {
          execution: "script",
          script: "node worker.cjs",
          precheck: { kind: "command", command: "node check.cjs" },
        },
        run: () => Effect.succeed(result(stringify({ changed: false }))),
      });
      const task = yield* test.submit();
      yield* test.inbox.tick;
      expect((yield* test.inbox.get(test.projectId, task.id))?.status).toBe("unchanged");
      expect(test.commands).toHaveLength(0);
      expect(test.processes).toHaveLength(1);
      expect((yield* test.inbox.overview(test.projectId)).aiSkipped).toBe(1);
    }).pipe(Effect.scoped),
  );
  it.effect("never treats precheck failure or invalid output as unchanged", () =>
    Effect.gen(function* () {
      for (const output of [
        result("not JSON"),
        result(stringify({ changed: false }), 2),
        { ...result(stringify({ changed: false })), stdoutTruncated: true },
      ]) {
        const test = yield* setup({
          recipe: { precheck: { kind: "command", command: "node check.cjs" } },
          run: () => Effect.succeed(output),
        });
        const task = yield* test.submit();
        yield* test.inbox.tick;
        expect((yield* test.inbox.get(test.projectId, task.id))?.status).toBe("failed");
        expect(test.commands).toHaveLength(0);
      }
    }).pipe(Effect.scoped),
  );
  it.effect("runs scripts without a model and keeps user input out of shell arguments", () =>
    Effect.gen(function* () {
      const test = yield* setup({ recipe: { execution: "script", script: "node worker.cjs" } });
      const task = yield* test.submit("script", "텍스트 & echo injected");
      yield* test.inbox.tick;
      const completed = yield* test.inbox.get(test.projectId, task.id);
      expect(completed?.status).toBe("completed");
      expect(completed?.aiSkipped).toBe(true);
      expect(test.commands).toHaveLength(0);
      expect(test.processes[0]?.args.at(-1)).toBe("node worker.cjs");
      expect(test.processes[0]?.env?.T3_TASK_INPUTS_JSON).toContain("텍스트 & echo injected");
      expect(completed?.receipts[0]?.exitCode).toBe(0);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "keeps a command fingerprint tied to successful results and skips only the accepted revision",
    () =>
      Effect.gen(function* () {
        let workingCode = 3;
        const test = yield* setup({
          recipe: {
            execution: "script",
            script: "node work.cjs",
            precheck: { kind: "command", command: "node check.cjs" },
          },
          run: (request) =>
            Effect.succeed(
              request.args.at(-1) === "node check.cjs"
                ? result(stringify({ changed: true, fingerprint: "revision-a", context: "差分" }))
                : result("work", workingCode),
            ),
        });
        const first = yield* test.submit("first");
        yield* test.inbox.tick;
        expect((yield* test.inbox.get(test.projectId, first.id))?.status).toBe("failed");
        workingCode = 0;
        const second = yield* test.submit("second");
        yield* test.inbox.tick;
        expect((yield* test.inbox.get(test.projectId, second.id))?.status).toBe("completed");
        const third = yield* test.submit("third");
        yield* test.inbox.tick;
        expect((yield* test.inbox.get(test.projectId, third.id))?.status).toBe("unchanged");
        expect(
          test.processes.filter((request) => request.args.at(-1) === "node work.cjs"),
        ).toHaveLength(2);
      }).pipe(Effect.scoped),
  );
  it.effect("does not reuse a completed baseline across different inputs or recipe revisions", () =>
    Effect.gen(function* () {
      const test = yield* setup({
        recipe: {
          execution: "script",
          script: "node work.cjs",
          precheck: { kind: "command", command: "node check.cjs" },
        },
        run: (request) =>
          Effect.succeed(
            request.args.at(-1) === "node check.cjs"
              ? result(stringify({ changed: true, fingerprint: "revision-a" }))
              : result(),
          ),
      });
      yield* test.submit("one", "one");
      yield* test.inbox.tick;
      yield* test.submit("two", "two");
      yield* test.inbox.tick;
      yield* test.inbox.saveRecipe({
        projectId: test.projectId,
        recipe: { ...test.recipe, name: "새 버전" },
      });
      yield* test.submit("three", "one");
      yield* test.inbox.tick;
      expect(
        test.processes.filter((request) => request.args.at(-1) === "node work.cjs"),
      ).toHaveLength(3);
    }).pipe(Effect.scoped),
  );
  it.effect("uses only a successfully completed file fingerprint as the next baseline", () =>
    Effect.gen(function* () {
      const test = yield* setup({
        recipe: {
          execution: "script",
          script: "node worker.cjs",
          precheck: { kind: "files", paths: ["input.txt"] },
        },
      });
      yield* test.fs.writeFileString(`${test.cwd}/input.txt`, "revision one");
      yield* test.submit("first");
      yield* test.inbox.tick;
      const second = yield* test.submit("second");
      yield* test.inbox.tick;
      expect((yield* test.inbox.get(test.projectId, second.id))?.status).toBe("unchanged");
      expect(test.processes).toHaveLength(1);
      yield* test.fs.writeFileString(`${test.cwd}/input.txt`, "revision two");
      yield* test.submit("third");
      yield* test.inbox.tick;
      expect(test.processes).toHaveLength(2);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "dispatches one durable run and does not accept an agent completion as independent verification",
    () =>
      Effect.gen(function* () {
        const test = yield* setup();
        const task = yield* test.submit();
        yield* test.inbox.tick;
        yield* test.inbox.tick;
        const running = yield* test.inbox.get(test.projectId, task.id);
        expect(test.commands).toHaveLength(1);
        const run = test.runs.get(running!.runId!)!;
        test.runs.set(run.id, {
          ...run,
          status: "completed",
          finalOutput: "All done; tests passed",
        });
        yield* test.inbox.tick;
        expect((yield* test.inbox.get(test.projectId, task.id))?.status).toBe("needs-verification");
      }).pipe(Effect.scoped),
  );
  it.effect("rejects stale artifacts even when the agent says the work succeeded", () =>
    Effect.gen(function* () {
      const test = yield* setup({
        recipe: { artifacts: [{ path: "report.json", format: "json", requiredKeys: ["items"] }] },
      });
      yield* test.fs.writeFileString(`${test.cwd}/report.json`, stringify({ items: [] }));
      const task = yield* test.submit();
      yield* test.inbox.tick;
      const running = (yield* test.inbox.get(test.projectId, task.id))!;
      const run = test.runs.get(running.runId!)!;
      test.runs.set(run.id, { ...run, status: "completed" });
      yield* test.inbox.tick;
      const final = yield* test.inbox.get(test.projectId, task.id);
      expect(final?.status).toBe("failed");
      expect(final?.receipts.at(-1)?.output).toContain("실행 전 파일");
    }).pipe(Effect.scoped),
  );
  it.effect("accepts a changed JSON artifact with required fields and retains its hash", () =>
    Effect.gen(function* () {
      const test = yield* setup({
        recipe: { artifacts: [{ path: "report.json", format: "json", requiredKeys: ["items"] }] },
      });
      const task = yield* test.submit();
      yield* test.inbox.tick;
      const running = (yield* test.inbox.get(test.projectId, task.id))!;
      yield* test.fs.writeFileString(`${test.cwd}/report.json`, stringify({ items: ["new"] }));
      const run = test.runs.get(running.runId!)!;
      test.runs.set(run.id, { ...run, status: "completed" });
      yield* test.inbox.tick;
      const final = yield* test.inbox.get(test.projectId, task.id);
      expect(final?.status).toBe("completed");
      expect(final?.receipts.at(-1)?.sha256).toMatch(/^[a-f0-9]{64}$/);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "recovers an uncertain dispatch by matching its existing run rather than launching another",
    () =>
      Effect.gen(function* () {
        const test = yield* setup({ loseDispatchReply: true });
        const task = yield* test.submit();
        yield* test.inbox.tick;
        expect((yield* test.inbox.get(test.projectId, task.id))?.status).toBe("delivery-unknown");
        yield* test.inbox.action({
          projectId: test.projectId,
          taskId: task.id,
          action: "reconcile",
        });
        yield* test.inbox.tick;
        expect(test.commands).toHaveLength(1);
        expect((yield* test.inbox.get(test.projectId, task.id))?.status).toBe("running");
      }).pipe(Effect.scoped),
  );
  it.effect("does not replay script or verification effects after a restart", () =>
    Effect.gen(function* () {
      const test = yield* setup({ recipe: { execution: "script", script: "node worker.cjs" } });
      const task = yield* test.submit();
      yield* test.store.update({ ...task, status: "checking" });
      const restarted = yield* makeWorkspaceTaskInbox(test.deps);
      yield* restarted.start();
      expect((yield* restarted.get(test.projectId, task.id))?.status).toBe("delivery-unknown");
      expect(test.processes).toHaveLength(0);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "holds and releases queued work and cancels during a precheck without dispatching",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const test = yield* setup({
          recipe: { precheck: { kind: "command", command: "node check.cjs" } },
          run: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as(result(stringify({ changed: true }))),
            ),
        });
        const task = yield* test.submit();
        yield* test.inbox.action({ projectId: test.projectId, taskId: task.id, action: "hold" });
        yield* test.inbox.tick;
        expect(test.processes).toHaveLength(0);
        yield* test.inbox.action({ projectId: test.projectId, taskId: task.id, action: "release" });
        const worker = yield* Effect.forkChild(test.inbox.tick);
        yield* Deferred.await(entered);
        yield* test.inbox.action({ projectId: test.projectId, taskId: task.id, action: "cancel" });
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(worker);
        yield* test.inbox.tick;
        expect((yield* test.inbox.get(test.projectId, task.id))?.status).toBe("cancelled");
        expect(test.commands).toHaveLength(0);
      }).pipe(Effect.scoped),
  );
});
