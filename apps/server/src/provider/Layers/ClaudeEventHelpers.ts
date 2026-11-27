import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  PermissionUpdate,
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeModelUsageLedger } from "../tokenConsumption.ts";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type RuntimeContentStreamKind,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeTaskStatus,
  type TaskAgentLinkage,
  type TaskRunHandles,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type UserInputQuestion,
  WorkspaceWorkflowError,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  getModelSelectionStringOptionValue,
  resolvePromptInjectedEffort,
} from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import type * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import type * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import type { makeClaudeChatSkillPlugin } from "../ClaudeChatSkills.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderTurnHistory } from "../ProviderTurnHistory.ts";
import { getClaudeModelCapabilities, normalizeClaudeCliEffort } from "./ClaudeProvider.ts";
import { nonNegativeInt, trimmedString } from "./ClaudeTokenLedger.ts";

export const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(
  Schema.fromJsonString(Schema.Unknown),
);
export const decodeUnknownJsonStringExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Unknown),
);

export const PROVIDER = ProviderDriverKind.make("claudeAgent");
export const isWorkspaceWorkflowError = Schema.is(WorkspaceWorkflowError);
export type ClaudeTextStreamKind = Extract<
  RuntimeContentStreamKind,
  "assistant_text" | "reasoning_text"
>;
export type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;
export type ClaudeSdkEffort = NonNullable<ClaudeQueryOptions["effort"]>;

export function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

export interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  /**
   * True for turns auto-started by assistant output arriving without an
   * active turn (background agent/subagent responses between user prompts).
   * Synthetic turns are auto-closed by the next sendTurn; real turns are
   * steered instead (the queued message continues the same turn).
   */
  readonly synthetic?: boolean;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  nextSyntheticAssistantBlockIndex: number;
}

export interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

export interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

export interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
  readonly cancel: () => void;
}

export interface ToolInFlight {
  /** Null records conflicting provider snapshots for this call. */
  reportedModel?: string | null;
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
  readonly partialInputJson: string;
  readonly lastEmittedInputFingerprint?: string;
  /** Owning agent when this tool ran inside a subagent (see attribution note). */
  readonly agentId?: string;
  readonly parentToolUseId?: string;
}

export interface ClaudeTaskState {
  readonly id: string;
  subject: string;
  status: PlanStep["status"];
  readonly blockedBy: Set<string>;
}

/**
 * Agent identity captured from task_started and repeated on every subsequent
 * task.* payload, so client folds can reconstruct an agent even when its
 * start row aged out of activity retention.
 */
export interface ClaudeTaskAgentState {
  readonly taskId: string;
  toolUseId: string | undefined;
  description: string | undefined;
  subagentType: string | undefined;
  taskType: string | undefined;
  workflowName: string | undefined;
  skipTranscript: boolean;
  runHandles: TaskRunHandles | undefined;
  /** Set when this task was launched from inside a subagent. */
  owningAgentId: string | undefined;
  /** Seeded from the launching tool's input; refined by the subagent's own
   * assistant snapshots (authoritative API model). */
  model: string | undefined;
  effort: string | undefined;
}

