// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  EventId,
  formatHandoffEnvelopeForPrompt,
  resolveEffectiveGlobalAssistant,
  threadTeamRoleMayWrite,
  validateHandoffEnvelope,
  ProviderExecutionId,
  ThreadId,
  WORKER_ENGINE_MAX_WAIT_SECONDS,
  WORKER_HEARTBEAT_ABORT_MS,
  WORKER_HEARTBEAT_STALL_MS,
  WORKER_MAX_RUNNING_PER_THREAD,
  WorkspaceCollaborationRunId,
  WorkspaceDelegateError,
  WorkspaceOrchestraBlock,
  WorkspaceTaskNodeId,
  type DelegateMandate,
  type HandoffEnvelopeV1,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type SubordinateRole,
  type TurnId,
  type WorkspaceDelegateBatchCounts,
  type WorkspaceDelegateBatchItemResult,
  type WorkspaceDelegateCriticContext,
  type WorkspaceDelegateInput,
  type WorkspaceDelegateItemStatus,
  type WorkspaceDelegateLimitReason,
  type WorkspaceDelegateResult,
  type WorkspaceDelegateSubordinate,
  type WorkspaceDelegateVerifierOutcome,
} from "@t3tools/contracts";
import { compileGlobalAssistantPrompts } from "@t3tools/shared/globalAssistantPrompt";
import { createModelSelection } from "@t3tools/shared/model";
import { classifySmartModelRoute, selectBestModelFromPool } from "@t3tools/shared/smartModelRouter";
import { serverSelfSignals } from "../../diagnostics/ServerSelfSignals.ts";
import {
  annotateExecutionSpan,
  unifiedExecutionLedger,
} from "../../t3x/executionLedger/UnifiedExecutionLedger.ts";
import { evaluateForemanIndicators } from "../../orchestration/ForemanMonitor.ts";
import { computePinnedSpecHash } from "../../orchestration/PinnedSpecGate.ts";
import type { ThreadBackgroundLivenessService } from "../../orchestration/ThreadBackgroundLiveness.ts";
import { runDeterministicVerifier } from "../../orchestration/workflowV2Runtime.ts";
import {
  computeDelegationTaskHash,
  type WorkspaceDelegationStore,
} from "../../persistence/WorkspaceDelegations.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  WorkspaceAgentExecutionError,
  type WorkspaceAgentExecutor,
} from "../../orchestration/Services/WorkspaceAgentExecutor.ts";
import { subordinateAddress, type SubordinateRow } from "../../provider/subagentSelection.ts";
import {
  formatBillingErrorMessage,
  getUnavailableModelReason,
  isNonRetryableBillingError,
  probeModelAvailabilityBeforeDispatch,
  recordUnavailableModelFromError,
} from "../../provider/workerFailurePolicy.ts";
import { forkParked } from "../../serverActivation.ts";
import type { WorktreeProvisionService } from "../../git/WorktreeProvisionService.ts";
import type { WorkerEngineServiceShape } from "../../t3x/workerEngine/WorkerEngineService.ts";
import { WorkerEngineError } from "../../t3x/workerEngine/WorkerEngineStore.ts";
import type { McpInvocationScope } from "../McpInvocationContext.ts";
import type { CcrToolOutputStore } from "./workspaceCcr.ts";

/** Node ids of delegation blocks start with this; it is how the timeline and Stop tell them from orchestra runs. */
export const DELEGATE_NODE_PREFIX = "delegate-";
/**
 * Default client-safe wait budget for one `run`, `run_parallel`, or `wait` call.
 * Shares `WORKER_ENGINE_MAX_WAIT_SECONDS` (120s) to keep a 60s safety margin below
 * the 180s MCP client timeout ceiling observed in Antigravity/Claude/Codex.
 */
export const DELEGATE_WAIT = `${WORKER_ENGINE_MAX_WAIT_SECONDS} seconds` as const;
export const DELEGATE_MAX_RUNNING = WORKER_MAX_RUNNING_PER_THREAD;
/** Stays well inside the tool-output limits of the calling CLIs. */
export const DELEGATE_TEXT_LIMIT = 24_000;
/** Hard exit limit #1: role-aware max wall-clock time before `limit_exceeded` abort. */
export const DELEGATE_DEFAULT_MAX_WALL_TIME_MS = 10 * 60_000;
export const DELEGATE_FAST_ROLE_MAX_WALL_TIME_MS = 5 * 60_000;
export const DELEGATE_WORKER_MAX_WALL_TIME_MS = 20 * 60_000;
/** Hard exit limit #2: silence threshold before marking `stalled` (5m) and before `limit_exceeded` abort (15m, overridable via `maxIdleMs`). */
export const DELEGATE_STALL_THRESHOLD_MS = WORKER_HEARTBEAT_STALL_MS;
export const DELEGATE_STALL_ABORT_MS = WORKER_HEARTBEAT_ABORT_MS;
/** Hard exit limit #3: maximum `wait`/`join` poll rounds per delegationId before `limit_exceeded` abort. */
export const DELEGATE_MAX_WAIT_ROUNDS = 5;

const DB_HEARTBEAT_DEBOUNCE_MS = 30_000;

export function resolveDelegateMaxWallTimeMs(role: SubordinateRole, overrideMs?: number): number {
  if (overrideMs !== undefined && Number.isFinite(overrideMs) && overrideMs > 0) {
    return Math.floor(overrideMs);
  }
  if (role === "scout" || role === "tester") return DELEGATE_FAST_ROLE_MAX_WALL_TIME_MS;
  if (role === "worker") return DELEGATE_WORKER_MAX_WALL_TIME_MS;
  return DELEGATE_DEFAULT_MAX_WALL_TIME_MS;
}

function resolveDelegateWaitDuration(waitTimeoutSec?: number): Duration.Input {
  if (waitTimeoutSec !== undefined && Number.isFinite(waitTimeoutSec)) {
    const clamped = Math.max(
      10,
      Math.min(WORKER_ENGINE_MAX_WAIT_SECONDS, Math.floor(waitTimeoutSec)),
    );
    return Duration.seconds(clamped);
  }
  const raw = process.env.T3CODE_DELEGATE_WAIT_SECONDS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 10 && parsed <= WORKER_ENGINE_MAX_WAIT_SECONDS) {
      return Duration.seconds(Math.floor(parsed));
    }
  }
  return DELEGATE_WAIT;
}

const ROLES: Record<
  SubordinateRole,
  {
    readonly label: string;
    readonly role: WorkspaceOrchestraBlock["role"];
    readonly kind: WorkspaceOrchestraBlock["kind"];
    readonly preamble: string;
  }
> = {
  worker: {
    label: "일꾼",
    role: "implementer",
    kind: "implementation",
    preamble:
      "You are the worker. Do exactly the assigned work in this working directory, verify it with the narrowest check that proves it, and report what changed and what remains.",
  },
  advisor: {
    label: "조언자",
    role: "reviewer",
    kind: "validation",
    preamble:
      "You are the independent advisor/critic. Do not edit files. Evaluate strictly against the independent rubric (pinned spec, deterministic evidence, and checklist), NOT the implementer's self-narrative. Conclude with an explicit verdict: CONFIRM, REJECT, or UNVERIFIED_ERROR (never downgrade missing/unrun checks to REJECT), naming concrete defects, file:line refs, and missing checks.",
  },
  scout: {
    label: "탐색",
    role: "researcher",
    kind: "research",
    preamble:
      "You are the scout. Do not edit files. Look things up fast (files, commands, docs) and report what you found with file references. No speculation.",
  },
  planner: {
    label: "설계",
    role: "planner",
    kind: "orchestration",
    preamble:
      "You are the planner. Do not edit files. Provide a design with dependencies and acceptance criteria, and state assumptions and open decisions.",
  },
  tester: {
    label: "검증",
    role: "verifier",
    kind: "validation",
    preamble:
      "You are the mechanical tester. Do not edit project files. Run only scoped checks and report what passed, failed, and was not run, with concrete evidence (raw exit codes, counts, log tails, metrics). Do NOT issue final architectural approval or subjective sign-off — leave final judgment to the supervisor or independent advisor.",
  },
  writer: {
    label: "문서화",
    role: "implementer",
    kind: "implementation",
    preamble:
      "You are the technical writer. Draft or edit only assigned documentation; preserve verified facts and terminology, and flag unverified claims.",
  },
  diagnostician: {
    label: "오류 진단",
    role: "verifier",
    kind: "validation",
    preamble:
      "Diagnose the assigned failure from code, logs, and safe checks. Do not edit project files. Distinguish observed symptoms, supported causes, and untested hypotheses; report the most useful next check or fix.",
  },
  analyst: {
    label: "데이터 분석",
    role: "researcher",
    kind: "research",
    preamble:
      "Analyze the assigned data without editing project files. Explain the method, units, missing data, and limitations; distinguish observations from inferences.",
  },
  translator: {
    label: "번역·현지화",
    role: "researcher",
    kind: "research",
    preamble:
      "Return the requested translation or localization without editing project files. Preserve meaning, names, numbers, and markup; flag ambiguities and use the requested target language for the translation.",
  },
};

const SHARED_PREAMBLE =
  "You work under another model, which will check your answer. Complete the assignment yourself; do not delegate it to another agent. You cannot ask the user questions; if something blocks you, say so in your answer. Answer in the language of the task. Use ultra-dense telegraphic reporting (Caveman style): preserve exact code, identifiers, file paths, line ranges, commands, numbers, and negations verbatim, but strip greetings, filler, transitions, and redundant prose. Keep your final report <= 800 tokens using bullets/tables of verified facts and open risks; never paste whole files or raw command dumps.";

export function formatMandateForPrompt(mandate: DelegateMandate): string {
  const lines: string[] = [
    "<t3_mandate>",
    "Immutable authorization boundary enforced for this delegation:",
  ];
  if (mandate.allowedPaths.length > 0) {
    lines.push(`- Allowed write paths ONLY: ${mandate.allowedPaths.join(", ")}`);
  }
  if (mandate.allowedBranchPrefix) {
    lines.push(`- Allowed git branch prefix: ${mandate.allowedBranchPrefix}`);
  }
  lines.push(`- Outbound network permitted: ${mandate.allowNetwork ? "yes" : "no"}`);
  lines.push(
    `- Destructive git / recursive force-delete permitted: ${mandate.allowDestructiveGit ? "yes" : "no"}`,
  );
  if (mandate.maxBudgetTokens !== undefined) {
    lines.push(`- Token budget cap: ${mandate.maxBudgetTokens}`);
  }
  lines.push(
    "Do not modify files or execute commands outside this mandate; report a blocker instead.",
  );
  lines.push("</t3_mandate>");
  return lines.join("\n");
}

