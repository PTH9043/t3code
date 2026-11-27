import { expect, it, vi } from "vite-plus/test";
import { EventId, ThreadId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  makeThreadActivitySummaryReader,
  type ThreadToolActivity,
} from "@t3tools/client-runtime/state/thread-tool-activity";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolActivityRow, UnlinkedToolRecords } from "./ToolActivityRow";
import { deriveThreadTimelineWork } from "./threadTimelineWork";
import { maskedActivityRecord } from "@t3tools/client-runtime/state/thread-tool-activity";

const turnId = TurnId.make("turn"),
  createdAt = "2026-01-01T00:00:00Z";
const event = (id: string, kind: string, payload: unknown): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  turnId,
  createdAt,
  tone: "tool",
  kind,
  summary: "Command run",
  payload,
});
const done = {
  turnId,
  state: "completed" as const,
  requestedAt: createdAt,
  startedAt: createdAt,
  completedAt: createdAt,
  assistantMessageId: null,
};
const command = (id: string, cmd: string, kind = "tool.completed") =>
  event(id, kind, {
    itemType: "command_execution",
    reportedModel: "actual-worker",
    data: {
      toolName: "Bash",
      input: { command: cmd },
      result: { type: "tool_result", tool_use_id: id, is_error: false },
    },
  });

it("shows the caller's Claude report and the child's recorded DeepSeek assignment on their own calls", () => {
  const block = {
    executionId: "worker",
    messageId: "worker-result",
    attempt: 1,
    ownerThreadId: "room",
    runId: "run",
    nodeId: "researcher",
    title: "Research",
    displayName: "Researcher",
    role: "researcher",
    kind: "research",
    modelSelection: { instanceId: "worker-account", model: "DeepSeek" },
    status: "completed",
  };
  const worker = {
    executionId: block.executionId,
    messageId: block.messageId,
    attempt: block.attempt,
    providerInstanceId: block.modelSelection.instanceId,
    toolCallId: "same-call-id",
    itemType: "file_change",
  };
  const child = (id: string, kind: string, p: object) => ({ ...event(id, kind, p), turnId: null });
  const work = deriveThreadTimelineWork([
    event("assigned", "conversation.turn-assigned", {
      instanceId: "parent-account",
      model: "Claude",
    }),
    event("delegate", "tool.completed", {
      toolCallId: "same-call-id",
      reportedModel: "Claude",
      data: { toolName: "mcp__t3-code__workspace_delegate" },
    }),
    child("child-start", "tool.started", worker),
    child("child-update", "tool.updated", worker),
    child("child-done", "tool.completed", {
      ...worker,
      data: {
        item: {
          type: "fileChange",
          status: "completed",
          changes: [{ path: "src/work.ts", diff: "+edited" }],
        },
      },
    }),
    child("other-account", "tool.completed", {
      ...worker,
      toolCallId: "other",
      providerInstanceId: "different",
    }),
    child("wrong-attempt", "tool.completed", { ...worker, attempt: 2 }),
    child("wrong-exec", "tool.completed", { ...worker, executionId: "other" }),
    child("missing-message", "tool.completed", { ...worker, messageId: undefined, exitCode: 3 }),
    child("worker-report", "tool.completed", {
      ...worker,
      toolCallId: "reported",
      reportedModel: "native-model",
    }),
    child("block", "orchestra.block", block),
  ]);
  const activity = (id: string) =>
    work.find((row) => row.toolActivity?.eventIds.some((eventId) => eventId === id));
  const sender = activity("delegate")!.toolActivity!;
  const receipt = activity("child-start")!;
  expect(receipt.orchestraMessageId).toBe(block.messageId);
  expect(receipt.toolActivity).toMatchObject({
    executorSource: "execution-assigned",
    evidence: "confirmed-diff",
    confirmedDiffPaths: ["src/work.ts"],
    eventIds: ["child-start", "child-update", "child-done"],
  });
  expect(sender.executorLabel).toBe("위임 호출자 · 제공자 보고 · Claude");
  const html = renderToStaticMarkup(<ToolActivityRow group={receipt.toolActivity!} />);
  expect(html).toContain("하위 작업 배정 · worker-account · DeepSeek");
  expect(html).not.toContain("Claude");
  expect(activity("missing-message")?.toolActivity?.phase).toBe("failed");
  for (const id of ["wrong-attempt", "wrong-exec", "other-account", "missing-message"]) {
    expect(activity(id)?.orchestraMessageId).toBeUndefined();
    expect(activity(id)?.toolActivity?.executorSource).toBe("unknown");
  }
  expect(activity("worker-report")?.toolActivity?.executorLabel).toBe(
    "하위 작업 · 제공자 보고 · native-model",
  );
});

