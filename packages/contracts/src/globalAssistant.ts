import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BUILTIN_CHIEF_OF_STAFF_ID, PersonaTraitGenome } from "./livingPersona.ts";
import { ModelSelection } from "./orchestration.ts";
import type { ThreadResponseStyle } from "./threadResponseStyle.ts";

export const GlobalAssistantPreset = Schema.Literals([
  "default",
  "concise",
  "detailed",
  "friendly",
  "professional",
]);
export type GlobalAssistantPreset = typeof GlobalAssistantPreset.Type;

export const OutputSectionPosition = Schema.Literals(["start", "body", "end"]);
export type OutputSectionPosition = typeof OutputSectionPosition.Type;

export const OutputSectionRule = Schema.Struct({
  id: TrimmedNonEmptyString,
  heading: TrimmedNonEmptyString,
  position: OutputSectionPosition,
  required: Schema.Boolean,
  constraint: Schema.String,
  maxLines: Schema.optionalKey(PositiveInt),
});
export type OutputSectionRule = typeof OutputSectionRule.Type;

export const StyleExample = Schema.Struct({
  situation: Schema.String,
  goodExample: Schema.String,
  badExample: Schema.optionalKey(Schema.String),
});
export type StyleExample = typeof StyleExample.Type;

export const DomainPlaybook = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  keywords: Schema.Array(Schema.String),
  alwaysInclude: Schema.Boolean,
  rules: Schema.String,
});
export type DomainPlaybook = typeof DomainPlaybook.Type;

export const GlobalAssistantEnforcement = Schema.Struct({
  suppressDefaultNaturalWriting: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  injectRecencyReminder: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  propagateCorePrinciplesToSubordinates: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  verifyOutputContract: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  autoRepairOnMissingContract: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
});
export type GlobalAssistantEnforcement = typeof GlobalAssistantEnforcement.Type;

export const DEFAULT_GLOBAL_ASSISTANT_ENFORCEMENT: GlobalAssistantEnforcement = {
  suppressDefaultNaturalWriting: true,
  injectRecencyReminder: true,
  propagateCorePrinciplesToSubordinates: true,
  verifyOutputContract: true,
  autoRepairOnMissingContract: false,
};

export const DEFAULT_PERSONA_TRAIT_GENOME: PersonaTraitGenome = {
  ocean: {
    openness: 0.35,
    conscientiousness: 0.88,
    extraversion: 0.2,
    agreeableness: 0.55,
    neuroticism: -0.3,
  },
  koreanPragmatics: {
    firmness: 0.85,
    warmth: 0.78,
    wit: 0.25,
    intimacy: 0.68,
  },
};

export const SavedPersonaProfile = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  personaName: Schema.String,
  preset: GlobalAssistantPreset.pipe(Schema.withDecodingDefault(Effect.succeed("professional"))),
  defaultModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  voiceAndTone: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  lengthPolicy: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  explanationPolicy: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  styleExamples: Schema.Array(StyleExample).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  traitGenome: PersonaTraitGenome.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PERSONA_TRAIT_GENOME)),
  ),
});
export type SavedPersonaProfile = typeof SavedPersonaProfile.Type;

export const GlobalAssistantConfig = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  defaultModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  personaName: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  preset: GlobalAssistantPreset.pipe(Schema.withDecodingDefault(Effect.succeed("default"))),
  voiceAndTone: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  styleExamples: Schema.Array(StyleExample).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  corePrinciples: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  lengthPolicy: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  explanationPolicy: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  outputSections: Schema.Array(OutputSectionRule).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  domainPlaybooks: Schema.Array(DomainPlaybook).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  extraInstructions: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  enforcement: GlobalAssistantEnforcement.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_GLOBAL_ASSISTANT_ENFORCEMENT)),
  ),
  characterOverridesVoice: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  activePersonaId: Schema.optionalKey(Schema.String),
  threadPersonaOverrides: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  enableLivingAffectEngine: Schema.optionalKey(Schema.Boolean),
  dynamicAnchorTokenBudget: Schema.optionalKey(PositiveInt),
  traitGenome: Schema.optionalKey(PersonaTraitGenome),
  personaProfiles: Schema.optionalKey(Schema.Record(Schema.String, SavedPersonaProfile)),
});
export type GlobalAssistantConfig = typeof GlobalAssistantConfig.Type;

