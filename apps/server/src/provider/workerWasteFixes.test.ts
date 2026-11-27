// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { ProviderDriverKind, ProviderInstanceId, type ModelTargetRef } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { resolveDynamicCouncilRoster } from "../orchestration/council/DynamicCouncilRoster.ts";
import {
  clearUnavailableModelCooldownsForTest,
  formatBillingErrorMessage,
  getUnavailableModelReason,
  isAntseedPeerUnavailableError,
  isNonRetryableBillingError,
  probeModelAvailabilityBeforeDispatch,
  recordUnavailableModelFromError,
} from "./workerFailurePolicy.ts";
import {
  WorkerEngineService,
  makeWorkerEngineServiceLayer,
  type WorkerExecutionRunner,
} from "../t3x/workerEngine/WorkerEngineService.ts";
import { WorkerEngineError } from "../t3x/workerEngine/WorkerEngineStore.ts";

function makeTarget(instanceId: string, driverId: string, modelId: string): ModelTargetRef {
  return {
    providerInstanceId: ProviderInstanceId.make(instanceId),
    driverId: ProviderDriverKind.make(driverId),
    modelId,
    displayName: `${instanceId} · ${modelId}`,
  };
}

function buildEngineLayer(runner: WorkerExecutionRunner) {
  return makeWorkerEngineServiceLayer({
    runner,
    heartbeat: {
      startBackgroundFiber: false,
      dbDebounceMs: 1_000,
    },
    reconcileOnBoot: false,
  }).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provide(NodeServices.layer));
}

afterEach(() => {
  clearUnavailableModelCooldownsForTest();
});

