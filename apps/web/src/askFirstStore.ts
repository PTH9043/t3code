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

export const COMPOSER_REQUEST_MODES = [
  { value: "direct", label: "바로 실행", description: "요청을 바로 보내 AI가 진행합니다." },
  {
    value: "ask-first",
    label: "질문하기",
    description: "AI가 작업 계획과 필요한 조건을 먼저 묻고 답변을 기다립니다.",
  },
  {
    value: "conditions",
    label: "조건 확인",
    description: "조건 양식을 직접 수정·확인한 뒤 요청을 보냅니다.",
  },
] as const;
export type ComposerRequestMode = (typeof COMPOSER_REQUEST_MODES)[number]["value"];
const DEFAULT_REQUEST_MODE: ComposerRequestMode = "direct";

export function isComposerRequestMode(value: unknown): value is ComposerRequestMode {
  return COMPOSER_REQUEST_MODES.some((mode) => mode.value === value);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Preserve the existing form toggle when adding the independent question mode. */
export function migrateComposerRequestModes(value: unknown) {
  const modeByFolder: Record<string, ComposerRequestMode> = {};
  if (!isRecord(value)) return { modeByFolder };
  if (isRecord(value.enabledByFolder)) {
    for (const [folder, enabled] of Object.entries(value.enabledByFolder)) {
      if (typeof enabled === "boolean") modeByFolder[folder] = enabled ? "conditions" : "direct";
    }
  }
  if (isRecord(value.modeByFolder)) {
    for (const [folder, mode] of Object.entries(value.modeByFolder)) {
      if (isComposerRequestMode(mode)) modeByFolder[folder] = mode;
    }
  }
  return { modeByFolder };
}

interface ComposerRequestModeState {
  readonly modeByFolder: Readonly<Record<string, ComposerRequestMode>>;
  readonly setMode: (folderKey: string, mode: ComposerRequestMode) => void;
}

export const useComposerRequestModeStore = create<ComposerRequestModeState>()(
  persist(
    (set) => ({
      modeByFolder: {},
      setMode: (folderKey, mode) =>
        set((state) =>
          (state.modeByFolder[folderKey] ?? DEFAULT_REQUEST_MODE) === mode
            ? state
            : { modeByFolder: { ...state.modeByFolder, [folderKey]: mode } },
        ),
    }),
    {
      name: "t3.ask-first.v2",
      version: 1,
      migrate: migrateComposerRequestModes,
      partialize: (state) => ({ modeByFolder: state.modeByFolder }),
    },
  ),
);

export function useComposerRequestMode(): ComposerRequestMode {
  const folderKey = useWorkspaceTabStore((state) => {
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    return active?.projectKey ?? NO_FOLDER_KEY;
  });
  return useComposerRequestModeStore(
    (state) => state.modeByFolder[folderKey] ?? DEFAULT_REQUEST_MODE,
  );
}

export function readComposerRequestMode(): ComposerRequestMode {
  return (
    useComposerRequestModeStore.getState().modeByFolder[activeFolderKey()] ?? DEFAULT_REQUEST_MODE
  );
}

export function setComposerRequestMode(mode: ComposerRequestMode): void {
  useComposerRequestModeStore.getState().setMode(activeFolderKey(), mode);
}

export function toggleComposerRequestMode(mode: Exclude<ComposerRequestMode, "direct">): void {
  setComposerRequestMode(readComposerRequestMode() === mode ? "direct" : mode);
}

export function formatComposerRequest(text: string, mode: ComposerRequestMode): string {
  const stop = /^(stop|cancel|멈춰|멈춰줘|중지|중단|그만)[\s.!?~…]*$/i.test(text.trim());
  return mode === "ask-first" && !stop ? ASK_FIRST_TASK_PREFIX + text : text;
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
  "- 작업 요청이면: (1) 하려는 작업 계획을 본문에 간단히 요약하고 (2) 진행에 필요한 확인 질문을 모두 물어봐 줘. 내가 답하기 전까지는 파일 수정이나 명령 실행 같은 실제 작업을 시작하지 마. 같은 작업에서 이미 내가 답하거나 승인한 조건은 다시 묻지 말고 반영해 줘.\n\n" +
  "어느 쪽이든 이 턴에는 반드시 본문 답변이 있어야 해. 질문 카드만 띄우고 끝내거나, 명령만 돌리고 말없이 끝내지 마. 질문 카드를 띄우기 전에는 본문에 '무엇을 확인했고 왜 묻는지'를 2~3줄로 먼저 써 줘 — 카드 안에서만 언급한 A·B·C 같은 내용은 내가 볼 수 없어.\n\n" +
  "질문은 현재 실행 환경의 기본 질문 툴로 해 줘 — Claude는 AskUserQuestion, Codex는 request_user_input을 사용해 줘. 답변 카드로 떠야 내가 클릭해서 답할 수 있어. 기본 질문 툴을 쓸 수 있으면 본문 질문으로 대체하지 마. 질문 툴이 없는 실행기에서만 본문에 번호와 선택지를 한 번에 묶어 제시해 줘. 각 질문에는 고를 만한 선택지를 2~4개 주고, 네가 권하는 것을 맨 앞에 두고 (권장)이라고 표시해 줘. 여러 개를 함께 고를 수 있는 질문이면 지원되는 경우 multiSelect로 만들어 줘.\n\n" +
  "자동 운영 루프(ScheduleWakeup) 중이어도 이 메시지는 루프 틱이 아니라 내가 직접 보낸 말이야. 다음 깨어남을 예약하더라도 먼저 본문으로 답하고 나서 예약해 줘.\n\n" +
  "이번 턴에서는 '웬만하면 묻지 말고 알아서 진행하라'는 평소 기준보다 이 지시가 우선이야. 다만 저장소나 환경을 찾아보면 알 수 있는 것은 여전히 먼저 확인하고, 그래도 남는 판단만 물어봐 줘.\n\n";
