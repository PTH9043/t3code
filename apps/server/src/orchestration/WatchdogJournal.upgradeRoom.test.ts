// @effect-diagnostics nodeBuiltinImport:off - The journal is a real SQLite file.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { WATCHDOG_PROJECTION_CONSUMER, WatchdogJournal } from "./WatchdogJournal.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

it("expires only an unclaimed room launch and recovers it until finalization is durable", () => {
  const { open } = openJournal();
  const journal = open();
  const room = "autousage-upgrade-room";
  const runId = "upgrade-room";
  const create = (id: string, sequence: number) =>
    journal.create({
      id,
      executionId: id,
      threadId: room,
      capability: "cap",
      context: { runId, nodeId: id, attempt: 1, provider: "codex", providerInstanceId: "codex" },
      upgradeRoom: {
        turnEventId: `event-${id}`,
        turnSequence: sequence,
        request: id,
        offlineQuestions: "decide",
        continuity: "fresh",
        projection: "{}",
        createdAt: 1000,
      },
    });
  expect(create("pending", 1)).toBe(true);
  expect(journal.expireUnclaimedUpgradeRoomJob("pending", 999)).toBe(false);
  const restarted = open();
  expect(restarted.expireUnclaimedUpgradeRoomJob("pending", 1000)).toBe(true);
  expect(journal.claim("pending", "cap")).toBe(false);
  expect(journal.beginSubmission("pending", "cap")).toBe(false);
  expect(restarted.isSealed("pending")).toBe(true);
  expect(restarted.listReconciliationContexts(WATCHDOG_PROJECTION_CONSUMER)).toMatchObject([
    { id: "pending" },
  ]);
  expect(restarted.listUnsettledForRun(room, runId, WATCHDOG_PROJECTION_CONSUMER)).toHaveLength(1);
  restarted.completeUpgradeRoomFinalization("pending");
  expect(journal.listUnsettledForRun(room, runId, WATCHDOG_PROJECTION_CONSUMER)).toHaveLength(0);
  expect(journal.listReconciliationContexts(WATCHDOG_PROJECTION_CONSUMER)).toHaveLength(0);

  expect(create("claimed", 2)).toBe(true);
  expect(journal.claim("claimed", "cap")).toBe(true);
  expect(journal.beginSubmission("claimed", "cap")).toBe(true);
  expect(restarted.expireUnclaimedUpgradeRoomJob("claimed", 100_000)).toBe(false);
});

it("fails a room job whose worker vanished, keeps its record and lets the room move on", () => {
  const journal = openJournal().open();
  const room = "autousage-upgrade-room";
  const create = (id: string, sequence: number) =>
    journal.create({
      id,
      executionId: id,
      threadId: room,
      capability: "cap",
      context: {
        runId: "upgrade-room",
        nodeId: id,
        attempt: 1,
        provider: "opencode",
        providerInstanceId: "opencode",
      },
      upgradeRoom: {
        turnEventId: `event-${id}`,
        turnSequence: sequence,
        request: id,
        offlineQuestions: "decide",
        continuity: "fresh",
        projection: "{}",
        createdAt: 1000,
      },
    });
  const worker = { workerId: "worker-1", pid: 4242, startedAt: 2000 };
  expect(create("lost", 1)).toBe(true);
  expect(journal.recordWorkerExit("lost", "worker-1", 3000)).toBe(false);
  expect(journal.claimWithWorker("lost", "cap", worker)).toBe(true);
  expect(journal.recordWorkerExit("lost", "another-worker", 3000)).toBe(false);
  expect(journal.finalizeUncertainUpgradeRoomJob("lost", WATCHDOG_PROJECTION_CONSUMER)).toBe(false);

  expect(journal.recordWorkerExit("lost", "worker-1", 3000)).toBe(true);
  expect(journal.get("lost")?.state).toBe("failed");
  expect(journal.workerOutcome("lost")).toEqual({
    workerId: "worker-1",
    outcome: "worker-error",
    recordedAt: 3000,
  });
  expect(journal.recordWorkerExit("lost", "worker-1", 4000)).toBe(false);
  expect(journal.finalizeUncertainUpgradeRoomJob("lost", WATCHDOG_PROJECTION_CONSUMER)).toBe(true);
  expect(
    journal.listUnsettledForRun(room, "upgrade-room", WATCHDOG_PROJECTION_CONSUMER),
  ).toHaveLength(0);

  // The worker's own uncertain result is kept; only the still-live state is closed.
  expect(create("reported", 3)).toBe(true);
  expect(journal.claimWithWorker("reported", "cap", worker)).toBe(true);
  journal.recordWorkerOutcome("reported", "cap", "worker-1", "stream-unknown", 3500);
  expect(journal.finalizeUncertainUpgradeRoomJob("reported", WATCHDOG_PROJECTION_CONSUMER)).toBe(
    false,
  );
  expect(journal.recordWorkerExit("reported", "worker-1", 4000)).toBe(true);
  expect(journal.get("reported")?.state).toBe("failed");
  expect(journal.workerOutcome("reported")?.outcome).toBe("stream-unknown");
  expect(journal.finalizeUncertainUpgradeRoomJob("reported", WATCHDOG_PROJECTION_CONSUMER)).toBe(
    true,
  );

  // A worker that wrote its final receipt and died before closing the stream.
  expect(create("unclosed", 4)).toBe(true);
  expect(journal.claimWithWorker("unclosed", "cap", worker)).toBe(true);
  journal.finish("unclosed", "cap", "completed", {
    id: "terminal",
    kind: "terminal",
    payload: "{}",
  });
  expect(journal.recordWorkerExit("unclosed", "worker-1", 4500)).toBe(true);
  expect(journal.get("unclosed")?.state).toBe("completed");
  expect(journal.workerOutcome("unclosed")?.outcome).toBe("worker-error");

  // A stop the user asked for stays a stop.
  expect(create("stopping", 2)).toBe(true);
  expect(journal.claimWithWorker("stopping", "cap", worker)).toBe(true);
  expect(journal.requestCancel("stopping")).toBe("cancel-requested");
  expect(journal.recordWorkerExit("stopping", "worker-1", 5000)).toBe(true);
  expect(journal.get("stopping")?.state).toBe("cancelled");
});