export function resolveActivePersonaId(
  config: Pick<GlobalAssistantConfig, "activePersonaId"> | null | undefined,
): string {
  const raw = config?.activePersonaId?.trim();
  return raw && raw.length > 0 ? raw : BUILTIN_CHIEF_OF_STAFF_ID;
}

export const DEFAULT_GLOBAL_ASSISTANT_CONFIG: GlobalAssistantConfig = {
  enabled: false,
  defaultModelSelection: null,
  personaName: "",
  preset: "default",
  voiceAndTone: "",
  styleExamples: [],
  corePrinciples: [],
  lengthPolicy: "",
  explanationPolicy: "",
  outputSections: [],
  domainPlaybooks: [],
  extraInstructions: "",
  enforcement: DEFAULT_GLOBAL_ASSISTANT_ENFORCEMENT,
  characterOverridesVoice: false,
};

export function isGlobalAssistantConfigured(
  config: GlobalAssistantConfig | null | undefined,
): boolean {
  if (!config || !config.enabled) return false;
  return (
    config.preset !== "default" ||
    config.personaName.trim().length > 0 ||
    config.voiceAndTone.trim().length > 0 ||
    config.lengthPolicy.trim().length > 0 ||
    config.explanationPolicy.trim().length > 0 ||
    config.extraInstructions.trim().length > 0 ||
    config.corePrinciples.some((item) => item.trim().length > 0) ||
    config.outputSections.length > 0 ||
    config.styleExamples.some((item) => item.goodExample.trim().length > 0) ||
    config.domainPlaybooks.some((item) => item.rules.trim().length > 0)
  );
}

/**
 * Extracts structured output section rules (e.g. `## [보고]`, `## [비서실장의 조언]`)
 * from legacy free-text `globalResponseStyle.instructions` without dropping any text.
 */