export interface ClaudeSessionContext {
  readonly nativeSubagentsRestricted: boolean;
  watchStopRequested: boolean;
  session: ProviderSession;
  readonly chatSkillPlugin: Effect.Success<ReturnType<typeof makeClaudeChatSkillPlugin>>;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  readonly basePermissionMode: PermissionMode | undefined;
  currentPermissionMode: PermissionMode | undefined;
  currentApiModelId: string | undefined;
  /** Effective effort for the session's turns; subagents without an explicit
   * effort override inherit this. */
  currentEffort: string | undefined;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly closeToolCallbacks: () => void;
  readonly drainToolCallbacks: () => Promise<void>;
  readonly beginControlOperation: () => (() => void) | undefined;
  readonly history: ProviderTurnHistory;
  readonly inFlightTools: Map<number, ToolInFlight>;
  readonly claudeTasks: Map<string, ClaudeTaskState>;
  readonly taskAgents: Map<string, ClaudeTaskAgentState>;
  /**
   * Last emitted workflow-member fingerprint per member slot. A coordinator
   * task_progress repeats the FULL member array every tick; without a
   * material-transition filter one provider tick fans out into up to 100
   * runtime events (event-log writes, queue pressure, client reducer work)
   * even when nothing changed for most members.
   */
  readonly workflowMemberFingerprints: Map<string, string>;
  /** Task ids that have started and not yet reached a terminal state. */
  readonly liveTaskIds: Set<string>;
  turnState: ClaudeTurnState | undefined;
  lastKnownContextWindow: number | undefined;
  lastKnownContextWindowSource?: "catalog" | "context_usage_api" | "model_usage_result" | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastKnownTotalProcessedTokens: number | undefined;
  /** Running modelUsage totals of this query process; see claudeTokenConsumption. */
  readonly modelUsageLedger: ClaudeModelUsageLedger;
  /** True when this query process was started via `--resume`. */
  readonly startedFromResume: boolean;
  /** Wave 1-A1: pending first-prompt sizing metadata (body is never persisted). */
  firstPromptTelemetryPending?:
    | {
        readonly isResume: boolean;
        readonly isExecution: boolean;
        readonly systemAppendFull: string;
        readonly projectAgentsMdInjected: string | undefined;
        readonly subordinateRoster: string | undefined;
        readonly globalSystemInstructions: string | undefined;
        readonly conductorEnabled: boolean;
        readonly pluginCount: number;
        readonly mcpServerNames: ReadonlyArray<string>;
        readonly programmaticAgentCount: number;
      }
    | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  stopped: boolean;
}

export interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly initializationResult?: () => Promise<{
    readonly account?: { readonly apiKeySource?: string; readonly apiProvider?: string };
  }>;
  readonly interrupt: () => Promise<void>;
  /** SDK Query.stopTask — present on real queries; optional for test doubles. */
  readonly stopTask?: (taskId: string) => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly getContextUsage?: () => Promise<SDKControlGetContextUsageResponse>;
  readonly reloadSkills?: () => Promise<{ skills: ReadonlyArray<{ name: string }> }>;
  readonly close: () => void;
}

export function hasDurableClaudeSessionId(message: SDKMessage): boolean {
  if (message.type !== "system") {
    return true;
  }

  return (
    message.subtype !== "hook_started" &&
    message.subtype !== "hook_progress" &&
    message.subtype !== "hook_response"
  );
}

export function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

export function normalizeClaudeStreamMessages(
  cause: Cause.Cause<ProviderAdapterProcessError>,
): ReadonlyArray<string> {
  const errors: Array<string> = [];
  for (const error of Cause.prettyErrors(cause)) {
    const message = error.message.trim();
    if (message.length > 0) {
      errors.push(message);
    }
  }
  if (errors.length > 0) {
    return errors;
  }

  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

export function getEffectiveClaudeAgentEffort(
  effort: string | null | undefined,
  model: string | null | undefined,
): ClaudeSdkEffort | null {
  const normalized = normalizeClaudeCliEffort(effort, model);
  return normalized ? (normalized as ClaudeSdkEffort) : null;
}

export function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}

export function isClaudeInterruptedCause(cause: Cause.Cause<ProviderAdapterProcessError>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage) ||
    cause.reasons.some(
      (reason) =>
        Cause.isFailReason(reason) && isClaudeInterruptedMessage(toMessage(reason.error.cause, "")),
    )
  );
}

export function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
}

/**
 * Leads the banner with what the person can do. The raw text stays attached:
 * it carries the request id needed to report a false positive, and the
 * refusal recognizers match on it.
 */
