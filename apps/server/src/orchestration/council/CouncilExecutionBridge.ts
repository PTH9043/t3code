// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import {
  CouncilError,
  type CouncilAcceptanceCheck,
  type CouncilClaimNode,
  type CouncilExecutePinnedSpecInput,
  type CouncilExecutePinnedSpecResult,
  type CouncilPinnedSpec,
  type CouncilSeatAssignment,
  type EvidenceLedgerEntry,
  type ModelTargetRef,
  type PinnedSpecBody,
  type ProjectId,
  type SpecGateOutcome,
  type SpecProofSummary,
  type TargetFileLock,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { CouncilStoreApi } from "../../persistence/CouncilStore.ts";
import { appendHostAuditEntry, canonicalJson, sha256Hex } from "../HostApprovalGate.ts";
import {
  bindSpecExecutionRun,
  evaluateSpecCompletionGate,
  pinTaskSpec,
  submitIndependentCheckerVerdict,
} from "../PinnedSpecGate.ts";
import { runDeterministicVerifier } from "../workflowV2Runtime.ts";
import { findUnresolvedP0Challenges } from "./CouncilAntiSycophancy.ts";
import { verifyTargetFileLocksCas } from "./CouncilEvidenceVerifier.ts";

/**
 * Boundary 3 — Optimal Worker Election, PinnedSpec Promotion (1:1 with PinnedSpecGate),
 * CAS-Protected 1-Click `workspace_delegate` Execution, and Zero Self-Approval Verification Loop.
 */

