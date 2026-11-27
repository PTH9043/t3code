import {
  MessageId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
  WorkspaceOrchestraBlock,
  type WorkspaceTaskNode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveOrchestraTaskLists,
  orchestraTaskIsExpanded,
  orchestraTaskMatchesFilter,
  type OrchestraRunSnapshot,
} from "./orchestraTaskList.ts";

const owner = ThreadId.make("owner");
const at = "2026-09-13T04:00:00.000Z";
const decodeBlock = Schema.decodeUnknownSync(WorkspaceOrchestraBlock);
const block = (attempt: number, status = "running", runId = "run") =>
  decodeBlock({
    executionId: `${runId}:compute:${attempt}`,
    ownerThreadId: owner,
    runId,
    nodeId: "compute",
    attempt,
    messageId: `${runId}:message:${attempt}`,
    title: "계산",
    instruction: "주문 합산",
    displayName: "Codex",
    role: "implementer",
    kind: "implementation",
    modelSelection: { instanceId: "codex", model: attempt === 1 ? "first-model" : "second-model" },
    status,
  });
const node = (
  id: string,
  order: number,
  status: WorkspaceTaskNode["status"],
): WorkspaceTaskNode => ({
  id: WorkspaceTaskNodeId.make(id),
  order,
  status,
  kind: "implementation",
  agent: "codex",
  role: "implementer",
  participantId: null,
  threadId: owner,
  parkedQuestion: null,
  worktreePath: null,
  branch: null,
  title: id,
  handoff: {
    task: "task",
    goal: "goal",
    context: "",
    input: "",
    constraints: [],
    expectedOutput: "result",
    successCriteria: ["pass"],
  },
  dependsOn: [],
  validationTargetId: null,
  priority: 0,
  maxAttempts: 3,
  attempts: [],
  output: null,
  error: null,
  failureClassification: null,
  confidence: null,
  validation: null,
  startedAt: null,
  completedAt: null,
});
const run = (nodes: WorkspaceTaskNode[]): OrchestraRunSnapshot => ({
  id: WorkspaceCollaborationRunId.make("run"),
  task: "검증 작업",
  status: "running",
  createdAt: at,
  meeting: null,
  graph: {
    revision: 1,
    status: "executing",
    nodes,
    changes: [],
    nextAction: "continue",
    overallConfidence: null,
    repairApproved: null,
    memoryCandidates: [],
  },
});
const message = (id: MessageId, text: string, streaming = false) => ({
  id,
  text,
  streaming,
  createdAt: at,
});

