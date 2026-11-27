import { expect, it } from "@effect/vitest";
import { ApprovalRequestId, TurnId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { makeCodexAsyncQuestions, type CodexAsyncQuestion } from "./CodexAsyncQuestions.ts";

class AnswerFailure extends Schema.TaggedErrorClass<AnswerFailure>()("AnswerFailure", {
  known: Schema.Boolean,
}) {}
const item = {
  type: "agentMessage",
  id: "native-question-item",
  delivery: "async",
  questions: [{ title: "Which project?" }],
};
const originalTurn = TurnId.make("native-original-turn");
const nextTurn = TurnId.make("native-answer-turn");
const answers = { question_1: { answers: ["Project A"] } };

it.effect("delivers question images with the async answer", () =>
  Effect.gen(function* () {
    let request: CodexAsyncQuestion | undefined;
    let received: ReadonlyArray<{ readonly type: "image"; readonly url: string }> | undefined;
    const bridge = yield* makeCodexAsyncQuestions({
      requested: (question) =>
        Effect.sync(() => {
          request = question;
        }),
      resolved: () => Effect.void,
      closed: () => Effect.void,
      sendAnswer: (_text, images) =>
        Effect.sync(() => {
          received = images;
          return nextTurn;
        }),
      rejectedBeforeDelivery: () => false,
    });
    yield* bridge.register(item, originalTurn);
    const images = [{ type: "image" as const, url: "data:image/png;base64,YQ==" }];
    expect(yield* bridge.answer(request!.requestId, answers, images)).toBe(true);
    expect(received).toEqual(images);
  }),
);

it.effect("does not treat a changed image as an identical accepted answer", () =>
  Effect.gen(function* () {
    let deliveries = 0;
    let resolutions = 0;
    const bridge = yield* makeCodexAsyncQuestions({
      requested: () => Effect.void,
      resolved: () =>
        Effect.sync(() => {
          resolutions++;
        }),
      closed: () => Effect.void,
      sendAnswer: () =>
        Effect.sync(() => {
          deliveries++;
          return nextTurn;
        }),
      rejectedBeforeDelivery: () => false,
    });
    yield* bridge.register(item, originalTurn);
    const requestId = ApprovalRequestId.make("async:native-question-item");
    const first = [{ type: "image" as const, url: "data:image/png;base64,YQ==" }];
    const changed = [{ type: "image" as const, url: "data:image/png;base64,Yg==" }];
    expect(yield* bridge.answer(requestId, answers, first)).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(bridge.answer(requestId, answers, changed)))).toBe(
      true,
    );
    expect(Exit.isFailure(yield* Effect.exit(bridge.answer(requestId, answers)))).toBe(true);
    expect(deliveries).toBe(1);
    expect(resolutions).toBe(1);
    expect(yield* bridge.answer(requestId, answers, first)).toBe(true);
    expect(deliveries).toBe(1);
    expect(resolutions).toBe(2);
  }),
);

it.effect(
  "does not treat differently structured answers with the same rendered text as identical",
  () =>
    Effect.gen(function* () {
      let deliveries = 0;
      const bridge = yield* makeCodexAsyncQuestions({
        requested: () => Effect.void,
        resolved: () => Effect.void,
        closed: () => Effect.void,
        sendAnswer: () =>
          Effect.sync(() => {
            deliveries++;
            return nextTurn;
          }),
        rejectedBeforeDelivery: () => false,
      });
      yield* bridge.register(item, originalTurn);
      const requestId = ApprovalRequestId.make("async:native-question-item");
      expect(yield* bridge.answer(requestId, { question_1: { answers: ["A", "B"] } })).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(bridge.answer(requestId, { question_1: { answers: ["A\nB"] } })),
        ),
      ).toBe(true);
      expect(deliveries).toBe(1);
    }),
);