it("folds sixteen unlinked start signals only for a known settled turn, preserving calls without inferring links", () => {
  const starts = Array.from({ length: 16 }, (_, i) =>
    event("start" + i, "tool.started", { itemType: "command_execution" }),
  );
  const executions = Array.from({ length: 16 }, (_, i) => command("call" + i, "git log --oneline"));
  const updates = executions.map((e, i) => ({
    ...e,
    id: EventId.make("updated" + i),
    kind: "tool.updated",
  }));
  const activities = [...starts, ...updates, ...executions];
  const rows = deriveThreadTimelineWork(activities, done);
  const group = rows.find((e) => e.unlinkedToolSignals)!.unlinkedToolSignals!;
  expect(group).toHaveLength(starts.length);
  expect(new Set(group.map((g) => g.id))).toEqual(new Set(starts.map((e) => e.id)));
  const calls = rows.flatMap((e) => (e.toolActivity ? [e.toolActivity] : []));
  expect(calls).toHaveLength(16);
  for (const [index, execution] of executions.entries()) {
    const call = calls.find((g) => g.callId === execution.id);
    expect(call).toBeDefined();
    expect(new Set(call!.eventIds)).toEqual(new Set([execution.id, updates[index]!.id]));
  }

  expect(calls.every((g) => g.events.length === 2 && g.phase === "completed")).toBe(true);
  const folded = renderToStaticMarkup(<UnlinkedToolRecords groups={group} />);
  expect(folded).toContain("중간 기술 기록 16건");
  expect(folded).not.toContain("tool.started");
  expect(
    deriveThreadTimelineWork(activities, { ...done, state: "interrupted" }).filter(
      (row) => row.unlinkedToolSignals,
    ),
  ).toHaveLength(1);
  const live = deriveThreadTimelineWork(activities, {
    ...done,
    state: "running",
    completedAt: null,
  });
  expect(live.filter((e) => e.toolActivity)).toHaveLength(32);
  expect(live.some((e) => e.unlinkedToolSignals)).toBe(false);
});

it("puts the actual operation and executor in closed rows, keeping raw arguments and enrichment unmounted", () => {
  const events = [
    command("git", "git log --oneline"),
    command("test", "node --test"),
    event("read", "tool.completed", {
      reportedModel: "reader",
      data: {
        toolName: "Read",
        input: { file_path: "README.md" },
        result: { tool_use_id: "read" },
      },
    }),
  ];
  const rows = deriveThreadTimelineWork(events);
  const markup = new Map(
    rows.map((row) => [
      row.id,
      renderToStaticMarkup(<ToolActivityRow group={row.toolActivity!} />),
    ]),
  );
  expect(rows).toHaveLength(3);
  expect(new Set(markup.keys())).toEqual(new Set(["git", "test", "read"]));
  expect(markup.get("git")).toMatch(/이력/);
  expect(markup.get("test")).toContain("테스트");
  expect(markup.get("read")).toContain("README.md");
  expect(markup.get("read")).toContain("reader");
  expect(markup.get("git")).toContain("actual-worker");
  const all = [...markup.values()].join("");
  expect(all).not.toMatch(/Command run|git log --oneline|로컬 설명 작성 중|원본 기술 기록|요약자/);
});

