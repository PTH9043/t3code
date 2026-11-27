// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_GLOBAL_ASSISTANT_CONFIG,
  DEFAULT_PERSONA_TRAIT_GENOME,
  ZERO_VISEME_WEIGHTS,
  type GlobalAssistantConfig,
  type T3PersonaManifest,
  type UnifiedBgTask,
} from "@t3tools/contracts";
import {
  inferOutOfBandExpression,
  ProceduralLifeController,
  resolveAvatarFrameIntervalMs,
} from "./assistantPresenceController.ts";
import { compileGlobalAssistantPrompts } from "./globalAssistantPrompt.ts";
import { compileLivingPersonaPrompt } from "./livingPersonaCompiler.ts";
import { DesktopUiChannelTransport, ProactivePresenceController } from "./proactivePresence.ts";

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

const sampleManifest: T3PersonaManifest = {
  schemaVersion: "1.0.0",
  personaId: "builtin-chief-of-staff",
  displayName: "전속 비서실장",
  tagline: "정확한 보고와 단호한 리스크 제동",
  isBuiltin: true,
  memoryPolicy: { shareHumanProfile: true, isolatePersonaSelf: true },
  traits: DEFAULT_PERSONA_TRAIT_GENOME,
  register: {
    primaryLevel: "polite_haeyo",
    userTitle: "대표님",
    selfReference: "저",
    preferredEndings: ["~예요", "~드릴게요"],
    forbiddenEndings: ["~했음", "~하셈"],
  },
  outputContract: {
    reportHeader: { enabled: true, markdownHeading: "## [보고]" },
    closingAdvice: { enabled: true, markdownHeading: "## [비서실장의 조언]", maxLines: 1 },
  },
  avatarVoice: {
    rendererType: "live2d",
    modelId: "type95",
    expressionMap: {},
    voice: {
      enabled: true,
      engine: "local_tts",
      voiceId: "ko-KR",
      baseSpeed: 1,
      basePitch: 1,
      prosodyByAffect: true,
    },
  },
  fewShotExamples: {},
  updatedAt: "2026-11-22T00:00:00.000Z",
};

describe("Gate 1: Tier A prefix cache invariance, Tier C <= 250 tok, and <= 15ms p95 compile", () => {
  it("keeps Tier A-1 and Tier A-2 byte-for-byte identical when toggling voiceConversationMode", () => {
    const constitution = "F-10 독립 감사, 사실 5단계 분류, 작업 11단계, 사전 승인 경계 불변 헌법.";
    const textMode = compileLivingPersonaPrompt({
      constitutionText: constitution,
      manifest: sampleManifest,
      soulMarkdown: "따뜻하지만 매몰비용에는 단호하게 제동을 겁니다.",
      situationMode: "DEEP_WORK",
      humanFacts: ["한국어 우선", "PowerShell 금지"],
      personaMemories: ["이전 배포 성공 확인"],
      voiceConversationMode: false,
    });
    const voiceMode = compileLivingPersonaPrompt({
      constitutionText: constitution,
      manifest: sampleManifest,
      soulMarkdown: "따뜻하지만 매몰비용에는 단호하게 제동을 겁니다.",
      situationMode: "DEEP_WORK",
      humanFacts: ["한국어 우선", "PowerShell 금지"],
      personaMemories: ["이전 배포 성공 확인"],
      voiceConversationMode: true,
    });

    // Tier A-1 & A-2 hashes must match 100% (0 bytes changed -> >=97% prefix cache preserved)
    assert.strictEqual(sha256(voiceMode.tierA1Constitution), sha256(textMode.tierA1Constitution));
    assert.strictEqual(sha256(voiceMode.tierA2PersonaSheet), sha256(textMode.tierA2PersonaSheet));
    // Voice hint lives strictly in Tier C-Living and stays <= 250 tokens
    assert.include(voiceMode.tierCLivingAnchor, "[음성 호흡]");
    assert.notInclude(textMode.tierCLivingAnchor, "[음성 호흡]");
    assert.isAtMost(voiceMode.estimatedTierCTokens, 250);

    // GlobalAssistantPrompts also preserves Tier A systemInstructions byte-for-byte
    const config: GlobalAssistantConfig = {
      ...DEFAULT_GLOBAL_ASSISTANT_CONFIG,
      enabled: true,
      personaName: "비서실장",
      preset: "professional",
      voiceAndTone: "정중하고 명료한 해요체",
      corePrinciples: ["사실과 추정 구분"],
    };
    const gText = compileGlobalAssistantPrompts(config, {
      userMessage: "오늘 빌드 상태 확인해줘",
      voiceConversationMode: false,
    });
    const gVoice = compileGlobalAssistantPrompts(config, {
      userMessage: "오늘 빌드 상태 확인해줘",
      voiceConversationMode: true,
    });
    assert.strictEqual(gVoice.systemInstructions, gText.systemInstructions);
    assert.include(gVoice.recencyAnchor ?? "", "음성 대화 호흡");

    // Measure p95 compile latency across 100 iterations (must be <= 15ms)
    const durations: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const t0 = performance.now();
      compileLivingPersonaPrompt({
        constitutionText: constitution,
        manifest: sampleManifest,
        soulMarkdown: "따뜻하지만 매몰비용에는 단호하게 제동을 겁니다.",
        situationMode: "SUNK_COST_BRAKE",
        voiceConversationMode: true,
      });
      durations.push(performance.now() - t0);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[94]!;
    assert.isAtMost(p95, 15, `p95 compile latency ${p95.toFixed(2)}ms exceeded 15ms gate`);
  });
});

