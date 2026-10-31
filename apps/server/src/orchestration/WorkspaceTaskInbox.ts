import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskInboxError,
  type ProjectId,
  type WorkspaceInboxTask,
  type WorkspaceInboxTaskStatus,
  type WorkspaceTaskInboxOverview,
  type WorkspaceTaskRecipe,
  type WorkspaceTaskRecipeSave,
  type WorkspaceTaskSubmit,
  type WorkspaceTaskAction,
  type WorkspaceTaskReceipt,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { executionProfileTask } from "@t3tools/shared/executionProfile";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import { WorkspaceTaskInboxStore } from "../persistence/WorkspaceTaskInboxStore.ts";
import { ProjectionWorkspaceCollaborationRunRepository } from "../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import * as ProcessRunner from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./Services/ProjectionSnapshotQuery.ts";
import {
  canonicalTaskInputs,
  renderTaskTemplate,
  resolveTaskInputs,
  taskHash,
  taskInputHash,
  taskInstructions,
  validateTaskRecipe,
} from "./workspaceTaskRecipe.ts";
import { makeWorkspaceTaskChecks } from "./workspaceTaskChecks.ts";

const isInboxError = Schema.is(WorkspaceTaskInboxError);
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const failure = (cause: unknown) =>
  isInboxError(cause)
    ? cause
    : new WorkspaceTaskInboxError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
const terminal = new Set<WorkspaceInboxTaskStatus>([
  "completed",
  "unchanged",
  "needs-verification",
  "failed",
  "cancelled",
  "delivery-unknown",
]);
const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const PrecheckOutput = Schema.fromJsonString(
  Schema.Struct({
    changed: Schema.Boolean,
    context: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
    fingerprint: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  }),
);
const decodePrecheckOutput = Schema.decodeUnknownEffect(PrecheckOutput);
const summary = (task: WorkspaceInboxTask) => {
  const { id, source, externalId, status, attempt, runId, error, aiSkipped, createdAt, updatedAt } =
    task;
  return {
    id,
    source,
    externalId,
    status,
    attempt,
    runId,
    error,
    aiSkipped,
    createdAt,
    updatedAt,
    recipeId: task.recipe.id,
    recipeName: task.recipe.name,
    recipeRevision: task.recipe.revision,
  };
};

export class WorkspaceTaskInbox extends Context.Service<
  WorkspaceTaskInbox,
  {
    readonly subscribe: (
      projectId: ProjectId,
    ) => Stream.Stream<WorkspaceTaskInboxOverview, WorkspaceTaskInboxError>;
    readonly overview: (
      projectId: ProjectId,
    ) => Effect.Effect<WorkspaceTaskInboxOverview, WorkspaceTaskInboxError>;
    readonly get: (
      projectId: ProjectId,
      taskId: string,
    ) => Effect.Effect<WorkspaceInboxTask | null, WorkspaceTaskInboxError>;
    readonly saveRecipe: (
      input: WorkspaceTaskRecipeSave,
    ) => Effect.Effect<WorkspaceTaskRecipe, WorkspaceTaskInboxError>;
    readonly submit: (
      input: WorkspaceTaskSubmit,
    ) => Effect.Effect<WorkspaceInboxTask, WorkspaceTaskInboxError>;
    readonly action: (
      input: WorkspaceTaskAction,
    ) => Effect.Effect<WorkspaceInboxTask, WorkspaceTaskInboxError>;
    readonly hasPendingSource: WorkspaceTaskInboxStore["Service"]["hasPendingSource"];
    readonly start: () => Effect.Effect<void>;
    readonly tick: Effect.Effect<void, WorkspaceTaskInboxError>;
  }
>()("t3/orchestration/WorkspaceTaskInbox") {}

