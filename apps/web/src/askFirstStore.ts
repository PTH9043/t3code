import { create } from "zustand";
import { persist } from "zustand/middleware";

import { useWorkspaceTabStore } from "./workspaceTabStore";

/** Settings written before any tab exists land here and stay readable. */
const NO_TAB_KEY = "__no-tab__";

function activeScopeKey(): string {
  return useWorkspaceTabStore.getState().activeTabId ?? NO_TAB_KEY;
}

interface AskFirstState {
  readonly enabledByTabId: Readonly<Record<string, boolean>>;
  readonly setEnabled: (tabId: string, enabled: boolean) => void;
  readonly dropTabs: (keepTabIds: ReadonlySet<string>) => void;
}

/**
 * "질문 먼저" — checked, every send in this tab (a meeting topic or a plain
 * task) instructs the AI to come back with its plan and clarifying questions
 * BEFORE touching anything, and to wait for the person's answer. Scoped per
 * workspace tab like the meeting room, persisted until turned off.
 */
export const useAskFirstStore = create<AskFirstState>()(
  persist(
    (set) => ({
      enabledByTabId: {},
      setEnabled: (tabId, enabled) =>
        set((state) =>
          (state.enabledByTabId[tabId] ?? false) === enabled
            ? state
            : { enabledByTabId: { ...state.enabledByTabId, [tabId]: enabled } },
        ),
      dropTabs: (keepTabIds) =>
        set((state) => {
          const entries = Object.entries(state.enabledByTabId).filter(
            ([tabId]) => tabId === NO_TAB_KEY || keepTabIds.has(tabId),
          );
          if (entries.length === Object.keys(state.enabledByTabId).length) return state;
          return { enabledByTabId: Object.fromEntries(entries) };
        }),
    }),
    {
      name: "t3.ask-first.v1",
      partialize: (state) => ({ enabledByTabId: state.enabledByTabId }),
    },
  ),
);

useWorkspaceTabStore.subscribe((state, previous) => {
  if (state.tabs === previous.tabs) return;
  useAskFirstStore.getState().dropTabs(new Set(state.tabs.map((tab) => tab.id)));
});

export function useAskFirstEnabled(): boolean {
  const activeTabId = useWorkspaceTabStore((state) => state.activeTabId) ?? NO_TAB_KEY;
  return useAskFirstStore((state) => state.enabledByTabId[activeTabId] ?? false);
}

export function readAskFirstEnabled(): boolean {
  return useAskFirstStore.getState().enabledByTabId[activeScopeKey()] ?? false;
}

export function setAskFirstEnabled(enabled: boolean): void {
  useAskFirstStore.getState().setEnabled(activeScopeKey(), enabled);
}

/**
 * Prepended to a plain task send. Phrased as the person's own instruction so
 * every provider treats it with user authority.
 */
export const ASK_FIRST_TASK_PREFIX =
  "[질문 먼저] 이 요청을 실행하기 전에: (1) 하려는 작업 계획을 간단히 요약하고 (2) 진행에 필요한 확인 질문이 있으면 모두 물어봐 줘. 내가 답하기 전까지는 파일 수정이나 명령 실행 같은 실제 작업을 시작하지 마.\n\n";

/**
 * Prepended to a meeting topic. The seats' statement prompt already carries
 * the `<t3_question>` protocol, and the server parks the run on it until the
 * person answers — so the instruction rides inside the topic itself.
 */
export const ASK_FIRST_MEETING_PREFIX =
  "[질문 먼저] 본격적인 논의를 시작하기 전에, 첫 발언자는 이 주제에 대해 확인이 필요한 사항이 있으면 <t3_question>으로 사용자에게 먼저 질문하고 답을 받은 뒤 논의를 진행하라. 확인할 것이 정말 없을 때만 곧바로 논의를 시작하라.\n\n";
