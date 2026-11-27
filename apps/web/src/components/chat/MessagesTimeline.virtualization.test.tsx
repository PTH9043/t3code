import { CheckpointRef, EnvironmentId, MessageId, TurnId } from "@t3tools/contracts";
import type { OrchestraTaskList } from "@t3tools/client-runtime/state/presentation";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import {
  deriveMessagesTimelineRows,
  resolveTimelineIsAtEnd,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import type { TimelineEntry } from "../../session-logic";
import type { TurnDiffSummary } from "../../types";

interface CapturedLegendListProps {
  data: ReadonlyArray<MessagesTimelineRow>;
  keyExtractor: (item: MessagesTimelineRow, index: number) => string;
  getItemType?: (item: MessagesTimelineRow, index: number) => string;
  renderItem: (args: { item: MessagesTimelineRow; index: number }) => ReactNode;
  estimatedItemSize?: number;
  estimatedHeaderSize?: number;
  drawDistance?: number;
  initialScrollAtEnd?: boolean;
  maintainScrollAtEnd?: unknown;
  maintainVisibleContentPosition?: unknown;
  onScroll?: () => void;
  className?: string;
  ListHeaderComponent?: ReactNode;
  ListFooterComponent?: ReactNode;
  ref?: Ref<LegendListRef>;
}

let lastCapturedLegendListProps: CapturedLegendListProps | null = null;

vi.mock("@legendapp/list/react", () => {
  const LegendList = (props: CapturedLegendListProps) => {
    lastCapturedLegendListProps = props;
    // Render a virtualized slice at the bottom (initialScrollAtEnd) so 1,000+ rows
    // stress-test fast while still verifying live rendered output and header/footer.
    const visibleWindowCount = 24;
    const startIndex = Math.max(0, props.data.length - visibleWindowCount);
    const slice = props.data.slice(startIndex);
    return (
      <div
        data-testid="legend-list"
        data-row-count={props.data.length}
        data-estimated-item-size={props.estimatedItemSize}
        data-estimated-header-size={props.estimatedHeaderSize}
        data-draw-distance={props.drawDistance}
        data-initial-scroll-at-end={props.initialScrollAtEnd ? "true" : "false"}
        data-maintain-scroll-at-end={props.maintainScrollAtEnd ? "enabled" : "disabled"}
        data-class-name={props.className}
      >
        {props.ListHeaderComponent}
        {slice.map((item, offset) => (
          <div
            key={props.keyExtractor(item, startIndex + offset)}
            data-item-type={props.getItemType?.(item, startIndex + offset)}
          >
            {props.renderItem({ item, index: startIndex + offset })}
          </div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  };

  return { LegendList };
});

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: (props: { fileDiff: { name?: string | null } }) => (
    <div data-testid="file-diff">{props.fileDiff.name ?? "diff"}</div>
  ),
}));

let timelineModule: typeof import("./MessagesTimeline");

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    location: { href: "http://localhost/" },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
      offsetHeight: 0,
    },
  });

  timelineModule = await import("./MessagesTimeline");
}, 30_000);

const ENV_ID = EnvironmentId.make("environment-local");
const BASE_TS = Date.parse("2026-11-21T00:00:00.000Z");

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TS + offsetSeconds * 1000).toISOString();
}

function buildLongCodeAssistantText(turnIndex: number): string {
  const codeLines = Array.from(
    { length: 14 },
    (_, line) => `  const step_${turnIndex}_${line} = computeMetric(${line});`,
  ).join("\n");
  return [
    `## Turn ${turnIndex} 분석 결과`,
    "",
    `요청하신 모듈 ${turnIndex}번의 성능 병목을 진단하고 가상화 높이 추정을 보정했습니다.`,
    "",
    "```ts",
    `export function applyTurnFix${turnIndex}() {`,
    codeLines,
    "  return true;",
    "}",
    "```",
    "",
    "검증을 완료했습니다.",
  ].join("\n");
}

