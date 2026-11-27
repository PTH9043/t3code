import {
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
  type UnifiedBgTask,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { RuntimeProofStrip } from "./RuntimeProofStrip";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

it("renders UNVERIFIED hallucination warning when text promises background completion but 0 real tasks exist", () => {
  const html = renderToStaticMarkup(
    <RuntimeProofStrip
      text="백그라운드 전수 촬영이 약 1분 안팎으로 끝나는 대로 자동 알림을 받아 보고드릴게요."
      turnId="turn-1"
      threadRef={threadRef}
      backgroundTasks={[]}
    />,
  );
  expect(html).toContain('data-runtime-proof-strip="unverified"');
  expect(html).toContain("미검증 경고");
  expect(html).toContain("실행 재요청");
});

it("renders verified ground-truth proof strip when real UnifiedBgTask is active", () => {
  const task: UnifiedBgTask = {
    taskId: "task-767",
    threadId: "thread-1",
    turnId: "turn-1",
    provider: "gemini",
    title: "T3 전수 촬영",
    execType: "LOCAL_PID",
    proofHandle: "PID 48291",
    startedAtMs: 1_700_000_000_000,
    lastProgressAtMs: 1_700_000_010_000,
    artifactCount: 18,
    watcherArmed: true,
    state: "RUNNING",
  };
  const html = renderToStaticMarkup(
    <RuntimeProofStrip
      text="백그라운드 전수 촬영이 약 1분 안팎으로 끝나는 대로 자동 알림을 받아 보고드릴게요."
      turnId="turn-1"
      threadRef={threadRef}
      backgroundTasks={[task]}
    />,
  );
  expect(html).toContain('data-runtime-proof-strip="verified"');
  expect(html).toContain("Gemini · PID 48291 가동 확인");
  expect(html).toContain("산출물 18개");
  expect(html).toContain("완료 자동보고 Hook 연결됨");
});

it("renders nothing for normal completed reports with no background tasks", () => {
  const html = renderToStaticMarkup(
    <RuntimeProofStrip
      text="모든 작업과 단위 테스트 검증을 완료했습니다."
      turnId="turn-2"
      threadRef={threadRef}
      backgroundTasks={[]}
    />,
  );
  expect(html).toBe("");
});

it("renders host PinnedSpec gate proofs (pass & self-approval blocked)", () => {
  const passedHtml = renderToStaticMarkup(
    <RuntimeProofStrip
      text="작업 완료"
      turnId="turn-3"
      threadRef={threadRef}
      backgroundTasks={[]}
      specProof={{
        specId: "spec-pr-101",
        outcome: "pass",
        checkerActorId: "agent-codex-checker",
        summary: "독립 검증자 승인 완료",
      }}
    />,
  );
  expect(passedHtml).toContain('data-spec-proof-strip="pass"');
  expect(passedHtml).toContain("[독립 검증 통과]");
  expect(passedHtml).toContain("spec-pr-101");

  const blockedHtml = renderToStaticMarkup(
    <RuntimeProofStrip
      text="작업 완료"
      turnId="turn-4"
      threadRef={threadRef}
      backgroundTasks={[]}
      specProof={{
        specId: "spec-pr-102",
        outcome: "refused_self_approval",
        summary: "생산자의 자기승인은 허용되지 않습니다.",
      }}
    />,
  );
  expect(blockedHtml).toContain('data-spec-proof-strip="refused_self_approval"');
  expect(blockedHtml).toContain("[자기승인 차단]");
});

it("flags executive wait-until-done promise when 0 tasks run and shows live progress detail when active", () => {
  const adviceText =
    "Stage 1 전수 계산이 끝날 때까지 추가 조작 없이 대기해 주시면 데이터 감사와 3트랙 분리력 결과를 한 번에 정리해 드릴게요.";
  const unverifiedHtml = renderToStaticMarkup(
    <RuntimeProofStrip
      text={adviceText}
      turnId="turn-stage1"
      threadRef={threadRef}
      backgroundTasks={[]}
    />,
  );
  expect(unverifiedHtml).toContain('data-runtime-proof-strip="unverified"');
  expect(unverifiedHtml).toContain("미검증 경고");

  const runningHtml = renderToStaticMarkup(
    <RuntimeProofStrip
      text={adviceText}
      turnId="turn-stage1"
      threadRef={threadRef}
      backgroundTasks={[
        {
          taskId: "stage1-job",
          threadId: "thread-1",
          turnId: "turn-stage1",
          provider: "claudeAgent",
          title: "Stage 1 전수 계산",
          execType: "LOCAL_PID",
          proofHandle: "shell:stage1-job",
          startedAtMs: 1_700_000_000_000,
          lastProgressAtMs: 1_700_000_020_000,
          logTail: "[Bash] Stage 1 320/1000 rows processed",
          watcherArmed: true,
          state: "RUNNING",
        },
      ]}
    />,
  );
  expect(runningHtml).toContain('data-runtime-proof-strip="verified"');
  expect(runningHtml).toContain('data-runtime-proof-detail=""');
  expect(runningHtml).toContain("Stage 1 전수 계산 — [Bash] Stage 1 320/1000 rows processed");
});

it("suppresses UNVERIFIED warning on historical turns, while background liveness is active, and on negated/user-prompt replies", () => {
  const promiseText =
    "백그라운드 전수 촬영이 약 1분 안팎으로 끝나는 대로 자동 알림을 받아 보고드릴게요.";

  // Historical turn whose background work already completed later
  expect(
    renderToStaticMarkup(
      <RuntimeProofStrip
        text={promiseText}
        turnId="turn-old"
        threadRef={threadRef}
        backgroundTasks={[]}
        isLatestAssistantAnswer={false}
      />,
    ),
  ).toBe("");

  // Active monitor/liveness suppresses unverified warning even when UnifiedBgTask array is empty
  expect(
    renderToStaticMarkup(
      <RuntimeProofStrip
        text={promiseText}
        turnId="turn-live"
        threadRef={threadRef}
        backgroundTasks={[]}
        isLatestAssistantAnswer={true}
        allowUnverifiedWarning={false}
      />,
    ),
  ).toBe("");

  // Explicit negation + user-input conditional reply must never trigger UNVERIFIED warning
  const negatedReply = [
    "## [보고]",
    "",
    "현재 별도로 돌리고 있는 백그라운드 작업이나 남은 도구 작업은 없습니다. (`[확인 완료]`) 다음 순서인 4순위 질문에 대한 대표님 답변을 기다리는 단계예요.",
    "",
    "편하신 대로 먼저 답변해 주시면 바로 2~3문장 카드로 정리해 드릴게요.",
  ].join("\n");
  expect(
    renderToStaticMarkup(
      <RuntimeProofStrip
        text={negatedReply}
        turnId="turn-negated"
        threadRef={threadRef}
        backgroundTasks={[]}
        isLatestAssistantAnswer={true}
        allowUnverifiedWarning={true}
      />,
    ),
  ).toBe("");
});
