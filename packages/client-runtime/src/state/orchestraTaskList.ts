import type {
  MessageId,
  ModelSelection,
  ThreadId,
  WorkspaceCollaborationRun,
  WorkspaceOrchestraBlock,
  WorkspaceTaskNode,
  WorkspaceTaskNodeStatus,
} from "@t3tools/contracts";

export type OrchestraTaskFilter = "all" | "running" | "attention" | "completed";
export type OrchestraRunSnapshot = Pick<
  WorkspaceCollaborationRun,
  "id" | "task" | "status" | "createdAt" | "meeting" | "graph"
> &
  Partial<Pick<WorkspaceCollaborationRun, "projectId" | "orchestra">>;
type TaskMessage = {
  readonly id: MessageId;
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt?: string;
};
type TaskProgress = { readonly summary: string; readonly createdAt: string };

export interface OrchestraTaskAttemptView {
  readonly key: string;
  readonly number: number;
  readonly messageId: MessageId | null;
  readonly text: string;
  readonly streaming: boolean;
  readonly status: WorkspaceTaskNodeStatus;
  readonly modelSelection: ModelSelection | null;
  readonly displayName: string;
  readonly instruction: string;
  readonly isSummary: boolean;
}

export interface OrchestraTaskView {
  readonly id: string;
  readonly title: string;
  readonly kind: WorkspaceTaskNode["kind"];
  readonly status: WorkspaceTaskNodeStatus;
  readonly displayName: string;
  readonly modelSelection: ModelSelection | null;
  readonly instruction: string;
  readonly attempts: ReadonlyArray<OrchestraTaskAttemptView>;
  readonly validation: WorkspaceTaskNode["validation"];
  readonly error: string | null;
  readonly question: string | null;
  readonly output: string | null;
  readonly progress: TaskProgress | null;
  readonly waitReason?: string | null;
  /** Sum of completed attempt durations, excluding queue/answer time and an in-flight attempt. */
  readonly completedAttemptMs?: number | null;
}

export interface OrchestraTaskList {
  readonly run?: OrchestraRunSnapshot;
  readonly id: string;
  readonly status: OrchestraRunSnapshot["status"] | null;
  readonly createdAt: string;
  readonly title: string;
  readonly conductor: string | null;
  readonly question?: string | null;
  readonly tasks: ReadonlyArray<OrchestraTaskView>;
}

export const orchestraTaskStatusLabels: Record<WorkspaceTaskNodeStatus, string> = {
  blocked: "선행 작업 대기",
  queued: "실행 대기",
  running: "실행 중",
  "awaiting-validation": "검증 대기",
  "awaiting-user": "답변 대기",
  completed: "완료",
  failed: "실패",
  cancelled: "취소",
  skipped: "건너뜀",
};

export function orchestraTaskMatchesFilter(task: OrchestraTaskView, filter: OrchestraTaskFilter) {
  switch (filter) {
    case "all":
      return true;
    case "running":
      return task.status === "running" || task.status === "awaiting-validation";
    case "attention":
      return task.status === "failed" || task.status === "awaiting-user";
    case "completed":
      return task.status === "completed";
  }
}

/** A manual choice survives status changes, filtering and list virtualization. */
export function orchestraTaskIsExpanded(task: OrchestraTaskView, explicit?: boolean) {
  return (
    explicit ??
    (task.status === "running" || task.status === "awaiting-user" || task.status === "failed")
  );
}

