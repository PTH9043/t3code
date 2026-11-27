import { createAndRecordClassifierTelemetry, type UserInputQuestion } from "@t3tools/contracts";
import { parseExaoneTextQuestionJson, parseExaoneTextQuestions } from "./exaoneTextQuestions.ts";

/**
 * Providers whose model can ask through the text of its answer. Their native
 * question, when one also arrives, replaces or defers the text card.
 */
export function asksThroughText(provider: string | null | undefined): boolean {
  return provider === "opencode" || provider === "gemini";
}

/**
 * Whether a completed turn is read for a text question: every Antigravity
 * model, and the EXAONE models served through OpenCode.
 */
export function isTextQuestionTurn(
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean {
  return (
    provider === "gemini" || (provider === "opencode" && model?.startsWith("t3_exaone/") === true)
  );
}

/** Activity summary of the card opened from a text question. */
export function textQuestionSummary(provider: string | null | undefined): string {
  return provider === "gemini" ? "Antigravity 질문" : "EXAONE 질문";
}

const LIST_ITEM = /^[ \t]{0,3}(?:[-*•][ \t]+)?\[(\d{1,2})\][ \t]+(\S.*)$/u;
const QUESTION_END =
  /(?:[?？]|(?:선택해|골라|알려|결정해|정해|지정해|답해|답변해)[ \t]?주(?:세요|십시오)[.:]?)$/u;
const EXAMPLE_LEAD = /(?:예시|샘플|스키마|example|schema|sample|quoted|예를 들|e\.g\.)/iu;
const EXAMPLE_PREFIX = /^(?:예|보기|예시|샘플|example|sample)[ \t]*[:：)]/iu;
const OPTION_SPLIT = /^(.+?)(?::[ \t]+|：[ \t]*|[ \t]+[—–][ \t]+)(\S.*)$/u;
const LIST_QUESTION_HEADER = "선택";

/**
 * Read a question the model wrote as prose at the very end of a finished
 * answer: one question line directly followed by options marked `[1]`, `[2]`…
 * in order, with nothing after them. Anything looser is left as text.
 */
