// @effect-diagnostics anyUnknownInErrorContext:off
import {
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";

import { ServerConfig } from "../../config.ts";
import {
  chooseAutomaticAccount,
  isActualRateLimitFailure,
  isConfirmedQuotaExhaustion,
  requiresAutomaticAccountSwitch,
} from "../../provider/providerAccountSwitch.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadRuntimeRead,
} from "../Services/ProjectionSnapshotQuery.ts";
import { WorkspaceDevelopment } from "../WorkspaceDevelopment.ts";

export interface AutomaticAccountSelectorDeps<EResolve, EId> {
  readonly serverSettingsService: ServerSettingsService["Service"];
  readonly serverConfig: ServerConfig["Service"];
  readonly providerRegistry: ProviderRegistry["Service"];
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly providerService: ProviderService["Service"];
  readonly orchestrationEngine: OrchestrationEngineService["Service"];
  readonly resolveThread: (
    threadId: ThreadId,
    read?: ProjectionThreadRuntimeRead,
  ) => Effect.Effect<OrchestrationThread | undefined, EResolve>;
  readonly threadModelSelections: Map<string, ModelSelection>;
  readonly serverCommandId: (tag: string) => Effect.Effect<CommandId, EId>;
  readonly serverEventId: () => Effect.Effect<EventId, EId>;
}

