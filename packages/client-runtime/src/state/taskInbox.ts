import type {
  WorkspaceInboxTaskStatus,
  WorkspaceTaskRecipeDefinition,
  WorkspaceTaskAction,
} from "@t3tools/contracts";

export const taskInboxStatus: Record<WorkspaceInboxTaskStatus, string> = {
  queued: "접수·대기",
  held: "보류",
  checking: "사전 확인·명령 실행",
  dispatching: "AI 배정 중",
  running: "AI 작업 중",
  verifying: "결과 확인 중",
  "cancel-requested": "취소 처리 중",
  completed: "설정한 결과 검사 통과",
  unchanged: "변화 없음 · AI 생략",
  "needs-verification": "응답 완료 · 검증 필요",
  failed: "실패",
  cancelled: "취소됨",
  "delivery-unknown": "수행 결과 재확인 필요",
};
export function taskInboxActions(
  status: WorkspaceInboxTaskStatus,
  hasRun: boolean,
): WorkspaceTaskAction["action"][] {
  if (status === "queued") return ["hold", "cancel"];
  if (status === "held") return ["release", "cancel"];
  if (["checking", "dispatching", "running", "verifying"].includes(status)) return ["cancel"];
  if (status === "delivery-unknown")
    return hasRun ? ["reconcile", "retry", "cancel"] : ["retry", "cancel"];
  if (status === "needs-verification") return ["cancel"];
  if (["failed", "cancelled"].includes(status)) return ["retry"];
  return [];
}
export const taskInboxActionLabels: Record<WorkspaceTaskAction["action"], string> = {
  hold: "보류",
  release: "다시 진행",
  cancel: "취소",
  retry: "새 시도로 재실행",
  reconcile: "기존 실행 재확인",
};
const base: WorkspaceTaskRecipeDefinition = {
  id: "research",
  name: "자료 조사",
  enabled: true,
  parameters: [{ name: "topic", label: "조사 주제", required: true, defaultValue: "" }],
  taskTemplate:
    "{{topic}}에 관한 자료를 조사하고 출처 링크, 확인한 사실, 적용 제안과 미해결 사항을 정리하세요.",
  execution: "agent",
  script: "",
  precheck: { kind: "none" },
  artifacts: [{ path: "reports/automation-report.md", format: "text", requiredKeys: [] }],
  verificationCommands: [],
  executionProfile: null,
};
export const starterTaskRecipes: readonly WorkspaceTaskRecipeDefinition[] = [
  base,
  {
    ...base,
    id: "issue-fix",
    name: "이슈 수정 후보",
    parameters: [
      { name: "issueUrl", label: "이슈 URL", required: false, defaultValue: "" },
      { name: "problem", label: "문제와 완료 조건", required: true, defaultValue: "" },
    ],
    taskTemplate:
      "이슈: {{issueUrl}}\n문제와 완료 조건: {{problem}}\n현재 코드를 확인하고 재현, 최소 수정, 관련 테스트와 후보 빌드를 수행하세요. 실행 중인 프로그램의 업그레이드는 별도 후보 작업공간에서 검증하고 안정성을 확인한 뒤 교체하세요. 변경과 실제 검사 결과를 보고하세요.",
    artifacts: [],
  },
  {
    ...base,
    id: "file-processing",
    name: "파일 처리",
    parameters: [
      { name: "sourceFolder", label: "입력 폴더", required: true, defaultValue: "" },
      { name: "requirements", label: "처리 방식과 출력 형식", required: true, defaultValue: "" },
    ],
    taskTemplate:
      "입력 폴더 {{sourceFolder}}의 자료를 다음 조건으로 처리하세요: {{requirements}}. 원본을 보존하고 결과 파일과 입력·출력 대응 목록, 미해결 사항을 저장하세요.",
    artifacts: [
      {
        path: "reports/file-processing.json",
        format: "json",
        requiredKeys: ["inputs", "outputs", "unresolved"],
      },
    ],
  },
  {
    ...base,
    id: "script-task",
    name: "AI 없이 명령 실행",
    parameters: [],
    taskTemplate: "저장한 명령을 실행하고 종료 코드와 결과 검사를 기록합니다.",
    execution: "script",
    script: "",
    artifacts: [],
  },
];
