import { usePrimaryEnvironmentId } from "~/state/environments";
import { ArchiveIcon, ArchiveX, ChevronRightIcon, LoaderIcon, SettingsIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  type BackgroundActivityProfile,
  type DesktopUpdateChannel,
  ProviderDriverKind,
  type ScopedThreadRef,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_CHAT_HORIZONTAL_INSET_PX,
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  type EnvironmentIdentificationMode,
  MAX_CHAT_HORIZONTAL_INSET_PX,
  MAX_CODE_FONT_SIZE,
  MAX_GLASS_OPACITY,
  MAX_INTERFACE_FONT_SIZE,
  MAX_PROMPT_FONT_SIZE,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MAX_TERMINAL_FONT_SIZE,
  MIN_CHAT_HORIZONTAL_INSET_PX,
  MIN_CODE_FONT_SIZE,
  MIN_GLASS_OPACITY,
  MIN_INTERFACE_FONT_SIZE,
  MIN_PROMPT_FONT_SIZE,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_TERMINAL_FONT_SIZE,
} from "@t3tools/contracts/settings";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { APP_VERSION, HOSTED_APP_CHANNEL } from "../../branding";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { isElectron } from "../../env";
import { buildHostedChannelSelectionUrl, type HostedAppChannel } from "../../hostedPairing";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import {
  readAppearanceModePreference,
  readThemeHalves,
  readThemePreference,
  useTheme,
} from "../../hooks/useTheme";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { isMacPlatform } from "../../lib/utils";
import { primaryServerObservabilityAtom, primaryServerProvidersAtom } from "../../state/server";
import { useListedThreadShells, useProjects } from "../../state/entities";
import { useDesktopAssistant } from "../../hooks/useDesktopAssistant";
import { ThreadCharacter } from "../chat/ThreadCharacter";
import { ThreadAssistantProfile } from "../chat/ThreadAssistantProfile";
import { RoomModelSettings } from "../chat/RoomModelSettings";
import { AssistantVoiceSampleSettings } from "../chat/AssistantVoiceInput";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { DesktopUpdatePermissionsSection } from "./PermissionsSettings";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  isFontFamilyAvailable,
  isMonospaceFamily,
  resolveDefaultFamilyLabel,
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
  TYPOGRAPHY_ADVANCED_STORAGE_KEY,
} from "../../appearanceFonts";
import { CodeFontPreview, PromptFontPreview, TerminalFontPreview } from "./SettingsFontPreviews";
import { discoverInstalledFonts, FontFamilyPicker, useFontEnumeration } from "./FontFamilyPicker";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThemeLibrary } from "./ThemeSettings";
import {
  backgroundActivityOverrideSettings,
  backgroundActivitySharedPolicySettings,
  durationToSeconds,
  formatDiagnosticsDescription,
  normalizeIntervalSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
  hasChangedBackgroundActivitySettings,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  readLastEnabledProjectGroupingMode,
  rememberEnabledProjectGroupingMode,
  resolveBackgroundActivityProfileOption,
} from "./SettingsPanels.logic";
import {
  PolicyTooltip,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ProjectFavicon } from "../ProjectFavicon";
import { AiSearchSettingsSection } from "./AiSearchSettings";
import { SearchModelsSettingsSection } from "./SearchModelsSettings";
import { UpgradeRoomSettingsSection } from "./UpgradeRoomSettings";

const ENVIRONMENT_IDENTIFICATION_LABELS: Record<EnvironmentIdentificationMode, string> = {
  artwork: "배경 그림",
  pill: "버전 표시",
  none: "표시 안 함",
};

const TIMESTAMP_FORMAT_LABELS = {
  locale: "시스템 기본값",
  "12-hour": "12시간제",
  "24-hour": "24시간제",
} as const;

const BACKGROUND_ACTIVITY_PROFILE_LABELS: Record<BackgroundActivityProfile, string> = {
  balanced: "균형",
  performance: "성능 우선",
  "battery-saver": "배터리 절약",
};

type BackgroundActivityProfileOption = BackgroundActivityProfile | "advanced";

const BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS: Record<BackgroundActivityProfileOption, string> = {
  ...BACKGROUND_ACTIVITY_PROFILE_LABELS,
  advanced: "고급",
};

const BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS: Record<BackgroundActivityProfile, string> = {
  balanced:
    "클라이언트가 유휴 상태이거나 호스트가 잠겼거나 저전력 모드일 때 백그라운드 확인을 일시 중지합니다.",
  performance: "구독 중인 클라이언트가 연결되어 있는 동안 필요한 백그라운드 확인을 허용합니다.",
  "battery-saver": "호스트나 클라이언트가 배터리를 사용할 때도 백그라운드 확인을 일시 중지합니다.",
};

const ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION =
  "선택한 공통 전원 정책과 사용자 지정 백그라운드 주기를 사용합니다.";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES: ReadonlyArray<{
  readonly key:
    | "pauseWhenHostLocked"
    | "pauseWhenHostLowPower"
    | "pauseWhenClientLowPower"
    | "pauseWhenOnBattery";
  readonly label: string;
}> = [
  { key: "pauseWhenHostLocked", label: "호스트 잠금 시 일시 중지" },
  { key: "pauseWhenHostLowPower", label: "호스트 저전력 모드 시 일시 중지" },
  { key: "pauseWhenClientLowPower", label: "클라이언트 저전력 모드 시 일시 중지" },
  { key: "pauseWhenOnBattery", label: "배터리 사용 시 일시 중지" },
];

function resetBackgroundActivitySettings() {
  return {
    backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  };
}

