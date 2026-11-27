import { ToolActivityRow, UnlinkedToolRecords } from "./ToolActivityRow";
import { hasChildActivityScope } from "@t3tools/shared/toolActivity";
import { type MessageId, ModelSelection, type WorkspaceOrchestraBlock } from "@t3tools/contracts";
import {
  handoffDeliveryText,
  latestHandoffActivity,
} from "@t3tools/client-runtime/state/conversation-handoff";
import {
  orchestraKindLabels,
  orchestraStatusLabels,
} from "@t3tools/client-runtime/state/presentation";
import type { ResponseStyleUiProfile } from "@t3tools/client-runtime/state/response-style-presentation";
import * as Schema from "effect/Schema";
import { useMemo, useState } from "react";
import { responseStyleSettingLabel, STANDARD_RESPONSE_STYLE_UI_PROFILE } from "~/responseStyleUi";
import type { PendingApproval, WorkLogEntry } from "../../session-logic";
import type { Thread, TurnDiffSummary } from "../../types";
import { ResponseStyleResultSummary } from "./ResponseStyleIndicators";

const turnStates = {
  running: "실행 중",
  completed: "완료",
  interrupted: "중단",
  error: "오류",
} as const;
const toolStates = {
  inProgress: "실행 중",
  completed: "완료",
  failed: "실패",
  declined: "거절",
  stopped: "중지",
} as const;
const isModelSelection = Schema.is(ModelSelection);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";
const clock = (value: string) => new Date(value).toLocaleTimeString("ko-KR");

type ViewerThread = Pick<Thread, "id" | "latestTurn" | "session" | "messages" | "activities">;

interface ViewerProps {
  thread: ViewerThread;
  historyState?: "saved" | "loading" | "draft";
  onEditTeam?: (() => void) | undefined;
  nextModel: ModelSelection | null;
  blocks: ReadonlyMap<MessageId, WorkspaceOrchestraBlock>;
  workLog: readonly WorkLogEntry[];
  checkpoints: readonly TurnDiffSummary[];
  onOpenTurnDiff?: (turnId: TurnDiffSummary["turnId"], path?: string) => void;
  pendingApprovals: readonly PendingApproval[];
  /** The style configured now. Past turns do not record the style they were answered with. */
  responseStyleProfile?: ResponseStyleUiProfile;
}

const toolActionGroupLabels: Readonly<Record<string, string>> = {
  read: "파일 읽기",
  edit: "파일 수정",
  command: "명령 실행",
  search: "검색",
  mcp: "MCP 도구",
  web: "웹 조회",
};

interface WorkTimelineRun {
  readonly key: string;
  readonly groupLabel: string;
  readonly entries: readonly WorkLogEntry[];
}

export function groupConsecutiveWorkLogEntries(
  entries: readonly WorkLogEntry[],
): ReadonlyArray<WorkTimelineRun> {
  const runs: Array<{
    key: string;
    signature: string | null;
    groupLabel: string;
    entries: WorkLogEntry[];
  }> = [];
  for (const entry of entries) {
    let signature: string | null = null;
    let groupLabel = entry.toolTitle ?? entry.label;
    if (entry.toolActivity) {
      const action = entry.toolActivity.action;
      signature = `tool:${action}:${entry.toolActivity.executorLabel}`;
      const actionText = toolActionGroupLabels[action] ?? action;
      groupLabel = entry.toolActivity.executorLabel
        ? `${entry.toolActivity.executorLabel} · ${actionText}`
        : actionText;
    } else if (!entry.unlinkedToolSignals) {
      const baseTitle = (entry.toolTitle ?? entry.label).trim();
      if (baseTitle.length > 0) {
        signature = `plain:${baseTitle}`;
        groupLabel = baseTitle;
      }
    }
    const previous = runs.at(-1);
    if (previous && signature !== null && previous.signature === signature) {
      previous.entries.push(entry);
    } else {
      runs.push({
        key: entry.id,
        signature,
        groupLabel,
        entries: [entry],
      });
    }
  }
  return runs.map(({ key, groupLabel, entries: groupedEntries }) => ({
    key,
    groupLabel,
    entries: groupedEntries,
  }));
}

function WorkTimelineItemContent({ entry }: { entry: WorkLogEntry }) {
  if (entry.unlinkedToolSignals) {
    return <UnlinkedToolRecords groups={entry.unlinkedToolSignals} />;
  }
  if (entry.toolActivity) {
    return <ToolActivityRow group={entry.toolActivity} />;
  }
  return (
    <>
      <time dateTime={entry.createdAt} className="mr-2 text-muted-foreground">
        {clock(entry.createdAt)}
      </time>
      {entry.toolTitle ?? entry.label}
      {entry.toolLifecycleStatus && <span> · {toolStates[entry.toolLifecycleStatus]}</span>}
      {(entry.detail || entry.command) && (
        <details>
          <summary>상세</summary>
          <pre className="whitespace-pre-wrap break-words">{entry.detail ?? entry.command}</pre>
        </details>
      )}
    </>
  );
}