export function formatClaudeSafeguardError(rawMessage: string): string {
  const detailsMatch = /Details:\s*`?(\[[^\]]+\])/i.exec(rawMessage);
  const tag = detailsMatch?.[1] ? ` ${detailsMatch[1]}` : "";
  return `Anthropic 안전장치가 이 요청을 거절했습니다${tag}. 이 대화의 이전 기록이 매번 함께 전송되므로 같은 대화에서 이 모델로 다시 보내면 또 거절됩니다. 새 대화를 열거나 다른 모델을 선택해 주세요. (${rawMessage.trim()})`;
}

/**
 * First user-facing error from a non-success result. "[ede_diagnostic] ..."
 * entries are CLI-internal telemetry (the CLI hides them from its own UI too),
 * so they must never become the error banner.
 */
export function resultUserFacingError(result: SDKResultMessage): string | undefined {
  if (result.subtype === "success") {
    return result.is_error === true ? result.result : undefined;
  }
  if (!Array.isArray(result.errors)) {
    return undefined;
  }
  return result.errors.find((error) => !error.startsWith("[ede_diagnostic]"));
}

export function isInterruptedResult(result: SDKResultMessage): boolean {
  // The CLI stamps user aborts explicitly: interrupting mid-tool-call yields
  // "aborted_tools" (with an internal "[ede_diagnostic] ..." error and
  // is_error: true), interrupting mid-stream yields "aborted_streaming".
  if (
    result.terminal_reason === "aborted_tools" ||
    result.terminal_reason === "aborted_streaming"
  ) {
    return true;
  }

  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) {
    return true;
  }

  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}

export function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.make(value);
}

export function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

export function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.make(value);
}

export function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

export function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

export function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

export function isTodoTool(toolName: string): boolean {
  return toolName.toLowerCase().includes("todowrite");
}

export type PlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};

export function extractPlanStepsFromTodoInput(input: Record<string, unknown>): PlanStep[] | null {
  // TodoWrite format: { todos: [{ content, status, activeForm? }] }
  const todos = input.todos;
  if (!Array.isArray(todos) || todos.length === 0) {
    return null;
  }
  return todos
    .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
    .map((todo) => ({
      step:
        typeof todo.content === "string" && todo.content.trim().length > 0
          ? todo.content.trim()
          : "Task",
      status:
        todo.status === "completed"
          ? "completed"
          : todo.status === "in_progress"
            ? "inProgress"
            : "pending",
    }));
}

export function isClaudeTaskTool(toolName: string): boolean {
  return toolName === "TaskCreate" || toolName === "TaskUpdate" || toolName === "TaskList";
}

export function normalizeClaudeTaskStatus(value: unknown): PlanStep["status"] {
  return value === "completed" ? "completed" : value === "in_progress" ? "inProgress" : "pending";
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function readStringArray(value: unknown): Array<string> {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

export function readClaudeToolUseResult(message: SDKMessage): Record<string, unknown> | undefined {
  if (message.type !== "user") {
    return undefined;
  }
  const result = (message as { readonly tool_use_result?: unknown }).tool_use_result;
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : undefined;
}

export function readClaudeTaskFromResult(
  result: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const task = result?.task;
  return task !== null && typeof task === "object" && !Array.isArray(task)
    ? (task as Record<string, unknown>)
    : undefined;
}

export function applyClaudeTaskToolResult(
  tasks: Map<string, ClaudeTaskState>,
  tool: ToolInFlight,
  result: Record<string, unknown> | undefined,
): boolean {
  if (!isClaudeTaskTool(tool.toolName)) {
    return false;
  }

  let changed = false;
  if (tool.toolName === "TaskList") {
    const resultTasks = result?.tasks;
    if (!Array.isArray(resultTasks)) {
      return false;
    }
    tasks.clear();
    for (const entry of resultTasks) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const task = entry as Record<string, unknown>;
      const id = readString(task.id);
      const subject = readString(task.subject);
      if (!id || !subject) {
        continue;
      }
      tasks.set(id, {
        id,
        subject,
        status: normalizeClaudeTaskStatus(task.status),
        blockedBy: new Set(readStringArray(task.blockedBy)),
      });
    }
    return tasks.size > 0;
  }

  if (tool.toolName === "TaskCreate") {
    const resultTask = readClaudeTaskFromResult(result);
    const id = readString(resultTask?.id);
    const subject = readString(resultTask?.subject) ?? readString(tool.input.subject);
    if (!id || !subject) {
      return false;
    }
    tasks.set(id, {
      id,
      subject,
      status: normalizeClaudeTaskStatus(tool.input.status),
      blockedBy: new Set(readStringArray(tool.input.blockedBy)),
    });
    return true;
  }

  const taskId = readString(tool.input.taskId) ?? readString(result?.taskId);
  if (!taskId) {
    return false;
  }
  const task = tasks.get(taskId);
  if (!task) {
    return false;
  }
  const subject = readString(tool.input.subject);
  if (subject && task.subject !== subject) {
    task.subject = subject;
    changed = true;
  }
  if (typeof tool.input.status === "string") {
    const status = normalizeClaudeTaskStatus(tool.input.status);
    if (task.status !== status) {
      task.status = status;
      changed = true;
    }
  }
  for (const dependency of readStringArray(tool.input.addBlockedBy)) {
    if (!task.blockedBy.has(dependency)) {
      task.blockedBy.add(dependency);
      changed = true;
    }
  }
  for (const dependency of readStringArray(tool.input.removeBlockedBy)) {
    if (task.blockedBy.delete(dependency)) {
      changed = true;
    }
  }
  return changed;
}

export function planStepsFromClaudeTasks(tasks: Map<string, ClaudeTaskState>): PlanStep[] {
  return Array.from(tasks.values()).map((task) => {
    const blockedBy = Array.from(task.blockedBy);
    const blockedSuffix = blockedBy.length > 0 ? ` (blocked by #${blockedBy.join(", #")})` : "";
    return {
      step: `${task.subject}${blockedSuffix}`,
      status: task.status,
    };
  });
}