export const makeWorkspaceTaskInbox = Effect.fn("WorkspaceTaskInbox.make")(function* (input: {
  store: WorkspaceTaskInboxStore["Service"];
  engine: Pick<OrchestrationEngineShape, "dispatch" | "streamDomainEvents">;
  query: Pick<ProjectionSnapshotQueryShape, "getProjectShellById">;
  runs: Pick<ProjectionWorkspaceCollaborationRunRepository["Service"], "getById" | "list">;
  runner: ProcessRunner.ProcessRunner["Service"];
}) {
  const platform = yield* HostProcessPlatform;
  const scope = yield* Effect.scope;
  const { readTaskFile, checkTaskArtifact } = yield* makeWorkspaceTaskChecks;
  const lock = yield* Semaphore.make(1);
  const tickLock = yield* Semaphore.make(1);
  const changed = yield* PubSub.unbounded<ProjectId>();
  const { store } = input;
  const requireProject = Effect.fn("TaskInbox.project")(function* (projectId: ProjectId) {
    const project = Option.getOrNull(yield* input.query.getProjectShellById(projectId));
    if (!project)
      return yield* new WorkspaceTaskInboxError({ message: "활성 프로젝트를 찾을 수 없습니다." });
    return project;
  }, Effect.mapError(failure));
  const overview = Effect.fn("TaskInbox.overview")(function* (projectId: ProjectId) {
    yield* requireProject(projectId);
    return {
      recipes: yield* store.recipes(projectId),
      tasks: (yield* store.list(projectId)).map(summary),
      ...(yield* store.counts(projectId)),
    };
  });
  const get = Effect.fn("TaskInbox.get")(function* (projectId: ProjectId, taskId: string) {
    yield* requireProject(projectId);
    return yield* store.get(projectId, taskId);
  });
  const saveRecipe = Effect.fn("TaskInbox.saveRecipe")(function* (
    request: WorkspaceTaskRecipeSave,
  ) {
    yield* requireProject(request.projectId);
    const normalized = {
      ...request.recipe,
      verificationCommands: [
        ...new Set([
          ...request.recipe.verificationCommands,
          ...(request.recipe.executionProfile?.verificationCommands ?? []),
        ]),
      ],
    };
    if (normalized.verificationCommands.length > 8)
      return yield* new WorkspaceTaskInboxError({
        message: "프로필을 포함한 검증 명령은 최대 8개입니다.",
      });
    yield* Effect.try({ try: () => validateTaskRecipe(normalized), catch: failure });
    const recipes = yield* store.recipes(request.projectId);
    if (recipes.length >= 100 && !recipes.some((item) => item.id === request.recipe.id))
      return yield* new WorkspaceTaskInboxError({
        message: "프로젝트마다 업무 양식은 최대 100개까지 저장할 수 있습니다.",
      });
    const saved = yield* store.saveRecipe(request.projectId, normalized, yield* now);
    yield* PubSub.publish(changed, request.projectId);
    return saved;
  });
  const submit = Effect.fn("TaskInbox.submit")((request: WorkspaceTaskSubmit) =>
    lock.withPermit(
      Effect.gen(function* () {
        yield* requireProject(request.projectId);
        const id = `task-${taskHash([request.projectId, request.source, request.externalId])}`;
        const inputHash = taskInputHash(request.recipeId, request.inputs, request.recipeRevision);
        const existing = yield* store.get(request.projectId, id);
        if (existing) {
          if (existing.inputHash !== inputHash)
            return yield* new WorkspaceTaskInboxError({
              message: "같은 외부 이벤트 ID에 다른 입력이 전달됐습니다. 새 이벤트 ID를 사용하세요.",
            });
          return existing;
        }
        const recipe = yield* store.recipe(
          request.projectId,
          request.recipeId,
          request.recipeRevision,
        );
        const latestRecipe = yield* store.recipe(request.projectId, request.recipeId);
        if (!recipe || !recipe.enabled || !latestRecipe?.enabled)
          return yield* new WorkspaceTaskInboxError({
            message: "활성 업무 양식과 지정한 버전을 찾을 수 없습니다.",
          });
        const inputs = yield* Effect.try({
          try: () => resolveTaskInputs(recipe, request.inputs),
          catch: failure,
        });
        const instructions = yield* Effect.try({
          try: () => taskInstructions(recipe, inputs),
          catch: failure,
        });
        if (
          executionProfileTask(instructions, recipe.executionProfile ?? undefined).length > 15_000
        )
          return yield* new WorkspaceTaskInboxError({
            message: "업무 입력과 지침이 너무 깁니다. 15,000자 이하로 줄이세요.",
          });
        const createdAt = yield* now;
        const saved = yield* store.insert({
          id,
          projectId: request.projectId,
          source: request.source,
          externalId: request.externalId,
          inputHash,
          inputs,
          recipe,
          status: "queued",
          attempt: 0,
          runId: null,
          monitorKey: taskHash([recipe.id, recipe.revision, canonicalTaskInputs(inputs)]),
          workspaceRoot: null,
          precheckFingerprint: null,
          baseline: {},
          receipts: [],
          output: "",
          error: null,
          aiSkipped: false,
          createdAt,
          updatedAt: createdAt,
        });
        yield* PubSub.publish(changed, request.projectId);
        return saved;
      }),
    ),
  );
  const save = Effect.fn("TaskInbox.save")(function* (task: WorkspaceInboxTask) {
    const updated = { ...task, updatedAt: yield* now };
    yield* store.update(updated);
    yield* PubSub.publish(changed, task.projectId);
    return updated;
  });
  const commit = Effect.fn("TaskInbox.commit")(
    (original: WorkspaceInboxTask, next: WorkspaceInboxTask) =>
      lock.withPermit(
        Effect.gen(function* () {
          const current = yield* store.get(original.projectId, original.id);
          if (!current || current.attempt !== original.attempt) return current;
          if (current.status === "cancel-requested" && original.status !== "cancel-requested")
            return yield* save({
              ...current,
              receipts: next.receipts,
              baseline: next.baseline,
              precheckFingerprint: next.precheckFingerprint,
            });
          if (current.status !== original.status) return current;
          return yield* save(next);
        }),
      ),
  );
  const command = Effect.fn("TaskInbox.command")(function* (
    task: WorkspaceInboxTask,
    cwd: string,
    kind: "precheck" | "script" | "verification",
    text: string,
  ) {
    const previousFingerprint =
      kind === "precheck"
        ? yield* store.previousFingerprint(task.projectId, task.monitorKey)
        : null;
    const result = yield* input.runner
      .run({
        command: platform === "win32" ? "cmd.exe" : "/bin/sh",
        args: platform === "win32" ? ["/d", "/s", "/c", text] : ["-lc", text],
        cwd,
        env: {
          ...process.env,
          T3_TASK_INPUTS_JSON: stringify(task.inputs),
          T3_TASK_ID: task.id,
          T3_TASK_ATTEMPT: String(task.attempt),
          T3_TASK_PREVIOUS_FINGERPRINT: previousFingerprint ?? "",
        },
        stdin: "",
        timeout: kind === "precheck" ? "20 seconds" : "120 seconds",
        maxOutputBytes: 32_000,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((result) => ({
          passed:
            result.code === 0 &&
            !result.timedOut &&
            !result.stdoutTruncated &&
            !result.stderrTruncated,
          exitCode: result.code === null ? null : Number(result.code),
          output: result.stdout,
          error: result.stderr,
        })),
        Effect.catch((error) =>
          Effect.succeed({ passed: false, exitCode: null, output: "", error: error.message }),
        ),
      );
    const receipt: WorkspaceTaskReceipt = {
      kind,
      label: text,
      passed: result.passed,
      exitCode: result.exitCode,
      sha256: NodeCrypto.createHash("sha256")
        .update(`${result.output}\n${result.error}`)
        .digest("hex"),
      output: `${result.output}\n${result.error}`.trim().slice(-4000),
      observedAt: yield* now,
    };
    return { receipt, stdout: result.output };
  });
  const verify = Effect.fn("TaskInbox.verify")(function* (
    task: WorkspaceInboxTask,
    cwd: string,
    scriptPassed = false,
  ) {
    const project = yield* requireProject(task.projectId);
    if (task.workspaceRoot !== project.workspaceRoot || task.workspaceRoot !== cwd) {
      yield* commit(task, {
        ...task,
        status: "delivery-unknown",
        error:
          "프로젝트 위치가 바뀌어 결과 확인을 보류했습니다. 원래 실행 위치의 변경을 확인하세요.",
      });
      return;
    }
    const receipts = [...task.receipts];
    for (const check of task.recipe.verificationCommands) {
      const current = yield* store.get(task.projectId, task.id);
      if (current?.status === "cancel-requested") return;
      const { receipt } = yield* command(task, cwd, "verification", check);
      receipts.push(receipt);
      yield* commit(task, { ...task, receipts });
      if (!receipt.passed) break;
    }
    for (const artifact of task.recipe.artifacts) {
      const resolved = { ...artifact, path: renderTaskTemplate(artifact.path, task.inputs) };
      receipts.push(
        yield* checkTaskArtifact({
          cwd,
          artifact: resolved,
          baseline: task.baseline[resolved.path] ?? null,
          now: yield* now,
        }),
      );
    }
    const checks = receipts.filter(
      (receipt) => receipt.kind === "verification" || receipt.kind === "artifact",
    );
    const failed = checks.some((receipt) => !receipt.passed);
    const verified = scriptPassed || checks.length > 0;
    yield* commit(task, {
      ...task,
      receipts,
      status: failed ? "failed" : verified ? "completed" : "needs-verification",
      error: failed
        ? "업무 결과 검증에 실패했습니다. 실행 자료를 확인하세요."
        : verified
          ? null
          : "실제 검증 명령이나 필수 산출물이 설정되지 않았습니다.",
    });
  });
  const dispatch = Effect.fn("TaskInbox.dispatch")(function* (task: WorkspaceInboxTask) {
    if (!task.runId) return;
    const project = yield* requireProject(task.projectId);
    if (task.workspaceRoot !== project.workspaceRoot)
      return yield* new WorkspaceTaskInboxError({
        message: "프로젝트 위치가 바뀌어 AI 배정을 보류했습니다.",
      });
    const existing = yield* input.runs.getById({ projectId: task.projectId, runId: task.runId });
    if (Option.isNone(existing)) {
      const current = yield* store.get(task.projectId, task.id);
      if (current?.status !== "dispatching") return;
      const context = task.receipts
        .filter((item) => item.kind === "precheck")
        .map((item) => item.output)
        .join("\n");
      yield* input.engine.dispatch({
        type: "project.collaboration.run.request",
        commandId: CommandId.make(`inbox-dispatch:${task.runId}`),
        projectId: task.projectId,
        runId: task.runId,
        task: `${taskInstructions(task.recipe, task.inputs)}${context ? `\n\n사전 확인 자료:\n${context}` : ""}`,
        ...(task.recipe.executionProfile ? { executionProfile: task.recipe.executionProfile } : {}),
        source: "automation",
        preempt: false,
        createdAt: task.updatedAt,
      });
    }
    yield* commit(task, { ...task, status: "running" });
  }, Effect.mapError(failure));
  const begin = Effect.fn("TaskInbox.begin")(function* (queued: WorkspaceInboxTask) {
    const project = yield* requireProject(queued.projectId);
    const active = yield* input.runs.list({
      projectId: queued.projectId,
      statuses: ["queued", "running", "cancel-requested"],
    });
    if (active.length || (yield* store.projectBusy(queued.projectId))) return;
    const checking = yield* commit(queued, {
      ...queued,
      workspaceRoot: project.workspaceRoot,
      status: "checking",
      error: null,
    });
    if (!checking || checking.status !== "checking") return;
    let task = checking;
    const cwd = project.workspaceRoot;
    const baseline: Record<string, string | null> = {};
    for (const artifact of task.recipe.artifacts) {
      const relative = renderTaskTemplate(artifact.path, task.inputs);
      baseline[relative] = (yield* readTaskFile(cwd, relative))?.sha256 ?? null;
    }
    task = { ...task, baseline };
    let changed = true;
    if (task.recipe.precheck.kind === "files") {
      const snapshots = yield* Effect.forEach(task.recipe.precheck.paths, (path) =>
        Effect.gen(function* () {
          const relative = renderTaskTemplate(path, task.inputs);
          const file = yield* readTaskFile(cwd, relative);
          if (!file)
            return yield* new WorkspaceTaskInboxError({
              message: `사전 확인 파일이 없습니다: ${relative}`,
            });
          return [relative, file.sha256];
        }),
      );
      const fingerprint = taskHash(snapshots);
      changed = fingerprint !== (yield* store.previousFingerprint(task.projectId, task.monitorKey));
      task = {
        ...task,
        precheckFingerprint: fingerprint,
        receipts: [
          ...task.receipts,
          {
            kind: "precheck",
            label: "파일 변경 확인",
            passed: true,
            exitCode: null,
            sha256: fingerprint,
            output: changed ? "파일 변경 또는 첫 실행" : "변화 없음",
            observedAt: yield* now,
          },
        ],
      };
    } else if (task.recipe.precheck.kind === "command") {
      const result = yield* command(task, cwd, "precheck", task.recipe.precheck.command);
      task = { ...task, receipts: [...task.receipts, result.receipt] };
      const admitted = yield* commit(checking, task);
      if (admitted?.status !== "checking") return;
      if (!result.receipt.passed) {
        yield* commit(checking, {
          ...task,
          status: "failed",
          error: "사전 확인 명령에 실패했습니다.",
        });
        return;
      }
      const parsed = yield* decodePrecheckOutput(result.stdout).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceTaskInboxError({
              message:
                '사전 확인 출력은 {"changed": true 또는 false, "context": "선택 자료"} JSON이어야 합니다.',
              cause,
            }),
        ),
      );
      changed =
        parsed.changed &&
        (!parsed.fingerprint ||
          parsed.fingerprint !==
            (yield* store.previousFingerprint(task.projectId, task.monitorKey)));
      task = {
        ...task,
        precheckFingerprint: parsed.fingerprint ?? null,
        receipts: task.receipts.map((item, index) =>
          index === task.receipts.length - 1
            ? { ...item, output: parsed.context ?? (changed ? "변경 감지" : "변화 없음") }
            : item,
        ),
      };
    }
    const current = yield* store.get(task.projectId, task.id);
    if (current?.status !== "checking") {
      yield* commit(checking, task);
      return;
    }
    if (!changed) {
      yield* commit(checking, { ...task, status: "unchanged", aiSkipped: true });
      return;
    }
    if (task.recipe.execution === "script") {
      // Persist before launching commands so a crash cannot silently replay their effects.
      const admitted = yield* commit(checking, task);
      if (admitted?.status !== "checking") return;
      const result = yield* command(task, cwd, "script", task.recipe.script);
      task = {
        ...task,
        receipts: [...task.receipts, result.receipt],
        output: result.stdout.slice(-16_000),
        aiSkipped: true,
      };
      if (!result.receipt.passed) {
        yield* commit(checking, { ...task, status: "failed", error: "실행 명령에 실패했습니다." });
        return;
      }
      const verifying = yield* commit(checking, { ...task, status: "verifying" });
      if (verifying?.status === "verifying") yield* verify(verifying, cwd, true);
    } else {
      const dispatching = yield* commit(checking, {
        ...task,
        status: "dispatching",
        runId: WorkspaceCollaborationRunId.make(`inbox-${task.id}-${task.attempt}`),
      });
      if (dispatching?.status === "dispatching") yield* dispatch(dispatching);
    }
  }, Effect.mapError(failure));
  const advance = Effect.fn("TaskInbox.advance")(function* (task: WorkspaceInboxTask) {
    if (task.status === "queued") {
      yield* begin(task);
      return;
    }
    if (task.status === "dispatching") {
      yield* dispatch(task);
      return;
    }
    if (task.status !== "running" && task.status !== "cancel-requested") return;
    const run = task.runId
      ? Option.getOrNull(
          yield* input.runs.getById({ projectId: task.projectId, runId: task.runId }),
        )
      : null;
    if (task.status === "cancel-requested") {
      if (run && ["queued", "running"].includes(run.status)) {
        yield* input.engine.dispatch({
          type: "project.collaboration.run.cancel",
          commandId: CommandId.make(`inbox-cancel:${run.id}`),
          projectId: task.projectId,
          runId: run.id,
          createdAt: yield* now,
        });
      } else if (!run || run.status !== "cancel-requested")
        yield* commit(task, { ...task, status: "cancelled", error: null });
      return;
    }
    if (!run) {
      yield* commit(task, {
        ...task,
        status: "delivery-unknown",
        error: "배정한 실행 기록을 찾을 수 없습니다. 결과를 확인한 뒤 재시도하세요.",
      });
      return;
    }
    if (run.status === "completed") {
      const project = yield* requireProject(task.projectId);
      const verifying = yield* commit(task, {
        ...task,
        status: "verifying",
        output: (run.finalOutput ?? "").slice(-16_000),
      });
      if (verifying?.status === "verifying") yield* verify(verifying, project.workspaceRoot);
    } else if (run.status === "failed" || run.status === "cancelled")
      yield* commit(task, {
        ...task,
        status: run.status,
        error: run.error,
        output: (run.finalOutput ?? "").slice(-16_000),
      });
  }, Effect.mapError(failure));
  const tick = tickLock.withPermit(
    Effect.gen(function* () {
      const tasks = yield* store.pending;
      const occupied = new Set(
        tasks.filter((task) => task.status !== "queued").map((task) => task.projectId),
      );
      for (const task of tasks) {
        if (task.status === "queued" && occupied.has(task.projectId)) continue;
        yield* advance(task).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
            return Effect.gen(function* () {
              const current = yield* store.get(task.projectId, task.id);
              if (current && current.status !== "cancel-requested" && !terminal.has(current.status))
                yield* commit(current, {
                  ...current,
                  status:
                    current.status === "dispatching" || current.status === "verifying"
                      ? "delivery-unknown"
                      : "failed",
                  error: failure(Cause.squash(cause)).message,
                });
            });
          }),
        );
        const current = yield* store.get(task.projectId, task.id);
        if (current && !terminal.has(current.status)) occupied.add(task.projectId);
      }
    }),
  );
  const action = Effect.fn("TaskInbox.action")((request: WorkspaceTaskAction) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          yield* requireProject(request.projectId);
          const task = yield* store.get(request.projectId, request.taskId);
          if (!task)
            return yield* new WorkspaceTaskInboxError({ message: "작업을 찾을 수 없습니다." });
          if (request.action === "hold" && task.status === "queued")
            return yield* save({ ...task, status: "held" });
          if (request.action === "release" && task.status === "held")
            return yield* save({ ...task, status: "queued" });
          if (
            request.action === "cancel" &&
            (!terminal.has(task.status) ||
              task.status === "needs-verification" ||
              task.status === "delivery-unknown")
          )
            return yield* save({
              ...task,
              status:
                task.runId || ["checking", "verifying"].includes(task.status)
                  ? "cancel-requested"
                  : "cancelled",
            });
          if (request.action === "retry" && terminal.has(task.status)) {
            if (task.runId) {
              const run = Option.getOrNull(
                yield* input.runs.getById({ projectId: task.projectId, runId: task.runId }),
              );
              if (run && ["queued", "running", "cancel-requested"].includes(run.status))
                return yield* new WorkspaceTaskInboxError({
                  message: "이전 실행이 아직 끝나지 않았습니다. 실행 상태를 먼저 확인하세요.",
                });
            }
            return yield* save({
              ...task,
              status: "queued",
              attempt: task.attempt + 1,
              runId: null,
              workspaceRoot: null,
              baseline: {},
              receipts: [],
              error: null,
              output: "",
              aiSkipped: false,
              precheckFingerprint: null,
            });
          }
          if (request.action === "reconcile" && task.status === "delivery-unknown" && task.runId) {
            const run = yield* input.runs.getById({ projectId: task.projectId, runId: task.runId });
            if (Option.isSome(run)) return yield* save({ ...task, status: "running", error: null });
          }
          return yield* new WorkspaceTaskInboxError({
            message: "현재 작업 상태에서는 해당 동작을 수행할 수 없습니다.",
          });
        }),
      )
      .pipe(Effect.mapError(failure)),
  );
  const start = Effect.fn("TaskInbox.start")(function* () {
    const tasks = yield* store.pending.pipe(Effect.orDie);
    for (const task of tasks)
      if (task.status === "checking" || task.status === "verifying")
        yield* save({
          ...task,
          status: "delivery-unknown",
          error:
            "실행 또는 검증 중 서버가 중단됐습니다. 이미 수행된 변경을 확인한 뒤 재시도하세요.",
        }).pipe(Effect.orDie);
    const safely = tick.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Task inbox tick failed", { cause: Cause.pretty(cause) }),
      ),
    );
    yield* forkParked(Effect.forever(safely.pipe(Effect.andThen(Effect.sleep("1 second"))))).pipe(
      Effect.provideService(Scope.Scope, scope),
    );
  });
  const subscribe = (projectId: ProjectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changed);
        const initial = yield* overview(projectId);
        return Stream.concat(
          Stream.succeed(initial),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changedProject) => changedProject === projectId),
            Stream.mapEffect(() => overview(projectId)),
          ),
        );
      }),
    );
  return WorkspaceTaskInbox.of({
    subscribe,
    overview,
    get,
    saveRecipe,
    submit,
    action,
    start,
    tick,
    hasPendingSource: store.hasPendingSource,
  });
});

export const layer = Layer.effect(
  WorkspaceTaskInbox,
  Effect.gen(function* () {
    return yield* makeWorkspaceTaskInbox({
      store: yield* WorkspaceTaskInboxStore,
      engine: yield* OrchestrationEngineService,
      query: yield* ProjectionSnapshotQuery,
      runs: yield* ProjectionWorkspaceCollaborationRunRepository,
      runner: yield* ProcessRunner.ProcessRunner,
    });
  }),
);
