import {
  isCustomResponseStyle,
  resolveResponseStyle,
  type ThreadResponseStyle,
} from "@t3tools/contracts";

const presetVariant = {
  default: "standard",
  concise: "compact-brief",
  detailed: "deep-analysis",
  friendly: "warm-conversational",
  professional: "executive-command",
} as const satisfies Record<ThreadResponseStyle["preset"], string>;

export type ResponseStyleUiVariant = (typeof presetVariant)[ThreadResponseStyle["preset"]];
/** Where the resolved style came from; `resolveResponseStyle` itself does not say. */
export type ResponseStyleScope = "global" | "thread";
export type ResolvedResponseStyle = ReturnType<typeof resolveResponseStyle>;

export interface ResponseStyleUiProfile {
  readonly variant: ResponseStyleUiVariant;
  readonly scopeLabel: "전역 스타일" | "이 방 전용" | "미설정";
  readonly personaBadge: string | undefined;
  readonly hasStructuredSections: boolean;
  readonly defaultCollapseToolGroups: boolean;
}

const REPORT_HEADING = /^##\s*\[보고\]\s*$/;
const ADVICE_HEADING = /^##\s*\[비서실장의 조언\]\s*$/;
const REPORT_REQUEST = /##\s*\[보고\]/;
const STRUCTURE_REQUEST = /##\s*\[(?:보고|비서실장의 조언)\]/;
const EXECUTIVE_PERSONA = "비서실장";

const personaBadges = {
  standard: undefined,
  "compact-brief": "간결 브리핑",
  "deep-analysis": "상세 기술 분석",
  "warm-conversational": "친근한 대화",
} satisfies Record<Exclude<ResponseStyleUiVariant, "executive-command">, string | undefined>;

/**
 * The one place chat, turn viewer and mobile ask how a response style should look.
 * `scope` is ignored while the style asks for nothing (null, or default preset with no text).
 */
export function deriveResponseStyleUiProfile(
  resolved: ResolvedResponseStyle,
  scope: ResponseStyleScope,
): ResponseStyleUiProfile {
  const style = resolved.style;
  if (!style || !isCustomResponseStyle(style)) {
    return {
      variant: "standard",
      scopeLabel: "미설정",
      personaBadge: undefined,
      hasStructuredSections: false,
      defaultCollapseToolGroups: false,
    };
  }
  const text = [style.tone, style.length, style.explanation, style.instructions].join("\n");
  const persona = text.includes(EXECUTIVE_PERSONA);
  // A preset this build does not know (older client, newer server) renders as standard.
  const preset = Object.hasOwn(presetVariant, style.preset)
    ? presetVariant[style.preset]
    : "standard";
  const variant = persona || REPORT_REQUEST.test(text) ? "executive-command" : preset;
  return {
    variant,
    scopeLabel: scope === "thread" ? "이 방 전용" : "전역 스타일",
    personaBadge:
      variant !== "executive-command"
        ? personaBadges[variant]
        : !persona
          ? "전문 보고"
          : style.preset === "professional"
            ? "최고 비서실장 · 전문"
            : "최고 비서실장",
    hasStructuredSections: STRUCTURE_REQUEST.test(text),
    defaultCollapseToolGroups: variant === "compact-brief",
  };
}

/** Resolves a thread's style from settings and derives its profile, scope included. */
export function resolveResponseStyleUiProfile(
  settings: Parameters<typeof resolveResponseStyle>[0],
  threadId?: string | null,
) {
  const room = threadId ? settings.threadResponseStyles?.[threadId] : undefined;
  return deriveResponseStyleUiProfile(
    resolveResponseStyle(settings, threadId),
    isCustomResponseStyle(room) ? "thread" : "global",
  );
}

const composerPlaceholders: Record<ResponseStyleUiVariant, string | undefined> = {
  standard: undefined,
  "compact-brief": "핵심만 빠르게 확인할 질문을 입력하세요…",
  "deep-analysis": "심층 분석·설계·원인 규명이 필요한 과제를 입력하세요…",
  "warm-conversational": "편하게 물어보세요. 무엇이든 함께 살펴볼게요…",
  "executive-command": "최고 비서실장에게 분석·코드 검증·투자 판단을 지시하세요…",
};

