import { useAtomValue } from "@effect/atom-react";
import { McpToolsSection } from "./McpToolsSection";
import { ExtensionsSection } from "./ExtensionsSection";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Result from "effect/Result";
import {
  ChevronDownIcon,
  CloudIcon,
  LaptopIcon,
  LoaderIcon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
  TerminalIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import { formatProviderDriverKindLabel } from "../../providerModels";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { getRelativeTimeState } from "../../timestampFormat";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateActive,
  type ProviderUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Switch } from "../ui/switch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { GeminiLoginDialog } from "./GeminiLoginDialog";
import { GrokAccountDialog } from "./GrokAccountDialog";
import { MuseAccountDialog, type MuseAccountAuthTab } from "./MuseAccountDialog";
import { DeepSeekConnectionDialog } from "./DeepSeekConnectionDialog";
import { GlmConnectionDialog } from "./GlmConnectionDialog";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";
import {
  API_CONNECTION_LABEL_BY_PROVIDER_ID,
  readApiConnectionProviderId,
} from "../chat/providerIconUtils";
import { searchableSetting } from "./settingsSearch";
import {
  backgroundActivityOverrideSettings,
  buildProviderInstanceUpdatePatch,
  durationToSeconds,
  normalizeIntervalSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
} from "./SettingsPanels.logic";
import {
  PolicyTooltip,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import {
  buildProviderEnvironmentOptions,
  classifyProviderEnvironmentAccess,
  type ProviderEnvironmentAccess,
  type ProviderOperateAccess,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  resolveSelectedProviderEnvironmentId,
} from "./ProviderSettingsPanel.logic";

export type ProviderStatusFilter = "all" | "active" | "unconfigured";

export function classifyProviderRowFilterStatus(input: {
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly isDirty?: boolean | undefined;
  readonly liveStatus?: string | undefined;
  readonly liveInstalled?: boolean | undefined;
  readonly liveAuthStatus?: string | undefined;
}): "active" | "unconfigured" {
  if (!input.enabled) return "unconfigured";
  if (input.liveStatus !== undefined) {
    if (
      input.liveStatus === "ready" ||
      input.liveAuthStatus === "authenticated" ||
      (input.liveInstalled === true && input.liveStatus === "warning")
    ) {
      return "active";
    }
    return "unconfigured";
  }
  if (input.isDefault && !input.isDirty) return "unconfigured";
  return "active";
}

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
) {
  return favorites.filter((favorite) => favorite.provider !== instanceId);
}

const PROVIDER_SETTINGS = DRIVER_OPTIONS.map((definition) => ({
  provider: definition.value,
}));

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = getRelativeTimeState(lastCheckedAt);

  if (lastCheckedRelative.status === "missing") {
    return null;
  }

  if (lastCheckedRelative.status === "invalid") {
    return <span className="text-[11px] text-muted-foreground/50">확인 시각 없음</span>;
  }

  const checkedLabel = (() => {
    if (lastCheckedRelative.value === "just now") return "방금";
    const match = /^(\d+)([mhd])$/.exec(lastCheckedRelative.value);
    if (!match) return lastCheckedRelative.value;
    const unit = match[2] === "m" ? "분" : match[2] === "h" ? "시간" : "일";
    return `${match[1]}${unit} 전`;
  })();

  return (
    <span className="text-[11px] text-muted-foreground/60">
      최근 확인 <span className="font-mono tabular-nums">{checkedLabel}</span>
    </span>
  );
}

function providerConnectionStatusText(connection: EnvironmentPresentation["connection"]): string {
  switch (connection.phase) {
    case "available":
      return "연결 가능";
    case "offline":
      return "오프라인";
    case "connecting":
      return "연결 중";
    case "reconnecting":
      return "다시 연결 중";
    case "connected":
      return "연결됨";
    case "error":
      return "연결 실패";
  }
}

function providerEnvironmentIcon(environment: EnvironmentPresentation) {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return MonitorIcon;
  if (environment.entry.target._tag === "RelayConnectionTarget") return CloudIcon;
  if (environment.entry.target._tag === "SshConnectionTarget") return TerminalIcon;
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return LaptopIcon;
  return CloudIcon;
}

function providerEnvironmentDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "기본 장치";
  if (environment.relayManaged) return "T3 Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return "로컬 장치";
  return environment.displayUrl ?? "원격 장치";
}

function EnvironmentUnavailableRow({
  environment,
  access,
}: {
  readonly environment: EnvironmentPresentation;
  readonly access: Exclude<ProviderEnvironmentAccess, { kind: "editable" | "read-only" }>;
}) {
  const isLoading = access.kind === "loading";
  const title = isLoading
    ? "CLI 계정 설정 불러오는 중"
    : access.kind === "error"
      ? "이 장치에 연결할 수 없음"
      : "CLI 계정 설정을 사용할 수 없음";
  const description = isLoading
    ? access.reason === "permissions"
      ? "이 세션에서 변경할 수 있는 항목을 확인하고 있습니다."
      : `${environment.label} 설정을 기다리고 있습니다.`
    : providerConnectionStatusText(environment.connection);
  // No spinner: this state can persist indefinitely for a wedged device, and a
  // continuously repainting animation would run the whole time.
  return (
    <SettingsSection title="AI 제공자 및 CLI 계정">
      <SettingsRow title={title} description={description} />
    </SettingsSection>
  );
}