function build500TurnDataset(turnCount = 500): {
  entries: TimelineEntry[];
  rows: MessagesTimelineRow[];
  diffMap: Map<MessageId, TurnDiffSummary>;
} {
  const entries: TimelineEntry[] = [];
  const diffMap = new Map<MessageId, TurnDiffSummary>();

  for (let turn = 0; turn < turnCount; turn += 1) {
    const turnId = TurnId.make(`turn-${turn}`);
    const userId = MessageId.make(`user-${turn}`);
    const assistantId = MessageId.make(`assistant-${turn}`);
    const userAt = isoAt(turn * 10);
    const workAt = isoAt(turn * 10 + 2);
    const assistantAt = isoAt(turn * 10 + 5);

    const userText =
      turn % 5 === 0
        ? Array.from(
            { length: 10 },
            (_, line) => `Turn ${turn} 상세 요청 ${line + 1}: ${"컨텍스트 설명 ".repeat(6)}`,
          ).join("\n")
        : `Turn ${turn}: 메시지 타임라인 가상화 상태를 점검해 주세요.`;

    entries.push({
      id: `entry-user-${turn}`,
      kind: "message",
      createdAt: userAt,
      message: {
        id: userId,
        role: "user",
        text: userText,
        turnId: null,
        createdAt: userAt,
        updatedAt: userAt,
        streaming: false,
      },
    });

    if (turn % 2 === 0) {
      entries.push({
        id: `entry-work-${turn}`,
        kind: "work",
        createdAt: workAt,
        entry: {
          id: `work-${turn}`,
          createdAt: workAt,
          turnId,
          label: "Read file",
          detail: `apps/web/src/components/chat/MessagesTimeline.tsx (turn ${turn})`,
          tone: "tool",
          toolLifecycleStatus: "completed",
        },
      });
    }

    const assistantText =
      turn % 3 === 0
        ? buildLongCodeAssistantText(turn)
        : turn % 3 === 1
          ? `Turn ${turn} 수정 완료.\n\n변경 항목을 확인하고 회귀 테스트를 통과했습니다.`
          : `Turn ${turn} 확인했습니다.`;

    if (turn % 10 === 0) {
      diffMap.set(assistantId, {
        turnId,
        checkpointTurnCount: turn + 1,
        checkpointRef: CheckpointRef.make(`ckpt-${turn}`),
        status: "ready" as const,
        files: [
          {
            path: "apps/web/src/components/chat/MessagesTimeline.tsx",
            kind: "modified" as const,
            additions: 12,
            deletions: 3,
          },
          {
            path: "apps/web/src/components/chat/MessagesTimeline.test.tsx",
            kind: "modified" as const,
            additions: 8,
            deletions: 1,
          },
        ],
        assistantMessageId: assistantId,
        completedAt: assistantAt,
      });
    }

    entries.push({
      id: `entry-assistant-${turn}`,
      kind: "message",
      createdAt: assistantAt,
      message: {
        id: assistantId,
        role: "assistant",
        text: assistantText,
        turnId,
        createdAt: assistantAt,
        updatedAt: assistantAt,
        streaming: false,
      },
    });
  }

  const rows = deriveMessagesTimelineRows({
    timelineEntries: entries,
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaryByAssistantMessageId: diffMap,
    revertTurnCountByUserMessageId: new Map(),
  });

  return { entries, rows, diffMap };
}

function makeMessageRow(overrides: {
  id?: string;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: Array<{
    type: "image" | "file";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    previewUrl?: string;
  }>;
  showAssistantMeta?: boolean;
  changedFilesCount?: number;
}): Extract<MessagesTimelineRow, { kind: "message" }> {
  const messageId = MessageId.make(overrides.id ?? "msg-1");
  const turnId = TurnId.make("turn-1");
  return {
    kind: "message",
    id: `row-${messageId}`,
    createdAt: isoAt(0),
    durationStart: isoAt(0),
    showAssistantMeta: overrides.showAssistantMeta ?? overrides.role === "assistant",
    showAssistantCopyButton: overrides.role === "assistant",
    assistantCopyStreaming: false,
    assistantTurnDiffSummary:
      overrides.changedFilesCount && overrides.changedFilesCount > 0
        ? {
            turnId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ckpt-1"),
            status: "ready",
            files: Array.from({ length: overrides.changedFilesCount }, (_, index) => ({
              path: `src/file-${index}.ts`,
              kind: "modified" as const,
              additions: 5,
              deletions: 2,
            })),
            assistantMessageId: messageId,
            completedAt: isoAt(1),
          }
        : undefined,
    message: {
      id: messageId,
      role: overrides.role,
      text: overrides.text,
      turnId: overrides.role === "assistant" ? turnId : null,
      createdAt: isoAt(0),
      updatedAt: isoAt(1),
      streaming: false,
      attachments: overrides.attachments as never,
    },
  };
}

function buildBaseTimelineProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    latestTurn: null,
    runningTurnId: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-500",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENV_ID,
    markdownCwd: undefined,
    resolvedTheme: "dark" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    contentInsetEndAdjustment: 120,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

describe("estimateTimelineRowHeight (ERR-07)", () => {
  it("is deterministic and bounded with no NaN, 0, or runaway values across all row kinds", () => {
    const {
      estimateTimelineRowHeight,
      TIMELINE_MIN_ESTIMATED_ROW_HEIGHT,
      TIMELINE_MAX_ESTIMATED_ROW_HEIGHT,
    } = timelineModule;

    const orchestraList: OrchestraTaskList = {
      id: "run-1",
      createdAt: isoAt(0),
      run: null,
      tasks: Array.from({ length: 12 }, (_, idx) => ({
        id: `task-${idx}`,
        title: `Task ${idx}`,
        displayName: `Agent ${idx}`,
        role: "implementer",
        kind: "implementation",
        status: idx === 0 ? "running" : "completed",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        attempts: [
          {
            attempt: 1,
            executionId: `exec-${idx}`,
            messageId: MessageId.make(`orch-msg-${idx}`),
            status: idx === 0 ? "running" : "completed",
            text: "작업 결과 요약\n".repeat(30),
            streaming: idx === 0,
            isSummary: false,
            createdAt: isoAt(idx),
            updatedAt: isoAt(idx + 1),
          },
        ],
      })),
    } as unknown as OrchestraTaskList;

    const extremeRows: MessagesTimelineRow[] = [
      { kind: "working", id: "w", createdAt: isoAt(0) },
      {
        kind: "turn-fold",
        id: "tf",
        createdAt: isoAt(0),
        turnId: TurnId.make("t1"),
        label: "3초 동안 작업함",
        expanded: false,
      },
      {
        kind: "work-toggle",
        id: "wt",
        createdAt: isoAt(0),
        groupId: "g1",
        hiddenCount: 15,
        expanded: false,
        onlyToolEntries: true,
      },
      {
        kind: "turn-plan",
        id: "tp",
        createdAt: isoAt(0),
        turnPlan: {
          id: "tp-1",
          turnId: TurnId.make("t1"),
          createdAt: isoAt(0),
          plan: {
            turnId: TurnId.make("t1"),
            createdAt: isoAt(0),
            steps: Array.from({ length: 40 }, (_, i) => ({
              step: `Step ${i}`,
              status: "pending" as const,
            })),
          },
        },
      },
      {
        kind: "work",
        id: "work-huge",
        createdAt: isoAt(0),
        groupedEntries: Array.from({ length: 50 }, (_, i) => ({
          id: `we-${i}`,
          createdAt: isoAt(i),
          label: "Ran command",
          detail: "x".repeat(300),
          tone: "tool" as const,
        })),
      },
      {
        kind: "proposed-plan",
        id: "pp-huge",
        createdAt: isoAt(0),
        proposedPlan: {
          id: "plan-1" as never,
          turnId: TurnId.make("t1"),
          planMarkdown: "# Plan\n" + "- item line\n".repeat(400),
          implementedAt: null,
          implementationThreadId: null,
          createdAt: isoAt(0),
          updatedAt: isoAt(0),
        },
      },
      { kind: "orchestra", id: "orch-huge", createdAt: isoAt(0), list: orchestraList },
      makeMessageRow({ role: "user", text: "" }),
      makeMessageRow({ role: "user", text: "A".repeat(120_000) }),
      makeMessageRow({ role: "assistant", text: "" }),
      makeMessageRow({
        role: "assistant",
        text: "```ts\n" + "const a = 1;\n".repeat(5_000) + "```",
        changedFilesCount: 40,
      }),
    ];

    for (const row of extremeRows) {
      const first = estimateTimelineRowHeight(row);
      const second = estimateTimelineRowHeight(row);
      expect(first).toBe(second);
      expect(Number.isFinite(first)).toBe(true);
      expect(Number.isInteger(first)).toBe(true);
      expect(first).toBeGreaterThanOrEqual(TIMELINE_MIN_ESTIMATED_ROW_HEIGHT);
      expect(first).toBeLessThanOrEqual(TIMELINE_MAX_ESTIMATED_ROW_HEIGHT);
    }
  });

  it("scales monotonically with text length, code blocks, attachments, diffs, work group size, and orchestra blocks", () => {
    const { estimateTimelineRowHeight } = timelineModule;

    // User messages: short < medium < collapsed long < long + attachments
    const shortUser = makeMessageRow({ role: "user", text: "짧은 질문" });
    const mediumUser = makeMessageRow({ role: "user", text: "중간 길이 질문입니다.\n".repeat(5) });
    const longUser = makeMessageRow({
      role: "user",
      text: "매우 긴 사용자 프롬프트 내용입니다.\n".repeat(15),
    });
    const longUserWithImages = makeMessageRow({
      role: "user",
      text: "매우 긴 사용자 프롬프트 내용입니다.\n".repeat(15),
      attachments: [
        { type: "image", id: "img-1", name: "a.png", mimeType: "image/png", sizeBytes: 1024 },
        { type: "image", id: "img-2", name: "b.png", mimeType: "image/png", sizeBytes: 1024 },
        { type: "file", id: "file-1", name: "spec.md", mimeType: "text/markdown", sizeBytes: 2048 },
      ],
    });
    expect(estimateTimelineRowHeight(shortUser)).toBeLessThan(
      estimateTimelineRowHeight(mediumUser),
    );
    expect(estimateTimelineRowHeight(mediumUser)).toBeLessThan(estimateTimelineRowHeight(longUser));
    expect(estimateTimelineRowHeight(longUser)).toBeLessThan(
      estimateTimelineRowHeight(longUserWithImages),
    );

    // Assistant messages: short < medium < code block < code block + diffs < + orchestra block
    const shortAssistant = makeMessageRow({ role: "assistant", text: "확인했습니다." });
    const mediumAssistant = makeMessageRow({
      role: "assistant",
      text: "설명 문장입니다.\n\n".repeat(5),
    });
    const codeAssistant = makeMessageRow({
      role: "assistant",
      text: buildLongCodeAssistantText(1),
    });
    const codeAssistantWithDiffs = makeMessageRow({
      role: "assistant",
      text: buildLongCodeAssistantText(1),
      changedFilesCount: 4,
    });
    expect(estimateTimelineRowHeight(shortAssistant)).toBeLessThan(
      estimateTimelineRowHeight(mediumAssistant),
    );
    expect(estimateTimelineRowHeight(mediumAssistant)).toBeLessThan(
      estimateTimelineRowHeight(codeAssistant),
    );
    expect(estimateTimelineRowHeight(codeAssistant)).toBeLessThan(
      estimateTimelineRowHeight(codeAssistantWithDiffs),
    );
    expect(estimateTimelineRowHeight(codeAssistant)).toBeLessThan(
      estimateTimelineRowHeight(codeAssistant, { hasOrchestraBlock: true }),
    );

    // Work groups: 1 entry < 4 entries
    const smallWork: MessagesTimelineRow = {
      kind: "work",
      id: "w-1",
      createdAt: isoAt(0),
      groupedEntries: [{ id: "e-1", createdAt: isoAt(0), label: "Read file", tone: "tool" }],
    };
    const largerWork: MessagesTimelineRow = {
      kind: "work",
      id: "w-4",
      createdAt: isoAt(0),
      groupedEntries: Array.from({ length: 4 }, (_, i) => ({
        id: `e-${i}`,
        createdAt: isoAt(i),
        label: "Ran command",
        tone: "tool" as const,
      })),
    };
    expect(estimateTimelineRowHeight(smallWork)).toBeLessThan(
      estimateTimelineRowHeight(largerWork),
    );
  });

  it("buckets variable-height assistant rows into distinct LegendList item types", () => {
    const { getTimelineRowItemType } = timelineModule;
    const shortType = getTimelineRowItemType(makeMessageRow({ role: "assistant", text: "OK" }));
    const longCodeType = getTimelineRowItemType(
      makeMessageRow({
        role: "assistant",
        text: buildLongCodeAssistantText(7),
        changedFilesCount: 3,
      }),
    );
    const orchestraBlockType = getTimelineRowItemType(
      makeMessageRow({ role: "assistant", text: buildLongCodeAssistantText(7) }),
      { hasOrchestraBlock: true },
    );

    expect(shortType).not.toBe(longCodeType);
    expect(orchestraBlockType).toContain("message:assistant:orchestra-block:");
  });
});

