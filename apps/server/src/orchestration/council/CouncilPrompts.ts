import type {
  CouncilClaimNode,
  CouncilRoleArchetype,
  CouncilSeatAssignment,
  EffectiveCouncilMode,
  EvidenceLedgerEntry,
} from "@t3tools/contracts";

/**
 * Orthogonal role prompts & strict structured JSON envelopes for:
 * - Round 1 (Blind Isolated Exploration)
 * - Round 2 (Dynamic Anonymized Critique `Proposal-1..M`)
 * - Round 3 (Arbiter Synthesis — `discussion` report vs `code_patch` PinnedSpec)
 *
 * Workspace-neutral: never hardcodes T3-specific directory names or tech stacks.
 */

const ROLE_DUTY_CODE_PATCH_KO: Record<CouncilRoleArchetype, string> = {
  CHAIR_ARBITER:
    "당신은 의장(CHAIR_ARBITER)입니다. Round 1에서는 다른 좌석의 제안을 전혀 보지 않은 상태로 독립적 원인과 최소 침습 패치 초안을 실존 파일·라인 근거와 함께 작성하세요.",
  CONTRARIAN_RED:
    "당신은 의무 반론자·레드팀(CONTRARIAN_RED)입니다. 다수파 설계의 회귀 버그, 보안 허점, 경쟁 조건, 표본/가정 오류를 최소 1건 이상 실존 파일·라인·심볼(또는 데이터 키) 근거와 함께 의무 공격하세요. 근거 없는 막연한 찬성은 금지됩니다.",
  SYSTEM_ARCHITECT:
    "당신은 수석 설계자(SYSTEM_ARCHITECT)입니다. 현재 프로젝트의 모듈 간 데이터·타입 계약 정합성과 최소 침습(Minimal Diff) 변경 구조를 실제 로컬 근거에 기반해 설계하세요.",
  AST_LEDGER_AUDITOR:
    "당신은 원장·심볼 대조관(AST_LEDGER_AUDITOR)입니다. 인용된 코드·스크립트·데이터 파일의 실제 함수 시그니처, 필드/키 경로, 입출력 경계 및 예외 처리 누락 여부를 정밀 대조하세요.",
  EDGE_PERF_CRITIC:
    "당신은 경계·성능·통계 분석가(EDGE_PERF_CRITIC)입니다. 경계값 입력, 누락/말단 데이터 절단, 타임아웃·취소 경합, 자원/수수료/오버헤드 왜곡 위험을 집중 탐색하세요.",
  INTENT_CONTRACT_GUARD:
    "당신은 의도·검증 감사관(INTENT_CONTRACT_GUARD)입니다. 사용자의 원래 질문·요구사항 중 빠진 항목이 없는지 점검하고, 검증 기준의 완전성을 확인하세요.",
};

const ROLE_DUTY_DISCUSSION_KO: Record<CouncilRoleArchetype, string> = {
  CHAIR_ARBITER:
    "당신은 의장(CHAIR_ARBITER)입니다. Round 1에서는 다른 좌석의 의견을 보지 않은 상태로 사용자의 질문에 대한 독립적 핵심 가설·원인 진단·실행 전략을 프로젝트 내 실존 파일·데이터 근거와 함께 작성하세요.",
  CONTRARIAN_RED:
    "당신은 의무 반론자·레드팀(CONTRARIAN_RED)입니다. 직관적 가설의 생존 편향, 과최적화, 표본 부족, 반례, 숨은 비용/위험을 실존 코드·결과 데이터 근거와 함께 날카롭게 반박하세요.",
  SYSTEM_ARCHITECT:
    "당신은 구조·전략 설계자(SYSTEM_ARCHITECT)입니다. 현상을 설명하는 메커니즘과 실행 가능한 의사결정 프레임워크·검증 실험 설계를 실존 파일 근거로 구조화하세요.",
  AST_LEDGER_AUDITOR:
    "당신은 데이터·원장 대조관(AST_LEDGER_AUDITOR)입니다. 로컬 스크립트·지표 계산식·결과 JSON/문서의 실제 수치와 정의가 주장과 정확히 일치하는지 대조하세요.",
  EDGE_PERF_CRITIC:
    "당신은 경계·예외·리스크 분석가(EDGE_PERF_CRITIC)입니다. 극단 구간(급락·유동성 고갈·구간 경계·미완결 표본)에서의 왜곡과 실패 조건을 집중 검증하세요.",
  INTENT_CONTRACT_GUARD:
    "당신은 질문 의도·논리 감사관(INTENT_CONTRACT_GUARD)입니다. 사용자의 핵심 질문에서 벗어난 동문서답이나 근거 없는 일반론을 걸러내고 실제로 답해야 할 쟁점을 고정하세요.",
};