function WorkTimeline({ entries }: { entries: readonly WorkLogEntry[] }) {
  const [all, setAll] = useState(false);
  const visibleEntries = useMemo(() => (all ? entries : entries.slice(-20)), [all, entries]);
  const groupedRuns = useMemo(
    () => groupConsecutiveWorkLogEntries(visibleEntries),
    [visibleEntries],
  );
  if (!entries.length) return null;
  return (
    <section aria-label="작업 기록">
      <h4 className="font-medium">작업 기록</h4>
      {!all && entries.length > 20 && (
        <button
          type="button"
          className="text-muted-foreground underline"
          onClick={() => setAll(true)}
        >
          이전 기록 {entries.length - 20}개 보기
        </button>
      )}
      <ol className="mt-1 divide-y divide-border/60">
        {groupedRuns.map((run) =>
          run.entries.length === 1 ? (
            <li key={run.key} className="py-1">
              <WorkTimelineItemContent entry={run.entries[0]!} />
            </li>
          ) : (
            <li key={run.key} className="py-1">
              <details
                data-tool-activity-group="true"
                className="rounded-md border border-border/60 bg-muted/20 px-2 py-1"
              >
                <summary className="flex cursor-pointer items-center justify-between gap-2 text-xs font-medium select-none">
                  <span className="min-w-0 truncate">{run.groupLabel}</span>
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="rounded-full border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-foreground">
                      ×{run.entries.length}
                    </span>
                    <time dateTime={run.entries[0]!.createdAt}>
                      {clock(run.entries[0]!.createdAt)}
                    </time>
                  </span>
                </summary>
                <ol className="mt-1.5 divide-y divide-border/50 border-t border-border/50 pt-1 pl-2">
                  {run.entries.map((entry) => (
                    <li key={entry.id} className="py-1">
                      <WorkTimelineItemContent entry={entry} />
                    </li>
                  ))}
                </ol>
              </details>
            </li>
          ),
        )}
      </ol>
    </section>
  );
}

