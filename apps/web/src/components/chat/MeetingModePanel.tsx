import type { ProviderInstanceId, WorkspaceMeetingMode } from "@t3tools/contracts";
import { memo, useEffect } from "react";
import { CrownIcon } from "lucide-react";

import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import type { ModelEsque } from "./providerIconUtils";
import { cn } from "~/lib/utils";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import {
  MAX_MEETING_SEATS,
  meetingSeatId,
  setMeetingComposerSeatModel,
  setMeetingComposerSeatOption,
  toggleMeetingComposerSeat,
  updateMeetingComposerConfig,
  useMeetingComposerConfig,
} from "../../meetingComposerStore";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";
import { getProviderModelCapabilities } from "../../providerModels";

const MODE_LABELS: ReadonlyArray<{ mode: WorkspaceMeetingMode; label: string; hint: string }> = [
  { mode: "fixed-rounds", label: "고정 라운드", hint: "정해진 횟수만큼 토론 후 계획" },
  { mode: "until-consensus", label: "합의까지", hint: "의장이 합의를 확인하면 조기 종료" },
  { mode: "free-form", label: "자유 토론", hint: "의장이 다음 발언자를 지목" },
];

const SELECT_CLASS =
  "h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

function defaultSeatModel(options: ReadonlyArray<ModelEsque> | undefined): string | null {
  if (!options || options.length === 0) return null;
  return (options.find((option) => !option.isLegacy) ?? options[0]!).slug;
}

/**
 * The meeting side of the model picker: tick the accounts that take a seat,
 * then set how the discussion runs. The topic itself is typed in the composer
 * and sent like any other message.
 */