describe("orchestra task lists", () => {
  it("distinguishes unavailable providers, rejected validation, and opaque execution errors", () => {
    const provider = {
      ...node("provider", 0, "failed"),
      error: "Provider instance missing assigned to role 'researcher' is unavailable",
    };
    const worker = { ...node("worker", 1, "failed"), error: "검증 반려 요약" };
    const validation = {
      ...node("validator", 2, "completed"),
      validation: {
        targetNodeId: worker.id,
        verdict: "fail" as const,
        confidence: "high" as const,
        summary: "잘못된 주장",
        evidence: ["stop_loss_engine.py:26"],
        failureClassification: "information" as const,
        nextAction: "근거 정정",
        recordedAt: at,
      },
    };
    const unknown = { ...node("unknown", 3, "failed"), error: "unexpected upstream issue" };
    const [list] = deriveOrchestraTaskLists({
      ownerThreadId: owner,
      runs: [run([provider, worker, validation, unknown])],
      blocks: new Map(),
      messages: [],
    });
    expect(list?.tasks[0]?.diagnostic).toMatchObject({ kind: "provider-unavailable" });
    expect(list?.tasks[1]?.diagnostic).toMatchObject({
      kind: "validation-rejected",
      evidence: ["stop_loss_engine.py:26"],
      action: "근거 정정",
    });
    expect(list?.tasks[3]?.diagnostic).toMatchObject({
      kind: "execution-error",
      label: "실행 오류 · 상세 원인 미확인",
    });
  });

  it("separates missing handoff files, hash mismatches, and permission failures without inferring other causes", () => {
    const input = [
      { ...node("missing", 0, "failed"), error: "handoff input file ENOENT" },
      { ...node("hash", 1, "failed"), error: "인계 파일 해시 불일치" },
      { ...node("permission", 2, "failed"), error: "입력 파일 EACCES" },
      { ...node("other", 3, "failed"), error: "ENOENT" },
    ];
    const [list] = deriveOrchestraTaskLists({
      ownerThreadId: owner,
      runs: [run(input)],
      blocks: new Map(),
      messages: [],
    });
    expect(list?.tasks.map((task) => task.diagnostic?.label)).toEqual([
      "입력 파일 없음",
      "입력 자료 해시 불일치",
      "입력 자료 접근 권한 오류",
      "실행 오류 · 상세 원인 미확인",
    ]);
  });

  it("distinguishes safety refusal and uncertain delivery from an ordinary execution failure", () => {
    const refusal = {
      ...node("refusal", 0, "awaiting-user"),
      error: "Your message was flagged by Claude's safeguards.",
    };
    const delivery = {
      ...node("delivery", 1, "awaiting-user"),
      error: "이전 입력의 전달·종료가 미확인입니다. 자동 재전송을 중단했습니다.",
    };
    const [list] = deriveOrchestraTaskLists({
      ownerThreadId: owner,
      runs: [run([refusal, delivery])],
      blocks: new Map(),
      messages: [],
    });
    expect(list?.tasks[0]?.diagnostic?.kind).toBe("safety-refusal");
    expect(list?.tasks[1]?.diagnostic?.kind).toBe("delivery-unconfirmed");
    const [sessionBlock] = deriveOrchestraTaskLists({
      ownerThreadId: owner,
      runs: [run([{ ...refusal, error: "API Error: Opus 5.5's safeguards flagged this session" }])],
      blocks: new Map(),
      messages: [],
    });
    expect(sessionBlock?.tasks[0]?.diagnostic?.kind).toBe("safety-refusal");
  });

  it("does not blame a later failed attempt on an older validation receipt", () => {
    const later = {
      ...node("worker", 0, "failed"),
      error: "later execution failure",
      attempts: [
        {
          number: 1,
          agent: "codex" as const,
          role: "implementer" as const,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          strategy: "retry",
          threadId: owner,
          status: "failed" as const,
          output: null,
          error: "later execution failure",
          failureClassification: "tool" as const,
          confidence: null,
          startedAt: "2026-09-14T04:00:00.000Z",
          completedAt: "2026-09-14T04:00:01.000Z",
        },
      ],
    };
    const old = {
      ...node("validator", 1, "completed"),
      validation: {
        targetNodeId: later.id,
        verdict: "fail" as const,
        confidence: "high" as const,
        summary: "old",
        evidence: [],
        failureClassification: "validation" as const,
        nextAction: "old",
        recordedAt: at,
      },
    };
    const [list] = deriveOrchestraTaskLists({
      ownerThreadId: owner,
      runs: [run([later, old])],
      blocks: new Map(),
      messages: [],
    });
    expect(list?.tasks[0]?.diagnostic?.kind).toBe("execution-error");
  });

  it("explains dependencies and totals only completed attempt durations", () => {
    const producer = {
      ...node("compute", 0, "running"),
      attempts: [
        {
          number: 1,
          agent: "codex" as const,
          role: "implementer" as const,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          strategy: "first",
          threadId: owner,
          status: "failed" as const,
          output: null,
          error: "failure",
          failureClassification: null,
          confidence: null,
          startedAt: at,
          completedAt: "2026-09-13T04:00:05.500Z",
        },
      ],
    };
    const dependent = { ...node("report", 1, "blocked"), dependsOn: [producer.id] };
    const [list] = deriveOrchestraTaskLists({
      ownerThreadId: owner,
      runs: [run([producer, dependent])],
      blocks: new Map(),
      messages: [],
    });
    expect(list?.tasks[0]?.completedAttemptMs).toBe(5500);
    expect(list?.tasks[0]?.waitReason).toBeNull();
    expect(list?.tasks[1]?.completedAttemptMs).toBeNull();
    expect(list?.tasks[1]?.waitReason).toBe("선행 작업 대기: compute");
    const validation = {
      ...node("validate", 2, "queued"),
      kind: "validation" as const,
      validationTargetId: producer.id,
      dependsOn: [producer.id],
    };
    const [validating] = deriveOrchestraTaskLists({
      ownerThreadId: owner,
      runs: [run([{ ...producer, status: "awaiting-validation" }, validation])],
      blocks: new Map(),
      messages: [],
    });
    expect(validating?.tasks[1]?.waitReason).toBe("실행 순서 배정 대기");
    const [settled] = deriveOrchestraTaskLists({
      ownerThreadId: owner,
      runs: [{ ...run([producer, dependent]), status: "cancelled" }],
      blocks: new Map(),
      messages: [],
    });
    expect(settled?.tasks.every((task) => task.waitReason === null)).toBe(true);
  });
  it("shows the latest received activity for the current attempt without mixing retries or conversations", () => {
    const first = block(1, "failed");
    const current = block(2);
    const input = {
      ownerThreadId: owner,
      runs: [],
      blocks: new Map([first, current].map((entry) => [entry.messageId, entry])),
      messages: [message(current.messageId, "unchanged assistant text", true)],
      workEntries: [
        {
          orchestraMessageId: current.messageId,
          label: "검증 명령 실행 중",
          createdAt: "2026-09-13T04:02:00.000Z",
        },
        { orchestraMessageId: current.messageId, label: "older event", createdAt: at },
        {
          orchestraMessageId: first.messageId,
          label: "late previous attempt",
          createdAt: "2026-09-13T04:03:00.000Z",
        },
        {
          orchestraMessageId: "another-conversation",
          label: "foreign event",
          createdAt: "2026-09-13T04:04:00.000Z",
        },
      ],
    };
    expect(deriveOrchestraTaskLists(input)[0]?.tasks[0]?.progress).toEqual({
      summary: "검증 명령 실행 중",
      createdAt: "2026-09-13T04:02:00.000Z",
    });
    expect(
      deriveOrchestraTaskLists({
        ...input,
        messages: [{ ...input.messages[0]!, updatedAt: "2026-09-13T04:05:00.000Z" }],
      })[0]?.tasks[0]?.progress,
    ).toEqual({
      summary: "AI 응답 수신 · unchanged assistant text",
      createdAt: "2026-09-13T04:05:00.000Z",
    });
    expect(
      deriveOrchestraTaskLists({
        ...input,
        messages: [
          {
            ...input.messages[0]!,
            text: "## [보고]\nDefiLlama 락업 데이터 197개 분석 중",
            streaming: true,
            updatedAt: "2026-09-13T04:06:00.000Z",
          },
        ],
      })[0]?.tasks[0]?.progress,
    ).toEqual({
      summary: "AI 응답 수신 · DefiLlama 락업 데이터 197개 분석 중",
      createdAt: "2026-09-13T04:06:00.000Z",
    });
  });
  it("groups retries under one task and keeps full live bodies, original models and instructions", () => {
    const first = block(1, "failed");
    const second = block(2);
    const full = "full output ".repeat(1000);
    const [list] = deriveOrchestraTaskLists({
      ownerThreadId: owner,
      runs: [],
      blocks: new Map([
        [first.messageId, first],
        [second.messageId, second],
      ]),
      messages: [
        message(first.messageId, "failed evidence"),
        message(second.messageId, full, true),
      ],
    });
    expect(list?.tasks).toHaveLength(1);
    expect(
      list?.tasks[0]?.attempts.map((attempt) => [
        attempt.number,
        attempt.modelSelection?.model,
        attempt.text,
      ]),
    ).toEqual([
      [1, "first-model", "failed evidence"],
      [2, "second-model", full],
    ]);
    expect(list?.tasks[0]?.attempts[1]).toMatchObject({
      streaming: true,
      instruction: "주문 합산",
      isSummary: false,
    });
  });

  it("shows unstarted tasks, preserves graph order on status changes, and waits for validation", () => {
    const producer = block(1, "completed");
    const build = (status: WorkspaceTaskNode["status"]) =>
      deriveOrchestraTaskLists({
        ownerThreadId: owner,
        runs: [run([node("report", 2, "blocked"), node("compute", 1, status)])],
        blocks: new Map([[producer.messageId, producer]]),
        messages: [message(producer.messageId, "result")],
      })[0]!;
    const pending = build("awaiting-validation");
    expect(pending.tasks.map((task) => task.id)).toEqual(["compute", "report"]);
    expect(pending.tasks[1]?.status).toBe("blocked");
    expect(orchestraTaskMatchesFilter(pending.tasks[0]!, "completed")).toBe(false);
    expect(build("completed").tasks.map((task) => task.id)).toEqual(
      pending.tasks.map((task) => task.id),
    );
  });

  it("shows a new retry streaming before the graph query has refreshed", () => {
    const retry = block(2, "running");
    const [list] = deriveOrchestraTaskLists({
      ownerThreadId: owner,
      runs: [run([node("compute", 1, "failed")])],
      blocks: new Map([[retry.messageId, retry]]),
      messages: [message(retry.messageId, "new live output", true)],
    });
    expect(list?.tasks[0]?.status).toBe("running");
    expect(orchestraTaskIsExpanded(list!.tasks[0]!)).toBe(true);
  });

  it("keeps runs and owner conversations separate even when node IDs match", () => {
    const first = block(1, "completed");
    const otherRun = block(1, "running", "run-b");
    const foreign = {
      ...block(1, "running", "foreign"),
      ownerThreadId: ThreadId.make("another-owner"),
    };
    const lists = deriveOrchestraTaskLists({
      ownerThreadId: owner,
      runs: [],
      blocks: new Map([first, otherRun, foreign].map((entry) => [entry.messageId, entry])),
      messages: [first, otherRun, foreign].map((entry) => message(entry.messageId, entry.runId)),
    });
    expect(lists.map((list) => list.id)).toEqual(["run", "run-b"]);
    expect(lists.map((list) => list.tasks[0]?.attempts[0]?.text)).toEqual(["run", "run-b"]);
  });

  it("surfaces native approval while the graph still says running and preserves manual disclosure choices", () => {
    const waiting = block(1, "awaiting-user");
    const [list] = deriveOrchestraTaskLists({
      ownerThreadId: owner,
      runs: [run([node("compute", 1, "running")])],
      blocks: new Map([[waiting.messageId, waiting]]),
      messages: [message(waiting.messageId, "approval needed")],
    });
    const task = list!.tasks[0]!;
    expect(task.status).toBe("awaiting-user");
    expect(orchestraTaskMatchesFilter(task, "attention")).toBe(true);
    expect(orchestraTaskIsExpanded(task)).toBe(true);
    expect(orchestraTaskIsExpanded(task, false)).toBe(false);
    const completed = { ...task, status: "completed" as const };
    expect(orchestraTaskIsExpanded(completed)).toBe(false);
    expect(orchestraTaskIsExpanded(completed, true)).toBe(true);
  });

  it("labels stored receipt output as a summary when the original message is outside the loaded window", () => {
    const stored = block(1, "completed");
    const task = {
      ...node("compute", 1, "completed"),
      attempts: [
        {
          number: 1,
          agent: "codex" as const,
          role: "implementer" as const,
          modelSelection: stored.modelSelection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          strategy: "primary",
          threadId: owner,
          status: "completed" as const,
          output: "stored excerpt",
          error: null,
          failureClassification: null,
          confidence: null,
          startedAt: at,
          completedAt: at,
        },
      ],
    };
    const [list] = deriveOrchestraTaskLists({
      ownerThreadId: owner,
      runs: [run([task])],
      blocks: new Map([[stored.messageId, stored]]),
      messages: [],
    });
    expect(list?.tasks[0]?.attempts[0]).toMatchObject({ text: "stored excerpt", isSummary: true });
  });
});

