"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
} from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { Button } from "../ui/button";
import { ACPRegistryIcon, GithubCopilotIcon, PiAgentIcon, type Icon } from "../Icons";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { AnimatedHeight } from "../AnimatedHeight";
import {
  ADD_PROVIDER_WIZARD_STEPS,
  resolveWizardNavigation,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";
import { ProviderEnvironmentSection } from "./ProviderEnvironmentSection";
import { OpenCodeApiSettings } from "./OpenCodeApiSettings";
import { DeepSeekConnectionDialog } from "./DeepSeekConnectionDialog";
import { GlmConnectionDialog } from "./GlmConnectionDialog";
import { AntseedConnectionDialog } from "./AntseedConnectionDialog";
import { CliAccountLoginDialog } from "./CliAccountLoginDialog";

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

/**
 * Normalize a user-provided label into a slug suffix for the instance id.
 * The full id is formed by prefixing the driver slug — e.g. label "Work" on
 * driver "codex" becomes `codex_work`. Output is trimmed to 48 chars so the
 * final composed id stays under the 64-char slug cap enforced by
 * `ProviderInstanceId` in `@t3tools/contracts`.
 */
function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function deriveInstanceId(driver: ProviderDriverKind, label: string): string {
  const slug = slugifyLabel(label);
  return slug ? `${driver}_${slug}` : "";
}

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const DEFAULT_DRIVER_OPTION = DRIVER_OPTIONS[0]!;
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};
interface ComingSoonDriverOption {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
}

const COMING_SOON_DRIVER_OPTIONS: readonly ComingSoonDriverOption[] = [
  {
    value: ProviderDriverKind.make("githubCopilot"),
    label: "Github Copilot",
    icon: GithubCopilotIcon,
  },
  {
    value: ProviderDriverKind.make("acpRegistry"),
    label: "ACP Registry",
    icon: ACPRegistryIcon,
  },
  {
    value: ProviderDriverKind.make("piAgent"),
    label: "Pi Agent",
    icon: PiAgentIcon,
  },
];

/**
 * Validate an instance id against the same slug rules the server applies in
 * `ProviderInstanceId` (see `packages/contracts/src/providerInstance.ts`).
 * Returns a user-facing error string, or `null` if valid.
 */
function validateInstanceId(id: string, existing: ReadonlySet<string>): string | null {
  if (id.length === 0) return "인스턴스 ID를 입력하세요.";
  if (id.length > 64) return "인스턴스 ID는 64자 이하여야 합니다.";
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "인스턴스 ID는 영문자로 시작하고 영문자, 숫자, '-', '_'만 사용할 수 있습니다.";
  }
  if (existing.has(id)) return `'${id}' 인스턴스가 이미 존재합니다.`;
  return null;
}

interface AddProviderInstanceDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onOpenChange: (open: boolean) => void;
}

