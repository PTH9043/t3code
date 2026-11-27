// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadTeamMember,
  type CouncilClaimNode,
  type EvidenceLedgerEntry,
  type ModelTargetRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  assignDynamicAnonHandles,
  computeStanceHash,
  computeSubjectiveOpinion,
  detectClaimDagCycles,
  enforceEvidenceGatedFlipRule,
  findUnresolvedP0Challenges,
  isPlaceholderEvidencePath,
  isTemplatePlaceholderEcho,
  scrubIdentityLeaks,
} from "./CouncilAntiSycophancy.ts";
import { verifyEvidenceEntryOnDisk, verifyTargetFileLocksCas } from "./CouncilEvidenceVerifier.ts";
import { electOptimalExecutionWorkerChain } from "./CouncilExecutionBridge.ts";
import { evaluateCouncilTriage, resolveEffectiveCouncilMode } from "./CouncilTriage.ts";
import {
  buildSubordinateSlotsFromTeam,
  resolveDynamicCouncilRoster,
  type ConfiguredSubordinateSlot,
} from "./DynamicCouncilRoster.ts";

function makeTarget(
  instanceId: string,
  driverId: string,
  modelId: string,
  displayName?: string,
): ModelTargetRef {
  return {
    providerInstanceId: ProviderInstanceId.make(instanceId),
    driverId: ProviderDriverKind.make(driverId),
    modelId,
    displayName: displayName ?? `${instanceId} · ${modelId}`,
  };
}

describe("CouncilTriage — 0ms Intelligent Triage Gate", () => {
  it("skips short follow-ups and simple prompts to avoid 4.2x overhead", () => {
    expect(evaluateCouncilTriage({ userPrompt: "계속" }).recommendation).toBe("skip");
    expect(
      evaluateCouncilTriage({ userPrompt: "이 버튼 색깔만 파란색으로 바꿔줘" }).recommendation,
    ).toBe("skip");
  });

  it("recommends council for cross-layer architectural / migration tasks and forces on /council", () => {
    const complex = evaluateCouncilTriage({
      userPrompt:
        "packages/contracts 스키마와 apps/server SQLite 마이그레이션, apps/web 상태 머신 동시성 아키텍처를 전수 통합 설계해줘",
    });
    expect(complex.score).toBeGreaterThanOrEqual(0.55);
    expect(["suggest", "auto"]).toContain(complex.recommendation);

    const explicit = evaluateCouncilTriage({ userPrompt: "/council 인증 레이어 검토" });
    expect(explicit.score).toBe(1.0);
    expect(explicit.recommendation).toBe("auto");
  });

  it("resolves 'auto' mode to 'discussion' for analysis/strategy prompts and 'code_patch' for explicit code edits", () => {
    expect(
      resolveEffectiveCouncilMode("크라임 코인에 대한 패턴을 찾고 싶은데 같이 협의해봐라", "auto"),
    ).toBe("discussion");
    expect(
      resolveEffectiveCouncilMode(
        "RAG를 파악하고 다시 언락 숏 전략을 업그레이드 할 방향을 확정",
        "auto",
      ),
    ).toBe("discussion");
    expect(
      resolveEffectiveCouncilMode("언락 숏 전략을 업데이트해 나갈 방향을 확정해줘", "auto"),
    ).toBe("discussion");
    expect(resolveEffectiveCouncilMode("봇 신호 7건 (11월) 어떻게 성공했는지 분석", "auto")).toBe(
      "discussion",
    );
    expect(resolveEffectiveCouncilMode("CouncilStore.ts 잠금 해제 버그를 수정해줘", "auto")).toBe(
      "code_patch",
    );
    expect(resolveEffectiveCouncilMode("임의 프롬프트", "discussion")).toBe("discussion");
    expect(resolveEffectiveCouncilMode("임의 프롬프트", "code_patch")).toBe("code_patch");
    // Legacy callers omitting mode preserve 'code_patch'
    expect(resolveEffectiveCouncilMode("분석 프롬프트")).toBe("code_patch");
  });
});

