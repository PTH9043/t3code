import { describe, expect, it } from "vite-plus/test";
import { isRecoverableUserInputRequestId } from "./orchestration.ts";

describe("recoverable question requests", () => {
  it("allows both asynchronous and EXAONE text questions to be cancelled while idle", () => {
    expect(isRecoverableUserInputRequestId("async:question")).toBe(true);
    expect(isRecoverableUserInputRequestId("text-question:turn")).toBe(true);
    expect(isRecoverableUserInputRequestId("native-question")).toBe(false);
    expect(isRecoverableUserInputRequestId(undefined)).toBe(false);
  });
});
