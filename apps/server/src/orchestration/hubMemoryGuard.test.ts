// @effect-diagnostics nodeBuiltinImport:off - Exercise the real Windows and POSIX path semantics.
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "node:path";

import {
  HUB_LIMIT_ENV,
  HUB_MANIFEST_ENV,
  hubEnvironment,
  windowsJobGuardCandidates,
} from "./hubMemoryGuard.ts";

const posixPath = NodePath.posix;

describe("hubEnvironment", () => {
  it("handles Windows paths with spaces and rejects cross-drive and UNC paths", () => {
    const result = hubEnvironment(
      {
        hubMemory: {
          commitLimitMb: null,
          concurrencyGroup: null,
          concurrencySlots: null,
          sharedDatasets: [
            { name: "LOCAL", relativeSource: "data/한글 파일.arrow" },
            { name: "DRIVE", relativeSource: "E:/other.arrow" },
            { name: "UNC", relativeSource: "\\\\server\\share\\other.arrow" },
            { name: "PARENT", relativeSource: "../other.arrow" },
          ],
        },
      },
      "D:\\My Project",
      NodePath.win32,
    );
    expect(result.rejectedDatasets).toEqual(["DRIVE", "UNC", "PARENT"]);
    expect(result.env.T3_HUB_DATASET_LOCAL).toBe("D:\\My Project\\data\\한글 파일.arrow");
  });

  it("publishes nothing for a program without a budget", () => {
    const result = hubEnvironment(
      {
        hubMemory: {
          commitLimitMb: null,
          concurrencyGroup: null,
          concurrencySlots: null,
          sharedDatasets: [],
        },
      },
      "/project",
      posixPath,
    );
    expect(result).toEqual({ env: {}, rejectedDatasets: [] });
  });

  it("resolves shared datasets under the project root and rejects escapes", () => {
    const result = hubEnvironment(
      {
        hubMemory: {
          commitLimitMb: 3072,
          concurrencyGroup: "research",
          concurrencySlots: 4,
          sharedDatasets: [
            { name: "WALLET_EVENTS", relativeSource: "data/wallet_events.jsonl" },
            { name: "OUTSIDE", relativeSource: "data/../../secrets.jsonl" },
          ],
        },
      },
      "/project",
      posixPath,
    );
    expect(result.rejectedDatasets).toEqual(["OUTSIDE"]);
    expect(result.env.T3_HUB_DATASET_WALLET_EVENTS).toBe("/project/data/wallet_events.jsonl");
    expect(result.env.T3_HUB_DATASET_OUTSIDE).toBeUndefined();
    expect(result.env[HUB_LIMIT_ENV]).toBe("3072");
    expect(result.env.T3_HUB_YIELD_ON_WAIT).toBe("1");
    expect(result.env[HUB_MANIFEST_ENV]).toBe(
      '{"commitLimitMb":3072,"datasets":{"WALLET_EVENTS":"/project/data/wallet_events.jsonl"}}',
    );
  });
});

describe("windowsJobGuardCandidates", () => {
  it("locates architecture-specific packaged and source binaries", () => {
    const candidates = windowsJobGuardCandidates(NodePath.posix, "arm64");
    expect(candidates[0]).toContain("/hub-memory/win32-arm64/t3-hub-guard.exe");
    expect(
      candidates.some((candidate) => candidate.includes("/native/hub-memory/target/arm64/")),
    ).toBe(true);
  });
});
