import type { WorkspaceMeeting } from "@t3tools/contracts";
import {
  findParticipant,
  parseMeetingQuestion,
  renderMeetingTranscript,
  resolveChairParticipantId,
  WorkspaceMeetingError,
} from "./workspaceMeeting.ts";

/** A question-first turn belongs to the selected conductor, before any task graph exists. */
export function buildMeetingIntakePrompt(input: {
  readonly task: string;
  readonly workspacePrompt: string;
  readonly meeting: WorkspaceMeeting;
}) {
  const chair = findParticipant(input.meeting, resolveChairParticipantId(input.meeting));
  return [
    "# Workspace Meeting Intake",
    `Chair: ${chair.displayName} (${chair.id})`,
    ...(chair.roleDescription ? [`사용자가 지정한 역할: ${chair.roleDescription}`] : []),
    "사용자가 '질문 먼저'를 선택했습니다. 당신은 선택된 지휘 AI입니다. 이 단계에서는 질문과 답변만 하며, 파일 변경·명령 실행·프로그램 시작·하위 AI 호출·작업 그래프 작성은 하지 마세요.",
    "현재 요청이 프로그램 설명·상태 확인 등 질문이면, 제공된 현재 대화와 자료로 본문에 답변하고 끝내세요. 질문을 작업 재개 지시로 해석하지 마세요. 확인할 수 없는 내용은 모른다고 설명하세요.",
    "작업 요청이면 범위와 진행에 필요한 확인 질문을 한 번에 짧게 제시하세요. 사용자가 아직 답하지 않았다면 실제 작업을 시작하지 마세요. 필요한 세부 정보가 이미 있어도 작업 범위를 한 번 확인하세요.",
    "이미 받은 답변과 최신 사용자 발언이 우선입니다. '설명만', '작업하지 마', '취소'는 작업 허가가 아닙니다. 그런 경우에는 본문으로 답하고 끝내세요. 답변에 없는 목표를 기억에서 가져오지 마세요.",
    "같은 질문을 반복하지 마세요. 질문 앞에는 무엇을 확인하는지 본문으로 간단히 설명하세요.",
    '질문이 필요하면 <t3_question>{"question":"확인할 내용","options":["선택지"],"context":"질문 이유"}</t3_question> 형식을 사용하세요. 별도의 질문 도구를 호출하지 마세요. 이 형식은 현재 대화의 답변 카드로 표시됩니다.',
    input.meeting.answers.length === 0
      ? "아직 확인 질문에 대한 사용자 답변이 없습니다. <t3_ready>를 반환하지 마세요."
      : "사용자 답변으로 작업 범위가 확인됐고 실행을 원하는 경우에만 <t3_ready>확인된 작업 범위를 한두 문장으로 요약</t3_ready>를 반환하세요. 실제 계획과 배정은 다음 단계에서 합니다.",
    "",
    "## 현재 요청",
    input.task,
    "",
    "## 현재 대화와 프로젝트 참고 자료",
    input.workspacePrompt,
    "",
    "## 이미 받은 답변과 사용자 발언",
    renderMeetingTranscript(input.meeting) || "없음",
  ].join("\n");
}

export function parseMeetingIntakeOutput(output: string, hasAnswer: boolean) {
  const question = parseMeetingQuestion(output);
  if (question !== null) return { kind: "question" as const, ...question };
  if (output.includes("<t3_task_graph>"))
    throw new WorkspaceMeetingError("질문 먼저 단계에서는 작업 그래프를 실행할 수 없습니다.");
  const ready = /<t3_ready>([\s\S]*?)<\/t3_ready>/u.exec(output)?.[1]?.trim();
  if (ready && hasAnswer) return { kind: "ready" as const, summary: ready };
  if (output.includes("<t3_"))
    throw new WorkspaceMeetingError(
      "지휘 AI가 사용자 답변 전에 실행하거나 잘못된 확인 결과를 반환했습니다.",
    );
  const answer = output.trim();
  if (!answer) throw new WorkspaceMeetingError("지휘 AI가 질문이나 답변을 반환하지 않았습니다.");
  return { kind: "answer" as const, answer };
}