it("renders ten historical calls and one nine-record disclosure from a stamped interrupted turn with a newer latest turn and no checkpoint", () => {
  const unknown = Array.from({ length: 9 }, (_, i) =>
    event("signal" + i, "tool.updated", {
      itemType: "command_execution",
      toolActivityTurnState: "interrupted",
    }),
  );
  const calls = Array.from({ length: 10 }, (_, i) =>
    ["tool.started", ...(i < 8 ? ["tool.updated"] : []), "tool.completed"].map((kind, j) => ({
      ...command("item" + i, "git log --oneline", kind),
      id: EventId.make("event-" + i + "-" + j),
      sequence: i * 3 + j,
    })),
  ).flat();
  const newer = { ...done, turnId: TurnId.make("newer") };
  const events = [...unknown, ...calls];
  expect(events).toHaveLength(37);
  const rows = deriveThreadTimelineWork(events, newer, []);
  const markup = renderToStaticMarkup(
    <section>
      {rows.map((row) =>
        row.toolActivity ? (
          <ToolActivityRow key={row.id} group={row.toolActivity} />
        ) : (
          <UnlinkedToolRecords key={row.id} groups={row.unlinkedToolSignals!} />
        ),
      )}
    </section>,
  );
  expect(markup.match(/<summary\b/g)).toHaveLength(11);
  expect(markup).toContain("중간 기술 기록 9건");
  expect(markup).not.toContain("tool.updated");
  const tools = rows.flatMap((row) => (row.toolActivity ? [row.toolActivity] : []));
  expect(new Set(tools.map((g) => g.callId))).toEqual(
    new Set(Array.from({ length: 10 }, (_, i) => "item" + i)),
  );
  expect(
    tools.every((g) => g.phase === "completed" && g.executorLabel.includes("actual-worker")),
  ).toBe(true);
  const current = deriveThreadTimelineWork(events, newer, [], turnId);
  expect(current.some((row) => row.unlinkedToolSignals)).toBe(false);
  expect(current.filter((row) => row.toolActivity)).toHaveLength(19);
  const unmarked = unknown.map((row) => ({ ...row, payload: { itemType: "command_execution" } }));
  expect(
    deriveThreadTimelineWork([...unmarked, ...calls], newer, []).some(
      (row) => row.unlinkedToolSignals,
    ),
  ).toBe(false);
});

it("shares one pending summary across both surfaces, drops failed cache entries, and sends only closed facts", async () => {
  const raw = command("history", "git log --oneline");
  const group = deriveThreadTimelineWork([raw])[0]!.toolActivity!;
  const run = vi.fn<Parameters<typeof makeThreadActivitySummaryReader>[1]>();
  let finish!: (value: null) => void;
  const pending = new Promise<null>((resolve) => {
    finish = resolve;
  });
  run
    .mockReturnValueOnce(pending)
    .mockResolvedValue({ summary: "이력을 확인했습니다.", model: "granite4.1:8b" });
  const read = makeThreadActivitySummaryReader(ThreadId.make("room"), run);
  const first = read(group);
  expect(read(group)).toBe(first);
  finish(null);
  await first;
  expect(await read(group)).toMatchObject({ model: "granite4.1:8b" });
  await read(group);
  expect(run).toHaveBeenCalledTimes(2);
  const changed: ThreadToolActivity = { ...group, phase: "failed" };
  await read(changed);
  expect(run).toHaveBeenCalledTimes(3);
  const sent = JSON.stringify(run.mock.calls);
  expect(sent).not.toMatch(/git log|actual-worker|README|tool.completed/);
  expect(run.mock.calls[0]![0].activityId).toBe(group.eventIds[0]);
});

it("shows technical command syntax but masks arbitrary shell literals and credential values", () => {
  const raw = command(
    "safe",
    "git fetch https://test.invalid/?token=FIXTURE_SECRET ; git log --oneline",
  );
  const group = deriveThreadTimelineWork([raw])[0]!.toolActivity!;
  expect(maskedActivityRecord(raw, group)).toContain("git fetch ••• ; git log --oneline");
  expect(maskedActivityRecord(raw, group)).not.toMatch(/FIXTURE_SECRET|test.invalid/);
});
