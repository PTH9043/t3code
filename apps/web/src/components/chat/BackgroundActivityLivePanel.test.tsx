import type { UnifiedBgTask } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { BackgroundActivityLivePanel } from "./BackgroundActivityLivePanel";

describe("BackgroundActivityLivePanel", () => {
  it("renders nothing when no background tasks, liveness, or monitors are active", () => {
    const html = renderToStaticMarkup(
      <BackgroundActivityLivePanel
        tasks={[]}
        liveness={null}
        monitorTitles={[]}
        nowMsOverride={1_700_000_050_000}
      />,
    );
    expect(html).toBe("");
  });

  it("starts collapsed by default so active background tasks do not auto-open", () => {
    const html = renderToStaticMarkup(
      <BackgroundActivityLivePanel
        tasks={[]}
        liveness="working"
        latestActivityLabel="Read file"
        monitorTitles={["task-217 (diagnose_oi_robustness.py)"]}
        nowMsOverride={1_700_000_050_000}
      />,
    );

    expect(html).toContain('data-bg-live-panel=""');
    expect(html).toContain("AI 백그라운드 작업 진행 중");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("상세");
    expect(html).not.toContain("최근 활동: Read file");
    expect(html).not.toContain("감시 대상:");
  });

  it("renders active background task title, elapsed time, and live log tail when expanded", () => {
    const task: UnifiedBgTask = {
      taskId: "stage1-calc",
      threadId: "thread-1",
      turnId: "turn-1",
      provider: "claudeAgent",
      title: "Stage 1 전수 계산",
      execType: "LOCAL_PID",
      proofHandle: "shell:stage1-calc",
      startedAtMs: 1_700_000_000_000,
      lastProgressAtMs: 1_700_000_045_000,
      logTail: "[Bash] Stage 1 420/1000 rows processed (3-track separation)",
      artifactCount: 3,
      watcherArmed: true,
      state: "RUNNING",
    };

    const html = renderToStaticMarkup(
      <BackgroundActivityLivePanel
        tasks={[task]}
        liveness="working"
        isWorking={false}
        onStopBackgroundWork={() => {}}
        defaultExpanded
        nowMsOverride={1_700_000_050_000}
      />,
    );

    expect(html).toContain('data-bg-live-panel=""');
    expect(html).toContain('data-bg-live-state="running"');
    expect(html).toContain("AI 백그라운드 작업 진행 중 (1건 · Claude 1)");
    expect(html).toContain("[Claude] Stage 1 전수 계산");
    expect(html).toContain("[Bash] Stage 1 420/1000 rows processed (3-track separation)");
    expect(html).toContain("00:50");
    expect(html).toContain("5초 전 갱신");
    expect(html).toContain("shell:stage1-calc");
    expect(html).toContain("완료 자동보고 연결됨");
    expect(html).toContain("중지");
  });

  it("highlights STALLED tasks clearly when no output has arrived for >= 60s", () => {
    const stalledTask: UnifiedBgTask = {
      taskId: "stage1-stalled",
      threadId: "thread-1",
      turnId: "turn-1",
      provider: "gemini",
      title: "데이터 감사 스크립트",
      execType: "LOCAL_PID",
      proofHandle: "shell:stage1-stalled",
      startedAtMs: 1_700_000_000_000,
      lastProgressAtMs: 1_700_000_010_000,
      watcherArmed: false,
      state: "STALLED",
    };

    const html = renderToStaticMarkup(
      <BackgroundActivityLivePanel
        tasks={[stalledTask]}
        liveness="working"
        defaultExpanded
        nowMsOverride={1_700_000_090_000}
      />,
    );

    expect(html).toContain('data-bg-live-state="stalled"');
    expect(html).toContain("지연 1건");
    expect(html).toContain("60초 이상 무출력 지연 (80초 경과)");
  });

  it("keeps the Stop button accessible even while a turn is working", () => {
    const html = renderToStaticMarkup(
      <BackgroundActivityLivePanel
        tasks={[]}
        liveness="working"
        isWorking={true}
        onStopBackgroundWork={() => {}}
        nowMsOverride={1_700_000_050_000}
      />,
    );

    expect(html).toContain("중지");
  });
});
