import { ApprovalRequestId, ProviderItemId, type TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

const NativeQuestion = Schema.Struct({
  type: Schema.Literal("agentMessage"),
  id: Schema.String,
  delivery: Schema.Literal("async"),
  questions: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      options: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
    }),
  ),
});
const decodeNativeQuestion = Schema.decodeUnknownOption(NativeQuestion);
export type CodexAsyncAnswers = Readonly<
  Record<string, { readonly answers: ReadonlyArray<string> }>
>;
export type CodexAsyncQuestion = {
  readonly requestId: ApprovalRequestId;
  readonly itemId: ProviderItemId;
  readonly turnId: TurnId;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly isOther: true;
    readonly isSecret: false;
    readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  }>;
};

export class CodexAsyncAnswerDeliveryError extends Schema.TaggedErrorClass<CodexAsyncAnswerDeliveryError>()(
  "CodexAsyncAnswerDeliveryError",
  { requestId: Schema.String },
) {
  override get message() {
    return "This question answer is already submitting, was accepted with different content, or has unknown delivery. Check the original turn before resending.";
  }
}

export const makeCodexAsyncQuestions = <E, E2>(callbacks: {
  readonly requested: (question: CodexAsyncQuestion) => Effect.Effect<void, E2>;
  readonly resolved: (
    question: CodexAsyncQuestion,
    answers: CodexAsyncAnswers,
    turnId: TurnId,
  ) => Effect.Effect<void, E2>;
  readonly closed: (question: CodexAsyncQuestion) => Effect.Effect<void, E2>;
  readonly sendAnswer: (
    text: string,
    images?: ReadonlyArray<{ readonly type: "image"; readonly url: string }>,
  ) => Effect.Effect<TurnId, E>;
  readonly rejectedBeforeDelivery: (error: E) => boolean;
}) =>
  Effect.gen(function* () {
    type Pending = {
      readonly question: CodexAsyncQuestion;
      readonly state: "pending" | "submitting" | "accepted" | "cancelling";
      readonly text?: string;
      readonly acceptedTurnId?: TurnId;
    };
    const pending = yield* Ref.make(new Map<ApprovalRequestId, Pending>());
    const register = Effect.fn("CodexAsyncQuestions.register")(function* (
      item: unknown,
      turnId: TurnId,
    ) {
      const parsed = decodeNativeQuestion(item);
      if (Option.isNone(parsed) || parsed.value.questions.length === 0) return;
      const native = parsed.value;
      const question: CodexAsyncQuestion = {
        requestId: ApprovalRequestId.make(`async:${native.id}`),
        itemId: ProviderItemId.make(native.id),
        turnId,
        questions: native.questions.map((entry, index) => ({
          id: `question_${index + 1}`,
          header: "Question",
          question: entry.title,
          isOther: true,
          isSecret: false,
          options: (entry.options ?? []).map((label) => ({ label, description: "" })),
        })),
      };
      const added = yield* Ref.modify(pending, (current) => {
        if (current.has(question.requestId)) return [false, current];
        return [true, new Map(current).set(question.requestId, { question, state: "pending" })];
      });
      if (added) yield* callbacks.requested(question);
    });
    const answer = Effect.fn("CodexAsyncQuestions.answer")(function* (
      requestId: ApprovalRequestId,
      answers: CodexAsyncAnswers,
      images?: ReadonlyArray<{ readonly type: "image"; readonly url: string }>,
    ) {
      const current = (yield* Ref.get(pending)).get(requestId);
      if (!current) return false;
      const text =
        `User response to Codex question ${current.question.itemId}:\n` +
        current.question.questions
          .map(
            (question) =>
              `${question.question}\n${(answers[question.id]?.answers ?? []).join("\n")}`,
          )
          .join("\n\n");
      if (current.state === "accepted" && current.text === text && current.acceptedTurnId) {
        yield* callbacks.resolved(current.question, answers, current.acceptedTurnId);
        return true;
      }
      const claimed = yield* Ref.modify(pending, (entries) => {
        const entry = entries.get(requestId);
        if (entry?.state !== "pending") return [false, entries];
        return [true, new Map(entries).set(requestId, { ...entry, state: "submitting", text })];
      });
      if (!claimed) return yield* new CodexAsyncAnswerDeliveryError({ requestId });
      const turnId = yield* callbacks.sendAnswer(text, images).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (callbacks.rejectedBeforeDelivery(error)) {
              yield* Ref.update(pending, (entries) =>
                new Map(entries).set(requestId, { question: current.question, state: "pending" }),
              );
            }
            return yield* Effect.fail(error);
          }),
        ),
      );
      yield* Ref.update(pending, (entries) =>
        new Map(entries).set(requestId, {
          question: current.question,
          state: "accepted",
          text,
          acceptedTurnId: turnId,
        }),
      );
      yield* callbacks.resolved(current.question, answers, turnId);
      return true;
    });
    const cancel = Effect.fn("CodexAsyncQuestions.cancel")(function* (
      requestId: ApprovalRequestId,
    ) {
      const entry = yield* Ref.modify(pending, (entries) => {
        const current = entries.get(requestId);
        if (!current || current.state !== "pending") return [undefined, entries];
        return [current, new Map(entries).set(requestId, { ...current, state: "cancelling" })];
      });
      if (!entry) return false;
      yield* callbacks.closed(entry.question).pipe(
        Effect.catch((error) =>
          Ref.update(pending, (entries) => {
            if (entries.get(requestId)?.state !== "cancelling") return entries;
            return new Map(entries).set(requestId, entry);
          }).pipe(Effect.andThen(Effect.fail(error))),
        ),
      );
      yield* Ref.update(pending, (entries) => {
        if (entries.get(requestId)?.state !== "cancelling") return entries;
        const next = new Map(entries);
        next.delete(requestId);
        return next;
      });
      return true;
    });
    const close = Effect.gen(function* () {
      const entries = yield* Ref.getAndSet(pending, new Map());
      yield* Effect.forEach(
        [...entries.values()].filter((entry) => entry.state !== "accepted"),
        (entry) => callbacks.closed(entry.question),
        { discard: true },
      );
    });
    const has = (requestId: ApprovalRequestId) =>
      Ref.get(pending).pipe(Effect.map((entries) => entries.has(requestId)));
    return { register, answer, cancel, has, close };
  });