describe("TC-01 & TC-02 — Dynamic Model-Agnostic Roster & Homogeneous Guard", () => {
  const chair = makeTarget("inst_a", "driverA", "model-alpha");

  it("TC-01: scales cleanly for N=0, 1, 2, 3, 5, 8 and always seats CONTRARIAN_RED with cross-driver preference", () => {
    for (const count of [0, 1, 2, 3, 5, 8]) {
      const subs: ConfiguredSubordinateSlot[] = Array.from({ length: count }, (_, idx) => ({
        target: makeTarget(
          `sub_inst_${idx}`,
          idx % 2 === 0 ? "driverB" : "driverA",
          `model-sub-${idx}`,
        ),
        enabled: true,
        teamRole: idx === 0 ? "advisor" : idx === 1 ? "worker" : idx === 2 ? "tester" : "scout",
      }));

      const roster = resolveDynamicCouncilRoster({
        activeChatChair: chair,
        configuredSubordinates: subs,
        fallbackCandidates: [{ target: makeTarget("fb_1", "driverC", "model-fb") }],
        assessTargetHealth: () => ({ healthy: true }),
        topLevelDirs: ["packages", "apps", "docs"],
      });

      expect(roster[0]?.assignedRole).toBe("CHAIR_ARBITER");
      const contrarians = roster.filter((s) => s.assignedRole === "CONTRARIAN_RED");
      expect(contrarians.length).toBeGreaterThanOrEqual(1);
      if (count >= 1) {
        // Cross-driver subordinate must win CONTRARIAN_RED over same-driver subordinate
        expect(contrarians[0]?.targetModel.driverId).not.toBe(chair.driverId);
        expect(roster.length).toBe(1 + count);
      } else {
        // N=0 seats fallback contrarian automatically
        expect(roster.length).toBe(2);
        expect(contrarians[0]?.isFallbackSubstituted).toBe(true);
      }
      if (count > 5) {
        expect(roster.some((s) => s.directoryShardHint !== null)).toBe(true);
      }
    }
  });

  it("TC-02: diversifies 4 duplicate homogeneous slots (temp offset + dir shard) and substitutes quota-exhausted slot", () => {
    const dupModel = makeTarget("inst_dup", "opencode", "same-model-x");
    const exhaustedModel = makeTarget("inst_exhausted", "driverX", "quota-dead-model");
    const healthyFallback = makeTarget("inst_healthy_fb", "opencode", "backup-model-y");

    const subs: ConfiguredSubordinateSlot[] = [
      { target: dupModel, enabled: true, supportsTemperature: true },
      { target: dupModel, enabled: true, supportsTemperature: true },
      { target: dupModel, enabled: true, supportsTemperature: true },
      { target: exhaustedModel, enabled: true, supportsTemperature: false },
    ];

    const roster = resolveDynamicCouncilRoster({
      activeChatChair: chair,
      configuredSubordinates: subs,
      fallbackCandidates: [{ target: healthyFallback, supportsTemperature: true }],
      assessTargetHealth: (t) =>
        t.providerInstanceId === exhaustedModel.providerInstanceId
          ? { healthy: false, reason: "쿼터 소진(>=99%)" }
          : { healthy: true },
      topLevelDirs: ["packages", "apps", "scripts"],
    });

    const dupSeats = roster.filter((s) => s.targetModel.modelId === "same-model-x");
    expect(dupSeats.length).toBe(3);
    const offsets = dupSeats.map((s) => s.temperatureOffset);
    expect(new Set(offsets).size).toBe(3);
    expect(offsets).toEqual([0, 0.12, 0.24]);
    expect(dupSeats.every((s) => s.temperatureOffset === 0 || s.temperatureApplied)).toBe(true);
    expect(dupSeats.filter((s) => s.directoryShardHint !== null).length).toBeGreaterThanOrEqual(2);

    const substituted = roster.find((s) => s.isFallbackSubstituted);
    expect(substituted).toBeDefined();
    expect(substituted?.targetModel.providerInstanceId).toBe(healthyFallback.providerInstanceId);
  });

  it("backward-compatibly decodes legacy ThreadTeamMember without new optional fields", () => {
    const decode = Schema.decodeUnknownSync(ThreadTeamMember);
    const legacy = decode({
      instanceId: "inst_legacy",
      model: "legacy-model-1",
      role: "worker",
    });
    expect(legacy.enabled).toBeUndefined();
    const slots = buildSubordinateSlotsFromTeam({
      members: [legacy],
      providerInstances: {
        inst_legacy: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Legacy",
          enabled: true,
        },
      },
    });
    expect(slots[0]?.enabled).toBe(true);
    expect(slots[0]?.target.driverId).toBe("codex");
  });
});

