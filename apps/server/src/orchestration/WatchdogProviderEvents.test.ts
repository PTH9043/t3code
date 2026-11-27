// @effect-diagnostics nodeBuiltinImport:off - The journal is a real SQLite file.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";
import {
  ProviderDriverKind,
  ProviderExecutionContext,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { afterEach, expect, it } from "vite-plus/test";
import { WatchdogJournal } from "./WatchdogJournal.ts";
import { WatchdogProviderEvents } from "./WatchdogProviderEvents.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

const execution = ProviderExecutionContext.make({
  executionId: "job-1" as ProviderExecutionContext["executionId"],
  ownerThreadId: ThreadId.make("autousage-upgrade-room"),
  runId: "upgrade-room" as ProviderExecutionContext["runId"],
  nodeId: "turn-1" as ProviderExecutionContext["nodeId"],
  attempt: 1,
});
const provider = ProviderDriverKind.make("claudeAgent");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");

function recorderForRunningJob() {
  const dir = mkdtempSync(NodePath.join(tmpdir(), "t3-watchdog-events-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const journal = new WatchdogJournal(NodePath.join(dir, "watchdog-journal.sqlite"));
  cleanup.push(() => journal.close());
  journal.create({
    id: "job-1",
    executionId: "job-1",
    threadId: execution.ownerThreadId,
    capability: "cap",
    context: {
      runId: execution.runId,
      nodeId: execution.nodeId,
      attempt: 1,
      provider,
      providerInstanceId,
    },
  });
  journal.claim("job-1", "cap");
  const recorder = new WatchdogProviderEvents({
    journal,
    jobId: "job-1",
    capability: "cap",
    sessionId: ThreadId.make("job-1"),
    provider,
    providerInstanceId,
    execution,
  });
  return { journal, recorder };
}

let counter = 0;
const event = (type: string, payload: unknown) =>
  ({
    eventId: `event-${++counter}`,
    provider,
    providerInstanceId,
    threadId: "job-1",
    createdAt: "2026-11-20T00:00:00.000Z",
    execution,
    type,
    payload,
  }) as unknown as ProviderRuntimeEvent;

it("does not treat Claude's state, configuration and task wind-down notices after a completed turn as late work", () => {
  const { journal, recorder } = recorderForRunningJob();
  recorder.record(event("turn.completed", { state: "completed" }));
  expect(journal.get("job-1")?.state).toBe("completed");

  recorder.record(event("session.configured", { config: {} }));
  recorder.record(event("session.state.changed", { state: "ready" }));
  recorder.record(event("task.progress", { taskId: "task-1", description: "still running" }));
  recorder.record(event("task.completed", { taskId: "task-1", status: "stopped" }));
  recorder.record(event("session.exited", {}));

  expect(recorder.hasUnexpectedLateEvent).toBe(false);
});

it("does not treat OpenCode's abort error from our own stop as late work", () => {
  const { recorder } = recorderForRunningJob();
  recorder.record(event("turn.completed", { state: "completed" }));
  recorder.record(
    event("runtime.error", {
      message: "Aborted",
      class: "provider_error",
      detail: { name: "MessageAbortedError", data: { message: "Aborted" } },
    }),
  );
  expect(recorder.hasUnexpectedLateEvent).toBe(false);

  recorder.record(event("runtime.error", { message: "Boom", class: "provider_error" }));
  expect(recorder.hasUnexpectedLateEvent).toBe(true);
});

it("still flags work that runs after a completed turn", () => {
  const { recorder } = recorderForRunningJob();
  recorder.record(event("turn.completed", { state: "completed" }));
  recorder.record(event("content.delta", { streamKind: "assistant_text", delta: "more" }));

  expect(recorder.hasUnexpectedLateEvent).toBe(true);
});