describe("ProceduralLifeController & Out-of-Band Expression Inference", () => {
  it("generates bounded non-periodic blinks, 70/30 gaze parallax, 3s idle saccade, and fast frame steps", () => {
    let seed = 42;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const life = new ProceduralLifeController({ rng });

    // Blink intervals strictly bounded in [1800ms, 6500ms]
    for (let i = 0; i < 60; i += 1) {
      const interval = life.sampleNextBlinkIntervalMs();
      assert.isAtLeast(interval, 1_800);
      assert.isAtMost(interval, 6_500);
    }

    // Active pointer tracking -> triggers gaze-shift blink on large jump & follows cursor
    life.notifyCursorMove(0.8, 0.4, 1_000);
    let lastFrame = life.step({
      dtMs: 16.67,
      nowMs: 1_016,
      mode: "idle",
      expression: "neutral",
      expressionWeight: 0.7,
      gazeTarget: { x: 0.8, y: 0.4, source: "cursor" },
      visemeWeights: ZERO_VISEME_WEIGHTS,
    });
    assert.isTrue(lastFrame.isBlinking);
    assert.strictEqual(lastFrame.effectiveGazeSource, "cursor");

    // Step 30 frames (~500ms) -> eyes lead ahead of head (70/30 parallax)
    for (let f = 1; f <= 30; f += 1) {
      lastFrame = life.step({
        dtMs: 16.67,
        nowMs: 1_016 + f * 16.67,
        mode: "idle",
        expression: "warm_smile",
        expressionWeight: 0.8,
        gazeTarget: { x: 0.8, y: 0.4, source: "cursor" },
        visemeWeights: { a: 0.8, i: 0, u: 0, e: 0, o: 0, silence: 0.2 },
      });
    }
    assert.isAbove(lastFrame.eyeX, lastFrame.headX);
    assert.isAbove(lastFrame.mouthOpenY, 0.5);

    // After 3s cursor inactivity -> transitions automatically to micro-saccade idle
    const idleFrame = life.step({
      dtMs: 16.67,
      nowMs: 4_500,
      mode: "idle",
      expression: "neutral",
      expressionWeight: 0.6,
      gazeTarget: { x: 0.8, y: 0.4, source: "cursor" },
      visemeWeights: ZERO_VISEME_WEIGHTS,
    });
    assert.strictEqual(idleFrame.effectiveGazeSource, "saccade_idle");

    // Performance check: 1,000 steps must stay well below 6.0ms/frame budget
    const t0 = performance.now();
    for (let i = 0; i < 1_000; i += 1) {
      life.step({
        dtMs: 16.67,
        nowMs: 5_000 + i * 16.67,
        mode: "speaking",
        expression: "warm_smile",
        expressionWeight: 0.75,
        gazeTarget: { x: 0.1, y: 0.0, source: "saccade_idle" },
        visemeWeights: { a: 0.6, i: 0.1, u: 0, e: 0.2, o: 0.1, silence: 0.2 },
      });
    }
    const perFrameMs = (performance.now() - t0) / 1_000;
    assert.isBelow(perFrameMs, 1.0);
  });

  it("infers expressions out-of-band from structural headers while ignoring fenced code", () => {
    const errHint = inferOutOfBandExpression({
      situation: "DEEP_WORK",
      mode: "speaking",
      streamingText: "## [보고]\n### [오류·반증]\n타입 오류가 2건 확인되었습니다.",
    });
    assert.strictEqual(errHint.expression, "firm_serious");

    const codeOnly = inferOutOfBandExpression({
      situation: "DEEP_WORK",
      mode: "speaking",
      streamingText: "## [보고]\n```md\n[오류·반증]\n```\n## [비서실장의 조언]\n깔끔히 끝났어요.",
    });
    assert.strictEqual(codeOnly.expression, "warm_smile");

    assert.isNull(
      resolveAvatarFrameIntervalMs({
        hidden: true,
        reducedMotion: false,
        mode: "speaking",
        idlePowerSave30Fps: false,
      }),
    );
    assert.isBelow(
      resolveAvatarFrameIntervalMs({
        hidden: false,
        reducedMotion: false,
        mode: "speaking",
        idlePowerSave30Fps: true,
      })!,
      20,
    );
    assert.isAbove(
      resolveAvatarFrameIntervalMs({
        hidden: false,
        reducedMotion: false,
        mode: "idle",
        idlePowerSave30Fps: true,
      })!,
      30,
    );
  });
});

