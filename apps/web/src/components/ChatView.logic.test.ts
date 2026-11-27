import {
  ApprovalRequestId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  usesLocalBackend,
} from "@t3tools/client-runtime/connection";

import type { Thread, ThreadShell } from "../types";
import {
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildLoadingThreadFromShell,
  buildThreadTurnInterruptInput,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  dismissBranchMismatchForSession,
  ACCOUNT_AUTO_SWITCH_RECONNECT_SUPPRESS_MS,
  ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  LOCAL_RECONNECT_WARNING_GRACE_MS,
  hasEnvironmentReconnectWarningGraceElapsed,
  hasRecentAccountAutoSwitch,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  reconcileMountedTerminalThreadIds,
  reconcileRetainedMountedThreadIds,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  resolveVisibleThreadError,
  prepareOrchestraMessage,
  scheduleEnvironmentReconnectWarning,
  suppressEnvironmentReconnectBanner,
  startNewThreadForProject,
  shouldShowBranchMismatchBanner,
  shouldWaitForActiveModelBeforeSending,
  shouldWriteThreadErrorToCurrentServerThread,
} from "./ChatView.logic";

const environmentId = EnvironmentId.make("environment-local");

describe("changing the model during a turn", () => {
  const current = { instanceId: ProviderInstanceId.make("codex"), model: "original" };
  const other = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "new" };

  it("waits before submitting a different provider, model, account, or options while active", () => {
    for (const status of ["starting", "running"] as const) {
      const session = { status, providerInstanceId: current.instanceId };
      for (const next of [
        other,
        { ...current, model: "another-model" },
        { ...current, instanceId: ProviderInstanceId.make("codex-other-account") },
        { ...current, options: [{ id: "reasoningEffort", value: "high" }] },
      ]) {
        expect(
          shouldWaitForActiveModelBeforeSending({
            session,
            currentModelSelection: current,
            nextModelSelection: next,
          }),
        ).toBe(true);
      }
      expect(
        shouldWaitForActiveModelBeforeSending({
          session,
          currentModelSelection: current,
          nextModelSelection: current,
        }),
      ).toBe(false);
    }
  });

  it("allows the next model once the turn settles, and respects the actual session instance", () => {
    expect(
      shouldWaitForActiveModelBeforeSending({
        session: { status: "ready", providerInstanceId: current.instanceId },
        currentModelSelection: current,
        nextModelSelection: other,
      }),
    ).toBe(false);
    expect(
      shouldWaitForActiveModelBeforeSending({
        session: { status: "running", providerInstanceId: other.instanceId },
        currentModelSelection: current,
        nextModelSelection: current,
      }),
    ).toBe(true);
  });
});

describe("orchestra input length", () => {
  it("preserves complete in-range instructions and rejects oversized input", () => {
    const limit = `${"a".repeat(7_999)}끝`;
    expect(prepareOrchestraMessage(`  ${limit}  `)).toEqual({ kind: "ready", text: limit });
    expect(prepareOrchestraMessage(`${limit}추가 조건`)).toEqual({ kind: "too-long" });
    expect(prepareOrchestraMessage("   ")).toEqual({ kind: "ready", text: "" });
  });
});

describe("reconnect banner with version mismatch", () => {
  const baseline = {
    reconnecting: true,
    localBackend: true,
    versionSkew: true,
    recentAccountSwitch: false,
    updateRunning: false,
    graceElapsed: false,
  };
  it("keeps the local grace but shows a persistent or failed connection", () => {
    expect(suppressEnvironmentReconnectBanner(baseline)).toBe(true);
    expect(suppressEnvironmentReconnectBanner({ ...baseline, graceElapsed: true })).toBe(false);
    expect(suppressEnvironmentReconnectBanner({ ...baseline, reconnecting: false })).toBe(false);
  });
  it("preserves remote mismatch and update behavior", () => {
    expect(suppressEnvironmentReconnectBanner({ ...baseline, localBackend: false })).toBe(false);
    expect(
      suppressEnvironmentReconnectBanner({ ...baseline, localBackend: false, versionSkew: false }),
    ).toBe(true);
    expect(
      suppressEnvironmentReconnectBanner({ ...baseline, graceElapsed: true, updateRunning: true }),
    ).toBe(true);
  });
});
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";