export function ThreadTurnViewer({
  thread,
  historyState = "saved",
  onEditTeam,
  nextModel,
  blocks,
  workLog,
  checkpoints,
  onOpenTurnDiff,
  pendingApprovals,
  responseStyleProfile = STANDARD_RESPONSE_STYLE_UI_PROFILE,
}: ViewerProps) {
  const liveId = thread.session?.status === "running" ? thread.session.activeTurnId : null;
  const turnId = liveId ?? thread.latestTurn?.turnId;
  const turn = thread.latestTurn?.turnId === turnId ? thread.latestTurn : null;
  const state = liveId && !turn ? "running" : turn?.state;
  const awaitingFirstTurn = !turnId && thread.messages.length === 0;
  const entries = useMemo(() => {
    if (!turnId) return [];
    return workLog.filter((row) => row.turnId === turnId && !row.orchestraMessageId && !row.taskId);
  }, [turnId, workLog]);
  const files = useMemo(() => {
    const paths = new Set<string>();
    for (const checkpoint of checkpoints) {
      if (turnId && checkpoint.turnId === turnId && checkpoint.status === "ready")
        for (const file of checkpoint.files) paths.add(file.path);
    }
    return [...paths];
  }, [checkpoints, turnId]);
  const assignedModel = useMemo(() => {
    if (!turnId) return null;
    for (let i = thread.activities.length - 1; i >= 0; i--) {
      const event = thread.activities[i]!;
      if (event.turnId !== turnId || event.kind !== "conversation.turn-assigned") continue;
      if (!hasChildActivityScope(event.payload) && isModelSelection(event.payload))
        return event.payload;
    }
    return null;
  }, [thread.activities, turnId]);
  const reportedModels = useMemo(() => {
    const models = new Set<string>();
    for (const event of thread.activities) {
      if (!turnId || event.turnId !== turnId || event.kind !== "context-window.updated") continue;
      const data = event.payload;
      if (!record(data) || !Array.isArray(data.consumption) || hasChildActivityScope(data))
        continue;
      for (const observation of data.consumption) {
        // These adapters use native response model identifiers. Other adapters can attach
        // their requested model to accounting or leave the model unknown.
        if (
          record(observation) &&
          (observation.provider === "opencode" || observation.provider === "grok") &&
          typeof observation.model === "string" &&
          observation.model.trim()
        )
          models.add(observation.model);
      }
    }
    return [...models];
  }, [thread.activities, turnId]);
  const messages = useMemo(() => new Map(thread.messages.map((m) => [m.id, m])), [thread.messages]);
  const result = turnId
    ? thread.messages.findLast(
        (m) =>
          m.role === "assistant" &&
          !blocks.has(m.id) &&
          (m.turnId === turnId || m.id === turn?.assistantMessageId),
      )
    : undefined;
  const handoff = latestHandoffActivity(thread.activities);
  const assignments = [...blocks.values()].filter((block) => block.ownerThreadId === thread.id);
  return (
    <section
      aria-label="대화 뷰어"
      className="grid min-w-0 gap-3 overflow-x-hidden rounded-md border border-border/70 p-3 pr-4 text-xs [&_section]:min-w-0 [&_section]:break-words"
    >
      <h3 className="flex justify-between gap-2 text-sm font-semibold">
        최근 턴
        <span className="font-normal">
          {state
            ? turnStates[state]
            : historyState === "loading"
              ? "불러오는 중"
              : awaitingFirstTurn
                ? "첫 요청 대기"
                : "턴 기록 없음"}
        </span>
      </h3>
      {historyState === "draft" ? (
        <p className="text-muted-foreground">
          첫 요청을 보내기 전에 대화 상단에서 하위 모델 팀을 설정할 수 있습니다.
        </p>
      ) : historyState === "loading" ? (
        <p role="status" className="text-muted-foreground">
          저장된 대화 기록을 불러오는 중입니다.
        </p>
      ) : awaitingFirstTurn ? (
        <p className="text-muted-foreground">
          첫 요청을 보내면 실행 상태와 작업 기록이 여기에 표시됩니다.
        </p>
      ) : null}
      {turn && (
        <p className="flex flex-wrap gap-x-3 text-muted-foreground">
          <time dateTime={turn.requestedAt}>요청 {clock(turn.requestedAt)}</time>
          {turn.startedAt && <time dateTime={turn.startedAt}>시작 {clock(turn.startedAt)}</time>}
          {turn.completedAt && (
            <time dateTime={turn.completedAt}>종료 {clock(turn.completedAt)}</time>
          )}
        </p>
      )}
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words [&_dd]:min-w-0 [&_dd]:break-all [&_dt]:shrink-0">
        <dt>실행 모델</dt>
        <dd>{reportedModels.join(", ") || "제공자 보고 없음"}</dd>
        <dt>이번 요청에 지정한 모델</dt>
        <dd>
          {assignedModel
            ? `${assignedModel.instanceId} · ${assignedModel.model}`
            : "지정 기록 없음"}
        </dd>
        <dt>다음 턴 선택</dt>
        <dd>{nextModel ? `${nextModel.instanceId} · ${nextModel.model}` : "선택 확인 전"}</dd>
        <dt>현재 답변 스타일</dt>
        <dd>{responseStyleSettingLabel(responseStyleProfile)}</dd>
      </dl>
      <section aria-label="최근 대화 인계">
        <h4 className="font-medium">최근 대화 인계</h4>
        {handoff ? (
          <>
            <p>
              {clock(handoff.createdAt)} · {handoff.summary}
            </p>
            {handoff.delivery && <p>{handoffDeliveryText(handoff.delivery)}</p>}
            {handoff.prepared && (
              <p>
                이전 메시지 {handoff.prepared.sourceMessageCount}개 · 준비한 문맥{" "}
                {handoff.prepared.sentChars.toLocaleString()}자
              </p>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">
            {historyState === "loading"
              ? "인계 기록을 불러오는 중입니다."
              : "아직 표시할 인계 기록이 없습니다. 다른 모델로 대화를 이어갈 때 기록된 인계 내역이 여기에 표시됩니다."}
          </p>
        )}
      </section>
      {onEditTeam && (
        <button
          type="button"
          className="w-fit text-xs text-primary underline underline-offset-2"
          onClick={onEditTeam}
        >
          상단 하위 모델 편집
        </button>
      )}
      {pendingApprovals.length > 0 && (
        <section>
          <h4 className="font-medium">대화 승인 대기</h4>
          <ul>
            {pendingApprovals.map((a) => (
              <li key={a.requestId}>{a.detail || a.requestKind}</li>
            ))}
          </ul>
        </section>
      )}
      <WorkTimeline key={turnId ?? "empty"} entries={entries} />
      {files.length > 0 && (
        <details>
          <summary>이 턴의 변경 파일 {files.length}개</summary>
          <ul>
            {files.map((p) => (
              <li className="break-all font-mono" key={p}>
                {turnId && onOpenTurnDiff ? (
                  <button
                    type="button"
                    className="text-left underline"
                    onClick={() => onOpenTurnDiff(turnId, p)}
                  >
                    {p} · 차이 보기
                  </button>
                ) : (
                  p
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      <ResponseStyleResultSummary text={result?.text} variant={responseStyleProfile.variant} />
      {result?.text && (
        <details>
          <summary>{result.streaming ? "작성 중인 응답" : "응답 결과"}</summary>
          <p className="whitespace-pre-wrap break-words">{result.text}</p>
        </details>
      )}
      {assignments.length > 0 && (
        <section>
          <h4 className="font-medium">대화 작업 배정</h4>
          {assignments.map((block) => (
            <details key={block.messageId} className="mt-1 break-words">
              <summary>
                {block.displayName} · {orchestraKindLabels[block.kind]} ·{" "}
                {orchestraStatusLabels[block.status]}
              </summary>
              <p>
                배정 모델 · {block.modelSelection.instanceId} · {block.modelSelection.model}
              </p>
              {block.instruction && (
                <p className="whitespace-pre-wrap">지시 · {block.instruction}</p>
              )}
              {messages.get(block.messageId)?.text && (
                <p className="whitespace-pre-wrap">
                  작업 보고 · {messages.get(block.messageId)?.text}
                </p>
              )}
            </details>
          ))}
        </section>
      )}
    </section>
  );
}
