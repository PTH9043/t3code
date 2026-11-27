import { describe, expect, it } from "vite-plus/test";
import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import {
  buildAdaptiveHandoffCapsule,
  buildReturnCompletionCapsule,
  foldExploredCodeLedger,
  resolveAdaptiveHandoffProfile,
} from "./adaptiveHandoffCapsule.ts";

const now = "2026-11-26T10:00:00.000Z";

describe("adaptiveHandoffCapsule", () => {
  it("algebraically folds Read+Read unions, Edit upgrades, and Revert status", () => {
    const activities: OrchestrationThreadActivity[] = [
      {
        id: EventId.make("a1"),
        kind: "tool.completed",
        tone: "info",
        summary: "Read file",
        turnId: null,
        createdAt: now,
        payload: {
          toolName: "read_file",
          path: "apps/server/src/orchestration/WorkspaceMemory.ts",
          startLine: 1,
          endLine: 50,
        },
      },
      {
        id: EventId.make("a2"),
        kind: "tool.completed",
        tone: "info",
        summary: "Read file",
        turnId: null,
        createdAt: now,
        payload: {
          toolName: "read_file",
          path: "apps/server/src/orchestration/WorkspaceMemory.ts",
          startLine: 48,
          endLine: 110,
        },
      },
      {
        id: EventId.make("a3"),
        kind: "tool.completed",
        tone: "info",
        summary: "Edit file",
        turnId: null,
        createdAt: now,
        payload: {
          toolName: "edit_file",
          path: "apps/server/src/orchestration/Layers/ProviderCommandReactor.ts",
          startLine: 1500,
          endLine: 1540,
        },
      },
      {
        id: EventId.make("a4"),
        kind: "thread.reverted",
        tone: "info",
        summary: "Reverted experimental patch",
        turnId: null,
        createdAt: now,
        payload: {
          toolName: "revert",
          path: "apps/server/src/orchestration/old.ts",
        },
      },
    ];

    const ledger = foldExploredCodeLedger({ activities });
    const memEntry = ledger.find((e) => e.path.endsWith("WorkspaceMemory.ts"));
    const reactorEntry = ledger.find((e) => e.path.endsWith("ProviderCommandReactor.ts"));
    const revertedEntry = ledger.find((e) => e.path.endsWith("old.ts"));

    expect(memEntry?.lineRanges).toEqual(["L1-110"]);
    expect(memEntry?.status).toBe("UNCHANGED");
    expect(reactorEntry?.status).toBe("MODIFIED");
    expect(revertedEntry?.status).toBe("REVERTED");
  });

  it("selects target-tier profiles and produces compact capsules with @Alias compression", () => {
    expect(resolveAdaptiveHandoffProfile("codex", "gpt-6.2-sol")).toBe("profile-a-codex");
    expect(resolveAdaptiveHandoffProfile("gemini", "gemini-4-neon")).toBe("profile-b-antigravity");
    expect(resolveAdaptiveHandoffProfile("muse", "muse-spark-1.3")).toBe("profile-c-micro");
    expect(resolveAdaptiveHandoffProfile("claudeAgent", "claude-haiku-5-5")).toBe(
      "profile-c-micro",
    );
    expect(resolveAdaptiveHandoffProfile("claudeAgent", "claude-opus-5-5", "codex")).toBe(
      "profile-claude-return",
    );

    const capsule = buildAdaptiveHandoffCapsule({
      targetDriverKind: "codex",
      targetModel: "gpt-6.2-sol",
      currentMessageId: MessageId.make("m-cur"),
      workingTreeDiffStat: "apps/server/src/orchestration/WorkspaceMemory.ts | 12 ++--",
      thread: {
        id: ThreadId.make("t1"),
        projectId: ProjectId.make("p1"),
        messages: [
          {
            id: MessageId.make("m1"),
            role: "user",
            text: "비용 문제 때문에 SQLite를 유지하기로 결정했다. PostgreSQL 전환은 기각한다.",
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: MessageId.make("m2"),
            role: "assistant",
            text: "안녕하세요! 검토하겠습니다.\nSQLite 유지 및 아카이브 분리를 반영했습니다.",
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: MessageId.make("m-cur"),
            role: "user",
            text: "이제 다음 단계 구현해줘",
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
        activities: [
          {
            id: EventId.make("act1"),
            kind: "tool.completed",
            tone: "info",
            summary: "Read",
            turnId: null,
            createdAt: now,
            payload: {
              toolName: "read_file",
              path: "apps/server/src/orchestration/WorkspaceMemory.ts",
              startLine: 1,
              endLine: 80,
            },
          },
          {
            id: EventId.make("act2"),
            kind: "tool.completed",
            tone: "error",
            summary: "vitest exit 1: expected 200 got 500",
            turnId: null,
            createdAt: now,
            payload: {},
          },
        ],
        proposedPlans: [],
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/1"),
            status: "ready",
            files: [
              {
                path: "apps/server/src/orchestration/contextAssemblyGate.ts",
                kind: "modified",
                additions: 20,
                deletions: 2,
              },
            ],
            assistantMessageId: null,
            completedAt: now,
          },
        ],
      },
    });

    expect(capsule.profile).toBe("profile-a-codex");
    expect(capsule.text).toContain("SQLite를 유지하기로 결정했다");
    expect(capsule.text).toContain("PostgreSQL 전환은 기각한다");
    expect(capsule.text).toContain("[EXPLORED_CODE_LEDGER");
    expect(capsule.text).toContain("@orch=apps/server/src/orchestration");
    expect(capsule.text).not.toContain("안녕하세요!");
    expect(capsule.text).not.toContain("이제 다음 단계 구현해줘");
    expect(capsule.chars).toBeLessThan(3_000);
  });

  it("builds compact boomerang return completion capsules for Claude KV preservation", () => {
    const receipt = buildReturnCompletionCapsule({
      workerLabel: "codex:gpt-6.2-sol",
      changedFiles: [
        "apps/server/src/orchestration/contextAssemblyGate.ts",
        "apps/server/src/orchestration/adaptiveHandoffCapsule.ts",
      ],
      diffSummary: "Added mutual-exclusion context gate and adaptive capsule builder.",
      verificationSummary: "vitest 24/24 PASS, tsgo 0 errors",
      openIssues: ["Phase 3 CCR hook wiring remaining"],
    });
    expect(receipt).toContain("<t3_return_capsule");
    expect(receipt).toContain("@orch=apps/server/src/orchestration");
    expect(receipt.length).toBeLessThan(1_800);
  });
});
