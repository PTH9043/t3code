import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const AsyncQuestionMetadata = Schema.Struct({
  item: Schema.Struct({
    type: Schema.Literal("agentMessage"),
    delivery: Schema.Literal("async"),
    questions: Schema.Array(
      Schema.Struct({
        title: Schema.String,
        options: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
      }),
    ),
  }),
});
const decodeMetadata = Schema.decodeUnknownOption(AsyncQuestionMetadata);
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

// Preserve this validated addition until the generated protocol includes native async questions.
export function preserveAsyncQuestionMetadata<A>(method: string, raw: unknown, decoded: A): A {
  if (method !== "item/started" && method !== "item/completed") return decoded;
  const metadata = decodeMetadata(raw);
  if (
    Option.isNone(metadata) ||
    !isRecord(decoded) ||
    !isRecord(decoded.item) ||
    decoded.item.type !== "agentMessage"
  )
    return decoded;
  return { ...decoded, item: { ...decoded.item, ...metadata.value.item } } as A;
}