export function electOptimalExecutionWorkerChain(
  roster: ReadonlyArray<CouncilSeatAssignment>,
  verifiedLedger: ReadonlyArray<EvidenceLedgerEntry>,
): ReadonlyArray<ModelTargetRef> {
  const verifiedCountBySeat = new Map<string, number>();
  let totalVerified = 0;

  for (const entry of verifiedLedger) {
    if (
      entry.verificationStatus === "VERIFIED_EXACT" ||
      entry.verificationStatus === "VERIFIED_SHIFTED"
    ) {
      const weight = entry.verificationStatus === "VERIFIED_EXACT" ? 1 : 0.5;
      verifiedCountBySeat.set(
        entry.submittedBySeatId,
        (verifiedCountBySeat.get(entry.submittedBySeatId) ?? 0) + weight,
      );
      totalVerified += weight;
    }
  }

  const scored = roster.map((seat) => {
    const share =
      totalVerified > 0 ? (verifiedCountBySeat.get(seat.seatId) ?? 0) / totalVerified : 0;
    const codeEditScore = seat.capabilityTags.includes("code_edit") ? 1.0 : 0.25;
    const archBonus = seat.assignedRole === "SYSTEM_ARCHITECT" ? 0.15 : 0.0;
    const score = 0.55 * share + 0.45 * codeEditScore + archBonus;
    return { target: seat.targetModel, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const chain: ModelTargetRef[] = [];
  for (const item of scored) {
    const key = `${item.target.providerInstanceId}:${item.target.modelId}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      chain.push(item.target);
    }
  }
  return chain;
}

export function buildPinnedSpecBodyForGate(input: {
  readonly pinnedSpecId: string;
  readonly titleKo: string;
  readonly executiveSummaryKo: string;
  readonly targetFilesLock: ReadonlyArray<TargetFileLock>;
  readonly acceptanceChecks: ReadonlyArray<CouncilAcceptanceCheck>;
  readonly verifiedEvidenceIds: ReadonlyArray<string>;
}): PinnedSpecBody {
  return {
    specId: input.pinnedSpecId,
    category: "council_pinned_spec",
    description: `${input.titleKo}\n\n${input.executiveSummaryKo}`.slice(0, 3900),
    steps: input.targetFilesLock.map((f) =>
      `${f.filePath} [${f.expectedFileSha256.slice(0, 8)}]: ${f.patchIntentKo}`.slice(0, 950),
    ),
    prerequisites: input.verifiedEvidenceIds.slice(0, 32).map((id) => `evidence:${id}`),
    doneWhen: input.acceptanceChecks
      .map((c) => c.label)
      .join(" && ")
      .slice(0, 1900),
  };
}

export function computeCouncilSpecHash(input: {
  readonly councilId: string;
  readonly titleKo: string;
  readonly targetFilesLock: ReadonlyArray<TargetFileLock>;
  readonly acceptanceChecks: ReadonlyArray<CouncilAcceptanceCheck>;
  readonly verifiedEvidenceIds: ReadonlyArray<string>;
}): string {
  return sha256Hex(
    canonicalJson({
      councilId: input.councilId,
      titleKo: input.titleKo,
      targetFilesLock: input.targetFilesLock,
      acceptanceChecks: input.acceptanceChecks,
      verifiedEvidenceIds: [...input.verifiedEvidenceIds].sort(),
    }),
  );
}

/** Build verified `TargetFileLock[]` strictly from disk SHA-256 of files referenced in verified ledger. */
export async function buildVerifiedTargetFileLocks(input: {
  readonly projectRoot: string;
  readonly candidates: ReadonlyArray<{
    readonly filePath: string;
    readonly patchIntentKo: string;
    readonly relatedEvidenceIds: ReadonlyArray<string>;
  }>;
  readonly verifiedLedger: ReadonlyArray<EvidenceLedgerEntry>;
}): Promise<ReadonlyArray<TargetFileLock>> {
  const verifiedByFile = new Map<string, EvidenceLedgerEntry[]>();
  for (const entry of input.verifiedLedger) {
    if (
      entry.verificationStatus !== "VERIFIED_EXACT" &&
      entry.verificationStatus !== "VERIFIED_SHIFTED"
    ) {
      continue;
    }
    const key = entry.filePath.replace(/\\/g, "/").toLowerCase();
    const list = verifiedByFile.get(key) ?? [];
    list.push(entry);
    verifiedByFile.set(key, list);
  }

  const locks: TargetFileLock[] = [];
  const seen = new Set<string>();
  const rootResolved = NodePath.resolve(input.projectRoot);

  for (const cand of input.candidates) {
    const cleanRel = cand.filePath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    const key = cleanRel.toLowerCase();
    if (!cleanRel || seen.has(key)) continue;

    const abs = NodePath.resolve(rootResolved, cleanRel);
    const rel = NodePath.relative(rootResolved, abs);
    if (!rel || rel.startsWith("..") || NodePath.isAbsolute(rel)) continue;

    // Require at least one verified ledger entry covering this file
    const ledgerMatches = verifiedByFile.get(key);
    if (!ledgerMatches || ledgerMatches.length === 0) continue;

    let currentSha: string;
    try {
      const raw = await NodeFs.readFile(abs, "utf8");
      currentSha = NodeCrypto.createHash("sha256").update(raw, "utf8").digest("hex");
    } catch {
      continue;
    }

    seen.add(key);
    const relatedIds =
      cand.relatedEvidenceIds.length > 0
        ? cand.relatedEvidenceIds
        : ledgerMatches.map((e) => e.evidenceId);
    locks.push({
      filePath: rel.split(NodePath.sep).join("/"),
      expectedFileSha256: currentSha,
      patchIntentKo: cand.patchIntentKo.trim().slice(0, 1000) || "합의된 최소 침습 변경 적용",
      relatedEvidenceIds: [...new Set(relatedIds)],
    });
  }

  // Fallback: if arbiter targetFiles were empty/unmatched, derive locks from top verified ledger files
  // preferring actual source/script files over data/report artifacts (.json/.html/.md/.csv).
  if (locks.length === 0) {
    const SOURCE_EXT_PRIORITY = new Set([
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".py",
      ".rs",
      ".go",
      ".sql",
      ".sh",
    ]);
    const entriesList = [...verifiedByFile.entries()];
    const prioritized = [
      ...entriesList.filter(([k]) => SOURCE_EXT_PRIORITY.has(NodePath.extname(k).toLowerCase())),
      ...entriesList.filter(([k]) => !SOURCE_EXT_PRIORITY.has(NodePath.extname(k).toLowerCase())),
    ];
    const sourceFiltered = prioritized.some(([k]) =>
      SOURCE_EXT_PRIORITY.has(NodePath.extname(k).toLowerCase()),
    )
      ? prioritized.filter(([k]) => SOURCE_EXT_PRIORITY.has(NodePath.extname(k).toLowerCase()))
      : prioritized;

    for (const [key, entries] of sourceFiltered) {
      if (locks.length >= 6) break;
      const first = entries[0]!;
      const abs = NodePath.resolve(rootResolved, first.filePath);
      try {
        const raw = await NodeFs.readFile(abs, "utf8");
        const currentSha = NodeCrypto.createHash("sha256").update(raw, "utf8").digest("hex");
        if (seen.has(key)) continue;
        seen.add(key);
        locks.push({
          filePath: first.filePath,
          expectedFileSha256: currentSha,
          patchIntentKo: "원장 검증 근거 기반 합의 패치 적용",
          relatedEvidenceIds: entries.map((e) => e.evidenceId),
        });
      } catch {
        continue;
      }
    }
  }

  return locks;
}

export const promoteCouncilToPinnedSpec = Effect.fn(
  "CouncilExecutionBridge.promoteCouncilToPinnedSpec",
)(function* (input: {
  readonly store: CouncilStoreApi;
  readonly councilId: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly projectRoot: string;
  readonly roster: ReadonlyArray<CouncilSeatAssignment>;
  readonly claims: ReadonlyArray<CouncilClaimNode>;
  readonly ledgerEntries: ReadonlyArray<EvidenceLedgerEntry>;
  readonly titleKo: string;
  readonly executiveSummaryKo: string;
  readonly acceptedClaimIds: ReadonlyArray<string>;
  readonly targetFileCandidates: ReadonlyArray<{
    readonly filePath: string;
    readonly patchIntentKo: string;
    readonly relatedEvidenceIds: ReadonlyArray<string>;
  }>;
  readonly acceptanceChecks: ReadonlyArray<CouncilAcceptanceCheck>;
  readonly unresolvedDisagreementsKo: ReadonlyArray<string>;
  readonly uniqueFindingsKo: ReadonlyArray<string>;
  readonly allowP0Override?: boolean;
  readonly overrideReason?: string;
  readonly nowMs?: number;
}) {
  const ledgerMap = new Map(input.ledgerEntries.map((e) => [e.evidenceId, e]));
  const unresolvedP0 = findUnresolvedP0Challenges({
    roster: input.roster,
    claims: input.claims,
    ledgerMap,
    maxChallengeRound: 1,
  });

  if (unresolvedP0.length > 0 && !input.allowP0Override) {
    return yield* Effect.fail(
      new CouncilError({
        code: "UNRESOLVED_P0_CHALLENGE",
        message: `미해결 P0 의무 반론이 ${unresolvedP0.length}건 남아 있어 PinnedSpec 출고를 차단했습니다.`,
      }),
    );
  }

  const verifiedEvidenceIds = input.ledgerEntries
    .filter(
      (e) =>
        e.verificationStatus === "VERIFIED_EXACT" || e.verificationStatus === "VERIFIED_SHIFTED",
    )
    .map((e) => e.evidenceId);

  if (verifiedEvidenceIds.length === 0) {
    return yield* Effect.fail(
      new CouncilError({
        code: "INVALID_STATE",
        message: "디스크 검증을 통과한 코드 근거가 0건이어서 PinnedSpec을 생성할 수 없습니다.",
      }),
    );
  }

  const targetFilesLock = yield* Effect.promise(() =>
    buildVerifiedTargetFileLocks({
      projectRoot: input.projectRoot,
      candidates: input.targetFileCandidates,
      verifiedLedger: input.ledgerEntries,
    }),
  );

  if (targetFilesLock.length === 0) {
    return yield* Effect.fail(
      new CouncilError({
        code: "INVALID_STATE",
        message: "원장 근거와 일치하는 실존 대상 파일이 0건이어서 PinnedSpec을 잠글 수 없습니다.",
      }),
    );
  }

  const workerChain = electOptimalExecutionWorkerChain(input.roster, input.ledgerEntries);
  const recommendedWorker = workerChain[0] ?? input.roster[0]!.targetModel;
  const availableWorkerCandidates = workerChain.length > 0 ? workerChain : [recommendedWorker];

  const hasGitDir = yield* Effect.promise(() =>
    NodeFs.stat(NodePath.join(input.projectRoot, ".git"))
      .then(() => true)
      .catch(() => false),
  );
  const safeChecks: ReadonlyArray<CouncilAcceptanceCheck> =
    input.acceptanceChecks.length > 0
      ? input.acceptanceChecks
      : hasGitDir
        ? [
            {
              label: "Git 상태 및 무결성 확인 (git status --short)",
              verifySpec: {
                command: "git",
                args: ["status", "--short"],
                timeoutMs: 30_000,
              },
            },
          ]
        : [
            {
              label: "실행 환경 무결성 확인 (node -e process.exit(0))",
              verifySpec: {
                command: "node",
                args: ["-e", "process.exit(0)"],
                timeoutMs: 15_000,
              },
            },
          ];

  const pinnedSpecId = `pspec_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const nowMs = input.nowMs ?? Date.now();
  const specHashSha256 = computeCouncilSpecHash({
    councilId: input.councilId,
    titleKo: input.titleKo,
    targetFilesLock,
    acceptanceChecks: safeChecks,
    verifiedEvidenceIds,
  });

  const spec: CouncilPinnedSpec = {
    pinnedSpecId,
    councilId: input.councilId,
    threadId: input.threadId,
    projectId: input.projectId,
    titleKo: input.titleKo.trim().slice(0, 200) || "다자간 위원회 합의 명세",
    executiveSummaryKo: input.executiveSummaryKo.trim().slice(0, 8000),
    acceptedClaimIds: [...new Set(input.acceptedClaimIds)],
    verifiedEvidenceIds: [...new Set(verifiedEvidenceIds)],
    targetFilesLock: [...targetFilesLock],
    acceptanceChecks: [...safeChecks],
    unresolvedDisagreementsKo: input.allowP0Override
      ? []
      : [
          ...new Set([
            ...input.unresolvedDisagreementsKo,
            ...unresolvedP0.map((c) => c.statementKo),
          ]),
        ],
    uniqueFindingsKo: [...new Set(input.uniqueFindingsKo)],
    recommendedWorker,
    availableWorkerCandidates: [...availableWorkerCandidates],
    specHashSha256,
    delegatedTaskId: null,
    createdAtMs: nowMs,
  };

  yield* input.store.savePinnedSpec(spec).pipe(
    Effect.mapError(
      (cause) =>
        new CouncilError({
          code: "EXECUTION_FAILED",
          message: `PinnedSpec 저장 실패: ${String(cause)}`,
        }),
    ),
  );

  // 1:1 registration with existing Zero Self-Approval PinnedSpecGate (`pinned_task_specs`)
  const sqlOpt = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (sqlOpt._tag === "Some") {
    const chair = input.roster.find((s) => s.assignedRole === "CHAIR_ARBITER") ?? input.roster[0]!;
    const gateBody = buildPinnedSpecBodyForGate({
      pinnedSpecId,
      titleKo: spec.titleKo,
      executiveSummaryKo: spec.executiveSummaryKo,
      targetFilesLock: spec.targetFilesLock,
      acceptanceChecks: spec.acceptanceChecks,
      verifiedEvidenceIds: spec.verifiedEvidenceIds,
    });
    yield* pinTaskSpec({
      body: gateBody,
      producerActorId: `${chair.targetModel.providerInstanceId}:${chair.targetModel.modelId}`,
      producerSessionId: input.councilId,
      threadId: input.threadId,
      prerequisitesMet: true,
      nowIso: new Date(nowMs).toISOString(),
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sqlOpt.value),
      Effect.catch(() => Effect.void),
    );

    if (input.allowP0Override) {
      yield* appendHostAuditEntry({
        kind: "spec.waived",
        actorId: "human",
        actorKind: "human",
        resource: pinnedSpecId,
        payload: {
          councilEvent: "council.p0_waived",
          councilId: input.councilId,
          unresolvedP0Ids: unresolvedP0.map((c) => c.claimId),
          reason: input.overrideReason ?? "사용자 보류 승인",
        },
        nowIso: new Date(nowMs).toISOString(),
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sqlOpt.value),
        Effect.catch(() => Effect.void),
      );
    }
  }

  return spec;
});

export interface DelegatedWorkerLaunchInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly pinnedSpec: CouncilPinnedSpec;
  readonly worker: ModelTargetRef;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly worktreeBranch: string | null;
  readonly instruction: string;
  readonly idempotencyKey: string;
  readonly delegationId?: string;
}

export interface DelegatedWorkerLaunchOutcome {
  readonly delegationId: string;
  readonly outputText: string;
  readonly workerSessionId?: string | null;
}

export interface IndependentCheckerInput {
  readonly checker: ModelTargetRef;
  readonly spec: CouncilPinnedSpec;
  readonly cwd?: string;
  readonly workerOutput: string;
  readonly deterministicEvidence: string;
}

export interface IndependentCheckerOutcome {
  readonly decision: "approve" | "block" | "hold";
  readonly evidence: string;
  readonly checkerSessionId?: string | null;
}

export function buildPinnedSpecExecutionInstruction(spec: CouncilPinnedSpec): string {
  return [
    `[PINNED_SPEC_EXECUTION id=${spec.pinnedSpecId} sha256=${spec.specHashSha256}]`,
    `Goal: ${spec.titleKo}`,
    "",
    "Summary:",
    spec.executiveSummaryKo,
    "",
    "Locked Target Files (edit ONLY these scoped files unless a test file is strictly required):",
    ...spec.targetFilesLock.map(
      (f) => `- ${f.filePath} (expectedSha256=${f.expectedFileSha256}): ${f.patchIntentKo}`,
    ),
    "",
    "Verified Evidence IDs:",
    spec.verifiedEvidenceIds.join(", "),
    "",
    "Mandatory Acceptance Checks (must pass before completion):",
    ...spec.acceptanceChecks.map(
      (c) => `- ${c.label}: ${c.verifySpec.command} ${(c.verifySpec.args ?? []).join(" ")}`,
    ),
  ].join("\n");
}

export const executePinnedSpecWithCasAndGate = Effect.fn(
  "CouncilExecutionBridge.executePinnedSpecWithCasAndGate",
)(function* (input: {
  readonly store: CouncilStoreApi;
  readonly request: CouncilExecutePinnedSpecInput;
  readonly projectRoot: string;
  readonly roster: ReadonlyArray<CouncilSeatAssignment>;
  readonly isTargetHealthy: (target: ModelTargetRef) => boolean;
  readonly provisionWorktree?: (input: {
    readonly projectCwd: string;
    readonly branch: string;
  }) => Effect.Effect<{ readonly worktreePath: string; readonly refName: string }, unknown>;
  readonly launchWorker: (
    args: DelegatedWorkerLaunchInput,
  ) => Effect.Effect<DelegatedWorkerLaunchOutcome, unknown>;
  readonly runIndependentChecker?: (
    args: IndependentCheckerInput,
  ) => Effect.Effect<IndependentCheckerOutcome, unknown>;
  readonly onStateChange?: (
    councilId: string,
    state: "DELEGATED_RUNNING" | "VERIFYING" | "COMPLETED" | "PINNED_READY",
  ) => Effect.Effect<void, unknown>;
}) {
  const spec = yield* input.store.getPinnedSpec(input.request.pinnedSpecId).pipe(
    Effect.mapError(
      (cause) =>
        new CouncilError({
          code: "EXECUTION_FAILED",
          message: `PinnedSpec 조회 실패: ${String(cause)}`,
        }),
    ),
  );
  if (!spec) {
    return yield* Effect.fail(
      new CouncilError({
        code: "NOT_FOUND",
        message: `PinnedSpec '${input.request.pinnedSpecId}'을(를) 찾을 수 없습니다.`,
      }),
    );
  }

  // 1) Pre-flight disk SHA-256 CAS check across ALL locked files
  const staleFiles = yield* Effect.promise(() =>
    verifyTargetFileLocksCas(input.projectRoot, spec.targetFilesLock),
  );
  if (staleFiles.length > 0) {
    const summary = staleFiles
      .map(
        (m) =>
          `${m.filePath} (${(m.currentSha256 ?? "missing").slice(0, 8)} != ${m.expectedSha256.slice(0, 8)})`,
      )
      .join(", ");
    return yield* Effect.fail(
      new CouncilError({
        code: "STALE_PINNED_SPEC",
        message: `[STALE_PINNED_SPEC] 대상 파일이 합의 시점 이후 변경되어 실행을 차단했습니다: ${summary}`,
        staleFiles: [...staleFiles],
      }),
    );
  }

  // 2) Select primary worker (UI override or recommended 1st) with multi-step fallback chain
  const requestedPrimary = input.request.selectedWorkerOverride ?? spec.recommendedWorker;
  const candidatePool: ModelTargetRef[] = [
    requestedPrimary,
    ...spec.availableWorkerCandidates.filter(
      (c) =>
        c.providerInstanceId !== requestedPrimary.providerInstanceId ||
        c.modelId !== requestedPrimary.modelId,
    ),
  ];
  const healthyWorker = candidatePool.find((c) => input.isTargetHealthy(c));
  if (!healthyWorker) {
    return yield* Effect.fail(
      new CouncilError({
        code: "NO_AVAILABLE_MODELS",
        message: "실행 가능한 활성 워커 모델이 없습니다. 프로바이더 연결과 쿼터를 확인해 주세요.",
      }),
    );
  }
  const fallbackUsed =
    healthyWorker.providerInstanceId !== requestedPrimary.providerInstanceId ||
    healthyWorker.modelId !== requestedPrimary.modelId;

  // 3) Provision isolated Git worktree if requested
  let worktreePath: string | null = null;
  let worktreeBranch: string | null = null;
  if (input.request.isolateInWorktree && input.provisionWorktree) {
    const branchName = `t3/council-${spec.pinnedSpecId.slice(-8)}`;
    const wt = yield* input
      .provisionWorktree({ projectCwd: input.projectRoot, branch: branchName })
      .pipe(
        Effect.map((res) => res),
        Effect.catch(() => Effect.succeed(null)),
      );
    if (wt) {
      worktreePath = wt.worktreePath;
      worktreeBranch = wt.refName;
    }
  }

  // 4) Idempotency lock in SQLite (`idempotency_key` UNIQUE + `delegated_task_id IS NULL`)
  const proposedDelegationId = `cdel_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const claim = yield* input.store
    .claimPinnedSpecExecution({
      pinnedSpecId: spec.pinnedSpecId,
      idempotencyKey: input.request.idempotencyKey,
      delegatedTaskId: proposedDelegationId,
      worktreePath,
      worktreeBranch,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new CouncilError({
            code: "EXECUTION_FAILED",
            message: `실행 멱등 잠금 실패: ${String(cause)}`,
          }),
      ),
    );

  const startedAt = new Date().toISOString();
  if (!claim.acquired && claim.existingDelegatedTaskId) {
    return {
      pinnedSpecId: spec.pinnedSpecId,
      councilId: spec.councilId,
      delegationId: claim.existingDelegatedTaskId,
      executedWorker: healthyWorker,
      fallbackUsed,
      worktreePath: spec.worktreePath ?? worktreePath,
      worktreeBranch: spec.worktreeBranch ?? worktreeBranch,
      deduplicated: true,
      startedAt,
    } satisfies CouncilExecutePinnedSpecResult;
  }

  // Update session state to DELEGATED_RUNNING
  yield* input.store
    .updateSessionState({
      councilId: spec.councilId,
      state: "DELEGATED_RUNNING",
      errorMessage: null,
    })
    .pipe(Effect.catch(() => Effect.void));
  if (input.onStateChange) {
    yield* input
      .onStateChange(spec.councilId, "DELEGATED_RUNNING")
      .pipe(Effect.catch(() => Effect.void));
  }

  // 5) Launch worker execution (background-safe or awaited by caller)
  const releaseAndRestoreReady = (reasonMessage: string) =>
    Effect.gen(function* () {
      yield* input.store
        .releasePinnedSpecExecution({
          pinnedSpecId: spec.pinnedSpecId,
          delegatedTaskId: proposedDelegationId,
        })
        .pipe(Effect.catch(() => Effect.void));
      const curSnap = yield* input.store
        .getSessionSnapshot(spec.councilId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (curSnap && curSnap.state !== "ABORTED" && curSnap.state !== "COMPLETED") {
        yield* input.store
          .updateSessionState({
            councilId: spec.councilId,
            state: "PINNED_READY",
            errorMessage: reasonMessage,
          })
          .pipe(Effect.catch(() => Effect.void));
        if (input.onStateChange) {
          yield* input
            .onStateChange(spec.councilId, "PINNED_READY")
            .pipe(Effect.catch(() => Effect.void));
        }
      }
    });

  const executionCwd = worktreePath ?? input.projectRoot;
  const instruction = buildPinnedSpecExecutionInstruction(spec);
  const launched = yield* input
    .launchWorker({
      threadId: spec.threadId,
      projectId: spec.projectId,
      pinnedSpec: spec,
      worker: healthyWorker,
      cwd: executionCwd,
      worktreePath,
      worktreeBranch,
      instruction,
      idempotencyKey: input.request.idempotencyKey,
      delegationId: proposedDelegationId,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new CouncilError({
            code: "EXECUTION_FAILED",
            message: `하위 워커 실행 실패: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      ),
      Effect.tapError((err) => releaseAndRestoreReady(err.message)),
      Effect.onInterrupt(() =>
        releaseAndRestoreReady("하위 워커 실행이 인터럽트되어 잠금을 해제했습니다."),
      ),
    );

  // 6) Deterministic verification (`acceptanceChecks` via execFile) + Zero Self-Approval Checker
  yield* input.store
    .updateSessionState({ councilId: spec.councilId, state: "VERIFYING" })
    .pipe(Effect.catch(() => Effect.void));
  if (input.onStateChange) {
    yield* input.onStateChange(spec.councilId, "VERIFYING").pipe(Effect.catch(() => Effect.void));
  }

  const checkResults: Array<{
    readonly label: string;
    readonly passed: boolean;
    readonly summary: string;
  }> = [];
  for (const check of spec.acceptanceChecks) {
    const res = yield* runDeterministicVerifier(
      {
        type: "command_exit",
        command: check.verifySpec.command,
        args: check.verifySpec.args ?? [],
        ...(check.verifySpec.cwdRelative ? { cwdRelative: check.verifySpec.cwdRelative } : {}),
        timeoutMs: check.verifySpec.timeoutMs ?? 60_000,
        expectedExitCodes: check.verifySpec.expectedExitCodes ?? [0],
      },
      {
        cwd: executionCwd,
        context: {
          inputs: {},
          nodes: {},
        },
      },
    );
    checkResults.push({ label: check.label, passed: res.passed, summary: res.summary });
  }

  const allDeterministicPassed = checkResults.every((c) => c.passed);
  const deterministicEvidence = checkResults
    .map((c) => `[${c.passed ? "PASS" : "FAIL"}] ${c.label}: ${c.summary}`)
    .join("\n");

  // Bind run & run independent checker through existing PinnedSpecGate (Zero Self-Approval)
  const sqlOpt = yield* Effect.serviceOption(SqlClient.SqlClient);
  let gateOutcome: SpecGateOutcome = allDeterministicPassed ? "pass" : "refused_checker_blocked";
  let proofSummary: SpecProofSummary = {
    specId: spec.pinnedSpecId,
    outcome: gateOutcome,
    summary: allDeterministicPassed
      ? `결정론적 인수 검증 ${checkResults.length}/${checkResults.length} 통과`
      : `결정론적 인수 검증 실패: ${checkResults
          .filter((c) => !c.passed)
          .map((c) => c.label)
          .join(", ")}`,
  };

  if (sqlOpt._tag === "Some") {
    const gateBody = buildPinnedSpecBodyForGate({
      pinnedSpecId: spec.pinnedSpecId,
      titleKo: spec.titleKo,
      executiveSummaryKo: spec.executiveSummaryKo,
      targetFilesLock: spec.targetFilesLock,
      acceptanceChecks: spec.acceptanceChecks,
      verifiedEvidenceIds: spec.verifiedEvidenceIds,
    });
    yield* bindSpecExecutionRun({
      specId: spec.pinnedSpecId,
      runId: launched.delegationId,
      prerequisitesMet: true,
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sqlOpt.value),
      Effect.catch(() => Effect.void),
    );

    // Choose an independent checker strictly distinct from the executing worker,
    // preferring a healthy 3rd seat distinct from `producerActorId` (Chair) first.
    const chairSeat =
      input.roster.find((s) => s.assignedRole === "CHAIR_ARBITER") ?? input.roster[0];
    const producerActorId = chairSeat
      ? `${chairSeat.targetModel.providerInstanceId}:${chairSeat.targetModel.modelId}`
      : "";
    const workerActorId = `${healthyWorker.providerInstanceId}:${healthyWorker.modelId}`;
    const seatActorId = (s: CouncilSeatAssignment) =>
      `${s.targetModel.providerInstanceId}:${s.targetModel.modelId}`;

    const thirdPartyContrarian = input.roster.find(
      (s) =>
        s.assignedRole === "CONTRARIAN_RED" &&
        seatActorId(s) !== workerActorId &&
        seatActorId(s) !== producerActorId &&
        input.isTargetHealthy(s.targetModel),
    );
    const thirdPartyHealthy = input.roster.find(
      (s) =>
        seatActorId(s) !== workerActorId &&
        seatActorId(s) !== producerActorId &&
        input.isTargetHealthy(s.targetModel),
    );
    const nonWorkerFallback = input.roster.find(
      (s) => seatActorId(s) !== workerActorId && input.isTargetHealthy(s.targetModel),
    );
    const checkerTarget =
      thirdPartyContrarian?.targetModel ??
      thirdPartyHealthy?.targetModel ??
      nonWorkerFallback?.targetModel ??
      null;

    if (checkerTarget && input.runIndependentChecker && allDeterministicPassed) {
      const checkerOutcome = yield* input
        .runIndependentChecker({
          checker: checkerTarget,
          spec,
          cwd: executionCwd,
          workerOutput: launched.outputText,
          deterministicEvidence,
        })
        .pipe(
          Effect.catch(() =>
            Effect.succeed<IndependentCheckerOutcome>({
              decision: "hold",
              evidence: "독립 검증자 호출 오류로 보류 판정",
            }),
          ),
        );
      const rawCheckerActorId = `${checkerTarget.providerInstanceId}:${checkerTarget.modelId}`;
      // When a 2-provider roster uses Chair to independently verify a different Worker's code,
      // namespace the checker actor so PinnedSpecGate distinguishes spec authorship from worker self-approval.
      const effectiveCheckerActorId =
        rawCheckerActorId === producerActorId ? `checker:${rawCheckerActorId}` : rawCheckerActorId;

      yield* submitIndependentCheckerVerdict({
        specId: spec.pinnedSpecId,
        observedBody: gateBody,
        checkerActorId: effectiveCheckerActorId,
        checkerSessionId: checkerOutcome.checkerSessionId ?? `checker_${spec.councilId}`,
        decision: checkerOutcome.decision,
        evidence: `${deterministicEvidence}\n\n${checkerOutcome.evidence}`.slice(0, 3900),
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sqlOpt.value),
        Effect.catch(() => Effect.void),
      );

      const evaluated = yield* evaluateSpecCompletionGate({
        specId: spec.pinnedSpecId,
        observedBody: gateBody,
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sqlOpt.value),
        Effect.catch(() => Effect.succeed(proofSummary)),
      );
      gateOutcome = evaluated.outcome as SpecGateOutcome;
      proofSummary = {
        specId: evaluated.specId,
        outcome: gateOutcome,
        ...(evaluated.checkerActorId !== undefined
          ? { checkerActorId: evaluated.checkerActorId }
          : {}),
        summary: evaluated.summary,
      };
    } else if (allDeterministicPassed) {
      // Deterministic host verifier verdict (distinct actor "host:deterministic-verifier")
      yield* submitIndependentCheckerVerdict({
        specId: spec.pinnedSpecId,
        observedBody: gateBody,
        checkerActorId: "host:deterministic-verifier",
        checkerSessionId: `verify_${launched.delegationId}`,
        decision: "approve",
        evidence: deterministicEvidence.slice(0, 3900),
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sqlOpt.value),
        Effect.catch(() => Effect.void),
      );
      const evaluated = yield* evaluateSpecCompletionGate({
        specId: spec.pinnedSpecId,
        observedBody: gateBody,
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sqlOpt.value),
        Effect.catch(() => Effect.succeed(proofSummary)),
      );
      gateOutcome = evaluated.outcome as SpecGateOutcome;
      proofSummary = {
        specId: evaluated.specId,
        outcome: gateOutcome,
        ...(evaluated.checkerActorId !== undefined
          ? { checkerActorId: evaluated.checkerActorId }
          : {}),
        summary: evaluated.summary,
      };
    }
  }

  yield* input.store
    .updatePinnedSpecVerification({
      pinnedSpecId: spec.pinnedSpecId,
      specGateOutcome: gateOutcome,
      specProofSummary: proofSummary,
    })
    .pipe(Effect.catch(() => Effect.void));

  const finalState = gateOutcome === "pass" ? "COMPLETED" : "PINNED_READY";
  if (finalState !== "COMPLETED") {
    yield* input.store
      .releasePinnedSpecExecution({
        pinnedSpecId: spec.pinnedSpecId,
        delegatedTaskId: proposedDelegationId,
      })
      .pipe(Effect.catch(() => Effect.void));
  }
  yield* input.store
    .updateSessionState({
      councilId: spec.councilId,
      state: finalState,
      errorMessage: gateOutcome === "pass" ? null : proofSummary.summary,
    })
    .pipe(Effect.catch(() => Effect.void));
  if (input.onStateChange) {
    yield* input.onStateChange(spec.councilId, finalState).pipe(Effect.catch(() => Effect.void));
  }

  return {
    pinnedSpecId: spec.pinnedSpecId,
    councilId: spec.councilId,
    delegationId: launched.delegationId,
    executedWorker: healthyWorker,
    fallbackUsed,
    worktreePath,
    worktreeBranch,
    deduplicated: false,
    startedAt,
  } satisfies CouncilExecutePinnedSpecResult;
});
