import type { WorkspaceCollaborationRun, WorkspaceTaskNode } from "@t3tools/contracts";

const nodeStatusLabels: Record<WorkspaceTaskNode["status"], string> = {
  queued: "대기",
  running: "진행 중",
  blocked: "의존 작업 대기",
  "awaiting-validation": "검증 대기",
  "awaiting-user": "답변 대기",
  completed: "완료",
  failed: "실패",
  cancelled: "중지됨",
  skipped: "건너뜀",
};

function excerpt(text: string, maxChars: number) {
  const trimmed = text.trim();
  return trimmed.length <= maxChars
    ? trimmed
    : `${trimmed.slice(0, maxChars)}… (전체 내용은 위 대화에 있습니다.)`;
}

/** Summarizes persisted decisions and receipts without starting another provider turn. */
export function formatWorkspaceRunSummary(run: WorkspaceCollaborationRun): string | null {
  if (run.status !== "completed" && run.status !== "cancelled" && run.status !== "failed")
    return null;
  const sections = [
    "## 오케스트라 대화 정리",
    `**${{ completed: "완료", cancelled: "중지됨", failed: "실패" }[run.status]}**`,
    `### 요청\n${excerpt(run.task, 2_000)}`,
  ];
  const meeting = run.meeting;
  if (meeting) {
    const names = new Map(meeting.participants.map((seat) => [seat.id, seat.displayName]));
    const decisions = meeting.rounds
      .map((round) => {
        const content =
          round.chairSummary ??
          round.statements
            .map(
              (statement) =>
                `- ${names.get(statement.participantId) ?? statement.participantId}: ${excerpt(statement.content, 400)}`,
            )
            .join("\n");
        return content ? `**${round.index + 1}라운드**\n${excerpt(content, 1_000)}` : "";
      })
      .filter(Boolean);
    if (decisions.length)
      sections.push(`### 논의와 결정\n${excerpt(decisions.join("\n\n"), 6_000)}`);
    const inputs = [
      ...meeting.interjections.map((input) => `- 추가 요청: ${excerpt(input.text, 600)}`),
      ...meeting.answers.map(
        (input) => `- 질문: ${excerpt(input.question, 400)}\n  답변: ${excerpt(input.answer, 600)}`,
      ),
    ];
    if (inputs.length)
      sections.push(`### 사용자 요청과 답변\n${excerpt(inputs.join("\n"), 4_000)}`);
  }
  const graph = run.graph;
  if (graph) {
    const tasks = graph.nodes.map((node) => {
      const output = ["research", "implementation", "debug"].includes(node.kind)
        ? (node.output ?? node.attempts.at(-1)?.output)
        : null;
      return [
        `- **${node.title}** · ${nodeStatusLabels[node.status]}`,
        ...(output ? [excerpt(output, 600)] : []),
        ...(node.error ? [`오류: ${excerpt(node.error, 300)}`] : []),
      ].join("\n");
    });
    if (tasks.length) sections.push(`### 작업 결과\n${excerpt(tasks.join("\n\n"), 6_000)}`);
    const checks = graph.nodes.flatMap((node) =>
      node.validation
        ? [
            `- ${node.title}: ${{ pass: "통과", fail: "실패", inconclusive: "판정 보류" }[node.validation.verdict]} · ${excerpt(node.validation.summary, 400)}`,
          ]
        : [],
    );
    if (checks.length) sections.push(`### AI 검토 기록\n${excerpt(checks.join("\n"), 3_000)}`);
    if (graph.delivery)
      sections.push(
        "### 실제 검증\n" +
          graph.delivery.detail +
          "\n" +
          graph.delivery.commands
            .map(
              (receipt) =>
                "- " +
                receipt.command +
                ": 종료 코드 " +
                receipt.exitCode +
                (receipt.timedOut ? " · 시간 초과" : "") +
                "\n  로그: " +
                receipt.logPath,
            )
            .join("\n"),
      );
  } else if (run.steps.length) {
    sections.push(
      `### 작업 결과\n${excerpt(
        run.steps
          .map(
            (step) =>
              `- ${step.role} · ${step.status === "completed" ? "완료" : step.status === "cancelled" ? "중지됨" : step.status === "failed" ? "실패" : "미완료"}${step.output ? `\n${excerpt(step.output, 600)}` : ""}`,
          )
          .join("\n\n"),
        6_000,
      )}`,
    );
  }
  if (run.finalOutput) {
    // Discussion-only runs also store a full transcript after their conclusion.
    const conclusion = run.finalOutput.split("\n## 회의 전문\n")[0] ?? run.finalOutput;
    sections.push(`### 최종 결과\n${excerpt(conclusion, 6_000)}`);
  }
  if (run.status !== "completed") {
    sections.push(
      `### 남은 내용\n${
        run.error
          ? excerpt(run.error, 1_000)
          : "사용자 요청으로 실행을 중지했습니다. 위에 기록된 완료 작업과 대화는 보존되며, 미완료 작업은 완료로 처리하지 않았습니다."
      }`,
    );
  }
  return sections.join("\n\n");
}
