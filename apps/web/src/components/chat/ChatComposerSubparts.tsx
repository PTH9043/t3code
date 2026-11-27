import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { type TerminalContextDraft } from "../../lib/terminalContext";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerControl, ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import {
  COMPOSER_REQUEST_MODES,
  setComposerRequestMode,
  useComposerRequestMode,
  type ComposerRequestMode,
} from "../../askFirstStore";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { cn } from "~/lib/utils";
import { Separator } from "../ui/separator";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  BotIcon,
  ChevronDownIcon,
  MessageCircleQuestionIcon,
  PencilRulerIcon,
  type LucideIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react";
import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";

export type ComposerCommandMenuPosition = {
  bottom: number;
  left: number;
  maxHeight: number;
  width: number;
};

export function composerCommandMenuPositionsEqual(
  a: ComposerCommandMenuPosition,
  b: ComposerCommandMenuPosition,
): boolean {
  return (
    a.bottom === b.bottom && a.left === b.left && a.maxHeight === b.maxHeight && a.width === b.width
  );
}

export function ComposerCommandMenuLayer(props: {
  anchor: HTMLElement | null;
  children: ReactNode;
}) {
  const [position, setPosition] = useState<ComposerCommandMenuPosition | null>(null);

  useLayoutEffect(() => {
    const anchor = props.anchor;
    if (!anchor) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const rect = anchor.getBoundingClientRect();
      const next = {
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left,
        maxHeight: Math.max(96, rect.top - 24),
        width: rect.width,
      };
      setPosition((current) =>
        current && composerCommandMenuPositionsEqual(current, next) ? current : next,
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    if (observer) {
      // The composer is centered and capped at a max width, so opening a side
      // panel slides it sideways without ever resizing it. Watching the anchor
      // alone would leave the menu behind; the ancestors are what shrink, and
      // they resize on every frame of the panel animation.
      observer.observe(anchor);
      for (let element = anchor.parentElement; element; element = element.parentElement) {
        observer.observe(element);
      }
    }

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [props.anchor]);

  if (!position) return null;

  return createPortal(
    <div
      className="pointer-events-auto fixed z-[70]"
      style={{
        bottom: position.bottom,
        left: position.left,
        maxHeight: position.maxHeight,
        width: position.width,
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}

export const RAW_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const VIDEO_ONLY_MODEL_PATTERN =
  /(?:^|[-_/:.\s])(video|wan(?:[-_]?v?\d+)?|sora|veo|kling|runway|t2v|i2v|text-to-video|image-to-video)(?:$|[-_/:.\s])/i;

export function isVideoOnlyModelSlug(slug: string | null | undefined): boolean {
  if (!slug) return false;
  return VIDEO_ONLY_MODEL_PATTERN.test(slug.trim());
}

export function sanitizeProviderDisplayAlias(
  candidate: string | null | undefined,
  fallback: string | null,
): string | null {
  const trimmed = candidate?.trim() ?? "";
  if (trimmed && !RAW_UUID_PATTERN.test(trimmed)) {
    return trimmed;
  }
  const fallbackTrimmed = fallback?.trim() ?? "";
  if (fallbackTrimmed && !RAW_UUID_PATTERN.test(fallbackTrimmed)) {
    return fallbackTrimmed;
  }
  return trimmed ? `제공자 (${trimmed.slice(0, 8)})` : null;
}

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "승인 필요",
    description: "명령 실행과 파일 변경 전에 확인합니다.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "수정 자동 승인",
    description: "파일 수정은 자동 승인하고 다른 작업은 확인합니다.",
    icon: PenLineIcon,
  },
  auto: {
    label: "자동",
    description: "지원하는 제공자는 일반 작업을 자동 승인하고, 나머지는 확인합니다.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "전체 권한",
    description: "추가 확인 없이 명령 실행과 파일 수정을 허용합니다.",
    icon: LockOpenIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
export const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-slot="popover-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

export const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

export const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

export const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

export function isInsideComposerFloatingLayer(element: Element): boolean {
  return element.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

export const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  showInteractionModeToggle: boolean;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const runtimeModeOption = runtimeModeConfig[props.runtimeMode];
  const RuntimeModeIcon = runtimeModeOption.icon;
  const interactionModeTooltip =
    props.interactionMode === "plan"
      ? "계획 모드 — 클릭하면 일반 작업 모드로 돌아갑니다"
      : "기본 모드 — 클릭하면 계획 모드로 전환합니다";

  const interactionModeToggle = props.showInteractionModeToggle ? (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              className={cn(
                "shrink-0 whitespace-nowrap",
                props.interactionMode === "plan"
                  ? "bg-accent text-accent-foreground hover:bg-accent/80"
                  : "text-secondary-label hover:text-foreground",
              )}
              type="button"
              onClick={props.onToggleInteractionMode}
              aria-label={interactionModeTooltip}
            />
          }
        >
          {props.interactionMode === "plan" ? (
            <ComposerControlIcon icon={PencilRulerIcon} className="text-current opacity-100" />
          ) : (
            <ComposerControlIcon icon={BotIcon} opticalSize="large" />
          )}
          <span className="sr-only xl:not-sr-only">
            {props.interactionMode === "plan" ? "계획" : "작업"}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{interactionModeTooltip}</TooltipPopup>
      </Tooltip>
    </>
  ) : null;

  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

      <Tooltip>
        <Select
          value={props.runtimeMode}
          onValueChange={(value) => props.onRuntimeModeChange(value!)}
        >
          <TooltipTrigger
            render={
              <ComposerSelectControl className="shrink-0 font-medium" aria-label="실행 모드" />
            }
          >
            <ComposerControlIcon icon={RuntimeModeIcon} />
            <SelectValue>{runtimeModeOption.label}</SelectValue>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {runtimeModeOptions.map((mode) => {
              const option = runtimeModeConfig[mode];
              const OptionIcon = option.icon;
              return (
                <SelectItem key={mode} value={mode} hideIndicator className="min-w-64 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                        <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        {option.label}
                      </span>
                      <span className="text-muted-foreground text-xs leading-4">
                        {option.description}
                      </span>
                    </div>
                  </div>
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">{runtimeModeOption.description}</TooltipPopup>
      </Tooltip>

      {interactionModeToggle}
    </>
  );
});

export const ComposerFooterPrimaryActions = memo(function ComposerFooterPrimaryActions(props: {
  compact: boolean;
  activeContextWindow: ReturnType<typeof deriveLatestContextWindowSnapshot>;
  activeThreadProviderDisplayName: string | null;
  isPreparingWorktree: boolean;
  pendingAction: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    isResponding: boolean;
    isComplete: boolean;
  } | null;
  isRunning: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}) {
  return (
    <>
      {props.activeContextWindow ? (
        <ContextWindowMeter
          usage={props.activeContextWindow}
          providerDisplayName={props.activeThreadProviderDisplayName}
        />
      ) : null}
      {props.isPreparingWorktree ? (
        <span className="text-secondary-label text-xs">작업 트리 준비 중...</span>
      ) : null}
      <ComposerPrimaryActions
        compact={props.compact}
        pendingAction={props.pendingAction}
        isRunning={props.isRunning}
        showPlanFollowUpPrompt={props.showPlanFollowUpPrompt}
        promptHasText={props.promptHasText}
        isSendBusy={props.isSendBusy}
        sendDisabledReason={props.sendDisabledReason}
        isConnecting={props.isConnecting}
        isEnvironmentUnavailable={props.isEnvironmentUnavailable}
        isPreparingWorktree={props.isPreparingWorktree}
        hasSendableContent={props.hasSendableContent}
        preserveComposerFocusOnPointerDown={props.preserveComposerFocusOnPointerDown ?? false}
        onPreviousPendingQuestion={props.onPreviousPendingQuestion}
        onInterrupt={props.onInterrupt}
        onImplementPlanInNewThread={props.onImplementPlanInNewThread}
      />
    </>
  );
});

export const REQUEST_MODE_COMPACT_LABELS: Record<ComposerRequestMode, string> = {
  direct: "기본 실행",
  "ask-first": "질문 모드",
  conditions: "조건 확인",
};

export const RequestModeControl = memo(function RequestModeControl() {
  const mode = useComposerRequestMode();
  const activeOption =
    COMPOSER_REQUEST_MODES.find((option) => option.value === mode) ?? COMPOSER_REQUEST_MODES[0];
  const isCustomMode = mode !== "direct";
  const ModeIcon =
    mode === "ask-first"
      ? MessageCircleQuestionIcon
      : mode === "conditions"
        ? PencilRulerIcon
        : ZapIcon;
  return (
    <Menu>
      <MenuTrigger
        render={
          <ComposerControl
            className={cn(
              "shrink-0 whitespace-nowrap",
              isCustomMode
                ? "bg-accent text-accent-foreground hover:bg-accent/80"
                : "text-muted-foreground hover:text-foreground",
            )}
            type="button"
            aria-label={`요청 실행 방식: ${REQUEST_MODE_COMPACT_LABELS[mode]}`}
            title={`${REQUEST_MODE_COMPACT_LABELS[mode]} · ${activeOption.description}`}
            data-request-mode-select={mode}
          />
        }
      >
        <ComposerControlIcon icon={ModeIcon} />
        <span className="hidden sm:inline">{REQUEST_MODE_COMPACT_LABELS[mode]}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
      </MenuTrigger>
      <MenuPopup align="start">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">요청 실행 방식</div>
        <MenuRadioGroup
          value={mode}
          onValueChange={(value) => {
            if (value === "direct" || value === "ask-first" || value === "conditions") {
              setComposerRequestMode(value);
            }
          }}
        >
          {COMPOSER_REQUEST_MODES.map((option) => (
            <MenuRadioItem key={option.value} value={option.value}>
              <div className="grid gap-0.5">
                <span className="font-medium">{REQUEST_MODE_COMPACT_LABELS[option.value]}</span>
                <span className="text-[11px] text-muted-foreground">{option.description}</span>
              </div>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});

// --------------------------------------------------------------------------
// Handle exposed to ChatView
// --------------------------------------------------------------------------
