import { WorkspaceTaskInbox } from "../WorkspaceTaskInbox.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../../config.ts";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { WorkspaceKnowledgeReactor } from "../Services/WorkspaceKnowledgeReactor.ts";
import { WorkspaceCollaborationReactor } from "../Services/WorkspaceCollaborationReactor.ts";
import { WorkspaceSchedulerReactor } from "../Services/WorkspaceSchedulerReactor.ts";
import { WorkspaceMonitoringReactor } from "../Services/WorkspaceMonitoringReactor.ts";
import { WorkspaceProgramSupervisor } from "../Services/WorkspaceProgramSupervisor.ts";
import { SessionRecoveryReactor } from "../Services/SessionRecoveryReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";
import { SharedLibrarySync } from "../../library/SharedLibrarySync.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const workspaceKnowledgeReactor = yield* WorkspaceKnowledgeReactor;
  const workspaceCollaborationReactor = yield* WorkspaceCollaborationReactor;
  const workspaceSchedulerReactor = yield* WorkspaceSchedulerReactor;
  const taskInbox = yield* Effect.serviceOption(WorkspaceTaskInbox);
  const workspaceProgramSupervisor = yield* Effect.serviceOption(WorkspaceProgramSupervisor);
  const workspaceMonitoringReactor = yield* Effect.serviceOption(WorkspaceMonitoringReactor);
  const sessionRecoveryReactor = yield* Effect.serviceOption(SessionRecoveryReactor);
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
  const sharedLibrarySync = yield* Effect.serviceOption(SharedLibrarySync);

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    if (config?.upgradeRoom) return;
    yield* threadDeletionReactor.start();
    yield* workspaceKnowledgeReactor.start();
    yield* workspaceCollaborationReactor.start();
    yield* workspaceSchedulerReactor.start();
    if (taskInbox._tag === "Some") yield* taskInbox.value.start();
    if (workspaceProgramSupervisor._tag === "Some") {
      yield* workspaceProgramSupervisor.value.start();
    }
    // After the supervisor: monitoring consumes its program events and runs.
    if (workspaceMonitoringReactor._tag === "Some") {
      yield* workspaceMonitoringReactor.value.start();
    }
    // After the reactors above: the recovery turns it dispatches need the
    // command reactor's subscriptions live to reach a provider.
    if (sessionRecoveryReactor._tag === "Some") {
      yield* sessionRecoveryReactor.value.start();
    }
    yield* agentAwarenessRelay.start();
    // Last: its first check waits out startup, then runs at most once a day.
    if (sharedLibrarySync._tag === "Some") {
      yield* sharedLibrarySync.value.start();
    }
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