function openJournal() {
  const dir = mkdtempSync(NodePath.join(tmpdir(), "t3-room-journal-"));
  const filename = NodePath.join(dir, "watchdog-journal.sqlite");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const open = () => {
    const journal = new WatchdogJournal(filename);
    cleanup.push(() => journal.close());
    return journal;
  };
  return { open };
}

it("adds the upgrade room tables idempotently and keeps their rows across reopen", () => {
  const { open } = openJournal();
  const first = open();
  expect(
    first.create({
      id: "job-1",
      executionId: "job-1",
      threadId: "autousage-upgrade-room",
      capability: "cap",
      context: {
        runId: "upgrade-room",
        nodeId: "turn-1",
        attempt: 1,
        provider: "codex",
        providerInstanceId: "codex",
      },
    }),
  ).toBe(true);
  expect(first.claim("job-1", "cap")).toBe(true);
  first.createUpgradeRoomJob({
    jobId: "job-1",
    turnEventId: "event-1",
    turnSequence: 7,
    request: "fix the bug",
    offlineQuestions: "decide",
    continuity: "fresh",
    projection: "{}",
    createdAt: 1_000,
  });
  first.recordUpgradeRoomResumeCursor("job-1", "cap", {
    providerInstanceId: "codex",
    cursor: '{"thread":"a"}',
    recordedAt: 2_000,
  });
  first.recordUpgradeRoomResumeCursor("job-1", "cap", {
    providerInstanceId: "codex",
    cursor: '{"thread":"b"}',
    recordedAt: 3_000,
  });
  first.recordUpgradeRoomQuestion("job-1", "cap", {
    requestId: "r1",
    questionId: "q1",
    question: "Which?",
    handledAs: "decided",
    recordedAt: 2_500,
  });
  first.recordUpgradeRoomQuestion("job-1", "cap", {
    requestId: "r1",
    questionId: "q1",
    question: "Which?",
    handledAs: "decided",
    recordedAt: 2_600,
  });
  first.writeUpgradeRoomBackendHeartbeat(5_000);
  first.writeUpgradeRoomBackendHeartbeat(4_000);
  first.admitUpgradeRoomTurn({
    turnEventId: "event-1",
    eventSequence: 7,
    messageId: "m1",
    queuedAt: 1,
    state: "started",
  });
  first.admitUpgradeRoomTurn({
    turnEventId: "event-2",
    eventSequence: 9,
    messageId: "m2",
    queuedAt: 2,
    state: "queued",
  });
  first.admitUpgradeRoomTurn({
    turnEventId: "event-2",
    eventSequence: 9,
    messageId: "m2",
    queuedAt: 3,
    state: "started",
  });
  expect(() =>
    first.recordUpgradeRoomResumeCursor("job-1", "wrong", {
      providerInstanceId: "codex",
      cursor: "{}",
      recordedAt: 1,
    }),
  ).toThrow();
  first.close();
  cleanup.pop();

  const reopened = open();
  expect(reopened.upgradeRoomJob("job-1")?.turnSequence).toBe(7);
  expect(reopened.latestUpgradeRoomResume()).toEqual({
    jobId: "job-1",
    providerInstanceId: "codex",
    cursor: '{"thread":"b"}',
  });
  expect(reopened.listUpgradeRoomQuestions("job-1")).toHaveLength(1);
  expect(reopened.upgradeRoomBackendHeartbeat()).toBe(5_000);
  expect(reopened.upgradeRoomTurnState("event-2")).toBe("queued");
  expect(
    reopened.listPendingUpgradeRoomTurns((id) => (id === "event-1" ? "job-1" : `job-for-${id}`)),
  ).toEqual([
    { turnEventId: "event-2", eventSequence: 9, messageId: "m2", queuedAt: 2, state: "queued" },
  ]);
  expect(reopened.latestUpgradeRoomTurnSequence()).toBe(9);
  expect(() =>
    reopened.createUpgradeRoomJob({
      jobId: "missing",
      turnEventId: "event-3",
      turnSequence: 1,
      request: "x",
      offlineQuestions: "wait",
      continuity: "fresh",
      projection: "{}",
      createdAt: 1,
    }),
  ).toThrow();
});
