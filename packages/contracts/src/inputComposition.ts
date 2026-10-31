import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";

/** T3-visible text before the adapter call. Native CLI history/tools are unobserved. */
export const InputCompositionReport = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literal("prepared"),
  path: Schema.Literals(["chat", "automation", "orchestra"]),
  promptChars: NonNegativeInt,
  contextRevision: Schema.String,
  parts: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["task", "handoff", "rag-assembly", "assignment", "separators"]),
      chars: NonNegativeInt,
    }),
  ),
  attachmentCount: NonNegativeInt,
  estimatedTokens: Schema.Null,
  nativeContext: Schema.Literal("unknown"),
});
export type InputCompositionReport = typeof InputCompositionReport.Type;
