import type { KoreanRegisterSpec } from "@t3tools/contracts";

export interface DriftAuditTurn {
  readonly turnId: string;
  readonly assistantText: string;
}

export interface PersonaDriftFinding {
  readonly turnId: string;
  readonly code: "forbidden_ending" | "register_mismatch" | "meta_prompt_leak";
  readonly evidence: string;
}

export interface PersonaDriftAuditReport {
  readonly personaId: string;
  readonly inspectedTurns: number;
  readonly driftScore: number;
  readonly healthy: boolean;
  readonly findings: ReadonlyArray<PersonaDriftFinding>;
  readonly correctiveHint: string | null;
}

const META_LEAK_PATTERNS: ReadonlyArray<RegExp> = [
  /\[Tier\s+[ABC](?:-[12])?\]/i,
  /PAD\s*[:=]\s*\(?-?\d+\.\d+/i,
  /OCEAN\s*(?:점수|수치|벡터)/i,
  /시스템\s*프롬프트에\s*따르면/i,
];

const BANMAL_FORBIDDEN_HONORIFIC = /(?:습니다|ㅂ니다|세요|해요|드립니다)[.!?]?(?:\s|$)/;
const HONORIFIC_FORBIDDEN_BANMAL = /(?:했어|할게|알았어|야|거든|잖아)[.!?]?(?:\s|$)/;

/**
 * Strips fenced code blocks and inline code so technical identifiers never
 * trigger false-positive register or forbidden-ending alarms.
 */
function stripCodeSpans(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
}

export interface LegacyRegisterLike {
  readonly speechLevel: "banmal_hae" | "haeyo" | "hasipsio" | string;
  readonly forbiddenEndings: ReadonlyArray<string>;
}

export type DriftAuditRegister = KoreanRegisterSpec | LegacyRegisterLike;

function resolveSpeechLevelLabel(register: DriftAuditRegister): {
  readonly kind: "banmal" | "honorific" | "other";
  readonly label: string;
} {
  if ("speechLevel" in register) {
    if (register.speechLevel === "banmal_hae") {
      return { kind: "banmal", label: register.speechLevel };
    }
    if (register.speechLevel === "haeyo" || register.speechLevel === "hasipsio") {
      return { kind: "honorific", label: register.speechLevel };
    }
    return { kind: "other", label: register.speechLevel };
  }
  if (register.primaryLevel === "casual_banmal") {
    return { kind: "banmal", label: register.primaryLevel };
  }
  if (register.primaryLevel === "polite_haeyo" || register.primaryLevel === "formal_hapsipsio") {
    return { kind: "honorific", label: register.primaryLevel };
  }
  return { kind: "other", label: register.primaryLevel };
}

/**
 * Audits the last N assistant turns (default 5) for persona speech-level drift,
 * forbidden endings, and internal PAD/prompt leakage.
 */
export function auditPersonaDriftWindow(input: {
  readonly personaId: string;
  readonly register: DriftAuditRegister;
  readonly turns: ReadonlyArray<DriftAuditTurn>;
  readonly windowSize?: number;
}): PersonaDriftAuditReport {
  const windowTurns = input.turns.slice(-(input.windowSize ?? 5));
  const findings: PersonaDriftFinding[] = [];
  const level = resolveSpeechLevelLabel(input.register);

  for (const turn of windowTurns) {
    const prose = stripCodeSpans(turn.assistantText);

    for (const pattern of META_LEAK_PATTERNS) {
      const m = prose.match(pattern);
      if (m) {
        findings.push({
          turnId: turn.turnId,
          code: "meta_prompt_leak",
          evidence: m[0],
        });
      }
    }

    for (const ending of input.register.forbiddenEndings) {
      const trimmed = ending.trim();
      if (!trimmed) continue;
      if (prose.includes(trimmed)) {
        findings.push({
          turnId: turn.turnId,
          code: "forbidden_ending",
          evidence: trimmed,
        });
      }
    }

    if (level.kind === "banmal") {
      const m = prose.match(BANMAL_FORBIDDEN_HONORIFIC);
      if (m) {
        findings.push({
          turnId: turn.turnId,
          code: "register_mismatch",
          evidence: m[0].trim(),
        });
      }
    } else if (level.kind === "honorific") {
      const m = prose.match(HONORIFIC_FORBIDDEN_BANMAL);
      if (m) {
        findings.push({
          turnId: turn.turnId,
          code: "register_mismatch",
          evidence: m[0].trim(),
        });
      }
    }
  }

  const denominator = Math.max(windowTurns.length, 1);
  const driftScore = Math.min(1, Number((findings.length / (denominator * 2)).toFixed(3)));
  const healthy = findings.length === 0;

  let correctiveHint: string | null = null;
  if (!healthy) {
    const codes = new Set(findings.map((f) => f.code));
    const hints: string[] = [];
    if (codes.has("meta_prompt_leak")) {
      hints.push("내부 감정 수치·계층 명칭을 답변 본문에 노출하지 말 것");
    }
    if (codes.has("register_mismatch") || codes.has("forbidden_ending")) {
      hints.push(`설정된 화계(${level.label})를 유지하고 금지 어미를 피할 것`);
    }
    correctiveHint = hints.join("; ");
  }

  return {
    personaId: input.personaId,
    inspectedTurns: windowTurns.length,
    driftScore,
    healthy,
    findings,
    correctiveHint,
  };
}