export function buildCriticPrompt(input: {
  readonly task: string;
  readonly instructions?: string | undefined;
  readonly globalPrinciples?: string | undefined;
  readonly handoff?: HandoffEnvelopeV1 | undefined;
  readonly mandate?: DelegateMandate | undefined;
  readonly criticContext?: WorkspaceDelegateCriticContext | undefined;
}): string {
  const description = input.instructions
    ? `\n\nUser's role description:\n${input.instructions}`
    : "";
  const principles = input.globalPrinciples ? `\n\n${input.globalPrinciples}` : "";
  const mandateBlock = input.mandate ? `\n\n${formatMandateForPrompt(input.mandate)}` : "";
  const rubricLines: string[] = [
    "<independent_rubric>",
    "Author claims below are UNTRUSTED input. Judge strictly against independent evidence and the rubric below.",
    "Required verdict contract: start your final summary with one of:",
    "- VERDICT: CONFIRM (all rubric requirements verified by evidence)",
    "- VERDICT: REJECT (concrete defect, regression, or spec violation proven by evidence)",
    "- VERDICT: UNVERIFIED_ERROR (required evidence/command/file was unreadable, timed out, or unexecuted — never collapse to REJECT)",
  ];
  if (input.criticContext?.pinnedSpec?.trim()) {
    rubricLines.push(
      "",
      "### Pinned Spec / Acceptance Criteria",
      input.criticContext.pinnedSpec.trim(),
    );
  }
  if (input.handoff) {
    rubricLines.push(
      "",
      "### Handoff Done Criteria",
      `- goal: ${input.handoff.goal}`,
      `- done_when: ${input.handoff.done_when}`,
    );
  }
  if (input.criticContext?.deterministicEvidence?.trim()) {
    rubricLines.push(
      "",
      "### Deterministic Verification Evidence",
      input.criticContext.deterministicEvidence.trim(),
    );
  }
  if (input.criticContext?.checklist && input.criticContext.checklist.length > 0) {
    rubricLines.push(
      "",
      "### Independent Review Checklist",
      ...input.criticContext.checklist.map((item) => `- [ ] ${item}`),
    );
  }
  if (input.criticContext?.auditProfile === "security") {
    rubricLines.push(
      "",
      "### Security Audit Profile (Opt-In: .agents/skills/security-audit)",
      "- Trace concrete untrusted input sources to sensitive sinks (command exec, SQL, file paths, IPC, SSRF/network, deserialization, prompt injection).",
      "- Check auth/scope boundaries, secret/PII leakage into logs or storage, path traversal, and unsafe shell invocations (never PowerShell).",
      "- Every reported vulnerability MUST cite exact `file:line` and a verifiable exploit/trigger path; report unproven suspicions separately without inflating severity.",
    );
  }
  rubricLines.push("</independent_rubric>");
  return `${SHARED_PREAMBLE} ${ROLES.advisor.preamble}${description}${principles}${mandateBlock}\n\n${rubricLines.join("\n")}\n\n<author_report_untrusted>\n${input.task}\n</author_report_untrusted>`;
}

/** The whole input the subordinate gets: it sees nothing else of the conversation. */
export function buildDelegatePrompt(
  role: SubordinateRole,
  task: string,
  instructions?: string,
  globalPrinciples?: string,
  handoff?: HandoffEnvelopeV1,
  mandate?: DelegateMandate,
  criticContext?: WorkspaceDelegateCriticContext,
): string {
  if (role === "advisor" && criticContext !== undefined) {
    return buildCriticPrompt({
      task,
      instructions,
      globalPrinciples,
      handoff,
      mandate,
      criticContext,
    });
  }
  const description = instructions ? `\n\nUser's role description:\n${instructions}` : "";
  const principles = globalPrinciples ? `\n\n${globalPrinciples}` : "";
  let handoffBlock = "";
  if (handoff) {
    const check = validateHandoffEnvelope(handoff);
    if (!check.valid) {
      throw new Error(`Invalid handoff envelope: ${check.errors.join("; ")}`);
    }
    const specHash = computePinnedSpecHash({
      specId: `${handoff.owner}:${role}`,
      category: role,
      description: handoff.goal.slice(0, 500),
      steps: [...handoff.refs],
      prerequisites: [handoff.write_policy],
      doneWhen: handoff.done_when,
    });
    handoffBlock = `\n\n${formatHandoffEnvelopeForPrompt(handoff)}\n<!-- pinned_spec_hash:${specHash} -->`;
  }
  const mandateBlock = mandate ? `\n\n${formatMandateForPrompt(mandate)}` : "";
  return `${SHARED_PREAMBLE} ${ROLES[role].preamble}${description}${principles}${handoffBlock}${mandateBlock}\n\n<task>\n${task}\n</task>`;
}

/** Block title in the owner thread, e.g. "일꾼 · Codex · gpt-6-sol". */
export function delegateLabel(row: SubordinateRow): string {
  return `${ROLES[row.role].label} · ${row.account} · ${row.model}`;
}

/** Keeps the tail of a long answer, where the final report is. */
export function capDelegateText(
  text: string,
  limit = DELEGATE_TEXT_LIMIT,
): { readonly text: string; readonly omitted: number } {
  if (text.length <= limit) return { text, omitted: 0 };
  const tail = text.slice(-limit);
  // Do not start on the second half of a surrogate pair.
  const start = /^[\uDC00-\uDFFF]/.test(tail) ? 1 : 0;
  return { text: tail.slice(start), omitted: text.length - limit + start };
}

const describeChoices = (rows: ReadonlyArray<SubordinateRow>): string =>
  rows
    .map((row) => {
      const shared = rows.filter((other) => other.role === row.role).length > 1;
      return `"${shared ? row.model : row.role}" (${delegateLabel(row)}, exact to: "${subordinateAddress(row)}")`;
    })
    .join(", ");

/**
 * Picks the subordinate `to` names: its role, or its model when several rows
 * share that role. An unknown or ambiguous name is an error listing what to use.
 */
export function matchSubordinate(
  rows: ReadonlyArray<SubordinateRow>,
  to: string,
  task?: string,
): { readonly match: SubordinateRow } | { readonly error: string } {
  if (rows.length === 0)
    return { error: "이 모델에는 하위 모델이 지정되어 있지 않습니다. 작업을 직접 처리하세요." };
  const target = to.trim();
  const wanted = target.toLowerCase();
  if (wanted === "auto") {
    const available = rows.filter((row) => !row.unavailable);
    if (available.length === 0) {
      return { error: "사용 가능한 하위 모델 계정이 없습니다." };
    }
    const route = classifySmartModelRoute({
      prompt: task ?? "",
      requiresTools: true,
    });
    const best = selectBestModelFromPool(
      available.map((row) => ({
        instanceId: row.instanceId,
        model: row.model,
        isLocalZeroCost: row.model.startsWith("t3_ollama/"),
        row,
      })),
      route.tier,
    );
    return { match: best?.row ?? available[0]! };
  }
  const matches = Object.keys(ROLES).some((role) => wanted.startsWith(`${role}@`))
    ? rows.filter((row) => subordinateAddress(row) === target)
    : rows.filter((row) => row.role === wanted || row.model.toLowerCase() === wanted);
  if (matches.length === 1) {
    const row = matches[0]!;
    return row.unavailable
      ? { error: `지정한 계정이 없거나 비활성 상태입니다. ${subordinateAddress(row)}` }
      : { match: row };
  }
  return {
    error:
      matches.length > 1
        ? `"${to}"에 해당하는 하위 모델이 여러 개입니다. to에 다음 중 하나를 쓰세요: ${describeChoices(matches)}`
        : `"${to}"에 해당하는 하위 모델이 없습니다. to에 다음 중 하나를 쓰세요: ${describeChoices(rows)}`,
  };
}

export type WorkspaceDelegateCaller = Pick<
  McpInvocationScope,
  | "threadId"
  | "sessionKey"
  | "providerInstanceId"
  | "runtimeMode"
  | "interactionMode"
  | "executionCwd"
  | "delegateTeam"
  | "activeDelegateTurnId"
>;

export interface WorkspaceDelegateDependencies {
  readonly execute: WorkspaceAgentExecutor["Service"]["execute"];
  readonly queries: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadShellById" | "getProjectShellById" | "getUnfinishedDelegationBlocks"
  >;
  /** Provider runtime events: subordinate activity updates heartbeats; owner `turn.aborted`/`session.exited` stops delegations. */
  readonly events: Stream.Stream<ProviderRuntimeEvent>;
  /** Orchestration domain events: immediate cancellation on `thread.turn-interrupt-requested` / `thread.session-stop-requested`. */
  readonly domainEvents?: Stream.Stream<OrchestrationEvent> | undefined;
  /** Used to close stale restart blocks and emit background completion notifications. */
  readonly dispatch?: OrchestrationEngineShape["dispatch"] | undefined;
  /** Optional SQLite durability store (`workspace_delegations` table). */
  readonly store?: WorkspaceDelegationStore | undefined;
  /** Optional thread background liveness tracker for unified status visibility. */
  readonly liveness?: ThreadBackgroundLivenessService["Service"] | undefined;
  /** Optional Git worktree provisioner enabling `worktreeIsolation: true` for concurrent workers. */
  readonly worktreeProvision?: WorktreeProvisionService["Service"] | undefined;
  /** Optional T3 Worker Engine durable backbone (Migration 109 tasks/dispatches/mailbox/worktree). */
  readonly workerEngine?: WorkerEngineServiceShape | undefined;
  /** Optional CCR reversible output store for lossless retrieval of truncated delegation outputs. */
  readonly ccrStore?: CcrToolOutputStore | undefined;
  /** Override stall warning threshold in ms (default: 2 minutes). */
  readonly stallThresholdMs?: number | undefined;
  /** Override automatic stall/idle abort threshold in ms (default: 3 minutes). */
  readonly stallAbortMs?: number | undefined;
  /** Override hard max idle time limit in ms (alias/precedence over stallAbortMs). */
  readonly maxIdleMs?: number | undefined;
  /** Override hard max wall-clock time limit in ms (role-based defaults: 5m/10m/12m). */
  readonly maxWallTimeMs?: number | undefined;
  /** Override hard max wait/join poll rounds per delegation (default: 5). */
  readonly maxWaitRounds?: number | undefined;
  /** Override stall/limit watchdog sweep interval (default: "30 seconds"). */
  readonly sweepInterval?: Duration.Input | undefined;
}

interface Delegation {
  readonly turnId: TurnId;
  readonly activeTurnId: Effect.Effect<TurnId | undefined>;
  readonly team: NonNullable<WorkspaceDelegateCaller["delegateTeam"]>;
  /** Also the execution id of the subordinate's run. */
  readonly id: string;
  readonly batchRunId?: string | undefined;
  readonly threadId: ThreadId;
  readonly row: SubordinateRow;
  readonly taskHash: string;
  readonly mandate?: DelegateMandate | undefined;
  readonly fiber: Fiber.Fiber<string, WorkspaceAgentExecutionError>;
  readonly startedAtMs: number;
  readonly maxWallTimeMs: number;
  readonly maxWallExtensionMs: number;
  wallExtensionAppliedMs: number;
  partialOutput: string;
  waitRounds: number;
  lastActivityAtMs: number;
  lastActivityAtIso: string;
  lastToolSummary: string | null;
  lastDbHeartbeatAtMs: number;
  stalledReported: boolean;
  abortedByStall: boolean;
  limitReason?: WorkspaceDelegateLimitReason | undefined;
  limitMessage?: string | undefined;
  readonly worktreePath?: string | null | undefined;
  readonly worktreeBranch?: string | null | undefined;
  readonly workerTaskId?: string | undefined;
  readonly workerDispatchId?: string | undefined;
  readonly workerRunId?: string | undefined;
  readonly workerToActor?: string | undefined;
  delivered: boolean;
  notifyOnComplete: boolean;
}

const decodeBlock = Schema.decodeUnknownOption(Schema.fromJsonString(WorkspaceOrchestraBlock));
const isRunning = (delegation: Delegation) => delegation.fiber.pollUnsafe() === undefined;

function summarizeSubordinateEvent(event: ProviderRuntimeEvent): string | null {
  switch (event.type) {
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const title = event.payload.title?.trim();
      if (title) return title.slice(0, 120);
      return `${event.payload.itemType}:${event.payload.status ?? event.type}`;
    }
    case "content.delta":
      return "응답 생성 중";
    case "turn.started":
      return "턴 시작됨";
    default:
      return null;
  }
}

/**
 * Runs the `workspace_delegate` tool: hands tasks from the answering model of
 * a chat thread to models the user placed under it.
 *
 * Wave 0/1 guarantees:
 * - Client-safe wait budget (`DELEGATE_WAIT = 140 seconds`, override via `T3CODE_DELEGATE_WAIT_SECONDS`).
 * - Non-blocking `start` / `start_parallel` and per-item partial `wait(delegationIds)`.
 * - Thread-scoped lifetime: finishing an owner turn (`turn.completed`) does NOT kill
 *   running delegations, so the next turn in the same thread can collect them; only
 *   `turn.aborted`, `session.exited`, `cancel`, stall auto-abort, or server shutdown stops them.
 * - Optional SQLite durability (`workspace_delegations`) distinguishes `interrupted_by_restart`
 *   from unknown IDs and allows one-time recovery of settled results.
 * - ForemanMonitor stall detection (5m `stalled`, 15m auto-interrupt), task-hash deduplication,
 *   and ActiveWorkTracker registration to protect against mid-flight restarts.
 */
