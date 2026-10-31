import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
  type OrchestrationCommand,
  type WorkspaceCollaborationRun,
  type WorkspaceTaskAttempt,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import type { ProjectionThreadActivity } from "../persistence/Services/ProjectionThreadActivities.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { buildInitialWorkspaceTaskGraph } from "./workspaceTaskGraph.ts";
import { makeWorkspaceAgentControl } from "./WorkspaceAgentControl.ts";
const at = "2026-10-22T00:00:00.000Z";
const projectId = ProjectId.make("mail-project");
const runId = WorkspaceCollaborationRunId.make("mail-run");
const threadId = ThreadId.make("mail-thread");
const lookup = { projectId, runId };
const setup = Effect.fn("AgentControlTest.setup")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const stateDir = yield* fs.makeTempDirectoryScoped();
  const graph = buildInitialWorkspaceTaskGraph("task");
  const attempt: WorkspaceTaskAttempt = {
    number: 1,
    agent: "fable",
    role: "coordinator",
    modelSelection: { instanceId: ProviderInstanceId.make("provider"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    strategy: "primary",
    threadId,
    status: "running",
    output: null,
    error: null,
    failureClassification: null,
    confidence: null,
    startedAt: at,
    completedAt: null,
  };
  const state: { run: WorkspaceCollaborationRun } = {
    run: {
      id: runId,
      projectId,
      source: "user",
      scheduleId: null,
      incidentId: null,
      task: "test",
      status: "running",
      steps: [],
      graph: {
        ...graph,
        nodes: ["sender", "receiver"].map((id) => ({
          ...graph.nodes[0]!,
          id: WorkspaceTaskNodeId.make(id),
          title: id,
          threadId,
          status: "running",
          attempts: [attempt],
        })),
      },
      meeting: null,
      orchestra: { maxParallel: 2, isolateWorktrees: false },
      finalOutput: null,
      error: null,
      createdAt: at,
      updatedAt: at,
    },
  };
  const rows = new Map<string, ProjectionThreadActivity>();
  const commands = new Set<string>();
  const deps = {
    stateDir,
    runs: {
      getById: (input: typeof lookup) =>
        Effect.succeed(
          input.projectId === projectId && input.runId === runId
            ? Option.some(state.run)
            : Option.none(),
        ),
      listResumable: () => Effect.succeed([state.run]),
    },
    activities: { listByThreadIdAndKinds: () => Effect.succeed([...rows.values()]) },
    query: {
      getThreadShellById: () => Effect.succeed(Option.some({ id: threadId, projectId } as never)),
    },
    engine: {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          if (!commands.has(command.commandId) && command.type === "thread.activity.append") {
            commands.add(command.commandId);
            rows.set(command.activity.id, {
              ...command.activity,
              activityId: command.activity.id,
              threadId,
            });
          }
          return { sequence: commands.size };
        }),
    },
  };
  const service = yield* makeWorkspaceAgentControl(deps);
  const scope = (node = "receiver"): McpInvocationScope => ({
    environmentId: EnvironmentId.make("env"),
    threadId,
    sessionKey: ThreadId.make("orchestra:" + runId + ":" + node + ":1"),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("provider"),
    capabilities: new Set(),
    issuedAt: 0,
  });
  const send = (requestId = "one", text = "전달할 내용") =>
    service.invoke({
      ...lookup,
      action: "send",
      requestId,
      text,
      toNodeId: WorkspaceTaskNodeId.make("receiver"),
    });
  return { service, deps, state, rows, fs, scope, send };
});
const suite = it.layer(NodeServices.layer);
suite("WorkspaceAgentControl", (it) => {
  it.effect(
    "deduplicates a retried delivery and rejects changed content and stale worker identities",
    () =>
      Effect.gen(function* () {
        const t = yield* setup();
        const first = yield* t.send();
        yield* t.send();
        expect((yield* t.service.overview(lookup)).total).toBe(1);
        expect(Exit.isFailure(yield* Effect.exit(t.send("one", "다른 내용")))).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              t.service.invoke(
                { ...lookup, action: "read" },
                { ...t.scope(), sessionKey: ThreadId.make("foreign") },
              ),
            ),
          ),
        ).toBe(true);
        const message = first.records[0]!;
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              t.service.invoke(
                {
                  ...lookup,
                  action: "ack",
                  recordId: message.id,
                  expectedRevision: message.revision,
                },
                t.scope("sender"),
              ),
            ),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              t.service.overview({ ...lookup, projectId: ProjectId.make("foreign") }),
            ),
          ),
        ).toBe(true);
        const restarted = yield* makeWorkspaceAgentControl(t.deps);
        expect((yield* restarted.overview(lookup)).records[0]?.text).toBe("전달할 내용");
      }),
  );
  it.effect(
    "stores the exact submitted input, separates acceptance from read and never requeues uncertainty automatically",
    () =>
      Effect.gen(function* () {
        const t = yield* setup();
        const sent = (yield* t.send()).records[0]!;
        const prepared = yield* t.service.prepare({
          ...lookup,
          nodeId: WorkspaceTaskNodeId.make("receiver"),
          executionId: "orchestra:mail-run:receiver:1",
          prompt: "실제 사용자 지시",
          model: "test",
          providerInstanceId: "provider",
        });
        expect(prepared.prompt).toContain(sent.text);
        const handoff = (yield* t.service.overview(lookup)).records.find(
          (r) => r.recordType === "handoff",
        )!;
        expect((yield* t.service.evidence({ ...lookup, recordId: handoff.id })).text).toBe(
          prepared.prompt,
        );
        yield* t.service.settleInput(prepared, true);
        let record = (yield* t.service.overview(lookup)).records.find((r) => r.id === sent.id)!;
        expect(record.status).toBe("accepted");
        yield* t.service.invoke(
          { ...lookup, action: "ack", recordId: record.id, expectedRevision: record.revision },
          t.scope(),
        );
        yield* t.service.settleInput(prepared, false);
        expect(
          (yield* t.service.overview(lookup)).records.find((r) => r.id === sent.id)?.status,
        ).toBe("read");
        yield* t.fs.writeFileString(handoff.sourcePath!, "변조된 원문");
        expect(
          Exit.isFailure(
            yield* Effect.exit(t.service.evidence({ ...lookup, recordId: handoff.id })),
          ),
        ).toBe(true);
      }),
  );
  it.effect("recovers orphaned claims as unknown and records a terminal report only once", () =>
    Effect.gen(function* () {
      const t = yield* setup();
      const sent = (yield* t.send()).records[0]!;
      yield* t.service.prepare({
        ...lookup,
        nodeId: WorkspaceTaskNodeId.make("receiver"),
        executionId: "orchestra:mail-run:receiver:1",
        prompt: "input",
        model: "test",
        providerInstanceId: "provider",
      });
      t.state.run = {
        ...t.state.run,
        graph: {
          ...t.state.run.graph!,
          nodes: t.state.run.graph!.nodes.map((n) =>
            n.id === "receiver"
              ? { ...n, status: "completed", output: "실제 응답", completedAt: at }
              : n,
          ),
        },
      };
      const restarted = yield* makeWorkspaceAgentControl(t.deps);
      yield* restarted.reports(t.state.run);
      yield* restarted.reports(t.state.run);
      const records = (yield* restarted.overview(lookup)).records;
      expect(records.find((r) => r.id === sent.id)?.status).toBe("unknown");
      expect(records.filter((r) => r.recordType === "report")).toHaveLength(1);
      expect(records.filter((r) => r.recordType === "report")[0]?.text).toBe("실제 응답");
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            restarted.invoke({
              ...lookup,
              action: "requeue",
              recordId: sent.id,
              expectedRevision: 0,
            }),
          ),
        ),
      ).toBe(true);
      const current = records.find((r) => r.id === sent.id)!;
      yield* restarted.invoke({
        ...lookup,
        action: "requeue",
        recordId: current.id,
        expectedRevision: current.revision,
      });
      expect(
        (yield* restarted.overview(lookup)).records.find((r) => r.id === sent.id)?.status,
      ).toBe("queued");
    }),
  );
});
