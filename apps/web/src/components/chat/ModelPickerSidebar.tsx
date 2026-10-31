import { type ProviderInstanceId } from "@t3tools/contracts";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SparklesIcon, StarIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";

/**
 * Build the hover tooltip for an instance button. Mirrors the old
 * kind-based copy but uses the entry's configured `displayName` so custom
 * instances get their user-authored name (e.g. "Codex Personal — Unavailable.").
 */
function describeUnavailableInstance(entry: ProviderInstanceEntry): string {
  const label = entry.displayName;
  if (!entry.enabled || entry.status === "disabled") {
    return `${label} — 설정에서 비활성화됨.`;
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return label;
  }
  const kind =
    entry.status === "error"
      ? "사용할 수 없음"
      : entry.status === "warning"
        ? "제한됨"
        : "준비되지 않음";
  return `${label} — ${kind}.`;
}

const SELECTED_INDICATOR_CLASS =
  "pointer-events-none absolute -right-1 top-1/2 z-10 h-5 w-0.75 -translate-y-1/2 rounded-l-full bg-primary";
const BADGE_BASE_CLASS =
  "pointer-events-none absolute -right-0.5 top-0.5 z-10 flex size-3.5 items-center justify-center rounded-full bg-transparent shadow-sm ";
const NEW_BADGE_CLASS = `${BADGE_BASE_CLASS} text-update `;

