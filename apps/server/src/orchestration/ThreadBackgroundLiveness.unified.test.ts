import {
  BG_TASK_STALLED_THRESHOLD_MS,
  detectDeferredBackgroundClaim,
  rollupBackgroundTasks,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { make } from "./ThreadBackgroundLiveness.ts";

it("tracks multi-model UnifiedBgTasks, detects 60s STALLED state, and clears on terminal status", () => {
  const service = make();
  const t0 = 1_700_000_000_000;

  service.recordTaskLiveness({
    threadId: "thread-1",
    taskId: "task-767",
    taskType: "local_bash",
    status: "running",
    kind: "started",
    provider: "gemini",
    turnId: "turn-1",
    title: "T3 전수 촬영",
    proofHandle: "PID 48291",
    logTail: "S07_light.png 저장 완료",
    artifactCount: 18,
    watcherArmed: true,
    nowMs: t0,
  });
  service.recordTaskLiveness({
    threadId: "thread-1",
    taskId: "resp_91f",
    taskType: "agent",
    status: "in_progress",
    kind: "started",
    provider: "codex",
    turnId: "turn-2",
    title: "multiServer 통합 검증",
    proofHandle: "resp_91f#142",
    nowMs: t0 + 5_000,
  });

  const live = service.getThreadBackgroundTasks("thread-1", t0 + 10_000);
  expect(live).toHaveLength(2);
  expect(live.map((t) => t.state)).toEqual(["RUNNING", "RUNNING"]);
  expect(live[1]?.execType).toBe("REMOTE_JOB");

  const rollup = rollupBackgroundTasks(live);
  expect(rollup.totalActive).toBe(2);
  expect(rollup.worstState).toBe("RUNNING");
  expect(rollup.byProvider.map((p) => `${p.shortCode}:${p.count}`)).toEqual(["G:1", "Cx:1"]);

  // After 65s without progress on task-767, it becomes STALLED while resp_91f is still RUNNING at 60s?
  const later = service.getThreadBackgroundTasks(
    "thread-1",
    t0 + BG_TASK_STALLED_THRESHOLD_MS + 2_000,
  );
  expect(later.find((t) => t.taskId === "task-767")?.state).toBe("STALLED");
  expect(later.find((t) => t.taskId === "resp_91f")?.state).toBe("RUNNING");
  expect(rollupBackgroundTasks(later).worstState).toBe("STALLED");

  // Completing task-767 removes it
  service.recordTaskLiveness({
    threadId: "thread-1",
    taskId: "task-767",
    taskType: "local_bash",
    status: "completed",
    kind: "completed",
    nowMs: t0 + 70_000,
  });
  expect(service.getThreadBackgroundTasks("thread-1", t0 + 70_000)).toHaveLength(1);
});

it("detects deferred background promises for UNVERIFIED hallucination checks without false positives", () => {
  expect(
    detectDeferredBackgroundClaim(
      "백그라운드 전수 촬영이 약 1분 안팎으로 끝나는 대로 자동 알림을 받아 보고드릴게요.",
    ),
  ).toBe(true);
  expect(
    detectDeferredBackgroundClaim(
      "마지막 5장만 다시 찍어 갤러리까지 묶는 중이에요. 약 10~15초 안에 끝나는 대로 최종 완료 보고를 올려드릴게요.",
    ),
  ).toBe(true);
  expect(
    detectDeferredBackgroundClaim("모든 테스트 94개가 통과했고 변경 파일 검증을 마쳤습니다."),
  ).toBe(false);
  expect(
    detectDeferredBackgroundClaim(
      "현재 별도로 돌리고 있는 백그라운드 작업이나 남은 도구 작업은 없습니다. (`[확인 완료]`)\n\n편하신 대로 먼저 답변해 주시면 바로 2~3문장 카드로 정리해 드릴게요.",
    ),
  ).toBe(false);
  expect(
    detectDeferredBackgroundClaim(
      "<details>\n`shared_ptr`을 함께 캡처해 콜백이 끝날 때까지 세션 수명이 유지되도록 고쳤습니다.\n</details>\n3순위 마무리 카드 2장으로 정리해 드릴게요.",
    ),
  ).toBe(false);
  expect(
    detectDeferredBackgroundClaim(
      "최신 신버전 전수 재촬영 백그라운드 진행 현황을 함께 보고드릴게요.",
    ),
  ).toBe(false);
});