function parseLegacyOutputSections(instructions: string): OutputSectionRule[] {
  const sections: OutputSectionRule[] = [];
  const headingMatches = [...instructions.matchAll(/^-?\s*(#{1,4}\s+\[[^\]]+\])\s*:\s*(.+)$/gm)];
  for (let index = 0; index < headingMatches.length; index += 1) {
    const match = headingMatches[index]!;
    const heading = match[1]!.trim();
    const constraint = match[2]!.trim();
    const isEnd =
      /마지막|끝|맨\s*아래/u.test(constraint) ||
      (headingMatches.length > 1 && index === headingMatches.length - 1);
    const isStart = index === 0 && !isEnd;
    const isSingleLine = /단\s*한\s*줄|한\s*줄로만|1줄/u.test(constraint);
    sections.push({
      id: `section-${index + 1}`,
      heading,
      position: isEnd ? "end" : isStart ? "start" : "body",
      required: true,
      constraint,
      ...(isSingleLine ? { maxLines: 1 } : {}),
    });
  }
  return sections;
}

/**
 * Splits legacy bracketed domain lines (e.g. `- A(투자·자산): ...`, `- B(SW·시스템): ...`)
 * into keyword-matchable `DomainPlaybook` entries so unrelated domain rules don't dilute every turn.
 */
function parseLegacyDomainPlaybooks(instructions: string): {
  readonly playbooks: DomainPlaybook[];
  readonly remainingText: string;
} {
  const lines = instructions.split(/\r?\n/);
  const playbooks: DomainPlaybook[] = [];
  const remaining: string[] = [];
  const domainLineRegex = /^-\s*([A-Z])\(([^)]+)\)\s*:\s*(.+)$/;

  for (const line of lines) {
    const match = line.trim().match(domainLineRegex);
    if (match) {
      const code = match[1]!;
      const titleLabel = match[2]!.trim();
      const body = match[3]!.trim();
      const keywords = [
        ...titleLabel.split(/[·,/()\s]+/),
        ...body
          .replace(/[()]/g, " ")
          .split(/[·,|/:\s]+/)
          .filter((token) => token.length >= 2 && !/^[A-Z]-\d+$/i.test(token))
          .slice(0, 18),
      ]
        .map((k) => k.trim())
        .filter((k) => k.length >= 2);
      playbooks.push({
        id: `domain-${code.toLowerCase()}`,
        title: `${code}(${titleLabel})`,
        keywords: [...new Set(keywords)],
        alwaysInclude: false,
        rules: body,
      });
    } else {
      remaining.push(line);
    }
  }

  if (playbooks.length > 0) {
    // Strip empty section header left behind once domain lines were extracted to Tier B playbooks.
    const cleanedRemaining = remaining
      .filter((line) => !/^\[산하\s*\d+개\s*전문\s*본부[^\]]*\]$/u.test(line.trim()))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return {
      playbooks,
      remainingText: cleanedRemaining,
    };
  }

  return {
    playbooks,
    remainingText: remaining
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}

/**
 * Deterministically converts a legacy `ThreadResponseStyle` into the unified `GlobalAssistantConfig`
 * preserving 100% of user-authored rules while elevating output sections and domain playbooks.
 */
export function deriveGlobalAssistantFromLegacyResponseStyle(
  style: ThreadResponseStyle | null | undefined,
): GlobalAssistantConfig | null {
  if (!style) return null;
  const hasContent =
    style.preset !== "default" ||
    [style.tone, style.length, style.explanation, style.instructions].some(
      (value) => value.trim().length > 0,
    );
  if (!hasContent) return null;

  const outputSections = parseLegacyOutputSections(style.instructions);
  const { playbooks, remainingText } = parseLegacyDomainPlaybooks(style.instructions);

  // Extract numbered core principles if present under `[절대 운영 원칙]`
  const corePrinciples: string[] = [];
  const principleSection = remainingText.match(/\[절대\s*운영\s*원칙\]([\s\S]*?)(?:\n\[|$)/u)?.[1];
  if (principleSection) {
    for (const line of principleSection.split(/\r?\n/)) {
      const cleaned = line
        .trim()
        .replace(/^\d+\.\s*/, "")
        .trim();
      if (cleaned.length > 0) corePrinciples.push(cleaned);
    }
  }

  return {
    enabled: true,
    defaultModelSelection: null,
    personaName: "",
    preset: style.preset,
    voiceAndTone: style.tone.trim(),
    styleExamples: [],
    corePrinciples,
    lengthPolicy: style.length.trim(),
    explanationPolicy: style.explanation.trim(),
    outputSections,
    domainPlaybooks: playbooks,
    extraInstructions: remainingText,
    enforcement: DEFAULT_GLOBAL_ASSISTANT_ENFORCEMENT,
    characterOverridesVoice: false,
  };
}

/**
 * Single Source of Truth resolver: returns `globalAssistant` when configured, or
 * transparently upcasts legacy `globalResponseStyle`. Per-thread overrides are intentionally retired.
 */
export function resolveEffectiveGlobalAssistant(settings: {
  readonly globalAssistant?: GlobalAssistantConfig | null;
  readonly globalResponseStyle?: ThreadResponseStyle | null;
}): GlobalAssistantConfig | null {
  if (settings.globalAssistant !== undefined && settings.globalAssistant !== null) {
    return settings.globalAssistant;
  }
  return deriveGlobalAssistantFromLegacyResponseStyle(settings.globalResponseStyle);
}

/**
 * Projects `GlobalAssistantConfig` back to legacy `ThreadResponseStyle` for backward compatibility
 * with any older read path or persisted workflow snapshot.
 */
export function toLegacyResponseStyle(
  config: GlobalAssistantConfig | null | undefined,
): ThreadResponseStyle | null {
  if (!config || !isGlobalAssistantConfigured(config)) return null;
  const sectionsText = config.outputSections
    .map(
      (section) =>
        `- ${section.heading}: ${section.constraint}${section.maxLines ? ` (최대 ${section.maxLines}줄)` : ""}`,
    )
    .join("\n");
  const principlesText = config.corePrinciples.length
    ? `[핵심 원칙]\n${config.corePrinciples.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}`
    : "";
  const combinedInstructions = [
    principlesText,
    config.extraInstructions.trim(),
    sectionsText ? `[필수 출력 형식]\n${sectionsText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    preset: config.preset,
    tone: config.voiceAndTone,
    length: config.lengthPolicy,
    explanation: config.explanationPolicy,
    instructions: combinedInstructions,
  };
}

export interface OutputContractViolation {
  readonly sectionId: string;
  readonly heading: string;
  readonly reason: "missing-heading" | "empty-content" | "exceeds-max-lines" | "wrong-position";
  readonly message: string;
}

export interface OutputContractVerification {
  readonly checked: boolean;
  readonly passed: boolean;
  readonly violations: ReadonlyArray<OutputContractViolation>;
}

const NON_CONTRACT_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /^API\s*Error(?::|\s|$)/i,
  /^(?:Anthropic|OpenAI|Google|Gemini|Claude|Codex|Provider)?\s*안전장치가\s+이\s+요청을\s+(?:거절|차단)/u,
  /safeguards?\s+flagged\s+this\s+session/i,
  /^(?:Error|오류)\s*:\s*(?:API|Request|Provider|Rate\s*limit|Authentication|Quota|Safety)/i,
];

const HORIZONTAL_RULE_LINE = /^(?:[-*_][ \t]*){3,}$/;
const QUESTION_CARD_INTRO_LINE =
  /^(?:아래\s*)?(?:질문\s*카드에서\s*선택해\s*주(?:세요|십시오)\.?|질문\s*카드로\s*답변해\s*주(?:세요|십시오)\.?|Select\s+from\s+the\s+question\s+card\s+below\.?)$/iu;

function isNonContractErrorOrRefusal(trimmedText: string): boolean {
  return NON_CONTRACT_ERROR_PATTERNS.some((pattern) => pattern.test(trimmedText));
}

function isQuestionBatchJson(rawJson: string): boolean {
  const source = rawJson.trim();
  if (!source.startsWith("{") || !source.includes('"questions"')) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(source);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as { questions?: unknown }).questions) &&
      (parsed as { questions: ReadonlyArray<unknown> }).questions.length > 0
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Removes a trailing Antigravity / EXAONE text-question JSON card block (and any
 * immediately preceding intro sentence or horizontal divider) so JSON lines are
 * never miscounted as body lines of the final required section.
 */
function stripTrailingQuestionCardBlock(text: string): {
  readonly body: string;
  readonly hadQuestionCard: boolean;
} {
  let working = text.trim();
  let hadQuestionCard = false;

  const fencedMatch = /```(?:json|question)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/iu.exec(working);
  if (fencedMatch?.[1] !== undefined && isQuestionBatchJson(fencedMatch[1])) {
    working = working.slice(0, fencedMatch.index).trimEnd();
    hadQuestionCard = true;
  } else if (isQuestionBatchJson(working)) {
    working = "";
    hadQuestionCard = true;
  } else {
    const bareTrailingMatch = /\r?\n[ \t]*(\{[ \t]*"questions"[ \t]*:[\s\S]*\})\s*$/u.exec(working);
    if (bareTrailingMatch?.[1] !== undefined && isQuestionBatchJson(bareTrailingMatch[1])) {
      working = working.slice(0, bareTrailingMatch.index).trimEnd();
      hadQuestionCard = true;
    }
  }

  if (!hadQuestionCard) {
    return { body: working, hadQuestionCard: false };
  }

  // Strip trailing blank lines, horizontal rules, and standard question-card intro lines.
  const lines = working.split(/\r?\n/);
  while (lines.length > 0) {
    const last = lines[lines.length - 1]!.trim();
    if (
      last.length === 0 ||
      HORIZONTAL_RULE_LINE.test(last) ||
      QUESTION_CARD_INTRO_LINE.test(last)
    ) {
      lines.pop();
      continue;
    }
    break;
  }

  return {
    body: lines.join("\n").trim(),
    hadQuestionCard: true,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractHeadingLabel(normalizedHeading: string): string {
  const withoutHashes = normalizedHeading.replace(/^#{1,6}\s*/, "").trim();
  const withoutBold = withoutHashes.replace(/^\*{1,2}(.+?)\*{1,2}$/, "$1").trim();
  const withoutBrackets = withoutBold.replace(/^\[(.+)\]$/, "$1").trim();
  return withoutBrackets.replace(/\s+/g, " ");
}

function matchSectionHeadingLine(
  rawLine: string,
  normalizedHeading: string,
): { readonly matched: true; readonly inlineTail: string } | { readonly matched: false } {
  const trimmed = rawLine.trim();
  if (!trimmed) return { matched: false };

  // 1. Exact canonical prefix match (e.g. `## [비서실장의 조언]`).
  if (trimmed.startsWith(normalizedHeading)) {
    const inlineTail = trimmed
      .slice(normalizedHeading.length)
      .replace(/^[:\s\-–—]+/, "")
      .trim();
    return { matched: true, inlineTail };
  }

  // 2. Mild markdown variations: heading level (`###`), dropped brackets (`## 비서실장의 조언`),
  //    or bold heading (`**[비서실장의 조언]**` / `**비서실장의 조언**`).
  const label = extractHeadingLabel(normalizedHeading);
  if (!label) return { matched: false };
  const labelPattern = label
    .split(" ")
    .map((token) => escapeRegExp(token))
    .join("\\s+");

  const headingVariantRegex = new RegExp(
    `^(?:#{1,6}\\s+(?:\\*{1,2})?\\[?${labelPattern}\\]?(?:\\*{1,2})?|\\*{2}\\[?${labelPattern}\\]?\\*{2}|\\[${labelPattern}\\])(?:\\s*[:\\-–—]\\s*(.*)|\\s*)$`,
    "u",
  );
  const variantMatch = headingVariantRegex.exec(trimmed);
  if (variantMatch) {
    return {
      matched: true,
      inlineTail: (variantMatch[1] ?? "").trim(),
    };
  }

  return { matched: false };
}

function computeFencedLineFlags(lines: ReadonlyArray<string>): ReadonlyArray<boolean> {
  const flags: boolean[] = [];
  let activeFence: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (activeFence === undefined) {
      if (fenceMatch?.[1]) {
        activeFence = fenceMatch[1];
        flags.push(true);
      } else {
        flags.push(false);
      }
    } else {
      flags.push(true);
      if (
        fenceMatch?.[1] &&
        fenceMatch[1][0] === activeFence[0] &&
        fenceMatch[1].length >= activeFence.length &&
        /^[`~]+$/.test(trimmed)
      ) {
        activeFence = undefined;
      }
    }
  }
  return flags;
}

/**
 * 0ms deterministic compliance check against required `outputSections`.
 * Works on both server and web UI without any LLM call.
 */
export function verifyGlobalOutputContract(
  config: GlobalAssistantConfig | null | undefined,
  responseText: string,
): OutputContractVerification {
  if (
    !config ||
    !config.enabled ||
    !config.enforcement.verifyOutputContract ||
    config.outputSections.length === 0
  ) {
    return { checked: false, passed: true, violations: [] };
  }

  const trimmed = responseText.trim();
  if (!trimmed || isNonContractErrorOrRefusal(trimmed)) {
    return { checked: false, passed: true, violations: [] };
  }

  const requiredSections = config.outputSections.filter((section) => section.required);
  if (requiredSections.length === 0) {
    return { checked: false, passed: true, violations: [] };
  }

  const { body: strippedBody, hadQuestionCard } = stripTrailingQuestionCardBlock(trimmed);
  if (!strippedBody) {
    return { checked: false, passed: true, violations: [] };
  }

  const lines = strippedBody.split(/\r?\n/);
  const fencedFlags = computeFencedLineFlags(lines);

  // Short confirmation turns that consist solely of a brief prompt + text question card
  // (with no structured report headings at all) should not trigger false missing-contract warnings.
  if (hadQuestionCard) {
    const nonEmptyLines = lines.filter(
      (line, idx) =>
        !fencedFlags[idx] && line.trim().length > 0 && !HORIZONTAL_RULE_LINE.test(line.trim()),
    );
    const hasAnyRequiredHeading = requiredSections.some((section) =>
      lines.some(
        (line, idx) =>
          !fencedFlags[idx] && matchSectionHeadingLine(line, section.heading.trim()).matched,
      ),
    );
    if (!hasAnyRequiredHeading && nonEmptyLines.length <= 2) {
      return { checked: false, passed: true, violations: [] };
    }
  }

  const violations: OutputContractViolation[] = [];

  for (const section of requiredSections) {
    const normalizedHeading = section.heading.trim();
    let headingIndex = -1;
    let inlineTail = "";
    for (let i = 0; i < lines.length; i += 1) {
      if (fencedFlags[i]) continue;
      const match = matchSectionHeadingLine(lines[i]!, normalizedHeading);
      if (match.matched) {
        headingIndex = i;
        inlineTail = match.inlineTail;
        break;
      }
    }

    if (headingIndex < 0) {
      violations.push({
        sectionId: section.id,
        heading: normalizedHeading,
        reason: "missing-heading",
        message: `필수 섹션 "${normalizedHeading}"이(가) 응답에 누락되었습니다.`,
      });
      continue;
    }

    // Collect content lines belonging to this section until next markdown heading
    const bodyLines: string[] = inlineTail ? [inlineTail] : [];
    for (let i = headingIndex + 1; i < lines.length; i += 1) {
      const candidate = lines[i]!.trim();
      if (!fencedFlags[i] && /^#{1,4}\s+/.test(candidate)) break;
      if (candidate.length === 0) continue;
      if (!fencedFlags[i] && HORIZONTAL_RULE_LINE.test(candidate)) continue;
      bodyLines.push(candidate);
    }

    if (bodyLines.length === 0) {
      violations.push({
        sectionId: section.id,
        heading: normalizedHeading,
        reason: "empty-content",
        message: `필수 섹션 "${normalizedHeading}"의 내용이 비어 있습니다.`,
      });
    } else if (section.maxLines !== undefined && bodyLines.length > section.maxLines) {
      violations.push({
        sectionId: section.id,
        heading: normalizedHeading,
        reason: "exceeds-max-lines",
        message: `"${normalizedHeading}"은(는) 최대 ${section.maxLines}줄 제한이지만 ${bodyLines.length}줄로 작성되었습니다.`,
      });
    }

    if (section.position === "end") {
      // Ensure no other heading appears after this section (ignoring headings inside code fences)
      const laterHeading = lines
        .slice(headingIndex + 1)
        .some(
          (line, offset) =>
            !fencedFlags[headingIndex + 1 + offset] && /^#{1,4}\s+/.test(line.trim()),
        );
      if (laterHeading) {
        violations.push({
          sectionId: section.id,
          heading: normalizedHeading,
          reason: "wrong-position",
          message: `"${normalizedHeading}"은(는) 답변 맨 마지막에 위치해야 합니다.`,
        });
      }
    }
  }

  return {
    checked: true,
    passed: violations.length === 0,
    violations,
  };
}
