import {
  resolveSubordinateTeam,
  type EnvironmentId,
  type ProviderInstanceId,
  type WorkspaceMeetingMode,
} from "@t3tools/contracts";
import { memo, useEffect } from "react";
import { CrownIcon, PlusIcon, UsersIcon, XIcon } from "lucide-react";
import { useEnvironmentSettings } from "~/hooks/useSettings";

import { Switch } from "../ui/switch";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import type { ModelEsque } from "./providerIconUtils";
import { cn } from "~/lib/utils";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  groupProviderInstanceEntriesByDriver,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import {
  addMeetingComposerSeat,
  setMeetingComposerSeatModel,
  setMeetingComposerSeatOption,
  toggleMeetingComposerSeat,
  updateMeetingComposerConfig,
  useMeetingComposerConfig,
} from "../../meetingComposerStore";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";
import { getProviderModelCapabilities } from "../../providerModels";
import { meetingModelDefaultOptions } from "../../meetingModelOptions";
import { ExecutionProfiles } from "../control-center/ExecutionProfiles";

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

function AutoSeatGlobalSubordinatesButton(props: {
  readonly environmentId: EnvironmentId;
  readonly visibleEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly currentSeats: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
  }>;
}) {
  const envSettings = useEnvironmentSettings(props.environmentId);
  const globalSubordinates = resolveSubordinateTeam(envSettings).members.filter(
    (member) => member.enabled !== false,
  );
  if (globalSubordinates.length === 0) return null;
  return (
    <button
      type="button"
      data-meeting-auto-seat-subordinates=""
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
      onClick={() => {
        for (const member of globalSubordinates) {
          const entry = props.visibleEntries.find((e) => e.instanceId === member.instanceId);
          if (!entry) continue;
          const alreadySeated = props.currentSeats.some(
            (seat) => seat.instanceId === member.instanceId && seat.model === member.model,
          );
          if (alreadySeated) continue;
          addMeetingComposerSeat({
            instanceId: member.instanceId,
            model: member.model,
            displayName: entry.displayName,
            ...(member.instructions ? { roleDescription: member.instructions } : {}),
            options: meetingModelDefaultOptions(entry, member.model),
          });
        }
      }}
    >
      <UsersIcon className="size-3" />
      전역 하위 팀({globalSubordinates.length}명) 합석
    </button>
  );
}

/**
 * Add models as independent participants, choose their conductor and effort,
 * and bound discussion and recovery before sending a topic from the composer.
 */
