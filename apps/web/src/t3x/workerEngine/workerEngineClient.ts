import type {
  EnvironmentId,
  WorkerAckInput,
  WorkerAckResult,
  WorkerCheckInput,
  WorkerCheckResult,
  WorkerDecisionGateRecord,
  WorkerDecisionGateStatus,
  WorkerDispatchInput,
  WorkerDispatchReceipt,
  WorkerGateCreateInput,
  WorkerGateResolveInput,
  WorkerStatusResult,
  WorkerStopInput,
  WorkerStopResult,
  WorkerWorktreeActionResult,
  WorkerWorktreeDiffResult,
} from "@t3tools/contracts";

import { readDesktopPrimaryBearerToken } from "~/environments/primary/desktopAuth";
import {
  isDesktopDirectPrimary,
  resolvePrimaryEnvironmentHttpUrl,
} from "~/environments/primary/target";
import { readPreparedConnection } from "~/state/session";

const WORKER_ENGINE_API_PREFIX = "/api/worker-engine";

export class WorkerEngineClientError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options?: {
      readonly status?: number | null;
      readonly details?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "WorkerEngineClientError";
    this.code = code;
    this.status = options?.status ?? null;
    if (options?.details) {
      this.details = options.details;
    }
  }
}

interface WorkerEngineEnvelope<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: Record<string, unknown>;
  };
}

export interface WorkerEngineRequestContext {
  readonly environmentId?: EnvironmentId | null;
  readonly primaryEnvironmentId?: EnvironmentId | null;
  readonly signal?: AbortSignal;
  readonly fetchFn?: typeof globalThis.fetch;
}