/** Merge durable graph state with the live message body; never count retries as new tasks. */
export function deriveOrchestraTaskLists(input: {
  readonly ownerThreadId: ThreadId | null;
  readonly runs: ReadonlyArray<OrchestraRunSnapshot>;
  readonly blocks: ReadonlyMap<MessageId, WorkspaceOrchestraBlock>;
  readonly messages: ReadonlyArray<TaskMessage>;
  readonly workEntries?: ReadonlyArray<{
    readonly orchestraMessageId?: string;
    readonly label: string;
    readonly createdAt: string;
  }>;
}): ReadonlyArray<OrchestraTaskList> {
  const messages = new Map(input.messages.map((message) => [message.id, message]));
  const progressByMessage = new Map<string, TaskProgress>();
  for (const entry of input.workEntries ?? []) {
    if (!entry.orchestraMessageId) continue;
    const previous = progressByMessage.get(entry.orchestraMessageId);
    if (!previous || entry.createdAt >= previous.createdAt) {
      progressByMessage.set(entry.orchestraMessageId, {
        summary: entry.label.replace(/\s+/g, " ").trim().slice(0, 180),
        createdAt: entry.createdAt,
      });
    }
  }
  const blocksByRun = new Map<string, WorkspaceOrchestraBlock[]>();
  for (const block of input.blocks.values()) {
    if (block.ownerThreadId !== input.ownerThreadId) continue;
    const existing = blocksByRun.get(block.runId) ?? [];
    existing.push(block);
    blocksByRun.set(block.runId, existing);
  }
  const runs = new Map(
    input.runs
      .filter(
        (run) =>
          input.ownerThreadId !== null &&
          (run.meeting?.threadId === input.ownerThreadId ||
            run.graph?.nodes.some((node) => node.threadId === input.ownerThreadId)),
      )
      .map((run) => [String(run.id), run]),
  );
  const ids = new Set([...blocksByRun.keys(), ...runs.keys()]);
  return [...ids]
    .flatMap((id): OrchestraTaskList[] => {
      const run = runs.get(id);
      const terminal =
        run !== undefined && ["cancelled", "failed", "completed"].includes(run.status);
      const settleStatus = (status: WorkspaceTaskNodeStatus): WorkspaceTaskNodeStatus =>
        terminal &&
        ["blocked", "queued", "running", "awaiting-validation", "awaiting-user"].includes(status)
          ? "cancelled"
          : status;
      const blocks = blocksByRun.get(id) ?? [];
      const blocksByNode = new Map<string, WorkspaceOrchestraBlock[]>();
      for (const block of blocks) {
        const existing = blocksByNode.get(block.nodeId) ?? [];
        existing.push(block);
        blocksByNode.set(block.nodeId, existing);
      }
      const nodes = new Map(run?.graph?.nodes.map((node) => [String(node.id), node]) ?? []);
      // Planning/discussion messages precede graph nodes. Status never controls ordering.
      const nodeIds = new Set([
        ...[...blocksByNode.keys()].filter((nodeId) => !nodes.has(nodeId)),
        ...[...nodes.values()].toSorted((a, b) => a.order - b.order).map((node) => String(node.id)),
      ]);
      const tasks = [...nodeIds].map((nodeId): OrchestraTaskView => {
        const node = nodes.get(nodeId);
        const nodeBlocks = (blocksByNode.get(nodeId) ?? []).toSorted(
          (a, b) => a.attempt - b.attempt,
        );
        const latestBlock = nodeBlocks.at(-1);
        const participant = run?.meeting?.participants.find(
          (seat) => seat.id === node?.participantId,
        );
        const attempts = new Map<number, OrchestraTaskAttemptView>();
        for (const attempt of node?.attempts ?? []) {
          attempts.set(attempt.number, {
            key: `${id}:${nodeId}:${attempt.number}`,
            number: attempt.number,
            messageId: null,
            text: attempt.output ?? "",
            streaming: !terminal && attempt.status === "running",
            status: settleStatus(attempt.status),
            modelSelection: attempt.modelSelection,
            displayName: participant?.displayName ?? node?.agent ?? "AI",
            instruction: node?.handoff.task ?? "",
            isSummary: true,
          });
        }
        for (const block of nodeBlocks) {
          const message = messages.get(block.messageId);
          const recorded = attempts.get(block.attempt);
          attempts.set(block.attempt, {
            key: `${id}:${nodeId}:${block.attempt}`,
            number: block.attempt,
            messageId: block.messageId,
            text: message?.text || recorded?.text || "",
            streaming:
              !terminal &&
              block.status === "running" &&
              (message?.streaming ?? recorded?.streaming ?? true),
            status: settleStatus(block.status),
            modelSelection: block.modelSelection,
            displayName: block.displayName,
            instruction: block.instruction ?? node?.handoff.task ?? "",
            isSummary: message === undefined,
          });
        }
        const ordered = [...attempts.values()].toSorted((a, b) => a.number - b.number);
        const latest = ordered.at(-1);
        const latestMessage = latestBlock ? messages.get(latestBlock.messageId) : undefined;
        let progress = latestBlock ? (progressByMessage.get(latestBlock.messageId) ?? null) : null;
        const messageAt = latestMessage?.updatedAt ?? latestMessage?.createdAt;
        if (latestMessage?.text && messageAt && (!progress || messageAt > progress.createdAt)) {
          progress = { summary: "AI 응답 수신", createdAt: messageAt };
        }
        // Native streaming can precede the graph query's refresh, especially on a retry.
        const nativeIsAhead =
          latestBlock !== undefined && latestBlock.attempt > (node?.attempts.at(-1)?.number ?? 0);
        const status =
          latestBlock?.status === "running" && nativeIsAhead
            ? "running"
            : latestBlock?.status === "awaiting-user" &&
                (nativeIsAhead || node?.status === "running")
              ? "awaiting-user"
              : (node?.status ?? latestBlock?.status ?? "queued");
        const dependencies = (node?.dependsOn ?? []).flatMap((dependencyId) => {
          const dependency = nodes.get(dependencyId);
          const satisfied =
            dependency &&
            (node?.kind === "validation" && node.validationTargetId === dependency.id
              ? ["awaiting-validation", "completed"].includes(dependency.status)
              : ["completed", "skipped"].includes(dependency.status));
          return satisfied ? [] : [dependency?.title ?? dependencyId];
        });
        const waitReason = terminal
          ? null
          : status === "awaiting-user"
            ? (node?.parkedQuestion?.question ?? "사용자 확인·답변 대기")
            : ["queued", "blocked"].includes(status) && run?.meeting?.pendingQuestion
              ? "회의의 사용자 답변 대기"
              : ["queued", "blocked"].includes(status) && dependencies.length
                ? `선행 작업 대기: ${dependencies.join(", ")}`
                : ["queued", "blocked"].includes(status)
                  ? "실행 순서 배정 대기"
                  : status === "awaiting-validation"
                    ? "검증 단계의 결과 대기"
                    : null;
        const durations = (node?.attempts ?? []).flatMap((attempt) => {
          if (attempt.completedAt === null) return [];
          const duration = Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt);
          return Number.isFinite(duration) && duration >= 0 ? [duration] : [];
        });
        return {
          id: nodeId,
          title: node?.title ?? latestBlock?.title ?? "작업",
          kind: node?.kind ?? latestBlock?.kind ?? "orchestration",
          status: settleStatus(status),
          displayName: latest?.displayName ?? participant?.displayName ?? node?.agent ?? "AI",
          modelSelection: latest?.modelSelection ?? participant?.modelSelection ?? null,
          instruction: latest?.instruction ?? node?.handoff.task ?? "",
          attempts: ordered,
          validation: node?.validation ?? null,
          error: node?.error ?? null,
          question: terminal ? null : (node?.parkedQuestion?.question ?? null),
          output: node?.output ?? null,
          progress,
          waitReason,
          completedAttemptMs: durations.length
            ? durations.reduce((sum, value) => sum + value, 0)
            : null,
        };
      });
      const chair =
        run?.meeting?.participants.find((seat) => seat.id === run.meeting?.chairParticipantId) ??
        run?.meeting?.participants[0];
      const firstMessage = blocks
        .map((block) => messages.get(block.messageId))
        .find((message) => message !== undefined);
      if (!run && !firstMessage) return [];
      return [
        {
          id,
          ...(run ? { run } : {}),
          status: run?.status ?? null,
          createdAt: run?.createdAt ?? firstMessage!.createdAt,
          title: run?.task ?? "오케스트라 작업",
          conductor: chair ? `${chair.displayName} · ${chair.modelSelection.model}` : null,
          question: terminal ? null : (run?.meeting?.pendingQuestion?.question ?? null),
          tasks,
        },
      ];
    })
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}