export const MeetingModePanel = memo(function MeetingModePanel(props: {
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly profileTarget?: { environmentId: EnvironmentId; folderKey: string };
}) {
  const config = useMeetingComposerConfig();
  const visibleEntries = props.instanceEntries.filter(isProviderInstancePickerVisible);
  const providerGroups = groupProviderInstanceEntriesByDriver(visibleEntries).flatMap((group) =>
    group.entries.map((entry) => ({
      ...group,
      label: group.entries.length > 1 ? `${entry.displayName} (${entry.instanceId})` : group.label,
      entries: [entry],
    })),
  );
  // "바로 실행" skips discussion: the chair plans straight away and the seats
  // split the work. The style is its own field, so picking it never touches the
  // discussion side's rounds or mode.
  const isDirectCollaboration = config.style === "collaboration";

  // Self-heal selections a past bug stored as display LABELS ("Extra High")
  // instead of choice ids ("xhigh"): remap by label once, idempotently.
  useEffect(() => {
    for (const seat of config.seats) {
      const entry = visibleEntries.find((candidate) => candidate.instanceId === seat.instanceId);
      if (!entry) continue;
      const seatId = seat.id;
      for (const option of meetingModelDefaultOptions(entry, seat.model)) {
        if (!seat.options?.some((stored) => stored.id === option.id)) {
          setMeetingComposerSeatOption(seatId, option.id, option.value);
        }
      }
      const descriptors = getProviderOptionDescriptors({
        caps: getProviderModelCapabilities(entry.models, seat.model, entry.driverKind),
      });
      for (const stored of seat.options ?? []) {
        if (typeof stored.value !== "string") continue;
        const descriptor = descriptors.find(
          (candidate) => candidate.id === stored.id && candidate.type === "select",
        );
        if (!descriptor || descriptor.type !== "select") continue;
        if (descriptor.options.some((choice) => choice.id === stored.value)) continue;
        const byLabel = descriptor.options.find((choice) => choice.label === stored.value);
        if (byLabel) {
          setMeetingComposerSeatOption(seatId, stored.id, byLabel.id);
        } else {
          const fallback = meetingModelDefaultOptions(entry, seat.model).find(
            (option) => option.id === stored.id,
          );
          if (fallback) setMeetingComposerSeatOption(seatId, stored.id, fallback.value);
        }
      }
    }
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-3 py-2.5 text-sm">
      {props.profileTarget ? <ExecutionProfiles {...props.profileTarget} /> : null}
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        시작 방식
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
          <span className="block">토론 먼저</span>
          <span className="block font-normal text-muted-foreground">
            토론으로 합의한 뒤 병렬 실행
          </span>
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
          <span className="block">바로 실행</span>
          <span className="block font-normal text-muted-foreground">
            토론 없이 곧장 분담 병렬 실행
          </span>
        </button>
      </div>

      <label className="mt-3 grid gap-1.5 text-xs font-medium">
        <span className="flex items-center gap-1">
          <CrownIcon className="size-3.5" />
          지휘 AI
        </span>
        <select
          className={SELECT_CLASS}
          aria-label="지휘 AI"
          value={config.chairSeatId ?? ""}
          onChange={(event) => {
            const chairSeatId = event.currentTarget.value || null;
            updateMeetingComposerConfig((current) => ({ ...current, chairSeatId }));
          }}
        >
          <option value="">감독 AI 선택</option>
          {config.seats.map((seat) => {
            const seatEntry = visibleEntries.find((entry) => entry.instanceId === seat.instanceId);
            const sameDriver = visibleEntries.filter(
              (entry) => entry.driverKind === seatEntry?.driverKind,
            );
            const seatLabel = seatEntry
              ? sameDriver.length > 1
                ? `${seatEntry.displayName} (${seatEntry.instanceId})`
                : (groupProviderInstanceEntriesByDriver(sameDriver)[0]?.label ?? seat.displayName)
              : seat.displayName;
            return (
              <option key={seat.id} value={seat.id}>
                {seatLabel} ·{" "}
                {props.modelOptionsByInstance
                  .get(seat.instanceId)
                  ?.find((model) => model.slug === seat.model)?.name ?? seat.model}
              </option>
            );
          })}
        </select>
        <span className="font-normal text-muted-foreground">
          선택한 AI가 사용자의 대화 지시와 역할을 바탕으로 계획·배정·검증·최종 정리를 맡습니다.
        </span>
      </label>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          참가자 {config.seats.length > 0 ? `· ${config.seats.length}명` : ""}{" "}
          <span className="font-normal normal-case">(1명 이상)</span>
        </div>
        {props.profileTarget ? (
          <AutoSeatGlobalSubordinatesButton
            environmentId={props.profileTarget.environmentId}
            visibleEntries={visibleEntries}
            currentSeats={config.seats}
          />
        ) : null}
      </div>
      <div className="mt-1.5 grid gap-1">
        {providerGroups.map((group) => {
          // Keep each model tied to the account that actually provides it.
          const groupSeats = config.seats.filter((seat) =>
            group.entries.some((entry) => entry.instanceId === seat.instanceId),
          );
          const firstReadyEntry = group.entries.find(isProviderInstancePickerReady);
          const ready = firstReadyEntry !== undefined;
          const allOptions = Array.from(
            new Map(
              group.entries.flatMap((entry) => {
                const instanceOptions = props.modelOptionsByInstance.get(entry.instanceId) ?? [];
                return instanceOptions.map((model) => [model.slug, model]);
              }),
            ).values(),
          );
          const available = allOptions.filter(
            (option) => !groupSeats.some((seat) => seat.model === option.slug),
          );
          const nextModel = defaultSeatModel(available) ?? defaultSeatModel(allOptions);

          return (
            <div key={group.entries[0]!.instanceId} className="space-y-1.5">
              <div className="rounded-md border border-border/60 px-2 py-2">
                <div className="flex items-center gap-2">
                  <ProviderInstanceIcon
                    driverKind={group.driverKind}
                    displayName={group.label}
                    accentColor={undefined}
                    showBadge={false}
                    className="size-4 shrink-0"
                    iconClassName="size-4"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {group.label}
                    {!ready ? (
                      <span className="ml-1 font-normal text-muted-foreground">(사용 불가)</span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs hover:bg-muted disabled:opacity-40"
                    aria-label={`${group.label} 모델 추가`}
                    disabled={!ready || nextModel === null}
                    onClick={() => {
                      if (nextModel === null || !firstReadyEntry) return;
                      addMeetingComposerSeat({
                        instanceId: firstReadyEntry.instanceId,
                        model: nextModel,
                        displayName: group.label,
                        options: meetingModelDefaultOptions(firstReadyEntry, nextModel),
                      });
                    }}
                  >
                    <PlusIcon className="size-3" />
                    모델 추가
                  </button>
                </div>
                {groupSeats.map((seat) => {
                  const seatId = seat.id;
                  const seatEntry = group.entries.find(
                    (entry) => entry.instanceId === seat.instanceId,
                  );
                  if (!seatEntry) return null;
                  const seatReady = isProviderInstancePickerReady(seatEntry);
                  const modelLabel =
                    allOptions.find((option) => option.slug === seat.model)?.name ?? seat.model;
                  const isConductor = config.chairSeatId === seat.id;
                  return (
                    <div
                      key={seat.id}
                      data-meeting-seat={seat.id}
                      className="mt-2 rounded border border-border/50 p-2"
                    >
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          aria-label={`${group.label} ${modelLabel} 지휘 AI로 선택`}
                          aria-pressed={isConductor}
                          title={isConductor ? "지휘 AI" : "지휘 AI로 선택"}
                          className={cn(
                            "shrink-0 rounded p-1 hover:bg-muted",
                            isConductor ? "text-primary" : "text-muted-foreground",
                          )}
                          onClick={() =>
                            updateMeetingComposerConfig((current) => ({
                              ...current,
                              chairSeatId: seat.id,
                            }))
                          }
                        >
                          <CrownIcon className="size-3.5" />
                        </button>
                        <select
                          className={SELECT_CLASS}
                          value={seat.model}
                          aria-label={`${group.label} ${modelLabel} 모델`}
                          disabled={!seatReady}
                          onChange={(event) =>
                            setMeetingComposerSeatModel(
                              seatId,
                              event.currentTarget.value,
                              meetingModelDefaultOptions(seatEntry, event.currentTarget.value),
                            )
                          }
                        >
                          {allOptions.map((option) => (
                            <option key={option.slug} value={option.slug}>
                              {option.shortName ?? option.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
                          aria-label={`${group.label} ${modelLabel} 제거`}
                          onClick={() => toggleMeetingComposerSeat(seat)}
                        >
                          <XIcon className="size-3.5" />
                        </button>
                      </div>
                      <label className="mt-1.5 grid gap-1 text-xs">
                        <span>사용자가 지정한 역할</span>
                        <input
                          className={SELECT_CLASS}
                          value={seat.roleDescription ?? ""}
                          placeholder="예: 성능 조사와 근거 확인을 맡아줘"
                          onChange={(event) => {
                            const roleDescription = event.currentTarget.value;
                            updateMeetingComposerConfig((current) => ({
                              ...current,
                              seats: current.seats.map((entry) =>
                                entry.id === seat.id ? { ...entry, roleDescription } : entry,
                              ),
                            }));
                          }}
                        />
                      </label>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">
                          {isConductor ? "지휘 AI" : "작업 AI"}
                        </span>
                        {getProviderOptionDescriptors({
                          caps: getProviderModelCapabilities(
                            seatEntry.models,
                            seat.model,
                            seatEntry.driverKind,
                          ),
                          selections: seat.options ?? null,
                        })
                          .filter((descriptor) => descriptor.type === "select")
                          .map((descriptor) => {
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
                                aria-label={`${group.label} ${modelLabel} ${descriptor.label}`}
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
                          })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {config.seats
          .filter((seat) => !visibleEntries.some((entry) => entry.instanceId === seat.instanceId))
          .map((seat) => (
            <div
              key={seat.id}
              className="flex items-center gap-2 rounded-md border border-border/60 p-2 text-xs"
            >
              <span className="min-w-0 flex-1 break-all">
                {seat.displayName} · {seat.model} (연결을 찾을 수 없음)
              </span>
              <button
                type="button"
                aria-label={`${seat.displayName} ${seat.model} 제거`}
                onClick={() => toggleMeetingComposerSeat(seat)}
              >
                제거
              </button>
            </div>
          ))}
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
        <label className="flex items-center justify-between gap-2 text-xs font-medium">
          <span>
            수정 한도
            <span className="ml-1 font-normal text-muted-foreground">실패 복구·재계획 총 횟수</span>
          </span>
          <input
            type="number"
            min={1}
            max={8}
            aria-label="실패 복구·재계획 한도"
            value={config.maxRevisions}
            onChange={(event) => {
              const parsed = Number.parseInt(event.currentTarget.value, 10);
              if (!Number.isInteger(parsed)) return;
              const maxRevisions = Math.min(8, Math.max(1, parsed));
              updateMeetingComposerConfig((current) => ({ ...current, maxRevisions }));
            }}
            className={cn(SELECT_CLASS, "w-16 text-center")}
          />
        </label>
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
        <div className="mt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          병렬 실행
        </div>
        <label className="flex items-center justify-between gap-2 text-xs font-medium">
          <span>
            병렬 폭
            <span className="ml-1 font-normal text-muted-foreground">
              동시에 실행할 노드 수{config.maxParallel <= 1 ? " · 1이면 순차" : ""}
              {config.maxParallel > 1 && !config.isolateWorktrees ? " · 수정 작업은 하나씩" : ""}
            </span>
          </span>
          <input
            type="number"
            min={1}
            max={6}
            value={config.maxParallel}
            onChange={(event) => {
              const parsed = Number.parseInt(event.currentTarget.value, 10);
              if (!Number.isInteger(parsed)) return;
              const maxParallel = Math.min(6, Math.max(1, parsed));
              updateMeetingComposerConfig((current) => ({ ...current, maxParallel }));
            }}
            className={cn(SELECT_CLASS, "w-16 text-center")}
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-xs font-medium">
          <span>
            worktree 격리
            <span className="ml-1 font-normal text-muted-foreground">
              수정 묶음마다 전용 체크아웃 · 병합 전 diff 검토
            </span>
          </span>
          <Switch
            checked={config.isolateWorktrees}
            onCheckedChange={(isolateWorktrees) =>
              updateMeetingComposerConfig((current) => ({ ...current, isolateWorktrees }))
            }
          />
        </label>
      </div>

      <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
        <label className="grid gap-1 text-xs font-medium">
          실행 기간
          <select
            aria-label="실행 기간"
            value={config.executionMode ?? "once"}
            className={SELECT_CLASS}
            onChange={(event) => {
              const executionMode =
                event.currentTarget.value === "persistent" ? "persistent" : "once";
              updateMeetingComposerConfig((current) => ({ ...current, executionMode }));
            }}
          >
            <option value="once">한 번 실행</option>
            <option value="persistent">목표 완료까지 지속</option>
          </select>
        </label>
        {config.executionMode === "persistent" && (
          <label className="grid gap-1 text-xs font-medium">
            별도 감시 AI 확인 간격 · 초
            <input
              type="number"
              min={1}
              step={1}
              placeholder="지정하지 않으면 감시 안 함"
              value={config.watchdogIntervalSeconds ?? ""}
              className={SELECT_CLASS}
              onChange={(event) => {
                const raw = event.currentTarget.value;
                const value = Number(raw);
                if (raw !== "" && (!Number.isSafeInteger(value) || value <= 0)) return;
                updateMeetingComposerConfig((current) => {
                  const { watchdogIntervalSeconds: _previous, ...rest } = current;
                  return raw === "" ? rest : { ...rest, watchdogIntervalSeconds: value };
                });
              }}
            />
            <span className="font-normal text-muted-foreground">
              지정한 감독 AI 모델로 별도 세션을 실행하며 사용량이 발생합니다.
            </span>
          </label>
        )}
        <label className="flex items-center justify-between gap-2 text-xs font-medium">
          <span>
            실행 전 계획 확인
            <span className="ml-1 font-normal text-muted-foreground">
              작업·담당자·선행 작업 수정 후 시작
            </span>
          </span>
          <Switch
            checked={config.reviewPlan === true}
            onCheckedChange={(reviewPlan) =>
              updateMeetingComposerConfig((current) => ({ ...current, reviewPlan }))
            }
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-xs font-medium">
          <span>
            사용량 제한 후 자동 재개
            <span className="block font-normal text-muted-foreground">
              확인된 리셋 시각에 최대 3회 · 꺼두면 기존 오류 처리
            </span>
          </span>
          <Switch
            checked={config.resumeAfterLimit === true}
            onCheckedChange={(resumeAfterLimit) =>
              updateMeetingComposerConfig((current) => ({ ...current, resumeAfterLimit }))
            }
          />
        </label>
        <label className="grid gap-1 text-xs font-medium">
          작업 AI 실행 한도
          <input
            type="number"
            min={1}
            max={500}
            placeholder="제한 없음"
            value={config.maxWorkerTurns ?? ""}
            className={SELECT_CLASS}
            onChange={(event) => {
              const value = event.currentTarget.value;
              const maxWorkerTurns =
                value === "" ? undefined : Math.min(500, Math.max(1, Number.parseInt(value, 10)));
              if (maxWorkerTurns !== undefined && !Number.isInteger(maxWorkerTurns)) return;
              updateMeetingComposerConfig((current) => {
                const { maxWorkerTurns: _previous, ...rest } = current;
                return maxWorkerTurns === undefined ? rest : { ...rest, maxWorkerTurns };
              });
            }}
          />
          <span className="font-normal text-muted-foreground">
            작업·검증·재시도의 AI 호출 합계입니다. 질문 대기는 포함하지 않습니다.
          </span>
        </label>
        <label className="grid gap-1 text-xs font-medium">
          완료 검증 명령 · 한 줄에 하나
          <textarea
            rows={2}
            maxLength={4000}
            className="w-full rounded-md border border-input bg-background p-2 text-xs"
            placeholder="프로젝트에서 실행할 검증 명령"
            value={(config.verificationCommands ?? []).join("\n")}
            onChange={(event) => {
              const verificationCommands = event.currentTarget.value.split(/\r?\n/u);
              updateMeetingComposerConfig((current) => ({ ...current, verificationCommands }));
            }}
          />
          <span className="font-normal text-muted-foreground">
            코드 작업은 통합된 폴더에서 이 명령을 통과해야 완료됩니다.
          </span>
        </label>
      </div>
      <p className="mt-3 border-t border-border/60 pt-2 text-[11px] leading-relaxed text-muted-foreground">
        {config.seats.length < 1
          ? "감독 AI를 선택하세요."
          : isDirectCollaboration
            ? `지휘 AI가 계획을 세우고 필요한 작업을 배정합니다. 실패 복구·재계획은 ${config.maxRevisions}회까지 허용합니다. 각 모델의 추론 수준은 위에서 따로 선택할 수 있습니다.`
            : "입력창에 주제를 쓰고 보내면 이 대화창에서 오케스트라 토론이 시작됩니다. 설정한 라운드가 모두 끝나면 실행으로 넘어갈지, 라운드를 더 할지, 여기서 마칠지 물어봅니다."}
      </p>
    </div>
  );
});
