// @effect-diagnostics nodeBuiltinImport:off - Exercise the real Windows and POSIX path semantics.
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  computeHubRssUsageRatio,
  HUB_LIMIT_ENV,
  HUB_MANIFEST_ENV,
  hubEnvironment,
  initSharedBlackboardSchema,
  sweepExpiredBlackboardAndCompactRam,
  upsertBlackboardEntryCas,
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

describe("Shared Blackboard MVCC CAS & Lease TTL GC", () => {
  it("enforces optimistic concurrency control (CAS), allows expired lease takeover, and sweeps/compacts RAM under pressure", () => {
    const db = new NodeSqlite.DatabaseSync(":memory:");
    try {
      initSharedBlackboardSchema(db);
      const now = 1_700_000_000_000;

      // 1. Initial acquisition succeeds at version 1
      const first = upsertBlackboardEntryCas(
        db,
        "ws-1",
        {
          key: "lock:src/orchestration/WorkspaceMemory.ts",
          ownerAgentId: "agent-a",
          category: "file-lock",
          payloadJson: '{"status":"editing"}',
          leaseExpiresAt: now + 60_000,
        },
        undefined,
        now,
      );
      expect(first).toEqual({ success: true, newVersion: 1 });

      // 2. Concurrent write with stale expectedVersion fails with conflictEntry
      const conflict = upsertBlackboardEntryCas(
        db,
        "ws-1",
        {
          key: "lock:src/orchestration/WorkspaceMemory.ts",
          ownerAgentId: "agent-b",
          category: "file-lock",
          payloadJson: '{"status":"hijack"}',
          leaseExpiresAt: now + 60_000,
        },
        0,
        now + 1_000,
      );
      expect(conflict.success).toBe(false);
      expect(conflict.newVersion).toBe(1);
      expect(conflict.conflictEntry?.ownerAgentId).toBe("agent-a");

      // 3. Matching expectedVersion=1 increments to version 2
      const updated = upsertBlackboardEntryCas(
        db,
        "ws-1",
        {
          key: "lock:src/orchestration/WorkspaceMemory.ts",
          ownerAgentId: "agent-a",
          category: "file-lock",
          payloadJson: '{"status":"verifying"}',
          leaseExpiresAt: now + 30_000,
        },
        1,
        now + 2_000,
      );
      expect(updated).toEqual({ success: true, newVersion: 2 });

      // 4. After lease expires (now + 35_000), another agent can take over even with stale expectedVersion
      const takeover = upsertBlackboardEntryCas(
        db,
        "ws-1",
        {
          key: "lock:src/orchestration/WorkspaceMemory.ts",
          ownerAgentId: "agent-b",
          category: "file-lock",
          payloadJson: '{"status":"recovered"}',
          leaseExpiresAt: now + 40_000,
        },
        1,
        now + 35_000,
      );
      expect(takeover).toEqual({ success: true, newVersion: 3 });

      // 5. Sweep expired lease entries and trigger shrink_memory + WAL checkpoint at rssUsageRatio >= 0.75
      expect(computeHubRssUsageRatio(800 * 1024 * 1024, 1000)).toBeCloseTo(0.8, 3);
      const gc = sweepExpiredBlackboardAndCompactRam(db, "ws-1", 0.8, now + 50_000);
      expect(gc).toEqual({ evictedEntries: 1, walCheckpointed: true });
    } finally {
      db.close();
    }
  });
});