for (const status of ["cancelled", "failed", "completed"] as const) {
  it(`settles stale pending nodes and streaming attempts when the run is ${status}`, () => {
    const live = block(1);
    const [list] = deriveOrchestraTaskLists({
      ownerThreadId: owner,
      runs: [
        {
          ...run([
            node("compute", 0, "running"),
            node("waiting", 1, "blocked"),
            node("done", 2, "completed"),
          ]),
          status,
        },
      ],
      blocks: new Map([[live.messageId, live]]),
      messages: [message(live.messageId, "retained output", true)],
    });
    expect(list?.status).toBe(status);
    expect(list?.tasks.map((task) => task.status)).toEqual(["cancelled", "cancelled", "completed"]);
    expect(list?.tasks[0]?.attempts[0]).toMatchObject({
      status: "cancelled",
      streaming: false,
      text: "retained output",
    });
    expect(list?.tasks.some((task) => orchestraTaskMatchesFilter(task, "running"))).toBe(false);
  });
}
it("keeps cancellation pending until the server confirms termination", () => {
  const [list] = deriveOrchestraTaskLists({
    ownerThreadId: owner,
    runs: [{ ...run([node("compute", 0, "running")]), status: "cancel-requested" }],
    blocks: new Map(),
    messages: [],
  });
  expect(list?.status).toBe("cancel-requested");
  expect(list?.tasks[0]?.status).toBe("running");
});
