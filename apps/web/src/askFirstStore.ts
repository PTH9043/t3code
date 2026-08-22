import { create } from "zustand";
import { persist } from "zustand/middleware";

import { useWorkspaceTabStore } from "./workspaceTabStore";

/** Settings written before the screen's folder is known land here. */
const NO_FOLDER_KEY = "__no-folder__";

function activeFolderKey(): string {
  const state = useWorkspaceTabStore.getState();
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  return active?.projectKey ?? NO_FOLDER_KEY;
}

interface AskFirstState {
  readonly enabledByFolder: Readonly<Record<string, boolean>>;
  readonly setEnabled: (folderKey: string, enabled: boolean) => void;
}

/**
 * "질문 먼저" — checked, every send in this FOLDER (a meeting topic or a
 * plain task) instructs the AI to come back with its plan and clarifying
 * questions BEFORE touching anything, and to wait for the person's answer.
 * Scoped per folder like the meeting room, persisted until turned off.
 */
export const useAskFirstStore = create<AskFirstState>()(
  persist(
    (set) => ({
      enabledByFolder: {},
      setEnabled: (folderKey, enabled) =>
        set((state) =>
          (state.enabledByFolder[folderKey] ?? false) === enabled
            ? state
            : { enabledByFolder: { ...state.enabledByFolder, [folderKey]: enabled } },
        ),
    }),
    {
      name: "t3.ask-first.v2",
      partialize: (state) => ({ enabledByFolder: state.enabledByFolder }),
    },
  ),
);

export function useAskFirstEnabled(): boolean {
  const folderKey = useWorkspaceTabStore((state) => {
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    return active?.projectKey ?? NO_FOLDER_KEY;
  });
  return useAskFirstStore((state) => state.enabledByFolder[folderKey] ?? false);
}

export function readAskFirstEnabled(): boolean {
  return useAskFirstStore.getState().enabledByFolder[activeFolderKey()] ?? false;
}

export function setAskFirstEnabled(enabled: boolean): void {
  useAskFirstStore.getState().setEnabled(activeFolderKey(), enabled);
}

/**
 * Prepended to a plain send. Phrased as the person's own instruction so
 * every provider treats it with user authority.
 *
 * Distinguishes a question from a task request: the original wording
 * ("계획을 요약하고 확인 질문을 물어봐, 답하기 전까지 작업하지 마") was written
 * for task requests, and applied to a plain question it made the seat reply
 * with question cards instead of an answer — on 2026-08-22 one question
 * produced four consecutive cards and ~100 characters of prose, one of them
 * referring to "A·B·C" that existed only inside a card. It also demands a
 * prose reply on every turn, which keeps an autonomous wake-up loop from
 * swallowing the person's message as a loop tick.
 *
 * Names both question tools rather than asking in the abstract. Every provider
 * has one (Claude `AskUserQuestion`, Codex `request_user_input`) and each
 * ignores the name it does not own, but without a name the model satisfies
 * "물어봐 줘" by writing prose — text the person has to retype instead of the
 * card they can click. This toggle is the person explicitly asking to be
 * consulted, so it also has to outrank the standing "prefer assumptions over
 * questions" guidance the providers carry by default.
 */
export const ASK_FIRST_TASK_PREFIX =
  "[질문 먼저] 아래 메시지를 읽고 먼저 구분해 줘.\n\n" +
  "- 질문이거나 상태·결과를 묻는 말이면: 되묻지 말고 본문으로 바로 답해 줘. 저장소·로그·환경을 확인하면 알 수 있는 것은 확인해서 사실로 답하고, 답한 뒤에 정말 남는 판단이 있을 때만 질문해 줘.\n" +
  "- 작업 요청이면: (1) 하려는 작업 계획을 본문에 간단히 요약하고 (2) 진행에 필요한 확인 질문을 모두 물어봐 줘. 내가 답하기 전까지는 파일 수정이나 명령 실행 같은 실제 작업을 시작하지 마.\n\n" +
  "어느 쪽이든 이 턴에는 반드시 본문 답변이 있어야 해. 질문 카드만 띄우고 끝내거나, 명령만 돌리고 말없이 끝내지 마. 질문 카드를 띄우기 전에는 본문에 '무엇을 확인했고 왜 묻는지'를 2~3줄로 먼저 써 줘 — 카드 안에서만 언급한 A·B·C 같은 내용은 내가 볼 수 없어.\n\n" +
  "질문은 반드시 질문 툴(AskUserQuestion 또는 request_user_input)로 해 줘 — 답변 카드로 떠야 내가 클릭해서 답할 수 있어. 채팅 본문에 글로 쓴 질문은 답하기 불편하니 쓰지 마. 각 질문에는 고를 만한 선택지를 2~4개 주고, 네가 권하는 것을 맨 앞에 두고 (권장)이라고 표시해 줘. 여러 개를 함께 고를 수 있는 질문이면 multiSelect로 만들어 줘.\n\n" +
  "자동 운영 루프(ScheduleWakeup) 중이어도 이 메시지는 루프 틱이 아니라 내가 직접 보낸 말이야. 다음 깨어남을 예약하더라도 먼저 본문으로 답하고 나서 예약해 줘.\n\n" +
  "이번 턴에서는 '웬만하면 묻지 말고 알아서 진행하라'는 평소 기준보다 이 지시가 우선이야. 다만 저장소나 환경을 찾아보면 알 수 있는 것은 여전히 먼저 확인하고, 그래도 남는 판단만 물어봐 줘.\n\n";

/**
 * Prepended to a meeting topic. The seats' statement prompt already carries
 * the `<t3_question>` protocol, and the server parks the run on it until the
 * person answers — so the instruction rides inside the topic itself.
 */
export const ASK_FIRST_MEETING_PREFIX =
  "[질문 먼저] 본격적인 논의를 시작하기 전에, 첫 발언자는 이 주제에 대해 확인이 필요한 사항이 있으면 <t3_question>으로 사용자에게 먼저 질문하고 답을 받은 뒤 논의를 진행하라. 확인할 것이 정말 없을 때만 곧바로 논의를 시작하라.\n\n";
