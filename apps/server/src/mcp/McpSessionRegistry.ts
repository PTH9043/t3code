import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { TurnDelegateTeam } from "../provider/subagentSelection.ts";
import type { WatchdogJournal } from "../orchestration/WatchdogJournal.ts";
import { WatchdogRuntime } from "../orchestration/WatchdogRuntime.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly ownerThreadId?: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtimeMode?: McpInvocationContext.McpInvocationScope["runtimeMode"];
  readonly interactionMode?: McpInvocationContext.McpInvocationScope["interactionMode"];
  readonly executionCwd?: string;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly issueWatchdog: (input: {
    readonly request: McpCredentialRequest & { readonly ownerThreadId: ThreadId };
    readonly journal: WatchdogJournal;
    readonly jobId: string;
    readonly capability: string;
  }) => Effect.Effect<McpIssuedCredential | undefined>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  readonly restoreWatchdog: (input: {
    readonly journal: WatchdogJournal;
    readonly jobId: string;
    readonly challenge: {
      readonly challengeId: string;
      readonly nonce: Uint8Array;
      readonly workerId: string;
    };
  }) => Effect.Effect<boolean>;
  readonly confirmWatchdogRecovery: (sessionThreadId: ThreadId) => Effect.Effect<void>;
  /**
   * Records a sign of life for every credential bound to `threadId`. Provider
   * turns call this so that a session which is plainly alive keeps its
   * credential even when it goes a long time without touching an MCP tool.
   */
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly setExecutionPolicy: (
    threadId: ThreadId,
    policy: {
      readonly runtimeMode: McpInvocationContext.McpInvocationScope["runtimeMode"];
      readonly interactionMode: McpInvocationContext.McpInvocationScope["interactionMode"];
      readonly providerSessionId?: string | undefined;
      readonly delegateTeam?: TurnDelegateTeam | undefined;
      readonly activeDelegateTurnId?: McpInvocationContext.McpInvocationScope["activeDelegateTurnId"];
      readonly steering?: boolean;
    },
  ) => Effect.Effect<TurnDelegateTeam | undefined>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly sessionThreadId: ThreadId;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly lastAliveAt: number;
  readonly isStillActive?: (timestamp: number) => boolean;
  readonly recoveryPending?: boolean;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
  readonly recoveryWaiters: ReadonlyMap<
    string,
    { readonly signal: Deferred.Deferred<void>; readonly count: number }
  >;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
}