function backgroundActivityProfileSettings(profile: BackgroundActivityProfile) {
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile,
      overrides: {},
    },
  };
}

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>버전</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const updateState = useDesktopUpdateState();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);

  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";
  const selectedHostedAppChannel = hasDesktopBridge ? null : HOSTED_APP_CHANNEL;

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) => {
      const bridge = window.desktopBridge;
      if (
        !bridge ||
        typeof bridge.setUpdateChannel !== "function" ||
        channel === selectedUpdateChannel
      ) {
        return;
      }

      setIsChangingUpdateChannel(true);
      void bridge
        .setUpdateChannel(channel)
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "업데이트 채널을 변경하지 못했습니다",
              description: "잠시 후 다시 시도해 주세요.",
            }),
          );
        })
        .finally(() => {
          setIsChangingUpdateChannel(false);
        });
    },
    [selectedUpdateChannel],
  );

  const handleButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge.downloadUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "업데이트를 다운로드하지 못했습니다",
            description: "잠시 후 다시 시도해 주세요.",
          }),
        );
      });
      return;
    }

    if (action === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
          navigator.platform,
        ),
      );
      if (!confirmed) return;
      void bridge.installUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "업데이트를 설치하지 못했습니다",
            description: "잠시 후 다시 시도해 주세요.",
          }),
        );
      });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "업데이트를 확인하지 못했습니다",
              description: "이 빌드에서는 자동 업데이트를 사용할 수 없습니다.",
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "업데이트를 확인하지 못했습니다",
            description: "잠시 후 다시 시도해 주세요.",
          }),
        );
      });
  }, [updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = { download: "다운로드", install: "설치" };
  const statusLabel: Record<string, string> = {
    checking: "확인 중…",
    downloading: "다운로드 중…",
    "up-to-date": "최신 버전",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "업데이트 확인";
  const description =
    action === "download" || action === "install"
      ? "새 업데이트를 사용할 수 있습니다."
      : "현재 설치된 애플리케이션 버전입니다.";

  return (
    <>
      <SettingsRow
        title={<AboutVersionTitle />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant={action === "install" ? "default" : "outline"}
                  disabled={buttonDisabled}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      {hasDesktopBridge ? (
        <SettingsRow
          title="업데이트 채널"
          description="안정판은 정식 릴리스를 따릅니다. 나이틀리는 매일 배포되는 데스크톱 채널을 사용하며 언제든 안정판으로 돌아갈 수 있습니다."
          control={
            <Select
              value={selectedUpdateChannel}
              onValueChange={(value) => {
                handleUpdateChannelChange(value as DesktopUpdateChannel);
              }}
            >
              <SelectTrigger
                className="w-full sm:w-40"
                aria-label="업데이트 채널"
                disabled={isChangingUpdateChannel}
              >
                <SelectValue>
                  {selectedUpdateChannel === "nightly" ? "나이틀리" : "안정판"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  안정판
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  나이틀리
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : selectedHostedAppChannel ? (
        <SettingsRow
          title="업데이트 채널"
          description="호스팅 앱의 릴리스 채널을 전환합니다."
          control={
            <Select
              value={selectedHostedAppChannel}
              onValueChange={(value) => {
                if (value === selectedHostedAppChannel) return;
                window.location.assign(
                  buildHostedChannelSelectionUrl({ channel: value as HostedAppChannel }),
                );
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="업데이트 채널">
                <SelectValue>
                  {selectedHostedAppChannel === "nightly" ? "나이틀리" : "최신"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  최신
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  나이틀리
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </>
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const {
    theme,
    setTheme,
    followSystem,
    setFollowSystem,
    setThemeHalf,
    clearThemeHalves,
    themeHalves,
  } = useTheme();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const isBackgroundActivityDirty = hasChangedBackgroundActivitySettings(settings);

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["테마"] : []),
      ...(!followSystem ? ["시스템 설정 따르기"] : []),
      ...(themeHalves !== null ? ["테마 조합"] : []),
      ...(settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity
        ? ["유리 효과 투명도"]
        : []),
      ...((settings.chatHorizontalInsetPx ?? DEFAULT_CHAT_HORIZONTAL_INSET_PX) !==
      DEFAULT_CHAT_HORIZONTAL_INSET_PX
        ? ["대화방 좌우 여백"]
        : []),
      ...(settings.environmentIdentificationMode !==
      DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode
        ? ["실행 환경 표시"]
        : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["시간 형식"]
        : []),
      ...(settings.sidebarThreadPreviewCount !== DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount
        ? ["표시할 대화 수"]
        : []),
      ...(settings.sidebarProjectGroupingMode !==
      DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode
        ? ["프로젝트 그룹화"]
        : []),
      ...(settings.sidebarAutoSettleAfterDays !==
      DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays
        ? ["비활성 대화 자동 정리"]
        : []),
      ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? ["자동 줄 바꿈"] : []),
      ...(settings.fontFamilySans !== DEFAULT_UNIFIED_SETTINGS.fontFamilySans
        ? ["인터페이스 글꼴"]
        : []),
      ...(settings.fontFamilyComposer !== DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer
        ? ["프롬프트 글꼴"]
        : []),
      ...(settings.fontFamilyCode !== DEFAULT_UNIFIED_SETTINGS.fontFamilyCode ? ["코드 글꼴"] : []),
      ...(settings.fontFamilyTerminal !== DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal
        ? ["터미널 글꼴"]
        : []),
      ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
        ? ["차이 비교의 공백 변경"]
        : []),
      ...(settings.enableLegacyTokenStreaming !==
      DEFAULT_UNIFIED_SETTINGS.enableLegacyTokenStreaming
        ? ["토큰 단위 스트리밍"]
        : []),
      ...(settings.enableProviderUpdateChecks !==
      DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks
        ? ["AI 제공자 업데이트 확인"]
        : []),
      ...(isBackgroundActivityDirty ? ["백그라운드 활동"] : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["새 대화 실행 방식"]
        : []),
      ...(settings.newWorktreesStartFromOrigin !==
      DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin
        ? ["새 작업 트리를 원격 원본에서 시작"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["프로젝트 추가 기본 폴더"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["보관 전 확인"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["삭제 전 확인"]
        : []),
      ...(isTextGenerationModelDirty ? ["텍스트 생성 모델"] : []),
    ],
    [
      isTextGenerationModelDirty,
      isBackgroundActivityDirty,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.addProjectBaseDirectory,
      settings.defaultThreadEnvMode,
      settings.newWorktreesStartFromOrigin,
      settings.diffIgnoreWhitespace,
      settings.environmentIdentificationMode,
      settings.fontFamilyCode,
      settings.fontFamilyComposer,
      settings.fontFamilySans,
      settings.fontFamilyTerminal,
      settings.fontSizeCode,
      settings.fontSizeInterface,
      settings.fontSizePrompt,
      settings.fontSizeTerminal,
      settings.glassOpacity,
      settings.enableLegacyTokenStreaming,
      settings.enableProviderUpdateChecks,
      settings.sidebarAutoSettleAfterDays,
      settings.sidebarProjectGroupingMode,
      settings.sidebarThreadPreviewCount,
      settings.timestampFormat,
      settings.wordWrap,
      followSystem,
      theme,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      [
        "설정을 기본값으로 복원할까요?",
        `다음 항목이 초기화됩니다: ${changedSettingLabels.join(", ")}.`,
      ].join("\n"),
    );
    if (!confirmed) return;

    // Only touch the theme keys that are actually dirty, so a theme-storage
    // failure cannot block restoring unrelated settings. Preferences are
    // re-read after the confirmation dialog: they may have changed (another
    // tab, an OS flip) while it was open, and rollback must restore the live
    // values rather than the ones captured at render time.
    let previousTheme = theme;
    try {
      previousTheme = readThemePreference();
    } catch {
      // Storage is unreadable; the render-time value is the best rollback.
    }
    // The mix may have changed while the confirmation dialog was open; both
    // the dirty check and the rollback must see the live value.
    const liveHalves = readThemeHalves();
    const needsThemeReset = previousTheme !== "system";
    const needsMixReset = liveHalves !== null;
    // Same for the appearance mode: trusting the render-time value would skip
    // the reset and report success while a non-system mode stayed in storage.
    const needsFollowSystemReset = readAppearanceModePreference(previousTheme) !== "system";
    const notifyThemeRestoreFailure = () => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "테마 설정을 복원하지 못했습니다",
          description: "다시 시도해 주세요.",
        }),
      );
    };
    // Rollback restores the base preference first (which clears any mix) and
    // then re-applies the captured mix on top, so no failure path can leave
    // the pair of keys half-restored.
    const previousHalves = liveHalves;
    const rollbackThemeState = () => {
      if (needsThemeReset) setTheme(previousTheme);
      if (previousHalves?.light) setThemeHalf("light", previousHalves.light);
      if (previousHalves?.dark) setThemeHalf("dark", previousHalves.dark);
    };
    if (needsThemeReset && !setTheme("system")) {
      notifyThemeRestoreFailure();
      return;
    }
    if (needsMixReset && !clearThemeHalves()) {
      rollbackThemeState();
      notifyThemeRestoreFailure();
      return;
    }
    if (needsFollowSystemReset && !setFollowSystem(true)) {
      rollbackThemeState();
      notifyThemeRestoreFailure();
      return;
    }
    updateSettings({
      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
      wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
      diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
      environmentIdentificationMode: DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode,
      glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity,
      chatHorizontalInsetPx: DEFAULT_CHAT_HORIZONTAL_INSET_PX,
      sidebarThreadPreviewCount: DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount,
      sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
      sidebarAutoSettleAfterDays: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
      enableLegacyTokenStreaming: DEFAULT_UNIFIED_SETTINGS.enableLegacyTokenStreaming,
      enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
      backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
      backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
      automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
      providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
      newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
      fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
      fontFamilyComposer: DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer,
      fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
      fontFamilyTerminal: DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal,
    });
    onRestored?.();
  }, [
    changedSettingLabels,
    clearThemeHalves,
    onRestored,
    setFollowSystem,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
    updateSettings,
  ]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

function BackgroundActivityAdvancedDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeProfile = resolvedBackgroundActivity.profile;
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  );
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const hostPowerMonitorActiveIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorActiveInterval,
  );
  const hostPowerMonitorIdleIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorIdleInterval,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>백그라운드 활동</DialogTitle>
          <DialogDescription>
            공통 전원 정책과 각 백그라운드 작업의 실행 주기를 조정합니다.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-0 px-6 pb-5">
          <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">공통 정책</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  설정한 주기가 되었을 때 백그라운드 작업을 실행할지 결정합니다.
                </p>
              </div>
              <Select
                value={activeProfile}
                onValueChange={(value) => {
                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings({
                      backgroundActivity: backgroundActivitySharedPolicySettings(settings, value),
                    });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="공통 백그라운드 정책">
                  <SelectValue>{BACKGROUND_ACTIVITY_PROFILE_LABELS[activeProfile]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.performance}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"]}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>

            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">Git 가져오기 주기</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  백그라운드에서 원격 브랜치 상태를 새로 고칩니다.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={automaticGitFetchIntervalSeconds}
                  min={0}
                  step={5}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          automaticGitFetchInterval: Duration.seconds(
                            normalizeIntervalSeconds(value),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Git 가져오기 주기 줄이기" />
                    <NumberFieldInput aria-label="Git 가져오기 주기(초)" />
                    <NumberFieldIncrement aria-label="Git 가져오기 주기 늘리기" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">초</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">AI 제공자 상태 확인 주기</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  제공자의 사용 가능 여부, 버전, 인증 상태와 모델 정보를 새로 고칩니다.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={providerHealthRefreshIntervalSeconds}
                  min={0}
                  step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          providerHealthRefreshInterval: Duration.seconds(
                            normalizeIntervalSeconds(value),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="AI 제공자 상태 확인 주기 줄이기" />
                    <NumberFieldInput aria-label="AI 제공자 상태 확인 주기(초)" />
                    <NumberFieldIncrement aria-label="AI 제공자 상태 확인 주기 늘리기" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">초</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">호스트 전원 상태 확인</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  클라이언트가 활성 상태일 때 호스트 전원 상태를 확인합니다.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={hostPowerMonitorActiveIntervalSeconds}
                  min={5}
                  step={5}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          hostPowerMonitorActiveInterval: Duration.seconds(
                            normalizeIntervalSeconds(value, 5),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="활성 상태 전원 확인 주기 줄이기" />
                    <NumberFieldInput aria-label="활성 상태 전원 확인 주기(초)" />
                    <NumberFieldIncrement aria-label="활성 상태 전원 확인 주기 늘리기" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">초</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">유휴 호스트 상태 확인</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  전면에서 활성 상태인 클라이언트가 없을 때 호스트 전원 상태를 확인합니다.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={hostPowerMonitorIdleIntervalSeconds}
                  min={5}
                  step={30}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          hostPowerMonitorIdleInterval: Duration.seconds(
                            normalizeIntervalSeconds(value, 5),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="유휴 상태 전원 확인 주기 줄이기" />
                    <NumberFieldInput aria-label="유휴 상태 전원 확인 주기(초)" />
                    <NumberFieldIncrement aria-label="유휴 상태 전원 확인 주기 늘리기" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">초</span>
              </div>
            </div>

            <div className="grid gap-0 border-t sm:grid-cols-2">
              {BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES.map(({ key, label }) => (
                <label
                  key={key}
                  className="flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0 sm:border-r sm:even:border-r-0"
                >
                  <span className="text-sm font-medium">{label}</span>
                  <Switch
                    checked={resolvedBackgroundActivity[key]}
                    onCheckedChange={(checked) =>
                      updateSettings(
                        backgroundActivityOverrideSettings(
                          settings.backgroundActivity,
                          resolvedBackgroundActivity,
                          {
                            [key]: Boolean(checked),
                          },
                        ),
                      )
                    }
                    aria-label={label}
                  />
                </label>
              ))}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => updateSettings(resetBackgroundActivitySettings())}
          >
            모두 초기화
          </Button>
          <Button onClick={() => onOpenChange(false)}>완료</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function AppearanceSettingsPanel() {
  const {
    appearanceMode,
    refreshTheme,
    resolvedTheme,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
  } = useTheme();
  const customThemes = useCustomThemes();
  const [isImportThemeOpen, setIsImportThemeOpen] = useState(false);
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const environmentStageLabel = useEnvironmentStageLabel();
  const showEnvironmentIdentification =
    resolveEnvironmentIdentificationPillLabel(environmentStageLabel) !== null;
  const glassOpacityRatio =
    (settings.glassOpacity - MIN_GLASS_OPACITY) / (MAX_GLASS_OPACITY - MIN_GLASS_OPACITY);
  const glassOpacitySliderStyle = {
    "--settings-slider-progress": `${glassOpacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - glassOpacityRatio}rem`,
  } as CSSProperties;
  const chatHorizontalInsetPx = settings.chatHorizontalInsetPx ?? DEFAULT_CHAT_HORIZONTAL_INSET_PX;
  const chatHorizontalInsetSliderValue = chatHorizontalInsetPx ?? 48;
  const chatHorizontalInsetRatio =
    (chatHorizontalInsetSliderValue - MIN_CHAT_HORIZONTAL_INSET_PX) /
    (MAX_CHAT_HORIZONTAL_INSET_PX - MIN_CHAT_HORIZONTAL_INSET_PX);
  const chatHorizontalInsetSliderStyle = {
    "--settings-slider-progress": `${chatHorizontalInsetRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - chatHorizontalInsetRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsPageContainer>
      <SettingsSection id="appearance" title="화면 및 테마">
        <div id={searchableSetting("theme").id}>
          <ThemeLibrary
            appearanceMode={appearanceMode}
            customThemes={customThemes}
            initialAppearance={resolvedTheme}
            refreshTheme={refreshTheme}
            isImportOpen={isImportThemeOpen}
            setAppearanceMode={setAppearanceMode}
            setTheme={setTheme}
            setThemeHalf={setThemeHalf}
            theme={theme}
            themeHalves={themeHalves}
            onImportOpenChange={setIsImportThemeOpen}
          />
        </div>

        <SettingsRow
          {...searchableSetting("setting-glass-opacity")}
          description="유리 효과가 적용된 화면의 투명도를 조절합니다. 값이 높을수록 메뉴, 대화 상자와 입력창이 더 선명해집니다."
          resetAction={
            settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? (
              <SettingResetButton
                label="유리 효과 투명도"
                onClick={() =>
                  updateSettings({ glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="glass-opacity"
              >
                {settings.glassOpacity}%
              </output>
              <input
                aria-label="유리 효과 투명도"
                className="settings-slider min-w-0 flex-1"
                id="glass-opacity"
                max={MAX_GLASS_OPACITY}
                min={MIN_GLASS_OPACITY}
                onChange={(event) => {
                  const glassOpacity = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(glassOpacity) &&
                    glassOpacity >= MIN_GLASS_OPACITY &&
                    glassOpacity <= MAX_GLASS_OPACITY
                  ) {
                    updateSettings({ glassOpacity });
                  }
                }}
                step={5}
                style={glassOpacitySliderStyle}
                type="range"
                value={settings.glassOpacity}
              />
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("setting-chat-horizontal-inset")}
          description="대화방 본문·입력창과 양옆 경계선 사이의 간격을 조절합니다. 자동은 창 너비에 맞춰 기존 반응형 여백을 유지합니다."
          resetAction={
            chatHorizontalInsetPx !== DEFAULT_CHAT_HORIZONTAL_INSET_PX ? (
              <SettingResetButton
                label="대화방 좌우 여백"
                onClick={() =>
                  updateSettings({ chatHorizontalInsetPx: DEFAULT_CHAT_HORIZONTAL_INSET_PX })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full flex-col gap-2 sm:w-64">
              <div className="flex items-center gap-3">
                <output
                  className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                  htmlFor="chat-horizontal-inset"
                >
                  {chatHorizontalInsetPx === null ? "자동" : `${chatHorizontalInsetPx}px`}
                </output>
                <input
                  aria-label="대화방 좌우 여백"
                  className="settings-slider min-w-0 flex-1"
                  id="chat-horizontal-inset"
                  max={MAX_CHAT_HORIZONTAL_INSET_PX}
                  min={MIN_CHAT_HORIZONTAL_INSET_PX}
                  onChange={(event) => {
                    const nextInsetPx = Number(event.currentTarget.value);
                    if (
                      Number.isInteger(nextInsetPx) &&
                      nextInsetPx >= MIN_CHAT_HORIZONTAL_INSET_PX &&
                      nextInsetPx <= MAX_CHAT_HORIZONTAL_INSET_PX
                    ) {
                      updateSettings({ chatHorizontalInsetPx: nextInsetPx });
                    }
                  }}
                  step={4}
                  style={chatHorizontalInsetSliderStyle}
                  type="range"
                  value={chatHorizontalInsetSliderValue}
                />
              </div>
              <div className="grid grid-cols-4 gap-1">
                {(
                  [
                    { label: "자동", value: null },
                    { label: "12px", value: 12 },
                    { label: "48px", value: 48 },
                    { label: "96px", value: 96 },
                  ] as const
                ).map((preset) => {
                  const active = chatHorizontalInsetPx === preset.value;
                  return (
                    <Button
                      key={preset.label}
                      type="button"
                      size="xs"
                      variant={active ? "secondary" : "outline"}
                      aria-pressed={active}
                      onClick={() => updateSettings({ chatHorizontalInsetPx: preset.value })}
                    >
                      {preset.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          }
        />

        {showEnvironmentIdentification ? (
          <SettingsRow
            {...searchableSetting("environment-identification")}
            description="개발 및 나이틀리 실행 환경을 구분해 표시하는 방식을 선택합니다."
            resetAction={
              settings.environmentIdentificationMode !== DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE ? (
                <SettingResetButton
                  label="실행 환경 표시"
                  onClick={() =>
                    updateSettings({
                      environmentIdentificationMode: DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.environmentIdentificationMode}
                onValueChange={(value) => {
                  if (value === "artwork" || value === "pill" || value === "none") {
                    updateSettings({ environmentIdentificationMode: value });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="실행 환경 표시">
                  <SelectValue>
                    {ENVIRONMENT_IDENTIFICATION_LABELS[settings.environmentIdentificationMode]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {Object.entries(ENVIRONMENT_IDENTIFICATION_LABELS).map(([value, label]) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
      </SettingsSection>

      <TypographySection />
    </SettingsPageContainer>
  );
}

function useFontDefaultFamilies() {
  const settings = usePrimarySettings();
  // An unset preference shows the font it resolves to on this machine; the
  // default stacks are the platform's own faces, so the name is probed, not
  // hardcoded.
  const defaults = useMemo(
    () => ({
      sans: resolveDefaultFamilyLabel(DEFAULT_SANS_FONT_STACK) ?? "시스템 기본 글꼴",
      code: resolveDefaultFamilyLabel(DEFAULT_CODE_FONT_STACK) ?? "시스템 고정폭 글꼴",
    }),
    [],
  );
  return {
    sans: defaults.sans,
    code: defaults.code,
    // The composer inherits whatever the interface preference resolves to.
    interfaceFamily: settings.fontFamilySans.trim() || defaults.sans,
  };
}

function InterfaceFontRow({ preview }: { preview?: ReactNode }) {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("interface-font")}
      description="코드 블록과 터미널을 제외한 모든 화면에 사용합니다."
      defaultFamily={defaults.sans}
      value={settings.fontFamilySans}
      onValueChange={(fontFamilySans) => updateSettings({ fontFamilySans })}
      size={{
        label: "인터페이스 글꼴 크기",
        min: MIN_INTERFACE_FONT_SIZE,
        max: MAX_INTERFACE_FONT_SIZE,
        value: settings.fontSizeInterface,
        onChange: (fontSizeInterface) => updateSettings({ fontSizeInterface }),
      }}
      {...(preview !== undefined ? { preview } : {})}
    />
  );
}

function PromptFontRow() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("prompt-font")}
      description="프롬프트를 입력하는 상자에만 사용합니다. 고정폭 글꼴도 잘 어울립니다."
      defaultFamily={defaults.interfaceFamily}
      value={settings.fontFamilyComposer}
      onValueChange={(fontFamilyComposer) => updateSettings({ fontFamilyComposer })}
      size={{
        label: "프롬프트 글꼴 크기",
        min: MIN_PROMPT_FONT_SIZE,
        max: MAX_PROMPT_FONT_SIZE,
        value: settings.fontSizePrompt,
        onChange: (fontSizePrompt) => updateSettings({ fontSizePrompt }),
      }}
      preview={<PromptFontPreview />}
    />
  );
}

function CodeFontRow({
  title,
  description = "코드 블록, 변경 사항 비교와 파일 미리보기에 사용합니다.",
  preview,
}: {
  title?: string;
  description?: string;
  preview?: ReactNode;
}) {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("code-font")}
      {...(title !== undefined ? { title } : {})}
      description={description}
      defaultFamily={defaults.code}
      value={settings.fontFamilyCode}
      onValueChange={(fontFamilyCode) => updateSettings({ fontFamilyCode })}
      requireMonospace
      size={{
        label: "코드 글꼴 크기",
        min: MIN_CODE_FONT_SIZE,
        max: MAX_CODE_FONT_SIZE,
        value: settings.fontSizeCode,
        onChange: (fontSizeCode) => updateSettings({ fontSizeCode }),
      }}
      preview={preview ?? <CodeFontPreview />}
    />
  );
}

function TerminalFontRow() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("terminal-font")}
      description="코드 블록 및 변경 사항 비교와 별개로 터미널 출력에 사용합니다."
      defaultFamily={defaults.code}
      value={settings.fontFamilyTerminal}
      onValueChange={(fontFamilyTerminal) => updateSettings({ fontFamilyTerminal })}
      requireMonospace
      size={{
        label: "터미널 글꼴 크기",
        min: MIN_TERMINAL_FONT_SIZE,
        max: MAX_TERMINAL_FONT_SIZE,
        value: settings.fontSizeTerminal,
        onChange: (fontSizeTerminal) => updateSettings({ fontSizeTerminal }),
      }}
      preview={
        <TerminalFontPreview
          family={resolveTerminalFontPreference({
            advanced: true,
            code: settings.fontFamilyCode,
            terminal: settings.fontFamilyTerminal,
          })}
          size={settings.fontSizeTerminal}
        />
      }
    />
  );
}

function FontSmoothingRow() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  if (!isMacPlatform(navigator.platform)) return null;
  return (
    <SettingsRow
      {...searchableSetting("font-smoothing")}
      description="macOS의 진한 기본 표현 대신 더 얇은 회색조 안티앨리어싱으로 글자를 표시합니다."
      resetAction={
        settings.fontSmoothing !== DEFAULT_UNIFIED_SETTINGS.fontSmoothing ? (
          <SettingResetButton
            label="글꼴 다듬기"
            onClick={() =>
              updateSettings({ fontSmoothing: DEFAULT_UNIFIED_SETTINGS.fontSmoothing })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.fontSmoothing}
          onCheckedChange={(checked) => updateSettings({ fontSmoothing: Boolean(checked) })}
          aria-label="글꼴 다듬기"
        />
      }
    />
  );
}

function WordWrapRow() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsRow
      {...searchableSetting("word-wrap")}
      description="코드 블록, 표, 변경 사항 비교와 파일 미리보기에서 긴 줄을 기본으로 줄 바꿈합니다."
      resetAction={
        settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? (
          <SettingResetButton
            label="자동 줄 바꿈"
            onClick={() => updateSettings({ wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap })}
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.wordWrap}
          onCheckedChange={(checked) => updateSettings({ wordWrap: Boolean(checked) })}
          aria-label="코드, 표, 변경 사항 비교와 파일 미리보기에서 자동 줄 바꿈"
        />
      }
    />
  );
}

function TimelineMinimapRow() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsRow
      {...searchableSetting("timeline-minimap")}
      description="대화 오른쪽에 표시되는 막대를 클릭해 이전 메시지로 바로 이동합니다. 끄면 막대가 완전히 숨겨집니다."
      resetAction={
        settings.timelineMinimapEnabled !== DEFAULT_UNIFIED_SETTINGS.timelineMinimapEnabled ? (
          <SettingResetButton
            label="메시지 이동 막대"
            onClick={() =>
              updateSettings({
                timelineMinimapEnabled: DEFAULT_UNIFIED_SETTINGS.timelineMinimapEnabled,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.timelineMinimapEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ timelineMinimapEnabled: Boolean(checked) })
          }
          aria-label="메시지 이동 막대"
        />
      }
    />
  );
}

function FontSettingsGroup() {
  return (
    <>
      <InterfaceFontRow />
      <PromptFontRow />
      <CodeFontRow />
      <TerminalFontRow />
      <FontSmoothingRow />
    </>
  );
}

/**
 * The two-font view: one sans, one monospace. The prompt follows the
 * interface font and the terminal follows the monospace font, so the demos
 * under each row show every surface the choice reaches.
 */
function SimpleFontRows() {
  const settings = usePrimarySettings();
  return (
    <>
      <InterfaceFontRow preview={<PromptFontPreview />} />
      <CodeFontRow
        title="고정폭 글꼴"
        description="코드 블록, 변경 사항 비교, 파일 미리보기와 터미널에 사용합니다."
        preview={
          <>
            <CodeFontPreview />
            <TerminalFontPreview
              family={resolveTerminalFontPreference({
                advanced: false,
                code: settings.fontFamilyCode,
                terminal: settings.fontFamilyTerminal,
              })}
              size={resolveTerminalFontSizePreference({
                advanced: false,
                code: settings.fontSizeCode,
                terminal: settings.fontSizeTerminal,
              })}
            />
          </>
        }
      />
    </>
  );
}

// Font smoothing only renders on macOS, so a search jump to it elsewhere
// must not flip the section - the target would never mount to be scrolled to.
const ADVANCED_TYPOGRAPHY_TARGET_IDS: ReadonlySet<string> = new Set([
  "prompt-font",
  "terminal-font",
  ...(typeof navigator !== "undefined" && isMacPlatform(navigator.platform)
    ? ["font-smoothing"]
    : []),
]);

/**
 * The two-font view by default - one sans, one monospace, each cascading to
 * every surface it reaches - with an Advanced switch in the section header
 * that reveals the per-surface override rows. The choice persists locally,
 * and a settings-search jump to an override row flips Advanced on so the
 * target exists to scroll to.
 */
function TypographySection() {
  const [advanced, setAdvanced] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const searchTargetId = useSettingsSearchTargetId();
  // Flip Advanced on once per search jump so the hidden target can mount and
  // scroll; tracking the handled id lets the user turn it back off without
  // the still-set target immediately re-expanding the section.
  const lastExpandedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchTargetId === null || !ADVANCED_TYPOGRAPHY_TARGET_IDS.has(searchTargetId)) return;
    if (lastExpandedTargetRef.current === searchTargetId) return;
    lastExpandedTargetRef.current = searchTargetId;
    setAdvanced(true);
  }, [searchTargetId, setAdvanced]);
  return (
    <SettingsSection
      title="글꼴"
      headerAction={
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
          고급
          <Switch
            checked={advanced}
            onCheckedChange={(checked) => setAdvanced(Boolean(checked))}
            aria-label="고급 글꼴 설정 표시"
          />
        </label>
      }
    >
      {advanced ? <FontSettingsGroup /> : <SimpleFontRows />}
      <WordWrapRow />
      <TimelineMinimapRow />
    </SettingsSection>
  );
}

function FontFamilySettingsRow({
  id,
  title,
  description,
  defaultFamily,
  preview,
  value,
  onValueChange,
  requireMonospace = false,
  size,
}: {
  id?: string;
  title: string;
  description: string;
  /** What an unset preference renders as, e.g. "Menlo". */
  defaultFamily: string;
  preview?: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  requireMonospace?: boolean;
  size: { label: string; min: number; max: number; value: number; onChange: (v: number) => void };
}) {
  const trimmed = value.trim();
  // The fallback input edits a draft; the preference only commits once typing
  // pauses and the text probes as an available font (or is an explicit
  // clear), so the current font holds and nothing reflows mid-word.
  const [draft, setDraft] = useState(value);
  const [draftSettled, setDraftSettled] = useState(true);
  const commitTimerRef = useRef<number | null>(null);
  const lastValueRef = useRef(value);
  if (lastValueRef.current !== value) {
    // The committed value changed externally (hydration, reset, picker
    // selection); adopt it and drop any pending commit of a stale draft.
    lastValueRef.current = value;
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    setDraft(value);
    setDraftSettled(true);
  }
  useEffect(
    () => () => {
      if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current);
    },
    [],
  );
  const acceptsFamily = (candidate: string) =>
    isFontFamilyAvailable(candidate) && (!requireMonospace || isMonospaceFamily(candidate));
  const commitDraft = (next: string) => {
    setDraftSettled(true);
    // A rejected name stays in the field, flagged: the terminal would silently
    // fall back to its default, so the row must not claim it took the value.
    if (next.trim().length === 0 || acceptsFamily(next)) {
      onValueChange(next);
    }
  };
  const flushDraft = () => {
    if (commitTimerRef.current === null) return;
    window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
    commitDraft(draft);
  };
  const draftTrimmed = draft.trim();
  // Flag an unknown name only once typing pauses, and never for an empty
  // field - that is the starting state, not a rejected entry.
  const draftPending = draftSettled && draftTrimmed.length > 0 && draftTrimmed !== trimmed;
  const resetAction =
    trimmed.length > 0 ? (
      <SettingResetButton label={`${title} 종류`} onClick={() => onValueChange("")} />
    ) : null;
  const fontEnumeration = useFontEnumeration();
  // Everyone starts on the plain input; focusing it is the user gesture that
  // runs font discovery. Where the engine can enumerate, the control then
  // upgrades to the picker - popped open when the swap happens under focus,
  // so the interaction continues without a second click.
  const inputFocusedRef = useRef(false);
  const familyControl =
    fontEnumeration.status === "granted" ? (
      <FontFamilyPicker
        ariaLabel={`${title} 종류`}
        defaultFamily={defaultFamily}
        selectedFamily={trimmed}
        requireMonospace={requireMonospace}
        initialOpen={inputFocusedRef.current}
        onSelect={onValueChange}
      />
    ) : (
      <Input
        aria-label={`${title} 종류`}
        aria-invalid={draftPending || undefined}
        autoCapitalize="off"
        autoComplete="off"
        className="min-w-0 flex-1"
        maxLength={200}
        onFocus={() => {
          inputFocusedRef.current = true;
          discoverInstalledFonts();
        }}
        onBlur={() => {
          inputFocusedRef.current = false;
          flushDraft();
        }}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          setDraftSettled(false);
          if (commitTimerRef.current !== null) {
            window.clearTimeout(commitTimerRef.current);
          }
          commitTimerRef.current = window.setTimeout(() => {
            commitTimerRef.current = null;
            commitDraft(next);
          }, 400);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") flushDraft();
          if (event.key === "Escape") {
            // Discard uncommitted typing without closing the settings page,
            // which is what an unhandled Escape does.
            event.preventDefault();
            event.stopPropagation();
            if (commitTimerRef.current !== null) {
              window.clearTimeout(commitTimerRef.current);
              commitTimerRef.current = null;
            }
            setDraft(value);
            setDraftSettled(true);
          }
        }}
        placeholder={defaultFamily}
        spellCheck={false}
        value={draft}
      />
    );
  const control = (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <div className="min-w-0 flex-1 sm:w-44 sm:flex-none">{familyControl}</div>
      <Select
        value={String(size.value)}
        onValueChange={(next) => {
          if (typeof next !== "string") return;
          const parsed = Number(next);
          if (Number.isInteger(parsed) && parsed >= size.min && parsed <= size.max) {
            size.onChange(parsed);
          }
        }}
      >
        <SelectTrigger className="w-22 shrink-0" aria-label={size.label}>
          <SelectValue>{size.value} px</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {Array.from({ length: size.max - size.min + 1 }, (_, index) => size.min + index).map(
            (px) => (
              <SelectItem hideIndicator key={px} value={String(px)}>
                {px} px
              </SelectItem>
            ),
          )}
        </SelectPopup>
      </Select>
    </div>
  );
  return (
    <SettingsRow
      {...(id !== undefined ? { id } : {})}
      title={title}
      description={description}
      resetAction={resetAction}
      control={control}
    >
      {preview}
    </SettingsRow>
  );
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  // Local draft so the field can be emptied mid-edit; the setting only moves
  // on valid input and snaps back to the persisted value on blur.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <Input
      type="number"
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        // Number(), not parseInt: "3.5" must be rejected (not truncated to a
        // committed 3 while the field shows 3.5) — commit only when the
        // persisted value matches the displayed one.
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
          parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label="자동 정리 전 비활성 일수"
    />
  );
}

// The legacy rows sit behind the fold, so a settings-search jump has to
// expand the section before its target can mount and scroll.
const LEGACY_FEATURE_TARGET_IDS: ReadonlySet<string> = new Set([
  "legacy-plan-mode",
  "legacy-token-streaming",
  "legacy-sidebar",
]);

/**
 * Retired features kept only for users who still depend on them. Collapsed by
 * default so they stay out of the everyday settings path; a settings-search
 * jump to one of the rows unfolds the section.
 */
function LegacyFeaturesSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  // Unfold once per search jump; tracking the handled id lets the user fold
  // the section back up without the still-set target immediately reopening it.
  const lastExpandedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchTargetId === null) {
      // A handled jump clears the target; forgetting it here lets a later
      // jump to the same row expand the section again.
      lastExpandedTargetRef.current = null;
      return;
    }
    if (!LEGACY_FEATURE_TARGET_IDS.has(searchTargetId)) return;
    if (lastExpandedTargetRef.current === searchTargetId) return;
    lastExpandedTargetRef.current = searchTargetId;
    setOpen(true);
  }, [searchTargetId]);

  return (
    <section className="space-y-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex min-h-8 w-full items-center gap-2 px-3 sm:px-4">
          <h2 className="text-lg font-semibold tracking-[-0.025em] text-muted-foreground transition-colors group-hover:text-foreground">
            이전 기능
          </h2>
          <ChevronRightIcon className="size-4 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="relative space-y-1 overflow-visible pt-3 text-foreground">
            <SettingsRow
              {...searchableSetting("legacy-plan-mode")}
              description="입력창의 빌드/계획 전환, /plan 및 /default 명령과 Shift+Tab 단축키를 다시 표시합니다. 끄면 모든 대화가 빌드 모드로 실행됩니다."
              control={
                <Switch
                  checked={settings.planModeEnabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ planModeEnabled: Boolean(checked) })
                  }
                  aria-label="계획 모드(이전 방식)"
                />
              }
            />
            <SettingsRow
              {...searchableSetting("legacy-token-streaming")}
              description="도우미의 응답을 완성된 묶음이 아니라 토큰 단위로 표시합니다. 속도가 크게 느려지고 긴 응답을 읽기 어려워 권장하지 않으며, 이전 동작과의 호환성을 위해서만 유지됩니다."
              control={
                <Switch
                  checked={settings.enableLegacyTokenStreaming}
                  onCheckedChange={(checked) => {
                    if (!checked) {
                      updateSettings({ enableLegacyTokenStreaming: false });
                      return;
                    }
                    void (async () => {
                      const api = readLocalApi();
                      const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
                        [
                          "토큰 단위 출력을 켤까요?",
                          "기본 묶음 출력보다 훨씬 느리고 읽기 불편합니다. 이전 동작과의 호환성을 위해서만 제공되는 기능입니다.",
                        ].join("\n"),
                      );
                      if (confirmed) updateSettings({ enableLegacyTokenStreaming: true });
                    })();
                  }}
                  aria-label="토큰 단위 스트리밍(이전 방식)"
                />
              }
            />
            <SettingsRow
              {...searchableSetting("legacy-sidebar")}
              description="프로젝트별 대화 트리를 사용하는 이전 사이드바를 다시 표시합니다. 기본 사이드바는 활성 작업을 큰 카드로, 정리된 대화를 작은 행으로 한 목록에 표시합니다."
              control={
                <Switch
                  checked={settings.legacySidebarEnabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ legacySidebarEnabled: Boolean(checked) })
                  }
                  aria-label="사이드바(이전 방식)"
                />
              }
            />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

function AssistantSettingsSection() {
  const threads = useListedThreadShells();
  const projects = useProjects();
  const [selection, setSelection] = useState("");
  const selected = threads.find((thread) => `${thread.environmentId}:${thread.id}` === selection);
  return (
    <SettingsSection title="대화 비서 설정">
      <label className="flex flex-col gap-2 px-4 py-3 text-sm">
        설정할 대화
        <select
          className="rounded border border-border bg-background px-2 py-1 text-foreground"
          value={selection}
          onChange={(event) => setSelection(event.currentTarget.value)}
        >
          <option value="">대화를 선택하세요</option>
          {threads.map((thread) => {
            const project = projects.find(
              (item) => item.environmentId === thread.environmentId && item.id === thread.projectId,
            );
            return (
              <option
                key={`${thread.environmentId}:${thread.id}`}
                value={`${thread.environmentId}:${thread.id}`}
              >
                {project?.title ?? "프로젝트"} · {thread.title}
              </option>
            );
          })}
        </select>
      </label>
      {selected ? (
        <div key={selection}>
          <ThreadCharacter
            environmentId={selected.environmentId}
            threadId={selected.id}
            isWorking={false}
            settingsMode
          />
          <ThreadAssistantProfile
            environmentId={selected.environmentId}
            threadId={selected.id}
            computerAvailable
          />
        </div>
      ) : null}
    </SettingsSection>
  );
}

function MonitorAssistantSettingsSection() {
  const assistant = useDesktopAssistant();
  const appSettings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), appSettings),
  ).filter((entry) => entry.enabled);
  const selectedProviderId =
    pendingProviderId ?? assistant.settings?.modelSelection?.instanceId ?? "";
  const selectedProvider = entries.find((entry) => entry.instanceId === selectedProviderId);
  const modelOptions = selectedProvider
    ? (getCustomModelOptionsByInstance(appSettings, providers).get(selectedProvider.instanceId) ??
      [])
    : [];
  if (!assistant.available) return null;
  const settings = assistant.settings;
  return (
    <SettingsSection title="모니터 비서">
      {assistant.error ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {assistant.error}
        </p>
      ) : null}
      {!settings ? (
        <p className="px-4 py-2 text-sm">비서 설정을 불러오는 중…</p>
      ) : (
        <div className="flex flex-col gap-3 px-4 py-3 text-sm">
          <label className="flex items-center gap-3">
            비서 AI 연결
            <select
              aria-label="비서 AI 연결"
              value={selectedProviderId}
              onChange={(event) => setPendingProviderId(event.currentTarget.value)}
              className="rounded border border-border bg-background px-2 py-1 text-foreground"
            >
              <option value="">연결 선택</option>
              {!selectedProvider && selectedProviderId ? (
                <option value={selectedProviderId}>
                  사용할 수 없는 연결 · {selectedProviderId}
                </option>
              ) : null}
              {entries.map((entry) => (
                <option key={entry.instanceId} value={entry.instanceId}>
                  {entry.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-3">
            비서 모델
            <select
              aria-label="비서 모델"
              value={
                settings.modelSelection?.instanceId === selectedProviderId
                  ? settings.modelSelection.model
                  : ""
              }
              disabled={!selectedProvider}
              onChange={(event) => {
                if (!selectedProvider || !event.currentTarget.value) return;
                void assistant.update({
                  modelSelection: createModelSelection(
                    selectedProvider.instanceId,
                    event.currentTarget.value,
                  ),
                });
                setPendingProviderId(null);
              }}
              className="min-w-0 max-w-full rounded border border-border bg-background px-2 py-1 text-foreground"
            >
              <option value="">모델 선택</option>
              {settings.modelSelection?.instanceId === selectedProviderId &&
              !modelOptions.some((model) => model.slug === settings.modelSelection?.model) ? (
                <option value={settings.modelSelection.model}>
                  사용할 수 없는 모델 · {settings.modelSelection.model}
                </option>
              ) : null}
              {modelOptions.map((model) => (
                <option key={model.slug} value={model.slug}>
                  {model.slug}
                </option>
              ))}
            </select>
          </label>
          <p className="text-muted-foreground">비서 모델은 일반 대화의 모델과 별도로 사용합니다.</p>
          <label className="flex items-center gap-3">
            음성 전사 후 전송
            <select
              aria-label="음성 전사 후 전송"
              value={settings.voiceSendMode ?? "confirm"}
              onChange={(event) =>
                void assistant.update({
                  voiceSendMode: event.currentTarget.value as "confirm" | "auto",
                })
              }
              className="rounded border border-border bg-background px-2 py-1 text-foreground"
            >
              <option value="confirm">확인 후 전송</option>
              <option value="auto">자동 전송</option>
            </select>
          </label>
          <p className="text-muted-foreground">
            자동 전송은 음성 전사만 보내며 작성 중인 초안과 첨부는 보존합니다.
          </p>
          <AssistantVoiceSampleSettings />
          <label className="flex items-center gap-3">
            공통 캐릭터
            <select
              aria-label="모니터 비서 공통 캐릭터"
              value={settings.character}
              onChange={(event) =>
                void assistant.update({
                  character: event.currentTarget.value as typeof settings.character,
                })
              }
              className="rounded border border-border bg-background px-2 py-1 text-foreground"
            >
              <option value="off">표시 안 함</option>
              <option value="type95">1번 · 95식</option>
              <option value="k2">2번 · K2</option>
              <option value="ots14">3번 · OTs-14</option>
              <option value="agustina">2D Agustina</option>
              <option value="pixel">2D 픽셀 캐릭터</option>
              <option value="livliv">2.5D LivLiv 캐릭터</option>
              <option value="vrm">3D Polybot</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.alwaysOnTop}
              onChange={(event) =>
                void assistant.update({ alwaysOnTop: event.currentTarget.checked })
              }
            />
            항상 위에 표시
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.openAtStartup}
              onChange={(event) =>
                void assistant.update({ openAtStartup: event.currentTarget.checked })
              }
            />
            T3 시작 시 비서 열기
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.keepOnMainClose}
              onChange={(event) =>
                void assistant.update({ keepOnMainClose: event.currentTarget.checked })
              }
            />
            메인 창을 닫아도 비서 유지
          </label>
          <p className="text-muted-foreground">
            캐릭터 말투는 모니터 비서에서 보낸 요청에만 적용됩니다.
          </p>
          <div className="flex gap-2">
            <Button size="xs" onClick={() => void assistant.open()}>
              비서 열기
            </Button>
            <Button size="xs" variant="outline" onClick={() => void assistant.close()}>
              비서 닫기
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

export function GeneralSettingsPanel() {
  const teamEnvironmentId = usePrimaryEnvironmentId();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [backgroundActivityDialogOpen, setBackgroundActivityDialogOpen] = useState(false);
  const lastEnabledProjectGroupingMode = useRef<SidebarProjectGroupingMode>(
    readLastEnabledProjectGroupingMode(),
  );
  const observability = useAtomValue(primaryServerObservabilityAtom);
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const diagnosticsDescription = formatDiagnosticsDescription({
    localTracingEnabled: observability?.localTracingEnabled ?? false,
    otlpTracesEnabled: observability?.otlpTracesEnabled ?? false,
    otlpTracesUrl: observability?.otlpTracesUrl,
    otlpMetricsEnabled: observability?.otlpMetricsEnabled ?? false,
    otlpMetricsUrl: observability?.otlpMetricsUrl,
  });

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const textGenerationModelInstanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const textGenInstanceEntry = textGenerationModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const textGenerationModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeBackgroundActivityProfile = resolvedBackgroundActivity.profile;
  const backgroundActivityProfileOption = resolveBackgroundActivityProfileOption(settings);
  const backgroundActivityDescription =
    backgroundActivityProfileOption === "advanced"
      ? `${ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION} 현재 공통 정책: ${
          BACKGROUND_ACTIVITY_PROFILE_LABELS[activeBackgroundActivityProfile]
        }.`
      : BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS[resolvedBackgroundActivity.profile];
  const canResetBackgroundActivity = !Equal.equals(
    settings.backgroundActivity,
    DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  );

  return (
    <SettingsPageContainer>
      <DesktopUpdatePermissionsSection />
      <SettingsSection title="일반">
        <SettingsRow
          {...searchableSetting("background-watch-notice")}
          description="감시가 중단된 시각부터 알림을 표시합니다. 0초로 설정하면 알림을 숨기고 대화 기록은 유지합니다."
          control={
            <div className="flex items-center gap-2">
              <NumberField
                value={settings.backgroundWatchNoticeSeconds}
                min={0}
                step={1}
                size="sm"
                className="w-32"
                onValueChange={(value) => {
                  if (value !== null && Number.isInteger(value) && value >= 0)
                    updateSettings({ backgroundWatchNoticeSeconds: value });
                }}
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement aria-label="감시 중단 알림 표시 시간 줄이기" />
                  <NumberFieldInput aria-label="감시 중단 알림 표시 시간(초)" />
                  <NumberFieldIncrement aria-label="감시 중단 알림 표시 시간 늘리기" />
                </NumberFieldGroup>
              </NumberField>
              <span className="text-xs text-muted-foreground">초</span>
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("project-grouping")}
          description="여러 실행 환경에서 같은 저장소를 하나로 묶어 표시합니다."
          resetAction={
            settings.sidebarProjectGroupingMode !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode ? (
              <SettingResetButton
                label="프로젝트 그룹화"
                onClick={() =>
                  updateSettings({
                    sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={isProjectGroupingEnabled(settings.sidebarProjectGroupingMode)}
              onCheckedChange={(checked) => {
                if (!checked && settings.sidebarProjectGroupingMode !== "separate") {
                  lastEnabledProjectGroupingMode.current = settings.sidebarProjectGroupingMode;
                  rememberEnabledProjectGroupingMode(settings.sidebarProjectGroupingMode);
                }
                updateSettings({
                  sidebarProjectGroupingMode: projectGroupingModeFromToggle(
                    checked,
                    lastEnabledProjectGroupingMode.current,
                  ),
                });
              }}
              aria-label="프로젝트 그룹화"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("auto-settle-inactive-threads")}
          description="이 기간 동안 활동이 없는 사이드바 대화를 자동으로 정리합니다. 병합되거나 닫힌 PR의 대화는 항상 정리됩니다."
          resetAction={
            settings.sidebarAutoSettleAfterDays !==
            DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ? (
              <SettingResetButton
                label="비활성 대화 자동 정리"
                onClick={() =>
                  updateSettings({
                    sidebarAutoSettleAfterDays: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.sidebarAutoSettleAfterDays !== null}
              onCheckedChange={(checked) =>
                updateSettings({
                  sidebarAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                })
              }
              aria-label="비활성 대화 자동 정리"
            />
          }
        />
        {settings.sidebarAutoSettleAfterDays !== null ? (
          <SettingsRow
            title="자동 정리 전 비활성 일수"
            description="새로운 활동이 생기면 대화가 자동으로 다시 활성 상태가 됩니다."
            control={
              <AutoSettleDaysInput
                value={settings.sidebarAutoSettleAfterDays}
                onCommit={(days) => updateSettings({ sidebarAutoSettleAfterDays: days })}
              />
            }
          />
        ) : null}

        <SettingsRow
          {...searchableSetting("time-format")}
          description="시스템 기본값은 브라우저 또는 운영체제의 시간 표시 설정을 따릅니다."
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="시간 형식"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="시간 형식">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("hide-whitespace-changes")}
          description="변경 사항 비교 화면에서 공백만 바뀐 내용을 기본으로 무시할지 설정합니다."
          resetAction={
            settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
              <SettingResetButton
                label="공백 변경 숨기기"
                onClick={() =>
                  updateSettings({
                    diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffIgnoreWhitespace}
              onCheckedChange={(checked) =>
                updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
              }
              aria-label="공백 변경을 기본으로 숨기기"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("provider-update-checks")}
          description="설치된 AI 제공자 CLI의 새 버전이 있는지 확인합니다."
          resetAction={
            settings.enableProviderUpdateChecks !==
            DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
              <SettingResetButton
                label="AI 제공자 업데이트 확인"
                onClick={() =>
                  updateSettings({
                    enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableProviderUpdateChecks}
              onCheckedChange={(checked) =>
                updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
              }
              aria-label="AI 제공자 버전 확인"
            />
          }
        />

        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              백그라운드 활동
              <PolicyTooltip>
                각 작업의 설정 주기가 지난 뒤 Git 새로 고침이나 AI 제공자 상태 확인 같은 백그라운드
                작업을 실행할지 이 공통 정책이 결정합니다.
              </PolicyTooltip>
            </span>
          }
          description={backgroundActivityDescription}
          resetAction={
            canResetBackgroundActivity ? (
              <SettingResetButton
                label="백그라운드 활동"
                onClick={() => updateSettings(resetBackgroundActivitySettings())}
              />
            ) : null
          }
          control={
            <>
              <Select
                value={backgroundActivityProfileOption}
                onValueChange={(value) => {
                  if (value === "advanced") {
                    setBackgroundActivityDialogOpen(true);
                    return;
                  }
                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings(backgroundActivityProfileSettings(value));
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="백그라운드 활동 프로필">
                  <SelectValue>
                    {BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS[backgroundActivityProfileOption]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.performance}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"]}
                  </SelectItem>
                  <SelectItem hideIndicator value="advanced">
                    {BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced}
                  </SelectItem>
                </SelectPopup>
              </Select>
              {backgroundActivityProfileOption === "advanced" ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="outline"
                        aria-label="고급 백그라운드 활동 설정"
                        onClick={() => setBackgroundActivityDialogOpen(true)}
                      >
                        <SettingsIcon className="size-4" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">백그라운드 활동 설정</TooltipPopup>
                </Tooltip>
              ) : null}
              <BackgroundActivityAdvancedDialog
                open={backgroundActivityDialogOpen}
                onOpenChange={setBackgroundActivityDialogOpen}
              />
            </>
          }
        />

        <SettingsRow
          {...searchableSetting("new-threads")}
          description="새로 만드는 대화의 기본 작업 공간 방식을 선택합니다."
          resetAction={
            settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ||
            settings.newWorktreesStartFromOrigin !==
              DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
              <SettingResetButton
                label="새 대화"
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                    newWorktreesStartFromOrigin:
                      DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value === "local" || value === "worktree") {
                  updateSettings({ defaultThreadEnvMode: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="기본 대화 실행 방식">
                <SelectValue>
                  {settings.defaultThreadEnvMode === "worktree" ? "새 작업 트리" : "로컬"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="local">
                  로컬
                </SelectItem>
                <SelectItem hideIndicator value="worktree">
                  새 작업 트리
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        {settings.defaultThreadEnvMode === "worktree" ? (
          <SettingsRow
            className="bg-muted/20 sm:pl-9"
            title={searchableSetting("start-from-origin").title}
            description="로컬 브랜치 대신 원격 원본의 최신 일치 브랜치에서 작업 트리를 만듭니다."
            resetAction={
              settings.newWorktreesStartFromOrigin !==
              DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
                <SettingResetButton
                  label="새 작업 트리를 원격 원본에서 시작"
                  onClick={() =>
                    updateSettings({
                      newWorktreesStartFromOrigin:
                        DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.newWorktreesStartFromOrigin}
                onCheckedChange={(checked) =>
                  updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
                }
                aria-label="새 작업 트리를 기본으로 원격 원본에서 시작"
              />
            }
          />
        ) : null}

        <SettingsRow
          {...searchableSetting("add-project-starts-in")}
          description='비워 두면 프로젝트 추가 파일 탐색기를 열 때 "~/"에서 시작합니다.'
          resetAction={
            settings.addProjectBaseDirectory !==
            DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
              <SettingResetButton
                label="프로젝트 추가 기본 폴더"
                onClick={() =>
                  updateSettings({
                    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={settings.addProjectBaseDirectory}
              onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
              placeholder="~/"
              spellCheck={false}
              aria-label="프로젝트 추가 기본 폴더"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("archive-confirmation")}
          description="대화를 보관하기 전에 인라인 보관 버튼을 한 번 더 누르도록 합니다."
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="보관 전 확인"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="대화 보관 전 확인"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("delete-confirmation")}
          description="대화와 채팅 기록을 삭제하기 전에 확인합니다."
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="삭제 전 확인"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="대화 삭제 전 확인"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("text-generation-model")}
          description="대화 제목과 소스 제어 내용 등 텍스트 생성에 사용할 기본 모델입니다. 소스 제어 설정에서 전용 작성 모델로 별도 지정할 수 있습니다."
          resetAction={
            isTextGenerationModelDirty ? (
              <SettingResetButton
                label="텍스트 생성 모델"
                onClick={() =>
                  updateSettings({
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                activeInstanceId={textGenInstanceId}
                model={textGenModel}
                lockedProvider={null}
                instanceEntries={textGenerationModelInstanceEntries}
                modelOptionsByInstance={textGenerationModelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onInstanceModelChange={(instanceId, model) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(instanceId, model),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
              <TraitsPicker
                provider={textGenProvider}
                models={
                  // Use the exact instance's models (rather than the
                  // first-kind-match) so a custom text-gen instance like
                  // `codex_personal` gets its own model list, not the
                  // default Codex one.
                  textGenInstanceEntry?.models ?? []
                }
                model={textGenModel}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={textGenModelOptions}
                allowPromptInjectedEffort={false}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onModelOptionsChange={(nextOptions) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(
                          textGenInstanceId,
                          textGenModel,
                          nextOptions,
                        ),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
            </div>
          }
        />
      </SettingsSection>

      {teamEnvironmentId && (
        <SettingsSection id="thread-response-style" title="전역 AI · 비서 설정">
          <RoomModelSettings
            key={teamEnvironmentId}
            environmentId={teamEnvironmentId}
            showMonitorControls
          />
        </SettingsSection>
      )}
      {/* 대화별 비서·모니터 비서는 위의 전역 AI·비서 설정으로 통합되었습니다. */}

      <SearchModelsSettingsSection />
      <AiSearchSettingsSection />
      <UpgradeRoomSettingsSection />
      <SettingsSection title="정보">
        {isElectron || HOSTED_APP_CHANNEL ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="현재 설치된 애플리케이션 버전입니다."
          />
        )}
        <SettingsRow
          {...searchableSetting("diagnostics")}
          description={diagnosticsDescription}
          control={
            <Button render={<Link to="/settings/diagnostics" />} size="xs" variant="outline">
              진단 보기
            </Button>
          }
        />
      </SettingsSection>

      <LegacyFeaturesSection />
    </SettingsPageContainer>
  );
}

export function ArchivedThreadsPanel() {
  const projects = useProjects();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const environmentIds = useMemo(
    () => [...new Set(projects.map((project) => project.environmentId))],
    [projects],
  );
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(environmentIds);

  const archivedGroups = useMemo(() => {
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects.map(
          (project) =>
            [
              `${environmentId}:${project.id}`,
              {
                id: project.id,
                environmentId,
                name: project.title,
                cwd: project.workspaceRoot,
              },
            ] as const,
        ),
      ),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => ({
        ...thread,
        environmentId,
      })),
    );

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values());
    const groups: Array<{
      readonly project: (typeof archivedProjects)[number];
      readonly threads: Array<(typeof threads)[number]>;
    }> = [];
    for (const project of archivedProjects) {
      const projectThreads: Array<(typeof threads)[number]> = [];
      for (const thread of threads) {
        if (thread.projectId === project.id && thread.environmentId === project.environmentId) {
          projectThreads.push(thread);
        }
      }
      if (projectThreads.length > 0) {
        groups.push({
          project,
          threads: projectThreads.toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
        });
      }
    }
    return groups;
  }, [archivedSnapshots]);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "보관 해제" },
          { id: "delete", label: "삭제", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        const result = await unarchiveThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "대화 보관을 해제하지 못했습니다",
              description: "잠시 후 다시 시도해 주세요.",
            }),
          );
        }
        return;
      }

      if (clicked === "delete") {
        const result = await confirmAndDeleteThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "대화를 삭제하지 못했습니다",
              description: "잠시 후 다시 시도해 주세요.",
            }),
          );
        }
      }
    },
    [confirmAndDeleteThread, refreshArchivedThreads, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection
          id={isLoadingArchive ? undefined : searchableSetting("archive").id}
          title={searchableSetting("archive").title}
        >
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? "보관된 대화 불러오는 중"
                  : archiveError
                    ? "보관된 대화를 불러오지 못했습니다"
                    : "보관된 대화가 없습니다"}
              </span>
            }
            description={
              isLoadingArchive
                ? "연결된 실행 환경을 확인하고 있습니다."
                : archiveError
                  ? "연결 상태를 확인한 뒤 다시 시도해 주세요."
                  : "보관한 대화가 여기에 표시됩니다."
            }
          />
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }, index) => (
          <SettingsSection
            key={project.id}
            id={index === 0 ? searchableSetting("archive").id : undefined}
            title={project.name}
            icon={<ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />}
          >
            {projectThreads.map((thread) => (
              <SettingsRow
                key={thread.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void (async () => {
                    const result = await settlePromise(() =>
                      handleArchivedThreadContextMenu(
                        scopeThreadRef(thread.environmentId, thread.id),
                        {
                          x: event.clientX,
                          y: event.clientY,
                        },
                      ),
                    );
                    if (result._tag === "Failure") {
                      const error = squashAtomCommandFailure(result);
                      toastManager.add(
                        stackedThreadToast({
                          type: "error",
                          title: "보관된 대화 작업을 처리하지 못했습니다",
                          description: "잠시 후 다시 시도해 주세요.",
                        }),
                      );
                    }
                  })();
                }}
                title={thread.title}
                description={
                  <>
                    보관 {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                    {" \u00b7 생성 "}
                    {formatRelativeTimeLabel(thread.createdAt)}
                  </>
                }
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                    onClick={() => {
                      void (async () => {
                        const result = await unarchiveThread(
                          scopeThreadRef(thread.environmentId, thread.id),
                        );
                        if (result._tag === "Success") {
                          refreshArchivedThreads();
                          return;
                        }
                        if (!isAtomCommandInterrupted(result)) {
                          const error = squashAtomCommandFailure(result);
                          toastManager.add(
                            stackedThreadToast({
                              type: "error",
                              title: "대화 보관을 해제하지 못했습니다",
                              description: "잠시 후 다시 시도해 주세요.",
                            }),
                          );
                        }
                      })();
                    }}
                  >
                    <ArchiveX className="size-3.5" />
                    <span>보관 해제</span>
                  </Button>
                }
              />
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
