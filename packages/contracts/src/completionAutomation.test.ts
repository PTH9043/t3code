import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_COMPLETION_AUTOMATION,
  DEFAULT_COMPLETION_COMMAND_TIMEOUT_SECONDS,
  DEFAULT_COMPLETION_MAX_AUTO_FIX_ATTEMPTS,
  WorkspaceCompletionAutomation,
  resolveCompletionAutomationLimits,
} from "./completionAutomation.ts";

const decode = Schema.decodeUnknownSync(WorkspaceCompletionAutomation);

describe("completionAutomation contracts", () => {
  it("decodes legacy DB records without maxAutoFixAttempts or commandTimeoutSeconds", () => {
    const legacyRecord = {
      enabled: true,
      formatCommands: ["npm.cmd run format"],
      verificationCommands: ["npm.cmd test"],
      saveResult: true,
      followUpTask: null,
    };

    const decoded = decode(legacyRecord);
    expect(decoded.enabled).toBe(true);
    expect(decoded.maxAutoFixAttempts).toBeUndefined();
    expect(decoded.commandTimeoutSeconds).toBeUndefined();
    expect(resolveCompletionAutomationLimits(decoded)).toEqual({
      maxAutoFixAttempts: DEFAULT_COMPLETION_MAX_AUTO_FIX_ATTEMPTS,
      commandTimeoutSeconds: DEFAULT_COMPLETION_COMMAND_TIMEOUT_SECONDS,
    });
  });

  it("accepts valid persisted maxAutoFixAttempts (1..5) and commandTimeoutSeconds (10..1800)", () => {
    const minValid = decode({
      ...DEFAULT_COMPLETION_AUTOMATION,
      maxAutoFixAttempts: 1,
      commandTimeoutSeconds: 10,
    });
    expect(resolveCompletionAutomationLimits(minValid)).toEqual({
      maxAutoFixAttempts: 1,
      commandTimeoutSeconds: 10,
    });

    const maxValid = decode({
      ...DEFAULT_COMPLETION_AUTOMATION,
      maxAutoFixAttempts: 5,
      commandTimeoutSeconds: 1800,
    });
    expect(resolveCompletionAutomationLimits(maxValid)).toEqual({
      maxAutoFixAttempts: 5,
      commandTimeoutSeconds: 1800,
    });
  });

  it("rejects out-of-range or non-integer limits", () => {
    for (const invalid of [
      { maxAutoFixAttempts: 0 },
      { maxAutoFixAttempts: 6 },
      { maxAutoFixAttempts: 2.5 },
      { commandTimeoutSeconds: 9 },
      { commandTimeoutSeconds: 1801 },
      { commandTimeoutSeconds: 120.5 },
    ]) {
      expect(() =>
        decode({
          ...DEFAULT_COMPLETION_AUTOMATION,
          ...invalid,
        }),
      ).toThrow();
    }
  });

  it("clamps defensive limit inputs via resolveCompletionAutomationLimits", () => {
    expect(resolveCompletionAutomationLimits(null)).toEqual({
      maxAutoFixAttempts: 3,
      commandTimeoutSeconds: 120,
    });
    expect(
      resolveCompletionAutomationLimits({
        maxAutoFixAttempts: 99,
        commandTimeoutSeconds: 5,
      }),
    ).toEqual({
      maxAutoFixAttempts: 5,
      commandTimeoutSeconds: 10,
    });
  });
});