export function parseListTextQuestions(text: string): ReadonlyArray<UserInputQuestion> | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 100_000) return null;
  const lines = trimmed.split(/\r?\n/);
  const items: string[] = [];
  let index = lines.length - 1;
  let total = 0;
  for (; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const match = LIST_ITEM.exec(line);
    if (!match) break;
    const number = Number(match[1]);
    if (items.length === 0) total = number;
    if (number !== total - items.length) return null;
    items.unshift(match[2]!.replaceAll("**", "").trim());
    if (number === 1) {
      index -= 1;
      break;
    }
  }
  if (total < 2 || total > 8 || items.length !== total) return null;
  while (index >= 0 && !lines[index]!.trim()) index -= 1;
  if (index < 0) return null;
  const questionLine = lines[index]!.trim();
  if (/^[>|]/u.test(questionLine) || LIST_ITEM.test(questionLine)) return null;
  const question = questionLine
    .replace(/^#{1,6}[ \t]+/u, "")
    .replaceAll("**", "")
    .trim();
  if (!question || question.length > 4000 || !QUESTION_END.test(question)) return null;
  if (EXAMPLE_PREFIX.test(question)) return null;
  const before = lines.slice(0, index);
  if (before.filter((line) => /^[ \t]*(?:```|~~~)/u.test(line)).length % 2 === 1) return null;
  const lead = before.findLast((line) => line.trim());
  if (lead !== undefined && EXAMPLE_LEAD.test(lead)) return null;
  if (items.every((item) => /^https?:\/\//iu.test(item))) return null;
  const options = items.map((item) => {
    const split = OPTION_SPLIT.exec(item);
    return split
      ? { label: split[1]!.trim(), description: split[2]!.trim() }
      : { label: item, description: "" };
  });
  if (
    options.some(
      (option) => !option.label || option.label.length > 1000 || option.description.length > 4000,
    ) ||
    new Set(options.map((option) => option.label)).size !== options.length
  )
    return null;
  return [{ id: "question-1", header: LIST_QUESTION_HEADER, question, options }];
}

/** The sentence Antigravity is told to write right before its question block. */
export const ANTIGRAVITY_QUESTION_INTRO = "아래 질문 카드에서 선택해 주세요.";

const ANTIGRAVITY_INTRO_LINE =
  /^[ \t]*(?:아래[ \t]+)?(?:질문[ \t]+)?카드에서[ \t]+(?:(?:방향|항목|옵션|방식)을[ \t]+)?선택해[ \t]*주(?:세요|십시오)\.?[ \t]*$/gmu;
const TRAILING_CONTRACT_HEADING_SECTION =
  /\r?\n{1,3}##[ \t]+\[[^\r\n\]]+\][ \t]*\r?\n[^\r\n]+(?:\r?\n[^\r\n]+){0,5}\s*$/u;
const TRAILING_BARE_QUESTION_JSON = /\r?\n[ \t]*(\{[ \t]*"questions"[ \t]*:[\s\S]*\})\s*$/u;
const BARE_JSON_CONTEXT_HINT = /(?:카드|질문|question|선택해)/iu;
const BARE_JSON_EXCLUSION_HINT = /(?:예시|샘플|스키마|example|schema|sample|quoted)/iu;

function findLastAntigravityIntroMatch(
  text: string,
): { readonly index: number; readonly end: number } | null {
  const exactIndex = text.lastIndexOf(ANTIGRAVITY_QUESTION_INTRO);
  let best: { readonly index: number; readonly end: number } | null =
    exactIndex >= 0
      ? { index: exactIndex, end: exactIndex + ANTIGRAVITY_QUESTION_INTRO.length }
      : null;

  ANTIGRAVITY_INTRO_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANTIGRAVITY_INTRO_LINE.exec(text)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (!best || start >= best.index) {
      best = { index: start, end };
    }
  }
  return best;
}

function parseAntigravityStructuredCandidate(
  candidate: string,
): ReadonlyArray<UserInputQuestion> | null {
  const direct = parseExaoneTextQuestions(candidate);
  if (direct) return direct;

  const intro = findLastAntigravityIntroMatch(candidate);
  if (intro) {
    const fromIntro = candidate.slice(intro.index);
    const fencedFromIntro = parseExaoneTextQuestions(fromIntro);
    if (fencedFromIntro) return fencedFromIntro;

    // Accept bare JSON (or an unclosed/corrupted-closing-fence json block) directly following
    // the Antigravity intro sentence, as long as there is no real trailing prose after the JSON.
    const afterIntro = candidate
      .slice(intro.end)
      .replace(/^(?:[ \t]*\r?\n|[ \t]*(?:[-*_][ \t]*){3,}\r?\n)+/u, "")
      .trim();
    const unwrappedAfterIntro = afterIntro
      .replace(/^(?:```|~~~)(?:json|question)?[ \t]*(?:\r?\n)?/iu, "")
      .replace(/(?:\r?\n)?[ \t]*(?:```|~~~)[A-Za-z0-9._-]{0,16}[ \t]*$/u, "")
      .trim();
    if (unwrappedAfterIntro.startsWith("{") && unwrappedAfterIntro.endsWith("}")) {
      const bareAfterIntro = parseExaoneTextQuestionJson(unwrappedAfterIntro);
      if (bareAfterIntro) return bareAfterIntro;
    }
  }

  // Fallback for Antigravity emitting a bare trailing `{"questions":[...]}` JSON object
  // right after a question paragraph without code fences.
  const bareMatch = TRAILING_BARE_QUESTION_JSON.exec(candidate);
  if (bareMatch?.[1]) {
    const prefix = candidate.slice(0, bareMatch.index);
    const context = prefix.slice(-300);
    if (BARE_JSON_CONTEXT_HINT.test(context) && !BARE_JSON_EXCLUSION_HINT.test(context)) {
      return parseExaoneTextQuestionJson(bareMatch[1]);
    }
  }

  return null;
}

/**
 * Parse only a complete structured JSON question batch (fenced or Antigravity-introduced bare JSON),
 * never a prose `[1]/[2]` list. Safe to call even when a turn was interrupted after finalizing
 * a complete question block.
 */
export function parseStructuredTextQuestions(
  provider: string | null | undefined,
  text: string,
): ReadonlyArray<UserInputQuestion> | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 100_000) return null;
  if (provider !== "gemini") {
    return parseExaoneTextQuestions(trimmed);
  }
  const direct = parseAntigravityStructuredCandidate(trimmed);
  if (direct) return direct;

  // Tolerate a single global-contract closing heading section (e.g. `## [비서실장의 조언]\n...`)
  // placed after the closing question block, while still rejecting normal trailing prose.
  const withoutTrailingContractSection = trimmed
    .replace(TRAILING_CONTRACT_HEADING_SECTION, "")
    .trimEnd();
  if (withoutTrailingContractSection !== trimmed) {
    return parseAntigravityStructuredCandidate(withoutTrailingContractSection);
  }
  return null;
}

/**
 * The questions a finished answer asks. The structured JSON batch is read for every
 * text-question provider. For Antigravity the batch is also read from its own
 * introduction sentence onward (with or without code fences, and tolerating a trailing
 * closing contract heading), so words in the answer above that sentence do not hide a
 * real question; the prose list is read only when there is no batch.
 */
export function parseTextQuestions(
  provider: string | null | undefined,
  text: string,
): ReadonlyArray<UserInputQuestion> | null {
  const structured = parseStructuredTextQuestions(provider, text);
  if (structured) {
    createAndRecordClassifierTelemetry({
      classifier: "text_question_parser",
      decision: "structured_json",
      confidence: 0.98,
      fallbackUsed: false,
      ruleId: `text_q.structured.${provider ?? "default"}`,
      signalSource: "structured",
    });
    return structured;
  }
  if (provider !== "gemini") {
    createAndRecordClassifierTelemetry({
      classifier: "text_question_parser",
      decision: "none",
      confidence: 0.95,
      fallbackUsed: false,
      ruleId: "text_q.no_structured_match",
      signalSource: "structured",
    });
    return null;
  }
  const listQuestions = parseListTextQuestions(text);
  createAndRecordClassifierTelemetry({
    classifier: "text_question_parser",
    decision: listQuestions ? "prose_list" : "none",
    confidence: listQuestions ? 0.72 : 0.9,
    fallbackUsed: Boolean(listQuestions),
    ruleId: listQuestions ? "text_q.gemini_prose_list_fallback" : "text_q.no_match",
    signalSource: listQuestions ? "fallback" : "heuristic",
  });
  return listQuestions;
}

/**
 * Tells Antigravity how to ask so that `parseTextQuestions` opens a card. The
 * wording stays clear of the words the batch parser treats as a demonstration.
 */
export const ANTIGRAVITY_QUESTION_INSTRUCTIONS = [
  "<t3_question_card>사용자의 결정이 꼭 필요할 때만 질문하세요. 질문할 때는 답변의 맨 끝을 아래 두 부분으로 끝내세요. 마무리 구역(## [비서실장의 조언] 등)이 있다면 반드시 이 안내 문장과 json 코드 블록 앞에 먼저 쓰세요. 먼저 다음 한 문장을 그대로 쓰고, 바로 이어서 json 코드 블록 하나에 아래 형태의 JSON만 적습니다. 코드 블록 뒤에는 아무것도 쓰지 마세요.",
  "",
  ANTIGRAVITY_QUESTION_INTRO,
  "",
  "```json",
  '{"questions":[{"header":"짧은 제목","question":"질문 문장","options":[{"label":"선택지 이름","description":"한 줄 설명"}]}]}',
  "```",
  "",
  'header·question·label·description은 모두 문자열로 채우고, 여러 개를 고를 수 있는 질문에만 "multiple":true를 더하세요. 질문은 꼭 필요한 것만 하고, 권장하는 선택지를 첫 번째에 두어 label 끝에 "(권장)"을 붙이세요. 같은 선택지를 본문에 목록으로 다시 쓰지 마세요. 이 블록은 화면에 답변 카드로 표시되고 사용자의 선택은 다음 메시지로 전달됩니다. 실제로 답을 받아야 할 때만 쓰고, 형식을 설명하거나 보여 주려는 목적으로는 쓰지 마세요.</t3_question_card>',
].join("\n");

/** Question-card instructions for the driver answering a user's turn, if it needs any. */
export function textQuestionInstructions(driver: string | null | undefined): string | undefined {
  return driver === "gemini" ? ANTIGRAVITY_QUESTION_INSTRUCTIONS : undefined;
}