export function ProviderSettingsPanel() {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const options = useMemo(
    () => buildProviderEnvironmentOptions(environments, primaryEnvironmentId),
    [environments, primaryEnvironmentId],
  );
  // Raw user intent; the effective selection is re-derived every render so a
  // device that drops out of the catalog falls back without erasing the pick —
  // if it reappears (e.g. after a reconnect) the selection is restored.
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    primaryEnvironmentId,
  );
  const effectiveEnvironmentId = resolveSelectedProviderEnvironmentId(
    options,
    selectedEnvironmentId,
    primaryEnvironmentId,
  );
  const selectedEnvironment =
    options.find((environment) => environment.environmentId === effectiveEnvironmentId) ?? null;
  const onlyPrimaryDevice =
    options.length === 1 && options[0]?.entry.target._tag === "PrimaryConnectionTarget";

  return (
    <SettingsPageContainer>
      {!onlyPrimaryDevice ? (
        <SettingsSection title="장치">
          {options.length === 0 ? (
            // The catalog hydrates asynchronously, so an empty list before it is
            // ready means "not loaded yet", not "nothing is connected".
            <SettingsRow
              title={isReady ? "연결된 장치 없음" : "장치 불러오는 중"}
              description={
                isReady
                  ? "CLI 계정을 설정하려면 먼저 실행 환경을 연결하세요."
                  : "연결된 실행 환경을 확인하고 있습니다."
              }
            />
          ) : (
            <div className="grid gap-1 sm:grid-cols-2">
              {options.map((environment) => {
                const Icon = providerEnvironmentIcon(environment);
                const selected = environment.environmentId === effectiveEnvironmentId;
                const statusText = providerConnectionStatusText(environment.connection);
                return (
                  <button
                    key={environment.environmentId}
                    type="button"
                    aria-pressed={selected}
                    className={cn(
                      "flex min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors sm:px-4",
                      selected
                        ? "bg-primary/8 ring-1 ring-primary/25 dark:bg-primary/12"
                        : "hover:bg-muted/40",
                    )}
                    onClick={() => setSelectedEnvironmentId(environment.environmentId)}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background text-muted-foreground">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <ConnectionStatusDot
                          tooltipText={statusText}
                          dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                          pingClassName={connectionPhasePingClassName(environment.connection.phase)}
                        />
                        <span className="truncate text-sm font-medium text-foreground">
                          {environment.label}
                        </span>
                      </span>
                      <span className="block truncate pl-[18px] text-xs text-muted-foreground">
                        {providerEnvironmentDetail(environment)} · {statusText}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </SettingsSection>
      ) : null}

      {selectedEnvironment ? (
        <SelectedEnvironmentProviderSettings
          key={selectedEnvironment.environmentId}
          environment={selectedEnvironment}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function SelectedEnvironmentProviderSettings({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
  if (isPrimary) {
    // The desktop app owns its primary server outright; a browser session
    // checks the scopes its cookie session was granted.
    if (isElectron) {
      return <AccessGatedProviderSettings environment={environment} operateAccess="granted" />;
    }
    return <PrimarySessionGatedProviderSettings environment={environment} />;
  }
  return <RemoteSessionGatedProviderSettings environment={environment} />;
}

function PrimarySessionGatedProviderSettings({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const primarySessionState = usePrimarySessionState();
  const operateAccess = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: false,
    session: primarySessionState.data,
    isPending: primarySessionState.isPending,
    hasError: primarySessionState.error !== null,
  });
  return <AccessGatedProviderSettings environment={environment} operateAccess={operateAccess} />;
}

function RemoteSessionGatedProviderSettings({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const sessionState = useEnvironmentSessionState(environment.environmentId);
  const operateAccess = resolveRemoteOperateAccess({
    session: sessionState.data,
    isPending: sessionState.isPending,
    hasError: sessionState.hasError,
  });
  return <AccessGatedProviderSettings environment={environment} operateAccess={operateAccess} />;
}

function AccessGatedProviderSettings({
  environment,
  operateAccess,
}: {
  readonly environment: EnvironmentPresentation;
  readonly operateAccess: ProviderOperateAccess;
}) {
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess,
  });
  if (access.kind !== "editable" && access.kind !== "read-only") {
    return <EnvironmentUnavailableRow environment={environment} access={access} />;
  }
  return (
    <EnvironmentProviderSettings
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
      readOnly={access.kind === "read-only"}
    />
  );
}

export function EnvironmentProviderSettings({
  environmentId,
  environmentLabel,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  /**
   * Render the full provider layout, greyed out and inert, when this session's
   * credential lacks `orchestration:operate` on the environment. Showing the
   * real configuration keeps the view honest; disabling interaction keeps
   * every one of its writes from being offered and then rejected.
   */
  readonly readOnly?: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [isDeepSeekDialogOpen, setIsDeepSeekDialogOpen] = useState(false);
  const [isGlmDialogOpen, setIsGlmDialogOpen] = useState(false);
  const [geminiLoginTarget, setGeminiLoginTarget] = useState<{
    readonly instanceId: ProviderInstanceId;
    readonly displayName: string;
  } | null>(null);
  const [grokAccountDialog, setGrokAccountDialog] = useState<
    | { readonly mode: "add" }
    | {
        readonly mode: "reauth";
        readonly instanceId: ProviderInstanceId;
        readonly displayName: string;
      }
    | null
  >(null);
  const [museAccountDialog, setMuseAccountDialog] = useState<
    | { readonly mode: "add"; readonly initialTab?: MuseAccountAuthTab }
    | {
        readonly mode: "reauth";
        readonly instanceId: ProviderInstanceId;
        readonly displayName: string;
        readonly initialTab?: MuseAccountAuthTab;
      }
    | null
  >(null);
  const [updatingProviderDrivers, setUpdatingProviderDrivers] = useState<
    ReadonlySet<ProviderDriverKind>
  >(() => new Set());
  const [openInstanceDetails, setOpenInstanceDetails] = useState<Record<string, boolean>>({});
  const [statusFilter, setStatusFilter] = useState<ProviderStatusFilter>("all");
  const [groupExpandedOverrides, setGroupExpandedOverrides] = useState<Record<string, boolean>>({});
  const refreshingRef = useRef(false);
  const updatingDriversRef = useRef<Set<ProviderDriverKind>>(new Set());

  const providerUpdateCandidates = useMemo(
    () => collectProviderUpdateCandidates(serverProviders),
    [serverProviders],
  );
  const providerUpdateCandidateByInstanceId = useMemo(
    () => new Map(providerUpdateCandidates.map((candidate) => [candidate.instanceId, candidate])),
    [providerUpdateCandidates],
  );
  const visibleProviderSettings = PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider !== "cursor" ||
      serverProviders.some(
        (provider) =>
          provider.instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("cursor")),
      ),
  );
  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const providerHealthPreset = getBackgroundActivityPresetSettings(
    resolvedBackgroundActivity.profile,
  ).providerHealthRefreshInterval;
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const defaultProviderHealthRefreshIntervalSeconds = durationToSeconds(providerHealthPreset);
  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void (async () => {
      const result = await refreshServerProviders({
        environmentId,
        input: {},
      });
      refreshingRef.current = false;
      setIsRefreshingProviders(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        console.warn("Failed to refresh providers", {
          operation: "refresh-providers",
          environmentId,
          ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
        });
      }
    })();
  }, [environmentId, refreshServerProviders]);

  const runProviderUpdate = useCallback(
    async (candidate: ProviderUpdateCandidate) => {
      // Ref-based re-entry guard, mirroring refreshProviders: a state updater
      // may run after this function returns, so it cannot gate the dispatch.
      if (updatingDriversRef.current.has(candidate.driver)) {
        return;
      }
      updatingDriversRef.current.add(candidate.driver);
      setUpdatingProviderDrivers((previous) => new Set(previous).add(candidate.driver));

      const result = await updateProvider({
        environmentId,
        input: {
          provider: candidate.driver,
          instanceId: candidate.instanceId,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `${PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver} 업데이트 실패`,
            description: "CLI 업데이트 명령을 시작하지 못했습니다.",
          }),
        );
      }
      updatingDriversRef.current.delete(candidate.driver);
      setUpdatingProviderDrivers((previous) => {
        if (!previous.has(candidate.driver)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(candidate.driver);
        return next;
      });
    },
    [environmentId, updateProvider],
  );

  interface InstanceRow {
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
    readonly driver: ProviderDriverKind;
    readonly isDefault: boolean;
    readonly isDirty?: boolean;
  }

  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const defaultSlotIdsBySource = new Set<string>(
    visibleProviderSettings.map((providerSettings) =>
      String(defaultInstanceIdForDriver(providerSettings.provider)),
    ),
  );

  const rows: InstanceRow[] = [];
  const visibleDriverKinds = new Set<ProviderDriverKind>(
    visibleProviderSettings.map((providerSettings) => providerSettings.provider),
  );

  for (const providerSettings of visibleProviderSettings) {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const legacyProviders = settings.providers as Record<string, LegacyProviderSettings>;
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings
    >;
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    // A remote device may run a server version whose settings predate this
    // driver, so the legacy mirror can be absent. Without either an explicit
    // instance or a legacy blob there is nothing to render for the slot.
    const legacyConfig = legacyProviders[providerSettings.provider];
    const defaultLegacyConfig = defaultLegacyProviders[providerSettings.provider];
    const effectiveInstance: ProviderInstanceConfig | undefined =
      explicitInstance ??
      (legacyConfig !== undefined
        ? ({
            driver,
            enabled: legacyConfig.enabled,
            config: legacyConfig,
          } satisfies ProviderInstanceConfig)
        : undefined);
    // Only the default slot depends on the legacy blob; custom instances for
    // the driver must still render even when the slot has nothing to show.
    if (effectiveInstance !== undefined) {
      const isDirty =
        explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig);
      rows.push({
        instanceId: defaultInstanceId,
        instance: effectiveInstance,
        driver,
        isDefault: true,
        isDirty,
      });
    }
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance, driver: instance.driver, isDefault: false });
    }
  }
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      rows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: defaultSlotIdsBySource.has(String(id)),
      });
    }
  }

  // Split OpenCode-compatible API connections and Muse Cloud accounts into their
  // own groups so each branded gateway (Antseed, DeepSeek, Muse Cloud, …) reads
  // as its own section instead of being folded into one bucket.
  const rowGroups = new Map<string, { driver: ProviderDriverKind; rows: InstanceRow[] }>();
  for (const row of rows) {
    const connectionProviderId = readApiConnectionProviderId(row.instance.config);
    const isMuseCloudRow =
      row.driver === ProviderDriverKind.make("muse") &&
      typeof row.instance.config === "object" &&
      row.instance.config !== null &&
      "backendMode" in row.instance.config &&
      (row.instance.config as { backendMode?: unknown }).backendMode === "cloud";
    const groupKey =
      row.driver === ProviderDriverKind.make("opencode") && connectionProviderId !== undefined
        ? `opencode:${connectionProviderId}`
        : isMuseCloudRow
          ? "muse:cloud"
          : String(row.driver);
    const group = rowGroups.get(groupKey) ?? { driver: row.driver, rows: [] };
    group.rows.push(row);
    rowGroups.set(groupKey, group);
  }

  const updateProviderInstance = (
    row: InstanceRow,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: Parameters<
        typeof buildProviderInstanceUpdatePatch
      >[0]["textGenerationModelSelection"];
    },
  ) => {
    updateSettings(
      buildProviderInstanceUpdatePatch({
        settings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: options?.textGenerationModelSelection,
      }),
    );
  };

  const deleteProviderInstance = (id: ProviderInstanceId) => {
    updateSettings({
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, id),
    });
  };

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(settings.providerModelPreferences, instanceId);
    updateSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : {
              ...rest,
              [instanceId]: {
                hiddenModels,
                modelOrder,
              },
            },
    });
  };

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(
        Arr.filterMap(nextFavoriteModels, (slug) => {
          const trimmedSlug = slug.trim();
          return trimmedSlug.length > 0 ? Result.succeed(trimmedSlug) : Result.failVoid;
        }),
      ),
    ];
    updateSettings({
      favorites: [
        ...withoutProviderInstanceFavorites(settings.favorites ?? [], instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  const resetDefaultInstance = (driverKind: ProviderDriverKind) => {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
    const defaultLegacyProvider = defaultLegacyProviders[driverKind];
    if (defaultLegacyProvider === undefined) return;
    updateSettings({
      providers: {
        ...settings.providers,
        [driverKind]: defaultLegacyProvider,
      } as typeof settings.providers,
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, defaultInstanceId),
    });
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("providers")}
        headerAction={
          <div className="flex items-center gap-1.5">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            {!readOnly ? (
              <>
                <Button size="sm" variant="outline" onClick={() => setIsDeepSeekDialogOpen(true)}>
                  DeepSeek 연결
                </Button>
                <Button size="sm" variant="outline" onClick={() => setIsGlmDialogOpen(true)}>
                  GLM 연결
                </Button>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                        onClick={() => setIsAddInstanceDialogOpen(true)}
                        aria-label="CLI 계정 추가"
                      >
                        <PlusIcon className="size-3" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">CLI 계정 추가</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                        disabled={isRefreshingProviders}
                        onClick={() => void refreshProviders()}
                        aria-label="CLI 상태 새로고침"
                      >
                        {isRefreshingProviders ? (
                          <LoaderIcon className="size-3 animate-spin" />
                        ) : (
                          <RefreshCwIcon className="size-3" />
                        )}
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">CLI 상태 새로고침</TooltipPopup>
                </Tooltip>
              </>
            ) : null}
          </div>
        }
      >
        {readOnly ? (
          <SettingsRow
            title="제한된 권한"
            description={`이 세션에서는 ${environmentLabel}의 CLI 계정을 볼 수 있지만 설정을 변경할 권한은 없습니다.`}
          />
        ) : null}
        <div
          // `inert` blocks focus and interaction in one attribute, so the
          // read-only view stays byte-for-byte the editable layout without
          // threading a disabled flag through every control.
          inert={readOnly}
          aria-disabled={readOnly || undefined}
          className={readOnly ? "space-y-1 opacity-50 select-none" : "space-y-1"}
        >
          {(["codex", "claudeAgent"] as const).map((driver) => (
            <SettingsRow
              key={driver}
              {...searchableSetting(
                driver === "codex" ? "codex-auto-switch" : "claude-auto-switch",
              )}
              description={
                driver === "codex"
                  ? "주간 한도를 다 써도 크레딧이 남으면 유지합니다. 실제 429 오류가 발생하면 다른 Codex 계정으로 전환합니다."
                  : "사용 한도를 다 쓰거나 실제 429 오류가 발생하면 다른 Claude 계정으로 전환합니다. Codex 설정과 독립적으로 동작합니다."
              }
              control={
                <Switch
                  checked={settings.providerAutoSwitch?.[driver] ?? false}
                  disabled={readOnly}
                  aria-label={driver === "codex" ? "Codex 자동 전환" : "Claude 자동 전환"}
                  onCheckedChange={(checked) =>
                    updateSettings({ providerAutoSwitch: { [driver]: Boolean(checked) } })
                  }
                />
              }
            />
          ))}
          <p className="px-3 pb-2 text-xs text-muted-foreground sm:px-4">
            같은 모델을 지원하는 별도 로그인 계정만 선택합니다. 실패한 요청은 재전송하지 않으며 다음
            입력부터 새 계정을 사용합니다. 지속 Owner·Main 바인딩과 자동 작업의 고정 프로필은
            유지됩니다.
          </p>
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-1.5">
                상태 확인 주기
                <PolicyTooltip>
                  여기서 정한 주기마다 CLI 상태 확인을 시도하며, 실제 백그라운드 실행 여부는 공용
                  백그라운드 활동 정책을 따릅니다. 사용자 지정 주기는 일반 설정의 고급 항목에
                  표시됩니다.
                </PolicyTooltip>
              </span>
            }
            description="CLI 사용 가능 여부, 버전, 인증 상태와 모델 정보를 백그라운드에서 확인합니다. 수동으로만 새로고침하려면 0초로 설정하세요."
            resetAction={
              providerHealthRefreshIntervalSeconds !==
              defaultProviderHealthRefreshIntervalSeconds ? (
                <SettingResetButton
                  label="CLI 상태 확인 주기"
                  onClick={() =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          providerHealthRefreshInterval: undefined,
                        },
                      ),
                    )
                  }
                />
              ) : null
            }
            control={
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
                    <NumberFieldDecrement aria-label="CLI 상태 확인 주기 줄이기" />
                    <NumberFieldInput aria-label="CLI 상태 확인 주기(초)" />
                    <NumberFieldIncrement aria-label="CLI 상태 확인 주기 늘리기" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">초</span>
              </div>
            }
          />

          {(() => {
            const liveByInstanceId = new Map(
              serverProviders.map((candidate) => [candidate.instanceId, candidate] as const),
            );
            const classifiedEntries = [...rowGroups.entries()].map(([groupKey, group]) => {
              const rowsWithState = group.rows.map((row) => {
                const liveProvider = liveByInstanceId.get(row.instanceId);
                const filterStatus = classifyProviderRowFilterStatus({
                  enabled: row.instance.enabled ?? true,
                  isDefault: row.isDefault,
                  isDirty: row.isDirty,
                  liveStatus: liveProvider?.status,
                  liveInstalled: liveProvider?.installed,
                  liveAuthStatus: liveProvider?.auth.status,
                });
                return { row, liveProvider, filterStatus };
              });
              const activeCount = rowsWithState.filter(
                (item) => item.filterStatus === "active",
              ).length;
              const unconfiguredCount = rowsWithState.length - activeCount;
              const filteredRows =
                statusFilter === "all"
                  ? rowsWithState
                  : rowsWithState.filter((item) => item.filterStatus === statusFilter);
              return {
                groupKey,
                driver: group.driver,
                allRows: rowsWithState,
                filteredRows,
                activeCount,
                unconfiguredCount,
              };
            });
            const totalRowsCount = classifiedEntries.reduce(
              (sum, entry) => sum + entry.allRows.length,
              0,
            );
            const totalActiveCount = classifiedEntries.reduce(
              (sum, entry) => sum + entry.activeCount,
              0,
            );
            const totalUnconfiguredCount = totalRowsCount - totalActiveCount;
            const visibleEntries = classifiedEntries.filter(
              (entry) => entry.filteredRows.length > 0,
            );

            return (
              <div className="space-y-3 pt-1">
                <div
                  className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-border/50 bg-background/95 px-3 py-2 backdrop-blur-xs sm:px-4"
                  data-provider-filter-bar
                >
                  <div
                    className="flex flex-wrap items-center gap-1.5"
                    role="group"
                    aria-label="공급자 상태 필터"
                  >
                    {(
                      [
                        { id: "all", label: "전체", count: totalRowsCount },
                        { id: "active", label: "활성", count: totalActiveCount },
                        { id: "unconfigured", label: "미설정", count: totalUnconfiguredCount },
                      ] as const
                    ).map((filterItem) => (
                      <Button
                        key={filterItem.id}
                        type="button"
                        size="xs"
                        variant={statusFilter === filterItem.id ? "default" : "outline"}
                        aria-pressed={statusFilter === filterItem.id}
                        onClick={() => setStatusFilter(filterItem.id)}
                      >
                        {filterItem.label} ({filterItem.count})
                      </Button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        setGroupExpandedOverrides(
                          Object.fromEntries(
                            classifiedEntries.map((entry) => [entry.groupKey, true]),
                          ),
                        )
                      }
                    >
                      모두 펼치기
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        setGroupExpandedOverrides(
                          Object.fromEntries(
                            classifiedEntries.map((entry) => [entry.groupKey, false]),
                          ),
                        )
                      }
                    >
                      모두 접기
                    </Button>
                  </div>
                </div>

                {visibleEntries.length === 0 ? (
                  <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                    선택한 상태 필터에 해당하는 공급자가 없습니다.
                  </p>
                ) : null}

                <div className="grid items-start gap-3 xl:grid-cols-2">
                  {visibleEntries.map(
                    ({ groupKey, driver, filteredRows, activeCount, unconfiguredCount }) => {
                      const driverOption = getDriverOption(driver);
                      const connectionProviderId = groupKey.startsWith("opencode:")
                        ? groupKey.slice("opencode:".length)
                        : undefined;
                      const isMuseCloudGroup = groupKey === "muse:cloud";
                      const isMuseCodeGroup = groupKey === "muse";
                      const groupLabel =
                        connectionProviderId !== undefined
                          ? (API_CONNECTION_LABEL_BY_PROVIDER_ID[connectionProviderId] ??
                            readApiConnectionProviderId(filteredRows[0]?.row.instance.config) ??
                            connectionProviderId)
                          : isMuseCloudGroup
                            ? "Muse Cloud"
                            : isMuseCodeGroup
                              ? "Muse Code"
                              : (driverOption?.label ?? formatProviderDriverKindLabel(driver));
                      const enabledCount = filteredRows.filter(
                        ({ row }) => row.instance.enabled ?? true,
                      ).length;
                      const defaultExpanded = statusFilter !== "all" || activeCount > 0;
                      const isGroupExpanded = groupExpandedOverrides[groupKey] ?? defaultExpanded;
                      return (
                        <section
                          key={groupKey}
                          className="grid gap-3 rounded-xl border border-border/60 bg-muted/10 p-3"
                        >
                          <div className="flex w-full min-w-0 items-center justify-between gap-2">
                            <button
                              type="button"
                              aria-expanded={isGroupExpanded}
                              onClick={() =>
                                setGroupExpandedOverrides((existing) => ({
                                  ...existing,
                                  [groupKey]: !isGroupExpanded,
                                }))
                              }
                              className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h3 className="truncate text-sm font-semibold">{groupLabel}</h3>
                                  {activeCount > 0 ? (
                                    <Badge variant="success" size="sm">
                                      활성 {activeCount}
                                    </Badge>
                                  ) : (
                                    <Badge variant="outline" size="sm">
                                      미설정 {unconfiguredCount}
                                    </Badge>
                                  )}
                                  {filteredRows.length > 1 ? (
                                    <Badge variant="outline" size="sm">
                                      계정 그룹
                                    </Badge>
                                  ) : null}
                                </div>
                                <p className="text-[11px] text-muted-foreground">
                                  계정 {filteredRows.length}개
                                  {filteredRows.length > 1 ? ` · 사용 ${enabledCount}개` : ""}
                                </p>
                              </div>
                              <ChevronDownIcon
                                aria-hidden
                                className={cn(
                                  "size-4 shrink-0 text-muted-foreground transition-transform",
                                  isGroupExpanded && "rotate-180",
                                )}
                              />
                            </button>
                            {!readOnly && driver === ProviderDriverKind.make("grok") ? (
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                aria-label="Grok 계정 추가"
                                onClick={() => setGrokAccountDialog({ mode: "add" })}
                              >
                                <PlusIcon className="size-3" aria-hidden />
                                계정 추가
                              </Button>
                            ) : !readOnly && driver === ProviderDriverKind.make("muse") ? (
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                aria-label={
                                  isMuseCloudGroup ? "Muse Cloud 계정 추가" : "Muse Code 계정 추가"
                                }
                                onClick={() =>
                                  setMuseAccountDialog({
                                    mode: "add",
                                    initialTab: isMuseCloudGroup ? "cloud" : "browser",
                                  })
                                }
                              >
                                <PlusIcon className="size-3" aria-hidden />
                                계정 추가
                              </Button>
                            ) : null}
                          </div>
                          {isGroupExpanded ? (
                            <div className="grid gap-3">
                              {filteredRows.map(({ row, liveProvider }) => {
                                const updateCandidate = liveProvider
                                  ? providerUpdateCandidateByInstanceId.get(liveProvider.instanceId)
                                  : undefined;
                                const isDriverUpdateRunning =
                                  updateCandidate !== undefined &&
                                  (updatingProviderDrivers.has(updateCandidate.driver) ||
                                    serverProviders.some(
                                      (provider) =>
                                        provider.driver === updateCandidate.driver &&
                                        isProviderUpdateActive(provider),
                                    ));
                                const showInlineUpdateButton =
                                  updateCandidate !== undefined &&
                                  hasOneClickUpdateProviderCandidate(
                                    updateCandidate,
                                    serverProviders,
                                  );
                                const canRunInlineUpdate =
                                  updateCandidate !== undefined &&
                                  canOneClickUpdateProviderCandidate(
                                    updateCandidate,
                                    serverProviders,
                                  ) &&
                                  !updatingProviderDrivers.has(updateCandidate.driver);
                                const modelPreferences = settings.providerModelPreferences?.[
                                  row.instanceId
                                ] ?? {
                                  hiddenModels: [],
                                  modelOrder: [],
                                };
                                const favoriteModels = Arr.filterMap(
                                  settings.favorites ?? [],
                                  (favorite) =>
                                    favorite.provider === row.instanceId
                                      ? Result.succeed(favorite.model)
                                      : Result.failVoid,
                                );
                                const resetLabel = driverOption?.label ?? String(row.driver);
                                const headerAction =
                                  row.isDefault && row.isDirty ? (
                                    <SettingResetButton
                                      label={`${resetLabel} CLI 설정`}
                                      onClick={() => resetDefaultInstance(row.driver)}
                                    />
                                  ) : null;
                                const displayName =
                                  row.instance.displayName?.trim() ||
                                  driverOption?.label ||
                                  String(row.driver);
                                const isGrokApiKeyAccount =
                                  row.driver === ProviderDriverKind.make("grok") &&
                                  (liveProvider?.auth.type === "apiKey" ||
                                    Boolean(
                                      row.instance.environment?.some(
                                        (entry) => entry.name.trim() === "XAI_API_KEY",
                                      ),
                                    ));
                                const isMuseCloudAccount =
                                  row.driver === ProviderDriverKind.make("muse") &&
                                  typeof row.instance.config === "object" &&
                                  row.instance.config !== null &&
                                  "backendMode" in row.instance.config &&
                                  (row.instance.config as { backendMode?: unknown }).backendMode ===
                                    "cloud";
                                const isMuseApiKeyAccount =
                                  row.driver === ProviderDriverKind.make("muse") &&
                                  !isMuseCloudAccount &&
                                  (liveProvider?.auth.type === "apiKey" ||
                                    Boolean(
                                      row.instance.environment?.some(
                                        (entry) => entry.name.trim() === "META_API_KEY",
                                      ),
                                    ));
                                const authAction =
                                  row.driver === ProviderDriverKind.make("gemini") ? (
                                    <Button
                                      type="button"
                                      size="xs"
                                      variant={
                                        liveProvider?.auth.status === "authenticated"
                                          ? "ghost"
                                          : "outline"
                                      }
                                      onClick={() =>
                                        setGeminiLoginTarget({
                                          instanceId: row.instanceId,
                                          displayName,
                                        })
                                      }
                                    >
                                      {liveProvider?.auth.status === "authenticated"
                                        ? "Google 계정 변경"
                                        : liveProvider?.auth.status === "unauthenticated"
                                          ? "Google로 로그인"
                                          : "Google 계정 연결·변경"}
                                    </Button>
                                  ) : row.driver === ProviderDriverKind.make("grok") &&
                                    !isGrokApiKeyAccount ? (
                                    <Button
                                      type="button"
                                      size="xs"
                                      variant={
                                        liveProvider?.auth.status === "authenticated"
                                          ? "ghost"
                                          : "outline"
                                      }
                                      onClick={() =>
                                        setGrokAccountDialog({
                                          mode: "reauth",
                                          instanceId: row.instanceId,
                                          displayName,
                                        })
                                      }
                                    >
                                      {liveProvider?.auth.status === "authenticated"
                                        ? "Grok 계정 변경"
                                        : liveProvider?.auth.status === "unauthenticated"
                                          ? "Grok 로그인"
                                          : "Grok 로그인 · 변경"}
                                    </Button>
                                  ) : row.driver === ProviderDriverKind.make("muse") &&
                                    !isMuseApiKeyAccount ? (
                                    <Button
                                      type="button"
                                      size="xs"
                                      variant={
                                        liveProvider?.auth.status === "authenticated"
                                          ? "ghost"
                                          : "outline"
                                      }
                                      onClick={() =>
                                        setMuseAccountDialog({
                                          mode: "reauth",
                                          instanceId: row.instanceId,
                                          displayName,
                                          initialTab: isMuseCloudAccount ? "cloud" : "browser",
                                        })
                                      }
                                    >
                                      {isMuseCloudAccount
                                        ? liveProvider?.auth.status === "authenticated"
                                          ? "muse.ai 계정 변경"
                                          : liveProvider?.auth.status === "unauthenticated"
                                            ? "muse.ai (Google 로그인)"
                                            : "muse.ai (Google) · 변경"
                                        : liveProvider?.auth.status === "authenticated"
                                          ? "Muse 계정 변경"
                                          : liveProvider?.auth.status === "unauthenticated"
                                            ? "Meta · Google 로그인"
                                            : "Meta · Google 로그인 · 변경"}
                                    </Button>
                                  ) : null;
                                return (
                                  <ProviderInstanceCard
                                    key={row.instanceId}
                                    instanceId={row.instanceId}
                                    instance={row.instance}
                                    driverOption={driverOption}
                                    liveProvider={liveProvider}
                                    isExpanded={openInstanceDetails[row.instanceId] ?? false}
                                    onExpandedChange={(open) =>
                                      setOpenInstanceDetails((existing) => ({
                                        ...existing,
                                        [row.instanceId]: open,
                                      }))
                                    }
                                    onUpdate={(next) => {
                                      const wasEnabled = row.instance.enabled ?? true;
                                      const isDisabling = next.enabled === false && wasEnabled;
                                      const shouldClearTextGen =
                                        isDisabling && textGenInstanceId === row.instanceId;
                                      if (shouldClearTextGen) {
                                        updateProviderInstance(row, next, {
                                          textGenerationModelSelection:
                                            DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                                        });
                                      } else {
                                        updateProviderInstance(row, next);
                                      }
                                    }}
                                    environmentId={environmentId}
                                    onDelete={
                                      row.isDefault
                                        ? undefined
                                        : () => deleteProviderInstance(row.instanceId)
                                    }
                                    headerAction={headerAction}
                                    authAction={authAction}
                                    hiddenModels={modelPreferences.hiddenModels}
                                    favoriteModels={favoriteModels}
                                    modelOrder={modelPreferences.modelOrder}
                                    onHiddenModelsChange={(hiddenModels) =>
                                      updateProviderModelPreferences(row.instanceId, {
                                        ...modelPreferences,
                                        hiddenModels,
                                      })
                                    }
                                    onFavoriteModelsChange={(favoriteModels) =>
                                      updateProviderFavoriteModels(row.instanceId, favoriteModels)
                                    }
                                    onModelOrderChange={(modelOrder) =>
                                      updateProviderModelPreferences(row.instanceId, {
                                        ...modelPreferences,
                                        modelOrder,
                                      })
                                    }
                                    onRunUpdate={
                                      showInlineUpdateButton && updateCandidate
                                        ? () => {
                                            if (!canRunInlineUpdate) {
                                              return;
                                            }
                                            void runProviderUpdate(updateCandidate);
                                          }
                                        : undefined
                                    }
                                    isUpdating={
                                      showInlineUpdateButton ? isDriverUpdateRunning : undefined
                                    }
                                  />
                                );
                              })}
                            </div>
                          ) : null}
                        </section>
                      );
                    },
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      </SettingsSection>

      {isAddInstanceDialogOpen ? (
        <AddProviderInstanceDialog
          open
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          onOpenChange={setIsAddInstanceDialogOpen}
        />
      ) : null}
      <McpToolsSection environmentId={environmentId} readOnly={readOnly} />
      <ExtensionsSection environmentId={environmentId} readOnly={readOnly} />
      {isDeepSeekDialogOpen ? (
        <DeepSeekConnectionDialog
          open
          environmentId={environmentId}
          onOpenChange={setIsDeepSeekDialogOpen}
        />
      ) : null}
      {isGlmDialogOpen ? (
        <GlmConnectionDialog open environmentId={environmentId} onOpenChange={setIsGlmDialogOpen} />
      ) : null}
      {geminiLoginTarget ? (
        <GeminiLoginDialog
          open
          environmentId={environmentId}
          instanceId={geminiLoginTarget.instanceId}
          displayName={geminiLoginTarget.displayName}
          onAuthenticated={() => {
            const row = rows.find(
              (candidate) => candidate.instanceId === geminiLoginTarget.instanceId,
            );
            if (row && !(row.instance.enabled ?? true)) {
              updateProviderInstance(row, { ...row.instance, enabled: true });
            }
          }}
          onOpenChange={(open) => {
            if (!open) setGeminiLoginTarget(null);
          }}
        />
      ) : null}
      {grokAccountDialog ? (
        <GrokAccountDialog
          open
          environmentId={environmentId}
          mode={grokAccountDialog.mode}
          {...(grokAccountDialog.mode === "reauth"
            ? {
                instanceId: grokAccountDialog.instanceId,
                instanceDisplayName: grokAccountDialog.displayName,
              }
            : {})}
          defaultBinaryPath={settings.providers?.grok?.binaryPath}
          onAuthenticated={(result) => {
            const targetId =
              result?.instanceId ??
              (grokAccountDialog.mode === "reauth" ? grokAccountDialog.instanceId : undefined);
            if (!targetId) return;
            const row = rows.find((candidate) => candidate.instanceId === targetId);
            if (row && !(row.instance.enabled ?? true)) {
              updateProviderInstance(row, { ...row.instance, enabled: true });
            }
          }}
          onOpenChange={(open) => {
            if (!open) setGrokAccountDialog(null);
          }}
        />
      ) : null}
      {museAccountDialog ? (
        <MuseAccountDialog
          open
          environmentId={environmentId}
          mode={museAccountDialog.mode}
          {...(museAccountDialog.initialTab ? { initialTab: museAccountDialog.initialTab } : {})}
          {...(museAccountDialog.mode === "reauth"
            ? {
                instanceId: museAccountDialog.instanceId,
                instanceDisplayName: museAccountDialog.displayName,
              }
            : {})}
          defaultBinaryPath={settings.providers?.muse?.binaryPath}
          onAuthenticated={(result) => {
            const targetId =
              result?.instanceId ??
              (museAccountDialog.mode === "reauth" ? museAccountDialog.instanceId : undefined);
            if (!targetId) return;
            const row = rows.find((candidate) => candidate.instanceId === targetId);
            if (row && !(row.instance.enabled ?? true)) {
              updateProviderInstance(row, { ...row.instance, enabled: true });
            }
          }}
          onOpenChange={(open) => {
            if (!open) setMuseAccountDialog(null);
          }}
        />
      ) : null}
    </>
  );
}
