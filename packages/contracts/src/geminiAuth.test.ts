import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { GeminiAuthCompleteInput } from "./geminiAuth.ts";

const decodeCompleteInput = Schema.decodeUnknownSync(GeminiAuthCompleteInput);

describe("GeminiAuthCompleteInput", () => {
  it("accepts a single-line Google authorization code", () => {
    expect(decodeCompleteInput({ sessionId: "session-1", code: "4/0AbCdEf" })).toEqual({
      sessionId: "session-1",
      code: "4/0AbCdEf",
    });
  });

  it.each(["code\rnext", "code\nnext", "code\u0000next"])(
    "rejects control characters in an authorization code",
    (code) => {
      expect(() => decodeCompleteInput({ sessionId: "session-1", code })).toThrow();
    },
  );

  it("rejects an unreasonably long authorization code", () => {
    expect(() => decodeCompleteInput({ sessionId: "session-1", code: "a".repeat(4097) })).toThrow();
  });
});
