import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decodeNotificationPayload } from "./shared.ts";

const OlderItemNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  item: Schema.Struct({
    type: Schema.Literal("agentMessage"),
    id: Schema.String,
    text: Schema.String,
  }),
});
const base = {
  threadId: "native-thread",
  turnId: "native-turn",
  item: { type: "agentMessage", id: "native-question", text: "Question text" },
};

it.effect("preserves native async questions through an older generated notification schema", () =>
  Effect.gen(function* () {
    const raw = {
      ...base,
      item: {
        ...base.item,
        delivery: "async",
        questions: [{ title: "Which project?" }, { title: "Which mode?", options: ["A", "B"] }],
      },
    };
    expect(yield* decodeNotificationPayload("item/completed", OlderItemNotification, raw)).toEqual(
      raw,
    );
  }),
);
it.effect("keeps ordinary messages and discards malformed question additions", () =>
  Effect.gen(function* () {
    expect(yield* decodeNotificationPayload("item/completed", OlderItemNotification, base)).toEqual(
      base,
    );
    expect(
      yield* decodeNotificationPayload("item/completed", OlderItemNotification, {
        ...base,
        item: { ...base.item, delivery: "async", questions: [{ title: "Bad", options: [42] }] },
      }),
    ).toEqual(base);
  }),
);