describe("environment reconnect warning grace", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a persistent reconnect after the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    scheduleEnvironmentReconnectWarning(showWarning);
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS - 1);
    expect(showWarning).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(showWarning).toHaveBeenCalledOnce();
  });

  it("gives the local direct connection time to recover before showing a warning", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();
    scheduleEnvironmentReconnectWarning(showWarning, true);
    vi.advanceTimersByTime(LOCAL_RECONNECT_WARNING_GRACE_MS - 1);
    expect(showWarning).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(showWarning).toHaveBeenCalledOnce();
  });

  it("uses the local grace for loopback web and desktop-local connections but not remote ones", () => {
    vi.useFakeTimers();
    const primary = (httpBaseUrl: string, wsBaseUrl: string) =>
      new PrimaryConnectionTarget({ environmentId, label: "test", httpBaseUrl, wsBaseUrl });
    const targets = [
      [primary("http://localhost:8555", "ws://localhost:16595"), true],
      [primary("t3code-dev://app/", "ws://127.0.0.1:16595"), true],
      [
        new BearerConnectionTarget({
          environmentId,
          label: "WSL",
          connectionId: "local:wsl:ubuntu",
        }),
        true,
      ],
      [primary("https://example.test", "wss://example.test"), false],
      [new RelayConnectionTarget({ environmentId, label: "relay" }), false],
    ] as const;
    for (const [target, local] of targets) {
      const showWarning = vi.fn();
      expect(usesLocalBackend(target)).toBe(local);
      const cancel = scheduleEnvironmentReconnectWarning(showWarning, usesLocalBackend(target));
      vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);
      expect(showWarning).toHaveBeenCalledTimes(local ? 0 : 1);
      if (local) {
        vi.advanceTimersByTime(
          LOCAL_RECONNECT_WARNING_GRACE_MS - ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
        );
        expect(showWarning).toHaveBeenCalledOnce();
      }
      cancel();
    }
  });

  it("cancels the warning when the connection recovers during the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    const cancel = scheduleEnvironmentReconnectWarning(showWarning);
    cancel();
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);

    expect(showWarning).not.toHaveBeenCalled();
  });

  it("does not reuse elapsed grace from another environment", () => {
    const anotherEnvironmentId = EnvironmentId.make("environment-remote");

    expect(hasEnvironmentReconnectWarningGraceElapsed(environmentId, environmentId)).toBe(true);
    expect(hasEnvironmentReconnectWarningGraceElapsed(anotherEnvironmentId, environmentId)).toBe(
      false,
    );
  });
});

describe("account auto-switch reconnect suppression", () => {
  const now = Date.now();

  function autoSwitchActivity(at: string) {
    return {
      id: "evt-1" as never,
      tone: "info" as const,
      kind: "provider.account.auto-switched",
      summary: "Claude 계정 자동 전환",
      payload: {},
      turnId: null,
      createdAt: at,
    };
  }

  it("suppresses the warning while a fresh auto-switch is settling", () => {
    const activities = [autoSwitchActivity(new Date(now - 5_000).toISOString())];
    expect(hasRecentAccountAutoSwitch(activities, now)).toBe(true);
  });

  it("stops suppressing once the switch has had time to settle", () => {
    const activities = [
      autoSwitchActivity(
        new Date(now - (ACCOUNT_AUTO_SWITCH_RECONNECT_SUPPRESS_MS + 1_000)).toISOString(),
      ),
    ];
    expect(hasRecentAccountAutoSwitch(activities, now)).toBe(false);
  });

  it("ignores other activity kinds", () => {
    const activities = [
      { ...autoSwitchActivity(new Date(now - 1_000).toISOString()), kind: "tool.started" },
    ];
    expect(hasRecentAccountAutoSwitch(activities, now)).toBe(false);
  });

  it("handles empty or missing activity lists", () => {
    expect(hasRecentAccountAutoSwitch([], now)).toBe(false);
    expect(hasRecentAccountAutoSwitch(undefined, now)).toBe(false);
    expect(hasRecentAccountAutoSwitch(null, now)).toBe(false);
  });
});

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

const completedTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  threadId,
  status: "ready" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