export function AddProviderInstanceDialog({
  open,
  environmentId,
  environmentLabel,
  onOpenChange,
}: AddProviderInstanceDialogProps) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  const [wizardStep, setWizardStep] = useState(0);
  const [isDeepSeekSelected, setIsDeepSeekSelected] = useState(false);
  const [isGlmSelected, setIsGlmSelected] = useState(false);
  const [isAntseedSelected, setIsAntseedSelected] = useState(false);
  const [loginDriver, setLoginDriver] = useState<
    "codex" | "claudeAgent" | "cursor" | "grok" | "gemini" | "opencode" | null
  >(null);
  const [driver, setDriver] = useState<ProviderDriverKind>(DEFAULT_DRIVER_KIND);
  const [label, setLabel] = useState("");
  const [accentColor, setAccentColor] = useState<string>("");
  const [instanceIdOverride, setInstanceIdOverride] = useState<string | null>(null);
  // Driver-specific config drafts keyed by driver so toggling between drivers
  // during the same dialog session does not lose in-progress input.
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  const [environmentByDriver, setEnvironmentByDriver] = useState<
    Record<string, ReadonlyArray<ProviderInstanceEnvironmentVariable>>
  >({});
  // Errors are suppressed until the user has tried to submit once. After that
  // they update live so fixing the problem clears the message in place.
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);

  const existingIds = useMemo(
    () => new Set(Object.keys(settings.providerInstances ?? {})),
    [settings.providerInstances],
  );

  const driverOption = DRIVER_OPTION_BY_VALUE[driver] ?? DEFAULT_DRIVER_OPTION;
  const instanceId = instanceIdOverride ?? deriveInstanceId(driver, label);
  const driverSettingsFields = useMemo(
    () => deriveProviderSettingsFields(driverOption),
    [driverOption],
  );
  const instanceIdError = validateInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const previewLabel = label.trim() || `${driverOption.label} 계정`;
  const wizardStepSummaries = [driverOption.label, previewLabel, null] as const;

  const configDraft = configByDriver[driver] ?? EMPTY_CONFIG_DRAFT;
  const environment = environmentByDriver[driver] ?? [];
  const setEnvironment = (next: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => {
    setEnvironmentByDriver((existing) => ({ ...existing, [driver]: next }));
  };
  const setConfigDraft = (config: Record<string, unknown> | undefined) => {
    setConfigByDriver((existing) => {
      const next = { ...existing };
      if (config === undefined || Object.keys(config).length === 0) {
        delete next[driver];
      } else {
        next[driver] = config;
      }
      return next;
    });
  };

  const applyWizardNavigation = (navigation: WizardNavigation) => {
    if (navigation.kind === "blocked") {
      setHasAttemptedSubmit(true);
    }
    setWizardStep(navigation.step);
  };

  // Subscription-style CLI providers authenticate in the provider's own
  // browser login after the provider is selected, instead of separate
  // Codex/Claude shortcut buttons on the selection step.
  const isBrowserLoginUiDriver = (value: ProviderDriverKind): boolean =>
    value === "codex" ||
    value === "claudeAgent" ||
    value === "cursor" ||
    value === "grok" ||
    value === "gemini" ||
    value === "opencode";

  const navigateToStep = (requestedStep: number) => {
    applyWizardNavigation(
      resolveWizardNavigation(wizardStep, requestedStep, ADD_PROVIDER_WIZARD_STEPS.length, {
        instanceIdError,
      }),
    );
  };

  const handleSave = () => {
    setHasAttemptedSubmit(true);
    if (instanceIdError !== null) return;

    const config = configByDriver[driver] ?? {};
    const hasConfig = Object.keys(config).length > 0;
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);

    const nextInstance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      ...(label.trim().length > 0 ? { displayName: label.trim() } : {}),
      ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      ...(environment.length > 0 ? { environment } : {}),
      ...(hasConfig ? { config } : {}),
    };
    // `ProviderInstanceId.make` revalidates the slug; we've already checked
    // it via `validateInstanceId`, but going through the brand constructor
    // keeps the type boundary honest and guards against any future drift in
    // the slug rules.
    const brandedId = ProviderInstanceId.make(instanceId);
    const nextMap = {
      ...settings.providerInstances,
      [brandedId]: nextInstance,
    };
    try {
      updateSettings({ providerInstances: nextMap });
      toastManager.add({
        type: "success",
        title: "CLI 계정을 추가했습니다",
        description: `${driverOption.label} 계정 '${instanceId}'을(를) 추가했습니다.`,
      });
      onOpenChange(false);
    } catch {
      toastManager.add({
        type: "error",
        title: "CLI 계정을 추가하지 못했습니다",
        description: "설정을 저장하는 중 오류가 발생했습니다.",
      });
    }
  };

  if (isDeepSeekSelected)
    return (
      <DeepSeekConnectionDialog
        open={open}
        environmentId={environmentId}
        onOpenChange={onOpenChange}
        onBack={() => setIsDeepSeekSelected(false)}
      />
    );

  if (isGlmSelected)
    return (
      <GlmConnectionDialog
        open={open}
        environmentId={environmentId}
        onOpenChange={onOpenChange}
        onBack={() => setIsGlmSelected(false)}
      />
    );

  if (isAntseedSelected)
    return (
      <AntseedConnectionDialog
        open={open}
        environmentId={environmentId}
        onOpenChange={onOpenChange}
        onBack={() => setIsAntseedSelected(false)}
      />
    );

  if (loginDriver !== null)
    return (
      <CliAccountLoginDialog
        open={open}
        environmentId={environmentId}
        driver={loginDriver}
        onOpenChange={onOpenChange}
        onBack={() => setLoginDriver(null)}
      />
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>CLI 계정 추가</DialogTitle>
            <DialogDescription>
              {environmentLabel}에 추가 CLI 계정을 등록합니다. 개인용·업무용처럼 같은 제공자의
              계정을 여러 개로 분리할 수 있습니다.
            </DialogDescription>
            <AddProviderInstanceWizardSteps
              currentStep={wizardStep}
              summaries={wizardStepSummaries}
              instanceIdError={instanceIdError}
              onNavigation={applyWizardNavigation}
            />
          </DialogHeader>

          <div
            data-slot="dialog-panel"
            className="space-y-4 bg-zinc-25/80 px-6 py-5 ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5"
          >
            <AnimatedHeight>
              <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
                <div id="add-instance-driver-label" className="text-sm font-medium text-foreground">
                  CLI 제공자
                </div>
                <RadioGroup
                  value={driver}
                  onValueChange={(value) => setDriver(ProviderDriverKind.make(value))}
                  aria-labelledby="add-instance-driver-label"
                  className="grid grid-cols-1 gap-2 sm:grid-cols-2"
                >
                  {DRIVER_OPTIONS.map((option) => {
                    const IconComponent = option.icon;
                    return (
                      <RadioPrimitive.Root
                        key={option.value}
                        value={option.value}
                        className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
                      >
                        <IconComponent className="size-4 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {option.label}
                        </span>
                        <RadioPrimitive.Indicator
                          className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
                          aria-hidden
                        >
                          <CheckIcon className="size-3.5 shrink-0" />
                        </RadioPrimitive.Indicator>
                        {option.badgeLabel ? (
                          <Badge variant="warning" size="sm">
                            {option.badgeLabel}
                          </Badge>
                        ) : null}
                      </RadioPrimitive.Root>
                    );
                  })}
                  {COMING_SOON_DRIVER_OPTIONS.map((option) => {
                    const IconComponent = option.icon;
                    return (
                      <RadioPrimitive.Root
                        key={option.value}
                        value={option.value}
                        disabled
                        className={cn(
                          "relative flex cursor-not-allowed items-center gap-3 rounded-lg bg-card/60 px-3 py-3 text-left opacity-55 outline-none ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5",
                        )}
                      >
                        <IconComponent
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {option.label}
                        </span>
                        <Badge variant="warning" size="sm">
                          준비 중
                        </Badge>
                      </RadioPrimitive.Root>
                    );
                  })}
                </RadioGroup>
                <Button variant="outline" onClick={() => setIsDeepSeekSelected(true)}>
                  DeepSeek API 계정 연결
                </Button>
                <Button variant="outline" onClick={() => setIsGlmSelected(true)}>
                  GLM API 계정 연결
                </Button>
                <Button variant="outline" onClick={() => setIsAntseedSelected(true)}>
                  Antseed 게이트웨이 연결
                </Button>
              </div>

              <label className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
                <span className="text-xs font-medium text-foreground">표시 이름</span>
                <Input
                  className="bg-background"
                  placeholder="예: 업무용"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
                <span className="text-[11px] text-muted-foreground">
                  계정 목록에 표시할 이름입니다. 입력하지 않아도 됩니다.
                </span>
              </label>

              <label className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
                <span className="text-xs font-medium text-foreground">인스턴스 ID</span>
                <Input
                  className="bg-background"
                  placeholder={`${driver}_work`}
                  value={instanceId}
                  onChange={(event) => {
                    setInstanceIdOverride(event.target.value);
                  }}
                  aria-invalid={showInstanceIdError}
                />
                {showInstanceIdError ? (
                  <span className="text-[11px] text-destructive">{instanceIdError}</span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">
                    대화와 세션을 계정에 연결하는 식별자입니다. 영문자, 숫자, '-', '_'를 사용할 수
                    있습니다.
                  </span>
                )}
              </label>

              <div className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
                <span className="text-xs font-medium text-foreground">구분 색상</span>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <input
                    type="color"
                    value={normalizeProviderAccentColor(accentColor) ?? PROVIDER_ACCENT_SWATCHES[0]}
                    onChange={(event) => setAccentColor(event.target.value)}
                    aria-label="CLI 계정 구분 색상"
                    className="h-8 w-10 cursor-pointer rounded-xl border border-input bg-background p-0.5"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
                      const selected = accentColor.toLowerCase() === swatch;
                      return (
                        <button
                          key={swatch}
                          type="button"
                          className={cn(
                            "size-6 cursor-pointer rounded-full border transition",
                            selected
                              ? "scale-110 border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                              : "border-black/10 hover:scale-105 dark:border-white/20",
                          )}
                          style={{ backgroundColor: swatch }}
                          onClick={() => setAccentColor(swatch)}
                          aria-label={`${swatch} 구분 색상 사용`}
                        />
                      );
                    })}
                  </div>
                  {accentColor ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      onClick={() => setAccentColor("")}
                    >
                      지우기
                    </Button>
                  ) : null}
                </div>
                <span className="text-[11px] text-muted-foreground">
                  계정 선택 목록에서 계정을 빠르게 구분하는 색상입니다.
                </span>
              </div>

              <div className={cn("grid gap-5", wizardStep !== 2 && "hidden")}>
                {driver === "opencode" ? (
                  <OpenCodeApiSettings
                    instance={{ driver, config: configDraft, environment }}
                    onUpdate={(next) => {
                      setConfigDraft(next.config as Record<string, unknown>);
                      setEnvironment(next.environment ?? []);
                    }}
                  />
                ) : null}
                {driverSettingsFields.length > 0 ? (
                  <ProviderSettingsForm
                    definition={driverOption}
                    value={configDraft}
                    idPrefix={`add-provider-${driver}`}
                    variant="dialog"
                    onChange={setConfigDraft}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    이 CLI 제공자는 필수 설정이 없습니다. 바로 계정을 추가할 수 있습니다.
                  </p>
                )}
                <div className="border-t border-border/60 pt-4">
                  <ProviderEnvironmentSection environment={environment} onChange={setEnvironment} />
                </div>
              </div>
            </AnimatedHeight>
          </div>

          <DialogFooter variant="bare">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (wizardStep === 0) {
                  onOpenChange(false);
                  return;
                }
                setWizardStep((step) => Math.max(0, step - 1));
              }}
            >
              {wizardStep === 0 ? "취소" : "이전"}
            </Button>
            {wizardStep < ADD_PROVIDER_WIZARD_STEPS.length - 1 ? (
              <Button
                size="sm"
                onClick={() => {
                  if (wizardStep === 0 && isBrowserLoginUiDriver(driver)) {
                    setLoginDriver(
                      driver as "codex" | "claudeAgent" | "cursor" | "grok" | "gemini" | "opencode",
                    );
                    return;
                  }
                  navigateToStep(wizardStep + 1);
                }}
              >
                다음
              </Button>
            ) : (
              <Button size="sm" onClick={handleSave}>
                계정 추가
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
