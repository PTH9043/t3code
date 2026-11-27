import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_WORKSPACE_CONTROL_SETTINGS,
  DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
  DEFAULT_WORKSPACE_MONITORING_SETTINGS,
  DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceKnowledgeItemId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { WorkspaceMemory } from "../WorkspaceMemory.ts";
import { memoryHash } from "../memoryFiles.ts";
import { ProjectionWorkspaceRagRepositoryLive } from "../../persistence/Layers/ProjectionWorkspaceRag.ts";
import { ProjectionWorkspaceRagRepository } from "../../persistence/Services/ProjectionWorkspaceRag.ts";
import { ProjectionWorkspaceKnowledgeRepositoryLive } from "../../persistence/Layers/ProjectionWorkspaceKnowledge.ts";
import { ProjectionWorkspaceKnowledgeRepository } from "../../persistence/Services/ProjectionWorkspaceKnowledge.ts";

const layer = it.layer(
  Layer.merge(
    Layer.merge(OrchestrationProjectionPipelineLive, WorkspaceMemory.layer),
    Layer.merge(ProjectionWorkspaceRagRepositoryLive, ProjectionWorkspaceKnowledgeRepositoryLive),
  ).pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-conversation-rag-projection-" }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const now = "2026-08-10T00:00:00.000Z";
const projectId = ProjectId.make("project-conversation-rag");
const threadId = ThreadId.make("thread-conversation-rag");

function eventBase(id: string, aggregateKind: "project" | "thread") {
  return {
    eventId: EventId.make(`event-${id}`),
    aggregateKind,
    aggregateId: aggregateKind === "project" ? projectId : threadId,
    occurredAt: now,
    commandId: CommandId.make(`command-${id}`),
    causationEventId: null,
    correlationId: CommandId.make(`command-${id}`),
    metadata: {},
  } as const;
}

layer("automatic conversation RAG projection", (it) => {
  it.effect("resumes provenance replay using the settings in force at each old event", () =>
    Effect.gen(function* () {
      const events = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("provenance-resume-project");
      const threadId = ThreadId.make("provenance-resume-thread");
      const base = (id: string, kind: "project" | "thread") => ({
        ...eventBase(id, kind),
        aggregateId: kind === "project" ? projectId : threadId,
      });
      yield* events.append({
        ...base("resume-project", "project"),
        type: "project.created",
        payload: {
          projectId,
          title: "Replay",
          workspaceRoot: "/tmp/replay",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const thread = yield* events.append({
        ...base("resume-thread", "thread"),
        type: "thread.created",
        payload: {
          threadId,
          projectId,
          title: "Replay",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* events.append({
        ...base("resume-message", "thread"),
        type: "thread.message-sent",
        payload: {
          threadId,
          messageId: MessageId.make("resume-message"),
          role: "user",
          inputOrigin: "user",
          text: `begin-${"x".repeat(2500)}-end`,
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* events.append({
        ...base("resume-settings", "project"),
        type: "project.workspace-control-updated",
        payload: {
          projectId,
          workspaceControl: {
            ...DEFAULT_WORKSPACE_CONTROL_SETTINGS,
            conversationRag: {
              ...DEFAULT_WORKSPACE_CONTROL_SETTINGS.conversationRag,
              maxInputChars: 2000,
            },
          },
          updatedAt: now,
        },
      });
      const tail = yield* events.append({
        ...base("resume-unrelated-tail", "project"),
        type: "project.runtime-viewed",
        payload: { projectId, viewedThrough: now, updatedAt: now },
      });
      yield* pipeline.bootstrap;
      const before = yield* sql<{
        item_id: string;
      }>`SELECT item_id FROM workspace_conversation_rag_sources WHERE project_id=${projectId}`;
      assert.equal(before.length, 1);
      yield* sql`DELETE FROM workspace_conversation_rag_sources WHERE project_id=${projectId}`;
      yield* sql`UPDATE projection_state SET last_applied_sequence=${thread.sequence} WHERE projector='projection.conversation-rag-sources-v1'`;
      yield* Effect.gen(function* () {
        const resumed = yield* OrchestrationProjectionPipeline;
        yield* resumed.bootstrap;
      }).pipe(Effect.provide(Layer.fresh(OrchestrationProjectionPipelineLive)));
      const after = yield* sql<{
        item_id: string;
      }>`SELECT item_id FROM workspace_conversation_rag_sources WHERE project_id=${projectId}`;
      assert.deepEqual(after, before);
      const [cursor] = yield* sql<{ sequence: number }>`SELECT last_applied_sequence AS sequence
        FROM projection_state WHERE projector='projection.conversation-rag-sources-v1'`;
      assert.equal(cursor?.sequence, tail.sequence);
    }),
  );
  it.effect(
    "keeps independent duplicate sources and suppresses forgotten messages after provenance replay",
    () =>
      Effect.gen(function* () {
        const events = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const memory = yield* WorkspaceMemory;
        const rag = yield* ProjectionWorkspaceRagRepository;
        const knowledge = yield* ProjectionWorkspaceKnowledgeRepository;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("forgotten-rag-project");
        const threadId = ThreadId.make("forgotten-rag-thread");
        const base = (id: string, kind: "project" | "thread") => ({
          ...eventBase(id, kind),
          aggregateId: kind === "project" ? projectId : threadId,
        });
        yield* events.append({
          ...base("forgotten-project", "project"),
          type: "project.created",
          payload: {
            projectId,
            title: "RAG",
            workspaceRoot: "/tmp/conversation-rag",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* events.append({
          ...base("forgotten-thread", "thread"),
          type: "thread.created",
          payload: {
            threadId,
            projectId,
            title: "Test",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        for (const [id, text] of [
          ["duplicate-a", "DUPLICATECONTENTCANARY"],
          ["duplicate-b", "DUPLICATECONTENTCANARY"],
          ["separate", "INDEPENDENTCONTENTCANARY"],
          ["answer-duplicate", '{"choice":{"answers":["ANSWERPRESERVEDCANARY"]}}'],
        ] as const) {
          yield* events.append({
            ...base(id, "thread"),
            type: "thread.message-sent",
            payload: {
              threadId,
              messageId: MessageId.make(id),
              role: "user",
              inputOrigin: "user",
              text,
              attachments: [],
              turnId: null,
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          });
        }
        yield* events.append({
          ...base("answer-event", "thread"),
          type: "thread.user-input-response-requested",
          payload: {
            threadId,
            requestId: ApprovalRequestId.make("answer-request"),
            answers: { choice: { answers: ["ANSWERPRESERVEDCANARY"] } },
            createdAt: now,
          },
        });
        yield* pipeline.bootstrap;
        yield* memory.reconcile(projectId);
        // Simulate an upgraded installation whose previous projectors had already
        // consumed the events, then reconstruct provenance with its own cursor.
        yield* sql`DELETE FROM workspace_conversation_rag_sources WHERE project_id=${projectId}`;
        yield* sql`DELETE FROM projection_state WHERE projector = 'projection.conversation-rag-sources-v1'`;
        yield* pipeline.bootstrap;
        const sources = yield* sql<{
          source_id: string;
        }>`SELECT source_id FROM workspace_conversation_rag_sources WHERE project_id=${projectId} ORDER BY source_id`;
        assert.deepEqual(
          sources.map((row) => row.source_id),
          ["answer-duplicate", "answer-request", "duplicate-a", "duplicate-b", "separate"],
        );
        yield* memory.invoke({
          projectId,
          action: "forget-message",
          id: memoryHash("message:duplicate-a"),
        });
        assert.equal(
          (yield* rag.search({ projectId, query: "DUPLICATECONTENTCANARY" })).matches.length,
          1,
        );
        yield* sql`DELETE FROM projection_thread_messages WHERE message_id='duplicate-b'`;
        assert.equal(
          (yield* rag.search({ projectId, query: "DUPLICATECONTENTCANARY" })).matches.length,
          0,
        );
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
          VALUES ('duplicate-b',${threadId},'user','DUPLICATECONTENTCANARY',0,${now},${now})`;
        yield* memory.invoke({
          projectId,
          action: "forget-message",
          id: memoryHash("message:duplicate-b"),
        });
        assert.equal(
          (yield* rag.search({ projectId, query: "DUPLICATECONTENTCANARY" })).matches.length,
          0,
        );
        assert.equal(
          (yield* rag.search({ projectId, query: "INDEPENDENTCONTENTCANARY" })).matches.length,
          1,
        );
        yield* memory.invoke({
          projectId,
          action: "forget-message",
          id: memoryHash("message:answer-duplicate"),
        });
        assert.equal(
          (yield* rag.search({ projectId, query: "ANSWERPRESERVEDCANARY" })).matches.length,
          1,
        );
        const items = yield* knowledge.listByProjectId({ projectId });
        assert.ok(!items.some((item) => item.content.includes("DUPLICATECONTENTCANARY")));
        assert.ok(items.some((item) => item.content.includes("INDEPENDENTCONTENTCANARY")));
        const originals = yield* sql<{
          text: string;
        }>`SELECT text FROM projection_thread_messages WHERE message_id IN ('duplicate-a','duplicate-b')`;
        assert.equal(originals.length, 2);
        assert.ok(originals.every((row) => row.text === "DUPLICATECONTENTCANARY"));
      }),
  );
  it.effect("stores only direct user input as compacted project-scoped RAG", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* eventStore.append({
        ...eventBase("project", "project"),
        type: "project.created",
        payload: {
          projectId,
          title: "Conversation RAG",
          workspaceRoot: "/tmp/conversation-rag",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        ...eventBase("thread", "thread"),
        type: "thread.created",
        payload: {
          threadId,
          projectId,
          title: "보안 배포 대화",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        ...eventBase("user-message", "thread"),
        type: "thread.message-sent",
        payload: {
          threadId,
          messageId: MessageId.make("message-user"),
          role: "user",
          inputOrigin: "user",
          text: "배포 전 검증 필수\n\n배포 전 검증 필수\n\napi_key=sk-proj-abcdefghijklmnopqrstuvwxyz",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        ...eventBase("automation-message", "thread"),
        type: "thread.message-sent",
        payload: {
          threadId,
          messageId: MessageId.make("message-automation"),
          role: "user",
          inputOrigin: "automation",
          text: "내부 자동화 프롬프트는 저장하지 않는다",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly itemId: string;
        readonly content: string;
        readonly tagsJson: string;
      }>`
        SELECT item_id AS "itemId", content, tags_json AS "tagsJson"
        FROM projection_workspace_knowledge_items
        WHERE project_id = ${projectId}
      `;
      assert.equal(rows.length, 1);
      assert.match(rows[0]?.itemId ?? "", /^conversation-/);
      assert.ok(rows[0]?.tagsJson.includes("auto-conversation"));
      assert.ok(!rows[0]?.content.includes("abcdefghijklmnopqrstuvwxyz"));
      assert.equal(rows[0]?.content.match(/배포 전 검증 필수/g)?.length, 1);

      const originalRows = yield* sql<{ readonly text: string }>`
        SELECT text
        FROM projection_thread_messages
        WHERE message_id = 'message-user'
      `;
      assert.equal(originalRows.length, 1);
      assert.ok(originalRows[0]?.text.includes("api_key=sk-proj-abcdefghijklmnopqrstuvwxyz"));
      assert.equal(originalRows[0]?.text.match(/배포 전 검증 필수/g)?.length, 2);

      const ragRows = yield* sql<{ readonly content: string }>`
        SELECT content
        FROM projection_workspace_rag_chunks
        WHERE project_id = ${projectId}
      `;
      assert.equal(ragRows.length, 1);
      assert.ok(!ragRows[0]?.content.includes("내부 자동화 프롬프트"));
    }),
  );

  it.effect("disabling capture removes automatic copies but preserves manual knowledge", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* eventStore.append({
        ...eventBase("project-disable-seed", "project"),
        type: "project.created",
        payload: {
          projectId,
          title: "Conversation RAG",
          workspaceRoot: "/tmp/conversation-rag",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        ...eventBase("thread-disable-seed", "thread"),
        type: "thread.created",
        payload: {
          threadId,
          projectId,
          title: "보안 배포 대화",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        ...eventBase("user-message-disable-seed", "thread"),
        type: "thread.message-sent",
        payload: {
          threadId,
          messageId: MessageId.make("message-user"),
          role: "user",
          inputOrigin: "user",
          text: "자동 수집할 사용자 입력",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionPipeline.bootstrap;

      const manual = yield* eventStore.append({
        ...eventBase("manual-source", "project"),
        type: "project.knowledge-item-upserted",
        payload: {
          projectId,
          itemId: WorkspaceKnowledgeItemId.make("manual-source"),
          kind: "rag-source",
          title: "수동 자료",
          content: "수동 등록 자료는 유지된다",
          status: "active",
          origin: "user",
          relativeFolder: null,
          tags: ["manual"],
          updatedAt: now,
        },
      });
      yield* projectionPipeline.projectEvent(manual);

      const disabled = yield* eventStore.append({
        ...eventBase("disable", "project"),
        type: "project.workspace-control-updated",
        payload: {
          projectId,
          workspaceControl: {
            isolationMode: "strict",
            longTermMemoryRoot: null,
            conversationRag: {
              enabled: false,
              redactSensitiveData: true,
              maxInputChars: 24_000,
            },
            agentKnowledge: DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
            monitoring: DEFAULT_WORKSPACE_MONITORING_SETTINGS,
            orchestra: DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS,
          },
          updatedAt: now,
        },
      });
      yield* projectionPipeline.projectEvent(disabled);

      const knowledgeRows = yield* sql<{ readonly itemId: string }>`
        SELECT item_id AS "itemId"
        FROM projection_workspace_knowledge_items
        WHERE project_id = ${projectId}
        ORDER BY item_id
      `;
      assert.deepEqual(knowledgeRows, [{ itemId: "manual-source" }]);

      const ragRows = yield* sql<{ readonly itemId: string }>`
        SELECT DISTINCT item_id AS "itemId"
        FROM projection_workspace_rag_chunks
        WHERE project_id = ${projectId}
      `;
      assert.deepEqual(ragRows, [{ itemId: "manual-source" }]);
    }),
  );
});
