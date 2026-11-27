import {
  resolveSubordinateTeam,
  type CouncilMode,
  type CouncilSessionSnapshot,
  type EnvironmentId,
  type ModelTargetRef,
  type ProjectId,
  type ProviderDriverKind,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { ShieldCheckIcon, SparklesIcon, UsersIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const COUNCIL_MODE_OPTIONS: ReadonlyArray<{
  readonly value: CouncilMode;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    value: "auto",
    label: "자동 판별",
    hint: "분석·전략 질문은 채팅 보고서로, 코드 수정 지시는 PinnedSpec으로 자동 분기합니다.",
  },
  {
    value: "discussion",
    label: "분석·토론 보고서",
    hint: "파일 잠금 없이 근거 검증 토론 후 최종 합의 보고서를 채팅방에 바로 게시합니다.",
  },
  {
    value: "code_patch",
    label: "코드 수정 명세",
    hint: "수정 대상 파일 SHA-256 잠금 및 원클릭 워커 위임 카드(PinnedSpec)를 생성합니다.",
  },
];

export const ChatCouncilStrip = memo(function ChatCouncilStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly chairLabel: string;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly latestSession: CouncilSessionSnapshot | null;
  readonly sessions?: ReadonlyArray<CouncilSessionSnapshot>;
  readonly selectedCouncilId?: string | null;
  readonly onSelectCouncil?: (councilId: string) => void;
  readonly isStarting: boolean;
  readonly isCardDismissed?: boolean;
  readonly onReopenCard?: () => void;
  readonly onStartCouncil: (input: {
    readonly userPrompt: string;
    readonly mode?: CouncilMode;
    readonly overrideSubordinateTargets?: ReadonlyArray<ModelTargetRef>;
  }) => Promise<void>;
  readonly onOpenEvidenceDrawer: () => void;
}) {
  const settings = useEnvironmentSettings(props.environmentId);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [topicInput, setTopicInput] = useState("");
  const [selectedMode, setSelectedMode] = useState<CouncilMode>("auto");
  const [disabledKeys, setDisabledKeys] = useState<ReadonlySet<string>>(() => new Set());

  const instanceById = useMemo(
    () => new Map(props.providerStatuses.map((entry) => [entry.instanceId, entry])),
    [props.providerStatuses],
  );

  const globalSubordinates = useMemo(() => {
    const team = resolveSubordinateTeam(settings, props.threadId);
    return team.members
      .filter((member) => member.enabled !== false)
      .map((member) => {
        const entry = instanceById.get(member.instanceId);
        const key = `${member.instanceId}:${member.model}`;
        const target: ModelTargetRef = {
          providerInstanceId: member.instanceId,
          driverId: (entry?.driver ?? member.instanceId) as ProviderDriverKind,
          modelId: member.model,
          displayName: entry?.displayName
            ? `${entry.displayName} · ${member.model}`
            : `${member.instanceId} · ${member.model}`,
        };
        return { key, role: member.role, target };
      });
  }, [instanceById, props.threadId, settings]);

  const activeTargets = useMemo(
    () =>
      globalSubordinates.filter((item) => !disabledKeys.has(item.key)).map((item) => item.target),
    [disabledKeys, globalSubordinates],
  );

  const verifiedCount = useMemo(
    () =>
      props.latestSession?.ledgerEntries.filter(
        (e) =>
          e.verificationStatus === "VERIFIED_EXACT" || e.verificationStatus === "VERIFIED_SHIFTED",
      ).length ?? 0,
    [props.latestSession],
  );

  const handleLaunch = async () => {
    const trimmed = topicInput.trim();
    if (!trimmed || props.isStarting) return;
    setPopoverOpen(false);
    await props.onStartCouncil({
      userPrompt: trimmed,
      mode: selectedMode,
      ...(disabledKeys.size > 0 ? { overrideSubordinateTargets: activeTargets } : {}),
    });
    setTopicInput("");
  };

  return (
    <div
      data-council-strip=""
      className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-3 py-1 text-[11px] text-muted-foreground sm:px-5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <UsersIcon className="size-3.5 text-muted-foreground" />
          동적 위원회 1+{activeTargets.length}석
        </span>
        <span className="hidden truncate text-muted-foreground sm:inline">
          의장: {props.chairLabel}
        </span>
        {props.latestSession ? (
          <>
            <Badge variant="outline" size="sm">
              {props.latestSession.state}
            </Badge>
            {props.latestSession.mode === "discussion" ? (
              <Badge variant="secondary" size="sm">
                분석·토론
              </Badge>
            ) : null}
            {verifiedCount > 0 ? (
              <Badge variant="success" size="sm">
                <ShieldCheckIcon className="size-3" />
                근거 {verifiedCount}
              </Badge>
            ) : null}
            {props.latestSession.flipBlockedCount > 0 ? (
              <Badge variant="warning" size="sm">
                Flip 차단 {props.latestSession.flipBlockedCount}
              </Badge>
            ) : null}
          </>
        ) : null}
        {props.sessions && props.sessions.length > 1 && props.onSelectCouncil ? (
          <select
            aria-label="다자간 위원회 이력 선택"
            data-council-history-select=""
            value={props.selectedCouncilId ?? props.latestSession?.councilId ?? ""}
            onChange={(e) => props.onSelectCouncil?.(e.target.value)}
            className="h-5 max-w-[160px] rounded border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {props.sessions.map((item, idx) => (
              <option key={item.councilId} value={item.councilId}>
                {idx === 0 ? "최신" : `이전 ${idx}`} · #{item.councilId.slice(-6)} ({item.state})
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {props.latestSession && props.isCardDismissed && props.onReopenCard ? (
          <Button
            size="xs"
            variant="ghost"
            data-council-reopen-card=""
            onClick={props.onReopenCard}
          >
            카드 보기
          </Button>
        ) : null}
        {props.latestSession ? (
          <Button size="xs" variant="ghost" onClick={props.onOpenEvidenceDrawer}>
            원장
          </Button>
        ) : null}
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger
            render={
              <Button size="xs" variant="outline" disabled={props.isStarting}>
                <SparklesIcon className="size-3" />
                {props.isStarting ? "소집 중..." : "하위 팀 합석 회의"}
              </Button>
            }
          />
          <PopoverPopup align="end" className="w-[min(380px,90vw)] p-3 text-xs">
            <div className="space-y-2.5">
              <div>
                <p className="font-semibold text-foreground">
                  가변 하위 팀 자동 합석 (Blind R1 → 익명 R2 → 원장 → PinnedSpec)
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  현재 채팅방 모델({props.chairLabel})을 의장으로, 선택한 전역 하위 모델이 역할별
                  직교 합석합니다.
                </p>
              </div>

              <div className="space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">
                  참여 하위 슬롯 ({activeTargets.length}/{globalSubordinates.length})
                </span>
                {globalSubordinates.length === 0 ? (
                  <p className="rounded-md border border-border bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
                    설정된 전역 하위 모델이 없습니다. 소집 시 가용 폴백 모델이 의무 반론자로 자동
                    합석합니다.
                  </p>
                ) : (
                  <div className="max-h-32 space-y-1 overflow-y-auto">
                    {globalSubordinates.map((item) => {
                      const checked = !disabledKeys.has(item.key);
                      return (
                        <label
                          key={item.key}
                          className="flex cursor-pointer items-center justify-between gap-2 rounded border border-border/60 bg-card px-2 py-1"
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                setDisabledKeys((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(item.key)) next.delete(item.key);
                                  else next.add(item.key);
                                  return next;
                                });
                              }}
                              className="size-3.5 accent-primary"
                            />
                            <span className="truncate text-foreground">
                              {item.target.displayName}
                            </span>
                          </span>
                          <Badge variant="outline" size="sm">
                            {item.role}
                          </Badge>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="space-y-1" data-council-mode-picker="">
                <span className="text-[11px] font-medium text-muted-foreground">회의 방식</span>
                <div className="grid grid-cols-3 gap-1">
                  {COUNCIL_MODE_OPTIONS.map((opt) => {
                    const active = selectedMode === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setSelectedMode(opt.value)}
                        className={`rounded border px-2 py-1 text-[11px] font-medium transition-colors ${
                          active
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border/70 bg-card text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {COUNCIL_MODE_OPTIONS.find((o) => o.value === selectedMode)?.hint}
                </p>
              </div>

              <label className="grid gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">회의 안건</span>
                <textarea
                  rows={3}
                  value={topicInput}
                  onChange={(e) => setTopicInput(e.target.value)}
                  placeholder="예: 인증 레이어 동시성 경쟁 조건을 전수 분석하고 최소 침습 패치 명세를 확정해줘"
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>

              <div className="flex justify-end gap-1.5">
                <Button size="xs" variant="ghost" onClick={() => setPopoverOpen(false)}>
                  취소
                </Button>
                <Button
                  size="xs"
                  disabled={topicInput.trim().length === 0 || props.isStarting}
                  onClick={() => void handleLaunch()}
                >
                  위원회 소집 시작
                </Button>
              </div>
            </div>
          </PopoverPopup>
        </Popover>
      </div>
    </div>
  );
});