describe("buildLoadingThreadFromShell", () => {
  it("preserves shell metadata and supplies empty detail collections", () => {
    const shell = {
      environmentId,
      id: threadId,
      projectId,
      title: "Loading thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      session: null,
      latestUserMessageAt: now,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    } satisfies ThreadShell;

    expect(buildLoadingThreadFromShell(shell)).toMatchObject({
      environmentId,
      id: threadId,
      projectId,
      title: "Loading thread",
      branch: "main",
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    });
  });
});

describe("resolveThreadMetadataUpdateForNextTurn", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("updates a stale local thread branch to the active checkout", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({ branch: "feature/checkout", worktreePath: null });
  });

  it("does not write metadata when the model and branch are unchanged", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: "feature/current",
        nextBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("buildThreadTurnInterruptInput", () => {
  it("targets the session's active running turn", () => {
    const activeTurnId = TurnId.make("turn-running");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: activeTurnId });
  });

  it("omits a turn id when the session is not running", () => {
    expect(buildThreadTurnInterruptInput(makeThread({ session: readySession }))).toEqual({
      threadId,
    });
  });

  it("keeps the selected asynchronous question on the stop command", () => {
    const questionRequestId = ApprovalRequestId.make("async:question-1");
    expect(
      buildThreadTurnInterruptInput(makeThread({ session: readySession }), { questionRequestId }),
    ).toEqual({ threadId, questionRequestId });
  });

  it("only the explicit background stop asks the server to take watch loops down", () => {
    const thread = makeThread({ session: readySession });
    expect(buildThreadTurnInterruptInput(thread)).not.toHaveProperty("stopBackground");
    expect(buildThreadTurnInterruptInput(thread, { stopBackground: false })).not.toHaveProperty(
      "stopBackground",
    );
    expect(buildThreadTurnInterruptInput(thread, { stopBackground: true })).toMatchObject({
      stopBackground: true,
    });
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats element contexts as sendable content (no text, no images, no terminals)", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });

  it("does NOT treat zero element contexts as sendable", () => {
    expect(
      deriveComposerSendState({
        prompt: "",
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats empty and omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "만료된 터미널 컨텍스트는 전송되지 않습니다",
      description: "삭제하거나 다시 추가하면 터미널 출력을 포함할 수 있습니다.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "만료된 터미널 컨텍스트 2개는 메시지에서 제외되었습니다",
      description: "터미널 출력을 포함하려면 다시 추가하세요.",
    });
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("branchMismatchKey", () => {
  it("builds a key from thread id and both branches", () => {
    expect(branchMismatchKey("thread-1", { threadBranch: "feat/a", currentBranch: "feat/b" })).toBe(
      "thread-1:feat/a:feat/b",
    );
  });

  it("returns null without a thread or mismatch", () => {
    expect(branchMismatchKey(null, { threadBranch: "a", currentBranch: "b" })).toBeNull();
    expect(branchMismatchKey("thread-1", null)).toBeNull();
  });
});

describe("shouldShowBranchMismatchBanner", () => {
  const base = {
    hasMismatch: true,
    isDismissed: false,
    composerHasContent: false,
    wasShownForCurrentMismatch: false,
  };

  it("stays hidden during passive browsing (even though the composer autofocuses)", () => {
    expect(shouldShowBranchMismatchBanner(base)).toBe(false);
  });

  it("shows once the composer has draft content", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, composerHasContent: true })).toBe(true);
  });

  it("stays mounted after the draft clears once shown for the current mismatch", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, wasShownForCurrentMismatch: true })).toBe(
      true,
    );
  });

  it("never shows when dismissed or without a mismatch", () => {
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, isDismissed: true }),
    ).toBe(false);
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, hasMismatch: false }),
    ).toBe(false);
  });
});