/** Only http/https survive; anything else (javascript:, file:, …) is dropped. */
export function sanitizeSessionUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/** SDK task_updated patch status → the shared wire vocabulary. */
export const CLAUDE_TASK_PATCH_STATUS: Record<string, RuntimeTaskStatus> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  killed: "cancelled",
  paused: "idle",
};

/**
 * Resolves a stream message's parent_tool_use_id to the owning agent's
 * taskId. The Task tool's tool_use_id is remembered on task_started; any
 * subagent-forwarded block carries that id as its parent. Returns undefined
 * for parent-conversation traffic.
 */
export function agentIdForParentToolUse(
  agents: Map<string, ClaudeTaskAgentState>,
  parentToolUseId: string | null | undefined,
): string | undefined {
  if (parentToolUseId === null || parentToolUseId === undefined) {
    return undefined;
  }
  for (const agent of agents.values()) {
    if (agent.toolUseId === parentToolUseId) {
      return agent.taskId;
    }
  }
  return undefined;
}

/**
 * Linkage bundle repeated on every task.* payload for `taskId`. Reads the
 * remembered identity (from task_started) so progress/terminal rows are
 * self-describing even when the start row ages out of activity retention.
 */
export function taskLinkageFor(
  agents: Map<string, ClaudeTaskAgentState>,
  taskId: string,
): TaskAgentLinkage {
  const agent = agents.get(taskId);
  if (!agent) {
    return {};
  }
  return {
    ...(agent.taskType ? { taskType: agent.taskType } : {}),
    ...(agent.owningAgentId ? { agentId: agent.owningAgentId } : {}),
    ...(agent.description ? { title: agent.description } : {}),
    ...(agent.subagentType ? { role: agent.subagentType } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.effort ? { effort: agent.effort } : {}),
    ...(agent.toolUseId ? { toolUseId: agent.toolUseId } : {}),
    ...(agent.workflowName ? { workflowName: agent.workflowName } : {}),
    ...(agent.runHandles ? { runHandles: agent.runHandles } : {}),
  };
}

export const WORKFLOW_PHASE_CAP = 64;
export const WORKFLOW_AGENT_CAP = 100;

export interface ClaudeWorkflowAgentEntry {
  readonly index: number;
  readonly state: string;
  readonly label: string | undefined;
  readonly phaseIndex: number | undefined;
  readonly phaseTitle: string | undefined;
  readonly model: string | undefined;
  readonly attempt: number | undefined;
  readonly lastToolName: string | undefined;
  readonly startedAt: string | undefined;
  readonly error: string | undefined;
  readonly tokens: number | undefined;
  readonly toolCalls: number | undefined;
}

export interface ClaudeWorkflowProgress {
  readonly phases: ReadonlyArray<{ index: number; title: string }>;
  readonly agents: ReadonlyArray<ClaudeWorkflowAgentEntry>;
}

/**
 * Defensive parse of the SDK's undeclared-but-real workflow_progress array on
 * task_progress messages (wire-confirmed; absent from sdk.d.ts). Unknown
 * shapes are skipped per-entry; phases and agents dedupe by index before
 * caps; a vanished field never throws. If the array disappears upstream the
 * caller keeps the coordinator row and plain task lifecycle.
 */
