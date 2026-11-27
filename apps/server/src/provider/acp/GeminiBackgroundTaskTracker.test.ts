import { EventId, type ProviderRuntimeEvent, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import {
  createGeminiBackgroundTaskTracker,
  normalizeWhitelistedAntigravityLogPath,
} from "./GeminiBackgroundTaskTracker.ts";

describe("GeminiBackgroundTaskTracker", () => {
  it("whitelists only Antigravity .system_generated/tasks log files", () => {
    expect(
      normalizeWhitelistedAntigravityLogPath(
        "C:/Users/%ED%99%8D%EA%B8%B8%EB%8F%99/.gemini/antigravity/brain/conv-1/.system_generated/tasks/task-42.log",
      ),
    ).toBe(
      "C:\\Users\\홍길동\\.gemini\\antigravity\\brain\\conv-1\\.system_generated\\tasks\\task-42.log",
    );
    expect(normalizeWhitelistedAntigravityLogPath("C:/Users/user/.env")).toBeUndefined();
    expect(
      normalizeWhitelistedAntigravityLogPath(
        "C:/Users/user/.system_generated/tasks/../../secrets.txt",
      ),
    ).toBeUndefined();
  });

  it("emits task.started, redacted tail task.progress, and task.completed for background run_command", async () => {
    const events: ProviderRuntimeEvent[] = [];
    let seq = 0;
    let fakeLog = { size: 0, text: "" };
    const tracker = createGeminiBackgroundTaskTracker({
      threadId: ThreadId.make("thread-gemini-bg"),
      pollIntervalMs: 0,
      makeEventStamp: () =>
        Effect.succeed({
          eventId: EventId.make(`evt-${++seq}`),
          createdAt: "2026-11-21T02:00:00.000Z",
        }),
      emitEvent: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      readLogTail: (_filePath, lastSize) =>
        fakeLog.size > lastSize ? { size: fakeLog.size, text: fakeLog.text } : null,
    });

    const turnId = TurnId.make("turn-1");
    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call-bg-1",
          kind: "execute",
          title: "run_command",
          status: "completed",
          data: {
            rawInput: {
              toolSummary: "Capture full UI screenshots",
              CommandLine: "python scripts/capture_all.py",
            },
            rawOutput: {
              output: [
                "Tool is running as a background task with task id: conv-1/task-99",
                "Task logs are available at: file:///C:/Users/demo/.gemini/antigravity/brain/conv-1/.system_generated/tasks/task-99.log",
              ].join("\n"),
            },
          },
        },
        turnId,
        "gemini-4-neon",
      ),
    );

    expect(tracker.activeCount()).toBe(1);
    expect(events[0]).toMatchObject({
      type: "task.started",
      payload: {
        taskId: "conv-1/task-99",
        taskType: "local_bash",
        agentKind: "background",
        title: "Capture full UI screenshots",
        model: "gemini-4-neon",
      },
    });

    // Simulate log growth with a secret token that must be redacted
    fakeLog = {
      size: 120,
      text: "[14/28] modal-settings.png captured Bearer supersecrettoken12345\n",
    };
    await Effect.runPromise(tracker.pollOnce());
    expect(events[1]).toMatchObject({
      type: "task.progress",
      payload: {
        taskId: "conv-1/task-99",
        description: "[14/28] modal-settings.png captured Bearer •••",
      },
    });
    expect(JSON.stringify(events[1])).not.toContain("supersecrettoken12345");

    // Simulate task completion marker in log
    fakeLog = {
      size: 200,
      text: "Saved 28/28 screenshots\nCommand exited with code 0.\n",
    };
    await Effect.runPromise(tracker.pollOnce());
    expect(events[2]).toMatchObject({
      type: "task.completed",
      payload: {
        taskId: "conv-1/task-99",
        status: "completed",
      },
    });
    expect(tracker.activeCount()).toBe(0);
    tracker.dispose();
  });

  it("tracks invoke_subagent and completes on manage_task kill", async () => {
    const events: ProviderRuntimeEvent[] = [];
    let seq = 0;
    const tracker = createGeminiBackgroundTaskTracker({
      threadId: ThreadId.make("thread-gemini-sub"),
      pollIntervalMs: 0,
      makeEventStamp: () =>
        Effect.succeed({
          eventId: EventId.make(`evt-${++seq}`),
          createdAt: "2026-11-21T02:00:00.000Z",
        }),
      emitEvent: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    });

    const convId = "12345678-1234-4234-8234-123456789abc";
    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call-sub-1",
          title: "invoke_subagent",
          status: "completed",
          data: {
            rawInput: { Role: "Codebase Researcher", TypeName: "research" },
            rawOutput: { output: `Launched subagent conversationId: ${convId}` },
          },
        },
        TurnId.make("turn-2"),
        "gemini-4-neon",
      ),
    );
    expect(events[0]).toMatchObject({
      type: "task.started",
      payload: {
        taskId: convId,
        taskType: "local_agent",
        agentKind: "agent",
        role: "Codebase Researcher",
      },
    });

    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call-kill-1",
          title: "manage_subagents",
          status: "completed",
          data: {
            rawInput: { Action: "kill", ConversationIds: [convId] },
          },
        },
        TurnId.make("turn-2"),
        "gemini-4-neon",
      ),
    );
    expect(events[1]).toMatchObject({
      type: "task.completed",
      payload: {
        taskId: convId,
        status: "stopped",
      },
    });
    expect(tracker.activeCount()).toBe(0);
    tracker.dispose();
  });

  it("tracks run_workflow with null rawOutput, auto-discovers manage_task TaskIds, and parses ACP content blocks", async () => {
    const events: ProviderRuntimeEvent[] = [];
    let seq = 0;
    const tracker = createGeminiBackgroundTaskTracker({
      threadId: ThreadId.make("thread-gemini-acp-real"),
      pollIntervalMs: 0,
      makeEventStamp: () =>
        Effect.succeed({
          eventId: EventId.make(`evt-${++seq}`),
          createdAt: "2026-11-22T02:40:00.000Z",
        }),
      emitEvent: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    });

    const turnId = TurnId.make("turn-wf-1");
    // 1. run_workflow in_progress with rawOutput: null (exact Antigravity ACP shape)
    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call_wf_1",
          kind: "other",
          title: "Run run_workflow",
          status: "inProgress",
          data: {
            rawInput: { Description: "Run Phase 3 study", Script: "print('hi')" },
            rawOutput: null,
            content: null,
          },
        },
        turnId,
        "gemini-4-neon",
      ),
    );
    expect(tracker.activeCount()).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "task.started",
      payload: {
        taskId: "workflow:call_wf_1",
        taskType: "local_agent",
        title: "Run Phase 3 study",
      },
    });

    // 2. run_workflow completed -> completes automatically
    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call_wf_1",
          kind: "other",
          title: "Run run_workflow",
          status: "completed",
          data: {
            rawInput: { Description: "Run Phase 3 study", Script: "print('hi')" },
            rawOutput: null,
            content: null,
          },
        },
        turnId,
        "gemini-4-neon",
      ),
    );
    expect(tracker.activeCount()).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "task.completed",
      payload: {
        taskId: "workflow:call_wf_1",
        status: "completed",
      },
    });

    // 3. manage_task status for previously unseen TaskId (with rawOutput: null) auto-discovers it
    const taskId = "a5e7ce30-8beb-4ea0-850b-7e5f22b44529/task-995";
    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call_mt_1",
          kind: "other",
          title: "Run manage_task",
          status: "completed",
          data: {
            rawInput: { Action: "status", TaskId: taskId },
            rawOutput: null,
            content: null,
          },
        },
        turnId,
        "gemini-4-neon",
      ),
    );
    expect(tracker.activeCount()).toBe(1);
    expect(events.some((e) => e.type === "task.started" && e.payload.taskId === taskId)).toBe(true);
    expect(events.some((e) => e.type === "task.progress" && e.payload.taskId === taskId)).toBe(
      true,
    );

    // 4. Turn ends -> non-turnBound manage_task background job stays alive!
    await Effect.runPromise(tracker.onTurnEnded(turnId, "completed"));
    expect(tracker.activeCount()).toBe(1);

    // 5. manage_task kill closes it
    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call_mt_kill",
          kind: "other",
          title: "Run manage_task",
          status: "completed",
          data: {
            rawInput: { Action: "kill", TaskId: taskId },
            rawOutput: null,
          },
        },
        undefined,
        "gemini-4-neon",
      ),
    );
    expect(tracker.activeCount()).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "task.completed",
      payload: { taskId, status: "stopped" },
    });

    // 6. ACP content array text extraction + schedule fallback ID + swarm add/kill
    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call_content_bg",
          kind: "execute",
          title: "run_command",
          status: "completed",
          data: {
            rawInput: { toolSummary: "Long build", CommandLine: "python build.py" },
            rawOutput: null,
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Tool is running as a background task with task id: conv-9/task-77",
                },
              },
            ],
          },
        },
        turnId,
        "gemini-4-neon",
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: "task.started",
      payload: { taskId: "conv-9/task-77", title: "Long build" },
    });

    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call_sched_1",
          kind: "other",
          title: "Run schedule",
          status: "completed",
          data: {
            rawInput: { DurationSeconds: 60, Prompt: "Check build progress" },
            rawOutput: null,
          },
        },
        turnId,
        "gemini-4-neon",
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: "task.started",
      payload: { taskId: "schedule:call_sched_1", taskType: "monitor" },
    });

    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call_swarm_add",
          kind: "other",
          title: "Run swarm",
          status: "completed",
          data: {
            rawInput: { action: "add", name: "worker-a", brief: "Analyze tests" },
            rawOutput: null,
          },
        },
        turnId,
        "gemini-4-neon",
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: "task.started",
      payload: { taskId: "swarm:worker-a", taskType: "local_agent" },
    });

    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call_swarm_kill",
          kind: "other",
          title: "Run swarm",
          status: "completed",
          data: {
            rawInput: { action: "kill", name: "worker-a" },
            rawOutput: null,
          },
        },
        turnId,
        "gemini-4-neon",
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: "task.completed",
      payload: { taskId: "swarm:worker-a", status: "stopped" },
    });
    tracker.dispose();
  });

  it("prevents zombie tasks: resolves on-disk task logs, expires one-shot schedules, cleans stale blind status tasks, and emits completion on eviction", async () => {
    const events: ProviderRuntimeEvent[] = [];
    let seq = 0;
    let nowMs = 1_700_000_000_000;
    const fakeLogs = new Map<string, { size: number; text: string }>([
      [
        "fake/already-done.log",
        { size: 80, text: "Stage 1 finished.\nCommand exited with code 0.\n" },
      ],
      ["fake/running-then-done.log", { size: 40, text: "[1/2] Processing rows...\n" }],
    ]);

    const tracker = createGeminiBackgroundTaskTracker({
      threadId: ThreadId.make("thread-gemini-no-zombies"),
      pollIntervalMs: 0,
      now: () => nowMs,
      makeEventStamp: () =>
        Effect.succeed({
          eventId: EventId.make(`evt-${++seq}`),
          createdAt: "2026-11-22T03:00:00.000Z",
        }),
      emitEvent: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      resolveTaskLogPath: (taskId) => {
        if (taskId === "conv-1/task-done") return "fake/already-done.log";
        if (taskId === "conv-1/task-live") return "fake/running-then-done.log";
        return undefined;
      },
      readLogTail: (filePath, lastSize) => {
        const entry = fakeLogs.get(filePath);
        return entry && entry.size > lastSize ? entry : null;
      },
    });

    const turn1 = TurnId.make("turn-1");

    // 1. manage_task(status) with rawOutput: null for an already-exited task on disk must NOT register a zombie!
    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call-done",
          title: "Run manage_task",
          status: "completed",
          data: { rawInput: { Action: "status", TaskId: "conv-1/task-done" }, rawOutput: null },
        },
        turn1,
      ),
    );
    expect(tracker.activeCount()).toBe(0);

    // 2. manage_task(status) for a live task on disk attaches logTail & auto-completes when log exits!
    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call-live",
          title: "Run manage_task",
          status: "completed",
          data: { rawInput: { Action: "status", TaskId: "conv-1/task-live" }, rawOutput: null },
        },
        turn1,
      ),
    );
    expect(tracker.activeCount()).toBe(1);
    fakeLogs.set("fake/running-then-done.log", {
      size: 120,
      text: "[2/2] Done.\nCommand exited with code 0.\n",
    });
    await Effect.runPromise(tracker.pollOnce());
    expect(tracker.activeCount()).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "task.completed",
      payload: { taskId: "conv-1/task-live", status: "completed" },
    });

    // 3. One-shot schedule timer expires automatically after DurationSeconds + grace
    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call-sched-expire",
          title: "Run schedule",
          status: "completed",
          data: { rawInput: { DurationSeconds: 30, Prompt: "Check stage 1" }, rawOutput: null },
        },
        turn1,
      ),
    );
    expect(tracker.activeCount()).toBe(1);
    nowMs += 36_000;
    await Effect.runPromise(tracker.pollOnce());
    expect(tracker.activeCount()).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "task.completed",
      payload: { taskId: "schedule:call-sched-expire", status: "completed" },
    });

    // 4. Blind manage_task(status) without any log file auto-cleans after 120s of inactivity
    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call-blind",
          title: "Run manage_task",
          status: "completed",
          data: { rawInput: { Action: "status", TaskId: "conv-x/task-blind" }, rawOutput: null },
        },
        turn1,
      ),
    );
    expect(tracker.activeCount()).toBe(1);
    nowMs += 121_000;
    await Effect.runPromise(tracker.pollOnce());
    expect(tracker.activeCount()).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "task.completed",
      payload: { taskId: "conv-x/task-blind", status: "completed" },
    });

    // 5. Overflowing MAX_CONCURRENT_TASKS emits task.completed for evicted oldest task
    for (let i = 0; i < 13; i += 1) {
      await Effect.runPromise(
        tracker.observeToolCall(
          {
            toolCallId: `call-fill-${i}`,
            title: "Run manage_task",
            status: "completed",
            data: {
              rawInput: { Action: "status", TaskId: `conv-fill/task-${i}` },
              rawOutput: null,
            },
          },
          turn1,
        ),
      );
    }
    expect(tracker.activeCount()).toBe(12);
    expect(
      events.some((e) => e.type === "task.completed" && e.payload.taskId === "conv-fill/task-0"),
    ).toBe(true);
    tracker.dispose();
  });

  it("ignores historical logs without exit code markers and auto-completes active logs after 90s of mtime inactivity", async () => {
    const events: ProviderRuntimeEvent[] = [];
    let seq = 0;
    let nowMs = 1_700_000_200_000;
    const logs = new Map<string, { size: number; mtimeMs: number; text: string }>([
      [
        "fake/historical-3075.log",
        {
          size: 1792,
          // 5 hours old, no "Command exited with code" line — exact Antigravity task log shape
          mtimeMs: nowMs - 20_000_000,
          text: "CLEANED_TMP: True\n",
        },
      ],
      [
        "fake/active-no-exit.log",
        {
          size: 120,
          mtimeMs: nowMs - 2_000,
          text: "Stage 1 50% complete\n",
        },
      ],
    ]);

    const tracker = createGeminiBackgroundTaskTracker({
      threadId: ThreadId.make("thread-gemini-mtime"),
      pollIntervalMs: 0,
      now: () => nowMs,
      makeEventStamp: () =>
        Effect.succeed({
          eventId: EventId.make(`evt-${++seq}`),
          createdAt: "2026-11-22T03:55:00.000Z",
        }),
      emitEvent: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      resolveTaskLogPath: (taskId) => {
        if (taskId === "conv-1/task-3075") return "fake/historical-3075.log";
        if (taskId === "conv-1/task-active") return "fake/active-no-exit.log";
        return undefined;
      },
      readLogStat: (filePath) => {
        const entry = logs.get(filePath);
        return entry ? { size: entry.size, mtimeMs: entry.mtimeMs } : null;
      },
      readLogTail: (filePath, lastSize) => {
        const entry = logs.get(filePath);
        return entry && entry.size > lastSize ? entry : null;
      },
    });

    const turn1 = TurnId.make("turn-mtime");

    // 1. Historical log (5 hours old, no exit code) must NEVER register
    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call-hist",
          title: "Run manage_task",
          status: "completed",
          data: { rawInput: { Action: "status", TaskId: "conv-1/task-3075" }, rawOutput: null },
        },
        turn1,
      ),
    );
    expect(tracker.activeCount()).toBe(0);

    // 2. Fresh log without exit code registers, then auto-completes once mtime is stale for >= 90s
    await Effect.runPromise(
      tracker.observeToolCall(
        {
          toolCallId: "call-fresh",
          title: "Run manage_task",
          status: "completed",
          data: { rawInput: { Action: "status", TaskId: "conv-1/task-active" }, rawOutput: null },
        },
        turn1,
      ),
    );
    expect(tracker.activeCount()).toBe(1);

    nowMs += 95_000;
    await Effect.runPromise(tracker.pollOnce());
    expect(tracker.activeCount()).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "task.completed",
      payload: { taskId: "conv-1/task-active", status: "completed" },
    });
    tracker.dispose();
  });
});
