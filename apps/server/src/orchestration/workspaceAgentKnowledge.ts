import {
  WorkspaceKnowledgeItemId,
  type IsoDateTime,
  type ProjectId,
  type WorkspaceAgentKnowledgeSettings,
  type WorkspaceCollaborationRun,
  type WorkspaceKnowledgeItem,
  type WorkspaceTaskNode,
} from "@t3tools/contracts";

import { compactKnowledgeContent, knowledgeContentDigest } from "./workspaceConversationRag.ts";

const AUTO_AGENT_OUTPUT_TAG = "auto-agent-output";
const AGENT_OUTPUT_FOLDER = "collaboration-outputs";

/**
 * Agent outputs land in `rag-source` because that is the only kind the isolated
 * RAG index searches (`ProjectionWorkspaceRag`). Filing them as run memory would
 * store the text but leave it unsearchable, which is the opposite of the point.
 */
const AGENT_OUTPUT_KIND = "rag-source" as const;

export function agentKnowledgeRunItemPrefix(runId: string): string {
  return `agent-output-${knowledgeContentDigest(runId, 16)}-`;
}

export function agentKnowledgeItemId(input: {
  readonly runId: string;
  readonly nodeId: string;
}): WorkspaceKnowledgeItemId {
  return WorkspaceKnowledgeItemId.make(
    `${agentKnowledgeRunItemPrefix(input.runId)}${knowledgeContentDigest(input.nodeId, 16)}`,
  );
}

export function isAutomaticAgentKnowledgeItem(item: WorkspaceKnowledgeItem): boolean {
  return item.kind === AGENT_OUTPUT_KIND && item.tags.includes(AUTO_AGENT_OUTPUT_TAG);
}

function nodeTitle(node: WorkspaceTaskNode): string {
  return node.title.replace(/\s+/gu, " ").trim().slice(0, 100) || node.id;
}

/**
 * The output alone loses why it exists. Prefixing the node's goal and success
 * criteria keeps a retrieved chunk self-explanatory once it is read back months
 * later without the surrounding run.
 */
function nodeContent(node: WorkspaceTaskNode, output: string): string {
  const sections = [
    `TASK: ${node.handoff.task}`,
    `GOAL: ${node.handoff.goal}`,
    node.handoff.successCriteria.length > 0
      ? `SUCCESS CRITERIA: ${node.handoff.successCriteria.join(" / ")}`
      : "",
    `OUTPUT:\n${output}`,
  ];
  return sections.filter((section) => section.length > 0).join("\n\n");
}

export interface AgentKnowledgeCapture {
  readonly item: WorkspaceKnowledgeItem;
  readonly nodeId: string;
  readonly originalChars: number;
  readonly storedChars: number;
}

/**
 * Every completed graph node that produced an output becomes one compacted,
 * searchable item. Unlike memory candidates — which Fable hand-picks and caps —
 * this captures the whole run, so nothing an agent actually found is dropped.
 */
export function toAgentKnowledgeCaptures(input: {
  readonly run: WorkspaceCollaborationRun;
  readonly settings: WorkspaceAgentKnowledgeSettings;
  readonly capturedAt: IsoDateTime;
}): ReadonlyArray<AgentKnowledgeCapture> {
  if (!input.settings.enabled) return [];
  const graph = input.run.graph;
  if (graph === null) return [];

  const captures: Array<AgentKnowledgeCapture> = [];
  for (const node of graph.nodes) {
    const output = node.output ?? "";
    if (output.trim().length === 0) continue;
    const compacted = compactKnowledgeContent(nodeContent(node, output), {
      redactSensitiveData: input.settings.redactSensitiveData,
      maxChars: input.settings.maxOutputChars,
    });
    if (compacted === null) continue;
    // Starting a retry clears node.output. Only its terminal receipt identifies the
    // producing route, including synthesis results whose stored output was reformatted.
    const attempt = node.attempts.at(-1);
    const producer =
      attempt?.status === "completed" &&
      attempt.completedAt &&
      attempt.output &&
      (!node.threadId || attempt.threadId === node.threadId) &&
      (attempt.completedAt === node.completedAt || output.slice(0, 8_000) === attempt.output)
        ? attempt
        : undefined;
    const threadId =
      producer?.threadId ??
      node.threadId ??
      (!input.run.orchestra ? input.run.meeting?.threadId : null);
    captures.push({
      nodeId: node.id,
      originalChars: compacted.originalChars,
      storedChars: compacted.compactedChars,
      item: {
        id: agentKnowledgeItemId({ runId: input.run.id, nodeId: node.id }),
        provenance: {
          runId: input.run.id,
          nodeId: node.id,
          actor: node.agent,
          ...(node.confidence ? { confidence: node.confidence } : {}),
          ...(threadId ? { threadId } : {}),
          ...(producer
            ? {
                modelSelection: {
                  instanceId: producer.modelSelection.instanceId,
                  model: producer.modelSelection.model,
                },
              }
            : {}),
        },
        projectId: input.run.projectId as ProjectId,
        kind: AGENT_OUTPUT_KIND,
        title: `에이전트 결과 · ${nodeTitle(node)}`,
        content: compacted.content,
        status: "active",
        origin: "agent",
        relativeFolder: AGENT_OUTPUT_FOLDER,
        tags: [
          AUTO_AGENT_OUTPUT_TAG,
          "compacted",
          "collaboration",
          `run-${knowledgeContentDigest(input.run.id, 16)}`,
          `node-${node.id}`,
          `agent-${node.agent}`,
          `node-kind-${node.kind}`,
          ...(node.confidence === null ? [] : [`confidence-${node.confidence}`]),
          `original-chars-${compacted.originalChars}`,
          `stored-chars-${compacted.compactedChars}`,
          ...(compacted.redactionCount > 0 ? [`redacted-${compacted.redactionCount}`] : []),
          ...(compacted.duplicateBlocksRemoved > 0
            ? [`deduplicated-${compacted.duplicateBlocksRemoved}`]
            : []),
          ...(compacted.truncated ? ["bounded"] : []),
        ],
        originalChars: compacted.originalChars,
        storedChars: compacted.compactedChars,
        promptUses: 0,
        lastUsedAt: null,
        createdAt: input.capturedAt,
        updatedAt: input.capturedAt,
      },
    });
  }
  return captures;
}
