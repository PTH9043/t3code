import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import {
  OrchestrationThread,
  OrchestrationProjectShell,
  DEFAULT_WORKSPACE_CONTROL_SETTINGS,
  ThreadId,
  ProjectId,
  TurnId,
  MessageId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeWorkspaceAutomationRunner } from "./WorkspaceAutomationRunner.ts";

const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeProject = Schema.decodeUnknownEffect(OrchestrationProjectShell);

const at = "2026-10-05T01:00:00.000Z";
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("automation-thread");
const turnId = TurnId.make("automation-turn");
const makeFixture = Effect.fn(function* (
  options: {
    failFormat?: boolean;
    failVerification?: boolean;
    noVerification?: boolean;
    stale?: boolean;
  } = {},
) {
  let thread = yield* decodeThread({
    id: threadId,
    projectId: "project",
    title: "Work",
    modelSelection: { instanceId: "codex", model: "test" },
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    session: null,
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      assistantMessageId: null,
    },
    messages: [
      {
        id: "user",
        role: "user",
        turnId,
        text: "Fix",
        createdAt: at,
        updatedAt: at,
        streaming: false,
      },
      {
        id: "assistant",
        role: "assistant",
        turnId,
        text: "Finished",
        createdAt: at,
        updatedAt: at,
        streaming: false,
      },
    ],
    activities: [],
    checkpoints: [],
  });
  const project = yield* decodeProject({
    id: "project",
    title: "Project",
    workspaceRoot: process.cwd(),
    defaultModelSelection: null,
    scripts: [],
    createdAt: at,
    updatedAt: at,
    workspaceControl: {
      ...DEFAULT_WORKSPACE_CONTROL_SETTINGS,
      completionAutomation: {
        enabled: true,
        formatCommands: ["formatter"],
        verificationCommands: options.noVerification ? [] : ["test-one", "test-two"],
        saveResult: true,
        followUpTask: "Write docs",
      },
    },
  });
  const commands: OrchestrationCommand[] = [];
  const executions: string[] = [];
  const runner = yield* makeWorkspaceAutomationRunner({
    query: {
      getThreadRuntimeContext: () => Effect.succeed(Option.some(thread)),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
    },
    engine: {
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.type === "thread.activity.append")
            thread = { ...thread, activities: [...thread.activities, command.activity] };
          return { sequence: commands.length };
        }),
    },
    runner: {
      run: (input) =>
        Effect.sync(() => {
          const command = input.args.at(-1)!;
          executions.push(command);
          if (options.stale && command === "test-one") thread = { ...thread, latestTurn: null };
          return {
            code: ChildProcessSpawner.ExitCode(
              (command === "formatter" && options.failFormat) ||
                (command === "test-one" && options.failVerification)
                ? 1
                : 0,
            ),
            timedOut: false,
            stdout: `actual ${command}`,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    },
  });
  return {
    runner,
    commands,
    executions,
    getThread: () => thread,
    setFollowup: () => {
      thread = {
        ...thread,
        activities: [],
        messages: [{ ...thread.messages[0]!, id: MessageId.make(`automation-followup:${turnId}`) }],
      };
    },
  };
});

it.effect(
  "formats before the checkpoint boundary, then verifies and gates memory and one follow-up",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const plan = yield* fixture.runner.prepare({
        threadId,
        projectId,
        turnId,
        cwd: process.cwd(),
      });
      expect(plan).not.toBeNull();
      expect(fixture.executions).toEqual(["formatter"]);
      yield* fixture.runner.enqueue(plan!);
      yield* fixture.runner.drain;
      expect(fixture.executions).toEqual(["formatter", "test-one", "test-two"]);
      expect(
        fixture.commands.filter((command) => command.type === "project.knowledge.item.upsert"),
      ).toHaveLength(1);
      expect(
        fixture.commands.filter((command) => command.type === "thread.turn.start"),
      ).toHaveLength(1);
      expect(
        fixture.getThread().activities.find((item) => item.kind === "automation.check")?.payload,
      ).toMatchObject({ exitCode: 0, passed: true, output: "actual formatter" });
      expect(
        yield* fixture.runner.prepare({ threadId, projectId, turnId, cwd: process.cwd() }),
      ).toBeNull();
      fixture.setFollowup();
      expect(
        yield* fixture.runner.prepare({ threadId, projectId, turnId, cwd: process.cwd() }),
      ).toBeNull();
    }).pipe(Effect.scoped),
);

for (const options of [
  { failFormat: true },
  { failVerification: true },
  { noVerification: true },
  { stale: true },
]) {
  it.effect(`holds memory and follow-up when ${JSON.stringify(options)}`, () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(options);
      const plan = yield* fixture.runner.prepare({
        threadId,
        projectId,
        turnId,
        cwd: process.cwd(),
      });
      yield* fixture.runner.enqueue(plan!);
      yield* fixture.runner.drain;
      expect(
        fixture.commands.some(
          (command) =>
            command.type === "project.knowledge.item.upsert" ||
            command.type === "thread.turn.start",
        ),
      ).toBe(false);
      expect(fixture.getThread().activities.at(-1)?.kind).toBe(
        options.stale ? "automation.stale" : "automation.failed",
      );
      if (options.failFormat) expect(fixture.executions).toEqual(["formatter"]);
      if (options.failVerification) expect(fixture.executions).toEqual(["formatter", "test-one"]);
    }).pipe(Effect.scoped),
  );
}
