export type SettingsPath =
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/permissions"
  | "/settings/diagnostics"
  | "/settings/archived";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
}

/**
 * Section labels in sidebar order. The sidebar nav and the search-result
 * subtitles both render from this record, so each label exists once.
 */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/general": "일반",
  "/settings/appearance": "화면 및 테마",
  "/settings/keybindings": "단축키",
  "/settings/providers": "AI 제공자 및 CLI 계정",
  "/settings/source-control": "소스 제어",
  "/settings/connections": "연결",
  "/settings/permissions": "권한",
  "/settings/diagnostics": "시스템 진단 및 리소스",
  "/settings/archived": "보관함",
};

/**
 * Every searchable setting, in result order. This catalog is the single
 * source of truth for anchor ids and visible titles: panels render both via
 * `searchableSetting`, so a retitle (or, later, a translation pass) happens
 * here once instead of separately in the panel and the index.
 */
export const SETTINGS_SEARCH_ITEMS = [
  { id: "thread-response-style", title: "전역 답변 스타일", to: "/settings/general" },
  {
    id: "global-subordinate-team",
    title: "전역 하위 모델과 역할",
    to: "/settings/general",
    targetId: "thread-response-style",
  },
  { id: "search-models", title: "검색용 모델", to: "/settings/general" },
  {
    id: "openrouter-search-account",
    title: "OpenRouter 계정 연결",
    to: "/settings/general",
    targetId: "search-models",
  },
  {
    id: "baidu-search-account",
    title: "바이두(Baidu) Qianfan 계정 연결",
    to: "/settings/general",
    targetId: "search-models",
  },
  {
    id: "ai-document-search",
    title: "AI 문서 검색 · RAG · OCR · Grok 조사",
    to: "/settings/general",
    targetId: "ai-search",
  },
  { id: "codex-auto-switch", title: "Codex 자동 전환", to: "/settings/providers" },
  { id: "claude-auto-switch", title: "Claude 자동 전환", to: "/settings/providers" },
  {
    id: "color-scheme",
    title: "색상 모드",
    to: "/settings/appearance",
    // The scheme tiles sit at the top of the Appearance section.
    targetId: "appearance",
  },
  {
    id: "theme",
    title: "테마",
    to: "/settings/appearance",
    // Theme cards live directly under the scheme tiles; the section is the
    // stable scroll destination for both.
    targetId: "appearance",
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: "유리 효과 투명도",
    to: "/settings/appearance",
  },
  {
    id: "setting-chat-horizontal-inset",
    title: "대화방 좌우 여백 · 폭",
    to: "/settings/appearance",
  },
  {
    id: "environment-identification",
    title: "실행 환경 표시",
    to: "/settings/appearance",
    // The setting is stage-dependent, so its parent section is the stable destination.
    targetId: "appearance",
  },
  {
    id: "interface-font",
    title: "인터페이스 글꼴",
    to: "/settings/appearance",
  },
  {
    id: "prompt-font",
    title: "프롬프트 글꼴",
    to: "/settings/appearance",
  },
  {
    id: "code-font",
    title: "코드 글꼴",
    to: "/settings/appearance",
  },
  {
    id: "terminal-font",
    title: "터미널 글꼴",
    to: "/settings/appearance",
  },
  {
    id: "font-smoothing",
    title: "글꼴 다듬기",
    to: "/settings/appearance",
  },
  {
    id: "word-wrap",
    title: "자동 줄 바꿈",
    to: "/settings/appearance",
  },
  {
    id: "timeline-minimap",
    title: "메시지 이동 막대",
    to: "/settings/appearance",
  },
  {
    id: "project-grouping",
    title: "프로젝트 그룹화",
    to: "/settings/general",
  },
  {
    id: "background-watch-notice",
    title: "감시 중단 알림 표시 시간",
    to: "/settings/general",
  },
  {
    id: "upgrade-room-downtime-summary",
    title: "T3가 꺼진 동안 한 작업 표시",
    to: "/settings/general",
  },
  {
    id: "upgrade-room-offline-questions",
    title: "T3가 꺼져 있을 때 모델의 질문",
    to: "/settings/general",
  },
  {
    id: "auto-settle-inactive-threads",
    title: "비활성 대화 자동 정리",
    to: "/settings/general",
  },
  {
    id: "time-format",
    title: "시간 형식",
    to: "/settings/general",
  },
  {
    id: "hide-whitespace-changes",
    title: "공백 변경 숨기기",
    to: "/settings/general",
  },
  {
    id: "provider-update-checks",
    title: "AI 제공자 업데이트 확인",
    to: "/settings/general",
  },
  {
    id: "new-threads",
    title: "새 대화",
    to: "/settings/general",
  },
  {
    id: "start-from-origin",
    title: "원본 상태에서 시작",
    to: "/settings/general",
    targetId: "new-threads",
  },
  {
    id: "add-project-starts-in",
    title: "프로젝트 추가 시작 위치",
    to: "/settings/general",
  },
  {
    id: "archive-confirmation",
    title: "보관 전 확인",
    to: "/settings/general",
  },
  {
    id: "delete-confirmation",
    title: "삭제 전 확인",
    to: "/settings/general",
  },
  {
    id: "text-generation-model",
    title: "텍스트 생성 모델",
    to: "/settings/general",
  },
  {
    id: "diagnostics",
    title: "진단",
    to: "/settings/general",
  },
  {
    id: "legacy-plan-mode",
    title: "계획 모드 (이전 방식)",
    to: "/settings/general",
  },
  {
    id: "legacy-token-streaming",
    title: "토큰 단위 스트리밍 (이전 방식)",
    to: "/settings/general",
  },
  {
    id: "legacy-sidebar",
    title: "사이드바 (이전 방식)",
    to: "/settings/general",
  },
  {
    id: "keybindings",
    title: "단축키",
    to: "/settings/keybindings",
  },
  {
    id: "providers",
    title: "AI 제공자 및 CLI 계정",
    to: "/settings/providers",
  },
  {
    id: "source-control",
    title: "소스 제어",
    to: "/settings/source-control",
  },
  {
    id: "google-account",
    title: "Google 로그인",
    to: "/settings/connections",
  },
  {
    id: "remote-environments",
    title: "원격 실행 환경",
    to: "/settings/connections",
  },
  {
    id: "automatic-update-download",
    title: "자동 다운로드",
    to: "/settings/general",
  },
  {
    id: "automatic-update-install",
    title: "자동 설치 및 재시작",
    to: "/settings/general",
  },
  {
    id: "workspace-program-manual-control",
    title: "프로그램 수동 제어",
    to: "/settings/permissions",
  },
  {
    id: "workspace-program-log-collection",
    title: "프로그램 로그 수집",
    to: "/settings/permissions",
  },
  {
    id: "workspace-program-auto-start",
    title: "프로그램 자동 시작",
    to: "/settings/permissions",
  },
  {
    id: "workspace-program-auto-diagnosis",
    title: "프로그램 오류 자동 진단",
    to: "/settings/permissions",
  },
  {
    id: "workspace-program-auto-restart-after-repair",
    title: "수정 검증 후 자동 재시작",
    to: "/settings/permissions",
  },
  {
    id: "workspace-program-monitoring-auto-actions",
    title: "모니터링 자동 조치",
    to: "/settings/permissions",
  },
  {
    id: "self-monitoring-enabled",
    title: "T3 Code 자체 감시",
    to: "/settings/permissions",
  },
  {
    id: "self-monitoring-project",
    title: "자체 감시 수신 프로젝트",
    to: "/settings/permissions",
  },
  {
    id: "system-diagnostics",
    title: "시스템 진단 및 리소스",
    to: "/settings/diagnostics",
  },
  {
    id: "execution-ledger",
    title: "9종 협업 통합 실행 원장",
    to: "/settings/diagnostics",
  },
  {
    id: "archive",
    title: "보관된 대화",
    to: "/settings/archived",
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = Object.fromEntries(
  SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item]),
) as Readonly<Record<SettingsSearchItemId, SettingsSearchItem>>;

/**
 * `id` and `title` props for the element a search item anchors to. Panels
 * spread (or pick from) this instead of restating the strings, so the catalog
 * and the rendered settings cannot drift apart.
 */
export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID[id];
  return { id: anchorId, title };
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];

  return items.filter((item) => normalizeSearchText(item.title).includes(normalizedQuery));
}
