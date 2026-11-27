// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import {
  AuthAdministrativeScopes,
  clampWorkerWaitSeconds,
  type WorkerDecisionGateRisk,
  type WorkerMailboxMessageType,
  type WorkerWorktreeMode,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { startWorkerCheckKeepalive } from "../t3x/workerEngine/checkKeepalive.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

interface WorkerCliResponse {
  readonly ok: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: Record<string, unknown>;
  };
}

function parseTargetSpec(raw: string): {
  readonly targetInstanceId: string;
  readonly targetModel: string | null;
} {
  const trimmed = raw.trim();
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx <= 0) {
    return { targetInstanceId: trimmed, targetModel: null };
  }
  return {
    targetInstanceId: trimmed.slice(0, colonIdx).trim(),
    targetModel: trimmed.slice(colonIdx + 1).trim() || null,
  };
}

function parseMailboxTypes(raw: string | undefined): WorkerMailboxMessageType[] | undefined {
  if (!raw?.trim()) return undefined;
  const valid = new Set<WorkerMailboxMessageType>([
    "dispatch",
    "worker_done",
    "question",
    "answer",
    "escalation",
    "decision_gate",
    "heartbeat",
    "merge_ready",
    "status",
  ]);
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is WorkerMailboxMessageType => valid.has(s as WorkerMailboxMessageType));
  return parsed.length > 0 ? parsed : undefined;
}

const withWorkerCliToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: AuthAdministrativeScopes,
      label: "t3 worker cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

function emitErrorAndExit(code: string, message: string, asJson: boolean): never {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  }
  process.stderr.write(`error: ${code}: ${message}\n`);
  process.exit(1);
}

const callWorkerEngineApi = Effect.fn("workerCli.callWorkerEngineApi")(function* (input: {
  readonly flags: CliAuthLocationFlags;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  readonly asJson: boolean;
  readonly keepaliveDeadlineMs?: number | undefined;
}) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(input.flags, logLevel);

  return yield* Effect.gen(function* () {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      emitErrorAndExit(
        "server_not_running",
        "T3 서버가 실행 중이지 않습니다. 서버를 먼저 시작한 뒤 다시 시도하세요.",
        input.asJson,
      );
    }

    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const httpClient = yield* HttpClient.HttpClient;
    return yield* withWorkerCliToken(environmentAuth, (token) =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          input.keepaliveDeadlineMs !== undefined
            ? startWorkerCheckKeepalive({ deadlineMs: input.keepaliveDeadlineMs })
            : () => {},
        ),
        () =>
          Effect.gen(function* () {
            const url = `${runtimeState.value.origin}${input.path}`;
            let req =
              input.method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url);
            req = HttpClientRequest.bearerToken(req, token);
            if (input.body !== undefined) {
              req = HttpClientRequest.bodyText(req, JSON.stringify(input.body), "application/json");
            }
            const response = yield* httpClient
              .execute(req)
              .pipe(
                Effect.catch((cause) =>
                  Effect.sync(() =>
                    emitErrorAndExit(
                      "connection_failed",
                      `T3 서버(${runtimeState.value.origin})에 연결하지 못했습니다: ${cause instanceof Error ? cause.message : String(cause)}`,
                      input.asJson,
                    ),
                  ),
                ),
              );
            const rawJson = yield* response.json.pipe(
              Effect.orElseSucceed(() => ({
                ok: false,
                error: { code: "invalid_response", message: `HTTP ${response.status}` },
              })),
            );
            const parsed = rawJson as WorkerCliResponse;

            if (response.status >= 400 || !parsed.ok) {
              emitErrorAndExit(
                parsed.error?.code ?? `http_${response.status}`,
                parsed.error?.message ?? `Request failed with status ${response.status}`,
                input.asJson,
              );
            }
            return parsed;
          }),
        (stopKeepalive) => Effect.sync(stopKeepalive),
      ),
    );
  }).pipe(
    Effect.provide(
      EnvironmentAuth.runtimeLayer.pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    ),
  );
});

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription('Print a single-line JSON envelope: {"ok":true,"result":{...}}.'),
  Flag.withDefault(false),
);

