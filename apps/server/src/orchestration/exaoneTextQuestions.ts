import { Schema } from "effect";
import { createAndRecordClassifierTelemetry, UserInputQuestion } from "@t3tools/contracts";

export const EXAONE_QUESTION_ALREADY_SETTLED = "EXAONE text question is already settled";

const TextQuestionBatch = Schema.Struct({
  questions: Schema.Array(
    Schema.Struct({
      header: Schema.String,
      question: Schema.String,
      options: Schema.Array(
        Schema.Struct({
          label: Schema.String,
          description: Schema.optional(Schema.String),
        }),
      ),
      multiple: Schema.optional(Schema.Boolean),
    }),
  ),
});
const decodeBatch = Schema.decodeUnknownOption(TextQuestionBatch);

/** Parse and validate a raw JSON string containing a complete question batch. */
export function parseExaoneTextQuestionJson(
  source: string,
): ReadonlyArray<UserInputQuestion> | null {
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > 100_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const decoded = decodeBatch(parsed);
  if (decoded._tag === "None") return null;
  const questions = decoded.value.questions;
  if (questions.length === 0 || questions.length > 12) return null;
  if (
    questions.some(
      (q) =>
        !q.header.trim() ||
        !q.question.trim() ||
        q.header.length > 200 ||
        q.question.length > 4000 ||
        q.options.length > 12 ||
        q.options.some(
          (o) => !o.label.trim() || o.label.length > 1000 || (o.description ?? "").length > 4000,
        ),
    )
  )
    return null;
  return questions.map((q, index) => ({
    id: "question-" + (index + 1),
    header: q.header,
    question: q.question,
    options: q.options.map((o) => ({ label: o.label, description: o.description ?? "" })),
    ...(q.multiple ? { multiSelect: true } : {}),
  }));
}

/** Accept only a complete question batch, never a partial JSON stream. */
export function parseExaoneTextQuestions(text: string): ReadonlyArray<UserInputQuestion> | null {
  const trimmed = text.trim();
  if (trimmed.length > 100_000) {
    createAndRecordClassifierTelemetry({
      classifier: "exaone_text_question_parser",
      decision: "none",
      confidence: 1,
      fallbackUsed: false,
      ruleId: "exaone_q.oversize",
      signalSource: "structured",
    });
    return null;
  }
  // Tolerate a stray tokenizer suffix glued directly to the closing fence (e.g. "```Ble"
  // observed from gemini-4-neon), while still rejecting real trailing prose on a new line.
  const fenced =
    /(?:```|~~~)(?:json|question)?[ \t]*\r?\n((?:(?!(?:```|~~~))[\s\S])*)\r?\n(?:```|~~~)[A-Za-z0-9._-]{0,16}[ \t]*$/iu.exec(
      trimmed,
    );
  const prefix = fenced ? trimmed.slice(0, fenced.index) : "";
  if (fenced) {
    const context = prefix.slice(-300);
    if (!/(?:카드|질문|question)/iu.test(context)) {
      createAndRecordClassifierTelemetry({
        classifier: "exaone_text_question_parser",
        decision: "none",
        confidence: 0.9,
        fallbackUsed: false,
        ruleId: "exaone_q.missing_context_hint",
        signalSource: "heuristic",
      });
      return null;
    }
    if (/(?:예시|샘플|스키마|example|schema|sample|quoted)/iu.test(context)) {
      createAndRecordClassifierTelemetry({
        classifier: "exaone_text_question_parser",
        decision: "rejected_demo_context",
        confidence: 0.92,
        fallbackUsed: false,
        ruleId: "exaone_q.demo_context_excluded",
        signalSource: "heuristic",
      });
      return null;
    }
  }
  const source = fenced ? fenced[1] : trimmed;
  if (!source) {
    createAndRecordClassifierTelemetry({
      classifier: "exaone_text_question_parser",
      decision: "none",
      confidence: 1,
      fallbackUsed: false,
      ruleId: "exaone_q.empty",
      signalSource: "structured",
    });
    return null;
  }
  const parsed = parseExaoneTextQuestionJson(source);
  createAndRecordClassifierTelemetry({
    classifier: "exaone_text_question_parser",
    decision: parsed ? (fenced ? "fenced_json" : "raw_json") : "none",
    confidence: parsed ? 0.98 : 0.95,
    fallbackUsed: false,
    ruleId: parsed
      ? fenced
        ? "exaone_q.fenced_valid"
        : "exaone_q.raw_valid"
      : "exaone_q.invalid_json",
    signalSource: "structured",
  });
  return parsed;
}

const decodeRequestedQuestions = Schema.decodeUnknownOption(
  Schema.Struct({ requestId: Schema.String, questions: Schema.Array(UserInputQuestion) }),
);

/** Compare visible question content, ignoring provider-specific question IDs. */
export function matchesExaoneTextQuestions(
  payload: unknown,
  requestId: string,
  native: ReadonlyArray<UserInputQuestion>,
): boolean {
  const decoded = decodeRequestedQuestions(payload);
  if (decoded._tag === "None" || decoded.value.requestId !== requestId) return false;
  const questions = decoded.value.questions;
  return (
    questions.length > 0 &&
    questions.length === native.length &&
    questions.every((q, index) => {
      const other = native[index];
      return (
        other !== undefined &&
        q.question.trim() === other.question.trim() &&
        Boolean(q.multiSelect) === Boolean(other.multiSelect) &&
        q.options.length === other.options.length &&
        q.options.every((option, i) => option.label.trim() === other.options[i]?.label.trim())
      );
    })
  );
}
