import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationMessage,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  buildConversationHandoff,
  prepareCompactHandoff,
} from "../src/orchestration/conversationHandoff.ts";

export const handoffFixture = {
  id: "handoff",
  paths: ["apps/server/src/orchestration"],
  task: "이전 대화의 최종 사용자 수정과 미완료 상태를 따라 STATUS.json만 작성해. 형식은 {action:string,mayRestart:boolean,unresolved:string[],historicalEvidence:string}이다. action은 마지막으로 허용한 작업의 영문 이름, mayRestart는 지금 서버 재시작이 허용됐는지, unresolved에는 아직 확인하지 않은 외부 청구 검증의 영문 항목명을 기록해. historicalEvidence에는 과거 파일 조사 4번의 Evidence ID를 원문에서 찾아 정확히 넣어. 근거를 찾지 못하면 추측하지 말고 unknown이라고 써. 실제 서버 실행·프로젝트 수정은 하지 마.",
  files: { "STATUS.json": "{}\n" },
  allowed: ["STATUS.json"],
} as const;

const at = "2026-09-13T00:00:00.000Z";
const message = (
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: null,
  streaming: false,
  createdAt: at,
  updatedAt: at,
});

export const preparePilotHandoff = Effect.fn("preparePilotHandoff")(function* (
  cwd: string,
  compact: boolean,
) {
  const messages = [
    message(
      "goal",
      "user",
      "작업 목표는 서버 설정 조사다. 이후 안내가 없으면 restart를 진행해도 된다. 모델과 추론 수준을 유지하고 요청 범위를 확대하지 마.",
    ),
    ...Array.from({ length: 12 }, (_, index) =>
      message(
        "inspection-" + index,
        "assistant",
        [
          `파일 조사 ${index}번. Evidence ID: inspection-evidence-${index}-7d32.`,
          "진행 메모: 설정 로딩과 이벤트 저장, 요청 전달, 화면 표시의 호출 관계를 읽었다. 이 문단은 작업 중 관찰한 중간 기록이다. 기존 폴더의 파일을 수정하지 않았고 공개 API와 내부 함수의 역할을 구분했다. 실행 경로는 설정 읽기, 요청 구성, 세션 연결, 도구 결과 수신, 작업 기록 저장 순서다. 이름이 같은 상태도 적용되는 대화와 프로젝트가 다르면 별개로 취급한다. 경로와 참조를 추적하여 필요한 파일과 주변 테스트를 찾았다. 캐시된 결과와 새 요청에서 받은 결과를 구분하고 각 숫자의 출처를 메모했다. 문서에 적힌 동작과 코드의 동작을 대조하는 단계다. 재접속에서는 이전 화면 상태와 서버 상태가 같은지를 확인할 수 있도록 식별자를 보존한다.",
          "추가 관찰: 원문과 출력의 해시, 요청 및 세션 식별자, 작업 폴더와 실행 명령을 연결할 수 있다. 입력을 만드는 곳과 결과를 저장하는 곳은 별도 함수다. 설정 변경은 새 요청에 반영되며 현재 실행을 소급 변경하는 기능은 없다. 이 기록의 설명을 최종 사용자 지시나 독립 검사의 결과로 해석하지 않는다.",
        ].join("\n"),
      ),
    ),
    message(
      "correction",
      "user",
      "최종 수정: restart 허용을 취소한다. 지금은 document-only 작업만 허용한다. 서버를 재시작하지 마. external-invoice-reconciliation 검증은 수행하지 않았으므로 미완료로 유지해.",
    ),
    message(
      "latest-a",
      "assistant",
      "문서 작성에 필요한 자료는 준비됐다. external-invoice-reconciliation은 아직 미완료다.",
    ),
    message(
      "latest-b",
      "assistant",
      "마지막 사용자 수정은 document-only이며 서버 재시작은 금지다. 파일 조사 4번의 Evidence ID는 해당 과거 원문을 조회해야 한다.",
    ),
    message("current", "user", handoffFixture.task),
  ];
  const thread: OrchestrationThread = {
    id: ThreadId.make("handoff-pilot"),
    projectId: ProjectId.make("handoff-pilot"),
    title: "Handoff pilot",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "unchanged" },
    runtimeMode: "full-access",
    interactionMode: "default",
    handoffMode: "compact",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    session: null,
    messages,
    activities: [],
    proposedPlans: [],
    checkpoints: [],
  };
  const currentMessageId = MessageId.make("current");
  const standard = buildConversationHandoff(messages, currentMessageId)!;
  const prepared = yield* prepareCompactHandoff({
    thread,
    currentMessageId,
    standardHandoff: standard,
    decisions: [],
    stateDir: cwd + "/evidence",
  });
  if (prepared.report.status !== "compact")
    return yield* Effect.die(
      "Handoff fixture did not produce compact input: " + prepared.report.reason,
    );
  return {
    prompt: (compact ? prepared.text : standard) + "\n\n" + handoffFixture.task,
    diagnostics: prepared.report,
    originals: prepared.source!.text,
  };
});