function buildSearchParams(
  entries: Readonly<Record<string, string | undefined | null>>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    const trimmed = value?.trim();
    if (trimmed) {
      out[key] = trimmed;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function resolveRemoteEndpointUrl(
  httpBaseUrl: string,
  pathname: string,
  searchParams?: Record<string, string>,
): string {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.search = searchParams ? new URLSearchParams(searchParams).toString() : "";
  url.hash = "";
  return url.toString();
}

function isSameOriginBrowserUrl(targetUrl: string): boolean {
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }
  try {
    return new URL(targetUrl).origin === window.location.origin;
  } catch {
    return false;
  }
}

async function resolveWorkerEngineFetchTarget(
  pathname: string,
  searchParams: Record<string, string> | undefined,
  context: WorkerEngineRequestContext,
): Promise<{
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly credentials: RequestCredentials;
}> {
  const useRemote =
    context.environmentId !== undefined &&
    context.environmentId !== null &&
    context.primaryEnvironmentId !== undefined &&
    context.primaryEnvironmentId !== null &&
    context.environmentId !== context.primaryEnvironmentId;

  if (useRemote && context.environmentId) {
    const prepared = readPreparedConnection(context.environmentId);
    if (!prepared) {
      throw new WorkerEngineClientError(
        "environment_unavailable",
        "선택한 원격 실행 환경에 아직 연결되지 않았습니다.",
      );
    }
    const url = resolveRemoteEndpointUrl(prepared.httpBaseUrl, pathname, searchParams);
    if (prepared.httpAuthorization?._tag === "Bearer") {
      return {
        url,
        headers: { Authorization: `Bearer ${prepared.httpAuthorization.token}` },
        credentials: "omit",
      };
    }
    if (prepared.httpAuthorization?._tag === "Dpop") {
      throw new WorkerEngineClientError(
        "dpop_not_supported",
        "현재 릴레이(DPoP) 원격 환경에서는 작업자 엔진 HTTP 패널을 직접 조회할 수 없습니다. 로컬 또는 Bearer 연결 환경에서 사용하세요.",
      );
    }
    return {
      url,
      headers: {},
      credentials: isSameOriginBrowserUrl(url) ? "include" : "omit",
    };
  }

  const url = resolvePrimaryEnvironmentHttpUrl(pathname, searchParams);
  if (isSameOriginBrowserUrl(url)) {
    return {
      url,
      headers: {},
      credentials: "include",
    };
  }

  if (isDesktopDirectPrimary()) {
    return {
      url,
      headers: {},
      credentials: "omit",
    };
  }

  const bearerToken = await readDesktopPrimaryBearerToken();
  return {
    url,
    headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {},
    credentials: "omit",
  };
}

export async function parseWorkerEngineResponse<T>(response: Response): Promise<T> {
  let payload: WorkerEngineEnvelope<T> | null = null;
  try {
    payload = (await response.json()) as WorkerEngineEnvelope<T>;
  } catch {
    throw new WorkerEngineClientError(
      "invalid_response",
      `작업자 엔진 응답을 해석하지 못했습니다 (HTTP ${response.status}).`,
      { status: response.status },
    );
  }

  if (!response.ok || !payload?.ok || payload.result === undefined) {
    const code = payload?.error?.code ?? `http_${response.status}`;
    const message =
      payload?.error?.message ?? `작업자 엔진 요청에 실패했습니다 (HTTP ${response.status}).`;
    throw new WorkerEngineClientError(code, message, {
      status: response.status,
      ...(payload?.error?.details ? { details: payload.error.details } : {}),
    });
  }

  return payload.result;
}

async function requestWorkerEngine<T>(
  method: "GET" | "POST",
  subpath: string,
  options: {
    readonly searchParams?: Record<string, string>;
    readonly body?: unknown;
    readonly context?: WorkerEngineRequestContext;
  } = {},
): Promise<T> {
  const context = options.context ?? {};
  const pathname = `${WORKER_ENGINE_API_PREFIX}${subpath}`;
  const target = await resolveWorkerEngineFetchTarget(pathname, options.searchParams, context);
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...target.headers,
  };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
  }

  const fetchFn = context.fetchFn ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(target.url, {
      method,
      headers,
      credentials: target.credentials,
      ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new WorkerEngineClientError(
      "network_error",
      `작업자 엔진 서버와 통신하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return await parseWorkerEngineResponse<T>(response);
}

export function getWorkerStatus(
  params: {
    readonly threadId?: string | null;
    readonly runId?: string | null;
    readonly taskId?: string | null;
  } = {},
  context?: WorkerEngineRequestContext,
): Promise<WorkerStatusResult> {
  const searchParams = buildSearchParams({
    threadId: params.threadId,
    runId: params.runId,
    taskId: params.taskId,
  });
  return requestWorkerEngine<WorkerStatusResult>("GET", "/status", {
    ...(searchParams ? { searchParams } : {}),
    ...(context ? { context } : {}),
  });
}

export function dispatchWorker(
  input: WorkerDispatchInput,
  context?: WorkerEngineRequestContext,
): Promise<WorkerDispatchReceipt> {
  return requestWorkerEngine<WorkerDispatchReceipt>("POST", "/dispatch", {
    body: input,
    ...(context ? { context } : {}),
  });
}

export function checkWorkerMailbox(
  input: WorkerCheckInput,
  context?: WorkerEngineRequestContext,
): Promise<WorkerCheckResult> {
  return requestWorkerEngine<WorkerCheckResult>("POST", "/check", {
    body: input,
    ...(context ? { context } : {}),
  });
}

export function ackWorkerDelivery(
  input: WorkerAckInput,
  context?: WorkerEngineRequestContext,
): Promise<WorkerAckResult> {
  return requestWorkerEngine<WorkerAckResult>("POST", "/ack", {
    body: input,
    ...(context ? { context } : {}),
  });
}

export function stopWorkerDispatch(
  input: WorkerStopInput,
  context?: WorkerEngineRequestContext,
): Promise<WorkerStopResult> {
  return requestWorkerEngine<WorkerStopResult>("POST", "/stop", {
    body: input,
    ...(context ? { context } : {}),
  });
}

export async function listWorkerGates(
  params: {
    readonly taskId?: string | null;
    readonly threadId?: string | null;
    readonly status?: WorkerDecisionGateStatus;
  } = {},
  context?: WorkerEngineRequestContext,
): Promise<ReadonlyArray<WorkerDecisionGateRecord>> {
  const searchParams = buildSearchParams({
    taskId: params.taskId,
    threadId: params.threadId,
    status: params.status,
  });
  const result = await requestWorkerEngine<{
    readonly gates: ReadonlyArray<WorkerDecisionGateRecord>;
  }>("GET", "/gates", {
    ...(searchParams ? { searchParams } : {}),
    ...(context ? { context } : {}),
  });
  return result.gates;
}

export async function createWorkerGate(
  input: WorkerGateCreateInput,
  context?: WorkerEngineRequestContext,
): Promise<WorkerDecisionGateRecord> {
  const result = await requestWorkerEngine<{ readonly gate: WorkerDecisionGateRecord }>(
    "POST",
    "/gates",
    {
      body: input,
      ...(context ? { context } : {}),
    },
  );
  return result.gate;
}

export async function resolveWorkerGate(
  input: WorkerGateResolveInput,
  context?: WorkerEngineRequestContext,
): Promise<WorkerDecisionGateRecord> {
  const result = await requestWorkerEngine<{ readonly gate: WorkerDecisionGateRecord }>(
    "POST",
    "/gates/resolve",
    {
      body: input,
      ...(context ? { context } : {}),
    },
  );
  return result.gate;
}

export function getWorkerWorktreeDiff(
  taskId: string,
  context?: WorkerEngineRequestContext,
): Promise<WorkerWorktreeDiffResult> {
  return requestWorkerEngine<WorkerWorktreeDiffResult>("GET", "/worktree/diff", {
    searchParams: { taskId },
    ...(context ? { context } : {}),
  });
}

export function mergeWorkerWorktree(
  taskId: string,
  context?: WorkerEngineRequestContext,
): Promise<WorkerWorktreeActionResult> {
  return requestWorkerEngine<WorkerWorktreeActionResult>("POST", "/worktree/merge", {
    body: { taskId },
    ...(context ? { context } : {}),
  });
}

export function discardWorkerWorktree(
  taskId: string,
  context?: WorkerEngineRequestContext,
): Promise<WorkerWorktreeActionResult> {
  return requestWorkerEngine<WorkerWorktreeActionResult>("POST", "/worktree/discard", {
    body: { taskId },
    ...(context ? { context } : {}),
  });
}
