import type {
  CouncilClaimNode,
  CouncilPinnedSpec,
  CouncilSeatAssignment,
  CouncilSessionSnapshot,
  CouncilState,
  EffectiveCouncilMode,
  EvidenceLedgerEntry,
  ModelTargetRef,
  ProjectId,
  SpecGateOutcome,
  SpecProofSummary,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

interface CouncilSessionRow {
  council_id: string;
  thread_id: string;
  project_id: string;
  user_prompt: string;
  council_mode?: EffectiveCouncilMode | null;
  chair_ref_json: string;
  dynamic_roster_json: string;
  state: CouncilState;
  triage_score: number;
  flip_blocked_count: number;
  research_retry_count: number;
  synthesis_report_md?: string | null;
  error_message: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface CouncilEvidenceRow {
  evidence_id: string;
  council_id: string;
  submitted_by_seat_id: string;
  round_num: 1 | 2 | 3;
  file_path: string;
  start_line: number;
  end_line: number;
  ast_symbol: string | null;
  resolved_symbol_line: number | null;
  excerpt_sha256: string;
  file_head_sha256: string;
  verification_status: EvidenceLedgerEntry["verificationStatus"];
  verified_at_ms: number;
}

interface CouncilClaimRow {
  claim_id: string;
  council_id: string;
  author_seat_id: string;
  anon_handle: string;
  round_num: 1 | 2 | 3;
  claim_kind: CouncilClaimNode["claimKind"];
  severity: CouncilClaimNode["severity"];
  target_claim_id: string | null;
  response_taxonomy: CouncilClaimNode["responseTaxonomy"];
  stance_hash: string;
  statement_ko: string;
  proposed_diff_sketch: string | null;
  evidence_ids_json: string;
  sl_belief: number;
  sl_disbelief: number;
  sl_uncertainty: number;
  sl_base_rate: number;
  status: CouncilClaimNode["status"];
}

interface CouncilPinnedSpecRow {
  pinned_spec_id: string;
  council_id: string;
  thread_id: string;
  project_id: string;
  title_ko: string;
  executive_summary_ko: string;
  accepted_claim_ids_json: string;
  verified_evidence_ids_json: string;
  target_files_lock_json: string;
  acceptance_checks_json: string;
  unresolved_p0_json: string;
  unique_findings_json: string;
  recommended_worker_json: string;
  worker_candidates_json: string;
  spec_hash_sha256: string;
  delegated_task_id: string | null;
  idempotency_key: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  spec_gate_outcome: SpecGateOutcome | null;
  spec_proof_summary_json: string | null;
  created_at_ms: number;
}

function parseJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToEvidence(row: CouncilEvidenceRow): EvidenceLedgerEntry {
  return {
    evidenceId: row.evidence_id,
    councilId: row.council_id,
    submittedBySeatId: row.submitted_by_seat_id,
    roundNum: row.round_num,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    astSymbol: row.ast_symbol,
    ...(row.resolved_symbol_line !== null ? { resolvedSymbolLine: row.resolved_symbol_line } : {}),
    excerptSha256: row.excerpt_sha256,
    fileHeadSha256: row.file_head_sha256,
    verificationStatus: row.verification_status,
    verifiedAtMs: row.verified_at_ms,
  };
}

function rowToClaim(row: CouncilClaimRow): CouncilClaimNode {
  return {
    claimId: row.claim_id,
    councilId: row.council_id,
    authorSeatId: row.author_seat_id,
    anonHandle: row.anon_handle,
    roundNum: row.round_num,
    claimKind: row.claim_kind,
    severity: row.severity,
    targetClaimId: row.target_claim_id,
    responseTaxonomy: row.response_taxonomy,
    stanceHash: row.stance_hash,
    statementKo: row.statement_ko,
    proposedDiffSketch: row.proposed_diff_sketch,
    evidenceIds: parseJsonSafe<string[]>(row.evidence_ids_json, []),
    subjectiveOpinion: {
      belief: row.sl_belief,
      disbelief: row.sl_disbelief,
      uncertainty: row.sl_uncertainty,
      baseRate: row.sl_base_rate,
    },
    status: row.status,
  };
}

function rowToPinnedSpec(row: CouncilPinnedSpecRow): CouncilPinnedSpec {
  const proof =
    row.spec_proof_summary_json !== null
      ? parseJsonSafe<SpecProofSummary | null>(row.spec_proof_summary_json, null)
      : null;
  return {
    pinnedSpecId: row.pinned_spec_id,
    councilId: row.council_id,
    threadId: row.thread_id as ThreadId,
    projectId: row.project_id as ProjectId,
    titleKo: row.title_ko,
    executiveSummaryKo: row.executive_summary_ko,
    acceptedClaimIds: parseJsonSafe(row.accepted_claim_ids_json, []),
    verifiedEvidenceIds: parseJsonSafe(row.verified_evidence_ids_json, []),
    targetFilesLock: parseJsonSafe(row.target_files_lock_json, []),
    acceptanceChecks: parseJsonSafe(row.acceptance_checks_json, []),
    unresolvedDisagreementsKo: parseJsonSafe(row.unresolved_p0_json, []),
    uniqueFindingsKo: parseJsonSafe(row.unique_findings_json, []),
    recommendedWorker: parseJsonSafe<ModelTargetRef>(row.recommended_worker_json, {
      providerInstanceId: "unknown" as ModelTargetRef["providerInstanceId"],
      driverId: "unknown" as ModelTargetRef["driverId"],
      modelId: "unknown",
      displayName: "unknown",
    }),
    availableWorkerCandidates: parseJsonSafe<ModelTargetRef[]>(row.worker_candidates_json, []),
    specHashSha256: row.spec_hash_sha256,
    delegatedTaskId: row.delegated_task_id,
    ...(row.worktree_path !== null ? { worktreePath: row.worktree_path } : {}),
    ...(row.worktree_branch !== null ? { worktreeBranch: row.worktree_branch } : {}),
    ...(row.spec_gate_outcome !== null ? { specGateOutcome: row.spec_gate_outcome } : {}),
    ...(proof !== null ? { specProofSummary: proof } : {}),
    createdAtMs: row.created_at_ms,
  };
}

const ACTIVE_STATES_FOR_RESTART_CLEANUP: ReadonlyArray<CouncilState> = [
  "AUTO_SEATING",
  "BLIND_ROUND_1",
  "LEDGER_COMMIT_B1",
  "ANON_CRITIQUE_ROUND_2",
  "LEDGER_COMMIT_B2",
  "ARBITER_SYNTHESIS_B3",
  "DELEGATED_RUNNING",
  "VERIFYING",
];

export interface CouncilStoreApi {
  readonly createSession: (input: {
    readonly councilId: string;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly userPrompt: string;
    readonly mode?: EffectiveCouncilMode;
    readonly chairModel: ModelTargetRef;
    readonly roster: ReadonlyArray<CouncilSeatAssignment>;
    readonly state: CouncilState;
    readonly triageScore: number;
    readonly nowMs?: number;
  }) => Effect.Effect<void, unknown>;
  readonly updateSessionState: (input: {
    readonly councilId: string;
    readonly state: CouncilState;
    readonly roster?: ReadonlyArray<CouncilSeatAssignment>;
    readonly flipBlockedCount?: number;
    readonly researchRetryCount?: number;
    readonly synthesisReportMarkdown?: string | null;
    readonly errorMessage?: string | null;
    readonly nowMs?: number;
  }) => Effect.Effect<void, unknown>;
  readonly appendEvidenceEntries: (
    entries: ReadonlyArray<EvidenceLedgerEntry>,
  ) => Effect.Effect<void, unknown>;
  readonly upsertClaims: (claims: ReadonlyArray<CouncilClaimNode>) => Effect.Effect<void, unknown>;
  readonly savePinnedSpec: (spec: CouncilPinnedSpec) => Effect.Effect<void, unknown>;
  readonly claimPinnedSpecExecution: (input: {
    readonly pinnedSpecId: string;
    readonly idempotencyKey: string;
    readonly delegatedTaskId: string;
    readonly worktreePath: string | null;
    readonly worktreeBranch: string | null;
  }) => Effect.Effect<
    { readonly acquired: boolean; readonly existingDelegatedTaskId: string | null },
    unknown
  >;
  readonly releasePinnedSpecExecution: (input: {
    readonly pinnedSpecId: string;
    readonly delegatedTaskId?: string | null;
  }) => Effect.Effect<void, unknown>;
  readonly updatePinnedSpecVerification: (input: {
    readonly pinnedSpecId: string;
    readonly specGateOutcome: SpecGateOutcome;
    readonly specProofSummary: SpecProofSummary;
  }) => Effect.Effect<void, unknown>;
  readonly updatePinnedSpecFileLocks: (input: {
    readonly pinnedSpecId: string;
    readonly targetFilesLock: CouncilPinnedSpec["targetFilesLock"];
    readonly specHashSha256: string;
  }) => Effect.Effect<void, unknown>;
  readonly getSessionSnapshot: (
    councilId: string,
  ) => Effect.Effect<CouncilSessionSnapshot | null, unknown>;
  readonly getPinnedSpec: (
    pinnedSpecId: string,
  ) => Effect.Effect<CouncilPinnedSpec | null, unknown>;
  readonly listThreadSessions: (
    threadId: ThreadId,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<CouncilSessionSnapshot>, unknown>;
  readonly closeStaleCouncilSessions: (nowMs?: number) => Effect.Effect<number, unknown>;
}

export function makeCouncilStore(sql: SqlClient.SqlClient): CouncilStoreApi {
  const assembleSnapshot = Effect.fn("CouncilStore.assembleSnapshot")(function* (
    row: CouncilSessionRow,
  ): Effect.fn.Return<CouncilSessionSnapshot, unknown> {
    const [evidenceRows, claimRows, pinnedRows] = yield* Effect.all([
      sql<CouncilEvidenceRow>`
        SELECT * FROM council_evidence_ledger
        WHERE council_id = ${row.council_id}
        ORDER BY round_num ASC, verified_at_ms ASC, evidence_id ASC
      `,
      sql<CouncilClaimRow>`
        SELECT * FROM council_claims
        WHERE council_id = ${row.council_id}
        ORDER BY round_num ASC, claim_id ASC
      `,
      sql<CouncilPinnedSpecRow>`
        SELECT * FROM council_pinned_specs
        WHERE council_id = ${row.council_id}
        LIMIT 1
      `,
    ]);

    return {
      councilId: row.council_id,
      threadId: row.thread_id as ThreadId,
      projectId: row.project_id as ProjectId,
      userPrompt: row.user_prompt,
      mode: row.council_mode === "discussion" ? "discussion" : "code_patch",
      state: row.state,
      chairModel: parseJsonSafe<ModelTargetRef>(row.chair_ref_json, {
        providerInstanceId: "unknown" as ModelTargetRef["providerInstanceId"],
        driverId: "unknown" as ModelTargetRef["driverId"],
        modelId: "unknown",
        displayName: "unknown",
      }),
      roster: parseJsonSafe<CouncilSeatAssignment[]>(row.dynamic_roster_json, []),
      triageScore: row.triage_score,
      flipBlockedCount: row.flip_blocked_count,
      researchRetryCount: row.research_retry_count,
      ledgerEntries: evidenceRows.map(rowToEvidence),
      claims: claimRows.map(rowToClaim),
      pinnedSpec: pinnedRows[0] ? rowToPinnedSpec(pinnedRows[0]) : null,
      synthesisReportMarkdown: row.synthesis_report_md ?? null,
      errorMessage: row.error_message,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    };
  });

  return {
    createSession: Effect.fn("CouncilStore.createSession")(function* (input) {
      const nowMs = input.nowMs ?? Date.now();
      const mode = input.mode ?? "code_patch";
      yield* sql`INSERT INTO council_sessions (
        council_id, thread_id, project_id, user_prompt, council_mode, chair_ref_json,
        dynamic_roster_json, state, triage_score, flip_blocked_count,
        research_retry_count, synthesis_report_md, error_message, created_at_ms, updated_at_ms
      ) VALUES (
        ${input.councilId}, ${input.threadId}, ${input.projectId}, ${input.userPrompt}, ${mode},
        ${JSON.stringify(input.chairModel)}, ${JSON.stringify(input.roster)},
        ${input.state}, ${input.triageScore}, 0, 0, NULL, NULL, ${nowMs}, ${nowMs}
      )`;
    }),

    updateSessionState: Effect.fn("CouncilStore.updateSessionState")(function* (input) {
      const nowMs = input.nowMs ?? Date.now();
      const rows = yield* sql<CouncilSessionRow>`
        SELECT * FROM council_sessions WHERE council_id = ${input.councilId} LIMIT 1
      `;
      const existing = rows[0];
      if (!existing) return;
      const nextRosterJson =
        input.roster !== undefined ? JSON.stringify(input.roster) : existing.dynamic_roster_json;
      const nextFlipBlocked = input.flipBlockedCount ?? existing.flip_blocked_count;
      const nextRetry = input.researchRetryCount ?? existing.research_retry_count;
      const nextReport =
        input.synthesisReportMarkdown !== undefined
          ? input.synthesisReportMarkdown
          : (existing.synthesis_report_md ?? null);
      const nextError =
        input.errorMessage !== undefined ? input.errorMessage : existing.error_message;
      yield* sql`UPDATE council_sessions
        SET state = ${input.state},
            dynamic_roster_json = ${nextRosterJson},
            flip_blocked_count = ${nextFlipBlocked},
            research_retry_count = ${nextRetry},
            synthesis_report_md = ${nextReport},
            error_message = ${nextError},
            updated_at_ms = ${nowMs}
        WHERE council_id = ${input.councilId}`;
    }),

    appendEvidenceEntries: Effect.fn("CouncilStore.appendEvidenceEntries")(function* (entries) {
      for (const entry of entries) {
        yield* sql`INSERT OR IGNORE INTO council_evidence_ledger (
          evidence_id, council_id, submitted_by_seat_id, round_num,
          file_path, start_line, end_line, ast_symbol, resolved_symbol_line,
          excerpt_sha256, file_head_sha256, verification_status, verified_at_ms
        ) VALUES (
          ${entry.evidenceId}, ${entry.councilId}, ${entry.submittedBySeatId}, ${entry.roundNum},
          ${entry.filePath}, ${entry.startLine}, ${entry.endLine}, ${entry.astSymbol},
          ${entry.resolvedSymbolLine ?? null}, ${entry.excerptSha256}, ${entry.fileHeadSha256},
          ${entry.verificationStatus}, ${entry.verifiedAtMs}
        )`;
      }
    }),

    upsertClaims: Effect.fn("CouncilStore.upsertClaims")(function* (claims) {
      for (const claim of claims) {
        yield* sql`INSERT INTO council_claims (
          claim_id, council_id, author_seat_id, anon_handle, round_num,
          claim_kind, severity, target_claim_id, response_taxonomy, stance_hash,
          statement_ko, proposed_diff_sketch, evidence_ids_json,
          sl_belief, sl_disbelief, sl_uncertainty, sl_base_rate, status
        ) VALUES (
          ${claim.claimId}, ${claim.councilId}, ${claim.authorSeatId}, ${claim.anonHandle},
          ${claim.roundNum}, ${claim.claimKind}, ${claim.severity}, ${claim.targetClaimId},
          ${claim.responseTaxonomy}, ${claim.stanceHash}, ${claim.statementKo},
          ${claim.proposedDiffSketch}, ${JSON.stringify(claim.evidenceIds)},
          ${claim.subjectiveOpinion.belief}, ${claim.subjectiveOpinion.disbelief},
          ${claim.subjectiveOpinion.uncertainty}, ${claim.subjectiveOpinion.baseRate},
          ${claim.status}
        ) ON CONFLICT(claim_id) DO UPDATE SET
          status = excluded.status,
          response_taxonomy = excluded.response_taxonomy,
          sl_belief = excluded.sl_belief,
          sl_disbelief = excluded.sl_disbelief,
          sl_uncertainty = excluded.sl_uncertainty,
          sl_base_rate = excluded.sl_base_rate,
          evidence_ids_json = excluded.evidence_ids_json`;
      }
    }),

    savePinnedSpec: Effect.fn("CouncilStore.savePinnedSpec")(function* (spec) {
      yield* sql`INSERT INTO council_pinned_specs (
        pinned_spec_id, council_id, thread_id, project_id, title_ko,
        executive_summary_ko, accepted_claim_ids_json, verified_evidence_ids_json,
        target_files_lock_json, acceptance_checks_json, unresolved_p0_json,
        unique_findings_json, recommended_worker_json, worker_candidates_json,
        spec_hash_sha256, delegated_task_id, idempotency_key,
        worktree_path, worktree_branch, spec_gate_outcome, spec_proof_summary_json,
        created_at_ms
      ) VALUES (
        ${spec.pinnedSpecId}, ${spec.councilId}, ${spec.threadId}, ${spec.projectId},
        ${spec.titleKo}, ${spec.executiveSummaryKo},
        ${JSON.stringify(spec.acceptedClaimIds)}, ${JSON.stringify(spec.verifiedEvidenceIds)},
        ${JSON.stringify(spec.targetFilesLock)}, ${JSON.stringify(spec.acceptanceChecks)},
        ${JSON.stringify(spec.unresolvedDisagreementsKo)}, ${JSON.stringify(spec.uniqueFindingsKo)},
        ${JSON.stringify(spec.recommendedWorker)}, ${JSON.stringify(spec.availableWorkerCandidates)},
        ${spec.specHashSha256}, ${spec.delegatedTaskId}, NULL,
        ${spec.worktreePath ?? null}, ${spec.worktreeBranch ?? null},
        ${spec.specGateOutcome ?? null},
        ${spec.specProofSummary ? JSON.stringify(spec.specProofSummary) : null},
        ${spec.createdAtMs}
      ) ON CONFLICT(council_id) DO UPDATE SET
        pinned_spec_id = excluded.pinned_spec_id,
        title_ko = excluded.title_ko,
        executive_summary_ko = excluded.executive_summary_ko,
        accepted_claim_ids_json = excluded.accepted_claim_ids_json,
        verified_evidence_ids_json = excluded.verified_evidence_ids_json,
        target_files_lock_json = excluded.target_files_lock_json,
        acceptance_checks_json = excluded.acceptance_checks_json,
        unresolved_p0_json = excluded.unresolved_p0_json,
        unique_findings_json = excluded.unique_findings_json,
        recommended_worker_json = excluded.recommended_worker_json,
        worker_candidates_json = excluded.worker_candidates_json,
        spec_hash_sha256 = excluded.spec_hash_sha256`;
    }),

    claimPinnedSpecExecution: Effect.fn("CouncilStore.claimPinnedSpecExecution")(function* (input) {
      const existingByKey = yield* sql<Pick<CouncilPinnedSpecRow, "delegated_task_id">>`
        SELECT delegated_task_id FROM council_pinned_specs
        WHERE idempotency_key = ${input.idempotencyKey}
        LIMIT 1
      `;
      if (existingByKey[0]?.delegated_task_id) {
        return {
          acquired: false,
          existingDelegatedTaskId: existingByKey[0].delegated_task_id,
        };
      }

      const existingBySpec = yield* sql<Pick<CouncilPinnedSpecRow, "delegated_task_id">>`
        SELECT delegated_task_id FROM council_pinned_specs
        WHERE pinned_spec_id = ${input.pinnedSpecId}
        LIMIT 1
      `;
      if (existingBySpec[0]?.delegated_task_id) {
        return {
          acquired: false,
          existingDelegatedTaskId: existingBySpec[0].delegated_task_id,
        };
      }

      yield* sql`UPDATE council_pinned_specs
        SET delegated_task_id = ${input.delegatedTaskId},
            idempotency_key = ${input.idempotencyKey},
            worktree_path = ${input.worktreePath},
            worktree_branch = ${input.worktreeBranch}
        WHERE pinned_spec_id = ${input.pinnedSpecId}
          AND delegated_task_id IS NULL`;

      const verify = yield* sql<Pick<CouncilPinnedSpecRow, "delegated_task_id">>`
        SELECT delegated_task_id FROM council_pinned_specs
        WHERE pinned_spec_id = ${input.pinnedSpecId}
        LIMIT 1
      `;
      const winner = verify[0]?.delegated_task_id ?? null;
      return {
        acquired: winner === input.delegatedTaskId,
        existingDelegatedTaskId: winner,
      };
    }),

    releasePinnedSpecExecution: Effect.fn("CouncilStore.releasePinnedSpecExecution")(
      function* (input) {
        if (input.delegatedTaskId) {
          yield* sql`UPDATE council_pinned_specs
          SET delegated_task_id = NULL,
              idempotency_key = NULL,
              worktree_path = NULL,
              worktree_branch = NULL
          WHERE pinned_spec_id = ${input.pinnedSpecId}
            AND delegated_task_id = ${input.delegatedTaskId}`;
          return;
        }
        yield* sql`UPDATE council_pinned_specs
        SET delegated_task_id = NULL,
            idempotency_key = NULL,
            worktree_path = NULL,
            worktree_branch = NULL
        WHERE pinned_spec_id = ${input.pinnedSpecId}`;
      },
    ),

    updatePinnedSpecVerification: Effect.fn("CouncilStore.updatePinnedSpecVerification")(
      function* (input) {
        yield* sql`UPDATE council_pinned_specs
          SET spec_gate_outcome = ${input.specGateOutcome},
              spec_proof_summary_json = ${JSON.stringify(input.specProofSummary)}
          WHERE pinned_spec_id = ${input.pinnedSpecId}`;
      },
    ),

    updatePinnedSpecFileLocks: Effect.fn("CouncilStore.updatePinnedSpecFileLocks")(
      function* (input) {
        yield* sql`UPDATE council_pinned_specs
        SET target_files_lock_json = ${JSON.stringify(input.targetFilesLock)},
            spec_hash_sha256 = ${input.specHashSha256}
        WHERE pinned_spec_id = ${input.pinnedSpecId}`;
      },
    ),

    getSessionSnapshot: Effect.fn("CouncilStore.getSessionSnapshot")(function* (councilId) {
      const rows = yield* sql<CouncilSessionRow>`
        SELECT * FROM council_sessions WHERE council_id = ${councilId} LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      return yield* assembleSnapshot(row);
    }),

    getPinnedSpec: Effect.fn("CouncilStore.getPinnedSpec")(function* (pinnedSpecId) {
      const rows = yield* sql<CouncilPinnedSpecRow>`
        SELECT * FROM council_pinned_specs WHERE pinned_spec_id = ${pinnedSpecId} LIMIT 1
      `;
      return rows[0] ? rowToPinnedSpec(rows[0]) : null;
    }),

    listThreadSessions: Effect.fn("CouncilStore.listThreadSessions")(function* (
      threadId,
      limit = 8,
    ) {
      const capped = Math.max(1, Math.min(20, limit));
      const rows = yield* sql<CouncilSessionRow>`
        SELECT * FROM council_sessions
        WHERE thread_id = ${threadId}
        ORDER BY updated_at_ms DESC
        LIMIT ${capped}
      `;
      return yield* Effect.forEach(rows, (row) => assembleSnapshot(row), { concurrency: 4 });
    }),

    closeStaleCouncilSessions: Effect.fn("CouncilStore.closeStaleCouncilSessions")(
      function* (nowMs) {
        const ts = nowMs ?? Date.now();
        let closed = 0;
        for (const activeState of ACTIVE_STATES_FOR_RESTART_CLEANUP) {
          const rows = yield* sql<Pick<CouncilSessionRow, "council_id">>`
          SELECT council_id FROM council_sessions WHERE state = ${activeState}
        `;
          if (rows.length === 0) continue;
          yield* sql`UPDATE council_sessions
          SET state = 'INTERRUPTED_BY_RESTART',
              error_message = '서버 재시작으로 다자간 위원회 실행이 중단되었습니다.',
              updated_at_ms = ${ts}
          WHERE state = ${activeState}`;
          closed += rows.length;
        }
        // Clean up orphaned execution locks on aborted/interrupted specs that never passed the gate
        yield* sql`UPDATE council_pinned_specs
        SET delegated_task_id = NULL,
            idempotency_key = NULL,
            worktree_path = NULL,
            worktree_branch = NULL
        WHERE delegated_task_id IS NOT NULL
          AND (spec_gate_outcome IS NULL OR spec_gate_outcome != 'pass')
          AND council_id IN (
            SELECT council_id FROM council_sessions
            WHERE state IN ('ABORTED', 'INTERRUPTED_BY_RESTART')
          )`;
        return closed;
      },
    ),
  };
}
