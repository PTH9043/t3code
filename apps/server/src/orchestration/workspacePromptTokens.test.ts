import {
  ProjectId,
  WorkspaceKnowledgeItemId,
  type WorkspaceKnowledgeItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { composeWorkspacePrompt } from "./workspacePrompt.ts";
import { loadWorkspaceTokenCounter } from "./workspacePromptTokens.ts";

const projectId = ProjectId.make("token-test");
const now = Date.parse("2026-10-15T00:00:00Z");
function item(id: string, content: string, mandatory = false): WorkspaceKnowledgeItem {
  return {
    id: WorkspaceKnowledgeItemId.make(id),
    projectId,
    title: id,
    content,
    kind: mandatory ? "directive" : "long-term-memory",
    origin: mandatory ? "user" : "agent",
    status: "active",
    relativeFolder: null,
    tags: [],
    originalChars: null,
    storedChars: null,
    promptUses: 0,
    lastUsedAt: null,
    createdAt: "2026-10-15T00:00:00Z",
    updatedAt: "2026-10-15T00:00:00Z",
  };
}

describe.each(["standard", "relevant"] as const)("%s reference-token budget", (contextMode) => {
  it("measures Korean, code and literal special-token text without changing an unlimited prompt", async () => {
    const tokenCounter = await loadWorkspaceTokenCounter();
    const input = {
      now,
      request: { projectId, contextMode, task: '한국어 코드 수정: const x = "<|endoftext|>";' },
      items: [item("rule", "필수 지침: 원문을 보존하세요.", true)],
      ragMatches: [],
    };
    const original = composeWorkspacePrompt(input);
    const measured = composeWorkspacePrompt({ ...input, tokenCounter });
    expect(measured.prompt).toBe(original.prompt);
    expect(measured.tokenEstimate?.total).toBe(tokenCounter(original.prompt));
    expect(measured.tokenEstimate?.sections.instructions).toBeGreaterThan(0);
    expect(measured.tokenEstimate?.sections.memory).toBe(0);
    expect(measured.tokenEstimate?.limit).toBeNull();
    expect(measured.diagnostics?.tokenCount ?? null).toBeNull();
  });

  it("keeps required text and complete smaller evidence while enforcing the serialized prompt budget", async () => {
    const tokenCounter = await loadWorkspaceTokenCounter();
    const large = "Review memory large evidence. ".repeat(1200);
    const small = "Review memory small evidence.";
    const rule = "필수 사용자 지침을 절대 바꾸지 마세요.";
    const base = {
      now,
      request: { projectId, contextMode, task: "Review memory", maxContextChars: 60_000 },
      ragMatches: [],
    };
    const mandatory = item("rule", rule, true);
    const minimum = composeWorkspacePrompt({ ...base, items: [mandatory], tokenCounter });
    const maxContextTokens = minimum.tokenEstimate!.total + 180;
    const result = composeWorkspacePrompt({
      ...base,
      request: { ...base.request, maxContextTokens },
      tokenCounter,
      items: [mandatory, item("a-large", large), item("z-small", small)],
    });
    expect(result.prompt).toContain(rule);
    expect(result.prompt).toContain(small);
    expect(result.prompt).not.toContain(large.slice(0, 100));
    expect(result.sourceItemIds).toEqual([mandatory.id, WorkspaceKnowledgeItemId.make("z-small")]);
    expect(result.tokenEstimate?.total).toBe(tokenCounter(result.prompt));
    expect(result.tokenEstimate!.total).toBeLessThanOrEqual(maxContextTokens);
    expect(result.tokenEstimate?.mandatoryOverflow).toBe(0);
    expect(result.truncated).toBe(true);
  });

  it("reports required-text overflow, never truncating the task or mandatory instructions", async () => {
    const tokenCounter = await loadWorkspaceTokenCounter();
    const rule = "사용자 제약과 금지 조건을 모두 지키세요. ".repeat(400);
    const task = "현재 요청 원문을 보존하세요. ".repeat(40);
    const result = composeWorkspacePrompt({
      now,
      request: { projectId, task, contextMode, maxContextTokens: 256 },
      tokenCounter,
      items: [item("rule", rule, true), item("extra", "Review optional memory")],
      ragMatches: [],
    });
    expect(result.prompt).toContain(rule);
    expect(result.prompt).toContain(task);
    expect(result.sourceItemIds).toEqual([WorkspaceKnowledgeItemId.make("rule")]);
    expect(result.tokenEstimate!.mandatoryOverflow).toBe(tokenCounter(result.prompt) - 256);
    expect(result.tokenEstimate?.sections.memory).toBe(0);
  });

  it("rejects an unmeasurable budget instead of silently treating the count as zero", () => {
    expect(() =>
      composeWorkspacePrompt({
        now,
        request: { projectId, task: "Review", contextMode, maxContextTokens: 256 },
        items: [],
        ragMatches: [],
      }),
    ).toThrow("토크나이저");
  });

  it("counts required source references before deciding which optional evidence fits", async () => {
    const tokenCounter = await loadWorkspaceTokenCounter();
    const requiredSuffix = "\n\n전체 원문 참조: D:/자료/선택된-기억.txt";
    const optional = item("memory", "Review memory evidence. ".repeat(100));
    const minimum = composeWorkspacePrompt({
      now,
      request: { projectId, task: "Review memory", contextMode },
      tokenCounter,
      requiredSuffix,
      items: [],
      ragMatches: [],
    });
    const limit = minimum.tokenEstimate!.total + 20;
    const result = composeWorkspacePrompt({
      now,
      request: { projectId, task: "Review memory", contextMode, maxContextTokens: limit },
      tokenCounter,
      requiredSuffix,
      items: [optional],
      ragMatches: [],
    });
    expect(result.prompt).toContain(requiredSuffix);
    expect(result.tokenEstimate?.total).toBe(tokenCounter(result.prompt));
    expect(result.tokenEstimate!.total).toBeLessThanOrEqual(limit);
    expect(result.sourceItemIds).toEqual([]);
    if (result.diagnostics) expect(result.diagnostics.promptChars).toBe(result.prompt.length);
  });
});