export function parseWorkflowProgress(value: unknown): ClaudeWorkflowProgress | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const phasesByIndex = new Map<number, string>();
  const agentsByIndex = new Map<number, ClaudeWorkflowAgentEntry>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const entryType = trimmedString(record.type);
    if (entryType === "workflow_phase") {
      const index = nonNegativeInt(record.index);
      const title = trimmedString(record.title);
      if (index !== undefined && title && !phasesByIndex.has(index)) {
        phasesByIndex.set(index, title);
      }
      continue;
    }
    if (entryType !== "workflow_agent") {
      continue;
    }
    const index = nonNegativeInt(record.index);
    const state = trimmedString(record.state);
    if (index === undefined || !state || agentsByIndex.has(index)) {
      continue;
    }
    agentsByIndex.set(index, {
      index,
      state,
      label: trimmedString(record.label),
      phaseIndex: nonNegativeInt(record.phaseIndex),
      phaseTitle: trimmedString(record.phaseTitle),
      model: trimmedString(record.model),
      attempt: nonNegativeInt(record.attempt),
      lastToolName: trimmedString(record.lastToolName),
      startedAt: trimmedString(record.startedAt),
      error: trimmedString(record.error),
      tokens: nonNegativeInt(record.tokens),
      toolCalls: nonNegativeInt(record.toolCalls),
    });
  }
  if (phasesByIndex.size === 0 && agentsByIndex.size === 0) {
    return undefined;
  }
  const phases = Array.from(phasesByIndex.entries())
    .map(([index, title]) => ({ index, title }))
    .toSorted((a, b) => a.index - b.index)
    .slice(0, WORKFLOW_PHASE_CAP);
  const agents = Array.from(agentsByIndex.values())
    .toSorted((a, b) => a.index - b.index)
    .slice(0, WORKFLOW_AGENT_CAP);
  return { phases, agents };
}

/**
 * Workflow member states from workflow_progress → shared task status.
 * Unknown states read running after startedAt, pending before it.
 */
export function workflowAgentStatus(entry: ClaudeWorkflowAgentEntry): RuntimeTaskStatus {
  switch (entry.state) {
    case "queued":
    case "pending":
      return "pending";
    case "start":
    case "running":
      return entry.startedAt === undefined ? "pending" : "running";
    case "done":
      return "completed";
    case "error":
      return "failed";
    default:
      return entry.startedAt === undefined ? "pending" : "running";
  }
}

export function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  // For agent/subagent tools, prefer the human-readable description or prompt
  // over raw JSON. The structured subagent_type is carried separately on the
  // task.* payloads (role) — the label is display-only.
  const itemType = classifyToolItemType(toolName);
  if (itemType === "collab_agent_tool_call") {
    const description =
      typeof input.description === "string" ? input.description.trim() : undefined;
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : undefined;
    const label = description || (prompt ? prompt.slice(0, 200) : undefined);
    if (label) {
      return label;
    }
  }

  const serialized = encodeJsonStringForDiagnostics(input) ?? "[unserializable input]";
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

export function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

export const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

export function buildPromptText(
  input: ProviderSendTurnInput,
  boundInstanceId: ProviderInstanceId,
): string {
  const rawEffort =
    input.modelSelection?.instanceId === boundInstanceId
      ? getModelSelectionStringOptionValue(input.modelSelection, "effort")
      : null;
  const claudeModel =
    input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection.model : undefined;
  const caps = getClaudeModelCapabilities(claudeModel);

  const promptEffort = resolvePromptInjectedEffort(caps, rawEffort);
  return applyClaudePromptEffortPrefix(input.input?.trim() ?? "", promptEffort);
}

export function buildUserMessage(input: {
  readonly sdkContent: Array<Record<string, unknown>>;
}): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: input.sdkContent as unknown as SDKUserMessage["message"]["content"],
    },
  } as SDKUserMessage;
}

export function buildClaudeImageContentBlock(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}

export const buildUserMessageEffect = Effect.fn("buildUserMessageEffect")(function* (
  input: ProviderSendTurnInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
    readonly boundInstanceId: ProviderInstanceId;
  },
) {
  const text = buildPromptText(input, dependencies.boundInstanceId);
  const sdkContent: Array<Record<string, unknown>> = [];

  if (text.length > 0) {
    sdkContent.push({ type: "text", text });
  }

  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== "image") {
      continue;
    }

    if (!SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
      });
    }

    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: dependencies.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }

    const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: "Failed to read attachment file.",
            cause,
          }),
      ),
    );

    sdkContent.push(
      buildClaudeImageContentBlock({
        mimeType: attachment.mimeType,
        bytes,
      }),
    );
  }

  return buildUserMessage({ sdkContent });
});

