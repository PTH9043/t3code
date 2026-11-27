import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  canRetryUnconfirmedCreation,
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  groupQueuedThreadMessages,
  isQueuedThreadCreationSendable,
  modelSelectionsEqual,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  resolveQueuedThreadSettings,
  shouldHoldUnconfirmedFailedAttempt,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { createThreadOutboxManager, ThreadOutboxManagerError } from "./thread-outbox-manager";
import { reconcileQueuedCreationReceipt, retainThreadOutboxFailure } from "./thread-outbox-failure";
import { matchesQueuedAttempt, prepareQueuedCreationAttempt } from "./thread-outbox-attempt";
import type { ThreadOutboxStorage } from "./thread-outbox-storage";

function queuedMessage(input: {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly messageId: string;
  readonly createdAt: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make(input.environmentId ?? "environment-1"),
    threadId: ThreadId.make(input.threadId ?? "thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.messageId,
    attachments: [],
    createdAt: input.createdAt,
  };
}

describe("thread outbox", () => {
  it("retries only when the server and stored attempt support safe bootstrap recovery", () => {
    const creation = {
      projectId: ProjectId.make("project"),
      workspaceMode: "local" as const,
      branch: null,
      worktreePath: null,
    };
    const base = {
      creation,
      threadExists: false,
      projectCwd: "/project",
      safeBootstrapReplay: true,
    };
    expect(canRetryUnconfirmedCreation(base)).toBe(true);
    expect(canRetryUnconfirmedCreation({ ...base, threadExists: true })).toBe(false);
    expect(
      canRetryUnconfirmedCreation({ ...base, threadExists: true, safeBootstrapResume: true }),
    ).toBe(true);
    expect(canRetryUnconfirmedCreation({ ...base, safeBootstrapReplay: false })).toBe(false);
    expect(canRetryUnconfirmedCreation({ ...base, projectCwd: null })).toBe(false);
    expect(
      canRetryUnconfirmedCreation({
        ...base,
        creation: { ...creation, workspaceMode: "worktree" },
      }),
    ).toBe(false);
    const worktree = {
      ...base,
      creation: { ...creation, workspaceMode: "worktree" as const },
      safeWorktreeBootstrapResume: true,
      attemptWorktree: { projectCwd: "/project", worktreeBranchName: "t3/task" },
    };
    expect(canRetryUnconfirmedCreation(worktree)).toBe(true);
    expect(canRetryUnconfirmedCreation({ ...worktree, threadExists: true })).toBe(true);
    expect(canRetryUnconfirmedCreation({ ...worktree, safeWorktreeBootstrapResume: false })).toBe(
      false,
    );
    expect(canRetryUnconfirmedCreation({ ...worktree, attemptWorktree: undefined })).toBe(false);
  });
  it("persists the attempt before sending and skips work changed during preparation", async () => {
    const original = queuedMessage({ messageId: "prepare", createdAt: "2026-06-08T10:00:01.000Z" });
    let current: QueuedThreadMessage | null = original;
    const updateIfCurrent = async (
      expected: QueuedThreadMessage,
      replacement: QueuedThreadMessage,
    ) => {
      if (current !== expected) return false;
      current = replacement;
      return true;
    };
    const prepared = await prepareQueuedCreationAttempt({
      message: original,
      fingerprint: async () => "a".repeat(64),
      isEditing: () => false,
      updateIfCurrent,
    });
    expect(prepared?.deliveryAttemptFingerprint).toBe("a".repeat(64));
    expect(matchesQueuedAttempt(prepared!, "a".repeat(64))).toBe(true);
    expect(matchesQueuedAttempt(prepared!, "b".repeat(64))).toBe(false);
    expect(current).toBe(prepared);
    current = original;
    const preparedWorktree = await prepareQueuedCreationAttempt({
      message: original,
      fingerprint: async () => "c".repeat(64),
      attemptWorktree: { projectCwd: "/project", worktreeBranchName: "t3/task" },
      isEditing: () => false,
      updateIfCurrent,
    });
    expect(
      decodeQueuedThreadMessage(encodeQueuedThreadMessage(preparedWorktree!))
        .deliveryAttemptWorktree,
    ).toEqual({ projectCwd: "/project", worktreeBranchName: "t3/task" });
    current = original;
    expect(
      await prepareQueuedCreationAttempt({
        message: original,
        fingerprint: async () => {
          current = { ...original, text: "new edit" };
          return "a".repeat(64);
        },
        isEditing: () => false,
        updateIfCurrent,
      }),
    ).toBeNull();
    expect(current?.text).toBe("new edit");
    current = original;
    let checks = 0;
    expect(
      await prepareQueuedCreationAttempt({
        message: original,
        fingerprint: async () => "a".repeat(64),
        isEditing: () => ++checks > 1,
        updateIfCurrent,
      }),
    ).toBeNull();
    expect(current).toBe(original);
    const previousWarning = {
      ...original,
      deliveryAttemptFingerprint: "a".repeat(64),
      deliveryFailure: { stage: "start-turn" as const, message: "not yet confirmed" },
      deliveryReceiptChecked: false,
    };
    expect(shouldHoldUnconfirmedFailedAttempt(previousWarning)).toBe(false);
    expect(
      shouldHoldUnconfirmedFailedAttempt({
        ...original,
        deliveryFailure: previousWarning.deliveryFailure,
      }),
    ).toBe(true);
    current = previousWarning;
    const retried = await prepareQueuedCreationAttempt({
      message: previousWarning,
      fingerprint: async () => "a".repeat(64),
      isEditing: () => false,
      updateIfCurrent,
    });
    expect(retried?.deliveryFailure).toBeUndefined();
    expect(retried?.deliveryReceiptChecked).toBeUndefined();
  });
  it("removes only a matching accepted creation and retains uncertain or changed requests", async () => {
    for (const status of [
      "accepted",
      "unconfirmed",
      "mismatch",
      "rejected",
      "unavailable",
    ] as const) {
      const registry = AtomRegistry.make();
      const stored = new Map<MessageId, QueuedThreadMessage>();
      const manager = createThreadOutboxManager({
        registry,
        storage: {
          load: async () => [...stored.values()],
          write: async (message) => {
            stored.set(message.messageId, message);
          },
          remove: async (message) => {
            stored.delete(message.messageId);
          },
        },
      });
      const message = {
        ...queuedMessage({ messageId: `receipt-${status}`, createdAt: "2026-06-08T10:00:01.000Z" }),
        deliveryAttemptFingerprint: "a".repeat(64),
      };
      await manager.enqueue(message);
      expect(
        decodeQueuedThreadMessage(encodeQueuedThreadMessage(message)).deliveryAttemptFingerprint,
      ).toBe("a".repeat(64));
      const result = await reconcileQueuedCreationReceipt({
        message,
        status,
        removeIfCurrent: manager.removeIfCurrent,
        updateIfCurrent: manager.updateIfCurrent,
      });
      expect(result).toBe(status === "accepted" ? "removed" : "held");
      expect(stored.has(message.messageId)).toBe(status !== "accepted");
      if (status !== "accepted")
        expect(stored.get(message.messageId)?.deliveryFailure?.message).toBeTruthy();
      if (status === "unconfirmed") {
        const saved = stored.get(message.messageId)!;
        let writes = 0;
        expect(
          await reconcileQueuedCreationReceipt({
            message: saved,
            status,
            removeIfCurrent: manager.removeIfCurrent,
            updateIfCurrent: async () => {
              writes++;
              return true;
            },
          }),
        ).toBe("held");
        expect(writes).toBe(0);
      }
      registry.dispose();
    }
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    const original = queuedMessage({ messageId: "edited", createdAt: "2026-06-08T10:00:01.000Z" });
    await manager.enqueue(original);
    await manager.update({ ...original, text: "newer edit" });
    expect(
      await reconcileQueuedCreationReceipt({
        message: original,
        status: "accepted",
        removeIfCurrent: manager.removeIfCurrent,
        updateIfCurrent: manager.updateIfCurrent,
      }),
    ).toBe("changed");
    expect(
      registry.get(manager.queuedMessagesByThreadKeyAtom)["environment-1:thread-1"]?.[0]?.text,
    ).toBe("newer edit");
    registry.dispose();
  });
  it("groups messages by scoped thread and preserves creation order", () => {
    const later = queuedMessage({
      messageId: "message-2",
      createdAt: "2026-06-08T10:00:02.000Z",
    });
    const earlier = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    expect(groupQueuedThreadMessages([later, earlier])).toEqual({
      "environment-1:thread-1": [earlier, later],
    });
  });

  it("decodes the persisted schema and rejects incomplete messages", () => {
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    expect(
      decodeQueuedThreadMessage({
        schemaVersion: 1,
        ...message,
      }),
    ).toEqual(message);
    expect(decodeQueuedThreadMessage({ schemaVersion: 3, ...message })).toEqual(message);
    expect(() =>
      decodeQueuedThreadMessage({
        schemaVersion: 1,
        environmentId: "environment-1",
      }),
    ).toThrow();
  });

  it("persists the exact selector snapshot while remaining compatible with v1 messages", () => {
    const legacyMessage = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const selectedMessage = {
      ...legacyMessage,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(selectedMessage))).toEqual(
      selectedMessage,
    );
    expect(
      resolveQueuedThreadSettings(legacyMessage, {
        modelSelection: selectedMessage.modelSelection,
        runtimeMode: selectedMessage.runtimeMode,
        interactionMode: selectedMessage.interactionMode,
      }),
    ).toEqual({
      modelSelection: selectedMessage.modelSelection,
      runtimeMode: selectedMessage.runtimeMode,
      interactionMode: selectedMessage.interactionMode,
    });
  });

  it("compares model options as part of the queued settings change", () => {
    const base = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "medium" }],
    } as const;

    expect(modelSelectionsEqual(base, base)).toBe(true);
    expect(
      modelSelectionsEqual(base, {
        ...base,
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      }),
    ).toBe(false);
  });

  it("backs off queued delivery retries and caps them at sixteen seconds", () => {
    expect([1, 2, 3, 4, 5, 6].map(threadOutboxRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 16_000,
    ]);
  });

  it("serializes mutations even when an earlier mutation is slower", async () => {
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = manager.serialize(async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    const second = manager.serialize(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    registry.dispose();
  });

  it("holds the mutation queue while persisted messages are loading", async () => {
    const registry = AtomRegistry.make();
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const stored = new Map([[message.messageId, message]]);
    let loadCalls = 0;
    let removeCalls = 0;
    let releaseInitialLoad!: () => void;
    const initialLoadBlocked = new Promise<void>((resolve) => {
      releaseInitialLoad = resolve;
    });
    const storage: ThreadOutboxStorage = {
      load: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          await initialLoadBlocked;
        }
        return [...stored.values()];
      },
      write: async () => undefined,
      remove: async (candidate) => {
        removeCalls += 1;
        stored.delete(candidate.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });

    const loading = manager.load();
    await Promise.resolve();
    const clearing = manager.clearEnvironment(message.environmentId);
    await Promise.resolve();
    await Promise.resolve();

    expect(loadCalls).toBe(1);
    expect(removeCalls).toBe(0);

    releaseInitialLoad();
    await Promise.all([loading, clearing]);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("reports structured load failures and permits a retry", async () => {
    const registry = AtomRegistry.make();
    const loadCause = new Error("storage unavailable");
    const warnings: Array<{ message: string; error: unknown }> = [];
    let loadCalls = 0;
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => {
          loadCalls += 1;
          if (loadCalls === 1) throw loadCause;
          return [];
        },
        write: async () => undefined,
        remove: async () => undefined,
      },
      warn: (message, error) => warnings.push({ message, error }),
    });

    await manager.load();
    expect(warnings).toEqual([
      {
        message: "[thread-outbox] failed to load persisted messages",
        error: new ThreadOutboxManagerError({
          operation: "load",
          environmentId: null,
          threadId: null,
          messageId: null,
          cause: loadCause,
        }),
      },
    ]);

    await manager.load();
    expect(loadCalls).toBe(2);
    registry.dispose();
  });

  it("keeps atom state aligned with durable writes and removals", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const removalCause = new Error("remove failed");
    let failRemoval = true;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        if (failRemoval) {
          throw removalCause;
        }
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await manager.enqueue(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    await expect(manager.remove(message)).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: "remove",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: removalCause,
      }),
    );
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    failRemoval = false;
    await manager.remove(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("publishes an enqueued message before the durable write resolves", async () => {
    const registry = AtomRegistry.make();
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => writeBlocked,
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    const enqueueing = manager.enqueue(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    releaseWrite();
    await enqueueing;
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });
    registry.dispose();
  });

  it("rolls an enqueued message back out when the durable write fails", async () => {
    const registry = AtomRegistry.make();
    const writeCause = new Error("disk full");
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => {
          throw writeCause;
        },
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await expect(manager.enqueue(message)).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: "enqueue",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: writeCause,
      }),
    );
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("keeps a same-id retry queued when the first attempt's write fails", async () => {
    const registry = AtomRegistry.make();
    let failNextWrite = true;
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => {
          if (failNextWrite) {
            failNextWrite = false;
            await firstWriteBlocked;
            throw new Error("disk full");
          }
        },
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const retried = { ...message, text: "retried" };

    const first = manager.enqueue(message);
    const second = manager.enqueue(retried);
    releaseFirstWrite();
    await expect(first).rejects.toBeInstanceOf(ThreadOutboxManagerError);
    await second;

    // The failed first attempt must not roll back the retry that replaced it.
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [retried],
    });
    await expect(manager.confirmQueued(retried)).resolves.toBe(true);
    await expect(manager.confirmQueued(message)).resolves.toBe(false);
    registry.dispose();
  });

  it("replaces an existing message when an enqueue retry uses the same id", async () => {
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const retried = { ...message, text: "retried" };

    await manager.enqueue(message);
    await manager.enqueue(retried);

    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [retried],
    });
    registry.dispose();
  });

  it("updates a queued message in place but never resurrects a removed one", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await manager.enqueue(message);
    const edited = { ...message, text: "edited" };
    await expect(manager.update(edited)).resolves.toBe(true);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [edited],
    });
    expect(stored.get(message.messageId)).toEqual(edited);

    await manager.remove(edited);
    await expect(manager.update({ ...message, text: "stale flush" })).resolves.toBe(false);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    expect(stored.size).toBe(0);
    registry.dispose();
  });

  it("retains a missing-thread message even after shell synchronization is live", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("send");
  });

  it("holds queued creations when the thread exists without proof its first message was accepted", () => {
    for (const threadExists of [true, false]) {
      expect(
        resolveThreadOutboxDeliveryAction({
          isCreation: true,
          threadExists,
          shellStatus: "live",
          environmentConnected: true,
          threadBusy: false,
          hasAttemptFingerprint: true,
        }),
      ).toBe("verify");
      expect(
        resolveThreadOutboxDeliveryAction({
          isCreation: true,
          threadExists,
          shellStatus: "cached",
          environmentConnected: false,
          threadBusy: false,
          hasAttemptFingerprint: true,
        }),
      ).toBe("wait");
      expect(
        resolveThreadOutboxDeliveryAction({
          isCreation: true,
          threadExists,
          shellStatus: "live",
          environmentConnected: true,
          threadBusy: false,
          hasAttemptFingerprint: true,
          hasDeliveryFailure: true,
        }),
      ).toBe("verify");
      expect(
        resolveThreadOutboxDeliveryAction({
          isCreation: true,
          threadExists,
          shellStatus: "live",
          environmentConnected: true,
          threadBusy: false,
          hasAttemptFingerprint: true,
          hasDeliveryFailure: true,
          receiptChecked: true,
        }),
      ).toBe("wait");
    }
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: true,
        shellStatus: "cached",
        environmentConnected: false,
        threadBusy: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "cached",
        environmentConnected: false,
        threadBusy: false,
      }),
    ).toBe("wait");
    // Connected but not yet synchronized: a previously delivered creation may
    // simply not be visible yet — sending now could duplicate the thread.
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("send");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: true,
      }),
    ).toBe("hold");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
        hasDeliveryFailure: true,
      }),
    ).toBe("wait");
  });

  it("round-trips queued creations and gates incomplete ones from sending", () => {
    const base = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const creationMessage = {
      ...base,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "worktree",
        branch: "main",
        worktreePath: null,
        startFromOrigin: true,
      },
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(creationMessage))).toEqual(
      creationMessage,
    );
    expect(isQueuedThreadCreationSendable(creationMessage)).toBe(true);
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        creation: { ...creationMessage.creation, branch: null },
      }),
    ).toBe(false);
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        creation: { ...creationMessage.creation, branch: "" },
      }),
    ).toBe(false);
    expect(isQueuedThreadCreationSendable({ ...creationMessage, modelSelection: undefined })).toBe(
      false,
    );
    expect(isQueuedThreadCreationSendable(base)).toBe(false);
  });

  it("recognizes transport failures without treating command rejection as a connection error", () => {
    expect(shouldRetryThreadOutboxDelivery(new Error("Socket is not connected"))).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "ConnectionTransientError",
        message: "temporarily unavailable",
      }),
    ).toBe(true);
    expect(shouldRetryThreadOutboxDelivery(new Error("Thread no longer exists"))).toBe(false);
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "OrchestrationDispatchCommandError",
        reason: "active-turn-settings",
        message: "현재 작업이 진행 중입니다.",
      }),
    ).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "OrchestrationDispatchCommandError",
        message: "현재 작업이 진행 중입니다.",
      }),
    ).toBe(false);
  });

  it("holds deterministic failures for user review and retries connection failures", () => {
    const deterministicFailure = new Error("Thread no longer exists");

    expect(
      resolveThreadOutboxFailureAction({
        stage: "settings-sync",
        error: deterministicFailure,
        interrupted: false,
      }),
    ).toBe("hold");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: deterministicFailure,
        interrupted: false,
      }),
    ).toBe("hold");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: new Error("Socket is not connected"),
        interrupted: false,
      }),
    ).toBe("retry");
  });

  it("persists a failed message across reload and never overwrites a newer edit", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, unknown>();
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()].map(decodeQueuedThreadMessage),
      write: async (message) => {
        stored.set(message.messageId, encodeQueuedThreadMessage(message));
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const original = queuedMessage({
      messageId: "preserved",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    await manager.enqueue(original);
    expect(
      await retainThreadOutboxFailure({
        message: original,
        stage: "settings-sync",
        error: new Error("Socket is not connected"),
        interrupted: false,
        updateIfCurrent: manager.updateIfCurrent,
      }),
    ).toBe("retry");
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)["environment-1:thread-1"]).toEqual([
      original,
    ]);
    const held: QueuedThreadMessage = {
      ...original,
      deliveryFailure: { stage: "start-turn", message: "모델을 사용할 수 없습니다" },
    };
    expect(
      await retainThreadOutboxFailure({
        message: original,
        stage: "start-turn",
        error: new Error("모델을 사용할 수 없습니다"),
        interrupted: false,
        updateIfCurrent: manager.updateIfCurrent,
      }),
    ).toBe("held");
    const otherRegistry = AtomRegistry.make();
    const reopened = createThreadOutboxManager({ registry: otherRegistry, storage });
    await reopened.load();
    expect(
      otherRegistry.get(reopened.queuedMessagesByThreadKeyAtom)["environment-1:thread-1"],
    ).toEqual([held]);
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
        hasDeliveryFailure: true,
      }),
    ).toBe("wait");
    const edited = { ...held, text: "사용자가 수정한 새 내용" };
    expect(await manager.update(edited)).toBe(true);
    expect(await manager.updateIfCurrent(held, original)).toBe(false);
    expect(await manager.removeIfCurrent(held)).toBe(false);
    expect(
      await retainThreadOutboxFailure({
        message: held,
        stage: "start-turn",
        error: new Error("늦게 도착한 오류"),
        interrupted: false,
        updateIfCurrent: manager.updateIfCurrent,
      }),
    ).toBe("changed");
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)["environment-1:thread-1"]).toEqual([
      edited,
    ]);
    expect(decodeQueuedThreadMessage(stored.get(edited.messageId))).toEqual(edited);
    registry.dispose();
    otherRegistry.dispose();
  });

  it("keeps the original queued message if saving its failure state fails", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [...stored.values()],
        write: async (message) => {
          if (message.deliveryFailure) throw new Error("storage unavailable");
          stored.set(message.messageId, message);
        },
        remove: async (message) => {
          stored.delete(message.messageId);
        },
      },
    });
    const message = queuedMessage({
      messageId: "keep-on-error",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    await manager.enqueue(message);
    await expect(
      retainThreadOutboxFailure({
        message,
        stage: "start-turn",
        error: new Error("request rejected"),
        interrupted: false,
        updateIfCurrent: manager.updateIfCurrent,
      }),
    ).rejects.toBeInstanceOf(ThreadOutboxManagerError);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)["environment-1:thread-1"]).toEqual([
      message,
    ]);
    expect(stored.get(message.messageId)).toBe(message);
    registry.dispose();
  });
});
