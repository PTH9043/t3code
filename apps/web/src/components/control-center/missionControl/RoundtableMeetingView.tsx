import type {
  MissionCrewRole,
  MissionExecutionStyle,
  MissionMeetingRecord,
  MissionMeetingStyle,
  MissionRoundtableStartInput,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CheckCircle2Icon,
  CrownIcon,
  ExternalLinkIcon,
  MessageSquareIcon,
  PlayIcon,
  RocketIcon,
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  MEETING_STANCE_META,
  MEETING_STATUS_META,
  MEETING_STYLE_META,
  ORG_TIER_META,
  formatRelativeTimeKo,
  formatTokensCompact,
} from "./missionControlUi.logic";

export function RoundtableMeetingView(props: {
  readonly projectId: ProjectId;
  readonly roles: ReadonlyArray<MissionCrewRole>;
  readonly meetings: ReadonlyArray<MissionMeetingRecord>;
  readonly projectThreads: ReadonlyArray<{ readonly id: ThreadId; readonly title: string }>;
  readonly killSwitchActive: boolean;
  readonly busy: boolean;
  readonly onStartMeeting: (input: MissionRoundtableStartInput) => Promise<void>;
  readonly onCancelMeeting: (meetingId: string) => Promise<void>;
  readonly onDeleteMeeting: (meetingId: string) => Promise<void>;
  readonly onPromoteToMission: (input: {
    readonly meetingId: string;
    readonly executionStyle: MissionExecutionStyle;
  }) => Promise<void>;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const enabledRoles = useMemo(() => props.roles.filter((r) => r.enabled), [props.roles]);
  const defaultModerator = useMemo(
    () =>
      enabledRoles.find(
        (r) => r.canModerate || r.orgTier === "L0_COMMANDER" || r.orgTier === "L1_LEAD",
      )?.roleKey ??
      enabledRoles[0]?.roleKey ??
      "planner",
    [enabledRoles],
  );

  const [topic, setTopic] = useState("");
  const [moderatorRoleKey, setModeratorRoleKey] = useState(defaultModerator);
  const [meetingStyle, setMeetingStyle] = useState<MissionMeetingStyle>("roundtable");
  const [maxRounds, setMaxRounds] = useState(3);
  const [autoSparseSelect, setAutoSparseSelect] = useState(true);
  const [selectedPeers, setSelectedPeers] = useState<string[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string>("__new__");

  const effectiveModerator = enabledRoles.some((r) => r.roleKey === moderatorRoleKey)
    ? moderatorRoleKey
    : defaultModerator;
  const candidatePeers = useMemo(
    () => enabledRoles.filter((r) => r.roleKey !== effectiveModerator),
    [effectiveModerator, enabledRoles],
  );

  const togglePeer = (roleKey: string) => {
    setAutoSparseSelect(false);
    setSelectedPeers((prev) =>
      prev.includes(roleKey) ? prev.filter((k) => k !== roleKey) : [...prev, roleKey],
    );
  };

  const handleStart = async () => {
    const trimmed = topic.trim();
    if (!trimmed || props.busy || props.killSwitchActive) return;
    await props.onStartMeeting({
      projectId: props.projectId,
      topic: trimmed,
      moderatorRoleKey: effectiveModerator,
      meetingStyle,
      maxRounds,
      autoSparseSelect,
      ...(!autoSparseSelect && selectedPeers.length > 0
        ? { participantRoleKeys: selectedPeers }
        : {}),
      ...(selectedThreadId !== "__new__"
        ? { threadId: selectedThreadId as ThreadId, createNewThread: false }
        : { createNewThread: true }),
    });
    setTopic("");
  };

  return (
    <div data-roundtable-meeting-view="" className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-12">
      {/* 좌측: 회의 개회 및 감독자/동등 참가자 편성 */}
      <section className="grid min-w-0 content-start gap-3 rounded-2xl border border-border bg-card p-4 shadow-xs xl:col-span-5">
        <div className="flex items-start gap-2">
          <UsersIcon className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">합석 회의 개회 (감독자 진행 · 전원 동등)</h3>
            <p className="text-[11px] text-muted-foreground">
              주최자(감독자)를 제외한 모든 참가자는 직급 없이 동등하게 대화하며, 하위 역할군도
              상급자에게 직접 반론·보완 의견을 전달해 결론을 도출합니다.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          {(["roundtable", "blind_audit"] as const).map((style) => {
            const meta = MEETING_STYLE_META[style];
            const active = meetingStyle === style;
            return (
              <button
                key={style}
                type="button"
                onClick={() => setMeetingStyle(style)}
                className={`rounded-xl border p-2.5 text-left transition-colors ${
                  active
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border/80 bg-background/60 text-muted-foreground hover:bg-muted/50"
                }`}
              >
                <div className="text-xs font-semibold">{meta.label}</div>
                <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug opacity-85">
                  {meta.hint}
                </div>
              </button>
            );
          })}
        </div>

        <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <CrownIcon className="size-3.5 text-amber-500" />
            주최자 (감독자 · 진행/합의 판정/최종 종합 전담)
          </span>
          <select
            aria-label="회의 감독자 선택"
            className="h-8 w-full min-w-0 truncate rounded-lg border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
            value={effectiveModerator}
            onChange={(e) => setModeratorRoleKey(e.target.value)}
          >
            {enabledRoles.map((role) => (
              <option key={role.roleKey} value={role.roleKey}>
                {role.displayName} ({ORG_TIER_META[role.orgTier ?? "L2_SPECIALIST"].short} ·{" "}
                {role.providerInstanceId}/{role.modelSlug})
              </option>
            ))}
          </select>
        </label>

        <div className="grid min-w-0 gap-1.5 rounded-xl border border-border/70 bg-muted/20 p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-foreground">
              동등 참가자 (직급 무관 1표 · 자유 반론 허용)
            </span>
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={autoSparseSelect}
                onChange={(e) => setAutoSparseSelect(e.target.checked)}
              />
              Layer 0 자동 희소 선별 (토큰 절감)
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {candidatePeers.map((peer) => {
              const checked = autoSparseSelect || selectedPeers.includes(peer.roleKey);
              const tierMeta = ORG_TIER_META[peer.orgTier ?? "L2_SPECIALIST"];
              return (
                <button
                  key={peer.roleKey}
                  type="button"
                  onClick={() => togglePeer(peer.roleKey)}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                    checked
                      ? "border-primary/50 bg-primary/10 text-foreground"
                      : "border-border bg-background/70 text-muted-foreground hover:bg-muted"
                  }`}
                >
                  <span className="font-medium">{peer.displayName}</span>
                  <span className="text-[10px] opacity-75">({tierMeta.short})</span>
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {autoSparseSelect
              ? "안건 도메인과 DyLAN 기여도 점수를 바탕으로 연관 역할군 2~3명만 활성화하고 나머지는 토큰 0으로 비활성화합니다."
              : "선택한 참가자들이 감독자 진행 아래 동등하게 시냅스 패킷(≤150T)으로 토론합니다."}
          </p>
        </div>

        <textarea
          rows={4}
          aria-label="합석 회의 안건"
          placeholder="예: 크라임 코인 1년 10배(승률 50%+) 백테스팅 전략에서 과최적화를 피하면서 진입 신호와 리스크 한도를 어떻게 설계할지 토론해 줘."
          className="w-full resize-none rounded-xl border border-input bg-background p-2.5 text-xs leading-relaxed text-foreground outline-none focus:ring-2 focus:ring-ring"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />

        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-12">
          <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground sm:col-span-8">
            <span>연동할 실제 대화창</span>
            <select
              className="h-8 w-full min-w-0 truncate rounded-lg border border-input bg-background px-2 text-xs text-foreground"
              value={selectedThreadId}
              onChange={(e) => setSelectedThreadId(e.target.value)}
            >
              <option value="__new__">+ 새 합석 회의 대화창 자동 생성</option>
              {props.projectThreads.map((t) => (
                <option key={t.id} value={t.id}>
                  기존 대화창: {t.title.length > 50 ? `${t.title.slice(0, 50)}…` : t.title}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground sm:col-span-4">
            <span>최대 라운드 (조기종료)</span>
            <select
              className="h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-xs text-foreground"
              value={maxRounds}
              onChange={(e) => setMaxRounds(Number(e.target.value))}
            >
              <option value={1}>1라운드 (신속)</option>
              <option value={2}>2라운드 (표준)</option>
              <option value={3}>3라운드 (심층·권장)</option>
              <option value={4}>4라운드</option>
            </select>
          </label>
        </div>

        {props.killSwitchActive ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/8 px-2.5 py-1.5 text-[11px] text-destructive">
            자율 운영실이 종료된 상태입니다. 상단 <strong>운영실 재가동</strong> 후 회의를 열 수
            있습니다.
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={!topic.trim() || props.busy || props.killSwitchActive}
            onClick={() => void handleStart()}
          >
            <PlayIcon className="size-3.5" />
            합석 회의 시작
          </Button>
        </div>
      </section>

      {/* 우측: 합석 회의 대화 타임라인 & 시냅스 패킷 뷰 */}
      <section className="grid min-w-0 content-start gap-3 rounded-2xl border border-border bg-card p-4 shadow-xs xl:col-span-7">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MessageSquareIcon className="size-4 text-primary" />
            <div>
              <h3 className="text-sm font-semibold">합석 회의록 · 시냅스 패킷 교차 대화</h3>
              <p className="text-[11px] text-muted-foreground">
                MacNet 150T 압축 패킷 · SMoA Response Selection · 하위→상급 동등 반론 기록
              </p>
            </div>
          </div>
          <Badge variant="outline" size="sm">
            {props.meetings.length}건
          </Badge>
        </div>

        {props.meetings.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-12 text-center text-xs text-muted-foreground">
            진행 중이거나 완료된 합석 회의가 없습니다. 좌측에서 감독자와 동등 참가자를 선택해 회의를
            시작해 보세요.
          </div>
        ) : (
          <div className="grid min-w-0 gap-3">
            {props.meetings.map((meeting) => {
              const statusMeta = MEETING_STATUS_META[meeting.status];
              const isRunning = meeting.status === "RUNNING";
              const canPromote =
                (meeting.status === "COMPLETED" || meeting.status === "CONSENSUS_REACHED") &&
                !meeting.linkedMissionId;

              return (
                <article
                  key={meeting.id}
                  data-meeting-card={meeting.id}
                  className="grid min-w-0 gap-2.5 rounded-xl border border-border/80 bg-background/70 p-3.5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={statusMeta.variant} size="sm">
                          {statusMeta.label}
                        </Badge>
                        <Badge variant="outline" size="sm">
                          {MEETING_STYLE_META[meeting.meetingStyle].label}
                        </Badge>
                        <Badge variant="outline" size="sm">
                          R{meeting.currentRound}/{meeting.maxRounds}
                        </Badge>
                      </div>
                      <h4 className="mt-1 line-clamp-2 break-words text-sm font-semibold">
                        {meeting.topic}
                      </h4>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1 font-medium text-foreground">
                          <CrownIcon className="size-3 text-amber-500" />
                          감독자: {meeting.moderatorDisplayName}
                        </span>
                        <span>·</span>
                        <span>참가자: {meeting.participantRoleKeys.join(", ") || "-"}</span>
                        {meeting.prunedRoleKeys.length > 0 ? (
                          <>
                            <span>·</span>
                            <span className="text-emerald-600 dark:text-emerald-400">
                              희소 비활성(0T): {meeting.prunedRoleKeys.join(", ")}
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      {meeting.threadId ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => props.onOpenThread(meeting.threadId!)}
                        >
                          <ExternalLinkIcon className="size-3" />
                          대화창 열기
                        </Button>
                      ) : null}
                      {isRunning ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="destructive"
                          disabled={props.busy}
                          onClick={() => void props.onCancelMeeting(meeting.id)}
                        >
                          <SquareIcon className="size-3" />
                          회의 중단
                        </Button>
                      ) : (
                        <>
                          {canPromote ? (
                            <Button
                              type="button"
                              size="xs"
                              variant="default"
                              disabled={props.busy}
                              onClick={() =>
                                void props.onPromoteToMission({
                                  meetingId: meeting.id,
                                  executionStyle: "hierarchical_ops",
                                })
                              }
                            >
                              <RocketIcon className="size-3" />
                              합의안으로 자율 미션 실행
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            disabled={props.busy}
                            onClick={() => void props.onDeleteMeeting(meeting.id)}
                          >
                            <Trash2Icon className="size-3" />
                            삭제
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {meeting.earlyStopReason ? (
                    <div className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/8 px-2.5 py-1.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                      <CheckCircle2Icon className="size-3.5 shrink-0" />
                      <span>{meeting.earlyStopReason}</span>
                    </div>
                  ) : null}

                  {/* 라운드별 시냅스 패킷 대화 카드 */}
                  {meeting.packets.length > 0 ? (
                    <div className="grid min-w-0 gap-1.5">
                      {meeting.packets.map((pkt) => {
                        const stanceMeta = MEETING_STANCE_META[pkt.stance];
                        const tierMeta = ORG_TIER_META[pkt.fromOrgTier];
                        return (
                          <div
                            key={pkt.id}
                            className={`grid min-w-0 gap-1 rounded-lg border px-2.5 py-2 text-xs ${
                              pkt.selectedForNextRound
                                ? "border-border/70 bg-muted/20"
                                : "border-border/40 bg-muted/10 opacity-70"
                            }`}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-1.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <Badge variant="outline" size="sm">
                                  R{pkt.roundNum}
                                </Badge>
                                <span className="font-semibold">{pkt.fromDisplayName}</span>
                                <span className="text-[10px] text-muted-foreground">
                                  ({tierMeta.short})
                                </span>
                                <Badge variant={stanceMeta.variant} size="sm">
                                  {stanceMeta.label}
                                </Badge>
                                {pkt.upwardFeedback ? (
                                  <Badge variant="info" size="sm">
                                    <ArrowUpRightIcon className="size-2.5" />
                                    하위→상급 의견 전달
                                  </Badge>
                                ) : null}
                                {pkt.replyToRoleKeys.length > 0 ? (
                                  <span className="text-[10px] text-muted-foreground">
                                    → {pkt.replyToRoleKeys.join(", ")}
                                  </span>
                                ) : null}
                              </div>
                              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground tabular-nums">
                                <span>{pkt.tokenCount}T</span>
                                <span>·</span>
                                <span>기여 {Math.round(pkt.importanceContribution * 100)}%</span>
                              </div>
                            </div>
                            <p className="break-words text-xs leading-relaxed text-foreground">
                              {pkt.claim}
                            </p>
                            {pkt.evidence.length > 0 || pkt.riskOrCounter ? (
                              <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                                {pkt.evidence.length > 0 ? (
                                  <span>근거: {pkt.evidence.join(" · ")}</span>
                                ) : null}
                                {pkt.riskOrCounter ? (
                                  <span className="text-amber-700 dark:text-amber-300">
                                    리스크/반론: {pkt.riskOrCounter}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}

                  {/* 감독자 최종 메타 통합 결론 */}
                  {meeting.finalSynthesisMd ? (
                    <div className="grid min-w-0 gap-1.5 rounded-lg border border-primary/25 bg-primary/5 p-3">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                        <SparklesIcon className="size-3.5" />
                        감독자 최종 통합 결론 ({meeting.moderatorDisplayName})
                      </div>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-foreground/90">
                        {meeting.finalSynthesisMd}
                      </pre>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground tabular-nums">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>토큰 {formatTokensCompact(meeting.totalTokens)}</span>
                      <span>·</span>
                      <span className="text-emerald-600 dark:text-emerald-400">
                        시냅스 압축 절감 ~{formatTokensCompact(meeting.estimatedSavedTokens)}T
                      </span>
                      <span>·</span>
                      <span>비용 ${meeting.totalCostUsd.toFixed(4)}</span>
                      {meeting.linkedMissionId ? (
                        <>
                          <span>·</span>
                          <Badge variant="success" size="sm">
                            미션 인계됨 ({meeting.linkedMissionId})
                          </Badge>
                        </>
                      ) : null}
                    </div>
                    <span>
                      {formatRelativeTimeKo(meeting.completedAtMs ?? meeting.createdAtMs)}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
