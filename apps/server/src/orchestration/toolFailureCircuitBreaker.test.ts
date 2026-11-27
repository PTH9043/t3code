import { describe, expect, it } from "vite-plus/test";
import { ToolFailureCircuitBreaker } from "./toolFailureCircuitBreaker.ts";

describe("ToolFailureCircuitBreaker", () => {
  it("trips on 3 consecutive identical normalized failures and resets on success or new signature", () => {
    const breaker = new ToolFailureCircuitBreaker(3);

    const s1 = breaker.recordFailure({
      threadId: "t1",
      toolName: "vitest",
      errorText: "2026-11-26T10:00:01Z AssertionError: expected 401 to be 200 in 12ms",
    });
    expect(s1.tripped).toBe(false);
    expect(s1.streak).toBe(1);

    const s2 = breaker.recordFailure({
      threadId: "t1",
      toolName: "vitest",
      errorText: "2026-11-26T10:00:05Z AssertionError: expected 401 to be 200 in 45ms",
    });
    expect(s2.tripped).toBe(false);
    expect(s2.streak).toBe(2);
    expect(s2.signature).toBe(s1.signature);

    const s3 = breaker.recordFailure({
      threadId: "t1",
      toolName: "vitest",
      errorText: "2026-11-26T10:00:09Z AssertionError: expected 401 to be 200 in 18ms",
    });
    expect(s3.tripped).toBe(true);
    expect(s3.streak).toBe(3);
    expect(s3.directive).toContain("[T3-CIRCUIT-BREAKER");

    // Different error resets streak to 1.
    const diff = breaker.recordFailure({
      threadId: "t1",
      toolName: "vitest",
      errorText: "SyntaxError: Unexpected token }",
    });
    expect(diff.tripped).toBe(false);
    expect(diff.streak).toBe(1);

    // Success clears thread state.
    breaker.recordSuccess("t1");
    const afterSuccess = breaker.recordFailure({
      threadId: "t1",
      toolName: "vitest",
      errorText: "SyntaxError: Unexpected token }",
    });
    expect(afterSuccess.streak).toBe(1);
  });
});
