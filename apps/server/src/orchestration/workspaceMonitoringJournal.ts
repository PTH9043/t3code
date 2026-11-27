import { WorkspaceMonitoringMetric } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import type { MonitoringFinding } from "./workspaceMonitoring.ts";

export interface WorkspaceMonitoringJournalEntry {
  readonly fingerprint: string;
  readonly occurrenceId: string;
  readonly metricIndex: number;
  readonly finding: MonitoringFinding;
}

export interface WorkspaceMonitoringJournalRef {
  readonly fingerprint: string;
  readonly occurrenceId: string;
}

export interface WorkspaceMonitoringCooldown {
  readonly fingerprint: string;
  readonly firedAt: number;
}

export interface WorkspaceMonitoringActionState extends WorkspaceMonitoringJournalRef {
  readonly state: "pending" | "publishing" | "completed";
  readonly firedAt: number | null;
}

const IsoObservationTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
  Schema.makeFilter((value) => {
    const timestamp = DateTime.make(value);
    const day = DateTime.make(`${value.slice(0, 10)}T00:00:00.000Z`);
    return (
      Option.isSome(timestamp) &&
      Option.isSome(day) &&
      DateTime.formatIso(day.value).slice(0, 10) === value.slice(0, 10)
    );
  }),
);

const Finding = Schema.Struct({
  fingerprint: Schema.String,
  targetLabel: Schema.String,
  programId: Schema.NullOr(Schema.String),
  metric: WorkspaceMonitoringMetric,
  observed: Schema.String,
  observedAt: IsoObservationTime,
});
const NonNegativeIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const MatchingFingerprints = Schema.makeFilter(
  (entry: { readonly fingerprint: string; readonly finding: MonitoringFinding }) =>
    entry.fingerprint === entry.finding.fingerprint,
);
const JournalEntry = Schema.Struct({
  fingerprint: Schema.String,
  occurrenceId: Schema.String,
  metricIndex: NonNegativeIndex,
  finding: Finding,
}).check(MatchingFingerprints);
const JournalRow = Schema.Struct({
  ...JournalEntry.fields,
  finding: Schema.fromJsonString(Finding),
}).check(MatchingFingerprints);
const JournalRef = Schema.Struct({ fingerprint: Schema.String, occurrenceId: Schema.String });
const Cooldown = Schema.Struct({
  fingerprint: Schema.String,
  firedAt: Schema.Number.check(Schema.isFinite()),
});
const ActionState = Schema.Struct({
  fingerprint: Schema.String,
  occurrenceId: Schema.String,
  state: Schema.Literals(["pending", "publishing", "completed"]),
  firedAt: Schema.NullOr(Schema.Number.check(Schema.isFinite())),
}).check(
  Schema.makeFilter((entry) =>
    entry.state === "completed" ? entry.firedAt !== null : entry.firedAt === null,
  ),
);

const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(JournalEntry));
const decodeRow = Schema.decodeUnknownEffect(JournalRow);
const decodeRefs = Schema.decodeUnknownEffect(Schema.Array(JournalRef));
const decodeRef = Schema.decodeUnknownEffect(JournalRef);
const decodeCooldowns = Schema.decodeUnknownEffect(Schema.Array(Cooldown));
const decodeCooldown = Schema.decodeUnknownEffect(Cooldown);
const decodeActionState = Schema.decodeUnknownEffect(ActionState);
const encodeFinding = Schema.encodeEffect(Schema.fromJsonString(Finding));

// Do not attach the invalid value or SQL parameters to errors that may be logged.
const invalid = (operation: string) => () =>
  new PersistenceDecodeError({ operation, issue: "Invalid workspace monitoring journal data" });
const sqlFailure = (operation: string) => () =>
  new PersistenceSqlError({
    operation,
    detail: "Workspace monitoring journal database operation failed",
  });