const workerStatusCommand = Command.make("status", {
  ...projectLocationFlags,
  thread: Flag.string("thread").pipe(Flag.optional),
  run: Flag.string("run").pipe(Flag.optional),
  task: Flag.string("task").pipe(Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show T3 worker tasks, active dispatches, open gates, and unread mail."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const params = new URLSearchParams();
      if (Option.isSome(flags.thread)) params.set("threadId", flags.thread.value);
      if (Option.isSome(flags.run)) params.set("runId", flags.run.value);
      if (Option.isSome(flags.task)) params.set("taskId", flags.task.value);
      const qs = params.toString();
      const resp = yield* callWorkerEngineApi({
        flags,
        method: "GET",
        path: `/api/worker-engine/status${qs ? `?${qs}` : ""}`,
        asJson: flags.json,
      });
      if (flags.json) {
        yield* Console.log(JSON.stringify(resp));
        return;
      }
      const r = resp.result as {
        tasks: unknown[];
        activeDispatches: unknown[];
        openGates: unknown[];
        unreadMailboxCount: number;
      };
      yield* Console.log(
        `tasks=${r.tasks.length} activeDispatches=${r.activeDispatches.length} openGates=${r.openGates.length} unreadMail=${r.unreadMailboxCount}`,
      );
    }),
  ),
);

const workerDispatchCommand = Command.make("dispatch", {
  ...projectLocationFlags,
  spec: Flag.string("spec").pipe(Flag.withDescription("Task instructions for the worker.")),
  role: Flag.string("role").pipe(Flag.withDefault("worker")),
  target: Flag.string("target").pipe(
    Flag.withDescription(
      "Provider instance id or instance:model (e.g. codex, claudeAgent:claude-sonnet-5-5, gemini).",
    ),
  ),
  thread: Flag.string("thread").pipe(Flag.withDefault("cli-default")),
  run: Flag.string("run").pipe(Flag.optional),
  cwd: Flag.string("cwd").pipe(Flag.optional),
  worktree: Flag.choice("worktree", ["isolated", "current"] as const).pipe(Flag.optional),
  taskId: Flag.string("task-id").pipe(Flag.optional),
  idempotencyKey: Flag.string("idempotency-key").pipe(Flag.optional),
  retryOf: Flag.string("retry-of").pipe(Flag.optional),
  callerKind: Flag.choice("caller-kind", [
    "t3_supervisor",
    "personal_ai",
    "council",
    "orchestra",
    "cli",
  ] as const).pipe(Flag.withDefault("cli")),
  requireApproval: Flag.boolean("require-approval").pipe(Flag.withDefault(false)),
  approvalQuestion: Flag.string("approval-question").pipe(Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Dispatch a task to a T3 worker with fencing, dedup, and optional worktree isolation.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { targetInstanceId, targetModel } = parseTargetSpec(flags.target);
      const body = {
        threadId: flags.thread,
        ...(Option.isSome(flags.run) ? { runId: flags.run.value } : {}),
        callerKind: flags.callerKind,
        ...(Option.isSome(flags.taskId) ? { taskId: flags.taskId.value } : {}),
        ...(Option.isSome(flags.idempotencyKey)
          ? { idempotencyKey: flags.idempotencyKey.value }
          : {}),
        ...(Option.isSome(flags.retryOf) ? { retryOfDispatchId: flags.retryOf.value } : {}),
        role: flags.role,
        targetInstanceId,
        targetModel,
        specText: flags.spec,
        cwd: Option.isSome(flags.cwd) ? flags.cwd.value : process.cwd(),
        ...(Option.isSome(flags.worktree)
          ? { worktreeMode: flags.worktree.value as WorkerWorktreeMode }
          : {}),
        ...(flags.requireApproval ? { requireApproval: true } : {}),
        ...(Option.isSome(flags.approvalQuestion)
          ? { approvalQuestion: flags.approvalQuestion.value }
          : {}),
      };
      const resp = yield* callWorkerEngineApi({
        flags,
        method: "POST",
        path: "/api/worker-engine/dispatch",
        body,
        asJson: flags.json,
      });
      if (flags.json) {
        yield* Console.log(JSON.stringify(resp));
        return;
      }
      const r = resp.result as Record<string, unknown>;
      yield* Console.log(
        `taskId=${r.taskId} dispatchId=${r.dispatchId} runId=${r.runId} status=${r.status} worktree=${r.worktreePath ?? "current"}`,
      );
    }),
  ),
);