it.effect("renders native free-text metadata and sends an identical answer once", () =>
  Effect.gen(function* () {
    const opened: CodexAsyncQuestion[] = [];
    const resolved: TurnId[] = [];
    const sent: string[] = [];
    const bridge = yield* makeCodexAsyncQuestions({
      requested: (question) =>
        Effect.sync(() => {
          opened.push(question);
        }),
      resolved: (_, __, turnId) =>
        Effect.sync(() => {
          resolved.push(turnId);
        }),
      closed: () => Effect.void,
      sendAnswer: (text) =>
        Effect.sync(() => {
          sent.push(text);
          return nextTurn;
        }),
      rejectedBeforeDelivery: () => false,
    });
    yield* bridge.register(item, originalTurn);
    yield* bridge.register(item, originalTurn);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.questions).toEqual([
      {
        id: "question_1",
        header: "Question",
        question: "Which project?",
        isOther: true,
        isSecret: false,
        options: [],
      },
    ]);
    const requestId = opened[0]!.requestId;
    expect(yield* bridge.answer(requestId, answers)).toBe(true);
    expect(yield* bridge.answer(requestId, answers)).toBe(true);
    expect(sent).toEqual([
      "User response to Codex question native-question-item:\nWhich project?\nProject A",
    ]);
    expect(resolved).toEqual([nextTurn, nextTurn]);
    expect(
      Exit.isFailure(
        yield* Effect.exit(bridge.answer(requestId, { question_1: { answers: ["Changed"] } })),
      ),
    ).toBe(true);
    expect(sent).toHaveLength(1);
  }),
);

it.effect("keeps an unanswered card open when its session closes", () =>
  Effect.gen(function* () {
    let closed = 0;
    const bridge = yield* makeCodexAsyncQuestions({
      requested: () => Effect.void,
      resolved: () => Effect.void,
      closed: () =>
        Effect.sync(() => {
          closed++;
        }),
      sendAnswer: () => Effect.succeed(nextTurn),
      rejectedBeforeDelivery: () => false,
    });
    yield* bridge.register(item, originalTurn);
    yield* bridge.close;
    expect(closed).toBe(0);
  }),
);

it.effect("ignores late question notifications after the session closes", () =>
  Effect.gen(function* () {
    let requested = 0;
    const bridge = yield* makeCodexAsyncQuestions({
      requested: () =>
        Effect.sync(() => {
          requested++;
        }),
      resolved: () => Effect.void,
      closed: () => Effect.void,
      sendAnswer: () => Effect.succeed(nextTurn),
      rejectedBeforeDelivery: () => false,
    });
    yield* bridge.close;
    yield* bridge.register(item, originalTurn);
    expect(requested).toBe(0);
    expect(yield* bridge.has(ApprovalRequestId.make("async:native-question-item"))).toBe(false);
  }),
);

it.effect("does not resend or falsely close an answer with unknown delivery", () =>
  Effect.gen(function* () {
    const opened: CodexAsyncQuestion[] = [];
    let sent = 0;
    let closed = 0;
    const bridge = yield* makeCodexAsyncQuestions({
      requested: (question) =>
        Effect.sync(() => {
          opened.push(question);
        }),
      resolved: () => Effect.die("An unknown answer must not be marked resolved."),
      closed: () =>
        Effect.sync(() => {
          closed++;
        }),
      sendAnswer: () =>
        Effect.sync(() => {
          sent++;
        }).pipe(Effect.andThen(Effect.fail(new AnswerFailure({ known: false })))),
      rejectedBeforeDelivery: (error) => error.known,
    });
    yield* bridge.register(item, originalTurn);
    const requestId = opened[0]!.requestId;
    expect(Exit.isFailure(yield* Effect.exit(bridge.answer(requestId, answers)))).toBe(true);
    const retry = yield* bridge.answer(requestId, answers).pipe(Effect.flip);
    expect(retry._tag).toBe("CodexAsyncAnswerDeliveryError");
    expect(sent).toBe(1);
    yield* bridge.close;
    expect(closed).toBe(0);
  }),
);

it.effect("does not restore a closed session when an in-flight answer succeeds late", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let closed = 0;
    let resolved = 0;
    const bridge = yield* makeCodexAsyncQuestions({
      requested: () => Effect.void,
      resolved: () =>
        Effect.sync(() => {
          resolved++;
        }),
      closed: () =>
        Effect.sync(() => {
          closed++;
        }),
      sendAnswer: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return nextTurn;
        }),
      rejectedBeforeDelivery: () => false,
    });
    yield* bridge.register(item, originalTurn);
    const requestId = ApprovalRequestId.make("async:native-question-item");
    const delivery = yield* bridge.answer(requestId, answers).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* bridge.close;
    expect(closed).toBe(0);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(delivery)).toBe(true);
    expect(resolved).toBe(1);
    expect(yield* bridge.has(requestId)).toBe(false);
    expect(yield* bridge.answer(requestId, answers)).toBe(false);
  }),
);

