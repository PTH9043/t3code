/**
 * Deterministic, zero-LLM-cost Korean user utterance & speech-style profiler.
 *
 * Keeps raw user messages 100% verbatim in separated storage while isolating the
 * user's own natural voice segments (e.g. instructions after `->` when pasting logs/cards)
 * so AI-authored quotes or terminal dumps never distort the user's speaking style profile.
 */

export type DominantSpeechRegister =
  | "casual_banmal"
  | "polite_haeyo"
  | "formal_hapsipsio"
  | "concise_directive"
  | "mixed";

export interface UserUtteranceInput {
  readonly id?: string | undefined;
  readonly threadId?: string | null | undefined;
  readonly threadTitle?: string | null | undefined;
  readonly text: string;
  readonly createdAt?: string | null | undefined;
}

export interface SpeechHabitObservation {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  readonly examples: ReadonlyArray<string>;
}

export interface UserSpeechStyleProfile {
  readonly totalUserMessages: number;
  readonly analyzedVoiceSegmentCount: number;
  readonly avgVoiceChars: number;
  readonly dominantRegister: DominantSpeechRegister;
  readonly registerCounts: {
    readonly casualBanmal: number;
    readonly politeHaeyo: number;
    readonly formalHapsipsio: number;
    readonly conciseDirective: number;
  };
  readonly arrowChainMessageCount: number;
  readonly parentheticalAsideCount: number;
  readonly habitObservations: ReadonlyArray<SpeechHabitObservation>;
  readonly frequentEndings: ReadonlyArray<{ readonly ending: string; readonly count: number }>;
  readonly representativeSamples: ReadonlyArray<{
    readonly text: string;
    readonly createdAt: string | null;
    readonly threadTitle: string | null;
  }>;
}

const FENCED_CODE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/gu;
const URL_ONLY_RE = /^https?:\/\/\S+$/iu;
const TECHNICAL_NOISE_LINE_RE =
  /^(?:\s*[{[\]}]\s*$|(?:\[추천\s*\d+순위\]|잠금\s*대상\s*파일|인수\s*검증\s*게이트|원장\s*검증\s*근거|무근거\s*Flip|\d+인\s*동적\s*위원회|CHAIR\s*·|RED\s*·|ARCH\s*·|LEDGER\s*·|EDGE\s*·|GUARD\s*·|File\s+change|Command\s+output:|Traceback|at\s+\S+\s*\(|[A-Za-z0-9_./\\-]+\.(?:py|ts|tsx|js|json|md)\s*\[[0-9a-f]{6,}\]|node\s+-e\s+process\.exit))/iu;

function stripCodeAndQuotes(raw: string): string {
  return raw
    .replaceAll("\r\n", "\n")
    .replace(FENCED_CODE_RE, "\n")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .trim();
}

function looksLikePastedReportBlock(block: string): boolean {
  const trimmed = block.trim();
  if (!trimmed) return true;
  const lineCount = trimmed.split("\n").length;
  if (lineCount >= 4 && trimmed.length >= 220) return true;
  if (
    /(?:^|\n)\s*(?:###?\s+|\d+\.\s+\*\*|진단:|변경한\s*것|건드리지\s*않은\s*것|우려\s*사항)/u.test(
      trimmed,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Extracts the user's own spoken segments from a raw user message without mutating
 * the stored verbatim original. Handles the common pattern where a user pastes UI text,
 * logs, or a URL and appends `-> 내 실제 말투 지시`.
 */
export function extractUserOwnVoiceSegments(rawText: string): ReadonlyArray<string> {
  const cleaned = stripCodeAndQuotes(rawText);
  if (!cleaned) return [];

  const segments: string[] = [];
  const arrowParts = cleaned
    .split(/\s*(?:->|→)\s*/u)
    .map((p) => p.trim())
    .filter(Boolean);

  if (arrowParts.length >= 2) {
    for (let idx = 0; idx < arrowParts.length; idx += 1) {
      const part = arrowParts[idx]!;
      if (URL_ONLY_RE.test(part)) continue;
      if (idx === 0 && looksLikePastedReportBlock(part)) continue;
      if (looksLikePastedReportBlock(part) && idx < arrowParts.length - 1) continue;
      const lines = part
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !URL_ONLY_RE.test(l) && !TECHNICAL_NOISE_LINE_RE.test(l));
      const joined = lines.join(" ").replace(/\s+/gu, " ").trim();
      if (joined.length >= 2 && joined.length <= 600) {
        segments.push(joined);
      }
    }
    if (segments.length > 0) return segments;
  }

  if (looksLikePastedReportBlock(cleaned)) {
    // Check if the final paragraph/line is the user's own remark appended at the bottom
    const lines = cleaned
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !TECHNICAL_NOISE_LINE_RE.test(l) && !URL_ONLY_RE.test(l));
    const tail = lines.at(-1);
    if (
      tail &&
      tail.length >= 4 &&
      tail.length <= 240 &&
      !/(?:합니다\.|습니다\.|됩니다\.)$/u.test(tail)
    ) {
      return [tail];
    }
    return [];
  }

  const keptLines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !URL_ONLY_RE.test(l) && !TECHNICAL_NOISE_LINE_RE.test(l));
  const merged = keptLines.join(" ").replace(/\s+/gu, " ").trim();
  if (!merged) return [];
  return [merged.slice(0, 600)];
}

const FORMAL_ENDING_RE =
  /(?:합니다|습니다|십니다|입니까|습니까|바랍니다|하십시오|하시기\s*바랍니다)[.!?~\s]*$/u;
const POLITE_ENDING_RE =
  /(?:해요|돼요|네요|군요|거든요|잖아요|할게요|볼게요|어요|아요|여요|세요|까요|나요|인가요|신가요)[.!?~\s]*$/u;
const CASUAL_BANMAL_ENDING_RE =
  /(?:해줘|해봐|해봐라|해라|보자|하자|할까|뭘까|인듯|같은데|같은디|인디|인데|잖아|말이야|이겡|이게|건데|거야|냐|니|지|어|아|야|네|군|다)[.!?~\s]*$/u;

function classifySegmentRegister(segment: string): keyof UserSpeechStyleProfile["registerCounts"] {
  const withoutParens = segment.replace(/\([^)]*\)/gu, "").trim() || segment.trim();
  if (FORMAL_ENDING_RE.test(withoutParens)) return "formalHapsipsio";
  if (POLITE_ENDING_RE.test(withoutParens)) return "politeHaeyo";
  if (CASUAL_BANMAL_ENDING_RE.test(withoutParens)) return "casualBanmal";
  return "conciseDirective";
}