const workerCheckCommand = Command.make("check", {
  ...projectLocationFlags,
  run: Flag.string("run").pipe(Flag.optional),
  thread: Flag.string("thread").pipe(Flag.optional),
  toActor: Flag.string("to").pipe(Flag.optional),
  types: Flag.string("types").pipe(Flag.optional),
  wait: Flag.boolean("wait").pipe(Flag.withDefault(false)),
  timeoutSec: Flag.integer("timeout-sec").pipe(Flag.withDefault(60)),
  peek: Flag.boolean("peek").pipe(Flag.withDefault(false)),
  limit: Flag.integer("limit").pipe(Flag.withDefault(20)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Check worker mailbox (FIFO delivery with <=120s wait and 15s stderr keepalive).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const clampedTimeout = clampWorkerWaitSeconds(flags.timeoutSec, 60);
      const types = parseMailboxTypes(Option.getOrUndefined(flags.types));
      const body = {
        ...(Option.isSome(flags.run) ? { runId: flags.run.value } : {}),
        ...(Option.isSome(flags.thread) ? { threadId: flags.thread.value } : {}),
        ...(Option.isSome(flags.toActor) ? { toActor: flags.toActor.value } : {}),
        ...(types ? { types } : {}),
        wait: flags.wait,
        timeoutSec: clampedTimeout,
        peek: flags.peek,
        limit: flags.limit,
      };
      const nowMs = yield* Clock.currentTimeMillis;
      const resp = yield* callWorkerEngineApi({
        flags,
        method: "POST",
        path: "/api/worker-engine/check",
        body,
        asJson: flags.json,
        ...(flags.wait ? { keepaliveDeadlineMs: nowMs + clampedTimeout * 1_000 } : {}),
      });
      if (flags.json) {
        yield* Console.log(JSON.stringify(resp));
        return;
      }
      const r = resp.result as {
        deliveryId: string | null;
        messages: Array<{ type: string; subject: string; taskId: string | null }>;
      };
      if (r.messages.length === 0) {
        yield* Console.log("No messages.");
        return;
      }
      yield* Console.log(
        `deliveryId=${r.deliveryId ?? "peek"} messages=${r.messages.length}\n${r.messages
          .map((m) => `- [${m.type}] ${m.subject} (task=${m.taskId ?? "-"})`)
          .join("\n")}`,
      );
    }),
  ),
);

const workerAckCommand = Command.make("ack", {
  ...projectLocationFlags,
  delivery: Flag.string("delivery").pipe(Flag.withDescription("Delivery ID returned by check.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Acknowledge a mailbox delivery so its messages are marked handled."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resp = yield* callWorkerEngineApi({
        flags,
        method: "POST",
        path: "/api/worker-engine/ack",
        body: { deliveryId: flags.delivery },
        asJson: flags.json,
      });
      if (flags.json) {
        yield* Console.log(JSON.stringify(resp));
        return;
      }
      const r = resp.result as { deliveryId: string; acknowledgedMessageCount: number };
      yield* Console.log(
        `acknowledged deliveryId=${r.deliveryId} count=${r.acknowledgedMessageCount}`,
      );
    }),
  ),
);

const workerStopCommand = Command.make("stop", {
  ...projectLocationFlags,
  dispatch: Flag.string("dispatch").pipe(Flag.withDescription("Dispatch ID to stop.")),
  reason: Flag.string("reason").pipe(Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Stop a running worker dispatch."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resp = yield* callWorkerEngineApi({
        flags,
        method: "POST",
        path: "/api/worker-engine/stop",
        body: {
          dispatchId: flags.dispatch,
          ...(Option.isSome(flags.reason) ? { reason: flags.reason.value } : {}),
        },
        asJson: flags.json,
      });
      if (flags.json) {
        yield* Console.log(JSON.stringify(resp));
        return;
      }
      const r = resp.result as { dispatchId: string; status: string; stopped: boolean };
      yield* Console.log(`dispatchId=${r.dispatchId} stopped=${r.stopped} status=${r.status}`);
    }),
  ),
);

const workerGateListCommand = Command.make("list", {
  ...projectLocationFlags,
  task: Flag.string("task").pipe(Flag.optional),
  thread: Flag.string("thread").pipe(Flag.optional),
  status: Flag.choice("status", ["open", "approved", "denied", "expired"] as const).pipe(
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List decision gates."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const params = new URLSearchParams();
      if (Option.isSome(flags.task)) params.set("taskId", flags.task.value);
      if (Option.isSome(flags.thread)) params.set("threadId", flags.thread.value);
      if (Option.isSome(flags.status)) params.set("status", flags.status.value);
      const qs = params.toString();
      const resp = yield* callWorkerEngineApi({
        flags,
        method: "GET",
        path: `/api/worker-engine/gates${qs ? `?${qs}` : ""}`,
        asJson: flags.json,
      });
      if (flags.json) {
        yield* Console.log(JSON.stringify(resp));
        return;
      }
      const r = resp.result as {
        gates: Array<{ gateId: string; status: string; question: string }>;
      };
      yield* Console.log(
        r.gates.length === 0
          ? "No gates."
          : r.gates.map((g) => `- ${g.gateId} [${g.status}] ${g.question}`).join("\n"),
      );
    }),
  ),
);

