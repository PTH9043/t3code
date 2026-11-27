import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  WorkerAckInput,
  WorkerCheckInput,
  WorkerDispatchInput,
  WorkerGateCreateInput,
  WorkerGateResolveInput,
  WorkerStopInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import { WorkerEngineError } from "./WorkerEngineStore.ts";
import { WorkerEngineService } from "./WorkerEngineService.ts";

const WORKER_ENGINE_PREFIX = "/api/worker-engine";

const authenticateWorkerRoute = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

function statusForWorkerError(error: WorkerEngineError): number {
  switch (error.code) {
    case "not_found":
      return 404;
    case "fencing_rejected":
    case "conflict":
    case "circuit_broken":
    case "invalid_state":
      return 409;
    case "concurrency_limit":
      return 429;
    case "worktree_error":
    case "storage_error":
      return 500;
  }
}

function handleWorkerErrors<E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  return effect.pipe(
    Effect.catch((error) => {
      if (error instanceof WorkerEngineError) {
        return Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            {
              ok: false,
              error: {
                code: error.code,
                message: error.message,
                ...(error.details ? { details: error.details } : {}),
              },
            },
            { status: statusForWorkerError(error) },
          ),
        );
      }
      if (error && typeof error === "object" && "_tag" in error) {
        const tag = (error as { readonly _tag?: unknown })._tag;
        if (tag === "EnvironmentAuthInvalidError") {
          const reason = (error as { readonly reason?: unknown }).reason;
          return Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              {
                ok: false,
                error: {
                  code: "auth_invalid",
                  message: typeof reason === "string" ? reason : "Unauthorized",
                },
              },
              { status: 401 },
            ),
          );
        }
        if (tag === "EnvironmentScopeRequiredError") {
          const requiredScope = (error as { readonly requiredScope?: unknown }).requiredScope;
          return Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              {
                ok: false,
                error: {
                  code: "insufficient_scope",
                  message:
                    typeof requiredScope === "string"
                      ? `Missing required scope: ${requiredScope}`
                      : "Insufficient scope",
                },
              },
              { status: 403 },
            ),
          );
        }
        if (tag === "EnvironmentInternalError") {
          const reason = (error as { readonly reason?: unknown }).reason;
          return Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              {
                ok: false,
                error: {
                  code: "internal_error",
                  message: typeof reason === "string" ? reason : "Internal error",
                },
              },
              { status: 500 },
            ),
          );
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      return Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { ok: false, error: { code: "invalid_request", message } },
          { status: 400 },
        ),
      );
    }),
  );
}

const decodeBody = <A>(schema: Schema.Decoder<A, never>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = yield* request.json;
    return yield* Schema.decodeUnknownEffect(schema)(raw);
  });

const readQueryParam = (name: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://127.0.0.1");
    const val = url.searchParams.get(name)?.trim();
    return val && val.length > 0 ? val : undefined;
  });

const TaskIdBody = Schema.Struct({ taskId: Schema.String });

