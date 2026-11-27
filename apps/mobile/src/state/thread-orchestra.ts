import type { ThreadId, WorkspaceCollaborationRun } from "@t3tools/contracts";

export function isThreadOrchestraStopIntent(text: string): boolean {
  return /^(애|얘|야)?\s*(회의|미팅|오케스트라)?\s*(멈춰|멈춰라|멈춰줘|멈추라고|중지|중지해|중지해줘|중단|중단해|중단해줘|그만|그만해|그만해라|스탑|스톱|stop|cancel)$/i.test(
    text.trim().replace(/[\s.!?~…ㅋㅎ;,]+$/g, ""),
  );
}

export function selectThreadOrchestraOption(
  draft: string,
  options: ReadonlyArray<string>,
  selected: string,
): string {
  const trimmed = draft.trim();
  if (!trimmed || options.includes(trimmed)) return selected;
  const previous = options.find((option) => draft.endsWith(`\n${option}`));
  return `${previous ? draft.slice(0, -(previous.length + 1)) : draft}\n${selected}`;
}

export function activeThreadOrchestra(
  runs: ReadonlyArray<WorkspaceCollaborationRun>,
  threadId: ThreadId,
): WorkspaceCollaborationRun | undefined {
  const rank = { running: 0, queued: 1, "cancel-requested": 2 } as const;
  return runs
    .filter(
      (run) =>
        run.meeting?.threadId === threadId &&
        (run.status === "queued" || run.status === "running" || run.status === "cancel-requested"),
    )
    .sort(
      (left, right) =>
        (rank[left.status as keyof typeof rank] ?? 3) -
        (rank[right.status as keyof typeof rank] ?? 3),
    )[0];
}

export function prepareThreadOrchestraMessage(
  run: WorkspaceCollaborationRun,
  draft: { readonly text: string; readonly attachmentCount: number },
) {
  if (run.status === "cancel-requested")
    return {
      kind: "hold" as const,
      reason: "통합 작업을 중지하는 중입니다. 중지가 끝난 뒤 다시 보내세요.",
    };
  const text = draft.text.trim();
  if (isThreadOrchestraStopIntent(text))
    return draft.attachmentCount === 0
      ? { kind: "stop" as const }
      : {
          kind: "hold" as const,
          reason: "첨부를 보존했습니다. 중지 버튼을 눌러 작업을 중지하세요.",
        };
  if (text.length > 8_000)
    return { kind: "hold" as const, reason: "답변이나 추가 지시는 8,000자 이하로 입력하세요." };
  const question = run.meeting?.pendingQuestion;
  if (question) {
    if (!text && !draft.attachmentCount) return { kind: "empty" as const };
    return {
      kind: "answer" as const,
      text: text || "첨부한 이미지를 참고하세요.",
      question: question.question,
      questionRef: { nodeId: question.nodeId, askedAt: question.askedAt },
    };
  }
  if (draft.attachmentCount)
    return {
      kind: "hold" as const,
      reason: "추가 지시에는 이미지를 보낼 수 없어 초안에 보관했습니다.",
    };
  return text ? { kind: "interject" as const, text } : { kind: "empty" as const };
}