describe("TC-03 & TC-05 — Anti-Sycophancy (Flip-Test), Anonymization, DAG & Contrarian Gate", () => {
  const verifiedEv1: EvidenceLedgerEntry = {
    evidenceId: "ev_1",
    councilId: "cnc_1",
    submittedBySeatId: "seat_sub_0",
    roundNum: 1,
    filePath: "src/core.ts",
    startLine: 1,
    endLine: 10,
    astSymbol: "computeCore",
    excerptSha256: "a".repeat(64),
    fileHeadSha256: "b".repeat(64),
    verificationStatus: "VERIFIED_EXACT",
    verifiedAtMs: 1000,
  };
  const verifiedEv2: EvidenceLedgerEntry = {
    ...verifiedEv1,
    evidenceId: "ev_2",
    roundNum: 2,
    startLine: 11,
    endLine: 20,
    astSymbol: "guardEdge",
  };
  const rejectedEv: EvidenceLedgerEntry = {
    ...verifiedEv1,
    evidenceId: "ev_bad",
    verificationStatus: "REJECTED_FILE_MISSING",
  };
  const ledgerMap = new Map<string, EvidenceLedgerEntry>([
    [verifiedEv1.evidenceId, verifiedEv1],
    [verifiedEv2.evidenceId, verifiedEv2],
    [rejectedEv.evidenceId, rejectedEv],
  ]);

  it("TC-03: blocks sycophantic flip lacking novel verified evidence, permits flip with new verified evidence", () => {
    const r1Claim: CouncilClaimNode = {
      claimId: "clm_r1",
      councilId: "cnc_1",
      authorSeatId: "seat_sub_0",
      anonHandle: "Proposal-1",
      roundNum: 1,
      claimKind: "PATCH_PROPOSAL",
      severity: "P1",
      targetClaimId: null,
      responseTaxonomy: "INITIAL",
      stanceHash: computeStanceHash({
        proposedDiffSketch: "fix null guard in computeCore",
        evidenceEntries: [verifiedEv1],
      }),
      statementKo: "computeCore에 null 가드가 필요합니다.",
      proposedDiffSketch: "fix null guard in computeCore",
      evidenceIds: ["ev_1"],
      subjectiveOpinion: computeSubjectiveOpinion({
        evidenceIds: ["ev_1"],
        ledgerMap,
      }).opinion,
      status: "ACTIVE",
    };

    // Sycophantic flip: changes stance to match majority WITHOUT new verified evidence
    const sycophanticR2: CouncilClaimNode = {
      ...r1Claim,
      claimId: "clm_r2_bad",
      roundNum: 2,
      stanceHash: computeStanceHash({
        proposedDiffSketch: "delete computeCore completely",
        evidenceEntries: [verifiedEv1],
      }),
      proposedDiffSketch: "delete computeCore completely",
      evidenceIds: ["ev_1", "ev_bad"],
    };

    const blocked = enforceEvidenceGatedFlipRule({
      round1Claim: r1Claim,
      round2Candidate: sycophanticR2,
      verifiedLedgerMap: ledgerMap,
    });
    expect(blocked.flipBlocked).toBe(true);
    expect(blocked.acceptedClaim.status).toBe("FLIP_BLOCKED");
    expect(blocked.acceptedClaim.proposedDiffSketch).toBe("fix null guard in computeCore");

    // Legitimate update: introduces novel verified evidence ev_2
    const legitR2: CouncilClaimNode = {
      ...sycophanticR2,
      claimId: "clm_r2_good",
      evidenceIds: ["ev_1", "ev_2"],
    };
    const allowed = enforceEvidenceGatedFlipRule({
      round1Claim: r1Claim,
      round2Candidate: legitR2,
      verifiedLedgerMap: ledgerMap,
    });
    expect(allowed.flipBlocked).toBe(false);
    expect(allowed.acceptedClaim.status).toBe("ACTIVE");
    expect(allowed.acceptedClaim.subjectiveOpinion.belief).toBeGreaterThan(0.5);

    // Legitimate update with VERIFIED_SHIFTED novel evidence must NOT be false-positive FLIP_BLOCKED
    const shiftedEv: EvidenceLedgerEntry = {
      ...verifiedEv2,
      evidenceId: "ev_shifted_r2",
      verificationStatus: "VERIFIED_SHIFTED",
    };
    const shiftedMap = new Map<string, EvidenceLedgerEntry>([
      ...ledgerMap.entries(),
      [shiftedEv.evidenceId, shiftedEv],
    ]);
    const shiftedR2: CouncilClaimNode = {
      ...r1Claim,
      claimId: "clm_r2_shifted",
      roundNum: 2,
      stanceHash: computeStanceHash({
        proposedDiffSketch: null,
        evidenceEntries: [verifiedEv1, shiftedEv],
      }),
      evidenceIds: ["ev_1", "ev_shifted_r2"],
    };
    const allowedShifted = enforceEvidenceGatedFlipRule({
      round1Claim: r1Claim,
      round2Candidate: shiftedR2,
      verifiedLedgerMap: shiftedMap,
    });
    expect(allowedShifted.flipBlocked).toBe(false);
    expect(allowedShifted.acceptedClaim.status).toBe("ACTIVE");
  });

  it("anonymizes seats to Proposal-1..M and scrubs self-identification leaks", () => {
    const handles = assignDynamicAnonHandles({
      councilId: "cnc_1",
      roundNum: 2,
      seatIds: ["seat_chair", "seat_sub_0", "seat_sub_1"],
    });
    expect([...handles.values()].sort()).toEqual(["Proposal-1", "Proposal-2", "Proposal-3"]);

    const scrubbed = scrubIdentityLeaks("나는 Claude Opus이고 Gemini-4와 Codex를 반박한다.", [
      "custom_acct_01",
    ]);
    expect(scrubbed).not.toMatch(/claude|gemini|codex/iu);
    expect(scrubbed).toContain("[익명 제안자]");
  });

  it("detects Claim DAG cycles and enforces CONTRARIAN_RED P0 challenge gate (TC-05)", () => {
    const cycles = detectClaimDagCycles([
      { claimId: "a", targetClaimId: "b" },
      { claimId: "b", targetClaimId: "a" },
      { claimId: "c", targetClaimId: null },
    ]);
    expect([...cycles].sort()).toEqual(["a", "b"]);

    const roster = resolveDynamicCouncilRoster({
      activeChatChair: makeTarget("c1", "d1", "m1"),
      configuredSubordinates: [{ target: makeTarget("s1", "d2", "m2"), enabled: true }],
      fallbackCandidates: [],
      assessTargetHealth: () => ({ healthy: true }),
      topLevelDirs: [],
    });
    const contrarianId = roster.find((s) => s.assignedRole === "CONTRARIAN_RED")!.seatId;

    const p0Challenge: CouncilClaimNode = {
      claimId: "clm_p0",
      councilId: "cnc_1",
      authorSeatId: contrarianId,
      anonHandle: "Proposal-2",
      roundNum: 2,
      claimKind: "CONTRARIAN_CHALLENGE",
      severity: "P0",
      targetClaimId: "clm_r1",
      responseTaxonomy: "INITIAL",
      stanceHash: "h1",
      statementKo: "경쟁 조건(race condition)으로 멱등 키가 중복 삽입됩니다.",
      proposedDiffSketch: null,
      evidenceIds: ["ev_1"],
      subjectiveOpinion: { belief: 0.65, disbelief: 0, uncertainty: 0.35, baseRate: 0.5 },
      status: "ACTIVE",
    };

    expect(
      findUnresolvedP0Challenges({ roster, claims: [p0Challenge], ledgerMap }).map(
        (c) => c.claimId,
      ),
    ).toEqual(["clm_p0"]);

    const resolution: CouncilClaimNode = {
      ...p0Challenge,
      claimId: "clm_defense",
      authorSeatId: "seat_chair",
      claimKind: "REBUTTAL_DEFENSE",
      severity: null,
      targetClaimId: "clm_p0",
      responseTaxonomy: "NEW_EVIDENCE_ADDED",
      evidenceIds: ["ev_2"],
    };
    expect(
      findUnresolvedP0Challenges({ roster, claims: [p0Challenge, resolution], ledgerMap }),
    ).toEqual([]);
  });

  it("elects optimal execution worker chain weighted by verified ledger share + code_edit capability", () => {
    const roster = resolveDynamicCouncilRoster({
      activeChatChair: makeTarget("chair_1", "d1", "m_chair"),
      configuredSubordinates: [
        {
          target: makeTarget("sub_arch", "d2", "m_arch"),
          enabled: true,
          explicitCapabilities: ["code_edit", "deep_reasoning"],
        },
        {
          target: makeTarget("sub_critic", "d3", "m_critic"),
          enabled: true,
          explicitCapabilities: ["fast_critic"],
        },
      ],
      fallbackCandidates: [],
      assessTargetHealth: () => ({ healthy: true }),
      topLevelDirs: [],
    });
    const archSeat = roster.find((s) => s.targetModel.modelId === "m_arch")!;
    const chain = electOptimalExecutionWorkerChain(roster, [
      { ...verifiedEv1, submittedBySeatId: archSeat.seatId },
      { ...verifiedEv2, submittedBySeatId: archSeat.seatId },
    ]);
    expect(chain[0]?.modelId).toBe("m_arch");
    expect(chain.length).toBe(3);
  });
});