export const MeetingModePanel = memo(function MeetingModePanel(props: {
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
}) {
  const config = useMeetingComposerConfig();
  const seatById = new Map(config.seats.map((seat) => [seat.id, seat] as const));
  const visibleEntries = props.instanceEntries.filter(isProviderInstancePickerVisible);
  // 협업 skips discussion: the chair plans straight away and the seats split
  // the work. The style is its own field, so picking it never touches the
  // meeting side's rounds or mode.
  const isDirectCollaboration = config.style === "collaboration";

  // Self-heal selections a past bug stored as display LABELS ("Extra High")
  // instead of choice ids ("xhigh"): remap by label once, idempotently.
  useEffect(() => {
    for (const entry of visibleEntries) {
      const seatId = meetingSeatId(entry.instanceId);
      const seat = seatById.get(seatId);
      if (!seat?.options?.length) continue;
      const descriptors = getProviderOptionDescriptors({
        caps: getProviderModelCapabilities(entry.models, seat.model, entry.driverKind),
      });
      for (const stored of seat.options) {
        if (typeof stored.value !== "string") continue;
        const descriptor = descriptors.find(
          (candidate) => candidate.id === stored.id && candidate.type === "select",
        );
        if (!descriptor || descriptor.type !== "select") continue;
        if (descriptor.options.some((choice) => choice.id === stored.value)) continue;
        const byLabel = descriptor.options.find((choice) => choice.label === stored.value);
        if (byLabel) {
          setMeetingComposerSeatOption(seatId, stored.id, byLabel.id);
        }
      }
    }
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-3 py-2.5 text-sm">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        작업 방식
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-1">
        <button
          type="button"
          onClick={() =>
            updateMeetingComposerConfig((current) =>
              current.style === "meeting" ? current : { ...current, style: "meeting" },
            )
          }
          className={cn(
            "rounded-md border px-2 py-1.5 text-left text-xs",
            !isDirectCollaboration
              ? "border-primary/50 bg-primary/8 font-medium"
              : "border-transparent hover:bg-muted/50",
          )}
        >
          <span className="block">회의</span>
          <span className="block font-normal text-muted-foreground">토론으로 합의 후 실행</span>
        </button>
        <button
          type="button"
          onClick={() =>
            updateMeetingComposerConfig((current) =>
              current.style === "collaboration" ? current : { ...current, style: "collaboration" },
            )
          }
          className={cn(
            "rounded-md border px-2 py-1.5 text-left text-xs",
            isDirectCollaboration
              ? "border-primary/50 bg-primary/8 font-medium"
              : "border-transparent hover:bg-muted/50",
          )}
        >
          <span className="block">협업</span>
          <span className="block font-normal text-muted-foreground">토론 없이 바로 분담 실행</span>
        </button>
      </div>

      <div className="mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        참가자 {config.seats.length > 0 ? `· ${config.seats.length}명` : ""}{" "}
        <span className="font-normal normal-case">(2–{MAX_MEETING_SEATS}명)</span>
      </div>
      <div className="mt-1.5 grid gap-1">
        {visibleEntries.map((entry) => {
          const ready = isProviderInstancePickerReady(entry);
          const seatId = meetingSeatId(entry.instanceId);
          const seat = seatById.get(seatId);
          const options = props.modelOptionsByInstance.get(entry.instanceId);
          const checked = seat !== undefined;
          return (
            <div
              key={entry.instanceId}
              className={cn(
                "flex flex-wrap items-center gap-2 rounded-md px-1.5 py-1",
                ready ? "hover:bg-muted/50" : "opacity-45",
              )}
            >
              <Checkbox
                checked={checked}
                disabled={!ready}
                aria-label={`${entry.displayName} 참가`}
                onCheckedChange={() => {
                  const model = seat?.model ?? defaultSeatModel(options);
                  if (model === null) return;
                  toggleMeetingComposerSeat({
                    id: seatId,
                    instanceId: entry.instanceId,
                    model,
                    displayName: entry.displayName,
                  });
                }}
              />
              <ProviderInstanceIcon
                driverKind={entry.driverKind}
                displayName={entry.displayName}
                accentColor={entry.accentColor}
                showBadge={Boolean(entry.accentColor)}
                className="size-4 shrink-0"
                iconClassName="size-4"
              />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {entry.displayName}
                {!ready ? (
                  <span className="ml-1 font-normal text-muted-foreground">(사용 불가)</span>
                ) : null}
              </span>
              {seat !== undefined && options && options.length > 0 ? (
                <select
                  className={cn(SELECT_CLASS, "max-w-36 shrink-0")}
                  value={seat.model}
                  aria-label={`${entry.displayName} 모델`}
                  onChange={(event) =>
                    setMeetingComposerSeatModel(seatId, event.currentTarget.value)
                  }
                >
                  {options.map((option) => (
                    <option key={option.slug} value={option.slug}>
                      {option.shortName ?? option.name}
                    </option>
                  ))}
                </select>
              ) : null}
              {seat !== undefined
                ? // The same option descriptors the composer's effort picker
                  // reads — so each seat's turns run at the effort chosen
                  // here, not whatever the composer happens to be set to.
                  getProviderOptionDescriptors({
                    caps: getProviderModelCapabilities(entry.models, seat.model, entry.driverKind),
                    selections: seat.options ?? null,
                  })
                    .filter((descriptor) => descriptor.type === "select")
                    .map((descriptor) => {
                      // A choice's VALUE is its id ("high"); the label is
                      // display only. The descriptor already folded the
                      // seat's stored selection into currentValue.
                      const currentValue = getProviderOptionCurrentValue(descriptor);
                      const shownValue =
                        typeof currentValue === "string" &&
                        descriptor.options.some((choice) => choice.id === currentValue)
                          ? currentValue
                          : (descriptor.options.find((choice) => choice.isDefault)?.id ??
                            descriptor.options[0]?.id ??
                            "");
                      return (
                        <select
                          key={descriptor.id}
                          className={cn(SELECT_CLASS, "max-w-28 shrink-0")}
                          value={shownValue}
                          aria-label={`${entry.displayName} ${descriptor.label}`}
                          title={descriptor.label}
                          onChange={(event) =>
                            setMeetingComposerSeatOption(
                              seatId,
                              descriptor.id,
                              event.currentTarget.value,
                            )
                          }
                        >
                          {descriptor.options.map((choice) => (
                            <option key={choice.id} value={choice.id}>
                              {choice.label}
                            </option>
                          ))}
                        </select>
                      );
                    })
                : null}
            </div>
          );
        })}
        {visibleEntries.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/70 px-2 py-3 text-center text-xs text-muted-foreground">
            사용할 수 있는 제공자 계정이 없습니다.
          </p>
        ) : null}
      </div>

      {!isDirectCollaboration ? (
        <>
          <div className="mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            진행 방식
          </div>
          <div className="mt-1.5 grid gap-1">
            {MODE_LABELS.map(({ mode, label, hint }) => (
              <button
                key={mode}
                type="button"
                onClick={() => updateMeetingComposerConfig((current) => ({ ...current, mode }))}
                className={cn(
                  "flex items-baseline gap-2 rounded-md border px-2 py-1.5 text-left text-xs",
                  config.mode === mode
                    ? "border-primary/50 bg-primary/8 font-medium"
                    : "border-transparent hover:bg-muted/50",
                )}
              >
                <span className="shrink-0">{label}</span>
                <span className="min-w-0 truncate font-normal text-muted-foreground">{hint}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className="mt-3 grid gap-2">
        {!isDirectCollaboration ? (
          <>
            <label className="flex items-center justify-between gap-2 text-xs font-medium">
              최대 라운드
              <input
                type="number"
                min={1}
                max={10}
                value={config.maxRounds}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.currentTarget.value, 10);
                  if (!Number.isInteger(parsed)) return;
                  const maxRounds = Math.min(10, Math.max(1, parsed));
                  updateMeetingComposerConfig((current) => ({ ...current, maxRounds }));
                }}
                className={cn(SELECT_CLASS, "w-16 text-center")}
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-xs font-medium">
              <span>
                라운드마다 확인
                <span className="ml-1 font-normal text-muted-foreground">
                  각 라운드 후 진행 여부를 물어봄
                </span>
              </span>
              <Switch
                checked={config.userInLoop}
                onCheckedChange={(userInLoop) =>
                  updateMeetingComposerConfig((current) => ({ ...current, userInLoop }))
                }
              />
            </label>
          </>
        ) : null}
        <label className="flex items-center justify-between gap-2 text-xs font-medium">
          <span className="flex items-center gap-1">
            <CrownIcon className="size-3.5 text-muted-foreground" />
            의장
          </span>
          <select
            className={cn(SELECT_CLASS, "max-w-40")}
            value={config.chairSeatId ?? ""}
            onChange={(event) => {
              const chairSeatId = event.currentTarget.value || null;
              updateMeetingComposerConfig((current) => ({
                ...current,
                chairSeatId,
              }));
            }}
          >
            <option value="">자동 (첫 참가자)</option>
            {config.seats.map((seat) => (
              <option key={seat.id} value={seat.id}>
                {seat.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="mt-3 border-t border-border/60 pt-2 text-[11px] leading-relaxed text-muted-foreground">
        {config.seats.length < 2
          ? "참가자를 2명 이상 선택하세요."
          : isDirectCollaboration
            ? "입력창에 작업을 쓰고 보내면 의장이 곧장 계획을 세우고 참가자들이 분담 실행합니다. 협업 모드는 끌 때까지 유지됩니다. 실패한 작업은 2회까지만 재시도하고 계획 수정도 8회에서 멈추므로 무한히 돌지 않습니다."
            : "입력창에 주제를 쓰고 보내면 이 대화창에서 회의가 시작됩니다. 회의 모드는 끌 때까지 유지됩니다."}
      </p>
    </div>
  );
});