export const workerEngineHttpRoutesLayer = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    `${WORKER_ENGINE_PREFIX}/status`,
    handleWorkerErrors(
      Effect.gen(function* () {
        yield* authenticateWorkerRoute(AuthOrchestrationReadScope);
        const engine = yield* WorkerEngineService;
        const threadId = yield* readQueryParam("threadId");
        const runId = yield* readQueryParam("runId");
        const taskId = yield* readQueryParam("taskId");
        const result = yield* engine.status({ threadId, runId, taskId });
        return HttpServerResponse.jsonUnsafe({ ok: true, result });
      }),
    ),
  ),
  HttpRouter.add(
    "POST",
    `${WORKER_ENGINE_PREFIX}/dispatch`,
    handleWorkerErrors(
      Effect.gen(function* () {
        yield* authenticateWorkerRoute(AuthOrchestrationOperateScope);
        const engine = yield* WorkerEngineService;
        const payload = yield* decodeBody(WorkerDispatchInput);
        const result = yield* engine.dispatch(payload);
        return HttpServerResponse.jsonUnsafe({ ok: true, result });
      }),
    ),
  ),
  HttpRouter.add(
    "POST",
    `${WORKER_ENGINE_PREFIX}/check`,
    handleWorkerErrors(
      Effect.gen(function* () {
        yield* authenticateWorkerRoute(AuthOrchestrationOperateScope);
        const engine = yield* WorkerEngineService;
        const payload = yield* decodeBody(WorkerCheckInput);
        const result = yield* engine.check(payload);
        return HttpServerResponse.jsonUnsafe({ ok: true, result });
      }),
    ),
  ),
  HttpRouter.add(
    "POST",
    `${WORKER_ENGINE_PREFIX}/ack`,
    handleWorkerErrors(
      Effect.gen(function* () {
        yield* authenticateWorkerRoute(AuthOrchestrationOperateScope);
        const engine = yield* WorkerEngineService;
        const payload = yield* decodeBody(WorkerAckInput);
        const result = yield* engine.ack(payload);
        return HttpServerResponse.jsonUnsafe({ ok: true, result });
      }),
    ),
  ),
  HttpRouter.add(
    "POST",
    `${WORKER_ENGINE_PREFIX}/stop`,
    handleWorkerErrors(
      Effect.gen(function* () {
        yield* authenticateWorkerRoute(AuthOrchestrationOperateScope);
        const engine = yield* WorkerEngineService;
        const payload = yield* decodeBody(WorkerStopInput);
        const result = yield* engine.stop(payload);
        return HttpServerResponse.jsonUnsafe({ ok: true, result });
      }),
    ),
  ),
  HttpRouter.add(
    "GET",
    `${WORKER_ENGINE_PREFIX}/gates`,
    handleWorkerErrors(
      Effect.gen(function* () {
        yield* authenticateWorkerRoute(AuthOrchestrationReadScope);
        const engine = yield* WorkerEngineService;
        const taskId = yield* readQueryParam("taskId");
        const threadId = yield* readQueryParam("threadId");
        const statusParam = yield* readQueryParam("status");
        const gates = yield* engine.listGates({
          taskId,
          threadId,
          ...(statusParam === "open" ||
          statusParam === "approved" ||
          statusParam === "denied" ||
          statusParam === "expired"
            ? { status: statusParam }
            : {}),
        });
        return HttpServerResponse.jsonUnsafe({ ok: true, result: { gates } });
      }),
    ),
  ),
  HttpRouter.add(
    "POST",
    `${WORKER_ENGINE_PREFIX}/gates`,
    handleWorkerErrors(
      Effect.gen(function* () {
        yield* authenticateWorkerRoute(AuthOrchestrationOperateScope);
        const engine = yield* WorkerEngineService;
        const payload = yield* decodeBody(WorkerGateCreateInput);
        const gate = yield* engine.createGate(payload);
        return HttpServerResponse.jsonUnsafe({ ok: true, result: { gate } });
      }),
    ),
  ),
  HttpRouter.add(
    "POST",
    `${WORKER_ENGINE_PREFIX}/gates/resolve`,
    handleWorkerErrors(
      Effect.gen(function* () {
        yield* authenticateWorkerRoute(AuthOrchestrationOperateScope);
        const engine = yield* WorkerEngineService;
        const payload = yield* decodeBody(WorkerGateResolveInput);
        const gate = yield* engine.resolveGate(payload);
        return HttpServerResponse.jsonUnsafe({ ok: true, result: { gate } });
      }),
    ),
  ),
  HttpRouter.add(
    "GET",
    `${WORKER_ENGINE_PREFIX}/worktree/diff`,
    handleWorkerErrors(
      Effect.gen(function* () {
        yield* authenticateWorkerRoute(AuthOrchestrationReadScope);
        const engine = yield* WorkerEngineService;
        const taskId = yield* readQueryParam("taskId");
        if (!taskId) {
          return yield* new WorkerEngineError({
            code: "invalid_state",
            message: "Query parameter 'taskId' is required.",
          });
        }
        const result = yield* engine.inspectWorktreeDiff(taskId);
        return HttpServerResponse.jsonUnsafe({ ok: true, result });
      }),
    ),
  ),
  HttpRouter.add(
    "POST",
    `${WORKER_ENGINE_PREFIX}/worktree/merge`,
    handleWorkerErrors(
      Effect.gen(function* () {
        yield* authenticateWorkerRoute(AuthOrchestrationOperateScope);
        const engine = yield* WorkerEngineService;
        const payload = yield* decodeBody(TaskIdBody);
        const result = yield* engine.mergeWorktree(payload.taskId);
        return HttpServerResponse.jsonUnsafe({ ok: true, result });
      }),
    ),
  ),
  HttpRouter.add(
    "POST",
    `${WORKER_ENGINE_PREFIX}/worktree/discard`,
    handleWorkerErrors(
      Effect.gen(function* () {
        yield* authenticateWorkerRoute(AuthOrchestrationOperateScope);
        const engine = yield* WorkerEngineService;
        const payload = yield* decodeBody(TaskIdBody);
        const result = yield* engine.discardWorktree(payload.taskId);
        return HttpServerResponse.jsonUnsafe({ ok: true, result });
      }),
    ),
  ),
);