const ENDING_EXTRACT_PATTERNS: ReadonlyArray<{ readonly label: string; readonly rx: RegExp }> = [
  { label: "~해줘 / ~해", rx: /(?:해\s*줘|해줘|진행해|수정해|확인해)[.!?~\s]*$/u },
  { label: "~해봐라 / ~봐라", rx: /(?:해\s*봐라|봐라|해라)[.!?~\s]*$/u },
  { label: "~인디 / ~같은디", rx: /(?:인디|같은디|건디|는디)[.!?~\s]*$/u },
  { label: "~인데 / ~같은데", rx: /(?:인데|같은데|건데|는데)[.!?~\s]*$/u },
  { label: "~말이야 / ~잖아", rx: /(?:말이야|잖아)[.!?~\s]*$/u },
  { label: "~냐 / ~나? / ~뭘까", rx: /(?:뭘까|할까|되나|안되나|맞나|뭐야|이겡|이게)[.!?~\s]*$/u },
  { label: "~해요 / ~세요", rx: /(?:해요|세요|돼요|네요|까요)[.!?~\s]*$/u },
  {
    label: "체언·명사형 종결 (~확정, ~파악)",
    rx: /(?:확정|파악|분석|정리|우선이야|재시작)[.!?~\s]*$/u,
  },
];

const HABIT_DETECTORS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly testRaw?: (raw: string) => boolean;
  readonly testVoice?: (seg: string) => boolean;
}> = [
  {
    id: "arrow_chaining",
    label: "인용·맥락 뒤 화살표(`->`)로 본론 지시 연결",
    testRaw: (raw) => /(?:->|→)/u.test(raw),
  },
  {
    id: "parenthetical_intent",
    label: "괄호 `(...)` 안에 진짜 의도·이유 덧붙이기",
    testVoice: (seg) => /\([^)]{4,}\)/u.test(seg),
  },
  {
    id: "colloquial_discourse",
    label: "구어체 추임새·강조 (`말이야`, `근데`, `자꾸`, `어 `)",
    testVoice: (seg) => /(?:말이야|근데|자꾸|^어\s+|잖아)/u.test(seg),
  },
  {
    id: "dialect_soft_ending",
    label: "친근한 구어·사투리형 어미 (`~인디`, `~같은디`, `~이겡`)",
    testVoice: (seg) => /(?:인디|같은디|건디|이겡)/u.test(seg),
  },
  {
    id: "root_cause_first",
    label: "수정 전 정확한 원인·이유 파악 우선 요청",
    testVoice: (seg) => /(?:원인|정확한\s*문제|파악이\s*우선|왜\s*그런|뭐야)/u.test(seg),
  },
  {
    id: "ellipsis_pause",
    label: "말줄임표(`..` / `...`)로 여운·당혹감 표현",
    testVoice: (seg) => /\.{2,}/u.test(seg),
  },
];

