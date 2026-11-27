import {
  CommandId,
  EventId,
  MessageId,
  WorkspaceKnowledgeItemId,
  resolveCompletionAutomationLimits,
  type WorkspaceAutomationCheck,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Cause from "effect/Cause";
import * as ProcessRunner from "../../processRunner.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  WorkspaceAutomationRunner,
  type WorkspaceAutomationPlan,
} from "../Services/WorkspaceAutomationRunner.ts";

const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

function countConsecutiveAutomationFailures(
  activities: ReadonlyArray<{ readonly kind: string }>,
): number {
  let failures = 0;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const kind = activities[index]?.kind;
    if (kind === "automation.verified") {
      break;
    }
    if (kind === "automation.failed") {
      failures += 1;
    }
  }
  return failures;
}

export const makeWorkspaceAutomationRunner = Effect.fn("WorkspaceAutomationRunner.make")(
  function* (input: {
    engine: Pick<OrchestrationEngineShape, "dispatch">;
    query: Pick<ProjectionSnapshotQueryShape, "getThreadRuntimeContext" | "getProjectShellById">;
    runner: ProcessRunner.ProcessRunner["Service"];
  }) {
    const platform = yield* HostProcessPlatform;
    const activity = Effect.fn("WorkspaceAutomationRunner.activity")(function* (
      plan: Pick<WorkspaceAutomationPlan, "threadId" | "turnId">,
      kind: string,
      summary: string,
      payload: unknown,
      suffix = "",
    ) {
      const createdAt = yield* now;
      yield* input.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`automation:${plan.threadId}:${plan.turnId}:${kind}:${suffix}`),
        threadId: plan.threadId,
        activity: {
          id: EventId.make(`automation:${plan.threadId}:${plan.turnId}:${kind}:${suffix}`),
          kind,
          summary,
          payload,
          tone:
            kind.endsWith("failed") || kind.endsWith("stale") || kind.endsWith("limit_reached")
              ? "error"
              : "info",
          turnId: plan.turnId,
          createdAt,
        },
        createdAt,
      });
    });
    const check = Effect.fn("WorkspaceAutomationRunner.check")(function* (
      plan: WorkspaceAutomationPlan,
      phase: WorkspaceAutomationCheck["phase"],
      command: string,
      index: number,
    ) {
      const limits = resolveCompletionAutomationLimits(plan.config);
      const timeoutSeconds =
        phase === "format"
          ? Math.min(20, limits.commandTimeoutSeconds)
          : limits.commandTimeoutSeconds;
      const startedAt = yield* now;
      const result = yield* input.runner
        .run({
          command: platform === "win32" ? "cmd.exe" : process.env.SHELL || "/bin/sh",
          args: platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command],
          cwd: plan.cwd,
          env: {
            ...process.env,
            T3_AUTOMATION_THREAD_ID: plan.threadId,
            T3_AUTOMATION_TURN_ID: plan.turnId,
          },
          stdin: "",
          timeout: `${timeoutSeconds} seconds`,
          maxOutputBytes: 32_000,
          outputMode: "truncate",
        })
        .pipe(
          Effect.map((result) => {
            const trimmedOutput = `${result.stdout}\n${result.stderr}`.trim().slice(-2000);
            const output =
              result.timedOut && !trimmedOutput
                ? `명령 실행 시간 초과 (${timeoutSeconds}초)`
                : trimmedOutput;
            return {
              exitCode: result.code === null ? null : Number(result.code),
              passed: result.code === 0 && !result.timedOut,
              output,
            };
          }),
          Effect.catch((error) =>
            Effect.succeed({ exitCode: null, passed: false, output: error.message }),
          ),
        );
      const receipt: WorkspaceAutomationCheck = {
        phase,
        command,
        ...result,
        startedAt,
        completedAt: yield* now,
      };
      yield* activity(
        plan,
        "automation.check",
        `${phase === "format" ? "포맷" : "검증"} ${receipt.passed ? "통과" : "실패"} · 종료 코드 ${receipt.exitCode ?? "없음"}`,
        receipt,
        `${phase}:${index}`,
      );
      return receipt;
    });
    const prepare: WorkspaceAutomationRunner["Service"]["prepare"] = (request) =>
      Effect.gen(function* () {
        const project = Option.getOrNull(yield* input.query.getProjectShellById(request.projectId));
        const config = project?.workspaceControl?.completionAutomation;
        if (!config?.enabled) return null;
        const limits = resolveCompletionAutomationLimits(config);
        const thread = Option.getOrNull(
          yield* input.query.getThreadRuntimeContext(request.threadId, {
            messages: true,
            activityKinds: [
              "automation.started",
              "automation.verified",
              "automation.failed",
              "automation.limit_reached",
            ],
          }),
        );
        if (
          !thread ||
          thread.projectId !== request.projectId ||
          thread.orchestraRunThreadId ||
          thread.session?.activeTurnId ||
          thread.latestTurn?.turnId !== request.turnId ||
          thread.latestTurn.state !== "completed"
        )
          return null;
        const firstUser = thread.messages.find(
          (message) => message.turnId === request.turnId && message.role === "user",
        );
        if (firstUser?.id.startsWith("automation-followup:")) return null;
        if (
          thread.activities.some(
            (item) =>
              item.turnId === request.turnId &&
              (item.kind === "automation.started" || item.kind === "automation.limit_reached"),
          )
        )
          return null;
        const priorConsecutiveFailures = countConsecutiveAutomationFailures(thread.activities);
        if (priorConsecutiveFailures >= limits.maxAutoFixAttempts) {
          yield* activity(
            request,
            "automation.limit_reached",
            `최대 자동 보정 한도(${limits.maxAutoFixAttempts}회) 도달로 자동 검증을 중단했습니다`,
            {
              attempts: priorConsecutiveFailures,
              maxAutoFixAttempts: limits.maxAutoFixAttempts,
              commandTimeoutSeconds: limits.commandTimeoutSeconds,
              limitReached: true,
            },
          );
          return null;
        }
        const plan: WorkspaceAutomationPlan = {
          ...request,
          projectId: thread.projectId,
          config,
          formatChecks: [],
        };
        yield* activity(plan, "automation.started", "완료 후 포맷·검증 시작", {
          verificationCommands: config.verificationCommands.length,
          attemptNumber: priorConsecutiveFailures + 1,
          maxAutoFixAttempts: limits.maxAutoFixAttempts,
          commandTimeoutSeconds: limits.commandTimeoutSeconds,
        });
        for (const [index, command] of config.formatCommands.entries()) {
          const receipt = yield* check(plan, "format", command, index);
          plan.formatChecks.push(receipt);
          if (!receipt.passed) break;
        }
        return plan;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not prepare completion automation", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
        ),
      );
    const verify = Effect.fn("WorkspaceAutomationRunner.verify")(function* (
      plan: WorkspaceAutomationPlan,
    ) {
      const limits = resolveCompletionAutomationLimits(plan.config);
      const checks = [...plan.formatChecks];
      if (checks.every((item) => item.passed)) {
        for (const [index, command] of plan.config.verificationCommands.entries()) {
          const receipt = yield* check(plan, "verification", command, index);
          checks.push(receipt);
          if (!receipt.passed) break;
        }
      }
      const passed =
        plan.config.verificationCommands.length > 0 &&
        checks.filter((item) => item.phase === "verification").length ===
          plan.config.verificationCommands.length &&
        checks.every((item) => item.passed);
      const thread = Option.getOrNull(
        yield* input.query.getThreadRuntimeContext(plan.threadId, { messages: true }),
      );
      if (!thread || thread.latestTurn?.turnId !== plan.turnId || thread.session?.activeTurnId) {
        yield* activity(
          plan,
          "automation.stale",
          "작업 상태가 바뀌어 검증 결과 저장·후속 실행 보류",
          { checks },
        );
        return;
      }
      const attemptNumber = countConsecutiveAutomationFailures(thread.activities) + 1;
      const limitReached = !passed && attemptNumber >= limits.maxAutoFixAttempts;
      yield* activity(
        plan,
        passed ? "automation.verified" : "automation.failed",
        passed
          ? "실제 명령 검증 통과"
          : limitReached
            ? `자동 검증 실패 · 최대 자동 보정 한도(${attemptNumber}/${limits.maxAutoFixAttempts}회) 도달로 중단`
            : "자동 검증 실패 · 결과 저장·후속 실행 보류",
        {
          checks,
          attemptNumber,
          maxAutoFixAttempts: limits.maxAutoFixAttempts,
          commandTimeoutSeconds: limits.commandTimeoutSeconds,
          limitReached,
        },
      );
      if (!passed) return;
      const createdAt = yield* now;
      if (plan.config.saveResult) {
        const output = thread.messages
          .filter((message) => message.turnId === plan.turnId && message.role === "assistant")
          .map((message) => message.text)
          .join("\n")
          .slice(-6000);
        yield* input.engine.dispatch({
          type: "project.knowledge.item.upsert",
          commandId: CommandId.make(`automation:${plan.threadId}:${plan.turnId}:memory`),
          projectId: plan.projectId,
          itemId: WorkspaceKnowledgeItemId.make(`verified-${plan.threadId}-${plan.turnId}`),
          kind: "working-memory",
          title: `검증 통과 · ${thread.title}`.slice(0, 180),
          content: [
            `대화: ${plan.threadId}\n작업: ${plan.turnId}`,
            output,
            ...checks.map(
              (item) =>
                `${item.phase}: ${item.command}\n종료 코드: ${item.exitCode}\n${item.output}`,
            ),
          ].join("\n\n"),
          status: "active",
          origin: "agent",
          relativeFolder: null,
          tags: ["verified-automation"],
          provenance: { threadId: plan.threadId },
          createdAt,
        });
      }
      if (plan.config.followUpTask?.trim()) {
        yield* input.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`automation:${plan.threadId}:${plan.turnId}:followup`),
          threadId: plan.threadId,
          message: {
            messageId: MessageId.make(`automation-followup:${plan.turnId}`),
            role: "user",
            text: plan.config.followUpTask,
            attachments: [],
          },
          inputOrigin: "automation",
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt,
        });
      }
    });
    const worker = yield* makeDrainableWorker((plan: WorkspaceAutomationPlan) =>
      verify(plan).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Completion verification failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    );
    return WorkspaceAutomationRunner.of({ prepare, enqueue: worker.enqueue, drain: worker.drain });
  },
);

export const WorkspaceAutomationRunnerLive = Layer.effect(
  WorkspaceAutomationRunner,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const query = yield* ProjectionSnapshotQuery;
    const runner = yield* ProcessRunner.make();
    return yield* makeWorkspaceAutomationRunner({ engine, query, runner });
  }),
);
