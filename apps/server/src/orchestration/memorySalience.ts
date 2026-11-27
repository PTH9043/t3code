export type CognitiveMemoryType = "directive" | "semantic" | "episodic" | "procedural";
export type MemorySalienceTier = "user-decision" | "reported-evidence" | "ordinary";

export interface MemoryClassificationResult {
  salience: MemorySalienceTier;
  cognitiveType: CognitiveMemoryType;
  requiresProceduralReview: boolean;
  extractedSummaryHeader: string;
}

const DIRECTIVE_PATTERNS =
  /(?:절대|항상|반드시|규칙|금지|하지\s*마|쓰지\s*마|고정|원칙|지시|우선|조건|정정|수정해야|always|never|must(?:\s+not)?|strictly|convention|policy|constraint|correction)/iu;

const PROCEDURAL_PATTERNS =
  /(?:순서대로|단계별|절차|런북|스크립트|빌드\s*방법|배포\s*절차|재현\s*방법|체크리스트|runbook|step-by-step|workflow|how\s+to\s+run|command\s+sequence)/iu;

const DECISION_PATTERNS =
  /(?:기억|결정|채택|전환|업그레이드|마이그레이션|변경하기로|합의|선택|예산|기간|역할|권한|remember|decision|preference|decided\s+to|switched\s+to|migrated\s+to|adopted)/iu;

const EVIDENCE_PATTERNS =
  /(?:원인은|버그|해결|에러|로그|벤치마크|측정\s*결과|검증|테스트|시험|원인|실패|반려|통과|오류|근거|출처|확인|root\s+cause|fixed\s+by|stack\s+trace|error\s+code|regression|verified|test|failed|failure|evidence|source|error)/iu;

const PATH_OR_URL_EVIDENCE =
  /https?:\/\/\S+|(?:[\p{L}\p{N}_.-]+[\\/])+[\p{L}\p{N}_.-]+|[\p{L}\p{N}_-]+\.(?:ts|tsx|py|md|json|cs|go|rs|sql)(?::\d+)?/iu;

/** Classify signals without claiming that an assistant report has been verified. */
export function classifyMemorySalience(origin: string, text: string): MemorySalienceTier {
  const normalized = text.normalize("NFKC").trim();
  if (!normalized) return "ordinary";
  const isUser = origin === "user" || origin === "user-requested";
  if (
    isUser &&
    (DIRECTIVE_PATTERNS.test(normalized) ||
      DECISION_PATTERNS.test(normalized) ||
      PROCEDURAL_PATTERNS.test(normalized) ||
      /실패|원인/iu.test(normalized))
  ) {
    return "user-decision";
  }
  const hasPathOrUrl = PATH_OR_URL_EVIDENCE.test(normalized);
  const hasOutcome = EVIDENCE_PATTERNS.test(normalized);
  if (
    (origin === "assistant" || origin === "agent") &&
    normalized.length >= 40 &&
    hasPathOrUrl &&
    hasOutcome
  ) {
    return "reported-evidence";
  }
  return "ordinary";
}

/**
 * CoALA 4-memory cognitive classification (directive / semantic / episodic / procedural)
 * with existing 3-tier salience compatibility and procedural safety guardrail.
 */
export function classifyCognitiveMemory(
  content: string,
  role: string = "user",
): MemoryClassificationResult {
  const normalized = content.normalize("NFKC").trim();
  const firstLine = normalized.split(/\r?\n/)[0]?.slice(0, 110) ?? "";
  const isUser = role === "user" || role === "user-requested";
  const salience = classifyMemorySalience(role, normalized);

  if (isUser && DIRECTIVE_PATTERNS.test(normalized)) {
    return {
      salience: "user-decision",
      cognitiveType: "directive",
      requiresProceduralReview: false,
      extractedSummaryHeader: firstLine,
    };
  }

  if (PROCEDURAL_PATTERNS.test(normalized)) {
    return {
      salience: isUser ? "user-decision" : salience === "ordinary" ? "reported-evidence" : salience,
      cognitiveType: "procedural",
      // CoALA security guardrail: agent-generated procedural memory requires review before promotion.
      requiresProceduralReview: !isUser,
      extractedSummaryHeader: firstLine,
    };
  }

  if (DECISION_PATTERNS.test(normalized)) {
    return {
      salience: isUser ? "user-decision" : salience,
      cognitiveType: "semantic",
      requiresProceduralReview: false,
      extractedSummaryHeader: firstLine,
    };
  }

  if (EVIDENCE_PATTERNS.test(normalized)) {
    return {
      salience: isUser
        ? salience
        : salience === "ordinary" && PATH_OR_URL_EVIDENCE.test(normalized)
          ? "reported-evidence"
          : salience,
      cognitiveType: "episodic",
      requiresProceduralReview: false,
      extractedSummaryHeader: firstLine,
    };
  }

  return {
    salience,
    cognitiveType: "episodic",
    requiresProceduralReview: false,
    extractedSummaryHeader: firstLine,
  };
}

/**
 * Procedural Memory Progressive Disclosure manifest builder:
 * exposes a lightweight 1-line index (~50 tokens) and expands full steps only
 * for runbooks whose topic/header matches the current query tokens.
 */
export function composeProgressiveProceduralContext(
  proceduralRecords: ReadonlyArray<{
    readonly id: string;
    readonly topic: string;
    readonly summaryHeader: string;
    readonly fullSteps: string;
  }>,
  currentQuery: string,
  maxExpandedRunbooks: number = 2,
): string {
  if (proceduralRecords.length === 0) return "";

  const queryTokens = new Set(
    currentQuery
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^a-z0-9가-힣_-]+/u)
      .filter((t) => t.length >= 2),
  );

  const scored = proceduralRecords.map((rec) => {
    const headerTokens = `${rec.topic} ${rec.summaryHeader}`.normalize("NFKC").toLowerCase();
    let hits = 0;
    for (const qt of queryTokens) {
      if (headerTokens.includes(qt)) hits++;
    }
    return { rec, hits };
  });

  scored.sort((a, b) => b.hits - a.hits);

  const manifestLines = [
    "### Procedural Memory Manifest (Runbooks & Learned Skills)",
    ...proceduralRecords.map((r) => `- [${r.id}] (${r.topic}): ${r.summaryHeader}`),
  ];

  const expanded = scored
    .filter((s) => s.hits > 0)
    .slice(0, maxExpandedRunbooks)
    .map((s) => `\n#### Expanded Runbook [${s.rec.id}]: ${s.rec.topic}\n${s.rec.fullSteps}`);

  return [...manifestLines, ...expanded].join("\n");
}