function roleGuidance(role: CouncilRoleArchetype, mode: EffectiveCouncilMode): string {
  return mode === "discussion" ? ROLE_DUTY_DISCUSSION_KO[role] : ROLE_DUTY_CODE_PATCH_KO[role];
}

export function buildBlindRound1Prompt(input: {
  readonly userPrompt: string;
  readonly seat: CouncilSeatAssignment;
  readonly workspaceSummary: string;
  readonly mode?: EffectiveCouncilMode;
  readonly targetedRetryFocus?: ReadonlyArray<string>;
}): string {
  const mode = input.mode ?? "code_patch";
  const shardNote = input.seat.directoryShardHint
    ? `집중 탐색 디렉터리 샤드(Shard): \`${input.seat.directoryShardHint}\` (동일 모델 중복 다양성 보장용 — 관련 파일이 이 영역에 있으면 우선 확인하세요).`
    : null;
  const retryNote =
    input.targetedRetryFocus && input.targetedRetryFocus.length > 0
      ? `표적 재탐색 지시(미해결 쟁점): ${input.targetedRetryFocus.join(" / ")}`
      : null;

  const modeNote =
    mode === "discussion"
      ? "이번 회의는 **분석·토론 보고서 모드**입니다. 억지로 코드 수정 패치를 지어내지 말고, 프로젝트 내 실존 스크립트·문서·데이터 파일을 조회해 정확한 근거(`filePath`, `startLine`, `endLine`, 함수명 또는 JSON 키 경로)를 제시하세요."
      : "이번 회의는 **코드 수정 명세 모드**입니다. 실존 파일 경로(워크스페이스 상대 경로), 정확한 `startLine`/`endLine`, 심볼명을 확인해 최소 침습 패치안을 제시하세요.";

  const schemaExample =
    mode === "discussion"
      ? {
          claimKind:
            input.seat.assignedRole === "CONTRARIAN_RED"
              ? "CONTRARIAN_CHALLENGE"
              : "ROOT_DIAGNOSIS",
          severity: input.seat.assignedRole === "CONTRARIAN_RED" ? "P0" : "P1",
          statementKo: "<여기에_실제_분석_결론과_수치_근거를_한국어로_작성>",
          proposedDiffSketch: null,
          evidence: [
            {
              filePath: "<실존_상대_파일_경로>",
              startLine: 1,
              endLine: 20,
              astSymbol: "<실존_함수명_또는_JSON_키_경로>",
            },
          ],
          acceptanceCommands: [],
        }
      : {
          claimKind:
            input.seat.assignedRole === "CONTRARIAN_RED"
              ? "CONTRARIAN_CHALLENGE"
              : "PATCH_PROPOSAL",
          severity: input.seat.assignedRole === "CONTRARIAN_RED" ? "P0" : "P1",
          statementKo: "<여기에_실제_원인_진단_및_패치_요약을_한국어로_작성>",
          proposedDiffSketch: "<파일별_최소_침습_변경_요약>",
          evidence: [
            {
              filePath: "<실존_상대_파일_경로>",
              startLine: 1,
              endLine: 25,
              astSymbol: "<실존_함수_또는_타입_심볼명>",
            },
          ],
          acceptanceCommands: [],
        };

  return [
    "# 다자간 위원회 — Round 1 (블라인드 격리 탐색)",
    roleGuidance(input.seat.assignedRole, mode),
    modeNote,
    "중요: Round 1은 완전 읽기 격리 단계입니다. 파일 수정 없이 로컬 파일만 조회하여 근거를 수집하세요.",
    "주의: 아래 JSON 예시의 `<...>` 자리표시 문구를 그대로 복사해 출력하면 원장에서 즉시 자동 기각됩니다.",
    "응답 안에 자신의 모델명이나 프로바이더 이름을 적지 마세요.",
    ...(shardNote ? [shardNote] : []),
    ...(retryNote ? [retryNote] : []),
    "",
    "## 사용자 요청",
    input.userPrompt,
    "",
    "## 워크스페이스 컨텍스트 요약",
    input.workspaceSummary,
    "",
    "## 필수 출력 형식 (strict JSON)",
    "반드시 `<t3_council_proposal>` 와 `</t3_council_proposal>` 태그 사이에 아래 스키마의 JSON 하나만 출력하세요.",
    "```json",
    JSON.stringify(schemaExample, null, 2),
    "```",
  ].join("\n");
}

export interface AnonymizedProposalCard {
  readonly anonHandle: string;
  readonly claimId: string;
  readonly claimKind: CouncilClaimNode["claimKind"];
  readonly statementKo: string;
  readonly proposedDiffSketch: string | null;
  readonly verifiedEvidence: ReadonlyArray<{
    readonly evidenceId: string;
    readonly filePath: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly astSymbol: string | null;
    readonly excerptSha256Short: string;
    readonly status: EvidenceLedgerEntry["verificationStatus"];
  }>;
}

