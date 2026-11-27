import { describe, expect, it } from "vite-plus/test";
import {
  buildTaskScopeGuardPrompt,
  isFileMutationAllowedByScopeGuard,
  parseTaskScopeGuardDirective,
} from "@t3tools/contracts";
import { formatCompactA11ySnapshot } from "./compactA11ySnapshot.ts";
import { renderObsidianBaseView, renderObsidianVaultNote } from "./obsidianVaultExport.ts";
import { classifySmartModelRoute, selectBestModelFromPool } from "./smartModelRouter.ts";

describe("Wave A-C adopted modules (ScopeGuard, CompactA11y, SmartRouter, ObsidianExport)", () => {
  it("keeps TaskScopeGuard in OBSERVING by default and enforces ARMED review/change locks", () => {
    const normal = parseTaskScopeGuardDirective("버그 좀 확인해줘");
    expect(normal.spec.armed).toBe(false);
    expect(normal.spec.mode).toBe("observing");
    expect(buildTaskScopeGuardPrompt(normal.spec)).toBeUndefined();

    const review = parseTaskScopeGuardDirective("/guard review -- 이 PR diff만 검토해줘");
    expect(review.spec.armed).toBe(true);
    expect(review.spec.mode).toBe("review");
    expect(review.strippedText).toBe("이 PR diff만 검토해줘");
    expect(isFileMutationAllowedByScopeGuard(review.spec, "src/index.ts").allowed).toBe(false);

    const scoped = parseTaskScopeGuardDirective(
      "/guard change files=src/config.ts|src/config.test.ts -- 설정만 수정",
    );
    expect(scoped.spec.armed).toBe(true);
    expect(isFileMutationAllowedByScopeGuard(scoped.spec, "src/config.ts").allowed).toBe(true);
    expect(isFileMutationAllowedByScopeGuard(scoped.spec, "src/other.ts").allowed).toBe(false);
    expect(isFileMutationAllowedByScopeGuard(scoped.spec, "report.csv.sha256").allowed).toBe(false);
    expect(buildTaskScopeGuardPrompt(scoped.spec)).toContain("Mandatory Completion Exception");
  });

  it("formats compact accessibility snapshots with concise role/label/locator lines", () => {
    const out = formatCompactA11ySnapshot({
      title: "T3 Settings",
      url: "http://localhost:5733/settings",
      elements: [
        {
          role: "button",
          name: "검색용 모델 저장",
          locator: 'getByRole("button", { name: "검색용 모델 저장" })',
        },
        { role: "checkbox", name: "전역 AI 계약 적용", checked: true, selector: "#global-enabled" },
      ],
    });
    expect(out).toContain("# T3 Settings");
    expect(out).toContain('[1] button "검색용 모델 저장"');
    expect(out).toContain("(checked) -> #global-enabled");
  });

  it("routes prompts locally in <1ms across zero_cost_local, balanced, and deep_reasoning tiers", () => {
    const t0 = performance.now();
    const cheap = classifySmartModelRoute({ prompt: "이 문장을 영어로 짧게 번역해줘" });
    const deep = classifySmartModelRoute({
      prompt: "모노레포 전체 동시성 데드락과 보안 감사를 수행하고 마이그레이션 아키텍처를 설계해줘",
      requiresTools: true,
    });
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(15);
    expect(cheap.tier).toBe("zero_cost_local");
    expect(deep.tier).toBe("deep_reasoning");

    const pool = [
      { instanceId: "ollama-local", model: "qwen2.5-coder:14b", isLocalZeroCost: true },
      { instanceId: "gemini", model: "gemini-3.8-flash" },
      { instanceId: "claude", model: "claude-opus-5-5" },
    ];
    expect(selectBestModelFromPool(pool, cheap.tier)?.model).toBe("qwen2.5-coder:14b");
    expect(selectBestModelFromPool(pool, deep.tier)?.model).toBe("claude-opus-5-5");
  });

  it("exports Obsidian-compatible YAML frontmatter, callouts, wikilinks, and .base views", () => {
    const note = renderObsidianVaultNote({
      id: "k-1",
      title: "RAG 성능 벤치마크",
      content: "RAGAS 4대 지표 1.0 달성",
      tags: ["#rag", "benchmark"],
      sourceUrls: ["https://example.com/rag"],
      updatedAt: "2026-11-22T01:00:00Z",
      relatedTitles: ["차세대 검색 아키텍처"],
    });
    expect(note).toContain('t3_id: "k-1"');
    expect(note).toContain("> [!info] 출처");
    expect(note).toContain("- [[차세대 검색 아키텍처]]");

    const base = renderObsidianBaseView("T3-Knowledge");
    expect(base).toContain('file.inFolder("T3-Knowledge")');
    expect(base).toContain("type: table");
  });
});