export function makeAutomaticAccountSelector<EResolve, EId>(
  deps: AutomaticAccountSelectorDeps<EResolve, EId>,
) {
  const {
    serverSettingsService,
    serverConfig,
    providerRegistry,
    projectionSnapshotQuery,
    providerService,
    orchestrationEngine,
    resolveThread,
    threadModelSelections,
    serverCommandId,
    serverEventId,
  } = deps;

  return Effect.fn("selectAutomaticAccount")(function* (
    thread: OrchestrationThread,
    selection: ModelSelection,
    createdAt: string,
    /**
     * Why we are choosing an account. A `"rate-limit"` call already carries
     * evidence the current account is exhausted, so it must be allowed to move
     * the thread even when the thread is a Workspace Development main binding —
     * otherwise a bound session can never escape a 429 and every auto-switch
     * silently dies. The `"quota-recheck"` path (ordinary turn start) still
     * honors the binding so a pinned Owner/Main profile is not reshuffled by a
     * routine quota probe.
     */
    reason: "rate-limit" | "quota-recheck" = "quota-recheck",
    persistThreadSelection = true,
  ) {
    const settings = yield* serverSettingsService.getSettings;
    if (
      serverConfig.upgradeRoom ||
      (!settings.providerAutoSwitch.codex && !settings.providerAutoSwitch.claudeAgent)
    )
      return selection;
    const providers = yield* providerRegistry.getProviders;
    const current = providers.find((provider) => provider.instanceId === selection.instanceId);
    const sessionProvider = thread.session?.providerName;
    const sessionDriverHint: "codex" | "claudeAgent" | null =
      sessionProvider === "codex" || sessionProvider === "claudeAgent" ? sessionProvider : null;
    const registryDriver: "codex" | "claudeAgent" | null =
      current?.driver === "codex"
        ? "codex"
        : current?.driver === "claudeAgent"
          ? "claudeAgent"
          : null;
    const currentDriver: "codex" | "claudeAgent" | null =
      current === undefined ? sessionDriverHint : registryDriver;
    if (
      currentDriver === null ||
      !(currentDriver === "codex"
        ? settings.providerAutoSwitch.codex
        : settings.providerAutoSwitch.claudeAgent)
    )
      return selection;
    const earlyNowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const bindingBlocked = new Set<string>();
    if (
      thread.session?.providerInstanceId &&
      thread.session.status === "error" &&
      (currentDriver === "claudeAgent"
        ? isConfirmedQuotaExhaustion(thread.session.lastError)
        : isActualRateLimitFailure(thread.session.lastError)) &&
      earlyNowMs - Date.parse(thread.session.updatedAt) < 5 * 60_000
    )
      bindingBlocked.add(thread.session.providerInstanceId);
    if (projectionSnapshotQuery.getRateLimitedAccountIds !== undefined) {
      const ids = yield* projectionSnapshotQuery.getRateLimitedAccountIds(
        DateTime.formatIso(DateTime.makeUnsafe(earlyNowMs - 5 * 60_000)),
        currentDriver === "claudeAgent",
      );
      for (const instanceId of ids) bindingBlocked.add(instanceId);
    }
    const selectionBlocked = bindingBlocked.has(selection.instanceId);
    if (reason !== "rate-limit" && !selectionBlocked) {
      const development = yield* Effect.serviceOption(WorkspaceDevelopment);
      if (Option.isSome(development)) {
        const state = yield* development.value.get(thread.projectId);
        if (state?.enabled && state.bindings.some((binding) => binding.sessionKey === thread.id))
          return selection;
      }
    }
    const sessions = yield* providerService.listSessions();
    if (
      sessions.some(
        (session) =>
          session.threadId === thread.id &&
          (session.status === "running" ||
            (session.activeTurnId != null &&
              session.status !== "error" &&
              session.status !== "closed")),
      )
    )
      return selection;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const blocked = bindingBlocked;
    if (
      currentDriver === "claudeAgent" &&
      current === undefined &&
      !blocked.has(selection.instanceId)
    )
      return selection;
    if (!requiresAutomaticAccountSwitch(current, blocked, nowMs)) return selection;
    const currentInfo =
      current !== undefined
        ? yield* providerService.getInstanceInfo(selection.instanceId).pipe(Effect.option)
        : Option.none<{ continuationIdentity: { continuationKey: string } }>();
    const independent = yield* Effect.filter(providers, (candidate) =>
      candidate.driver !== currentDriver ||
      (current !== undefined && candidate.instanceId === current.instanceId)
        ? Effect.succeed(true)
        : Option.isSome(currentInfo)
          ? providerService.getInstanceInfo(candidate.instanceId).pipe(
              Effect.map(
                (info) =>
                  info.continuationIdentity.continuationKey !==
                  currentInfo.value.continuationIdentity.continuationKey,
              ),
              Effect.catch(() => Effect.succeed(false)),
            )
          : Effect.succeed(candidate.driver === currentDriver),
    );
    const candidate = chooseAutomaticAccount({
      selection,
      providers: independent,
      settings: settings.providerAutoSwitch,
      providerInstances: settings.providerInstances,
      blockedInstanceIds: blocked,
      nowMs,
      driverHint: currentDriver,
    });
    if (!candidate) {
      const drainedIds = independent
        .filter(
          (provider) =>
            provider.driver === currentDriver &&
            provider.instanceId !== selection.instanceId &&
            provider.enabled,
        )
        .map((provider) => provider.instanceId);
      const exhausted = [selection.instanceId, ...drainedIds];
      yield* orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: yield* serverCommandId("account-auto-switch-exhausted"),
          threadId: thread.id,
          createdAt,
          activity: {
            id: yield* serverEventId(),
            kind: "provider.account.auto-switch-exhausted",
            tone: "error",
            summary: `${currentDriver === "codex" ? "Codex" : "Claude"}에서 같은 모델을 사용할 수 있는 다른 계정을 찾지 못했습니다`,
            payload: {
              driver: currentDriver,
              instanceIds: exhausted,
            },
            turnId: null,
            createdAt,
          },
        })
        .pipe(Effect.catchCause(() => Effect.logWarning("could not record exhausted accounts")));
      return selection;
    }
    const latest = yield* resolveThread(thread.id);
    if (!latest || !Equal.equals(latest.modelSelection, selection))
      return latest?.modelSelection ?? selection;
    const latestSessions = yield* providerService.listSessions();
    if (
      latestSessions.some(
        (session) =>
          session.threadId === thread.id &&
          (session.status === "running" ||
            (session.activeTurnId != null &&
              session.status !== "error" &&
              session.status !== "closed")),
      )
    )
      return selection;
    const next = { ...selection, instanceId: candidate.instanceId };
    if (persistThreadSelection) {
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("account-auto-switch"),
        threadId: thread.id,
        modelSelection: next,
      });
      threadModelSelections.set(thread.id, next);
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("account-auto-switch-activity"),
      threadId: thread.id,
      createdAt,
      activity: {
        id: yield* serverEventId(),
        kind: "provider.account.auto-switched",
        tone: "info",
        summary: `${currentDriver === "codex" ? "Codex" : "Claude"} 계정 자동 전환: ${candidate.displayName ?? candidate.instanceId}`,
        payload: {
          previousInstanceId: selection.instanceId,
          nextInstanceId: candidate.instanceId,
          reason: blocked.has(selection.instanceId) ? "rate-limit-429" : "quota-exhausted",
          requestReplayed: false,
        },
        turnId: null,
        createdAt,
      },
    });
    return next;
  });
}