it.effect("does not restore a closed session after a late pre-delivery rejection", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const bridge = yield* makeCodexAsyncQuestions({
      requested: () => Effect.void,
      resolved: () => Effect.void,
      closed: () => Effect.void,
      sendAnswer: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return yield* new AnswerFailure({ known: true });
        }),
      rejectedBeforeDelivery: (error) => error.known,
    });
    yield* bridge.register(item, originalTurn);
    const requestId = ApprovalRequestId.make("async:native-question-item");
    const delivery = yield* bridge.answer(requestId, answers).pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(entered);
    yield* bridge.close;
    yield* Deferred.succeed(release, undefined);
    expect((yield* Fiber.join(delivery))._tag).toBe("Failure");
    expect(yield* bridge.has(requestId)).toBe(false);
  }),
);

it.effect("allows retry after a confirmed rejection before delivery", () =>
  Effect.gen(function* () {
    const opened: CodexAsyncQuestion[] = [];
    let attempts = 0;
    const bridge = yield* makeCodexAsyncQuestions({
      requested: (question) =>
        Effect.sync(() => {
          opened.push(question);
        }),
      resolved: () => Effect.void,
      closed: () => Effect.void,
      sendAnswer: () =>
        Effect.suspend(() =>
          ++attempts === 1
            ? Effect.fail(new AnswerFailure({ known: true }))
            : Effect.succeed(nextTurn),
        ),
      rejectedBeforeDelivery: (error) => error.known,
    });
    yield* bridge.register(item, originalTurn);
    const requestId = opened[0]!.requestId;
    expect(Exit.isFailure(yield* Effect.exit(bridge.answer(requestId, answers)))).toBe(true);
    expect(yield* bridge.answer(requestId, answers)).toBe(true);
    expect(attempts).toBe(2);
  }),
);

it.effect("claims a concurrent answer before provider submission", () =>
  Effect.gen(function* () {
    const opened: CodexAsyncQuestion[] = [];
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let attempts = 0;
    const bridge = yield* makeCodexAsyncQuestions({
      requested: (question) =>
        Effect.sync(() => {
          opened.push(question);
        }),
      resolved: () => Effect.void,
      closed: () => Effect.void,
      sendAnswer: () =>
        Effect.gen(function* () {
          attempts++;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return nextTurn;
        }),
      rejectedBeforeDelivery: () => false,
    });
    yield* bridge.register(item, originalTurn);
    const requestId = opened[0]!.requestId;
    const first = yield* bridge.answer(requestId, answers).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    expect(Exit.isFailure(yield* Effect.exit(bridge.answer(requestId, answers)))).toBe(true);
    expect(attempts).toBe(1);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(first)).toBe(true);
  }),
);

it.effect("cancels only the selected unanswered question without sending an answer", () =>
  Effect.gen(function* () {
    const opened: CodexAsyncQuestion[] = [];
    const closed: string[] = [];
    const sent: string[] = [];
    const bridge = yield* makeCodexAsyncQuestions({
      requested: (question) =>
        Effect.sync(() => {
          opened.push(question);
        }),
      resolved: () => Effect.void,
      closed: (question) =>
        Effect.sync(() => {
          closed.push(question.requestId);
        }),
      sendAnswer: (text) =>
        Effect.sync(() => {
          sent.push(text);
          return nextTurn;
        }),
      rejectedBeforeDelivery: () => false,
    });
    yield* bridge.register(item, originalTurn);
    yield* bridge.register({ ...item, id: "other-question" }, originalTurn);
    const first = opened[0]!.requestId;
    const second = opened[1]!.requestId;

    expect(yield* bridge.cancel(first)).toBe(true);
    expect(yield* bridge.cancel(first)).toBe(false);
    expect(closed).toEqual([first]);
    expect(yield* bridge.answer(first, answers)).toBe(false);
    expect(yield* bridge.answer(second, answers)).toBe(true);
    expect(sent).toHaveLength(1);
  }),
);

it.effect("does not submit an answer while cancellation is being recorded", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let sent = 0;
    const bridge = yield* makeCodexAsyncQuestions({
      requested: () => Effect.void,
      resolved: () => Effect.void,
      closed: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }),
      sendAnswer: () =>
        Effect.sync(() => {
          sent++;
          return nextTurn;
        }),
      rejectedBeforeDelivery: () => false,
    });
    yield* bridge.register(item, originalTurn);
    const requestId = ApprovalRequestId.make("async:native-question-item");
    const cancellation = yield* bridge.cancel(requestId).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    expect(Exit.isFailure(yield* Effect.exit(bridge.answer(requestId, answers)))).toBe(true);
    expect(sent).toBe(0);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(cancellation)).toBe(true);
  }),
);