export function buildAnonymizedRound2Prompt(input: {
  readonly userPrompt: string;
  readonly seat: CouncilSeatAssignment;
  readonly ownAnonHandle: string;
  readonly ownRound1Claim: CouncilClaimNode | null;
  readonly anonymizedProposals: ReadonlyArray<AnonymizedProposalCard>;
  readonly mode?: EffectiveCouncilMode;
}): string {
  const mode = input.mode ?? "code_patch";
  const proposalLines = input.anonymizedProposals.map((card) => {
    const evList =
      card.verifiedEvidence.length > 0
        ? card.verifiedEvidence
            .map(
              (ev) =>
                `  - [${ev.evidenceId}] ${ev.filePath}:${ev.startLine}-${ev.endLine} (${ev.astSymbol ?? "no-symbol"}, sha=${ev.excerptSha256Short}, ${ev.status})`,
            )
            .join("\n")
        : "  - (검증된 근거 0건)";
    return [
      `### ${card.anonHandle} (claimId=${card.claimId}, kind=${card.claimKind})`,
      `- 주장: ${card.statementKo}`,
      ...(card.proposedDiffSketch ? [`- 변경 스케치: ${card.proposedDiffSketch}`] : []),
      `- 원장 검증 근거:\n${evList}`,
    ].join("\n");
  });

  const contrarianNote =
    input.seat.assignedRole === "CONTRARIAN_RED"
      ? '규칙 4 (레드팀 판정): 다른 제안들이 당신의 Round 1 우려를 타당한 근거로 해소했다면 `claimKind: "REBUTTAL_DEFENSE"`, `severity: "P1"`, `responseTaxonomy: "SCOPE_NARROWED"`로 판정하세요. 여전히 치명적 결함이 미해결 상태이고 실존 근거로 입증될 때만 `CONTRARIAN_CHALLENGE` + `P0`를 유지하세요.'
      : null;

  return [
    "# 다자간 위원회 — Round 2 (익명 교차 비평 & 근거 기반 방어)",
    roleGuidance(input.seat.assignedRole, mode),
    `당신의 이번 라운드 익명 식별자는 \`${input.ownAnonHandle}\`입니다.`,
    "규칙 1 (Evidence-Gated Flip): Round 1 입장을 바꾸려면 반드시 Round 1에 없던 **새로운 실존 파일·라인 근거**를 함께 제시해야 합니다. 새 근거 없이 다수 의견에 동조하면 상태 머신이 `FLIP_BLOCKED`로 자동 기각합니다.",
    "규칙 2 (정형 응답): 반론을 수용·방어할 때는 반드시 `targetClaimId`에 대상 `clm_...` ID를 지정하고, `NEW_EVIDENCE_ADDED`, `SCOPE_NARROWED`, `CONFIDENCE_REDUCED`, `DEFERRED_ACCEPTED` 중 하나를 명시하세요.",
    "규칙 3: 모델명/프로바이더명을 추측하거나 언급하지 말고 오직 `Proposal-1..M`과 검증 근거로만 논증하세요.",
    ...(contrarianNote ? [contrarianNote] : []),
    "",
    "## 사용자 요청",
    input.userPrompt,
    "",
    "## Round 1 익명 제안 및 검증 원장",
    proposalLines.join("\n\n"),
    "",
    ...(input.ownRound1Claim
      ? [
          `## 당신의 Round 1 원안 (${input.ownRound1Claim.claimId})`,
          input.ownRound1Claim.statementKo,
          "",
        ]
      : []),
    "## 필수 출력 형식 (strict JSON)",
    "반드시 `<t3_council_critique>` 와 `</t3_council_critique>` 태그 사이에 아래 스키마의 JSON 하나만 출력하세요 (`<...>` 자리표시 복붙 금지).",
    "```json",
    JSON.stringify(
      {
        claimKind: "REBUTTAL_DEFENSE",
        severity: "P1",
        targetClaimId: input.anonymizedProposals[0]?.claimId ?? null,
        responseTaxonomy: "NEW_EVIDENCE_ADDED",
        statementKo: "<익명_제안에_대한_근거_기반_비평_또는_입장_보강을_한국어로_작성>",
        proposedDiffSketch: mode === "discussion" ? null : "<유지_또는_보강된_변경_스케치>",
        evidence: [
          {
            filePath: "<실존_상대_파일_경로>",
            startLine: 1,
            endLine: 20,
            astSymbol: "<실존_심볼_또는_JSON_키_경로>",
          },
        ],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

export function buildArbiterSynthesisPrompt(input: {
  readonly userPrompt: string;
  readonly verifiedClaims: ReadonlyArray<CouncilClaimNode>;
  readonly verifiedLedger: ReadonlyArray<EvidenceLedgerEntry>;
  readonly unresolvedChallenges: ReadonlyArray<CouncilClaimNode>;
  readonly mode?: EffectiveCouncilMode;
}): string {
  const mode = input.mode ?? "code_patch";
  const claimLines = input.verifiedClaims.map(
    (c) =>
      `- [${c.claimId}] (${c.anonHandle}, kind=${c.claimKind}, belief=${c.subjectiveOpinion.belief.toFixed(2)}, u=${c.subjectiveOpinion.uncertainty.toFixed(2)}, status=${c.status}): ${c.statementKo}` +
      (c.proposedDiffSketch ? `\n  Sketch: ${c.proposedDiffSketch}` : "") +
      `\n  EvidenceIds: ${c.evidenceIds.join(", ")}`,
  );
  const ledgerLines = input.verifiedLedger.map(
    (e) =>
      `- [${e.evidenceId}] ${e.filePath}:${e.startLine}-${e.endLine} (symbol=${e.astSymbol ?? "none"}, headSha=${e.fileHeadSha256.slice(0, 12)}, ${e.verificationStatus})`,
  );
  const challengeLines = input.unresolvedChallenges.map(
    (c) => `- [P0 ${c.claimId}] ${c.statementKo} (EvidenceIds: ${c.evidenceIds.join(", ")})`,
  );

  const synthesisExample =
    mode === "discussion"
      ? {
          titleKo: "<핵심_결론을_한_줄로_요약한_한국어_제목_80자_이내>",
          executiveSummaryKo:
            "<사용자가_바로_의사결정할_수_있는_구조화된_한국어_합의_보고서_본문(핵심_결론,정량_수치_대조,권장_행동_포함)>",
          acceptedClaimIds: input.verifiedClaims.slice(0, 3).map((c) => c.claimId),
          targetFiles: [],
          acceptanceChecks: [],
          unresolvedDisagreementsKo: [],
          uniqueFindingsKo: ["<소수파_좌석이_발견한_중요한_경계_조건이나_반례>"],
        }
      : {
          titleKo: "<합의된_실행_명세_제목_80자_이내>",
          executiveSummaryKo: "<합의_사항_핵심_변경_검증_전략_요약>",
          acceptedClaimIds: input.verifiedClaims.slice(0, 3).map((c) => c.claimId),
          targetFiles: [
            {
              filePath: "<실제로_수정할_코드_파일_경로>",
              patchIntentKo: "<수정_목적과_범위>",
              relatedEvidenceIds: input.verifiedLedger.slice(0, 1).map((e) => e.evidenceId),
            },
          ],
          acceptanceChecks: [
            {
              label: "<검증_명령_설명>",
              command: "node",
              args: ["-e", "process.exit(0)"],
            },
          ],
          unresolvedDisagreementsKo: [],
          uniqueFindingsKo: ["<소수파_좌석이_발견한_고유_경계_조건>"],
        };

  return [
    "# 다자간 위원회 — Round 3 (의장 최종 합성)",
    mode === "discussion"
      ? "당신은 의장(CHAIR_ARBITER)입니다. 이번 회의는 **분석·토론 보고서 모드**이므로 억지로 수정 대상 파일(`targetFiles`)을 잡지 말고(`[]` 유지), 디스크 검증을 통과한 주장과 근거만 종합해 명확한 결론·수치 근거·소수파 발견·미해결 쟁점을 합성하세요."
      : "당신은 의장(CHAIR_ARBITER)입니다. 아래 **디스크 검증을 통과한 주장과 코드 근거 원장만** 사용하여 합의안, 미해결 이견, 고유 발견, 실제 수정할 코드 파일(`targetFiles`), 인수 검증 명령을 구조화 합성하세요. 검증 원장에 없는 파일은 절대 넣지 마세요.",
    "",
    "## 사용자 요청",
    input.userPrompt,
    "",
    "## 원장 검증 통과 주장 (Subjective Logic 가중치 순)",
    claimLines.join("\n"),
    "",
    "## 검증된 근거 원장",
    ledgerLines.join("\n"),
    "",
    ...(challengeLines.length > 0
      ? [
          "## 미해결 P0 반론 목록 (반드시 반영하거나 unresolvedDisagreementsKo에 명시)",
          challengeLines.join("\n"),
          "",
        ]
      : []),
    "## 필수 출력 형식 (strict JSON — 태그 외 불필요한 서문 없이 정확히 출력)",
    "반드시 `<t3_council_synthesis>` 와 `</t3_council_synthesis>` 태그 사이에 유효한 JSON 하나만 출력하세요.",
    "```json",
    JSON.stringify(synthesisExample, null, 2),
    "```",
  ].join("\n");
}