export function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  if (result.subtype === "success") {
    return result.is_error === true ? "failed" : "completed";
  }

  const errors = resultErrorsText(result);
  if (isInterruptedResult(result)) {
    return "interrupted";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

export function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

export function nativeProviderRefs(
  _context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined;
  },
): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  if (options?.providerItemId) {
    return {
      providerItemId: ProviderItemId.make(options.providerItemId),
    };
  }
  return {};
}

export function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (
      candidate.type === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.length > 0
    ) {
      fragments.push(candidate.text);
    }
  }

  return fragments;
}

export function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
}

export function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return record.text;
  }

  return extractTextContent(record.content);
}

export function extractExitPlanModePlan(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    plan?: unknown;
  };
  return typeof record.plan === "string" && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined;
}

export function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

export function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  const result = decodeUnknownJsonStringExit(value);
  if (!Exit.isSuccess(result)) {
    return undefined;
  }
  const parsed = result.value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

export function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  return encodeJsonStringForDiagnostics(input);
}

export function toolResultStreamKind(
  itemType: CanonicalItemType,
): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

export function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
  readonly toolUseId: string;
  readonly block: Record<string, unknown>;
  readonly text: string;
  readonly isError: boolean;
}> {
  if (message.type !== "user") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<{
    readonly toolUseId: string;
    readonly block: Record<string, unknown>;
    readonly text: string;
    readonly isError: boolean;
  }> = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!toolUseId) {
      continue;
    }

    blocks.push({
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
    });
  }

  return blocks;
}

export function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

export function toRequestError(
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: `${method} failed`,
    cause,
  });
}

export function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

export function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

export function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);
  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }

  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);
    if (streamType) {
      const deltaType =
        streamType === "content_block_delta"
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined;
      if (deltaType) {
        return `claude/${message.type}/${streamType}/${deltaType}`;
      }
      return `claude/${message.type}/${streamType}`;
    }
  }

  return `claude/${message.type}`;
}

// Discriminator/identity keys carry no human-readable content; everything else
// on an unmodeled SDK message is potentially worth surfacing in the work log.
export const SDK_MESSAGE_NOISE_KEYS = new Set([
  "type",
  "subtype",
  "uuid",
  "parent_uuid",
  "session_id",
  "parent_tool_use_id",
  "request_id",
]);

// Pull the salient scalar content out of a message the adapter doesn't model
// yet, so the work-log row shows what actually arrived (e.g. a notification's
// text) instead of an opaque "unhandled subtype" placeholder. Nested structures
// are left to the full payload retained in the event's `detail`.
export function previewUnknownSdkContent(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(message as Record<string, unknown>)) {
    if (SDK_MESSAGE_NOISE_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        parts.push(`${key}: ${trimmed}`);
      }
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  const joined = parts.join(" · ");
  return joined.length > 280 ? `${joined.slice(0, 279)}…` : joined;
}

export function describeUnknownSdkMessage(kind: string, message: unknown): string {
  const preview = previewUnknownSdkContent(message);
  return preview ? `${kind} — ${preview}` : `${kind} (no displayable text content)`;
}

export function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      return maybeId;
    }
    return undefined;
  }

  if (message.type === "user") {
    return toolResultBlocksFromUserMessage(message)[0]?.toolUseId;
  }

  if (message.type === "stream_event") {
    const event = message.event as {
      type?: unknown;
      content_block?: { id?: unknown };
    };
    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }

  return undefined;
}

/**
 * The SDK warns on every full-access query that `canUseTool` is shadowed by
 * `bypassPermissions`. Here that is the intended setup: ordinary tools run
 * unprompted, while AskUserQuestion requires user interaction and the CLI
 * checks that before the bypass mode, so the question card still reaches the
 * callback. Drops only that warning, and only while the query is created (the
 * SDK emits it synchronously).
 */
export function withoutCanUseToolShadowWarning<A>(create: () => A): A {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: ReadonlyArray<unknown>) => {
    const options = rest[0];
    if (
      typeof options === "object" &&
      options !== null &&
      "code" in options &&
      options.code === "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED"
    ) {
      return;
    }
    Reflect.apply(emitWarning, process, [warning, ...rest]);
  }) as typeof process.emitWarning;
  try {
    return create();
  } finally {
    process.emitWarning = emitWarning;
  }
}