describe("session branch mismatch dismissal", () => {
  it("tracks dismissed keys and treats other keys as active", () => {
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(false);
    dismissBranchMismatchForSession("t1:a:b");
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(true);
    expect(isBranchMismatchDismissedForSession("t1:a:c")).toBe(false);
    expect(isBranchMismatchDismissedForSession(null)).toBe(false);
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps open threads and makes the active thread most recent", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["thread-a", "thread-b", "thread-c"],
        openThreadIds: ["thread-a", "thread-b", "thread-c"],
        activeThreadId: "thread-a",
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual(["thread-b", "thread-c", "thread-a"]);
  });

  it("drops closed threads and enforces the hidden mounted cap", () => {
    const ids = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => `thread-${index}`,
    );
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ids,
        openThreadIds: ids.slice(1),
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(ids.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("reconcileRetainedMountedThreadIds", () => {
  it("retains hidden open threads and adds the active open thread", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden")],
        openThreadIds: [ThreadId.make("thread-hidden")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: true,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("can retain the active thread as hidden when it is inactive", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-active")],
        openThreadIds: [ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
        retainInactiveActiveThread: true,
      }),
    ).toEqual([ThreadId.make("thread-active")]);
  });

  it("evicts the oldest hidden threads beyond the configured cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_PREVIEW_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("writes errors for a shell-derived active server thread", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: { environmentId, id: threadId },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
  });

  it("requires an active server thread matching the environment, route, and target", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: null,
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

describe("startNewThreadForProject", () => {
  it("starts a thread through the supplied shared handler for the active project", () => {
    const calls: Array<{ environmentId: EnvironmentId; projectId: ProjectId }> = [];
    const projectRef = { environmentId, projectId };

    expect(
      startNewThreadForProject(projectRef, (nextProjectRef) => {
        calls.push(nextProjectRef);
        return Promise.resolve();
      }),
    ).toBe(true);
    expect(calls).toEqual([projectRef]);
  });

  it("does nothing when the active project is unavailable", () => {
    let called = false;

    expect(
      startNewThreadForProject(null, () => {
        called = true;
        return Promise.resolve();
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("does not acknowledge unchanged server state", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: completedTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges a settled newer turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const newerTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: newerTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      state: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: TurnId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: runningTurn.turnId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a steering message projected onto the current running turn", () => {
    const runningTurn = {
      ...completedTurn,
      state: "running" as const,
      completedAt: null,
    };
    const runningSession = {
      ...readySession,
      status: "running" as const,
      activeTurnId: runningTurn.turnId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        latestTurn: runningTurn,
        session: runningSession,
        messages: [
          {
            id: MessageId.make("message-before-steer"),
            role: "user",
            text: "Initial prompt",
            turnId: runningTurn.turnId,
            createdAt: runningTurn.requestedAt,
            updatedAt: runningTurn.requestedAt,
            streaming: false,
          },
        ],
      }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: MessageId.make("message-steer"),
        session: runningSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges pending user interaction and errors immediately", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestTurn: null,
      latestUserMessageId: localDispatch.latestUserMessageId,
      session: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: "failed" })).toBe(true);
  });
});

describe("resolveVisibleThreadError", () => {
  const base = {
    isServerThread: true,
    localDraftError: null,
    localServerError: null,
    sessionError: null,
    dismissedSessionError: null,
  } as const;
  const refusal =
    "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.";

  it("shows the session error while it stands", () => {
    expect(resolveVisibleThreadError({ ...base, sessionError: refusal })).toBe(refusal);
  });

  it("closes for good once the person dismisses that message", () => {
    // The regression: the X cleared only the local entry, so the banner fell
    // back to the session error and reappeared immediately.
    expect(
      resolveVisibleThreadError({
        ...base,
        sessionError: refusal,
        dismissedSessionError: refusal,
      }),
    ).toBeNull();
  });

  it("still raises a different failure after one was dismissed", () => {
    expect(
      resolveVisibleThreadError({
        ...base,
        sessionError: "세션을 시작하지 못했습니다.",
        dismissedSessionError: refusal,
      }),
    ).toBe("세션을 시작하지 못했습니다.");
  });

  it("prefers a local error over the session's", () => {
    expect(
      resolveVisibleThreadError({
        ...base,
        localServerError: "보내지 못했습니다.",
        sessionError: refusal,
      }),
    ).toBe("보내지 못했습니다.");
  });

  it("reads the draft error while the thread is still local", () => {
    expect(
      resolveVisibleThreadError({
        ...base,
        isServerThread: false,
        localDraftError: "초안 오류",
        sessionError: refusal,
      }),
    ).toBe("초안 오류");
  });
});
