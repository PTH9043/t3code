import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
  PROVIDER_DISPLAY_NAMES,
} from "@t3tools/contracts";
import { memo, useEffect, useMemo, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import type { WorkspaceDevelopmentPanelProps } from "./WorkspaceDevelopmentPanel";
import { buttonVariants } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { ModelPickerContent } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { isClaudeApiEntry, isMuseCloudEntry } from "./modelPickerProviderGroups";
import {
  ModelEsque,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
} from "./providerIconUtils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { MeetingComposerTarget } from "../../meetingComposerStore";
import { ComposerControl, ComposerControlChevron } from "./ComposerControl";

const RAW_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveReadableAccountAlias(displayName: string | undefined, driverLabel: string): string {
  const trimmed = displayName?.trim() ?? "";
  if (!trimmed || RAW_UUID_REGEX.test(trimmed)) {
    return driverLabel || "기본 계정";
  }
  return trimmed;
}

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  /**
   * The instance currently selected in the composer. Drives the trigger
   * icon, label and the default-highlighted combobox row.
   */
  activeInstanceId: ProviderInstanceId;
  model: string;
  triggerPlaceholder?: string;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /** Instance entries rendered in the sidebar + used to resolve display name. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  terminalOpen?: boolean;
  /** Present in the chat composer, which can open the shared AI work panel. */
  meetingTarget?: MeetingComposerTarget | null;
  development?: WorkspaceDevelopmentPanelProps | null;
  developmentUnavailableReason?: string;
  open?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  triggerAriaLabel?: string;
  onOpenChange?: (open: boolean) => void;
  onOpenAiTask?: () => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;

  // Resolve the active instance entry by exact routing key. The composer
  // resolves fallbacks before rendering this component; if the selected
  // instance disappears, do not infer a replacement from its driver kind.
  const activeEntry = useMemo(() => {
    if (props.triggerPlaceholder) return null;
    return (
      props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null
    );
  }, [props.activeInstanceId, props.instanceEntries, props.triggerPlaceholder]);

  const activeInstanceId = props.activeInstanceId;
  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? [];
  // If the current slug belongs to a different instance (for example after
  // a provider switch or disable), prefer the active instance's first
  // option so the trigger icon and label stay in sync instead of showing
  // a stale foreign slug.
  const selectedModel =
    selectedInstanceOptions.find((option) => option.slug === props.model) ??
    selectedInstanceOptions[0];
  const triggerTitle =
    props.triggerPlaceholder ??
    (selectedModel ? getTriggerDisplayModelName(selectedModel) : props.model);
  const triggerLabel =
    props.triggerPlaceholder ??
    (selectedModel ? getTriggerDisplayModelLabel(selectedModel) : props.model);
  const driverLabel = activeEntry
    ? isMuseCloudEntry(activeEntry)
      ? "Muse Cloud"
      : activeEntry.driverKind === "muse"
        ? "Muse Code"
        : (PROVIDER_DISPLAY_NAMES[activeEntry.driverKind] ?? activeEntry.driverKind)
    : "";
  const readableAccountAlias = activeEntry
    ? resolveReadableAccountAlias(activeEntry.displayName, driverLabel)
    : "";
  const openAiAccount = activeEntry?.openAiAccountTag ? activeEntry : null;
  const namedAccount = activeEntry?.individualAccount ? activeEntry : openAiAccount;
  const namedAccountAlias = namedAccount
    ? resolveReadableAccountAlias(namedAccount.displayName, driverLabel)
    : "";
  const accountAndModel = namedAccount ? `${triggerLabel} · ${namedAccountAlias}` : triggerLabel;

  // Always hide instance badge and use driver label instead of displayName.
  // Multiple instances of the same driver (e.g. "claude" + "claude_personal")
  // are unified under one label (e.g. "Claude") with auto-switch handling failover.
  const showInstanceBadge = false;

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
  };

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const { documentElement, body } = document;
    const previousDocumentOverscrollBehavior = documentElement.style.overscrollBehavior;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;

    documentElement.style.overscrollBehavior = "contain";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const shouldAllowOverlayScroll = (target: EventTarget | null) => {
      return target instanceof Element && target.closest("[data-model-picker-content]");
    };
    const preventBackgroundWheel = (event: WheelEvent) => {
      if (shouldAllowOverlayScroll(event.target)) {
        return;
      }
      event.preventDefault();
    };
    const preventBackgroundTouchMove = (event: TouchEvent) => {
      if (shouldAllowOverlayScroll(event.target)) {
        return;
      }
      event.preventDefault();
    };

    document.addEventListener("wheel", preventBackgroundWheel, { capture: true, passive: false });
    document.addEventListener("touchmove", preventBackgroundTouchMove, {
      capture: true,
      passive: false,
    });

    return () => {
      document.removeEventListener("wheel", preventBackgroundWheel, { capture: true });
      document.removeEventListener("touchmove", preventBackgroundTouchMove, { capture: true });
      documentElement.style.overscrollBehavior = previousDocumentOverscrollBehavior;
      body.style.overflow = previousBodyOverflow;
      body.style.paddingRight = previousBodyPaddingRight;
    };
  }, [isMenuOpen]);

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    props.onInstanceModelChange(instanceId, model);
    setIsMenuOpen(false);
  };

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <PopoverTrigger
        render={
          <ComposerControl
            aria-label={
              openAiAccount
                ? [props.triggerAriaLabel, accountAndModel].filter(Boolean).join(" · ")
                : props.triggerAriaLabel
            }
            title={openAiAccount ? accountAndModel : undefined}
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-[140px] justify-between whitespace-nowrap",
              props.compact ? "max-w-48 shrink-0" : "max-w-56 shrink-0 sm:max-w-64",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {activeEntry ? (
            <ProviderInstanceIcon
              driverKind={activeEntry.driverKind}
              displayName={driverLabel}
              instanceId={String(activeEntry.instanceId)}
              model={selectedModel?.slug ?? props.model}
              accentColor={activeEntry.accentColor}
              showBadge={showInstanceBadge}
              className="size-4"
              iconClassName={cn("size-4", props.activeProviderIconClassName)}
              indicatorBackground="var(--input)"
              badgeClassName={cn(
                "right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3",
                "px-0.5 text-[7px]",
              )}
            />
          ) : null}
          {openAiAccount ? (
            <span className="max-w-24 shrink-0 truncate rounded bg-primary/10 px-1 text-[9px] font-semibold text-primary">
              API #{openAiAccount.openAiAccountTag}
            </span>
          ) : activeEntry && isClaudeApiEntry(activeEntry) ? (
            <span
              data-chat-claude-api="true"
              className="shrink-0 rounded bg-primary/10 px-1 text-[9px] font-semibold text-primary"
            >
              API
            </span>
          ) : activeEntry && isMuseCloudEntry(activeEntry) ? (
            <span
              data-chat-muse-cloud="true"
              className="shrink-0 rounded bg-primary/10 px-1 text-[9px] font-semibold text-primary"
            >
              Cloud
            </span>
          ) : null}
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 overflow-hidden truncate" />}>
              {activeEntry?.individualAccount
                ? `${triggerTitle} · ${readableAccountAlias}`
                : triggerTitle}
            </TooltipTrigger>
            <TooltipPopup side="top">{accountAndModel}</TooltipPopup>
          </Tooltip>
        </span>
        <span aria-hidden="true" className="flex items-center">
          <ComposerControlChevron />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="border-0 bg-transparent p-0 shadow-none before:hidden [-webkit-backdrop-filter:none]! [--viewport-inline-padding:0] [backdrop-filter:none]!"
        viewportClassName="rounded-lg !overflow-hidden p-0"
      >
        <ModelPickerContent
          key={
            typeof props.meetingTarget === "string"
              ? props.meetingTarget
              : props.meetingTarget
                ? `${props.meetingTarget.environmentId}:${props.meetingTarget.threadId}`
                : "models"
          }
          activeInstanceId={activeInstanceId}
          preferReadyAccount={Boolean(props.triggerPlaceholder)}
          model={props.model}
          lockedProvider={props.lockedProvider}
          lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
          meetingTarget={props.meetingTarget ?? null}
          development={props.development ?? null}
          {...(props.developmentUnavailableReason
            ? { developmentUnavailableReason: props.developmentUnavailableReason }
            : {})}
          instanceEntries={props.instanceEntries}
          {...(props.keybindings ? { keybindings: props.keybindings } : {})}
          modelOptionsByInstance={props.modelOptionsByInstance}
          terminalOpen={props.terminalOpen ?? false}
          onRequestClose={() => setIsMenuOpen(false)}
          {...(props.onOpenAiTask ? { onOpenAiTask: props.onOpenAiTask } : {})}
          {...(props.getModelDisabledReason
            ? { getModelDisabledReason: props.getModelDisabledReason }
            : {})}
          onInstanceModelChange={handleInstanceModelChange}
        />
      </PopoverPopup>
    </Popover>
  );
});
