import type { WorkspaceKnowledgeKind } from "@t3tools/contracts";

export const KNOWLEDGE_KIND_LABELS: Readonly<Record<WorkspaceKnowledgeKind, string>> = {
  directive: "사용자 지침",
  goal: "영속 목표",
  "rag-source": "RAG 자료",
  "run-memory": "실행 기억",
  "working-memory": "작업 기억",
  "long-term-memory": "장기기억",
  prompt: "프롬프트 조각",
};