describe("3부 작업자 낭비 5종 수정 검증", () => {
  it("1) 시간 초과 실패: 스트리밍 활동 연장 후 시간 초과 시 Interrupted가 아니라 failed + 부분 출력 보존", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const neverDone = yield* Deferred.make<void>();
      let capturePartial: ((text: string) => void) | undefined;
      let captureActivity: ((summary?: string | null) => Effect.Effect<void>) | undefined;

      const engineLayer = buildEngineLayer((req) =>
        Effect.gen(function* () {
          capturePartial = req.onPartialOutput;
          captureActivity = req.onActivity;
          req.onPartialOutput?.("부분 분석 결과 1단계: 병목 원인 식별 완료");
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(neverDone);
          return { resultText: "unreachable", exitCode: 0 };
        }),
      );

      yield* Effect.gen(function* () {
        const engine = yield* WorkerEngineService;
        const receipt = yield* engine.dispatch({
          runId: "run_timeout_test",
          threadId: "thread_timeout_test",
          role: "scout",
          targetInstanceId: "grok",
          targetModel: "grok-4.7",
          specText: "5분 시간 초과 + 스트리밍 활동 연장 검증",
          cwd: process.cwd(),
          worktreeMode: "current",
          maxWallTimeMs: 10_000,
          heartbeatTimeoutMs: 300_000,
          maxIdleMs: 900_000,
        });

        yield* Deferred.await(started);

        // 8초 시점에 스트리밍 활동과 추가 부분 출력 전달 -> 10초 시점에 끊기지 않고 연장돼야 함
        yield* TestClock.adjust("8 seconds");
        capturePartial?.(
          "부분 분석 결과 1단계: 병목 원인 식별 완료\n부분 분석 결과 2단계: 패치 초안 작성",
        );
        yield* captureActivity!("응답 생성 중");
        yield* TestClock.adjust("2 seconds");
        const sweep1 = yield* engine.sweepHeartbeatsOnce();
        expect(sweep1.aborted).toEqual([]);

        // 활동 없이 절대 상한(10초 + 최대 10초 연장 = 20초) 경과 -> 시간 초과 실패로 종료 + 부분 출력 보존
        yield* TestClock.adjust("15 seconds");
        const sweep2 = yield* engine.sweepHeartbeatsOnce();
        expect(sweep2.aborted).toContain(receipt.dispatchId);

        const settled = yield* engine.getDispatch(receipt.dispatchId);
        expect(settled?.status).toBe("failed");
        expect(settled?.errorMessage).toContain("시간 초과 실패");
        expect(settled?.resultText).toContain("부분 분석 결과 2단계");
      }).pipe(Effect.provide(engineLayer));
    }));

  it("2) 가려진 실패: runAndCollect 실패 시 executeWorker 스팬과 작업 상태도 Failure로 일치", () =>
    Effect.gen(function* () {
      const spanOutcomes: Array<{ readonly name: string; readonly failed: boolean }> = [];
      const recordingTracer = Tracer.make({
        span: (options) =>
          ({
            _tag: "Span",
            name: options.name,
            spanId: `span_${spanOutcomes.length}`,
            traceId: "trace_test",
            parent: options.parent,
            annotations: options.annotations,
            status: { _tag: "Started", startTime: options.startTime },
            attributes: new Map<string, unknown>(),
            links: options.links,
            sampled: true,
            kind: options.kind,
            end: (_endTime: bigint, exit: Exit.Exit<unknown, unknown>) => {
              spanOutcomes.push({ name: options.name, failed: Exit.isFailure(exit) });
            },
            attribute: () => undefined,
            event: () => undefined,
            addLinks: () => undefined,
          }) as unknown as Tracer.Span,
        context: ((f: () => unknown) => f()) as unknown as Tracer.Tracer["context"],
      });

      const engineLayer = buildEngineLayer(() =>
        Effect.fail(
          new WorkerEngineError({
            code: "invalid_state",
            message: "No policy-allowed peer currently serves model deepseek-v4.1-flash-1017",
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const engine = yield* WorkerEngineService;
        const exit = yield* Effect.exit(
          engine.runAndCollect({
            runId: "run_masked_fail",
            threadId: "thread_masked_fail",
            role: "reviewer",
            targetInstanceId: "antseed_local",
            targetModel: "t3_antseed/deepseek-v4.1-flash-1017",
            specText: "가려진 실패 일치 검증",
            cwd: process.cwd(),
            worktreeMode: "current",
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);

        const executeSpans = spanOutcomes.filter(
          (s) => s.name === "WorkerEngineService.executeWorker",
        );
        const collectSpans = spanOutcomes.filter(
          (s) => s.name === "WorkerEngineService.runAndCollect",
        );
        expect(executeSpans.length).toBe(1);
        expect(executeSpans[0]?.failed).toBe(true);
        expect(collectSpans.length).toBe(1);
        expect(collectSpans[0]?.failed).toBe(true);

        // 같은 모델이 쿨다운에 등록되어 즉시 재배정이 차단되는지도 함께 검증
        const cooldown = getUnavailableModelReason(
          "antseed_local",
          "t3_antseed/deepseek-v4.1-flash-1017",
        );
        expect(cooldown).toContain("사용 불가");
      }).pipe(Effect.provide(engineLayer), Effect.withTracer(recordingTracer));
    }));

  it("3) Antseed 사전 가용성·정책 확인 + 쿨다운 + 사용자 역할 모델 몰래 교체 금지", async () => {
    const tmpDir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-antseed-policy-"));
    try {
      NodeFs.writeFileSync(
        NodePath.join(tmpDir, "config.json"),
        JSON.stringify({ policy: { blockedModels: ["blocked-model-x"] } }),
        "utf8",
      );

      const blocked = await probeModelAvailabilityBeforeDispatch({
        providerInstanceId: "antseed_local",
        model: "t3_antseed/blocked-model-x",
        apiProviderId: "t3_antseed",
        antseedDir: tmpDir,
      });
      expect(blocked.available).toBe(false);
      expect(blocked.reason).toContain("사용 불가");

      const mockFetch = (async () =>
        new Response(JSON.stringify({ data: [{ id: "kimi-k2.5" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch;

      const missingOnGateway = await probeModelAvailabilityBeforeDispatch({
        providerInstanceId: "antseed_local",
        model: "t3_antseed/gpt-6.1-sol",
        apiProviderId: "t3_antseed",
        baseUrl: "http://127.0.0.1:8379/v1",
        antseedDir: tmpDir,
        fetchImpl: mockFetch,
      });
      expect(missingOnGateway.available).toBe(false);
      expect(missingOnGateway.reason).toContain("gpt-6.1-sol");

      // 쿨다운 동안 동일 모델 재배정 즉시 차단
      const secondProbe = await probeModelAvailabilityBeforeDispatch({
        providerInstanceId: "antseed_local",
        model: "t3_antseed/gpt-6.1-sol",
        apiProviderId: "t3_antseed",
        baseUrl: "http://127.0.0.1:8379/v1",
        antseedDir: tmpDir,
        fetchImpl: mockFetch,
      });
      expect(secondProbe.available).toBe(false);
      expect(secondProbe.fromCooldown).toBe(true);

      // 사용자가 역할을 정한 모델이 사용 불가일 때 다른 모델로 몰래 교체하지 않고 사용 불가로 표시
      const chair = makeTarget("codex", "codex", "gpt-5.4");
      const assignedAntseed = makeTarget("antseed_local", "opencode", "t3_antseed/gpt-6.1-sol");
      const backupHealthy = makeTarget("claude", "claudeAgent", "claude-sonnet-4-6");
      const roster = resolveDynamicCouncilRoster({
        activeChatChair: chair,
        configuredSubordinates: [
          {
            target: assignedAntseed,
            enabled: true,
            teamRole: "advisor",
          },
        ],
        fallbackCandidates: [{ target: backupHealthy }],
        assessTargetHealth: (t) =>
          t.providerInstanceId === "antseed_local"
            ? {
                healthy: false,
                ...(secondProbe.reason ? { reason: secondProbe.reason } : {}),
                preserveSlotOnUnavailable: true,
              }
            : { healthy: true },
        topLevelDirs: ["apps", "packages"],
      });

      const subSeat = roster.find((s) => s.seatId === "seat_sub_0");
      expect(subSeat?.targetModel.modelId).toBe("t3_antseed/gpt-6.1-sol");
      expect(subSeat?.isFallbackSubstituted).toBe(false);
      expect(subSeat?.unavailable).toBe(true);
      expect(subSeat?.unavailableReason).toContain("사용 불가");
    } finally {
      NodeFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("4) OpenCode 잔액 부족(Insufficient balance)을 비재시도 과금 오류로 분류", () => {
    expect(isNonRetryableBillingError("Insufficient balance")).toBe(true);
    expect(isNonRetryableBillingError("HTTP 402 Payment Required")).toBe(true);
    expect(isNonRetryableBillingError("connection reset by peer")).toBe(false);
    expect(
      isAntseedPeerUnavailableError("No policy-allowed peer currently serves model gpt-6.1-sol"),
    ).toBe(true);

    const formatted = formatBillingErrorMessage("Insufficient balance");
    expect(formatted).toContain("[과금 오류 · 재시도 안 함]");
    expect(formatted).toContain("Insufficient balance");

    const recorded = recordUnavailableModelFromError({
      providerInstanceId: "opencode",
      model: "opencode/kimi-k3.1-pro",
      errorMessage: "Insufficient balance",
    });
    expect(recorded?.category).toBe("billing_insufficient_balance");
  });

  it("5) 이미 끝난 작업의 중지 요청(Stale dispatch)을 실패가 아니라 '이미 종료됨'으로 정상 반환", () =>
    Effect.gen(function* () {
      const engineLayer = buildEngineLayer(() =>
        Effect.succeed({ resultText: "done quickly", exitCode: 0 }),
      );

      yield* Effect.gen(function* () {
        const engine = yield* WorkerEngineService;
        const result = yield* engine.runAndCollect({
          runId: "run_stale_stop",
          threadId: "thread_stale_stop",
          role: "scout",
          targetInstanceId: "codex",
          targetModel: "gpt-5.4",
          specText: "이미 종료된 작업 중지 검증",
          cwd: process.cwd(),
          worktreeMode: "current",
        });
        expect(result.resultText).toBe("done quickly");

        // 이미 completed 상태인 dispatch에 stop 호출 -> 실패(fencing_rejected)가 아니라 이미 종료됨 정상 반환
        const stopRes = yield* engine.stop({
          dispatchId: result.dispatchId,
          reason: "늦은 중지 요청",
        });
        expect(stopRes.stopped).toBe(false);
        expect(stopRes.status).toBe("completed");
        expect(stopRes.alreadyTerminated).toBe(true);
        expect(stopRes.message).toBe("이미 종료됨");
      }).pipe(Effect.provide(engineLayer));
    }));
});