/**
 * How long a credential outlives the last sign of life from its provider
 * session.
 *
 * Liveness is refreshed both by MCP traffic and by `touch` on every provider
 * turn, so a session that is still doing work never expires no matter how long
 * it goes between browser tool calls. This window therefore only bounds
 * credentials whose session died without a clean stop — the normal paths
 * (`stopSession`, `stopAll`) revoke eagerly and do not wait for it.
 *
 * The bound matters because `/mcp` is mounted outside the environment auth
 * stack and is reachable on whatever host the server binds to, so this token is
 * the only thing guarding the preview toolkit on a remote-reachable server.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const getHttpMcpEndpointHost = (hostname: string): string => {
  const normalized = hostname.toLowerCase();
  const endpointHostname =
    normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]"
      ? "127.0.0.1"
      : hostname;
  return endpointHostname.includes(":") && !endpointHostname.startsWith("[")
    ? `[${endpointHostname}]`
    : endpointHostname;
};

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({
    records: new Map(),
    recoveryWaiters: new Map(),
  });
  const watchdogRuntime = yield* Effect.serviceOption(WatchdogRuntime);
  const watchdogJournal = Option.getOrUndefined(watchdogRuntime)?.journal;
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const endpoint =
    httpServer.address._tag === "TcpAddress"
      ? `http://${getHttpMcpEndpointHost(httpServer.address.hostname)}:${httpServer.address.port}/mcp`
      : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const pruneDead = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) => {
    const next = new Map(
      Array.from(records).filter(
        ([, record]) => timestamp - record.lastAliveAt <= livenessWindowMs,
      ),
    );
    return next.size === records.size ? records : next;
  };

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        threadId: request.ownerThreadId ?? request.threadId,
        sessionKey: request.threadId,
        providerSessionId,
        providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
        ...(request.runtimeMode === undefined ? {} : { runtimeMode: request.runtimeMode }),
        ...(request.interactionMode === undefined
          ? {}
          : { interactionMode: request.interactionMode }),
        ...(request.executionCwd === undefined ? {} : { executionCwd: request.executionCwd }),
        capabilities: new Set(["preview"]),
        issuedAt,
      };
      yield* SynchronizedRef.update(state, ({ records, recoveryWaiters }) => {
        const next = new Map(pruneDead(records, issuedAt));
        next.set(tokenHash, {
          tokenHash,
          scope,
          sessionThreadId: request.threadId,
          lastAliveAt: issuedAt,
        });
        return { records: next, recoveryWaiters };
      });
      return {
        config: {
          environmentId,
          threadId: request.threadId,
          providerSessionId,
          providerInstanceId: scope.providerInstanceId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
        },
      };
    },
  );

  const resolveHash = Effect.fn("McpSessionRegistry.resolveHash")(function* (tokenHash: string) {
    const timestamp = yield* currentTimeMillis;
    return yield* SynchronizedRef.modify(state, ({ records, recoveryWaiters }) => {
      const current = pruneDead(records, timestamp);
      const record = current.get(tokenHash);
      if (!record) return [undefined, { records: current, recoveryWaiters }] as const;
      if (record.recoveryPending)
        return [undefined, { records: current, recoveryWaiters }] as const;
      if (record.isStillActive && !record.isStillActive(timestamp)) {
        const next = new Map(current);
        next.delete(tokenHash);
        return [undefined, { records: next, recoveryWaiters }] as const;
      }
      const next = new Map(current);
      next.set(tokenHash, { ...record, lastAliveAt: timestamp });
      return [record.scope, { records: next, recoveryWaiters }] as const;
    });
  });

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const scope = yield* resolveHash(tokenHash);
      if (scope || !watchdogJournal) return scope;
      const timestamp = yield* currentTimeMillis;
      const recoverable = yield* Effect.sync(() => {
        try {
          return watchdogJournal.recoverableMcpCredential(
            Buffer.from(tokenHash, "hex"),
            environmentId,
            timestamp,
            livenessWindowMs,
          );
        } catch {
          return false;
        }
      });
      if (!recoverable) return undefined;
      const fresh = yield* Deferred.make<void>();
      const signal = yield* SynchronizedRef.modify(state, ({ records, recoveryWaiters }) => {
        const record = records.get(tokenHash);
        if (record && !record.recoveryPending)
          return [undefined, { records, recoveryWaiters }] as const;
        const next = new Map(recoveryWaiters);
        const existing = next.get(tokenHash);
        const signal = existing?.signal ?? fresh;
        next.set(tokenHash, { signal, count: (existing?.count ?? 0) + 1 });
        return [signal, { records, recoveryWaiters: next }] as const;
      });
      if (signal) {
        yield* Deferred.await(signal).pipe(
          Effect.timeoutOption("10 seconds"),
          Effect.ensuring(
            SynchronizedRef.update(state, ({ records, recoveryWaiters }) => {
              const current = recoveryWaiters.get(tokenHash);
              if (!current || current.signal !== signal) return { records, recoveryWaiters };
              const next = new Map(recoveryWaiters);
              if (current.count === 1) next.delete(tokenHash);
              else next.set(tokenHash, { ...current, count: current.count - 1 });
              return { records, recoveryWaiters: next };
            }),
          ),
        );
      }
      return yield* resolveHash(tokenHash);
    },
  );

  const restoreWatchdog: McpSessionRegistryShape["restoreWatchdog"] = Effect.fn(
    "McpSessionRegistry.restoreWatchdog",
  )(function* ({ journal, jobId, challenge }) {
    const restored = yield* Effect.sync(() =>
      journal.consumeAttestedMcpCredential(jobId, challenge),
    );
    if (!restored || restored.environmentId !== environmentId) return false;
    const timestamp = yield* currentTimeMillis;
    const tokenHash = bytesToHex(restored.tokenHash);
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId,
      threadId: ThreadId.make(restored.ownerThreadId),
      sessionKey: ThreadId.make(restored.sessionId),
      providerSessionId: restored.providerSessionId,
      providerInstanceId: ProviderInstanceId.make(restored.providerInstanceId),
      ...(restored.runtimeMode ? { runtimeMode: restored.runtimeMode } : {}),
      ...(restored.interactionMode ? { interactionMode: restored.interactionMode } : {}),
      ...(restored.executionCwd ? { executionCwd: restored.executionCwd } : {}),
      capabilities: new Set(["preview"]),
      issuedAt: restored.issuedAt,
    };
    const isStillActive = (at: number) => {
      try {
        const worker = journal.worker(jobId);
        return (
          journal.activeMcpCredential(jobId, challenge.workerId) &&
          worker !== undefined &&
          at >= worker.lastHeartbeatAt &&
          at - worker.lastHeartbeatAt <= livenessWindowMs
        );
      } catch {
        return false;
      }
    };
    if (!isStillActive(timestamp)) return false;
    yield* SynchronizedRef.update(state, ({ records, recoveryWaiters }) => {
      const next = new Map(pruneDead(records, timestamp));
      next.set(tokenHash, {
        tokenHash,
        scope,
        sessionThreadId: scope.sessionKey!,
        lastAliveAt: timestamp,
        isStillActive,
        recoveryPending: true,
      });
      return { records: next, recoveryWaiters };
    });
    return true;
  });

  const confirmWatchdogRecovery: McpSessionRegistryShape["confirmWatchdogRecovery"] = Effect.fn(
    "McpSessionRegistry.confirmWatchdogRecovery",
  )(function* (sessionThreadId) {
    const signals = yield* SynchronizedRef.modify(state, ({ records, recoveryWaiters }) => {
      const next = new Map(records);
      const remaining = new Map(recoveryWaiters);
      const signals: Deferred.Deferred<void>[] = [];
      for (const [hash, record] of records) {
        if (record.sessionThreadId !== sessionThreadId || !record.recoveryPending) continue;
        next.set(hash, { ...record, recoveryPending: false });
        const waiting = remaining.get(hash);
        if (waiting) signals.push(waiting.signal);
        remaining.delete(hash);
      }
      return [signals, { records: next, recoveryWaiters: remaining }] as const;
    });
    yield* Effect.forEach(signals, (signal) => Deferred.succeed(signal, undefined), {
      discard: true,
    });
  });

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* currentTimeMillis;
      yield* SynchronizedRef.update(state, ({ records, recoveryWaiters }) => {
        const current = pruneDead(records, timestamp);
        const next = new Map(current);
        for (const [tokenHash, record] of current) {
          if (record.sessionThreadId === threadId) {
            next.set(tokenHash, { ...record, lastAliveAt: timestamp });
          }
        }
        return { records: next, recoveryWaiters };
      });
    },
  );

  const issueWatchdog: McpSessionRegistryShape["issueWatchdog"] = Effect.fn(
    "McpSessionRegistry.issueWatchdog",
  )(function* ({ request, journal, jobId, capability }) {
    const issued = yield* issue(request);
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const tokenHash = yield* hashToken(token);
    const scope = yield* resolve(token);
    if (!scope) return undefined;
    const bound = yield* Effect.sync(() => {
      try {
        journal.bindMcpCredential(jobId, capability, {
          token,
          environmentId,
          ownerThreadId: request.ownerThreadId,
          sessionId: request.threadId,
          providerSessionId: issued.config.providerSessionId,
          providerInstanceId: request.providerInstanceId,
          issuedAt: scope.issuedAt,
          ...(request.runtimeMode === "full-access" && request.interactionMode === "default"
            ? {
                runtimeMode: "full-access" as const,
                interactionMode: "default" as const,
                ...(request.executionCwd === undefined
                  ? {}
                  : { executionCwd: request.executionCwd }),
              }
            : {}),
        });
        return true;
      } catch {
        return false;
      }
    });
    const installed = yield* SynchronizedRef.modify(state, ({ records, recoveryWaiters }) => {
      const next = new Map(records);
      const prior = next.get(tokenHash);
      if (!bound || !prior) next.delete(tokenHash);
      else
        next.set(tokenHash, {
          ...prior,
          isStillActive: (at) => {
            try {
              const worker = journal.worker(jobId);
              return (
                worker !== undefined &&
                journal.activeMcpCredential(jobId, worker.workerId) &&
                at >= worker.lastHeartbeatAt &&
                at - worker.lastHeartbeatAt <= livenessWindowMs
              );
            } catch {
              return false;
            }
          },
        });
      return [bound && prior !== undefined, { records: next, recoveryWaiters }] as const;
    });
    return installed ? issued : undefined;
  });

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.update(state, ({ records, recoveryWaiters }) => ({
      records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
      recoveryWaiters,
    }));

  return McpSessionRegistry.of({
    issue,
    issueWatchdog,
    resolve,
    restoreWatchdog,
    confirmWatchdogRecovery,
    touch,
    setExecutionPolicy: (threadId, policy) =>
      SynchronizedRef.modifyEffect(state, ({ records, recoveryWaiters }) =>
        Effect.gen(function* () {
          const next = new Map(records);
          let delegateTeam: TurnDelegateTeam | undefined;
          for (const [hash, record] of records) {
            if (record.sessionThreadId !== threadId) continue;
            const scope = record.scope;
            const candidate = policy.steering ? scope.delegateTeam : policy.delegateTeam;
            const activeTurnId = policy.steering
              ? scope.activeDelegateTurnId
              : policy.activeDelegateTurnId;
            const bound =
              candidate?.threadId === threadId &&
              scope.threadId === threadId &&
              candidate.answeringInstanceId === scope.providerInstanceId &&
              scope.providerSessionId === policy.providerSessionId &&
              activeTurnId &&
              (!policy.steering || (yield* activeTurnId) !== undefined)
                ? candidate
                : undefined;
            if (bound) delegateTeam = bound;
            next.set(hash, {
              ...record,
              scope: {
                ...scope,
                delegateTeam: bound,
                activeDelegateTurnId: bound ? activeTurnId : undefined,
                runtimeMode: policy.runtimeMode,
                interactionMode: policy.interactionMode,
              },
            });
          }
          return [delegateTeam, { records: next, recoveryWaiters }] as const;
        }),
      ),
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.sessionThreadId === threadId);
    }),
    revokeAll: SynchronizedRef.update(state, ({ recoveryWaiters }) => ({
      records: new Map(),
      recoveryWaiters,
    })),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .revokeThread(request.threadId)
        .pipe(Effect.andThen(activeMcpSessionRegistry.issue(request)))
    : Effect.sync((): McpIssuedCredential | undefined => undefined);

/** The caller must create the matching journal job before issuing this credential. */
export const issueActiveWatchdogMcpCredential = (
  input: Parameters<McpSessionRegistryShape["issueWatchdog"]>[0],
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.issueWatchdog(input)
    : Effect.succeed(undefined);

export const restoreActiveWatchdogMcpCredential = (
  input: Parameters<McpSessionRegistryShape["restoreWatchdog"]>[0],
): Effect.Effect<boolean> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.restoreWatchdog(input)
    : Effect.succeed(false);

export const confirmActiveWatchdogMcpRecovery = (sessionThreadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.confirmWatchdogRecovery(sessionThreadId)
    : Effect.void;

/**
 * Refreshes the liveness of a thread's MCP credential. Called on every provider
 * turn so an active session is never mistaken for an abandoned one.
 */
export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

export const setActiveMcpExecutionPolicy = (
  threadId: ThreadId,
  policy: Parameters<McpSessionRegistryShape["setExecutionPolicy"]>[1],
): Effect.Effect<TurnDelegateTeam | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.setExecutionPolicy(threadId, policy)
    : Effect.succeed(undefined);

export const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
};
