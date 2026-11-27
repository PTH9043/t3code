import { EnvironmentId, MessageId, TurnId } from "@t3tools/contracts";
import { deriveResponseStyleUiProfile } from "@t3tools/client-runtime/state/response-style-presentation";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: Array<{ id: string }>;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    className?: string;
  }) => (
    <div data-testid="legend-list" data-class-name={props.className}>
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={item.id}>{props.renderItem({ item })}</div>
      ))}
    </div>
  ),
}));

// The real button keeps its text in a click handler; expose it to the markup.
vi.mock("./MessageCopyButton", () => ({
  MessageCopyButton: (props: { text: string }) => <button data-copy-text={props.text} />,
}));

let MessagesTimeline: typeof import("./MessagesTimeline").MessagesTimeline;

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

  ({ MessagesTimeline } = await import("./MessagesTimeline"));
}, 30_000);

const CREATED_AT = "2026-03-17T19:12:28.000Z";
const turnId = TurnId.make("turn-1");
const answer = [
  "## [보고]",
  "매출은 늘었습니다. [확인 완료]",
  "",
  "## [비서실장의 조언]",
  "계약부터 검토하십시오.",
  "",
].join("\n");
const executive = deriveResponseStyleUiProfile(
  {
    style: {
      preset: "professional",
      tone: "",
      length: "",
      explanation: "",
      instructions: "최고 비서실장으로서 보고하세요.",
    },
  },
  "global",
);

function render(props: Partial<Parameters<typeof MessagesTimeline>[0]> = {}) {
  return renderToStaticMarkup(
    <MessagesTimeline
      isWorking={false}
      activeTurnInProgress={false}
      activeTurnStartedAt={null}
      listRef={createRef<LegendListRef | null>()}
      latestTurn={{ turnId, state: "completed", startedAt: CREATED_AT, completedAt: CREATED_AT }}
      runningTurnId={null}
      turnDiffSummaryByAssistantMessageId={new Map()}
      routeThreadKey="environment-local:thread-1"
      onOpenTurnDiff={() => {}}
      revertTurnCountByUserMessageId={new Map()}
      onRevertUserMessage={() => {}}
      isRevertingCheckpoint={false}
      onImageExpand={() => {}}
      activeThreadEnvironmentId={EnvironmentId.make("environment-local")}
      markdownCwd={undefined}
      resolvedTheme="light"
      timestampFormat="locale"
      workspaceRoot={undefined}
      anchorMessageId={null}
      onAnchorReady={() => {}}
      contentInsetEndAdjustment={0}
      liveFollowEnabled
      onIsAtEndChange={() => {}}
      onManualNavigation={() => {}}
      timelineEntries={[
        {
          id: "entry-answer",
          kind: "message",
          createdAt: CREATED_AT,
          message: {
            id: MessageId.make("message-answer"),
            role: "assistant",
            text: answer,
            turnId,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
            streaming: false,
          },
        },
      ]}
      {...props}
    />,
  );
}
// `answer` has no character that HTML escapes, so the attribute holds it verbatim.
const copyText = (markup: string) => /data-copy-text="([^"]*)"/.exec(markup)?.[1];

describe("MessagesTimeline response style", () => {
  it("splits an executive answer into report and advice callout", () => {
    const markup = render({ responseStyleProfile: executive });
    expect(markup.match(/data-response-style-advice/g)).toHaveLength(1);
    expect(markup).toContain(">비서실장의 조언</p>");
    expect(markup).toContain("계약부터 검토하십시오.");
    expect(markup).toContain('data-markdown-copy="[확인 완료]"');
    expect(markup).not.toContain("[비서실장의 조언]</h2>");
  });

  it("copies the original message text whatever the style shows", () => {
    const styled = copyText(render({ responseStyleProfile: executive }));
    expect(styled).toBe(answer);
    expect(copyText(render())).toBe(answer);
  });

  it("renders the same message the standard way once the style is back to default", () => {
    const standard = render();
    expect(standard).not.toContain("data-response-style-advice");
    expect(standard).not.toContain("data-fact-status");
    expect(standard).toContain("[비서실장의 조언]</h2>");
    expect(standard).toContain("[보고]</h2>");
    expect(standard).toContain("[확인 완료]");
    const afterReset = render({
      responseStyleProfile: deriveResponseStyleUiProfile({ style: null }, "global"),
    });
    expect(afterReset).toBe(standard);
  });
});

describe("MessagesTimeline column width", () => {
  it("lets the message column follow the pane instead of a fixed width", () => {
    const markup = render({ loadEarlier: { loading: false, onLoadEarlier: () => {} } });
    const row = /<div class="([^"]*)" data-timeline-root="true">/.exec(markup)?.[1];
    expect(row).toBe("mx-auto w-full min-w-0 overflow-x-clip");
    expect(markup).not.toContain("max-w-3xl");
    expect(markup).not.toContain("max-w-[960px]");
    const list = /data-class-name="([^"]*)"/.exec(markup)?.[1] ?? "";
    expect(list).toContain("chat-timeline-horizontal-inset");
    expect(list).toContain("px-3");
    expect(list).toContain("sm:px-[max(1.25rem,min(3rem,(100%-54rem+1px)*9999))]");
    expect(list).not.toContain("sm:px-5");
  });

  it("disables persistent minimap gutter when custom inset is narrower than 48px", async () => {
    const { resolveTimelineMinimapHasPersistentGutter, resolveTimelineMinimapHitStripWidth } =
      await import("./MessagesTimeline.logic");
    expect(resolveTimelineMinimapHasPersistentGutter(1200, null)).toBe(true);
    expect(resolveTimelineMinimapHasPersistentGutter(1200, 12)).toBe(false);
    expect(resolveTimelineMinimapHitStripWidth(1200, 12)).toBe(0);
    expect(resolveTimelineMinimapHasPersistentGutter(1200, 48)).toBe(true);
    expect(resolveTimelineMinimapHitStripWidth(1200, 48)).toBe(36);
    expect(resolveTimelineMinimapHasPersistentGutter(500, 96)).toBe(false);
  });
});
