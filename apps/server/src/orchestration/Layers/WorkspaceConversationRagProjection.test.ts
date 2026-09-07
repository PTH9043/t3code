import {
  CommandId,
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

const layer = it.layer(
  OrchestrationProjectionPipelineLive.pipe(
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