describe("ProactivePresenceController & AssistantChannelTransport", () => {
  it("briefs on background completion/STALLED, enforces 30m cooldown, and mutes ambient chatter during INCIDENT_RESPONSE", async () => {
    const ctrl = new ProactivePresenceController({
      cooldownMs: 30 * 60_000,
      stallBriefMs: 65_000,
    });
    const task: UnifiedBgTask = {
      taskId: "bg-1",
      threadId: "t-1",
      turnId: null,
      provider: "codex",
      title: "번들 빌드 검증",
      execType: "LOCAL_PID",
      proofHandle: "shell:bg-1",
      startedAtMs: 1_000,
      lastProgressAtMs: 1_000,
      watcherArmed: false,
      state: "RUNNING",
    };

    // Initial observation registers running task
    const r0 = ctrl.observeBackgroundTasks({
      personaId: "builtin-chief-of-staff",
      tasks: [task],
      situation: "DEEP_WORK",
      nowMs: 10_000,
    });
    assert.isFalse(r0.shouldNotify);

    // Silent >= 65s triggers STALLED briefing once
    const rStalled = ctrl.observeBackgroundTasks({
      personaId: "builtin-chief-of-staff",
      tasks: [task],
      situation: "DEEP_WORK",
      nowMs: 70_000,
    });
    assert.isTrue(rStalled.shouldNotify);
    assert.strictEqual(rStalled.reason, "bg_task_stalled");

    // Task disappears -> completion briefing
    const rDone = ctrl.observeBackgroundTasks({
      personaId: "builtin-chief-of-staff",
      tasks: [],
      situation: "DEEP_WORK",
      nowMs: 80_000,
    });
    assert.isTrue(rDone.shouldNotify);
    assert.strictEqual(rDone.reason, "bg_task_completed");

    // Late night care muted during INCIDENT_RESPONSE
    const muted = ctrl.evaluateLateNightCare({
      personaId: "builtin-chief-of-staff",
      localHour: 2,
      consecutiveErrorCount: 3,
      situation: "INCIDENT_RESPONSE",
      nowMs: 100_000,
    });
    assert.isFalse(muted.shouldNotify);
    assert.strictEqual(muted.reason, "muted_incident_response");

    // Fires once in DEEP_WORK at 02:00, then blocked by 30m cooldown
    const fired = ctrl.evaluateLateNightCare({
      personaId: "builtin-chief-of-staff",
      localHour: 2,
      consecutiveErrorCount: 3,
      situation: "DEEP_WORK",
      nowMs: 100_000,
    });
    assert.isTrue(fired.shouldNotify);
    assert.strictEqual(fired.suggestedSituation, "LATE_NIGHT_CARE");

    const blockedByCooldown = ctrl.evaluateLateNightCare({
      personaId: "builtin-chief-of-staff",
      localHour: 2,
      consecutiveErrorCount: 4,
      situation: "DEEP_WORK",
      nowMs: 100_000 + 10 * 60_000,
    });
    assert.isFalse(blockedByCooldown.shouldNotify);
    assert.strictEqual(blockedByCooldown.reason, "cooldown_active");

    // Channel transport delivery
    const received: string[] = [];
    const transport = new DesktopUiChannelTransport((payload) => {
      received.push(payload.summaryText);
    });
    await transport.sendProactiveBriefing(fired.payload!);
    assert.lengthOf(received, 1);
  });
});