export const makeWorkspaceDelegate = Effect.fn("makeWorkspaceDelegate")(function* (
  deps: WorkspaceDelegateDependencies,
) {
  const scope = yield* Effect.scope;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const bootedAt = yield* nowIso;
  const stallAbortMs = deps.maxIdleMs ?? deps.stallAbortMs ?? DELEGATE_STALL_ABORT_MS;
  const stallThresholdMs =
    deps.stallThresholdMs ??
    (deps.maxIdleMs !== undefined
      ? Math.min(DELEGATE_STALL_THRESHOLD_MS, Math.max(1_000, Math.floor(stallAbortMs * 0.67)))
      : DELEGATE_STALL_THRESHOLD_MS);
  const maxWaitRounds = deps.maxWaitRounds ?? DELEGATE_MAX_WAIT_ROUNDS;
  const sweepInterval = deps.sweepInterval ?? "30 seconds";
  const delegations = new Map<string, Delegation>();
  const batchMembers = new Map<string, ReadonlyArray<string>>();

  const ofThread = (threadId: ThreadId) =>
    [...delegations.values()].filter((delegation) => delegation.threadId === threadId);

  const isOwnedByCaller = (delegation: Delegation, caller: WorkspaceDelegateCaller): boolean =>
    delegation.threadId === caller.threadId &&
    delegation.team.answeringInstanceId === caller.providerInstanceId;

  const evaluateStall = (delegation: Delegation, nowMs: number) => {
    const snapshot = evaluateForemanIndicators({
      nowMs,
      lastEventAtMs: delegation.lastActivityAtMs,
      hasPendingUserQuestion: false,
      hasPendingHostApproval: false,
      hasIncompleteWork: isRunning(delegation),
      thresholds: {
        stallMinutes: stallThresholdMs / 60_000,
      },
    });
    const stallIndicator = snapshot.indicators.find((item) => item.id === "stall");
    const stalled = stallIndicator?.state === "fired";
    const silentMs = Math.max(0, nowMs - delegation.lastActivityAtMs);
    return { stalled, silentMs, summary: stallIndicator?.summary ?? "" };
  };

  const describeDelegation = (delegation: Delegation, nowMs: number) => {
    if (!isRunning(delegation)) {
      return `${delegation.id} (${delegation.row.role} · ${delegation.row.model}, 종료, 결과 미수령)`;
    }
    const { stalled, silentMs } = evaluateStall(delegation, nowMs);
    const tail = delegation.lastToolSummary ? `, 최근: ${delegation.lastToolSummary}` : "";
    return `${delegation.id} (${delegation.row.role} · ${delegation.row.model}, ${
      stalled ? `멈춤 의심 ${Math.floor(silentMs / 60_000)}분` : "실행 중"
    }${tail})`;
  };

  // Server shutdown finalizer: interrupt all live delegation fibers cleanly so
  // no orphaned subordinate subprocess survives for 12~19 minutes.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const live = [...delegations.values()];
      delegations.clear();
      for (const delegation of live) {
        unifiedExecutionLedger.finish({
          executionId: delegation.id,
          executionKind: "workspace_delegate",
          status: "interrupted_by_restart",
          errorMessage: "서버 종료로 인해 위임이 중단되었습니다.",
        });
        deps.liveness?.recordTaskLiveness({
          threadId: delegation.threadId,
          taskId: delegation.id,
          taskType: "workspace_delegate",
          status: "interrupted",
          kind: "completed",
        });
      }
      if (live.length > 0) {
        yield* Effect.forEach(
          live,
          (delegation) =>
            Effect.gen(function* () {
              if (deps.workerEngine && delegation.workerDispatchId) {
                yield* deps.workerEngine
                  .stop({
                    dispatchId: delegation.workerDispatchId,
                    reason: "서버 종료로 인해 위임이 중단되었습니다.",
                  })
                  .pipe(Effect.ignore);
              }
              yield* Fiber.interrupt(delegation.fiber).pipe(Effect.ignore);
            }),
          { concurrency: "unbounded", discard: true },
        );
      }
    }),
  );

  // Runtime event observer:
  // 1) Subordinate events update activity heartbeat & tool summary (prevents false stall).
  // 2) Owner thread `turn.aborted` / `session.exited` stops live delegations.
  //    Owner `turn.completed` intentionally KEEPS delegations alive across turns (thread lifetime).
  yield* forkParked(
    Stream.runForEach(deps.events, (event) =>
      Effect.gen(function* () {
        if (event.execution !== undefined) {
          const target = delegations.get(event.execution.executionId);
          if (!target) return;
          const nowMs = yield* Clock.currentTimeMillis;
          target.lastActivityAtMs = nowMs;
          target.lastActivityAtIso = event.createdAt;
          target.stalledReported = false;
          const summary = summarizeSubordinateEvent(event);
          if (summary) target.lastToolSummary = summary;
          deps.liveness?.recordTaskLiveness({
            threadId: target.threadId,
            taskId: target.id,
            taskType: "workspace_delegate",
            status: "running",
            provider: event.provider,
            turnId: target.turnId,
            title: delegateLabel(target.row),
            ...(summary ? { logTail: summary } : {}),
            kind: "progress",
            nowMs,
          });
          if (deps.workerEngine && target.workerDispatchId) {
            yield* deps.workerEngine
              .touchActivity(target.workerDispatchId, target.lastToolSummary)
              .pipe(Effect.ignore);
          }
          if (deps.store && nowMs - target.lastDbHeartbeatAtMs >= DB_HEARTBEAT_DEBOUNCE_MS) {
            target.lastDbHeartbeatAtMs = nowMs;
            yield* deps.store.updateActivity({
              delegationId: target.id,
              lastActivityAt: event.createdAt,
              lastToolSummary: target.lastToolSummary,
              status: "running",
            });
          }
          return;
        }

        const isInterruptedTurnCompletion =
          event.type === "turn.completed" &&
          (event.payload.state === "cancelled" || event.payload.state === "interrupted");
        if (
          event.type !== "turn.aborted" &&
          event.type !== "session.exited" &&
          !isInterruptedTurnCompletion
        ) {
          return;
        }

        yield* Effect.forEach(
          ofThread(event.threadId),
          (delegation) =>
            Effect.gen(function* () {
              if (
                event.providerInstanceId !== undefined &&
                event.providerInstanceId !== delegation.team.answeringInstanceId
              ) {
                return;
              }
              if (!isInterruptedTurnCompletion) {
                const hasTurnId = event.type !== "session.exited" && event.turnId !== undefined;
                if (hasTurnId && event.turnId !== delegation.turnId) return;
                // Exits carry no session generation. For an exit or a terminal event
                // missing identity, re-check the captured credential and native turn.
                if (
                  (!hasTurnId || event.providerInstanceId === undefined) &&
                  (yield* delegation.activeTurnId) === delegation.turnId
                ) {
                  return;
                }
              }
              delegations.delete(delegation.id);
              unifiedExecutionLedger.finish({
                executionId: delegation.id,
                executionKind: "workspace_delegate",
                status: "cancelled",
                errorMessage: "부모 턴 종료로 인해 위임이 중단되었습니다.",
              });
              deps.liveness?.recordTaskLiveness({
                threadId: delegation.threadId,
                taskId: delegation.id,
                taskType: "workspace_delegate",
                status: "cancelled",
                kind: "completed",
              });
              if (deps.workerEngine && delegation.workerDispatchId) {
                yield* Effect.forkIn(
                  deps.workerEngine
                    .stop({
                      dispatchId: delegation.workerDispatchId,
                      reason: "부모 턴 종료로 인해 위임이 중단되었습니다.",
                    })
                    .pipe(Effect.ignore),
                  scope,
                );
              }
              yield* Effect.forkIn(Fiber.interrupt(delegation.fiber), scope);
            }),
          { discard: true },
        );
      }),
    ),
    { startImmediately: true },
  );

  if (deps.domainEvents) {
    yield* forkParked(
      Stream.runForEach(deps.domainEvents, (event) =>
        Effect.gen(function* () {
          if (
            event.type !== "thread.turn-interrupt-requested" &&
            event.type !== "thread.session-stop-requested"
          ) {
            return;
          }
          if (
            event.type === "thread.turn-interrupt-requested" &&
            event.payload.questionRequestId !== undefined
          ) {
            return;
          }
          const targetThreadId = event.payload.threadId;
          const liveOnThread = ofThread(targetThreadId);
          if (liveOnThread.length === 0) return;
          yield* Effect.forEach(
            liveOnThread,
            (delegation) =>
              Effect.gen(function* () {
                delegations.delete(delegation.id);
                unifiedExecutionLedger.finish({
                  executionId: delegation.id,
                  executionKind: "workspace_delegate",
                  status: "cancelled",
                  errorMessage: "사용자 정지 요청으로 하위 모델 위임이 즉시 중단되었습니다.",
                });
                deps.liveness?.recordTaskLiveness({
                  threadId: delegation.threadId,
                  taskId: delegation.id,
                  taskType: "workspace_delegate",
                  status: "cancelled",
                  kind: "completed",
                });
                if (deps.workerEngine && delegation.workerDispatchId) {
                  yield* Effect.forkIn(
                    deps.workerEngine
                      .stop({
                        dispatchId: delegation.workerDispatchId,
                        reason: "사용자 정지 요청으로 하위 모델 위임이 즉시 중단되었습니다.",
                      })
                      .pipe(Effect.ignore),
                    scope,
                  );
                }
                yield* Effect.forkIn(Fiber.interrupt(delegation.fiber), scope);
              }),
            { discard: true },
          );
        }),
      ),
      { startImmediately: true },
    );
  }

  const enforceDelegationLimit = (
    delegation: Delegation,
    limitReason: WorkspaceDelegateLimitReason,
    detailMessage: string,
    nowMs: number,
    currentIso: string,
  ) =>
    Effect.gen(function* () {
      if (delegation.limitReason) return;
      delegation.limitReason = limitReason;
      delegation.limitMessage = detailMessage;
      if (limitReason === "max_idle") {
        delegation.abortedByStall = true;
      }
      unifiedExecutionLedger.finish({
        executionId: delegation.id,
        executionKind: "workspace_delegate",
        status:
          limitReason === "max_wall_time" || limitReason === "max_idle" ? "failed" : "cancelled",
        errorMessage: detailMessage,
      });
      serverSelfSignals.recordDelegationEvent("limit_hit");
      const elapsedSec = Math.max(0, Math.round((nowMs - delegation.startedAtMs) / 1_000));
      const preservedPartial = delegation.partialOutput.trim();
      yield* Effect.logWarning("delegation.limit.hit", {
        threadId: delegation.threadId,
        turnId: delegation.turnId,
        delegationId: delegation.id,
        ...(delegation.batchRunId ? { batchRunId: delegation.batchRunId } : {}),
        role: delegation.row.role,
        model: delegation.row.model,
        limitReason,
        elapsedSec,
        waitRounds: delegation.waitRounds,
        partialOutputChars: preservedPartial.length,
        message: detailMessage,
      });
      if (deps.workerEngine && delegation.workerDispatchId) {
        yield* Effect.forkIn(
          deps.workerEngine
            .stop({
              dispatchId: delegation.workerDispatchId,
              reason: detailMessage,
            })
            .pipe(Effect.ignore),
          scope,
        );
      }
      yield* Effect.forkIn(Fiber.interrupt(delegation.fiber), scope);
      if (deps.store) {
        yield* deps.store.settle({
          delegationId: delegation.id,
          status: "limit_exceeded",
          ...(preservedPartial ? { resultText: preservedPartial } : {}),
          errorMessage: detailMessage,
          finishedAt: currentIso,
        });
      }
      if (deps.dispatch) {
        yield* deps
          .dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`delegate-limit:${delegation.id}`),
            threadId: delegation.threadId,
            createdAt: currentIso,
            activity: {
              id: EventId.make(`delegate-limit:${delegation.id}`),
              kind: "delegation.limit.hit",
              tone: "error",
              summary: `위임 한도 도달(${limitReason}): ${delegateLabel(delegation.row)}`,
              payload: {
                threadId: delegation.threadId,
                turnId: delegation.turnId,
                delegationId: delegation.id,
                ...(delegation.batchRunId ? { batchRunId: delegation.batchRunId } : {}),
                role: delegation.row.role,
                model: delegation.row.model,
                limitReason,
                elapsedSec,
                waitRounds: delegation.waitRounds,
                message: detailMessage,
              },
              turnId: delegation.turnId,
              createdAt: currentIso,
            },
          })
          .pipe(Effect.ignoreCause({ log: false }));
      }
    });

  // Stall & wall-time watchdog: enforces hard exit limits (#1 maxWallTimeMs, #2 maxIdleMs).
  const sweepStalledDelegations = Effect.gen(function* () {
    if (delegations.size === 0) return;
    const nowMs = yield* Clock.currentTimeMillis;
    const currentIso = yield* nowIso;
    for (const delegation of [...delegations.values()]) {
      if (!isRunning(delegation) || delegation.limitReason) continue;
      const elapsedMs = Math.max(0, nowMs - delegation.startedAtMs);
      const { stalled, silentMs } = evaluateStall(delegation, nowMs);
      const effectiveWallLimitMs = delegation.maxWallTimeMs + delegation.wallExtensionAppliedMs;
      if (elapsedMs >= effectiveWallLimitMs) {
        const streamingWindowMs = Math.max(
          1_000,
          Math.min(60_000, Math.floor(delegation.maxWallTimeMs / 2)),
        );
        const activelyStreaming =
          delegation.lastActivityAtMs > delegation.startedAtMs &&
          silentMs < streamingWindowMs &&
          delegation.wallExtensionAppliedMs < delegation.maxWallExtensionMs;
        if (activelyStreaming) {
          delegation.wallExtensionAppliedMs += Math.min(
            streamingWindowMs,
            delegation.maxWallExtensionMs - delegation.wallExtensionAppliedMs,
          );
          continue;
        }
        const partialLen = delegation.partialOutput.trim().length;
        yield* enforceDelegationLimit(
          delegation,
          "max_wall_time",
          `시간 초과 실패: 하위 모델 실행이 최대 허용 시간(${Math.round(effectiveWallLimitMs / 1_000)}초)을 초과했습니다.${partialLen > 0 ? ` (부분 출력 ${partialLen}자 보존됨)` : ""}`,
          nowMs,
          currentIso,
        );
        continue;
      }
      if (silentMs >= stallAbortMs) {
        const partialLen = delegation.partialOutput.trim().length;
        yield* enforceDelegationLimit(
          delegation,
          "max_idle",
          `시간 초과 실패: 하위 모델이 ${Math.max(1, Math.round(silentMs / 1_000))}초 이상 활동이 없었습니다.${partialLen > 0 ? ` (부분 출력 ${partialLen}자 보존됨)` : ""}`,
          nowMs,
          currentIso,
        );
      } else if (stalled && !delegation.stalledReported) {
        delegation.stalledReported = true;
        if (deps.store) {
          yield* deps.store.updateActivity({
            delegationId: delegation.id,
            lastActivityAt: delegation.lastActivityAtIso,
            lastToolSummary: delegation.lastToolSummary,
            status: "stalled",
          });
        }
      }
    }
  });

  yield* forkParked(
    Effect.forever(Effect.sleep(sweepInterval).pipe(Effect.andThen(sweepStalledDelegations))),
    { startImmediately: true },
  );

  // A restart loses the in-memory fibers: mark pre-boot DB rows as `interrupted_by_restart`
  // and close any unfinished timeline blocks left behind by the previous process.
  const closeStaleBlocks = Effect.gen(function* () {
    const createdAt = yield* nowIso;
    if (deps.store) {
      yield* deps.store.markInterruptedBeforeBoot(bootedAt, createdAt);
    }
    const dispatch = deps.dispatch;
    if (!deps.queries.getUnfinishedDelegationBlocks || !dispatch) return;
    for (const row of yield* deps.queries.getUnfinishedDelegationBlocks()) {
      const block = Option.getOrUndefined(decodeBlock(row.payload));
      // Only blocks from before this process started are leftovers; a later one
      // belongs to a delegation of this process, whatever the map says by now.
      if (!block || row.createdAt >= bootedAt || delegations.has(block.executionId)) continue;
      const threadId = ThreadId.make(row.threadId);
      const blockKey = `${block.executionId}:${block.attempt}`;
      const closedAt = yield* nowIso;
      yield* dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`delegate-stale:${blockKey}`),
        threadId,
        createdAt: closedAt,
        activity: {
          id: EventId.make(`orchestra-block:${blockKey}`),
          kind: "orchestra.block",
          tone: "info",
          summary: "서버 재시작으로 중단된 하위 모델 작업",
          payload: { ...block, status: "cancelled" },
          turnId: null,
          createdAt: row.createdAt,
        },
      }).pipe(
        Effect.andThen(
          dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.make(`delegate-stale-note:${blockKey}`),
            threadId,
            messageId: block.messageId,
            delta: "\n\n실행 중단: 서버 재시작으로 중단되었습니다.",
            createdAt: closedAt,
          }),
        ),
        Effect.andThen(
          dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make(`orchestra-complete:${blockKey}`),
            threadId,
            messageId: block.messageId,
            createdAt: closedAt,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not close a delegation block left by a restart", {
            executionId: block.executionId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not look for delegation blocks left by a restart", {
        cause: Cause.pretty(cause),
      }),
    ),
  );
  yield* forkParked(closeStaleBlocks);

  const settingsOption = yield* Effect.serviceOption(ServerSettingsService);
  const readSubordinatePrinciples = Effect.gen(function* () {
    if (Option.isNone(settingsOption)) return undefined;
    const settings = yield* settingsOption.value.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!settings) return undefined;
    const effective = resolveEffectiveGlobalAssistant(settings);
    return compileGlobalAssistantPrompts(effective).subordinatePrinciplesBlock;
  });

  const invoke = Effect.fn("WorkspaceDelegate.invoke")(function* (
    caller: WorkspaceDelegateCaller,
    input: WorkspaceDelegateInput,
  ): Effect.fn.Return<WorkspaceDelegateResult, WorkspaceDelegateError> {
    // A subordinate (or an orchestra participant) shares its owner's thread id
    // but runs under its own session key. It gets no subordinates of its own.
    const nested = caller.sessionKey !== undefined && caller.sessionKey !== caller.threadId;
    const thread = yield* deps.queries
      .getThreadShellById(caller.threadId)
      .pipe(
        Effect.mapError(
          () => new WorkspaceDelegateError({ message: "현재 대화를 확인하지 못했습니다." }),
        ),
      );
    const team = caller.delegateTeam;
    const activeTurnId =
      !nested &&
      team?.threadId === caller.threadId &&
      team.answeringInstanceId === caller.providerInstanceId
        ? caller.activeDelegateTurnId
        : undefined;
    const turnId = activeTurnId ? yield* activeTurnId : undefined;
    yield* Effect.annotateCurrentSpan({
      "t3.thread_id": caller.threadId,
      "t3.provider_instance_id": caller.providerInstanceId,
      "t3.delegate_action": input.action,
      ...(turnId ? { "t3.turn_id": turnId } : {}),
      ...(input.delegationId ? { "t3.delegation_id": input.delegationId } : {}),
      ...(input.batchRunId ? { "t3.batch_run_id": input.batchRunId } : {}),
    });
    const active = turnId !== undefined;
    const rows = active && team ? team.members : [];
    const subordinates: ReadonlyArray<WorkspaceDelegateSubordinate> = rows.map((row) => {
      const cooldownReason = getUnavailableModelReason(row.instanceId, row.model);
      return {
        role: row.role,
        account: row.account,
        instanceId: row.instanceId,
        model: row.model,
        ...(row.unavailable || cooldownReason ? { unavailable: true as const } : {}),
      };
    });
    const answer = (fields: Partial<WorkspaceDelegateResult>): WorkspaceDelegateResult => ({
      subordinates,
      status: null,
      delegationId: null,
      text: null,
      message: null,
      ...fields,
    });
    const fail = (message: string) => new WorkspaceDelegateError({ message });
    const nestedMessage =
      "하위 모델로 실행 중인 세션은 다른 모델에게 작업을 넘길 수 없습니다. 작업을 직접 처리하세요.";
    const waitDuration = resolveDelegateWaitDuration(input.waitTimeoutSec);

    /** Acknowledges any unread WorkerEngine mailbox delivery belonging to a delegation. */
    const ackWorkerDelivery = (delegation: Delegation) =>
      Effect.gen(function* () {
        if (!deps.workerEngine || !delegation.workerRunId || !delegation.workerToActor) return;
        const checked = yield* deps.workerEngine
          .check({
            runId: delegation.workerRunId,
            toActor: delegation.workerToActor,
            wait: false,
            limit: 20,
          })
          .pipe(Effect.orElseSucceed(() => null));
        if (checked?.deliveryId) {
          yield* deps.workerEngine.ack({ deliveryId: checked.deliveryId }).pipe(Effect.ignore);
        }
      });

    /** Resolves an ID not present in memory by consulting WorkerEngine (1st) and legacy store (2nd). */
    const lookupPersistedFallback = (
      delegationId: string,
      textLimit: number,
    ): Effect.Effect<WorkspaceDelegateBatchItemResult | null> =>
      Effect.gen(function* () {
        if (deps.workerEngine) {
          const dispatch = yield* deps.workerEngine
            .getDispatch(delegationId)
            .pipe(Effect.orElseSucceed(() => null));
          if (dispatch && dispatch.threadId === caller.threadId) {
            const task = yield* deps.workerEngine
              .getTask(dispatch.taskId)
              .pipe(Effect.orElseSucceed(() => null));
            const to = `${dispatch.role}@${dispatch.providerInstanceId}:${dispatch.model ?? "default"}`;
            const worktreeFields =
              task && task.worktreePath
                ? {
                    worktreePath: task.worktreePath,
                    worktreeBranch: task.worktreeBranch,
                  }
                : {};
            const lastActivityAt = DateTime.formatIso(
              DateTime.makeUnsafe(dispatch.lastHeartbeatAtMs),
            );
            if (dispatch.status === "interrupted_by_restart") {
              return {
                to,
                status: "interrupted_by_restart" as const,
                delegationId: dispatch.dispatchId,
                text: null,
                message:
                  dispatch.errorMessage ??
                  (task?.worktreePath
                    ? `서버 재시작으로 중단된 위임입니다. worktree(${task.worktreePath})가 보존되어 있습니다.`
                    : "서버 재시작으로 중단된 위임입니다. 필요하면 새 위임을 시작하세요."),
                lastActivityAt,
                lastToolSummary: dispatch.lastToolSummary,
                ...worktreeFields,
              };
            }
            if (
              dispatch.status === "completed" ||
              dispatch.status === "failed" ||
              dispatch.status === "cancelled"
            ) {
              const mailboxRunId = task?.runId ?? dispatch.runId;
              const checked = yield* deps.workerEngine
                .check({
                  runId: mailboxRunId,
                  toActor: `delegate:${dispatch.dispatchId}`,
                  wait: false,
                  limit: 20,
                })
                .pipe(Effect.orElseSucceed(() => null));
              if (checked && checked.deliveryId && checked.messages.length > 0) {
                yield* deps.workerEngine
                  .ack({ deliveryId: checked.deliveryId })
                  .pipe(Effect.ignore);
                if (dispatch.status === "completed" && dispatch.resultText) {
                  const capped = capDelegateText(dispatch.resultText, textLimit);
                  return {
                    to,
                    status: "completed" as const,
                    delegationId: dispatch.dispatchId,
                    text: capped.text,
                    message:
                      capped.omitted > 0
                        ? `응답이 길어 앞부분 ${capped.omitted}자를 생략하고 끝부분만 전달합니다.`
                        : null,
                    lastActivityAt,
                    lastToolSummary: dispatch.lastToolSummary,
                    ...worktreeFields,
                  };
                }
                return {
                  to,
                  status:
                    dispatch.status === "cancelled" ? ("cancelled" as const) : ("failed" as const),
                  delegationId: dispatch.dispatchId,
                  text: null,
                  message: dispatch.errorMessage ?? "위임 결과가 비어 있거나 중단되었습니다.",
                  lastActivityAt,
                  lastToolSummary: dispatch.lastToolSummary,
                  ...worktreeFields,
                };
              }
            }
          }
        }
        if (!deps.store) return null;
        const persisted = yield* deps.store.getById(delegationId);
        if (!persisted || persisted.threadId !== caller.threadId) return null;
        const to = `${persisted.role}@${persisted.targetInstanceId}:${persisted.targetModel}`;
        if (persisted.status === "interrupted_by_restart") {
          return {
            to,
            status: "interrupted_by_restart",
            delegationId: persisted.delegationId,
            text: null,
            message:
              persisted.errorMessage ??
              "서버 재시작으로 중단된 위임입니다. 필요하면 새 위임을 시작하세요.",
            lastActivityAt: persisted.lastActivityAt,
            lastToolSummary: persisted.lastToolSummary,
          };
        }
        if (
          persisted.deliveredAt === null &&
          (persisted.status === "completed" ||
            persisted.status === "failed" ||
            persisted.status === "cancelled" ||
            persisted.status === "limit_exceeded")
        ) {
          const deliveredAt = yield* nowIso;
          yield* deps.store.markDelivered(persisted.delegationId, deliveredAt);
          if (persisted.status === "completed" && persisted.resultText) {
            const capped = capDelegateText(persisted.resultText, textLimit);
            return {
              to,
              status: "completed",
              delegationId: persisted.delegationId,
              text: capped.text,
              message:
                capped.omitted > 0
                  ? `응답이 길어 앞부분 ${capped.omitted}자를 생략하고 끝부분만 전달합니다.`
                  : null,
              lastActivityAt: persisted.lastActivityAt,
              lastToolSummary: persisted.lastToolSummary,
            };
          }
          return {
            to,
            status: persisted.status,
            delegationId: persisted.delegationId,
            text: null,
            message: persisted.errorMessage ?? "위임 결과가 비어 있거나 중단되었습니다.",
            lastActivityAt: persisted.lastActivityAt,
            lastToolSummary: persisted.lastToolSummary,
          };
        }
        return null;
      });

    /** Waits for a delegation up to `waitDuration` and hands its settled outcome over once. */
    const collectItem = (
      delegation: Delegation,
      textLimit = DELEGATE_TEXT_LIMIT,
      deduplicated = false,
    ): Effect.Effect<WorkspaceDelegateBatchItemResult, WorkspaceDelegateError> =>
      Fiber.await(delegation.fiber).pipe(
        Effect.timeoutOption(waitDuration),
        Effect.flatMap((outcome) =>
          Effect.gen(function* () {
            if (delegations.get(delegation.id) !== delegation || delegation.delivered) {
              return yield* fail("이미 결과를 수령했거나 중단된 위임입니다.");
            }
            const to = subordinateAddress(delegation.row);
            const nowMs = yield* Clock.currentTimeMillis;
            const elapsedSec = Math.max(0, Math.round((nowMs - delegation.startedAtMs) / 1_000));
            if (delegation.limitReason) {
              delegation.delivered = true;
              delegations.delete(delegation.id);
              yield* ackWorkerDelivery(delegation);
              if (deps.store) {
                yield* deps.store.markDelivered(delegation.id, yield* nowIso);
              }
              const preserved = delegation.partialOutput.trim();
              const preservedText = preserved ? capDelegateText(preserved, textLimit).text : null;
              return {
                to,
                status: "limit_exceeded" as const,
                delegationId: delegation.id,
                text: preservedText,
                message:
                  delegation.limitMessage ??
                  `위임 종료 한도(${delegation.limitReason})에 도달하여 시간 초과 실패로 종료되었습니다.`,
                ...(deduplicated ? { deduplicated: true } : {}),
                lastActivityAt: delegation.lastActivityAtIso,
                lastToolSummary: delegation.lastToolSummary,
                elapsedSec,
                remainingWaitRounds: Math.max(0, maxWaitRounds - delegation.waitRounds),
                limitReason: delegation.limitReason,
              };
            }
            if (Option.isNone(outcome)) {
              // Check wall-time and wait-round exit limits immediately on wait timeout.
              delegation.waitRounds += 1;
              const remainingWaitRounds = Math.max(0, maxWaitRounds - delegation.waitRounds);
              const elapsedMs = Math.max(0, nowMs - delegation.startedAtMs);
              const { silentMs: currentSilentMs } = evaluateStall(delegation, nowMs);
              const effectiveWallLimitMs =
                delegation.maxWallTimeMs + delegation.wallExtensionAppliedMs;
              const streamingWindowMs = Math.max(
                1_000,
                Math.min(60_000, Math.floor(delegation.maxWallTimeMs / 2)),
              );
              const activelyStreaming =
                delegation.lastActivityAtMs > delegation.startedAtMs &&
                currentSilentMs < streamingWindowMs &&
                delegation.wallExtensionAppliedMs < delegation.maxWallExtensionMs;
              if (elapsedMs >= effectiveWallLimitMs && activelyStreaming) {
                delegation.wallExtensionAppliedMs += Math.min(
                  streamingWindowMs,
                  delegation.maxWallExtensionMs - delegation.wallExtensionAppliedMs,
                );
              } else if (elapsedMs >= effectiveWallLimitMs) {
                const currentIso = yield* nowIso;
                const preserved = delegation.partialOutput.trim();
                yield* enforceDelegationLimit(
                  delegation,
                  "max_wall_time",
                  `시간 초과 실패: 하위 모델 실행이 최대 허용 시간(${Math.round(effectiveWallLimitMs / 1_000)}초)을 초과했습니다.${preserved ? ` (부분 출력 ${preserved.length}자 보존됨)` : ""}`,
                  nowMs,
                  currentIso,
                );
                delegation.delivered = true;
                delegations.delete(delegation.id);
                if (deps.store) {
                  yield* deps.store.markDelivered(delegation.id, currentIso);
                }
                return {
                  to,
                  status: "limit_exceeded" as const,
                  delegationId: delegation.id,
                  text: preserved ? capDelegateText(preserved, textLimit).text : null,
                  message:
                    delegation.limitMessage ??
                    "시간 초과 실패: 최대 실행 시간 한도를 초과했습니다.",
                  ...(deduplicated ? { deduplicated: true } : {}),
                  lastActivityAt: delegation.lastActivityAtIso,
                  lastToolSummary: delegation.lastToolSummary,
                  elapsedSec,
                  remainingWaitRounds: 0,
                  limitReason: "max_wall_time" as const,
                };
              }
              if (delegation.waitRounds >= maxWaitRounds) {
                const currentIso = yield* nowIso;
                yield* enforceDelegationLimit(
                  delegation,
                  "max_wait_rounds",
                  `동일 위임에 대한 최대 대기 라운드(${maxWaitRounds}회)에 도달하여 자동 중단되었습니다. 범위를 더 작게 나누어 재위임하세요.`,
                  nowMs,
                  currentIso,
                );
                delegation.delivered = true;
                delegations.delete(delegation.id);
                if (deps.store) {
                  yield* deps.store.markDelivered(delegation.id, currentIso);
                }
                return {
                  to,
                  status: "limit_exceeded" as const,
                  delegationId: delegation.id,
                  text: null,
                  message:
                    delegation.limitMessage ??
                    `최대 대기 라운드(${maxWaitRounds}회) 초과로 자동 중단되었습니다.`,
                  ...(deduplicated ? { deduplicated: true } : {}),
                  lastActivityAt: delegation.lastActivityAtIso,
                  lastToolSummary: delegation.lastToolSummary,
                  elapsedSec,
                  remainingWaitRounds: 0,
                  limitReason: "max_wait_rounds" as const,
                };
              }
              // Promote to background completion push notification once a wait times out.
              delegation.notifyOnComplete = true;
              const { stalled, silentMs } = evaluateStall(delegation, nowMs);
              const status: WorkspaceDelegateItemStatus = stalled ? "stalled" : "running";
              const minutesSilent = Math.floor(silentMs / 60_000);
              const message = stalled
                ? `멈춤 의심(${minutesSilent}분 무활동, 경과 ${elapsedSec}초, 남은 대기 ${remainingWaitRounds}회${delegation.lastToolSummary ? `, 마지막 활동: ${delegation.lastToolSummary}` : ""}). action="wait"/"join"으로 더 기다리거나 action="cancel" 후 재위임하세요.`
                : `아직 실행 중입니다(경과 ${elapsedSec}초, 남은 대기 ${remainingWaitRounds}회${delegation.lastToolSummary ? `, 최근: ${delegation.lastToolSummary}` : ""}). action="wait" 또는 action="join"으로 결과를 수집하세요.`;
              return {
                to,
                status,
                delegationId: delegation.id,
                text: null,
                message,
                ...(deduplicated ? { deduplicated: true } : {}),
                lastActivityAt: delegation.lastActivityAtIso,
                lastToolSummary: delegation.lastToolSummary,
                elapsedSec,
                remainingWaitRounds,
              };
            }
            const exit = outcome.value;
            delegation.delivered = true;
            delegations.delete(delegation.id);
            yield* ackWorkerDelivery(delegation);
            if (deps.store) {
              yield* deps.store.markDelivered(delegation.id, yield* nowIso);
            }
            if (Exit.isSuccess(exit)) {
              if (!exit.value.trim()) {
                return {
                  to,
                  status: "failed" as const,
                  delegationId: delegation.id,
                  text: null,
                  message: "하위 모델이 배정된 작업의 결과를 반환하지 않았습니다.",
                  ...(deduplicated ? { deduplicated: true } : {}),
                  lastActivityAt: delegation.lastActivityAtIso,
                  lastToolSummary: delegation.lastToolSummary,
                };
              }
              const capped = capDelegateText(exit.value, textLimit);
              let cappedMessage: string | null =
                capped.omitted > 0
                  ? `응답이 길어 앞부분 ${capped.omitted}자를 생략하고 끝부분만 전달합니다.`
                  : null;
              if (capped.omitted > 0 && deps.ccrStore) {
                const ccr = yield* deps.ccrStore.compressAndStore({
                  threadId: delegation.threadId,
                  toolName: `workspace_delegate.${delegation.row.role}`,
                  rawText: exit.value,
                  mimeHint: "text",
                  options: { minBytes: 1 },
                });
                if (ccr.compressed && ccr.retrieveHint) {
                  cappedMessage = `${cappedMessage} ${ccr.retrieveHint}`;
                }
              }
              return {
                to,
                status: "completed" as const,
                delegationId: delegation.id,
                text: capped.text,
                message: cappedMessage,
                ...(deduplicated ? { deduplicated: true } : {}),
                lastActivityAt: delegation.lastActivityAtIso,
                lastToolSummary: delegation.lastToolSummary,
                ...(delegation.worktreePath !== undefined
                  ? { worktreePath: delegation.worktreePath }
                  : {}),
                ...(delegation.worktreeBranch !== undefined
                  ? { worktreeBranch: delegation.worktreeBranch }
                  : {}),
              };
            }
            const error = Cause.squash(exit.cause);
            const known = error instanceof WorkspaceAgentExecutionError ? error : undefined;
            const isTimedOut =
              known?.timedOut === true || (known?.message?.includes("시간 초과") ?? false);
            const cancelled =
              !isTimedOut && (Cause.hasInterruptsOnly(exit.cause) || known?.interrupted === true);
            const rawErrMsg =
              known?.message ??
              (delegation.abortedByStall
                ? "시간 초과 실패: 하위 모델이 장시간 활동이 없어 종료되었습니다."
                : cancelled
                  ? "위임이 중단되었습니다."
                  : Cause.pretty(exit.cause));
            const formattedErrMsg = isNonRetryableBillingError(rawErrMsg)
              ? formatBillingErrorMessage(rawErrMsg)
              : rawErrMsg;
            const preserved = (known?.partialOutput ?? delegation.partialOutput).trim();
            return {
              to,
              status: (cancelled ? "cancelled" : "failed") as "cancelled" | "failed",
              delegationId: delegation.id,
              text: preserved ? capDelegateText(preserved, textLimit).text : null,
              message: formattedErrMsg,
              ...(deduplicated ? { deduplicated: true } : {}),
              lastActivityAt: delegation.lastActivityAtIso,
              lastToolSummary: delegation.lastToolSummary,
            };
          }),
        ),
      );

    const collect = (delegation: Delegation, deduplicated = false) =>
      collectItem(delegation, DELEGATE_TEXT_LIMIT, deduplicated).pipe(
        Effect.map((item) =>
          answer({
            status: item.status,
            delegationId: item.delegationId,
            text: item.text,
            message: item.message,
            ...(item.worktreePath !== undefined ? { worktreePath: item.worktreePath } : {}),
            ...(item.worktreeBranch !== undefined ? { worktreeBranch: item.worktreeBranch } : {}),
          }),
        ),
      );

    const summarizeBatch = (
      results: ReadonlyArray<WorkspaceDelegateBatchItemResult>,
      batchRunId?: string,
    ): WorkspaceDelegateResult => {
      const counts: WorkspaceDelegateBatchCounts = {
        total: results.length,
        completed: results.filter((item) => item.status === "completed").length,
        running: results.filter((item) => item.status === "running").length,
        stalled: results.filter((item) => item.status === "stalled").length,
        failed: results.filter((item) => item.status === "failed").length,
        cancelled: results.filter((item) => item.status === "cancelled").length,
        limitExceeded: results.filter((item) => item.status === "limit_exceeded").length,
        interruptedByRestart: results.filter((item) => item.status === "interrupted_by_restart")
          .length,
        notFound: results.filter((item) => item.status === "not_found").length,
      };
      const hasStalled = counts.stalled > 0;
      const unresolvedIds = results
        .filter((item) => item.status === "running" || item.status === "stalled")
        .map((item) => item.delegationId);
      const hasRunning = unresolvedIds.length > 0;
      const allSettled = !hasRunning;
      const allCompleted = results.length > 0 && counts.completed === results.length;
      const allCancelled = results.length > 0 && counts.cancelled === results.length;
      const allLimitExceeded = results.length > 0 && counts.limitExceeded === results.length;
      const allInterruptedByRestart =
        results.length > 0 && counts.interruptedByRestart === results.length;
      const allNotFound = results.length > 0 && counts.notFound === results.length;
      const summaryStatus: WorkspaceDelegateItemStatus = hasRunning
        ? hasStalled
          ? "stalled"
          : "running"
        : allCompleted
          ? "completed"
          : allLimitExceeded
            ? "limit_exceeded"
            : allCancelled
              ? "cancelled"
              : allInterruptedByRestart
                ? "interrupted_by_restart"
                : allNotFound
                  ? "not_found"
                  : "failed";
      const missingCount = counts.notFound + counts.interruptedByRestart;
      const message = hasRunning
        ? `${results.length}개 중 ${counts.completed}개 완료, ${unresolvedIds.length}개 실행 중${
            hasStalled ? "(멈춤 의심 포함)" : ""
          }${counts.limitExceeded > 0 ? `, ${counts.limitExceeded}개 한도 초과 중단` : ""}${
            missingCount > 0 ? `, ${missingCount}개 유실/재시작 중단` : ""
          }. 남은 작업은 action="join" 또는 action="wait"과 ${
            batchRunId ? `batchRunId="${batchRunId}" / ` : ""
          }delegationIds=${JSON.stringify(unresolvedIds)}로 수집하세요.`
        : `${results.length}개 위임 정착 완료 (성공 ${counts.completed}, 한도초과 ${counts.limitExceeded}, 실패/중단/미발견 ${
            results.length - counts.completed - counts.limitExceeded
          }).`;
      return answer({
        status: summaryStatus,
        delegationId: unresolvedIds[0] ?? results[0]?.delegationId ?? null,
        text: null,
        message,
        results,
        ...(batchRunId ? { batchRunId } : {}),
        allSettled,
        unresolvedIds,
        counts,
      });
    };

    if (input.action === "status") {
      if (nested) return answer({ message: nestedMessage });
      const nowMs = yield* Clock.currentTimeMillis;
      // Thread-scoped visibility: show all live/uncollected delegations for this thread + answering instance,
      // regardless of whether the turn ID rotated.
      const tracked = active
        ? ofThread(caller.threadId).filter((delegation) => isOwnedByCaller(delegation, caller))
        : [];
      return answer({
        message:
          [
            ...(rows.length === 0
              ? ["이 모델에는 하위 모델이 지정되어 있지 않습니다. 작업을 직접 처리하세요."]
              : []),
            ...(tracked.length > 0
              ? [
                  `이 대화의 위임: ${tracked.map((d) => describeDelegation(d, nowMs)).join(", ")}. action="wait"과 delegationId 또는 delegationIds로 결과를 받으세요.`,
                ]
              : []),
          ].join(" ") || null,
      });
    }
    if (nested) return yield* fail(nestedMessage);

    if (input.action === "verify") {
      if (!input.verifySpec) {
        return yield* fail(
          "verify에는 verifySpec({ command, args?, cwdRelative?, timeoutMs? })가 필요합니다.",
        );
      }
      if (Option.isNone(thread)) return yield* fail("현재 대화를 찾을 수 없습니다.");
      const verifyCwd =
        caller.executionCwd ??
        thread.value.worktreePath ??
        Option.getOrUndefined(
          yield* deps.queries
            .getProjectShellById(thread.value.projectId)
            .pipe(
              Effect.mapError(
                () => new WorkspaceDelegateError({ message: "프로젝트를 확인하지 못했습니다." }),
              ),
            ),
        )?.workspaceRoot;
      if (!verifyCwd) return yield* fail("검증 작업 폴더를 확인하지 못했습니다.");
      const verifyResult = yield* runDeterministicVerifier(
        {
          type: "command_exit",
          command: input.verifySpec.command,
          args: input.verifySpec.args ?? [],
          ...(input.verifySpec.cwdRelative !== undefined
            ? { cwdRelative: input.verifySpec.cwdRelative }
            : {}),
          timeoutMs: input.verifySpec.timeoutMs ?? 60_000,
          expectedExitCodes: input.verifySpec.expectedExitCodes ?? [0],
          envAllowlist: [
            "PATH",
            "HOME",
            "USERPROFILE",
            "SYSTEMROOT",
            "TEMP",
            "TMP",
            "NODE_OPTIONS",
          ],
        },
        {
          cwd: verifyCwd,
          context: {
            inputs: {},
            nodes: {},
          },
        },
      );
      const isInfraUnverified =
        !verifyResult.passed &&
        (verifyResult.summary.includes("시간 초과") ||
          verifyResult.summary.includes("범위를 벗어납니다") ||
          verifyResult.stderr.includes("Path traversal blocked") ||
          verifyResult.stderr.includes("ENOENT"));
      const verdict: WorkspaceDelegateVerifierOutcome["verdict"] = verifyResult.passed
        ? "CONFIRM"
        : isInfraUnverified
          ? "UNVERIFIED_ERROR"
          : "REJECT";
      const verifierOutcome: WorkspaceDelegateVerifierOutcome = {
        verdict,
        passed: verifyResult.passed,
        exitCode: verifyResult.exitCode,
        summary: verifyResult.summary,
        stdoutTail: verifyResult.stdout.slice(-4_000),
        stderrTail: verifyResult.stderr.slice(-4_000),
      };
      return answer({
        status: verifyResult.passed ? "completed" : "failed",
        text: [
          `VERDICT: ${verdict}`,
          `SUMMARY: ${verifyResult.summary}`,
          ...(verifierOutcome.stdoutTail ? [`STDOUT:\n${verifierOutcome.stdoutTail}`] : []),
          ...(verifierOutcome.stderrTail ? [`STDERR:\n${verifierOutcome.stderrTail}`] : []),
        ].join("\n\n"),
        message: verifyResult.summary,
        verifierOutcome,
      });
    }

    // Join barrier or multi-ID wait: per-item partial resolution (missing/restarted IDs never discard live results).
    const resolvedJoinIds =
      input.action === "join"
        ? [
            ...new Set([
              ...(input.batchRunId ? (batchMembers.get(input.batchRunId) ?? []) : []),
              ...(input.delegationIds ?? []),
              ...(input.delegationId ? [input.delegationId] : []),
            ]),
          ]
        : input.action === "wait" && input.delegationIds && input.delegationIds.length > 0
          ? [...new Set(input.delegationIds)]
          : null;

    if (resolvedJoinIds !== null) {
      if (!active) {
        return yield* fail("현재 대화에서 활성화된 위임 컨텍스트가 없습니다.");
      }
      if (resolvedJoinIds.length === 0) {
        return yield* fail(
          input.batchRunId
            ? `batchRunId "${input.batchRunId}"에 해당하는 위임 목록을 찾을 수 없습니다.`
            : "join에는 batchRunId 또는 delegationIds가 필요합니다.",
        );
      }
      const perItemLimit = Math.max(
        4_000,
        Math.floor(DELEGATE_TEXT_LIMIT / Math.max(1, resolvedJoinIds.length)),
      );
      const results = yield* Effect.forEach(
        resolvedJoinIds,
        (delegationId): Effect.Effect<WorkspaceDelegateBatchItemResult, WorkspaceDelegateError> =>
          Effect.gen(function* () {
            const delegation = delegations.get(delegationId);
            if (delegation && isOwnedByCaller(delegation, caller)) {
              return yield* collectItem(delegation, perItemLimit);
            }
            const persisted = yield* lookupPersistedFallback(delegationId, perItemLimit);
            if (persisted) return persisted;
            serverSelfSignals.recordDelegationEvent("lost");
            return {
              to: "unknown",
              status: "not_found" as const,
              delegationId,
              text: null,
              message: `delegationId "${delegationId}"을(를) 찾을 수 없습니다. 이미 결과를 수령했거나 존재하지 않는 위임입니다.`,
            };
          }),
        { concurrency: "unbounded" },
      );
      return summarizeBatch(results, input.batchRunId);
    }

    if (input.action === "wait" || input.action === "cancel") {
      if (!input.delegationId) return yield* fail(`${input.action}에는 delegationId가 필요합니다.`);
      const delegation = delegations.get(input.delegationId);
      if (!active || !delegation || !isOwnedByCaller(delegation, caller)) {
        if (input.action === "wait" && active) {
          const persisted = yield* lookupPersistedFallback(input.delegationId, DELEGATE_TEXT_LIMIT);
          if (persisted) {
            return answer({
              status: persisted.status,
              delegationId: persisted.delegationId,
              text: persisted.text,
              message: persisted.message,
            });
          }
        }
        return yield* fail(
          `delegationId "${input.delegationId}"을(를) 찾을 수 없습니다. 이미 결과를 받았거나, 중단된 위임입니다.`,
        );
      }
      if (input.action === "wait" || !isRunning(delegation)) return yield* collect(delegation);
      delegation.delivered = true;
      delegations.delete(delegation.id);
      unifiedExecutionLedger.finish({
        executionId: delegation.id,
        executionKind: "workspace_delegate",
        status: "cancelled",
        errorMessage: "위임이 취소되었습니다.",
      });
      if (deps.workerEngine && delegation.workerDispatchId) {
        yield* deps.workerEngine
          .stop({
            dispatchId: delegation.workerDispatchId,
            reason: "위임을 중단했습니다.",
          })
          .pipe(Effect.ignore);
      }
      yield* Fiber.interrupt(delegation.fiber);
      yield* ackWorkerDelivery(delegation);
      if (deps.store) {
        const finishedAt = yield* nowIso;
        yield* deps.store.settle({
          delegationId: delegation.id,
          status: "cancelled",
          errorMessage: "위임을 중단했습니다.",
          finishedAt,
        });
        yield* deps.store.markDelivered(delegation.id, finishedAt);
      }
      return answer({
        status: "cancelled",
        delegationId: delegation.id,
        message: "위임을 중단했습니다.",
      });
    }

    const isParallelStart =
      input.action === "start_parallel" ||
      (input.action === "start" && input.tasks !== undefined && input.tasks.length > 0);
    const requestedTasks =
      input.action === "run_parallel" || isParallelStart
        ? (input.tasks ?? [])
        : input.to && input.task
          ? [
              {
                to: input.to,
                task: input.task,
                ...(input.handoff ? { handoff: input.handoff } : {}),
                ...(input.mandate ? { mandate: input.mandate } : {}),
                ...(input.criticContext ? { criticContext: input.criticContext } : {}),
                ...(input.allowDuplicate !== undefined
                  ? { allowDuplicate: input.allowDuplicate }
                  : {}),
              },
            ]
          : [];
    if (requestedTasks.length === 0) {
      return yield* fail(
        input.action === "run_parallel" || input.action === "start_parallel"
          ? `${input.action}에는 1개 이상의 tasks 항목({ to, task })이 필요합니다.`
          : `${input.action}에는 to와 task가 필요합니다.`,
      );
    }
    if (Option.isNone(thread)) return yield* fail("현재 대화를 찾을 수 없습니다.");

    const resolvedTasks: Array<{
      readonly row: SubordinateRow;
      readonly task: string;
      readonly taskHash: string;
      readonly handoff?: HandoffEnvelopeV1 | undefined;
      readonly mandate?: DelegateMandate | undefined;
      readonly criticContext?: WorkspaceDelegateCriticContext | undefined;
      readonly worktreeIsolation: boolean;
      readonly allowDuplicate: boolean;
    }> = [];
    const effectiveInteractionMode = caller.interactionMode ?? thread.value.interactionMode;
    for (const item of requestedTasks) {
      const matched = matchSubordinate(rows, item.to, item.task);
      if ("error" in matched) return yield* fail(matched.error);
      const row = matched.match;
      // The person's plan mode holds for everything the answering model starts:
      // roles that can change project files must wait for regular mode.
      if (threadTeamRoleMayWrite(row.role) && effectiveInteractionMode === "plan") {
        return yield* fail(
          row.role === "worker"
            ? "계획 모드에서는 일꾼(worker)에게 작업을 맡길 수 없습니다. 계획을 마친 뒤 일반 모드에서 다시 시도하세요."
            : "계획 모드에서는 문서화(writer) 역할에 수정을 맡길 수 없습니다.",
        );
      }
      const worktreeIsolation = item.worktreeIsolation ?? input.worktreeIsolation ?? false;
      if (worktreeIsolation && !threadTeamRoleMayWrite(row.role)) {
        return yield* fail(
          `worktreeIsolation은 쓰기 역할(worker/writer)에만 사용할 수 있습니다(요청 역할: ${row.role}).`,
        );
      }
      if (worktreeIsolation && !deps.worktreeProvision && !deps.workerEngine) {
        return yield* fail(
          "워크트리 격리 서비스(WorktreeProvisionService)가 비활성화되어 worktreeIsolation을 사용할 수 없습니다.",
        );
      }
      // Pre-flight availability & Antseed peer/policy check (never silently swaps the assigned role model).
      const instanceCfg = Option.isSome(settingsOption)
        ? yield* settingsOption.value.getSettings.pipe(
            Effect.map((s) => {
              const map = (s.providerInstances ?? {}) as Record<
                string,
                {
                  readonly apiConnection?: {
                    readonly providerId?: string;
                    readonly baseUrl?: string;
                  };
                }
              >;
              return map[row.instanceId];
            }),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined;
      const availability = yield* Effect.promise(() =>
        probeModelAvailabilityBeforeDispatch({
          providerInstanceId: row.instanceId,
          model: row.model,
          apiProviderId: instanceCfg?.apiConnection?.providerId,
          baseUrl: instanceCfg?.apiConnection?.baseUrl,
        }),
      );
      if (!availability.available) {
        return yield* fail(
          `${delegateLabel(row)} ${availability.reason ?? "사용 불가(피어/정책 또는 쿨다운)"}. 배정된 모델을 다른 모델로 자동 교체하지 않습니다.`,
        );
      }
      resolvedTasks.push({
        row,
        task: item.task,
        taskHash: computeDelegationTaskHash(item.task),
        handoff: item.handoff ?? input.handoff,
        mandate: item.mandate ?? input.mandate,
        criticContext: item.criticContext ?? input.criticContext,
        worktreeIsolation,
        allowDuplicate: item.allowDuplicate ?? input.allowDuplicate ?? false,
      });
    }

    const cwd =
      caller.executionCwd ??
      thread.value.worktreePath ??
      Option.getOrUndefined(
        yield* deps.queries
          .getProjectShellById(thread.value.projectId)
          .pipe(
            Effect.mapError(
              () => new WorkspaceDelegateError({ message: "프로젝트를 확인하지 못했습니다." }),
            ),
          ),
      )?.workspaceRoot;
    if (!cwd) return yield* fail("작업 폴더를 확인하지 못했습니다.");
    const startedAt = yield* nowIso;
    const startedAtMs = yield* Clock.currentTimeMillis;
    if (!team || !turnId || !activeTurnId || (yield* activeTurnId) !== turnId) {
      return yield* fail("위임을 요청한 답변 턴이 끝났습니다.");
    }

    // Deduplication check before capacity check so joining an existing live run
    // does not count against the concurrency cap or spawn duplicate subprocesses.
    const existingThreadRuns = ofThread(caller.threadId).filter(isRunning);
    const plan: Array<
      | { readonly kind: "reuse"; readonly delegation: Delegation }
      | { readonly kind: "spawn"; readonly spec: (typeof resolvedTasks)[number] }
    > = [];
    let newSpawnCount = 0;
    for (const spec of resolvedTasks) {
      const duplicate = !spec.allowDuplicate
        ? existingThreadRuns.find(
            (live) =>
              live.row.instanceId === spec.row.instanceId &&
              live.row.model === spec.row.model &&
              live.taskHash === spec.taskHash,
          )
        : undefined;
      if (duplicate) {
        plan.push({ kind: "reuse", delegation: duplicate });
      } else {
        newSpawnCount += 1;
        plan.push({ kind: "spawn", spec });
      }
    }

    // Checked last, with nothing awaited before the run is recorded, so calls
    // made in parallel cannot slip past the limit together.
    if (existingThreadRuns.length + newSpawnCount > DELEGATE_MAX_RUNNING) {
      return yield* fail(
        `한 대화에서 동시에 실행할 수 있는 위임은 ${DELEGATE_MAX_RUNNING}개입니다(현재 실행 중 ${existingThreadRuns.length}개, 요청 ${newSpawnCount}개). 먼저 wait 또는 cancel 하세요: ${existingThreadRuns.map((d) => describeDelegation(d, startedAtMs)).join(", ")}`,
      );
    }

    const batchRunId =
      input.action === "run_parallel" || isParallelStart
        ? WorkspaceCollaborationRunId.make(NodeCrypto.randomUUID())
        : undefined;
    const globalPrinciples = yield* readSubordinatePrinciples;
    const defaultNotifyOnComplete =
      input.notifyOnComplete ?? (input.action === "start" || isParallelStart);

    const launched: Array<{ readonly delegation: Delegation; readonly deduplicated: boolean }> = [];
    for (let index = 0; index < plan.length; index += 1) {
      const entry = plan[index]!;
      if (entry.kind === "reuse") {
        serverSelfSignals.recordDelegationEvent("deduplicated");
        launched.push({ delegation: entry.delegation, deduplicated: true });
        continue;
      }
      const { row, task, taskHash, handoff, mandate, criticContext, worktreeIsolation } =
        entry.spec;
      // A repeated execution id is treated as a replay, so every run gets its own.
      const id = NodeCrypto.randomUUID();
      const label = delegateLabel(row);
      const nodeId = WorkspaceTaskNodeId.make(
        batchRunId
          ? `${DELEGATE_NODE_PREFIX}${row.role}-${index + 1}`
          : `${DELEGATE_NODE_PREFIX}${row.role}`,
      );

      let executionCwd = cwd;
      let isolatedWorktreePath: string | null | undefined;
      let isolatedWorktreeBranch: string | null | undefined;
      if (worktreeIsolation && deps.worktreeProvision) {
        const branchName = `t3code/delegate-${id.slice(0, 8)}`;
        const provisioned = yield* deps.worktreeProvision
          .provision({
            projectCwd: cwd,
            baseBranch: thread.value.branch ?? "HEAD",
            branch: branchName,
            startFromOrigin: false,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new WorkspaceDelegateError({
                  message: `격리 워크트리 생성에 실패했습니다(${branchName}): ${String(cause)}`,
                }),
            ),
          );
        executionCwd = provisioned.worktreePath;
        isolatedWorktreePath = provisioned.worktreePath;
        isolatedWorktreeBranch = provisioned.refName;
      }

      const basePromptText = yield* Effect.try({
        try: () =>
          buildDelegatePrompt(
            row.role,
            task,
            row.instructions,
            globalPrinciples,
            handoff,
            mandate,
            criticContext,
          ),
        catch: (error) =>
          new WorkspaceDelegateError({
            message: error instanceof Error ? error.message : String(error),
          }),
      });
      const promptText =
        isolatedWorktreePath && isolatedWorktreeBranch
          ? `${basePromptText}\n\n<t3_worktree_isolation>\nYou are executing inside an isolated Git worktree.\n- worktreePath: ${isolatedWorktreePath}\n- branch: ${isolatedWorktreeBranch}\nEdit and test strictly within this worktree; do not mutate the main checkout.\n</t3_worktree_isolation>`
          : basePromptText;

      const delegationRef: { current: Delegation | null } = { current: null };
      const maxWallTimeMs = resolveDelegateMaxWallTimeMs(row.role, deps.maxWallTimeMs);
      const maxWallExtensionMs = Math.min(180_000, maxWallTimeMs);
      const executionRunId =
        batchRunId ?? WorkspaceCollaborationRunId.make(NodeCrypto.randomUUID());

      const buildExecuteEffect = (
        effectiveCwd: string,
        effectiveWorktreePath: string | null | undefined,
        effectiveWorktreeBranch: string | null | undefined,
        extraOnPartialOutput?: (fullOutput: string) => void,
      ) => {
        const finalPromptText =
          effectiveWorktreePath && effectiveWorktreeBranch && !isolatedWorktreePath
            ? `${basePromptText}\n\n<t3_worktree_isolation>\nYou are executing inside an isolated Git worktree.\n- worktreePath: ${effectiveWorktreePath}\n- branch: ${effectiveWorktreeBranch}\nEdit and test strictly within this worktree; do not mutate the main checkout.\n</t3_worktree_isolation>`
            : promptText;
        return deps.execute({
          delegatingTurnId: turnId,
          execution: {
            executionId: ProviderExecutionId.make(id),
            ownerThreadId: caller.threadId,
            runId: executionRunId,
            nodeId,
            attempt: 1,
          },
          modelSelection: createModelSelection(row.instanceId, row.model),
          runtimeMode: caller.runtimeMode ?? thread.value.runtimeMode,
          interactionMode: effectiveInteractionMode,
          cwd: effectiveCwd,
          prompt: finalPromptText,
          title: label,
          displayName: label,
          instruction: task.slice(0, 20_000),
          role: ROLES[row.role].role,
          kind: ROLES[row.role].kind,
          startedAt,
          onPartialOutput: (fullOutput) => {
            const current = delegationRef.current;
            if (current && fullOutput.length >= current.partialOutput.length) {
              current.partialOutput = fullOutput;
            }
            extraOnPartialOutput?.(fullOutput);
          },
        });
      };

      const attachOnExit = (
        base: Effect.Effect<string, WorkspaceAgentExecutionError>,
      ): Effect.Effect<string, WorkspaceAgentExecutionError> =>
        base.pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const finishedAt = yield* nowIso;
              let settledStatus: "completed" | "failed" | "cancelled" = "completed";
              let resultText: string | null = null;
              let errorMessage: string | null = null;
              if (Exit.isSuccess(exit)) {
                if (exit.value.trim()) {
                  settledStatus = "completed";
                  resultText = exit.value;
                } else {
                  settledStatus = "failed";
                  errorMessage = "하위 모델이 배정된 작업의 결과를 반환하지 않았습니다.";
                }
              } else {
                const error = Cause.squash(exit.cause);
                const known = error instanceof WorkspaceAgentExecutionError ? error : undefined;
                const isTimedOut =
                  known?.timedOut === true || (known?.message?.includes("시간 초과") ?? false);
                const cancelled =
                  !isTimedOut &&
                  (Cause.hasInterruptsOnly(exit.cause) || known?.interrupted === true);
                settledStatus = cancelled ? "cancelled" : "failed";
                const rawErr =
                  known?.message ??
                  (delegationRef.current?.abortedByStall
                    ? "시간 초과 실패: 하위 모델이 장시간 활동이 없어 종료되었습니다."
                    : cancelled
                      ? "위임이 중단되었습니다."
                      : Cause.pretty(exit.cause));
                recordUnavailableModelFromError({
                  providerInstanceId: row.instanceId,
                  model: row.model,
                  errorMessage: rawErr,
                });
                errorMessage = isNonRetryableBillingError(rawErr)
                  ? formatBillingErrorMessage(rawErr)
                  : rawErr;
                const preserved = (
                  known?.partialOutput ??
                  delegationRef.current?.partialOutput ??
                  ""
                ).trim();
                if (preserved) {
                  resultText = preserved;
                }
              }

              unifiedExecutionLedger.finish({
                executionId: id,
                executionKind: "workspace_delegate",
                status: settledStatus,
                errorMessage,
              });

              deps.liveness?.recordTaskLiveness({
                threadId: caller.threadId,
                taskId: id,
                taskType: "workspace_delegate",
                status: settledStatus,
                kind: "completed",
              });

              if (deps.store) {
                yield* deps.store.settle({
                  delegationId: id,
                  status: settledStatus,
                  resultText,
                  errorMessage,
                  finishedAt,
                });
              }

              // Background push notification when a detached delegation finishes
              // before the caller called `wait` again.
              const current = delegationRef.current;
              if (current && current.notifyOnComplete && !current.delivered && deps.dispatch) {
                const preview = resultText
                  ? resultText.trim().slice(0, 200)
                  : (errorMessage ?? "").slice(0, 200);
                yield* deps
                  .dispatch({
                    type: "thread.activity.append",
                    commandId: CommandId.make(`delegate-completed:${id}`),
                    threadId: caller.threadId,
                    createdAt: finishedAt,
                    activity: {
                      id: EventId.make(`delegate-completed:${id}`),
                      kind: "delegate.completed",
                      tone: settledStatus === "completed" ? "info" : "error",
                      summary: `하위 모델 작업 ${
                        settledStatus === "completed"
                          ? "완료"
                          : settledStatus === "cancelled"
                            ? "중단"
                            : "실패"
                      }: ${label}`,
                      payload: {
                        delegationId: id,
                        role: row.role,
                        model: row.model,
                        status: settledStatus,
                        preview,
                      },
                      turnId,
                      createdAt: finishedAt,
                    },
                  })
                  .pipe(Effect.ignoreCause({ log: false }));
              }
            }).pipe(Effect.ignoreCause({ log: false })),
          ),
        );

      let fiber: Fiber.Fiber<string, WorkspaceAgentExecutionError>;
      let workerTaskId: string | undefined;
      let workerDispatchId: string | undefined;
      let workerRunId: string | undefined;
      let workerToActor: string | undefined;

      if (deps.workerEngine) {
        const resultDeferred = yield* Deferred.make<string, WorkspaceAgentExecutionError>();
        const targetRunId = batchRunId ?? `delegate_${caller.threadId}`;
        const targetToActor = `delegate:${id}`;
        const receipt = yield* deps.workerEngine
          .dispatchWithRunner(
            {
              taskId: id,
              runId: targetRunId,
              threadId: caller.threadId,
              ownerTurnId: turnId,
              callerKind: "t3_supervisor",
              role: row.role,
              targetInstanceId: row.instanceId,
              targetModel: row.model,
              specText: task,
              cwd: executionCwd,
              worktreeMode: isolatedWorktreePath
                ? "isolated"
                : worktreeIsolation
                  ? "isolated"
                  : "current",
              ...(thread.value.branch ? { baseBranch: thread.value.branch } : {}),
              heartbeatTimeoutMs: stallThresholdMs,
              maxIdleMs: stallAbortMs,
              maxWallTimeMs,
              toActor: targetToActor,
            },
            {
              dispatchId: id,
              allowDuplicate: entry.spec.allowDuplicate,
              maxRunningPerThread: DELEGATE_MAX_RUNNING,
              skipLedger: true,
              ...(isolatedWorktreePath
                ? {
                    externalWorktree: {
                      worktreePath: isolatedWorktreePath,
                      worktreeBranch: isolatedWorktreeBranch ?? null,
                    },
                  }
                : {}),
              runner: (req) =>
                buildExecuteEffect(
                  req.effectiveCwd,
                  req.task.worktreePath,
                  req.task.worktreeBranch,
                  req.onPartialOutput,
                ).pipe(
                  Effect.tap((text) => Deferred.succeed(resultDeferred, text)),
                  Effect.tapError((err) => Deferred.fail(resultDeferred, err)),
                  Effect.onInterrupt(() => Deferred.interrupt(resultDeferred)),
                  Effect.map((text) => ({
                    resultText: text,
                    summary: text.slice(0, 400),
                    exitCode: 0,
                  })),
                  Effect.mapError(
                    (err) =>
                      new WorkerEngineError({
                        code: err.interrupted ? "conflict" : "invalid_state",
                        message: err.message,
                        details: { interrupted: err.interrupted === true },
                      }),
                  ),
                ),
            },
          )
          .pipe(Effect.mapError((err) => new WorkspaceDelegateError({ message: err.message })));

        if (receipt.deduplicated) {
          const existingLive = delegations.get(receipt.dispatchId);
          if (existingLive) {
            serverSelfSignals.recordDelegationEvent("deduplicated");
            launched.push({ delegation: existingLive, deduplicated: true });
            continue;
          }
        }

        if (receipt.worktreePath && !isolatedWorktreePath) {
          isolatedWorktreePath = receipt.worktreePath;
          isolatedWorktreeBranch = receipt.worktreeBranch;
        }
        workerTaskId = receipt.taskId;
        workerDispatchId = receipt.dispatchId;
        workerRunId = receipt.runId;
        workerToActor = targetToActor;
        fiber = yield* attachOnExit(Deferred.await(resultDeferred)).pipe(Effect.forkIn(scope));
      } else {
        fiber = yield* attachOnExit(
          buildExecuteEffect(executionCwd, isolatedWorktreePath, isolatedWorktreeBranch),
        ).pipe(Effect.forkIn(scope));
      }

      const delegation: Delegation = {
        id,
        ...(batchRunId ? { batchRunId } : {}),
        threadId: caller.threadId,
        team,
        turnId,
        activeTurnId,
        row,
        taskHash,
        mandate,
        fiber,
        startedAtMs,
        maxWallTimeMs,
        maxWallExtensionMs,
        wallExtensionAppliedMs: 0,
        partialOutput: "",
        waitRounds: 0,
        lastActivityAtMs: startedAtMs,
        lastActivityAtIso: startedAt,
        lastToolSummary: null,
        lastDbHeartbeatAtMs: startedAtMs,
        stalledReported: false,
        abortedByStall: false,
        ...(isolatedWorktreePath !== undefined ? { worktreePath: isolatedWorktreePath } : {}),
        ...(isolatedWorktreeBranch !== undefined ? { worktreeBranch: isolatedWorktreeBranch } : {}),
        ...(workerTaskId !== undefined ? { workerTaskId } : {}),
        ...(workerDispatchId !== undefined ? { workerDispatchId } : {}),
        ...(workerRunId !== undefined ? { workerRunId } : {}),
        ...(workerToActor !== undefined ? { workerToActor } : {}),
        delivered: false,
        notifyOnComplete: defaultNotifyOnComplete,
      };
      delegationRef.current = delegation;
      delegations.set(id, delegation);
      yield* annotateExecutionSpan({
        executionKind: "workspace_delegate",
        executionId: id,
        threadId: caller.threadId,
        parentRunId: batchRunId ?? null,
        provider: row.instanceId,
        model: row.model,
      });
      unifiedExecutionLedger.begin({
        executionId: id,
        executionKind: "workspace_delegate",
        threadId: caller.threadId,
        parentRunId: batchRunId ?? null,
        summary: `${label} (${task.slice(0, 80)})`,
        provider: row.instanceId,
        model: row.model,
        startedAtMs,
      });
      deps.liveness?.recordTaskLiveness({
        threadId: caller.threadId,
        taskId: id,
        taskType: "workspace_delegate",
        status: "running",
        provider: row.instanceId,
        modelLabel: row.model,
        turnId,
        title: label,
        proofHandle: `delegate:${id}`,
        kind: "started",
        nowMs: startedAtMs,
      });
      if (deps.store) {
        yield* deps.store.insert({
          delegationId: id,
          threadId: caller.threadId,
          ownerTurnId: turnId,
          answeringInstanceId: team.answeringInstanceId,
          role: row.role,
          targetInstanceId: row.instanceId,
          targetModel: row.model,
          taskText: task,
          taskHash,
          mandate,
          startedAt,
        });
      }
      launched.push({ delegation, deduplicated: false });
    }

    if (batchRunId) {
      batchMembers.set(
        batchRunId,
        launched.map((entry) => entry.delegation.id),
      );
    }

    if (isParallelStart) {
      const nowMs = yield* Clock.currentTimeMillis;
      const ids = launched.map((entry) => entry.delegation.id);
      const dedupCount = launched.filter((entry) => entry.deduplicated).length;
      return answer({
        status: "running",
        delegationId: ids[0] ?? null,
        ...(batchRunId ? { batchRunId } : {}),
        allSettled: false,
        unresolvedIds: ids,
        message: `${launched.length}개 하위 모델 실행을 백그라운드에서 시작했습니다${
          dedupCount > 0 ? ` (중복 합류 ${dedupCount}건)` : ""
        }. action="join"${batchRunId ? `(batchRunId="${batchRunId}")` : ""} 또는 action="wait"(delegationIds=${JSON.stringify(ids)})로 결과를 수집하세요.`,
        results: launched.map(({ delegation, deduplicated }) => {
          const { stalled } = evaluateStall(delegation, nowMs);
          return {
            to: subordinateAddress(delegation.row),
            status: stalled ? "stalled" : "running",
            delegationId: delegation.id,
            text: null,
            message: deduplicated
              ? "동일 작업이 이미 실행 중이어서 기존 위임에 합류했습니다."
              : "백그라운드에서 실행을 시작했습니다.",
            ...(deduplicated ? { deduplicated: true } : {}),
            lastActivityAt: delegation.lastActivityAtIso,
            lastToolSummary: delegation.lastToolSummary,
            elapsedSec: Math.max(0, Math.round((nowMs - delegation.startedAtMs) / 1_000)),
            remainingWaitRounds: Math.max(0, maxWaitRounds - delegation.waitRounds),
            ...(delegation.worktreePath !== undefined
              ? { worktreePath: delegation.worktreePath }
              : {}),
            ...(delegation.worktreeBranch !== undefined
              ? { worktreeBranch: delegation.worktreeBranch }
              : {}),
          };
        }),
      });
    }

    if (input.action === "start") {
      const first = launched[0]!;
      return answer({
        status: "running",
        delegationId: first.delegation.id,
        ...(first.delegation.worktreePath !== undefined
          ? { worktreePath: first.delegation.worktreePath }
          : {}),
        ...(first.delegation.worktreeBranch !== undefined
          ? { worktreeBranch: first.delegation.worktreeBranch }
          : {}),
        message: first.deduplicated
          ? '동일 작업이 이미 실행 중이어서 기존 위임에 합류했습니다. action="wait"과 이 delegationId로 결과를 수집하세요.'
          : '하위 모델 실행을 백그라운드에서 시작했습니다. 다른 독립 작업도 바로 start/start_parallel한 뒤 action="join" 또는 action="wait"(delegationIds)로 한 번에 결과를 수집하세요.',
      });
    }

    if (input.action === "run_parallel") {
      const perItemLimit = Math.max(
        4_000,
        Math.floor(DELEGATE_TEXT_LIMIT / Math.max(1, launched.length)),
      );
      const results = yield* Effect.forEach(
        launched,
        ({ delegation, deduplicated }) => collectItem(delegation, perItemLimit, deduplicated),
        { concurrency: "unbounded" },
      );
      return summarizeBatch(results, batchRunId);
    }

    const first = launched[0]!;
    return yield* collect(first.delegation, first.deduplicated);
  });

  return { invoke };
});