describe("MessagesTimeline 500-turn virtualization stress & scroll safety (ERR-07, ERR-34)", () => {
  it("renders a 500-turn (1,000+ row) dataset with dynamic estimation, elevated drawDistance, and zero empty/loading lockups", () => {
    const {
      MessagesTimeline,
      estimateTimelineRowHeight,
      estimateTimelineAverageRowHeight,
      TIMELINE_DRAW_DISTANCE,
    } = timelineModule;
    const { entries, rows, diffMap } = build500TurnDataset(500);

    // 500 user + 500 assistant + 250 turn-folds = 1,250 rows (> 1,000 rows).
    expect(rows.length).toBeGreaterThanOrEqual(1000);

    // Confirm estimator outperforms fixed 90px baseline on 500-turn mixed dataset.
    const estimatedTotalHeight = rows.reduce((sum, row) => sum + estimateTimelineRowHeight(row), 0);
    const fixed90TotalHeight = rows.length * 90;
    const averageEstimate = estimateTimelineAverageRowHeight(rows);
    expect(averageEstimate).toBeGreaterThan(90);
    expect(estimatedTotalHeight).toBeGreaterThan(fixed90TotalHeight * 1.4);

    // Measure render time & output for 500 turns even when hideEmptyPlaceholder=true
    // (which ChatView passes while background thread detail sync is in flight).
    const startedAt = performance.now();
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildBaseTimelineProps()}
        timelineEntries={entries}
        turnDiffSummaryByAssistantMessageId={diffMap}
        hideEmptyPlaceholder
      />,
    );
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(5_000);
    expect(markup).toContain('data-testid="legend-list"');
    expect(markup).toContain(`data-row-count="${rows.length}"`);
    expect(markup).toContain(`data-draw-distance="${TIMELINE_DRAW_DISTANCE}"`);
    expect(TIMELINE_DRAW_DISTANCE).toBeGreaterThanOrEqual(1200);
    expect(TIMELINE_DRAW_DISTANCE).toBeLessThanOrEqual(1600);
    expect(markup).toContain(`data-estimated-item-size="${averageEstimate}"`);
    expect(markup).toContain('data-initial-scroll-at-end="true"');
    expect(markup).not.toContain("Loading messages...");
    expect(markup).not.toContain("메시지를 보내 대화를 시작하세요.");
    expect(markup).toContain("Turn 499");

    // Verify scroll-padding-top is enforced on the scroll container (ERR-34).
    expect(markup).toContain("scroll-pt-4");
  });

  it("synchronizes scroll-padding-top and estimatedHeaderSize when topFadeEnabled is active (ERR-34)", () => {
    const { MessagesTimeline } = timelineModule;
    const { entries } = build500TurnDataset(12);

    const compactMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildBaseTimelineProps()}
        timelineEntries={entries}
        topFadeEnabled={false}
      />,
    );
    const fadedMarkup = renderToStaticMarkup(
      <MessagesTimeline {...buildBaseTimelineProps()} timelineEntries={entries} topFadeEnabled />,
    );

    expect(compactMarkup).toContain("scroll-pt-4");
    expect(compactMarkup).toContain('data-estimated-header-size="16"');
    expect(fadedMarkup).toContain("scroll-pt-10 sm:scroll-pt-12");
    expect(fadedMarkup).toContain("chat-timeline-scroll-fade");
    expect(fadedMarkup).toContain('data-estimated-header-size="48"');
  });

  it("disables maintainScrollAtEnd while loadEarlier is loading during reverse scroll and never blanks out rows", () => {
    const { MessagesTimeline } = timelineModule;
    const { entries, rows } = build500TurnDataset(500);

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildBaseTimelineProps()}
        timelineEntries={entries}
        topFadeEnabled
        loadEarlier={{ loading: true, onLoadEarlier: () => {} }}
      />,
    );

    expect(markup).toContain(`data-row-count="${rows.length}"`);
    expect(markup).toContain('data-maintain-scroll-at-end="disabled"');
    expect(markup).toContain('data-estimated-header-size="84"');
    expect(markup).toContain("이전 작업 불러오는 중…");
    expect(markup).not.toContain("Loading messages...");
  });

  it("maintains continuous non-empty viewport coverage across full reverse scroll over 500 turns", () => {
    const { MessagesTimeline, estimateTimelineRowHeight, TIMELINE_DRAW_DISTANCE } = timelineModule;
    const { entries, rows } = build500TurnDataset(500);

    renderToStaticMarkup(
      <MessagesTimeline {...buildBaseTimelineProps()} timelineEntries={entries} topFadeEnabled />,
    );
    expect(lastCapturedLegendListProps).not.toBeNull();
    const captured = lastCapturedLegendListProps!;
    expect(captured.data.length).toBe(rows.length);

    // Build cumulative positions from estimateTimelineRowHeight and simulate
    // reverse scrolling from bottom -> 75% -> 50% -> 25% -> 0 (top) -> bottom.
    const heights = captured.data.map((row) => estimateTimelineRowHeight(row));
    const offsets: number[] = [];
    let cursor = 48; // topFadeEnabled header height
    for (const h of heights) {
      offsets.push(cursor);
      cursor += h;
    }
    const contentLength = cursor + 16; // footer
    const viewportHeight = 800;
    const reverseOverscanTop = TIMELINE_DRAW_DISTANCE * 1.5;
    const reverseOverscanBottom = TIMELINE_DRAW_DISTANCE * 0.5;
    const maxScroll = Math.max(0, contentLength - viewportHeight);

    const checkpoints = [
      maxScroll,
      maxScroll * 0.75,
      maxScroll * 0.5,
      maxScroll * 0.25,
      0,
      maxScroll,
    ];
    for (const scrollTop of checkpoints) {
      const windowTop = Math.max(0, scrollTop - reverseOverscanTop);
      const windowBottom = scrollTop + viewportHeight + reverseOverscanBottom;
      let visibleCount = 0;
      let bufferedCount = 0;

      for (let i = 0; i < heights.length; i += 1) {
        const rowTop = offsets[i]!;
        const rowBottom = rowTop + heights[i]!;
        if (rowBottom > scrollTop && rowTop < scrollTop + viewportHeight) {
          visibleCount += 1;
        }
        if (rowBottom > windowTop && rowTop < windowBottom) {
          bufferedCount += 1;
        }
      }

      // Every reverse-scroll position must render live visible rows and pre-buffered neighbors.
      expect(visibleCount).toBeGreaterThan(0);
      expect(bufferedCount).toBeGreaterThan(visibleCount);

      // Verify end-detection accuracy at bottom vs scrolled-up checkpoints.
      const isAtEnd = resolveTimelineIsAtEnd(
        {
          isAtEnd: scrollTop >= maxScroll - 1,
          contentLength,
          scroll: scrollTop,
          scrollLength: viewportHeight,
        },
        0,
      );
      expect(isAtEnd).toBe(scrollTop === maxScroll);
    }

    // Confirm bucketed item types are assigned across all 1,000+ rows.
    const itemTypes = new Set(
      captured.data.map((row, index) => captured.getItemType?.(row, index) ?? ""),
    );
    expect(itemTypes.size).toBeGreaterThanOrEqual(4);
  });
});