export function makeWorkspaceMonitoringJournal(sql: SqlClient.SqlClient) {
  const list = Effect.fn("WorkspaceMonitoringJournal.list")(function* (projectId: string) {
    const operation = "WorkspaceMonitoringJournal.list";
    const rows = yield* sql`SELECT fingerprint, occurrence_id AS "occurrenceId",
      metric_index AS "metricIndex", finding_json AS finding
      FROM workspace_monitoring_journal WHERE project_id = ${projectId}
      ORDER BY fingerprint, occurrence_id`.pipe(Effect.mapError(sqlFailure(operation)));
    return yield* Effect.forEach(rows, (row) =>
      decodeRow(row).pipe(Effect.mapError(invalid(operation))),
    );
  });

  const upsert = Effect.fn("WorkspaceMonitoringJournal.upsert")(function* (
    projectId: string,
    entries: ReadonlyArray<WorkspaceMonitoringJournalEntry>,
  ) {
    const operation = "WorkspaceMonitoringJournal.upsert";
    const validated = yield* decodeEntries(entries).pipe(Effect.mapError(invalid(operation)));
    const prepared = yield* Effect.forEach(validated, (entry) =>
      encodeFinding(entry.finding).pipe(
        Effect.map((findingJson) => ({ entry, findingJson })),
        Effect.mapError(invalid(operation)),
      ),
    );
    yield* sql
      .withTransaction(
        Effect.forEach(
          prepared,
          ({ entry, findingJson }) =>
            sql`INSERT INTO workspace_monitoring_journal
          (project_id, fingerprint, occurrence_id, metric_index, finding_json)
          VALUES (${projectId}, ${entry.fingerprint}, ${entry.occurrenceId}, ${entry.metricIndex}, ${findingJson})
          ON CONFLICT(project_id, occurrence_id) DO UPDATE SET
            fingerprint = excluded.fingerprint, metric_index = excluded.metric_index,
            finding_json = excluded.finding_json`,
          { discard: true },
        ),
      )
      .pipe(Effect.mapError(sqlFailure(operation)));
  });

  const acknowledge = Effect.fn("WorkspaceMonitoringJournal.acknowledge")(function* (
    projectId: string,
    refs: ReadonlyArray<WorkspaceMonitoringJournalRef>,
  ) {
    const operation = "WorkspaceMonitoringJournal.acknowledge";
    const validated = yield* decodeRefs(refs).pipe(Effect.mapError(invalid(operation)));
    yield* sql
      .withTransaction(
        Effect.forEach(
          validated,
          (ref) =>
            sql`DELETE FROM workspace_monitoring_journal
          WHERE project_id = ${projectId} AND fingerprint = ${ref.fingerprint}
            AND occurrence_id = ${ref.occurrenceId}`,
          { discard: true },
        ),
      )
      .pipe(Effect.mapError(sqlFailure(operation)));
  });

  const loadCooldowns = Effect.fn("WorkspaceMonitoringJournal.loadCooldowns")(function* (
    projectId: string,
  ) {
    const operation = "WorkspaceMonitoringJournal.loadCooldowns";
    const rows = yield* sql`SELECT fingerprint, fired_at AS "firedAt"
      FROM workspace_monitoring_cooldowns WHERE project_id = ${projectId} ORDER BY fingerprint`.pipe(
      Effect.mapError(sqlFailure(operation)),
    );
    return yield* decodeCooldowns(rows).pipe(Effect.mapError(invalid(operation)));
  });

  // Omitted fingerprints remain unchanged; each batch updates only its entries.
  const saveCooldowns = Effect.fn("WorkspaceMonitoringJournal.saveCooldowns")(function* (
    projectId: string,
    entries: ReadonlyArray<WorkspaceMonitoringCooldown>,
  ) {
    const operation = "WorkspaceMonitoringJournal.saveCooldowns";
    const validated = yield* decodeCooldowns(entries).pipe(Effect.mapError(invalid(operation)));
    yield* sql
      .withTransaction(
        Effect.forEach(
          validated,
          (entry) =>
            sql`INSERT INTO workspace_monitoring_cooldowns (project_id, fingerprint, fired_at)
          VALUES (${projectId}, ${entry.fingerprint}, ${entry.firedAt})
          ON CONFLICT(project_id, fingerprint) DO UPDATE SET fired_at = MAX(workspace_monitoring_cooldowns.fired_at, excluded.fired_at)`,
          { discard: true },
        ),
      )
      .pipe(Effect.mapError(sqlFailure(operation)));
  });

  const getActionState = Effect.fn("WorkspaceMonitoringJournal.getActionState")(function* (
    projectId: string,
    ref: WorkspaceMonitoringJournalRef,
  ) {
    const operation = "WorkspaceMonitoringJournal.getActionState";
    const validated = yield* decodeRef(ref).pipe(Effect.mapError(invalid(operation)));
    const rows = yield* sql`SELECT fingerprint, occurrence_id AS "occurrenceId", state,
      fired_at AS "firedAt" FROM workspace_monitoring_action_journal
      WHERE project_id = ${projectId} AND occurrence_id = ${validated.occurrenceId}
        AND fingerprint = ${validated.fingerprint}`.pipe(Effect.mapError(sqlFailure(operation)));
    return rows[0]
      ? yield* decodeActionState(rows[0]).pipe(Effect.mapError(invalid(operation)))
      : null;
  });

  // Action evidence outlives acknowledgement of the finding, so an uncertain
  // publication cannot become eligible for replay after the finding is removed.
  const prepareAction = Effect.fn("WorkspaceMonitoringJournal.prepareAction")(function* (
    projectId: string,
    ref: WorkspaceMonitoringJournalRef,
  ) {
    const operation = "WorkspaceMonitoringJournal.prepareAction";
    const validated = yield* decodeRef(ref).pipe(Effect.mapError(invalid(operation)));
    yield* sql`INSERT INTO workspace_monitoring_action_journal
      (project_id, occurrence_id, fingerprint, state, fired_at)
      SELECT project_id, occurrence_id, fingerprint, 'pending', NULL
      FROM workspace_monitoring_journal
      WHERE project_id = ${projectId} AND occurrence_id = ${validated.occurrenceId}
        AND fingerprint = ${validated.fingerprint}
      ON CONFLICT(project_id, occurrence_id) DO NOTHING`.pipe(
      Effect.mapError(sqlFailure(operation)),
    );
    return yield* getActionState(projectId, validated);
  });

  // The caller may publish only after this durable transition returns true.
  const claimAction = Effect.fn("WorkspaceMonitoringJournal.claimAction")(function* (
    projectId: string,
    ref: WorkspaceMonitoringJournalRef,
  ) {
    const operation = "WorkspaceMonitoringJournal.claimAction";
    const validated = yield* decodeRef(ref).pipe(Effect.mapError(invalid(operation)));
    const rows = yield* sql`UPDATE workspace_monitoring_action_journal SET state = 'publishing'
      WHERE project_id = ${projectId} AND occurrence_id = ${validated.occurrenceId}
        AND fingerprint = ${validated.fingerprint} AND state = 'pending'
        AND EXISTS (SELECT 1 FROM workspace_monitoring_journal finding
          WHERE finding.project_id = ${projectId} AND finding.occurrence_id = ${validated.occurrenceId}
            AND finding.fingerprint = ${validated.fingerprint})
      RETURNING occurrence_id`.pipe(Effect.mapError(sqlFailure(operation)));
    return rows.length === 1;
  });

  // Call only when the caller knows no command from this claim was published.
  const releaseAction = Effect.fn("WorkspaceMonitoringJournal.releaseAction")(function* (
    projectId: string,
    ref: WorkspaceMonitoringJournalRef,
  ) {
    const operation = "WorkspaceMonitoringJournal.releaseAction";
    const validated = yield* decodeRef(ref).pipe(Effect.mapError(invalid(operation)));
    const rows = yield* sql`UPDATE workspace_monitoring_action_journal SET state = 'pending'
      WHERE project_id = ${projectId} AND occurrence_id = ${validated.occurrenceId}
        AND fingerprint = ${validated.fingerprint} AND state = 'publishing'
      RETURNING occurrence_id`.pipe(Effect.mapError(sqlFailure(operation)));
    return rows.length === 1;
  });

  const completeAction = Effect.fn("WorkspaceMonitoringJournal.completeAction")(function* (
    projectId: string,
    ref: WorkspaceMonitoringJournalRef,
    firedAt: number,
  ) {
    const operation = "WorkspaceMonitoringJournal.completeAction";
    const validated = yield* decodeRef(ref).pipe(Effect.mapError(invalid(operation)));
    const cooldown = yield* decodeCooldown({ fingerprint: validated.fingerprint, firedAt }).pipe(
      Effect.mapError(invalid(operation)),
    );
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`UPDATE workspace_monitoring_action_journal
        SET state = 'completed', fired_at = ${cooldown.firedAt}
        WHERE project_id = ${projectId} AND occurrence_id = ${validated.occurrenceId}
          AND fingerprint = ${validated.fingerprint} AND state = 'publishing'
        RETURNING occurrence_id`;
          if (rows.length === 0) return false;
          yield* sql`INSERT INTO workspace_monitoring_cooldowns (project_id, fingerprint, fired_at)
        VALUES (${projectId}, ${cooldown.fingerprint}, ${cooldown.firedAt})
        ON CONFLICT(project_id, fingerprint) DO UPDATE SET
          fired_at = MAX(workspace_monitoring_cooldowns.fired_at, excluded.fired_at)`;
          return true;
        }),
      )
      .pipe(Effect.mapError(sqlFailure(operation)));
  });

  return {
    list,
    upsert,
    acknowledge,
    loadCooldowns,
    saveCooldowns,
    getActionState,
    prepareAction,
    claimAction,
    releaseAction,
    completeAction,
  };
}
