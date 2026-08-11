import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { WorkspaceKnowledgeReactor } from "../Services/WorkspaceKnowledgeReactor.ts";
import { WorkspaceCollaborationReactor } from "../Services/WorkspaceCollaborationReactor.ts";
import { WorkspaceSchedulerReactor } from "../Services/WorkspaceSchedulerReactor.ts";
import { WorkspaceProgramSupervisor } from "../Services/WorkspaceProgramSupervisor.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";

describe("OrchestrationReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<OrchestrationReactor, never> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("starts all orchestration reactors", async () => {
    const started: string[] = [];

    runtime = ManagedRuntime.make(
      Layer.effect(OrchestrationReactor, makeOrchestrationReactor).pipe(
        Layer.provideMerge(
          Layer.succeed(ProviderRuntimeIngestionService, {
            start: () => {
              started.push("provider-runtime-ingestion");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderCommandReactor, {
            start: () => {
              started.push("provider-command-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CheckpointReactor, {
            start: () => {
              started.push("checkpoint-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadDeletionReactor, {
            start: () => {
              started.push("thread-deletion-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(WorkspaceKnowledgeReactor, {
            start: () => {
              started.push("workspace-knowledge-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(WorkspaceCollaborationReactor, {
            start: () => {
              started.push("workspace-collaboration-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(WorkspaceSchedulerReactor, {
            start: () => {
              started.push("workspace-scheduler-reactor");
              return Effect.void;
            },
            tick: Effect.void,
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(WorkspaceProgramSupervisor, {
            start: () => {
              started.push("workspace-program-supervisor");
              return Effect.void;
            },
            drain: Effect.void,
            discover: () => Effect.succeed({ candidates: [] }),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(AgentAwarenessRelay.AgentAwarenessRelay, {
            publishThread: () => Effect.void,
            start: () => {
              started.push("agent-awareness-relay");
              return Effect.void;
            },
          }),
        ),
      ),
    );

    const reactor = await runtime!.runPromise(Effect.service(OrchestrationReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

    expect(started).toEqual([
      "provider-runtime-ingestion",
      "provider-command-reactor",
      "checkpoint-reactor",
      "thread-deletion-reactor",
      "workspace-knowledge-reactor",
      "workspace-collaboration-reactor",
      "workspace-scheduler-reactor",
      "workspace-program-supervisor",
      "agent-awareness-relay",
    ]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