export function analyzeUserSpeechStyle(
  utterances: ReadonlyArray<UserUtteranceInput>,
): UserSpeechStyleProfile {
  const registerCounts = {
    casualBanmal: 0,
    politeHaeyo: 0,
    formalHapsipsio: 0,
    conciseDirective: 0,
  };
  let arrowChainMessageCount = 0;
  let parentheticalAsideCount = 0;
  let totalVoiceChars = 0;
  let analyzedVoiceSegmentCount = 0;

  const endingCounts = new Map<string, number>();
  const habitMap = new Map<string, { label: string; count: number; examples: string[] }>();
  for (const h of HABIT_DETECTORS) {
    habitMap.set(h.id, { label: h.label, count: 0, examples: [] });
  }

  const sampleCandidates: Array<{
    text: string;
    createdAt: string | null;
    threadTitle: string | null;
  }> = [];

  for (const item of utterances) {
    const raw = item.text?.trim() ?? "";
    if (!raw) continue;

    if (/(?:->|→)/u.test(raw)) {
      arrowChainMessageCount += 1;
    }

    const segments = extractUserOwnVoiceSegments(raw);
    for (const h of HABIT_DETECTORS) {
      if (h.testRaw && h.testRaw(raw)) {
        const entry = habitMap.get(h.id)!;
        entry.count += 1;
        const sample = segments[0] ?? raw.slice(0, 120);
        if (entry.examples.length < 3 && !entry.examples.includes(sample)) {
          entry.examples.push(sample);
        }
      }
    }

    for (const seg of segments) {
      analyzedVoiceSegmentCount += 1;
      totalVoiceChars += seg.length;
      if (/\([^)]{4,}\)/u.test(seg)) {
        parentheticalAsideCount += 1;
      }

      const reg = classifySegmentRegister(seg);
      registerCounts[reg] += 1;

      for (const ep of ENDING_EXTRACT_PATTERNS) {
        if (ep.rx.test(seg)) {
          endingCounts.set(ep.label, (endingCounts.get(ep.label) ?? 0) + 1);
        }
      }

      for (const h of HABIT_DETECTORS) {
        if (h.testVoice && h.testVoice(seg)) {
          const entry = habitMap.get(h.id)!;
          entry.count += 1;
          if (entry.examples.length < 3 && !entry.examples.includes(seg)) {
            entry.examples.push(seg);
          }
        }
      }

      sampleCandidates.push({
        text: seg,
        createdAt: item.createdAt ?? null,
        threadTitle: item.threadTitle ?? null,
      });
    }
  }

  const entries: Array<[DominantSpeechRegister, number]> = [
    ["casual_banmal", registerCounts.casualBanmal],
    ["polite_haeyo", registerCounts.politeHaeyo],
    ["formal_hapsipsio", registerCounts.formalHapsipsio],
    ["concise_directive", registerCounts.conciseDirective],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  const top = entries[0]!;
  const second = entries[1]!;
  const dominantRegister: DominantSpeechRegister =
    analyzedVoiceSegmentCount === 0
      ? "mixed"
      : second[1] > 0 && top[1] / Math.max(1, analyzedVoiceSegmentCount) < 0.45
        ? "mixed"
        : top[0];

  const frequentEndings = [...endingCounts.entries()]
    .map(([ending, count]) => ({ ending, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const habitObservations: SpeechHabitObservation[] = [...habitMap.entries()]
    .filter(([, v]) => v.count > 0)
    .map(([id, v]) => ({
      id,
      label: v.label,
      count: v.count,
      examples: v.examples,
    }))
    .sort((a, b) => b.count - a.count);

  const seenSample = new Set<string>();
  const representativeSamples: Array<{
    text: string;
    createdAt: string | null;
    threadTitle: string | null;
  }> = [];
  for (let i = sampleCandidates.length - 1; i >= 0 && representativeSamples.length < 12; i -= 1) {
    const cand = sampleCandidates[i]!;
    const norm = cand.text.toLowerCase();
    if (cand.text.length < 5 || seenSample.has(norm)) continue;
    seenSample.add(norm);
    representativeSamples.push(cand);
  }

  return {
    totalUserMessages: utterances.filter((u) => (u.text?.trim().length ?? 0) > 0).length,
    analyzedVoiceSegmentCount,
    avgVoiceChars:
      analyzedVoiceSegmentCount > 0 ? Math.round(totalVoiceChars / analyzedVoiceSegmentCount) : 0,
    dominantRegister,
    registerCounts,
    arrowChainMessageCount,
    parentheticalAsideCount,
    habitObservations,
    frequentEndings,
    representativeSamples,
  };
}

const REGISTER_LABELS_KO: Record<DominantSpeechRegister, string> = {
  casual_banmal: "편한 구어·반말 지시형 (`~해줘`, `~해봐라`, `~인디`, `~말이야`)",
  polite_haeyo: "친근한 해요체 (`~해요`, `~세요`, `~까요`)",
  formal_hapsipsio: "격식 합쇼체 (`~합니다`, `~바랍니다`)",
  concise_directive: "핵심 명사·단문 직결 지시형 (`~확정`, `~분석`, `->` 연결)",
  mixed: "구어 반말 지시 + 핵심 명사구 혼합형",
};

export function formatUserSpeechProfileMarkdown(
  profile: UserSpeechStyleProfile,
  options?: { readonly compact?: boolean },
): string {
  if (profile.totalUserMessages === 0) {
    return options?.compact
      ? "아직 수집된 사용자 발화 표본이 없습니다."
      : "# 사용자 발화·말투 프로파일\n\n아직 수집된 사용자 발화가 없습니다.\n";
  }

  if (options?.compact) {
    const habits = profile.habitObservations
      .slice(0, 3)
      .map((h) => `${h.label}(${h.count}회)`)
      .join(", ");
    const endings = profile.frequentEndings
      .slice(0, 4)
      .map((e) => `${e.ending}(${e.count})`)
      .join(", ");
    const samples = profile.representativeSamples
      .slice(0, 3)
      .map((s) => `- "${s.text.slice(0, 140)}"`)
      .join("\n");
    return [
      `- 주 화법: ${REGISTER_LABELS_KO[profile.dominantRegister]} (발화 ${profile.totalUserMessages}건, 평균 ${profile.avgVoiceChars}자)`,
      ...(habits ? [`- 화법 습관: ${habits}`] : []),
      ...(endings ? [`- 자주 쓰는 어미: ${endings}`] : []),
      ...(samples ? [`- 최근 실제 말투 원문:\n${samples}`] : []),
    ].join("\n");
  }

  const lines: string[] = [
    "# 사용자 발화·말투 프로파일 (User Speech & Phrasing Profile)",
    "",
    "> AI 작성·조사 보고서와 완전히 분리하여 **오직 사용자의 실제 입력 발화**에서만 추출한 말투·어미·지시 습관 기록입니다.",
    "",
    "## 1. 화법 요약",
    `- 총 사용자 메시지: ${profile.totalUserMessages}건 (추출된 순수 육성 구간 ${profile.analyzedVoiceSegmentCount}건, 평균 ${profile.avgVoiceChars}자)`,
    `- 주된 화법 기조: **${REGISTER_LABELS_KO[profile.dominantRegister]}**`,
    `- 어미 분포: 구어·반말 ${profile.registerCounts.casualBanmal}건 · 간결 명사/단문 지시 ${profile.registerCounts.conciseDirective}건 · 해요체 ${profile.registerCounts.politeHaeyo}건 · 합쇼체 ${profile.registerCounts.formalHapsipsio}건`,
    `- 화살표(\`->\`) 맥락 연결 사용: ${profile.arrowChainMessageCount}건 · 괄호 속 의도 부연: ${profile.parentheticalAsideCount}건`,
  ];

  if (profile.habitObservations.length > 0) {
    lines.push("", "## 2. 자주 나타나는 말투·화법 습관");
    for (const h of profile.habitObservations) {
      const ex = h.examples[0] ? ` — 예: *"${h.examples[0].slice(0, 120)}"*` : "";
      lines.push(`- **${h.label}** (${h.count}회)${ex}`);
    }
  }

  if (profile.frequentEndings.length > 0) {
    lines.push("", "## 3. 빈출 종결어미 패턴");
    for (const e of profile.frequentEndings) {
      lines.push(`- ${e.ending}: ${e.count}회`);
    }
  }

  if (profile.representativeSamples.length > 0) {
    lines.push("", "## 4. 최근 실제 말투 원문 샘플 (가공 없음)");
    for (const s of profile.representativeSamples) {
      const meta = [s.createdAt?.slice(0, 19).replace("T", " "), s.threadTitle]
        .filter(Boolean)
        .join(" · ");
      lines.push(`- ${meta ? `[${meta}] ` : ""}${s.text}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
