import { describe, expect, it } from "vite-plus/test";
import { auditPersonaDriftWindow } from "./PersonaDriftAuditor.ts";

describe("PersonaDriftAuditor", () => {
  it("flags banmal honorific drift, forbidden endings, and internal PAD leaks while ignoring code blocks", () => {
    const report = auditPersonaDriftWindow({
      personaId: "preset-pacemaker-soyul",
      register: {
        speechLevel: "banmal_hae",
        userHonorific: "너",
        selfPronoun: "나",
        forbiddenEndings: ["하시옵소서"],
        enforceNoMidTurnDrift: true,
      },
      turns: [
        {
          turnId: "t-1",
          assistantText: "야 이건 바로 고치면 돼.\n```ts\nconst msg = '감사합니다 PAD: 0.85';\n```",
        },
        {
          turnId: "t-2",
          assistantText: "확인했습니다. 현재 [Tier C] PAD: 0.42 상태로 안내드립니다.",
        },
      ],
    });

    expect(report.healthy).toBe(false);
    expect(report.inspectedTurns).toBe(2);
    expect(report.findings.some((f) => f.turnId === "t-1")).toBe(false);
    expect(report.findings.some((f) => f.code === "register_mismatch")).toBe(true);
    expect(report.findings.some((f) => f.code === "meta_prompt_leak")).toBe(true);
    expect(report.correctiveHint).toContain("banmal_hae");
  });

  it("reports healthy when recent 5 turns keep consistent haeyo register", () => {
    const report = auditPersonaDriftWindow({
      personaId: "builtin-chief-of-staff",
      register: {
        speechLevel: "haeyo",
        userHonorific: "대표님",
        selfPronoun: "저",
        forbiddenEndings: ["~하오"],
        enforceNoMidTurnDrift: true,
      },
      turns: [
        { turnId: "t-1", assistantText: "대표님, 테스트 24건 모두 통과했어요." },
        { turnId: "t-2", assistantText: "다음 단계도 바로 정리해 드릴게요." },
      ],
    });

    expect(report.healthy).toBe(true);
    expect(report.driftScore).toBe(0);
    expect(report.correctiveHint).toBeNull();
  });
});
