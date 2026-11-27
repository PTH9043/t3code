import {
  CommandId,
  WorkspaceKnowledgeItemId,
  type ModelSelection,
  type ProjectId,
  type ProviderExecutionContext,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  knowledgeContentDigest,
  redactConversationRagSensitiveData,
} from "../workspaceConversationRag.ts";

const encodeResearchData = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Keep research provenance identical for ordinary and detached orchestra executions. */
export const captureWorkspaceResearch = Effect.fn("captureWorkspaceResearch")(function* (input: {
  readonly engine: OrchestrationEngineShape;
  readonly projectId: ProjectId;
  readonly execution: ProviderExecutionContext;
  readonly modelSelection: ModelSelection;
  readonly title: string;
  readonly event: ProviderRuntimeEvent;
  readonly requirePersistence?: boolean;
}) {
  const { event, execution } = input;
  if (event.type !== "item.completed" || event.payload.itemType !== "web_search") return;
  const dataText =
    event.payload.data === undefined ? undefined : yield* encodeResearchData(event.payload.data);
  const detail = redactConversationRagSensitiveData(
    [event.payload.title, event.payload.detail, dataText].filter(Boolean).join("\n"),
  ).content.slice(0, 80_000);
  if (!detail.length) return;
  const blockKey = `${execution.executionId}:${execution.attempt}`;
  const write = input.engine.dispatch({
    type: "project.knowledge.item.upsert",
    commandId: CommandId.make(`orchestra-research:${blockKey}:${event.eventId}`),
    projectId: input.projectId,
    itemId: WorkspaceKnowledgeItemId.make(
      `research-${knowledgeContentDigest(`${blockKey}:${event.eventId}`, 32)}`,
    ),
    kind: "long-term-memory",
    title: redactConversationRagSensitiveData(
      `${input.title}: ${event.payload.title ?? "검색 기록"}`,
    ).content.slice(0, 200),
    content: detail,
    status: "active",
    origin: "agent",
    scope: "project",
    appliesToFolder: null,
    relativeFolder: "research",
    tags: ["research", "unverified", "orchestra"],
    provenance: {
      runId: execution.runId,
      nodeId: execution.nodeId,
      threadId: execution.ownerThreadId,
      ...(event.providerInstanceId === input.modelSelection.instanceId
        ? {
            modelSelection: {
              instanceId: input.modelSelection.instanceId,
              model: input.modelSelection.model,
            },
          }
        : {}),
    },
    research: {
      query: redactConversationRagSensitiveData(event.payload.title ?? input.title).content,
      sources: [
        ...new Set(
          (detail.match(/https?:\/\/[^\s<>"\\]+/g) ?? []).map((url) =>
            url.replace(/[),.;\]}]+$/g, ""),
          ),
        ),
      ].slice(0, 40),
      capturedAt: event.createdAt,
      verification: "unverified",
    },
    createdAt: event.createdAt,
  });
  if (input.requirePersistence) yield* write;
  else
    yield* write.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Orchestra research capture failed", {
          executionId: execution.executionId,
          cause: Cause.pretty(cause),
        }),
      ),
    );
});