/** `undefined` means the composer keeps its own placeholder. */
export function responseStyleComposerPlaceholder(variant: ResponseStyleUiVariant) {
  return composerPlaceholders[variant];
}

/** Lines with their offsets; `fenced` covers a code fence's delimiters and body. */
function scanLines(text: string) {
  const lines = [];
  let fence: string | undefined;
  for (let start = 0; ; ) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const content = text.slice(start, end);
    const run = /^\s*(`{3,}(?!.*`)|~{3,})/.exec(content)?.[1];
    const fenced = fence !== undefined || run !== undefined;
    if (fence === undefined) fence = run;
    else if (
      run !== undefined &&
      run[0] === fence[0] &&
      run.length >= fence.length &&
      /^\s*[`~]+\s*$/.test(content)
    ) {
      fence = undefined;
    }
    lines.push({ start, end, content, terminated: newline !== -1, fenced });
    if (newline === -1) return lines;
    start = newline + 1;
  }
}

/**
 * Splits an executive-style answer into its report and advice. Safe to call on every
 * streaming update: a heading counts only once its line is finished, so a section never
 * moves after it appears. Text from the next level-2 heading on is returned as `trailing`
 * so nothing is dropped. Render the parts; copy from the original text.
 */
const TRAILING_QUESTION_CARD_BLOCK =
  /(?:\r?\n){1,3}(?:[ \t]*(?:아래[ \t]+)?(?:질문[ \t]+)?카드에서[ \t]+(?:(?:방향|항목|옵션|방식)을[ \t]+)?선택해[ \t]*주(?:세요|십시오)\.?[ \t]*(?:\r?\n){1,3})?(?:(?:```|~~~)(?:json|question)?[ \t]*\r?\n[ \t]*\{[ \t]*"questions"[ \t]*:[\s\S]*?\}(?:\r?\n[ \t]*(?:```|~~~)[A-Za-z0-9._-]{0,16})?|\{[ \t]*"questions"[ \t]*:[\s\S]*\})[ \t]*$/iu;

function stripTrailingQuestionCardJson(text: string): string {
  const match = TRAILING_QUESTION_CARD_BLOCK.exec(text);
  if (!match) return text;
  const candidate = match[0];
  const jsonStart = candidate.indexOf("{");
  const jsonEnd = candidate.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) return text;
  try {
    const parsed = JSON.parse(candidate.slice(jsonStart, jsonEnd + 1)) as {
      questions?: unknown;
    };
    if (!Array.isArray(parsed?.questions) || parsed.questions.length === 0) return text;
  } catch {
    return text;
  }
  return text.slice(0, match.index).trimEnd();
}

export function splitStructuredStyleSections(text: string) {
  const lines = scanLines(text);
  const first = lines.find((line) => line.content.trim() !== "");
  const reportHeading = first?.terminated && REPORT_HEADING.test(first.content) ? first : undefined;
  const adviceHeading = lines.find(
    (line) => !line.fenced && line.terminated && ADVICE_HEADING.test(line.content),
  );
  const next =
    adviceHeading &&
    lines.find(
      (line) =>
        line.start > adviceHeading.start && !line.fenced && /^##(?:[ \t]+\S|\[)/.test(line.content),
    );
  const reportEnd = adviceHeading?.start ?? text.length;
  const rawAdvice = adviceHeading
    ? text.slice(adviceHeading.end + 1, next?.start ?? text.length).trim()
    : undefined;
  return {
    report: reportHeading
      ? text.slice(0, reportHeading.start) + text.slice(reportHeading.end + 1, reportEnd)
      : text.slice(0, reportEnd),
    advice: rawAdvice !== undefined ? stripTrailingQuestionCardJson(rawAdvice) : undefined,
    hasReportHeading: reportHeading !== undefined,
    trailing: next ? text.slice(next.start) : undefined,
  };
}

// Pairs rather than object keys: the formatter unquotes keys, and a label such as
// `오류·반증` should not end up as a bare identifier.
const FACT_STATUS_BADGES = [
  ["확인 완료", "success"],
  ["합리적 추정", "info"],
  ["검증 필요", "warning"],
  ["미확인", "muted"],
  ["오류·반증", "danger"],
  ["잠재력", "warning"],
  ["현재 역량", "info"],
  ["검증된 성과", "success"],
] as const;

export type FactStatusBadgeLabel = (typeof FACT_STATUS_BADGES)[number][0];
export type FactStatusBadgeTone = (typeof FACT_STATUS_BADGES)[number][1];

const FACT_STATUS_BADGE = new RegExp(
  `\\[(${FACT_STATUS_BADGES.map(([label]) => label).join("|")})\\]`,
  "g",
);

/** Same-length copy with fenced blocks and inline code spans blanked, so offsets still apply. */
function blankCode(text: string) {
  return scanLines(text)
    .map((line) =>
      line.fenced
        ? " ".repeat(line.content.length)
        : line.content.replace(/(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g, (span) =>
            " ".repeat(span.length),
          ),
    )
    .join("\n");
}

/**
 * Bracket status tags in reading order, with offsets into `text` (brackets included).
 * Only the exact bracket form outside code counts.
 */
export function findFactStatusBadges(text: string) {
  const badges = [];
  for (const match of blankCode(text).matchAll(FACT_STATUS_BADGE)) {
    const badge = FACT_STATUS_BADGES.find(([label]) => label === match[1]);
    if (!badge) continue;
    badges.push({
      start: match.index,
      end: match.index + match[0].length,
      label: badge[0],
      tone: badge[1],
    });
  }
  return badges;
}

export function countFactStatusBadges(text: string) {
  const counts = Object.fromEntries(FACT_STATUS_BADGES.map(([label]) => [label, 0])) as Record<
    FactStatusBadgeLabel,
    number
  >;
  const badges = findFactStatusBadges(text);
  for (const badge of badges) counts[badge.label] += 1;
  return { counts, total: badges.length };
}

const ZERO_WIDTH_JOINER = 0x200d;

/** Hermes has no Intl.Segmenter, so this keeps a code point with the base it modifies. */
function attachesToPrevious(point: string) {
  const code = point.codePointAt(0) ?? 0;
  // Joiner, skin tones, then combining marks (variation selectors and keycaps included).
  return (
    code === ZERO_WIDTH_JOINER || (code >= 0x1f3fb && code <= 0x1f3ff) || /^[\p{M}]$/u.test(point)
  );
}

function graphemes(text: string) {
  if (typeof Intl.Segmenter === "function") {
    return Array.from(
      new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(text),
      (part) => part.segment,
    );
  }
  const clusters: string[] = [];
  for (const point of text) {
    const previous = clusters.at(-1);
    if (
      previous !== undefined &&
      (previous.charCodeAt(previous.length - 1) === ZERO_WIDTH_JOINER || attachesToPrevious(point))
    ) {
      clusters[clusters.length - 1] = previous + point;
    } else {
      clusters.push(point);
    }
  }
  return clusters;
}

function stripLineMarkdown(line: string) {
  return line
    .replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?/, "")
    .replace(/\*+(?=\S)|(?<=\S)\*+|~~|`+/g, "")
    .replace(/(?<![\p{L}\p{N}])_+(?=\S)|(?<=\S)_+(?![\p{L}\p{N}])/gu, "")
    .trim();
}

/**
 * One-line teaser for a collapsed advice card: the first sentence of the first line with
 * words in it, at most `maxChars` graphemes including the ellipsis.
 */
export function summarizeAdviceLine(advice: string | undefined, maxChars = 120) {
  const line = advice
    ?.split("\n")
    .map(stripLineMarkdown)
    .find((candidate) => /[\p{L}\p{N}]/u.test(candidate));
  if (line === undefined) return undefined;
  const sentence = /^.*?[.!?。](?=\s|$)/.exec(line)?.[0] ?? line;
  const limit = Math.max(1, Math.floor(maxChars));
  if (sentence.length <= limit) return sentence;
  const parts = graphemes(sentence);
  return parts.length <= limit
    ? sentence
    : `${parts
        .slice(0, limit - 1)
        .join("")
        .trimEnd()}…`;
}