describe("TC-04 — Boundary 1 Disk SHA-256 + CodeGraph AST Evidence Ledger Verifier", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-council-ev-"));
    await NodeFs.mkdir(NodePath.join(tmpDir, "src"), { recursive: true });
    await NodeFs.writeFile(
      NodePath.join(tmpDir, "src/sample.ts"),
      [
        "export function calculateTotal(items: number[]): number {",
        "  return items.reduce((acc, n) => acc + n, 0);",
        "}",
        "",
        "export function formatReport(total: number): string {",
        "  return `Total: ${total}`;",
        "}",
      ].join("\n"),
      "utf8",
    );
  });

  afterAll(async () => {
    await NodeFs.rm(tmpDir, { recursive: true, force: true });
  });

  it("verifies exact symbol/range, detects shifted symbol, rejects missing/traversal/out-of-range/hallucinated symbols", async () => {
    const exact = await verifyEvidenceEntryOnDisk(tmpDir, {
      evidenceId: "ev_exact",
      councilId: "cnc_test",
      submittedBySeatId: "seat_chair",
      roundNum: 1,
      filePath: "src/sample.ts",
      startLine: 1,
      endLine: 3,
      astSymbol: "calculateTotal",
    });
    expect(exact.verificationStatus).toBe("VERIFIED_EXACT");
    expect(exact.resolvedSymbolLine).toBe(1);

    const shifted = await verifyEvidenceEntryOnDisk(tmpDir, {
      evidenceId: "ev_shift",
      councilId: "cnc_test",
      submittedBySeatId: "seat_sub_0",
      roundNum: 1,
      filePath: "src/sample.ts",
      startLine: 1,
      endLine: 3,
      astSymbol: "formatReport",
    });
    expect(shifted.verificationStatus).toBe("VERIFIED_SHIFTED");
    expect(shifted.resolvedSymbolLine).toBe(5);

    const hallucinatedSymbol = await verifyEvidenceEntryOnDisk(tmpDir, {
      evidenceId: "ev_no_sym",
      councilId: "cnc_test",
      submittedBySeatId: "seat_sub_0",
      roundNum: 1,
      filePath: "src/sample.ts",
      startLine: 1,
      endLine: 3,
      astSymbol: "nonExistentMagicSymbol",
    });
    expect(hallucinatedSymbol.verificationStatus).toBe("REJECTED_SYMBOL_NOT_FOUND");

    const traversal = await verifyEvidenceEntryOnDisk(tmpDir, {
      evidenceId: "ev_trav",
      councilId: "cnc_test",
      submittedBySeatId: "seat_sub_0",
      roundNum: 1,
      filePath: "../../etc/passwd",
      startLine: 1,
      endLine: 1,
      astSymbol: null,
    });
    expect(traversal.verificationStatus).toBe("REJECTED_FILE_MISSING");

    const outOfRange = await verifyEvidenceEntryOnDisk(tmpDir, {
      evidenceId: "ev_oor",
      councilId: "cnc_test",
      submittedBySeatId: "seat_sub_0",
      roundNum: 1,
      filePath: "src/sample.ts",
      startLine: 1,
      endLine: 999,
      astSymbol: null,
    });
    expect(outOfRange.verificationStatus).toBe("REJECTED_HASH_MISMATCH");

    // CAS tamper detection (1-byte change)
    const cleanCas = await verifyTargetFileLocksCas(tmpDir, [
      { filePath: "src/sample.ts", expectedFileSha256: exact.fileHeadSha256 },
    ]);
    expect(cleanCas).toEqual([]);

    await NodeFs.appendFile(NodePath.join(tmpDir, "src/sample.ts"), "\n// 1 byte", "utf8");
    const tamperedCas = await verifyTargetFileLocksCas(tmpDir, [
      { filePath: "src/sample.ts", expectedFileSha256: exact.fileHeadSha256 },
    ]);
    expect(tamperedCas.length).toBe(1);
    expect(tamperedCas[0]?.filePath).toBe("src/sample.ts");
  });

  it("verifies nested JSON key paths (exact & shifted), Markdown sections, and rejects template placeholder echoes", async () => {
    await NodeFs.mkdir(NodePath.join(tmpDir, "docs/reviews"), { recursive: true });
    await NodeFs.writeFile(
      NodePath.join(tmpDir, "docs/reviews/radar.json"),
      JSON.stringify(
        {
          watch: {
            AGTUSDT: {
              "2026-11-10": { strict: true, gainPct: 251.1 },
            },
          },
          calls: [{ symbol: "IDOLUSDT", complete7d: false }],
        },
        null,
        2,
      ),
      "utf8",
    );
    await NodeFs.writeFile(
      NodePath.join(tmpDir, "docs/notes.md"),
      "# 전략 요약\n\n- 급락 후 거래 고갈 반등 +30% 익절\n",
      "utf8",
    );

    const jsonExact = await verifyEvidenceEntryOnDisk(tmpDir, {
      evidenceId: "ev_json_exact",
      councilId: "cnc_json",
      submittedBySeatId: "seat_sub_4",
      roundNum: 2,
      filePath: "docs/reviews/radar.json",
      startLine: 1,
      endLine: 8,
      astSymbol: "watch.AGTUSDT.2026-11-10",
    });
    expect(jsonExact.verificationStatus).toBe("VERIFIED_EXACT");

    const jsonShifted = await verifyEvidenceEntryOnDisk(tmpDir, {
      evidenceId: "ev_json_shift",
      councilId: "cnc_json",
      submittedBySeatId: "seat_sub_4",
      roundNum: 2,
      filePath: "docs/reviews/radar.json",
      startLine: 1,
      endLine: 3,
      astSymbol: "calls.complete7d",
    });
    expect(jsonShifted.verificationStatus).toBe("VERIFIED_SHIFTED");

    const jsonPathSyntax = await verifyEvidenceEntryOnDisk(tmpDir, {
      evidenceId: "ev_jsonpath_syntax",
      councilId: "cnc_json",
      submittedBySeatId: "seat_sub_0",
      roundNum: 1,
      filePath: "docs/reviews/radar.json",
      startLine: 1,
      endLine: 12,
      astSymbol: "$.calls[*].complete7d",
    });
    expect(["VERIFIED_EXACT", "VERIFIED_SHIFTED"]).toContain(jsonPathSyntax.verificationStatus);

    const annotatedCodeSym = await verifyEvidenceEntryOnDisk(tmpDir, {
      evidenceId: "ev_annotated_code",
      councilId: "cnc_json",
      submittedBySeatId: "seat_chair",
      roundNum: 1,
      filePath: "src/sample.ts",
      startLine: 1,
      endLine: 3,
      astSymbol: "calculateTotal (baseline sum helper)",
    });
    expect(annotatedCodeSym.verificationStatus).toBe("VERIFIED_EXACT");

    const jsonMissing = await verifyEvidenceEntryOnDisk(tmpDir, {
      evidenceId: "ev_json_missing",
      councilId: "cnc_json",
      submittedBySeatId: "seat_sub_4",
      roundNum: 2,
      filePath: "docs/reviews/radar.json",
      startLine: 1,
      endLine: 8,
      astSymbol: "watch.NONEXISTENT.9999",
    });
    expect(jsonMissing.verificationStatus).toBe("REJECTED_SYMBOL_NOT_FOUND");

    const mdExact = await verifyEvidenceEntryOnDisk(tmpDir, {
      evidenceId: "ev_md_exact",
      councilId: "cnc_json",
      submittedBySeatId: "seat_chair",
      roundNum: 1,
      filePath: "docs/notes.md",
      startLine: 1,
      endLine: 3,
      astSymbol: "급락 후 거래 고갈",
    });
    expect(mdExact.verificationStatus).toBe("VERIFIED_EXACT");

    expect(isTemplatePlaceholderEcho("핵심 진단 및 제안 요약 (한국어, 600자 이내)")).toBe(true);
    expect(isTemplatePlaceholderEcho("<여기에_실제_분석_결론과_수치_근거를_한국어로_작성>")).toBe(
      true,
    );
    expect(isTemplatePlaceholderEcho("실제 AGT +30% 도달률은 54%입니다.")).toBe(false);
    expect(isPlaceholderEvidencePath("packages/contracts/src/example.ts")).toBe(true);
    expect(isPlaceholderEvidencePath("<실존_상대_파일_경로>")).toBe(true);
    expect(isPlaceholderEvidencePath("docs/reviews/radar.json")).toBe(false);
  });
});
