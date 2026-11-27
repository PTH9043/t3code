import {
  OPENCODE_API_KEY_ENV,
  WorkspaceHelperError,
  type WorkspaceHelperInput,
  type WorkspaceHelperResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { helperAllowedForModel, parseHelperAccount } from "../../provider/subagentSelection.ts";
import {
  LOCAL_OLLAMA_BASE_URL,
  LOCAL_OLLAMA_INSTANCE,
  LOCAL_OLLAMA_PROVIDER,
} from "../../provider/localOllama.ts";
import { unifiedExecutionLedger } from "../../t3x/executionLedger/UnifiedExecutionLedger.ts";

const LOCAL_OLLAMA_DEFAULT_NUM_CTX = 16_384;
const LOCAL_OLLAMA_DEFAULT_KEEP_ALIVE = "30m";

function isLocalLoopbackUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "::1" ||
        parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

/** The slice of a provider instance this module reads. */
export interface WorkspaceHelperInstance {
  readonly driver: string;
  readonly displayName?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly config?: unknown;
  readonly environment?:
    | ReadonlyArray<{ readonly name: string; readonly value: string }>
    | undefined;
}

export type WorkspaceHelperRequest = (url: string, options: RequestInit) => Promise<Response>;

const HELPER_TIMEOUT_MS = 120_000;
let helperRunSequence = 0;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const HELPER_SYSTEM_PROMPT =
  "You are a helper for another AI agent. Do exactly the task you are given, using only the material provided, and answer in the language of the task. Use ultra-concise telegraphic output: preserve exact code, identifiers, paths, commands, numbers, and negations verbatim while omitting greetings, preamble, and filler. Say plainly when unsure or lacking data; never invent facts, sources, or quotations.";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

const unavailable = (message: string, projectContentAllowed = false): WorkspaceHelperResult => ({
  available: false,
  account: null,
  model: null,
  projectContentAllowed,
  text: null,
  inputTokens: null,
  outputTokens: null,
  message,
});

/**
 * Runs a chore on the helper API assigned to the calling model.
 *
 * The assignment lives in the calling provider account's settings
 * (`helperAccount`, `helperForModels`, `helperScope`); the helper itself is a
 * registered API account (an OpenCode instance with an API connection). A
 * missing or disallowed assignment is a normal answer (`available: false`),
 * not an error, so the caller simply does the chore itself.
 */
export const runWorkspaceHelper = Effect.fn("runWorkspaceHelper")(function* (input: {
  readonly providerInstances: Readonly<Record<string, WorkspaceHelperInstance>>;
  readonly providers?: Readonly<Record<string, unknown>> | undefined;
  readonly callerInstanceId: string;
  readonly callerModel: string | undefined;
  readonly threadId?: string | undefined;
  readonly request: WorkspaceHelperInput;
  readonly fetch?: WorkspaceHelperRequest | undefined;
}) {
  const instanceSettings = record(input.providerInstances[input.callerInstanceId]?.config);
  const legacySettings = record(input.providers?.[input.callerInstanceId]);
  const callerSettings =
    text(instanceSettings.helperAccount) !== undefined
      ? instanceSettings
      : { ...legacySettings, ...instanceSettings };
  const projectContentAllowed = callerSettings.helperScope === "project";
  const assignment = parseHelperAccount(text(callerSettings.helperAccount));
  if (!assignment)
    return unavailable(
      "이 계정에는 하위 API가 지정되어 있지 않습니다. 작업을 직접 처리하세요.",
      projectContentAllowed,
    );
  if (!helperAllowedForModel(text(callerSettings.helperForModels), input.callerModel))
    return unavailable(
      "지금 답변 중인 모델에는 하위 API 사용이 허용되어 있지 않습니다. 작업을 직접 처리하세요.",
      projectContentAllowed,
    );

  const wanted = assignment.account.toLowerCase();
  const wantsLocalOllama =
    wanted === LOCAL_OLLAMA_INSTANCE || wanted === "ollama" || wanted === LOCAL_OLLAMA_PROVIDER;
  const match = Object.entries(input.providerInstances).find(
    ([id, instance]) =>
      instance.driver === "opencode" &&
      instance.enabled !== false &&
      (id.toLowerCase() === wanted || instance.displayName?.trim().toLowerCase() === wanted),
  );
  const connection = record(record(match?.[1].config).apiConnection);
  const explicitBaseUrl = text(connection.baseUrl);
  const fallbackLocalOllama = !match && wantsLocalOllama;
  const baseUrl = explicitBaseUrl ?? (fallbackLocalOllama ? LOCAL_OLLAMA_BASE_URL : undefined);
  if ((!match && !fallbackLocalOllama) || !baseUrl)
    return unavailable(
      `하위 API 계정 "${assignment.account}"을(를) 찾지 못했습니다. 설정의 계정 이름을 확인하세요.`,
      projectContentAllowed,
    );
  const isLocalOllamaConnection =
    fallbackLocalOllama ||
    connection.providerId === LOCAL_OLLAMA_PROVIDER ||
    (wantsLocalOllama && isLocalLoopbackUrl(baseUrl));
  const rawModelName = assignment.model.startsWith(`${LOCAL_OLLAMA_PROVIDER}/`)
    ? assignment.model.slice(`${LOCAL_OLLAMA_PROVIDER}/`.length)
    : assignment.model;
  if (!fallbackLocalOllama) {
    const models = Array.isArray(connection.models) ? connection.models : [];
    if (
      !models.includes(assignment.model) &&
      !(isLocalOllamaConnection && models.includes(rawModelName))
    )
      return unavailable(
        `하위 API 계정 "${assignment.account}"에 모델 "${assignment.model}"이(가) 등록되어 있지 않습니다.`,
        projectContentAllowed,
      );
    if (connection.protocol !== "chat-completions")
      return unavailable(
        "하위 API는 chat-completions 방식의 계정만 지원합니다.",
        projectContentAllowed,
      );
  }
  const apiKey = match?.[1].environment
    ?.find((entry) => entry.name === OPENCODE_API_KEY_ENV)
    ?.value.trim();
  const allowKeylessLocal = isLocalOllamaConnection && isLocalLoopbackUrl(baseUrl);
  if (!apiKey && !allowKeylessLocal)
    return unavailable(
      `하위 API 계정 "${assignment.account}"에 API 키가 없습니다.`,
      projectContentAllowed,
    );
  const resolvedModel = isLocalOllamaConnection ? rawModelName : assignment.model;
  const ready: WorkspaceHelperResult = {
    available: true,
    account: match ? (match[1].displayName ?? match[0]) : "Ollama",
    model: resolvedModel,
    projectContentAllowed,
    text: null,
    inputTokens: null,
    outputTokens: null,
    message: null,
  };
  if (input.request.action === "status") return ready;

  const task = input.request.task;
  if (!task) return yield* new WorkspaceHelperError({ message: "run에는 task가 필요합니다." });
  const endpoint = yield* Effect.try({
    try: () => {
      const url = new URL(baseUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Invalid API URL");
      return `${url.toString().replace(/\/+$/, "")}/chat/completions`;
    },
    catch: () => new WorkspaceHelperError({ message: "하위 API 주소가 올바르지 않습니다." }),
  });
  const context = input.request.context?.trim();
  const send = input.fetch ?? fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const requestPayload: Record<string, unknown> = {
    model: resolvedModel,
    messages: [
      { role: "system", content: HELPER_SYSTEM_PROMPT },
      { role: "user", content: context ? `${task}\n\n<material>\n${context}\n</material>` : task },
    ],
    ...(isLocalOllamaConnection
      ? {
          keep_alive: LOCAL_OLLAMA_DEFAULT_KEEP_ALIVE,
          options: { num_ctx: LOCAL_OLLAMA_DEFAULT_NUM_CTX },
        }
      : {}),
  };
  const helperStartedAtMs = yield* Clock.currentTimeMillis;
  helperRunSequence += 1;
  const helperRunId = `helper:${input.callerInstanceId}:${helperStartedAtMs.toString(36)}:${helperRunSequence}`;
  yield* unifiedExecutionLedger.beginEffect({
    executionId: helperRunId,
    executionKind: "workspace_helper",
    threadId: input.threadId ?? input.callerInstanceId,
    summary: `하위 API (${resolvedModel}): ${task.slice(0, 80)}`,
    provider: ready.account,
    model: resolvedModel,
    startedAtMs: helperStartedAtMs,
  });

  const executeHelperRequest = Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        send(endpoint, {
          method: "POST",
          headers,
          body: encodeJson(requestPayload),
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(HELPER_TIMEOUT_MS)]),
        }),
      catch: () =>
        new WorkspaceHelperError({
          message: "하위 API에 연결하지 못했습니다. 작업을 직접 처리하세요.",
        }),
    });
    if (!response.ok)
      return yield* new WorkspaceHelperError({
        message:
          response.status === 401 || response.status === 403
            ? "하위 API 키가 유효하지 않거나 권한이 없습니다. 작업을 직접 처리하세요."
            : `하위 API 요청이 실패했습니다 (HTTP ${response.status}). 작업을 직접 처리하세요.`,
      });
    const payload = record(
      yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: () => new WorkspaceHelperError({ message: "하위 API 응답을 읽지 못했습니다." }),
      }),
    );
    const choice = record(Array.isArray(payload.choices) ? payload.choices[0] : undefined);
    const answer = text(record(choice.message).content);
    if (!answer)
      return yield* new WorkspaceHelperError({
        message: "하위 API가 내용 없는 응답을 보냈습니다. 작업을 직접 처리하세요.",
      });
    const usage = record(payload.usage);
    return {
      ...ready,
      text: answer,
      inputTokens: count(usage.prompt_tokens),
      outputTokens: count(usage.completion_tokens),
    } satisfies WorkspaceHelperResult;
  });

  return yield* executeHelperRequest.pipe(
    Effect.onExit((exit) =>
      Effect.sync(() => {
        if (Exit.isSuccess(exit)) {
          unifiedExecutionLedger.finish({
            executionId: helperRunId,
            executionKind: "workspace_helper",
            status: "completed",
          });
        } else if (Cause.hasInterruptsOnly(exit.cause)) {
          unifiedExecutionLedger.finish({
            executionId: helperRunId,
            executionKind: "workspace_helper",
            status: "cancelled",
            errorMessage: "하위 API 요청이 중단되었습니다.",
          });
        } else {
          const squashed = Cause.squash(exit.cause);
          unifiedExecutionLedger.finish({
            executionId: helperRunId,
            executionKind: "workspace_helper",
            status: "failed",
            errorMessage: squashed instanceof Error ? squashed.message : String(squashed),
          });
        }
      }),
    ),
  );
});