/** Opens toward the rail so the list stays readable (not over the model names). */
const PICKER_TOOLTIP_SIDE = "left" as const;
const PICKER_TOOLTIP_SIDE_OFFSET = 8;
const PICKER_TOOLTIP_CLASS = "max-w-64 text-balance font-normal leading-snug";

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ProviderInstanceId | "favorites";
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  /**
   * Instance entries grouped by driver. Each driver gets one rail button;
   * clicking it selects an actual `ProviderInstanceId`, preserving account-level
   * model lists and dispatch identity.
   */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** Render the favorites rail entry. Hidden for locked-provider instance switching. */
  showFavorites?: boolean;
  /** Instance ids shown in the rail but unavailable for the current picker context. */
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
  /**
   * Instance id values that should render the "new" sparkle badge. Callers
   * pass the subset of default built-in ids they want flagged (custom
   * instances are never flagged — the user just made them).
   */
  newBadgeInstanceIds?: ReadonlySet<ProviderInstanceId>;
}) {
  const handleSelect = (instanceId: ProviderInstanceId | "favorites") => {
    props.onSelectInstance(instanceId);
  };
  const showFavorites = props.showFavorites ?? true;
  const [hoveredInstanceId, setHoveredInstanceId] = useState<ProviderInstanceId | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const [selectedIndicatorTop, setSelectedIndicatorTop] = useState<number | null>(null);
  const selectedDriverKind = useMemo(() => {
    if (props.selectedInstanceId === "favorites") return null;
    return (
      props.instanceEntries.find((entry) => entry.instanceId === props.selectedInstanceId)
        ?.driverKind ?? null
    );
  }, [props.instanceEntries, props.selectedInstanceId]);
  const driverGroups = useMemo(() => {
    const groups = new Map<string, ProviderInstanceEntry[]>();
    for (const entry of props.instanceEntries) {
      const list = groups.get(entry.driverKind) ?? [];
      list.push(entry);
      groups.set(entry.driverKind, list);
    }
    return [...groups.entries()].map(([driverKind, entries]) => {
      const visibleEntries = entries;
      const selectedEntry = entries.find((entry) => entry.instanceId === props.selectedInstanceId);
      const representative =
        selectedEntry ??
        entries.find((entry) => isProviderInstancePickerReady(entry) && entry.isDefault) ??
        entries.find((entry) => isProviderInstancePickerReady(entry)) ??
        entries.find((entry) => entry.isDefault) ??
        entries[0];
      const allContextDisabled = entries.every(
        (entry) => props.disabledInstanceIds?.has(entry.instanceId) ?? false,
      );
      const readyCount = entries.filter(isProviderInstancePickerReady).length;
      return {
        driverKind,
        entries: visibleEntries,
        representative,
        allContextDisabled,
        readyCount,
      };
    });
  }, [props.instanceEntries, props.disabledInstanceIds, props.selectedInstanceId]);

  useLayoutEffect(() => {
    const content = sidebarContentRef.current;
    if (!content) {
      return;
    }
    const selectedItem = Array.from(
      content.querySelectorAll<HTMLElement>("[data-model-picker-provider]"),
    ).find(
      (item) =>
        item.dataset.modelPickerProvider ===
        (props.selectedInstanceId === "favorites" ? "favorites" : selectedDriverKind),
    );
    if (!selectedItem) {
      setSelectedIndicatorTop(null);
      return;
    }
    setSelectedIndicatorTop(selectedItem.offsetTop + selectedItem.offsetHeight / 2 - 10);
  }, [props.instanceEntries, props.selectedInstanceId, selectedDriverKind, showFavorites]);

  return (
    <div className="w-11 shrink-0 overflow-hidden bg-muted/30" data-model-picker-sidebar="true">
      <div className="h-full overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div ref={sidebarContentRef} className="relative flex min-h-full flex-col gap-1 p-1">
          {selectedIndicatorTop !== null ? (
            <div
              data-model-picker-selected-indicator="true"
              className={cn(
                SELECTED_INDICATOR_CLASS,
                "right-0 translate-y-0 transition-[top] duration-200 ease-out",
              )}
              style={{ top: selectedIndicatorTop }}
            />
          ) : null}
          {/* Favorites section */}
          {showFavorites ? (
            <>
              <div className="relative w-full" data-model-picker-provider="favorites">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        className={cn(
                          "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))] focus-visible:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))] focus-visible:outline-none",
                        )}
                        onClick={() => handleSelect("favorites")}
                        type="button"
                        aria-label="즐겨찾기"
                      >
                        <StarIcon className="size-5 fill-current shrink-0" aria-hidden />
                      </button>
                    }
                  />
                  <TooltipPopup
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                    className={PICKER_TOOLTIP_CLASS}
                  >
                    즐겨찾기
                  </TooltipPopup>
                </Tooltip>
              </div>
              <div className="border-b border-border/70" aria-hidden="true" />
            </>
          ) : null}

          {/* Driver rail groups. Clicking a group still selects an exact account. */}
          {driverGroups.map((group) => {
            const entry = group.representative;
            if (!entry) return null;
            const groupUnavailable = group.readyCount === 0;
            const isDisabled = groupUnavailable || group.allContextDisabled;
            const isSelected = selectedDriverKind === group.driverKind;
            const isHovered = hoveredInstanceId === entry.instanceId;
            const showNewBadge = group.entries.some(
              (candidate) => props.newBadgeInstanceIds?.has(candidate.instanceId) ?? false,
            );
            const showInstanceBadge = Boolean(entry.accentColor);
            const statusLines = group.entries.map((candidate) => {
              const contextDisabled = props.disabledInstanceIds?.has(candidate.instanceId) ?? false;
              const label = contextDisabled
                ? (props.getDisabledInstanceTooltip?.(candidate) ??
                  `${candidate.displayName}은(는) 이 대화에서 사용할 수 없습니다.`)
                : describeUnavailableInstance(candidate);
              return label;
            });
            const tooltip =
              group.entries.length === 1
                ? statusLines[0]
                : `${entry.displayName}\n${statusLines.join("\n")}`;

            const button = (
              <button
                className={cn(
                  "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))] focus-visible:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))] focus-visible:outline-none",
                  isDisabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
                )}
                data-provider-accent-color={entry.accentColor}
                onClick={() => !isDisabled && handleSelect(entry.instanceId)}
                onMouseEnter={() => setHoveredInstanceId(entry.instanceId)}
                onMouseLeave={() =>
                  setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
                }
                onFocus={() => setHoveredInstanceId(entry.instanceId)}
                onBlur={() =>
                  setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
                }
                disabled={isDisabled}
                type="button"
                aria-label={isDisabled ? tooltip : entry.displayName}
              >
                <ProviderInstanceIcon
                  driverKind={entry.driverKind}
                  displayName={entry.displayName}
                  accentColor={entry.accentColor}
                  showBadge={showInstanceBadge}
                  className="size-6"
                  iconClassName="size-5"
                  indicatorBackground={
                    isHovered && !isDisabled
                      ? "var(--muted)"
                      : isSelected
                        ? "var(--background)"
                        : "color-mix(in oklab, var(--muted) 30%, transparent)"
                  }
                  {...(entry.accentColor
                    ? { badgeClassName: "h-3 min-w-3 px-0.5 text-[7px]" }
                    : {})}
                />
                {showNewBadge ? (
                  <span className={NEW_BADGE_CLASS} aria-hidden>
                    <SparklesIcon className="size-2" />
                  </span>
                ) : null}
              </button>
            );

            const trigger = isDisabled ? (
              <span className="relative block w-full">{button}</span>
            ) : (
              button
            );

            return (
              <div
                key={group.driverKind}
                className="relative w-full"
                data-model-picker-provider={group.driverKind}
              >
                <Tooltip>
                  <TooltipTrigger render={trigger} />
                  <TooltipPopup
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                    className={PICKER_TOOLTIP_CLASS}
                  >
                    <div className="grid gap-1">
                      <div className="font-medium">{entry.displayName}</div>
                    </div>
                  </TooltipPopup>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