const workerGateCreateCommand = Command.make("create", {
  ...projectLocationFlags,
  task: Flag.string("task"),
  question: Flag.string("question"),
  risk: Flag.choice("risk", ["medium", "high", "critical"] as const).pipe(Flag.withDefault("high")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a decision gate blocking a task until resolved."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resp = yield* callWorkerEngineApi({
        flags,
        method: "POST",
        path: "/api/worker-engine/gates",
        body: {
          taskId: flags.task,
          riskLevel: flags.risk as WorkerDecisionGateRisk,
          question: flags.question,
        },
        asJson: flags.json,
      });
      yield* Console.log(JSON.stringify(resp));
    }),
  ),
);

const workerGateResolveCommand = Command.make("resolve", {
  ...projectLocationFlags,
  gate: Flag.string("gate"),
  decision: Flag.choice("decision", ["approve", "deny"] as const),
  reason: Flag.string("reason").pipe(Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Approve or deny an open decision gate."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resp = yield* callWorkerEngineApi({
        flags,
        method: "POST",
        path: "/api/worker-engine/gates/resolve",
        body: {
          gateId: flags.gate,
          decision: flags.decision,
          ...(Option.isSome(flags.reason) ? { resolution: flags.reason.value } : {}),
        },
        asJson: flags.json,
      });
      yield* Console.log(JSON.stringify(resp));
    }),
  ),
);

const workerGateCommand = Command.make("gate").pipe(
  Command.withDescription("Manage worker decision gates."),
  Command.withSubcommands([
    workerGateListCommand,
    workerGateCreateCommand,
    workerGateResolveCommand,
  ]),
);

const workerWorktreeDiffCommand = Command.make("diff", {
  ...projectLocationFlags,
  task: Flag.string("task"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Inspect git status and diff of a preserved worker worktree."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resp = yield* callWorkerEngineApi({
        flags,
        method: "GET",
        path: `/api/worker-engine/worktree/diff?taskId=${encodeURIComponent(flags.task)}`,
        asJson: flags.json,
      });
      if (flags.json) {
        yield* Console.log(JSON.stringify(resp));
        return;
      }
      const r = resp.result as {
        worktreeBranch: string | null;
        worktreeState: string;
        diffStat: string;
        statusShort: string;
      };
      yield* Console.log(
        `branch=${r.worktreeBranch ?? "-"} state=${r.worktreeState}\n${r.diffStat || r.statusShort || "(no changes)"}`,
      );
    }),
  ),
);

const workerWorktreeMergeCommand = Command.make("merge", {
  ...projectLocationFlags,
  task: Flag.string("task"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Merge a reviewed worker worktree branch and clean up the worktree."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resp = yield* callWorkerEngineApi({
        flags,
        method: "POST",
        path: "/api/worker-engine/worktree/merge",
        body: { taskId: flags.task },
        asJson: flags.json,
      });
      yield* Console.log(JSON.stringify(resp));
    }),
  ),
);

const workerWorktreeDiscardCommand = Command.make("discard", {
  ...projectLocationFlags,
  task: Flag.string("task"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Discard a worker worktree and delete its branch."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resp = yield* callWorkerEngineApi({
        flags,
        method: "POST",
        path: "/api/worker-engine/worktree/discard",
        body: { taskId: flags.task },
        asJson: flags.json,
      });
      yield* Console.log(JSON.stringify(resp));
    }),
  ),
);

const workerWorktreeCommand = Command.make("worktree").pipe(
  Command.withDescription("Review, merge, or discard isolated worker worktrees."),
  Command.withSubcommands([
    workerWorktreeDiffCommand,
    workerWorktreeMergeCommand,
    workerWorktreeDiscardCommand,
  ]),
);

export const workerCommand = Command.make("worker").pipe(
  Command.withDescription(
    "Control the T3 Worker Engine (dispatch, mailbox check/ack, gates, worktrees).",
  ),
  Command.withSubcommands([
    workerStatusCommand,
    workerDispatchCommand,
    workerCheckCommand,
    workerAckCommand,
    workerStopCommand,
    workerGateCommand,
    workerWorktreeCommand,
  ]),
);
