// @effect-diagnostics nodeBuiltinImport:off - The journal validates its own durable database path.
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from "node:crypto";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Durable handoff for an independent watchdog. Never put provider credentials in this journal. */
export type WatchdogJobState =
  | "pending"
  | "running"
  | "cancel-requested"
  | "completed"
  | "failed"
  | "cancelled";

export interface WatchdogJournalJob {
  readonly id: string;
  readonly executionId: string;
  readonly threadId: string;
  readonly state: WatchdogJobState;
}

export interface WatchdogJournalEvent {
  readonly sequence: number;
  readonly id: string;
  readonly kind: string;
  readonly payload: string;
}

export interface WatchdogWorkerIdentity {
  readonly workerId: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly lastHeartbeatAt: number;
}

export interface WatchdogMcpCredential {
  readonly tokenHash: Uint8Array;
  readonly environmentId: string;
  readonly ownerThreadId: string;
  readonly sessionId: string;
  readonly providerSessionId: string;
  readonly providerInstanceId: string;
  readonly issuedAt: number;
  readonly runtimeMode?: "full-access";
  readonly interactionMode?: "default";
  readonly executionCwd?: string;
}

export type WatchdogWorkerOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "stop-sent"
  | "stop-unknown"
  | "start-unknown"
  | "submit-unknown"
  | "stream-unknown"
  | "drain-unknown"
  | "worker-error";

export interface WatchdogControl {
  readonly id: string;
  readonly kind: "approval" | "user-input";
  readonly payload: string;
  readonly state: "queued" | "sending" | "accepted" | "rejected" | "unknown";
  readonly attempt: string | null;
}

type JournalReceipt = { readonly id: string; readonly kind: string; readonly payload: string };
type JobRow = { id: string; execution_id: string; thread_id: string; state: WatchdogJobState };
const fromRow = (row: JobRow): WatchdogJournalJob => ({
  id: row.id,
  executionId: row.execution_id,
  threadId: row.thread_id,
  state: row.state,
});

const digest = (secret: string) => createHash("sha256").update(secret, "utf8").digest();
const terminal = new Set<WatchdogJobState>(["completed", "failed", "cancelled"]);
export const WATCHDOG_PROJECTION_CONSUMER = "conversation-v1";

export const watchdogAttestationMessage = (
  id: string,
  workerId: string,
  challengeId: string,
  nonce: Uint8Array,
): Buffer =>
  Buffer.from(
    JSON.stringify([
      "t3-watchdog-attestation-v1",
      id,
      workerId,
      challengeId,
      Buffer.from(nonce).toString("base64url"),
    ]),
    "utf8",
  );

/**
 * The journal records receipts, not permission to retry a model turn. An interrupted
 * or unreachable worker remains uncertain until a matching worker receipt arrives.
 * A consumer must apply events idempotently before advancing its cursor.
 */
export class WatchdogJournal {
  readonly #db: DatabaseSync;
  readonly filename: string;

  constructor(filename: string) {
    this.filename = filename === ":memory:" ? filename : NodePath.resolve(filename);
    this.#db = new DatabaseSync(this.filename);
    this.#db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS watchdog_jobs (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        capability_hash BLOB NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','running','cancel-requested','completed','failed','cancelled'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS watchdog_execution_context (
        job_id TEXT PRIMARY KEY REFERENCES watchdog_jobs(id),
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt > 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS watchdog_execution_provider (
        job_id TEXT PRIMARY KEY REFERENCES watchdog_jobs(id),
        provider TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS watchdog_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES watchdog_jobs(id),
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(job_id, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS watchdog_cursors (
        job_id TEXT NOT NULL REFERENCES watchdog_jobs(id),
        consumer TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        PRIMARY KEY(job_id, consumer)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS watchdog_controls (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES watchdog_jobs(id),
        id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('approval','user-input')),
        payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','sending','accepted','rejected','unknown')),
        attempt TEXT,
        UNIQUE(job_id, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS watchdog_stops (
        job_id TEXT PRIMARY KEY REFERENCES watchdog_jobs(id),
        attempt TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('sending', 'sent', 'unknown'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS watchdog_submissions (
        job_id TEXT PRIMARY KEY REFERENCES watchdog_jobs(id),
        state TEXT NOT NULL CHECK (state IN ('sending', 'accepted', 'unknown'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS watchdog_stream_seals (
        job_id TEXT PRIMARY KEY REFERENCES watchdog_jobs(id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS watchdog_workers (
        job_id TEXT PRIMARY KEY REFERENCES watchdog_jobs(id),
        worker_id TEXT NOT NULL,
        pid INTEGER NOT NULL CHECK (pid > 0),
        started_at INTEGER NOT NULL CHECK (started_at >= 0),
        last_heartbeat_at INTEGER NOT NULL CHECK (last_heartbeat_at >= started_at)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS watchdog_worker_outcomes (
        job_id TEXT PRIMARY KEY REFERENCES watchdog_jobs(id),
        worker_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN (
          'completed','failed','cancelled','stop-sent','stop-unknown',
          'start-unknown','submit-unknown','stream-unknown','drain-unknown','worker-error'
        )),
        recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS watchdog_worker_keys (
        job_id TEXT PRIMARY KEY REFERENCES watchdog_jobs(id),
        worker_id TEXT NOT NULL,
        public_key TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS watchdog_attestations (
        job_id TEXT NOT NULL REFERENCES watchdog_jobs(id),
        challenge_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        nonce BLOB NOT NULL,
        signature BLOB,
        PRIMARY KEY(job_id, challenge_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS watchdog_mcp_credentials (
        job_id TEXT PRIMARY KEY REFERENCES watchdog_jobs(id),
        token_hash BLOB NOT NULL UNIQUE,
        environment_id TEXT NOT NULL,
        owner_thread_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL,
        issued_at INTEGER NOT NULL CHECK (issued_at >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS watchdog_mcp_creator_policy (
        job_id TEXT PRIMARY KEY REFERENCES watchdog_jobs(id),
        execution_cwd TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS upgrade_room_jobs (
        job_id TEXT PRIMARY KEY REFERENCES watchdog_jobs(id),
        turn_event_id TEXT NOT NULL UNIQUE,
        turn_sequence INTEGER NOT NULL CHECK (turn_sequence >= 0),
        request TEXT NOT NULL,
        offline_questions TEXT NOT NULL CHECK (offline_questions IN ('decide','wait')),
        continuity TEXT NOT NULL CHECK (continuity IN ('resumed','fresh')),
        projection TEXT NOT NULL,
        created_at INTEGER NOT NULL CHECK (created_at >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS upgrade_room_resume_cursors (
        job_id TEXT PRIMARY KEY REFERENCES watchdog_jobs(id),
        provider_instance_id TEXT NOT NULL,
        cursor TEXT NOT NULL,
        recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS upgrade_room_finalizations (
        job_id TEXT PRIMARY KEY REFERENCES upgrade_room_jobs(job_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS upgrade_room_questions (
        job_id TEXT NOT NULL REFERENCES watchdog_jobs(id),
        request_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        question TEXT NOT NULL,
        handled_as TEXT NOT NULL CHECK (handled_as IN ('decided','waiting')),
        recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
        PRIMARY KEY(job_id, request_id, question_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS upgrade_room_backend_heartbeat (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        observed_at INTEGER NOT NULL CHECK (observed_at >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS upgrade_room_queue (
        turn_event_id TEXT PRIMARY KEY,
        event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0),
        message_id TEXT NOT NULL,
        queued_at INTEGER NOT NULL CHECK (queued_at >= 0),
        state TEXT NOT NULL CHECK (state IN ('queued','started','dropped'))
      ) STRICT;
    `);
  }

  close(): void {
    this.#db.close();
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #authorize(id: string, capability: string): WatchdogJobState {
    const row = this.#db
      .prepare("SELECT capability_hash, state FROM watchdog_jobs WHERE id = ?")
      .get(id) as { capability_hash: Uint8Array; state: WatchdogJobState } | undefined;
    const actual = digest(capability);
    if (
      !row ||
      row.capability_hash.byteLength !== actual.byteLength ||
      !timingSafeEqual(row.capability_hash, actual)
    ) {
      throw new Error("Watchdog job is unavailable or the capability is invalid.");
    }
    return row.state;
  }

  create(input: {
    id: string;
    executionId: string;
    threadId: string;
    capability: string;
    context?: {
      readonly runId: string;
      readonly nodeId: string;
      readonly attempt: number;
      readonly provider?: string;
      readonly providerInstanceId?: string;
    };
    /** Reject a new job atomically while an earlier run has unsettled results. */
    requireSettledConsumer?: string;
    upgradeRoom?: Omit<UpgradeRoomJobRecord, "jobId">;
  }): boolean {
    if (!input.id || !input.executionId || !input.threadId || !input.capability) {
      throw new Error("Watchdog job identity and capability are required.");
    }
    if (
      input.context &&
      (!input.context.runId ||
        !input.context.nodeId ||
        !Number.isSafeInteger(input.context.attempt) ||
        input.context.attempt < 1 ||
        Boolean(input.context.provider) !== Boolean(input.context.providerInstanceId))
    )
      throw new Error("Invalid watchdog execution context.");
    if (
      input.requireSettledConsumer !== undefined &&
      (!input.context || !input.requireSettledConsumer)
    )
      throw new Error("A run and consumer are required for the unsettled-job guard.");
    return this.#transaction(() => {
      if (
        input.context &&
        input.requireSettledConsumer &&
        this.listUnsettledForRun(input.threadId, input.context.runId, input.requireSettledConsumer)
          .length > 0
      )
        return false;
      this.#db
        .prepare(
          "INSERT INTO watchdog_jobs (id, execution_id, thread_id, capability_hash, state) VALUES (?, ?, ?, ?, 'pending')",
        )
        .run(input.id, input.executionId, input.threadId, digest(input.capability));
      if (input.context)
        this.#db
          .prepare(
            "INSERT INTO watchdog_execution_context (job_id, run_id, node_id, attempt) VALUES (?, ?, ?, ?)",
          )
          .run(input.id, input.context.runId, input.context.nodeId, input.context.attempt);
      if (input.context?.provider && input.context.providerInstanceId)
        this.#db
          .prepare(
            "INSERT INTO watchdog_execution_provider (job_id, provider, provider_instance_id) VALUES (?, ?, ?)",
          )
          .run(input.id, input.context.provider, input.context.providerInstanceId);
      if (input.upgradeRoom) this.#insertUpgradeRoomJob({ ...input.upgradeRoom, jobId: input.id });
      return true;
    });
  }

  executionProvider(
    id: string,
  ): { readonly provider: string; readonly providerInstanceId: string } | undefined {
    const row = this.#db
      .prepare(
        "SELECT provider, provider_instance_id FROM watchdog_execution_provider WHERE job_id = ?",
      )
      .get(id) as { provider: string; provider_instance_id: string } | undefined;
    return row && { provider: row.provider, providerInstanceId: row.provider_instance_id };
  }

  get(id: string): WatchdogJournalJob | undefined {
    const row = this.#db
      .prepare("SELECT id, execution_id, thread_id, state FROM watchdog_jobs WHERE id = ?")
      .get(id) as JobRow | undefined;
    return row && fromRow(row);
  }

  /** Startup recovery must never discover or reattach a different conversation's job. */
  getByExecution(threadId: string, executionId: string): WatchdogJournalJob | undefined {
    const row = this.#db
      .prepare(
        "SELECT id, execution_id, thread_id, state FROM watchdog_jobs WHERE thread_id = ? AND execution_id = ?",
      )
      .get(threadId, executionId) as JobRow | undefined;
    return row && fromRow(row);
  }

  listActive(threadId: string): ReadonlyArray<WatchdogJournalJob> {
    const rows = this.#db
      .prepare(
        "SELECT id, execution_id, thread_id, state FROM watchdog_jobs WHERE thread_id = ? AND state IN ('pending', 'running', 'cancel-requested') ORDER BY rowid",
      )
      .all(threadId) as unknown as JobRow[];
    return rows.map(fromRow);
  }

  /** Stop requests are scoped to both the owning conversation and its run. */
  listActiveForRun(threadId: string, runId: string): ReadonlyArray<WatchdogJournalJob> {
    const rows = this.#db
      .prepare(`SELECT j.id, j.execution_id, j.thread_id, j.state FROM watchdog_jobs j
      JOIN watchdog_execution_context c ON c.job_id = j.id
      WHERE j.thread_id = ? AND c.run_id = ? AND j.state IN ('pending','running','cancel-requested') ORDER BY j.rowid`)
      .all(threadId, runId) as unknown as JobRow[];
    return rows.map(fromRow);
  }

  listReconciliationContexts(consumer: string): ReadonlyArray<{
    readonly id: string;
    readonly threadId: string;
    readonly runId: string;
  }> {
    if (!consumer) throw new Error("Watchdog consumer identity is required.");
    const rows = this.#db
      .prepare(`SELECT j.id, j.thread_id, c.run_id FROM watchdog_jobs j
      JOIN watchdog_execution_context c ON c.job_id = j.id
      WHERE j.state IN ('pending','running','cancel-requested')
        OR (NOT EXISTS (SELECT 1 FROM upgrade_room_finalizations f WHERE f.job_id = j.id)
          AND (NOT EXISTS (SELECT 1 FROM watchdog_stream_seals s WHERE s.job_id = j.id)
            OR EXISTS (SELECT 1 FROM watchdog_worker_outcomes o WHERE o.job_id = j.id
              AND o.outcome NOT IN ('completed','failed','cancelled'))))
        OR EXISTS (SELECT 1 FROM watchdog_events e WHERE e.job_id = j.id
          AND e.sequence > COALESCE((SELECT p.sequence FROM watchdog_cursors p
            WHERE p.job_id = j.id AND p.consumer = ?), 0))
        OR EXISTS (SELECT 1 FROM upgrade_room_jobs r WHERE r.job_id = j.id
            AND NOT EXISTS (SELECT 1 FROM upgrade_room_finalizations f WHERE f.job_id = r.job_id))
      ORDER BY j.rowid`)
      .all(consumer) as unknown as { id: string; thread_id: string; run_id: string }[];
    return rows.map((row) => ({ id: row.id, threadId: row.thread_id, runId: row.run_id }));
  }

  /** A run cannot dispatch another check while an earlier result is unresolved or unapplied. */
  listUnsettledForRun(
    threadId: string,
    runId: string,
    consumer: string,
  ): ReadonlyArray<WatchdogJournalJob> {
    if (!consumer) throw new Error("Watchdog consumer identity is required.");
    const rows = this.#db
      .prepare(`SELECT j.id, j.execution_id, j.thread_id, j.state FROM watchdog_jobs j
      JOIN watchdog_execution_context x ON x.job_id = j.id
      WHERE j.thread_id = ? AND x.run_id = ? AND (
        (NOT EXISTS (SELECT 1 FROM upgrade_room_finalizations f WHERE f.job_id = j.id)
          AND (NOT EXISTS (SELECT 1 FROM watchdog_stream_seals s WHERE s.job_id = j.id)
            OR EXISTS (SELECT 1 FROM watchdog_worker_outcomes o WHERE o.job_id = j.id
              AND o.outcome NOT IN ('completed','failed','cancelled'))))
         OR EXISTS (SELECT 1 FROM watchdog_events e WHERE e.job_id = j.id
           AND e.sequence > COALESCE((SELECT c.sequence FROM watchdog_cursors c
             WHERE c.job_id = j.id AND c.consumer = ?), 0))
         OR EXISTS (SELECT 1 FROM upgrade_room_jobs r WHERE r.job_id = j.id
             AND NOT EXISTS (SELECT 1 FROM upgrade_room_finalizations f WHERE f.job_id = r.job_id))
      ) ORDER BY j.rowid`)
      .all(threadId, runId, consumer) as unknown as JobRow[];
    return rows.map(fromRow);
  }

  /** Terminal jobs can still have unapplied or undrained events after a server restart. */
  listUnsealed(threadId: string): ReadonlyArray<WatchdogJournalJob> {
    const rows = this.#db
      .prepare(`SELECT id, execution_id, thread_id, state FROM watchdog_jobs j
        WHERE j.thread_id = ? AND NOT EXISTS (
          SELECT 1 FROM watchdog_stream_seals s WHERE s.job_id = j.id
        ) ORDER BY j.rowid`)
      .all(threadId) as unknown as JobRow[];
    return rows.map(fromRow);
  }

  /** A sealed stream can still contain events the consumer has not projected. */
  listNeedingReplay(threadId: string, consumer: string): ReadonlyArray<WatchdogJournalJob> {
    if (!consumer) throw new Error("Watchdog consumer identity is required.");
    const rows = this.#db
      .prepare(`SELECT id, execution_id, thread_id, state FROM watchdog_jobs j
        WHERE j.thread_id = ? AND (
          NOT EXISTS (SELECT 1 FROM watchdog_stream_seals s WHERE s.job_id = j.id)
          OR EXISTS (SELECT 1 FROM watchdog_events e WHERE e.job_id = j.id
            AND e.sequence > COALESCE((SELECT c.sequence FROM watchdog_cursors c
              WHERE c.job_id = j.id AND c.consumer = ?), 0))
        ) ORDER BY j.rowid`)
      .all(threadId, consumer) as unknown as JobRow[];
    return rows.map(fromRow);
  }

  /** At most one worker may start an execution; there is no implicit re-claim. */
  claim(id: string, capability: string): boolean {
    return this.#transaction(() => {
      if (this.#authorize(id, capability) !== "pending") return false;
      this.#db.prepare("UPDATE watchdog_jobs SET state = 'running' WHERE id = ?").run(id);
      return true;
    });
  }

  /** Atomically bind the one permitted claim to the process that made it. */
  claimWithWorker(
    id: string,
    capability: string,
    worker: Pick<WatchdogWorkerIdentity, "workerId" | "pid" | "startedAt"> & {
      readonly publicKey?: string;
    },
  ): boolean {
    if (
      !worker.workerId ||
      !Number.isSafeInteger(worker.pid) ||
      worker.pid < 1 ||
      !Number.isSafeInteger(worker.startedAt) ||
      worker.startedAt < 0
    )
      throw new Error("Invalid watchdog worker identity.");
    if (
      worker.publicKey !== undefined &&
      createPublicKey(worker.publicKey).asymmetricKeyType !== "ed25519"
    )
      throw new Error("Invalid watchdog attestation key.");
    return this.#transaction(() => {
      if (this.#authorize(id, capability) !== "pending") return false;
      this.#db
        .prepare(`INSERT INTO watchdog_workers
          (job_id, worker_id, pid, started_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?)`)
        .run(id, worker.workerId, worker.pid, worker.startedAt, worker.startedAt);
      if (worker.publicKey !== undefined)
        this.#db
          .prepare(
            "INSERT INTO watchdog_worker_keys (job_id, worker_id, public_key) VALUES (?, ?, ?)",
          )
          .run(id, worker.workerId, worker.publicKey);
      this.#db.prepare("UPDATE watchdog_jobs SET state = 'running' WHERE id = ?").run(id);
      return true;
    });
  }

  /** Challenge a bound worker. A heartbeat alone cannot establish that it still owns the session. */
  challengeWorker(
    id: string,
  ):
    | { readonly challengeId: string; readonly nonce: Uint8Array; readonly workerId: string }
    | undefined {
    return this.#transaction(() => {
      if (this.get(id)?.state !== "running" || this.workerOutcome(id)) return undefined;
      const key = this.#db
        .prepare("SELECT worker_id FROM watchdog_worker_keys WHERE job_id = ?")
        .get(id) as { worker_id: string } | undefined;
      if (!key) return undefined;
      const challengeId = randomUUID();
      const nonce = randomBytes(32);
      // Only the latest challenge can restore this worker, including across repeated restarts.
      this.#db.prepare("DELETE FROM watchdog_attestations WHERE job_id = ?").run(id);
      this.#db
        .prepare(
          "INSERT INTO watchdog_attestations (job_id, challenge_id, worker_id, nonce) VALUES (?, ?, ?, ?)",
        )
        .run(id, challengeId, key.worker_id, nonce);
      return { challengeId, nonce, workerId: key.worker_id };
    });
  }

  /** Bind the scoped MCP credential before launch; persist only its hash. */
  bindMcpCredential(
    id: string,
    capability: string,
    credential: Omit<WatchdogMcpCredential, "tokenHash"> & { readonly token: string },
  ): void {
    const {
      token,
      environmentId,
      ownerThreadId,
      sessionId,
      providerSessionId,
      providerInstanceId,
      issuedAt,
      runtimeMode,
      interactionMode,
      executionCwd,
    } = credential;
    if (
      token.length < 32 ||
      !environmentId ||
      !ownerThreadId ||
      !sessionId ||
      !providerSessionId ||
      !providerInstanceId ||
      !Number.isSafeInteger(issuedAt) ||
      issuedAt < 0
    )
      throw new Error("Invalid watchdog MCP credential.");
    this.#transaction(() => {
      const job = this.get(id);
      if (
        this.#authorize(id, capability) !== "pending" ||
        job?.threadId !== ownerThreadId ||
        job.executionId !== sessionId
      )
        throw new Error("Watchdog MCP credential does not match its pending execution.");
      this.#db
        .prepare(`INSERT INTO watchdog_mcp_credentials
        (job_id, token_hash, environment_id, owner_thread_id, session_id, provider_session_id, provider_instance_id, issued_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          digest(token),
          environmentId,
          ownerThreadId,
          sessionId,
          providerSessionId,
          providerInstanceId,
          issuedAt,
        );
      if (runtimeMode === "full-access" && interactionMode === "default")
        this.#db
          .prepare("INSERT INTO watchdog_mcp_creator_policy (job_id, execution_cwd) VALUES (?, ?)")
          .run(id, executionCwd ?? null);
    });
  }

  pendingAttestations(
    id: string,
    capability: string,
    workerId: string,
  ): ReadonlyArray<{ readonly challengeId: string; readonly nonce: Uint8Array }> {
    if (this.#authorize(id, capability) !== "running" || this.worker(id)?.workerId !== workerId)
      return [];
    const rows = this.#db
      .prepare(
        "SELECT challenge_id, nonce FROM watchdog_attestations WHERE job_id = ? AND worker_id = ? AND signature IS NULL ORDER BY rowid LIMIT 32",
      )
      .all(id, workerId) as unknown as { challenge_id: string; nonce: Uint8Array }[];
    return rows.map((row) => ({ challengeId: row.challenge_id, nonce: row.nonce }));
  }

  respondAttestation(
    id: string,
    capability: string,
    workerId: string,
    challengeId: string,
    signature: Uint8Array,
  ): boolean {
    return this.#transaction(() => {
      if (this.#authorize(id, capability) !== "running" || this.worker(id)?.workerId !== workerId)
        return false;
      return (
        this.#db
          .prepare(
            "UPDATE watchdog_attestations SET signature = ? WHERE job_id = ? AND worker_id = ? AND challenge_id = ? AND signature IS NULL",
          )
          .run(signature, id, workerId, challengeId).changes === 1
      );
    });
  }

  #consumeAttestation(
    id: string,
    challenge: {
      readonly challengeId: string;
      readonly nonce: Uint8Array;
      readonly workerId: string;
    },
  ): boolean {
    const row = this.#db
      .prepare(`SELECT a.nonce, a.signature, k.public_key FROM watchdog_attestations a
        JOIN watchdog_worker_keys k ON k.job_id = a.job_id AND k.worker_id = a.worker_id
        WHERE a.job_id = ? AND a.challenge_id = ? AND a.worker_id = ?`)
      .get(id, challenge.challengeId, challenge.workerId) as
      | { nonce: Uint8Array; signature: Uint8Array | null; public_key: string }
      | undefined;
    if (!row?.signature) return false;
    this.#db
      .prepare("DELETE FROM watchdog_attestations WHERE job_id = ? AND challenge_id = ?")
      .run(id, challenge.challengeId);
    if (
      this.get(id)?.state !== "running" ||
      this.workerOutcome(id) ||
      row.nonce.byteLength !== challenge.nonce.byteLength ||
      !timingSafeEqual(row.nonce, challenge.nonce)
    )
      return false;
    return verify(
      null,
      watchdogAttestationMessage(id, challenge.workerId, challenge.challengeId, challenge.nonce),
      row.public_key,
      row.signature,
    );
  }

  /** A challenge is single-use. Only the worker's unpersisted private key can answer it. */
  verifyAttestation(
    id: string,
    challenge: {
      readonly challengeId: string;
      readonly nonce: Uint8Array;
      readonly workerId: string;
    },
  ): boolean {
    return this.#transaction(() => this.#consumeAttestation(id, challenge));
  }

  /** Release the scope only when the active worker proves ownership of its private key. */
  consumeAttestedMcpCredential(
    id: string,
    challenge: {
      readonly challengeId: string;
      readonly nonce: Uint8Array;
      readonly workerId: string;
    },
  ): WatchdogMcpCredential | undefined {
    return this.#transaction(() => {
      if (!this.#consumeAttestation(id, challenge)) return undefined;
      const row = this.#db
        .prepare(`SELECT token_hash, environment_id, owner_thread_id, session_id,
        provider_session_id, provider_instance_id, issued_at FROM watchdog_mcp_credentials WHERE job_id = ?`)
        .get(id) as
        | {
            token_hash: Uint8Array;
            environment_id: string;
            owner_thread_id: string;
            session_id: string;
            provider_session_id: string;
            provider_instance_id: string;
            issued_at: number;
          }
        | undefined;
      const policy = this.#db
        .prepare("SELECT execution_cwd FROM watchdog_mcp_creator_policy WHERE job_id = ?")
        .get(id) as { execution_cwd: string | null } | undefined;
      return (
        row && {
          tokenHash: row.token_hash,
          environmentId: row.environment_id,
          ownerThreadId: row.owner_thread_id,
          sessionId: row.session_id,
          providerSessionId: row.provider_session_id,
          providerInstanceId: row.provider_instance_id,
          issuedAt: row.issued_at,
          ...(policy
            ? { runtimeMode: "full-access" as const, interactionMode: "default" as const }
            : {}),
          ...(policy?.execution_cwd ? { executionCwd: policy.execution_cwd } : {}),
        }
      );
    });
  }

  /** Check the bound execution again for every use of a restored credential. */
  activeMcpCredential(id: string, workerId: string): boolean {
    return (
      this.get(id)?.state === "running" &&
      this.worker(id)?.workerId === workerId &&
      !this.workerOutcome(id) &&
      !this.isSealed(id) &&
      this.#db.prepare("SELECT 1 FROM watchdog_mcp_credentials WHERE job_id = ?").get(id) !==
        undefined
    );
  }

  /** A known bearer hash may wait for proof; the hash alone never grants authority. */
  recoverableMcpCredential(
    tokenHash: Uint8Array,
    environmentId: string,
    now: number,
    livenessWindowMs: number,
  ): boolean {
    const row = this.#db
      .prepare(
        "SELECT job_id FROM watchdog_mcp_credentials WHERE token_hash = ? AND environment_id = ?",
      )
      .get(tokenHash, environmentId) as { job_id: string } | undefined;
    if (!row) return false;
    const worker = this.worker(row.job_id);
    return (
      worker !== undefined &&
      this.activeMcpCredential(row.job_id, worker.workerId) &&
      now >= worker.lastHeartbeatAt &&
      now - worker.lastHeartbeatAt <= livenessWindowMs
    );
  }

  /** An old heartbeat is not proof of exit; never retry solely because it is stale. */
  heartbeat(id: string, capability: string, workerId: string, observedAt: number): boolean {
    if (!workerId || !Number.isSafeInteger(observedAt) || observedAt < 0)
      throw new Error("Invalid watchdog heartbeat.");
    return this.#transaction(() => {
      this.#authorize(id, capability);
      if (this.isSealed(id)) return false;
      return (
        this.#db
          .prepare(`UPDATE watchdog_workers SET last_heartbeat_at = MAX(last_heartbeat_at, ?)
            WHERE job_id = ? AND worker_id = ?`)
          .run(observedAt, id, workerId).changes === 1
      );
    });
  }

  worker(id: string): WatchdogWorkerIdentity | undefined {
    const row = this.#db
      .prepare(`SELECT worker_id, pid, started_at, last_heartbeat_at FROM watchdog_workers
        WHERE job_id = ?`)
      .get(id) as
      | { worker_id: string; pid: number; started_at: number; last_heartbeat_at: number }
      | undefined;
    return (
      row && {
        workerId: row.worker_id,
        pid: row.pid,
        startedAt: row.started_at,
        lastHeartbeatAt: row.last_heartbeat_at,
      }
    );
  }

  /** Records the worker's own final result; uncertainty is not a retry authorization. */
  recordWorkerOutcome(
    id: string,
    capability: string,
    workerId: string,
    outcome: WatchdogWorkerOutcome,
    recordedAt: number,
  ): void {
    if (!workerId || !Number.isSafeInteger(recordedAt) || recordedAt < 0)
      throw new Error("Invalid watchdog worker outcome.");
    this.#transaction(() => {
      this.#authorize(id, capability);
      if (this.worker(id)?.workerId !== workerId)
        throw new Error("Watchdog worker does not match.");
      const previous = this.workerOutcome(id);
      if (previous) {
        if (previous.workerId !== workerId || previous.outcome !== outcome)
          throw new Error("Watchdog worker outcome already differs.");
        return;
      }
      if (
        (outcome === "completed" || outcome === "failed" || outcome === "cancelled") &&
        (!this.isSealed(id) || this.get(id)?.state !== outcome)
      )
        throw new Error("Watchdog terminal outcome requires a matching sealed stream.");
      this.#db
        .prepare(`INSERT INTO watchdog_worker_outcomes (job_id, worker_id, outcome, recorded_at)
          VALUES (?, ?, ?, ?)`)
        .run(id, workerId, outcome, recordedAt);
    });
  }

  /**
   * The backend's own observation that the claimed worker's process is gone while its stream
   * was never closed. Whatever the worker managed to record stays; what is missing is filled
   * in: an outcome if it left none, a terminal state if the job still reads as live. The turn
   * is never submitted again.
   */
  recordWorkerExit(id: string, workerId: string, recordedAt: number): boolean {
    if (!workerId || !Number.isSafeInteger(recordedAt) || recordedAt < 0)
      throw new Error("Invalid watchdog worker exit.");
    return this.#transaction(() => {
      const state = this.get(id)?.state;
      if (
        !state ||
        state === "pending" ||
        this.worker(id)?.workerId !== workerId ||
        this.isSealed(id)
      )
        return false;
      const live = state === "running" || state === "cancel-requested";
      const recorded = this.workerOutcome(id) !== undefined;
      if (recorded && !live) return false;
      if (!recorded)
        this.#db
          .prepare(`INSERT INTO watchdog_worker_outcomes (job_id, worker_id, outcome, recorded_at)
            VALUES (?, ?, 'worker-error', ?)`)
          .run(id, workerId, recordedAt);
      if (live)
        this.#db
          .prepare("UPDATE watchdog_jobs SET state = ? WHERE id = ?")
          .run(state === "running" ? "failed" : "cancelled", id);
      return true;
    });
  }

  workerOutcome(id: string):
    | {
        readonly workerId: string;
        readonly outcome: WatchdogWorkerOutcome;
        readonly recordedAt: number;
      }
    | undefined {
    const row = this.#db
      .prepare(
        "SELECT worker_id, outcome, recorded_at FROM watchdog_worker_outcomes WHERE job_id = ?",
      )
      .get(id) as
      | { worker_id: string; outcome: WatchdogWorkerOutcome; recorded_at: number }
      | undefined;
    return row && { workerId: row.worker_id, outcome: row.outcome, recordedAt: row.recorded_at };
  }

  requestCancel(id: string): WatchdogJobState | undefined {
    return this.#transaction(() => {
      const job = this.get(id);
      if (!job || terminal.has(job.state) || job.state === "cancel-requested") return job?.state;
      const state = job.state === "pending" ? "cancelled" : "cancel-requested";
      this.#db.prepare("UPDATE watchdog_jobs SET state = ? WHERE id = ?").run(state, id);
      return state;
    });
  }

  /** Serialize the final submit decision against cancellation; a claim is never replayed. */
  beginSubmission(id: string, capability: string): boolean {
    return this.#transaction(() => {
      if (this.#authorize(id, capability) !== "running") return false;
      const inserted = this.#db
        .prepare("INSERT OR IGNORE INTO watchdog_submissions (job_id, state) VALUES (?, 'sending')")
        .run(id);
      return inserted.changes === 1;
    });
  }

  settleSubmission(id: string, capability: string, state: "accepted" | "unknown"): void {
    this.#transaction(() => {
      this.#authorize(id, capability);
      const updated = this.#db
        .prepare("UPDATE watchdog_submissions SET state = ? WHERE job_id = ? AND state = 'sending'")
        .run(state, id);
      if (updated.changes !== 1) throw new Error("Watchdog submission is not in flight.");
    });
  }

  getSubmission(id: string): "sending" | "accepted" | "unknown" | undefined {
    const row = this.#db
      .prepare("SELECT state FROM watchdog_submissions WHERE job_id = ?")
      .get(id) as { state: "sending" | "accepted" | "unknown" } | undefined;
    return row?.state;
  }

  /** Called only after the worker has drained and closed its provider event stream. */
  seal(id: string, capability: string): void {
    this.#transaction(() => {
      if (!terminal.has(this.#authorize(id, capability)))
        throw new Error("Watchdog stream cannot close before its terminal receipt.");
      this.#db.prepare("INSERT OR IGNORE INTO watchdog_stream_seals (job_id) VALUES (?)").run(id);
    });
  }

  isSealed(id: string): boolean {
    return (
      this.#db.prepare("SELECT 1 FROM watchdog_stream_seals WHERE job_id = ?").get(id) !== undefined
    );
  }

  hasAssistantOutputBefore(id: string, sequence: number): boolean {
    const row = this.#db
      .prepare(`SELECT 1 FROM watchdog_events WHERE job_id = ? AND sequence < ? AND json_valid(payload) AND (
      (kind = 'content.delta' AND json_extract(payload, '$.payload.streamKind') = 'assistant_text' AND length(json_extract(payload, '$.payload.delta')) > 0)
      OR (kind = 'item.completed' AND json_extract(payload, '$.payload.itemType') = 'assistant_message' AND length(json_extract(payload, '$.payload.detail')) > 0)
      ) LIMIT 1`)
      .get(id, sequence);
    return row !== undefined;
  }

  /** A stop attempt that may have reached the provider is not silently repeated. */
  takeStop(id: string, capability: string, attempt: string): boolean {
    if (!attempt) throw new Error("Watchdog stop attempt identity is required.");
    return this.#transaction(() => {
      if (this.#authorize(id, capability) !== "cancel-requested") return false;
      const inserted = this.#db
        .prepare(
          "INSERT OR IGNORE INTO watchdog_stops (job_id, attempt, state) VALUES (?, ?, 'sending')",
        )
        .run(id, attempt);
      return inserted.changes === 1;
    });
  }

  settleStop(id: string, capability: string, attempt: string, outcome: "sent" | "unknown"): void {
    this.#transaction(() => {
      this.#authorize(id, capability);
      const updated = this.#db
        .prepare(
          "UPDATE watchdog_stops SET state = ? WHERE job_id = ? AND attempt = ? AND state = 'sending'",
        )
        .run(outcome, id, attempt);
      if (updated.changes !== 1) throw new Error("Watchdog stop attempt does not match.");
    });
  }

  getStop(
    id: string,
  ): { readonly attempt: string; readonly state: "sending" | "sent" | "unknown" } | undefined {
    return this.#db
      .prepare("SELECT attempt, state FROM watchdog_stops WHERE job_id = ?")
      .get(id) as { attempt: string; state: "sending" | "sent" | "unknown" } | undefined;
  }

  /** Queue an interactive answer once. Its payload must never contain provider credentials. */
  enqueueControl(id: string, command: Pick<WatchdogControl, "id" | "kind" | "payload">): void {
    if (!command.id) throw new Error("Watchdog control identity is required.");
    this.#transaction(() => {
      const previous = this.getControl(id, command.id);
      if (previous) {
        if (previous.kind !== command.kind || previous.payload !== command.payload)
          throw new Error("Watchdog control id was reused with different content.");
        return;
      }
      if (this.get(id)?.state !== "running")
        throw new Error("Watchdog job is not accepting controls.");
      this.#db
        .prepare(
          "INSERT INTO watchdog_controls (job_id, id, kind, payload, state) VALUES (?, ?, ?, ?, 'queued')",
        )
        .run(id, command.id, command.kind, command.payload);
    });
  }

  getControl(id: string, controlId: string): WatchdogControl | undefined {
    const row = this.#db
      .prepare(
        "SELECT id, kind, payload, state, attempt FROM watchdog_controls WHERE job_id = ? AND id = ?",
      )
      .get(id, controlId) as WatchdogControl | undefined;
    return row;
  }

  /** A sending control is never automatically reclaimed after a crash. */
  takeControl(id: string, capability: string, attempt: string): WatchdogControl | undefined {
    if (!attempt) throw new Error("Watchdog delivery attempt identity is required.");
    return this.#transaction(() => {
      if (this.#authorize(id, capability) !== "running") return undefined;
      const control = this.#db
        .prepare(
          "SELECT id, kind, payload, state, attempt FROM watchdog_controls WHERE job_id = ? AND state IN ('queued', 'sending', 'unknown') ORDER BY sequence LIMIT 1",
        )
        .get(id) as WatchdogControl | undefined;
      if (!control || control.state !== "queued") return undefined;
      this.#db
        .prepare(
          "UPDATE watchdog_controls SET state = 'sending', attempt = ? WHERE job_id = ? AND id = ?",
        )
        .run(attempt, id, control.id);
      return { ...control, state: "sending", attempt };
    });
  }

  settleControl(
    id: string,
    capability: string,
    controlId: string,
    attempt: string,
    outcome: "accepted" | "rejected" | "unknown",
  ): void {
    this.#transaction(() => {
      this.#authorize(id, capability);
      const control = this.getControl(id, controlId);
      if (!control || control.attempt !== attempt)
        throw new Error("Watchdog control delivery attempt does not match.");
      if (control.state === outcome) return;
      if (control.state !== "sending") throw new Error("Watchdog control is not being delivered.");
      this.#db
        .prepare("UPDATE watchdog_controls SET state = ? WHERE job_id = ? AND id = ?")
        .run(outcome, id, controlId);
    });
  }

  /** Identical event replay is safe; reusing an event id for different content is an error. */
  #writeEvent(
    id: string,
    state: WatchdogJobState,
    event: JournalReceipt,
    allowLate = false,
  ): number {
    if (!event.id || !event.kind) throw new Error("Watchdog event identity and kind are required.");
    const previous = this.#db
      .prepare("SELECT sequence, kind, payload FROM watchdog_events WHERE job_id = ? AND id = ?")
      .get(id, event.id) as { sequence: number; kind: string; payload: string } | undefined;
    if (previous) {
      if (previous.kind !== event.kind || previous.payload !== event.payload)
        throw new Error("Watchdog event id was reused with different content.");
      return previous.sequence;
    }
    const lateEvent =
      allowLate &&
      terminal.has(state) &&
      !this.isSealed(id) &&
      !this.#db.prepare("SELECT 1 FROM upgrade_room_finalizations WHERE job_id = ?").get(id);
    if (state !== "running" && state !== "cancel-requested" && !lateEvent)
      throw new Error("Watchdog job is not running.");
    const inserted = this.#db
      .prepare("INSERT INTO watchdog_events (job_id, id, kind, payload) VALUES (?, ?, ?, ?)")
      .run(id, event.id, event.kind, event.payload);
    return Number(inserted.lastInsertRowid);
  }

  append(id: string, capability: string, event: JournalReceipt): number {
    return this.#transaction(() =>
      this.#writeEvent(id, this.#authorize(id, capability), event, true),
    );
  }

  /** Atomically preserve the actual receipt and state, including outcomes after a stop request. */
  finish(
    id: string,
    capability: string,
    outcome: "completed" | "failed" | "cancelled",
    receipt: JournalReceipt,
  ): void {
    this.#transaction(() => {
      const state = this.#authorize(id, capability);
      if (state === outcome) {
        this.#writeEvent(id, state, receipt);
        return;
      }
      if (state !== "running" && state !== "cancel-requested")
        throw new Error("Watchdog job cannot accept this terminal receipt.");
      this.#writeEvent(id, state, receipt);
      this.#db.prepare("UPDATE watchdog_jobs SET state = ? WHERE id = ?").run(outcome, id);
    });
  }

  read(id: string, after: number, limit = 100): ReadonlyArray<WatchdogJournalEvent> {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new Error("Invalid watchdog event cursor or limit.");
    return this.#db
      .prepare(
        "SELECT sequence, id, kind, payload FROM watchdog_events WHERE job_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
      )
      .all(id, after, limit) as unknown as WatchdogJournalEvent[];
  }

  cursor(id: string, consumer: string): number {
    const row = this.#db
      .prepare("SELECT sequence FROM watchdog_cursors WHERE job_id = ? AND consumer = ?")
      .get(id, consumer) as { sequence: number } | undefined;
    return row?.sequence ?? 0;
  }

  acknowledge(id: string, consumer: string, sequence: number): void {
    if (!consumer || !Number.isSafeInteger(sequence) || sequence < 1)
      throw new Error("Invalid watchdog acknowledgment.");
    this.#transaction(() => {
      const event = this.#db
        .prepare("SELECT sequence FROM watchdog_events WHERE job_id = ? AND sequence = ?")
        .get(id, sequence);
      if (!event) throw new Error("Watchdog event does not exist in this job.");
      this.#db
        .prepare(`INSERT INTO watchdog_cursors (job_id, consumer, sequence) VALUES (?, ?, ?)
        ON CONFLICT(job_id, consumer) DO UPDATE SET sequence = MAX(sequence, excluded.sequence)`)
        .run(id, consumer, sequence);
    });
  }

  /** Room metadata is written by the backend before spawn; the worker only reads it. */
  createUpgradeRoomJob(input: UpgradeRoomJobRecord): void {
    this.#transaction(() => this.#insertUpgradeRoomJob(input));
  }

  #insertUpgradeRoomJob(input: UpgradeRoomJobRecord): void {
    if (
      !input.jobId ||
      !input.turnEventId ||
      !Number.isSafeInteger(input.turnSequence) ||
      input.turnSequence < 0 ||
      !Number.isSafeInteger(input.createdAt) ||
      input.createdAt < 0
    )
      throw new Error("Invalid upgrade room job.");
    if (!this.get(input.jobId)) throw new Error("Upgrade room job has no watchdog execution.");
    this.#db
      .prepare(`INSERT OR IGNORE INTO upgrade_room_jobs
          (job_id, turn_event_id, turn_sequence, request, offline_questions, continuity, projection, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.jobId,
        input.turnEventId,
        input.turnSequence,
        input.request,
        input.offlineQuestions,
        input.continuity,
        input.projection,
        input.createdAt,
      );
  }

  completeUpgradeRoomFinalization(jobId: string): void {
    if (!this.isSealed(jobId)) throw new Error("Room finalization requires a closed stream.");
    this.#db
      .prepare("INSERT OR IGNORE INTO upgrade_room_finalizations (job_id) VALUES (?)")
      .run(jobId);
  }

  /** Retire a room job whose worker returned after its terminal receipt, without claiming a clean drain. */
  finalizeUncertainUpgradeRoomJob(jobId: string, consumer: string): boolean {
    return this.#transaction(() => {
      const job = this.get(jobId);
      if (
        !job ||
        !terminal.has(job.state) ||
        !this.upgradeRoomJob(jobId) ||
        !this.workerOutcome(jobId)
      )
        return false;
      if (this.read(jobId, this.cursor(jobId, consumer), 1).length > 0) return false;
      this.#db
        .prepare("INSERT OR IGNORE INTO upgrade_room_finalizations (job_id) VALUES (?)")
        .run(jobId);
      return true;
    });
  }

  /** Only a process that has not claimed the job can be expired without assuming delivery. */
  expireUnclaimedUpgradeRoomJob(jobId: string, olderThan: number): boolean {
    return this.#transaction(() => {
      const updated = this.#db
        .prepare(`UPDATE watchdog_jobs SET state = 'cancelled'
        WHERE id = ? AND state IN ('pending', 'cancelled')
          AND NOT EXISTS (SELECT 1 FROM watchdog_workers w WHERE w.job_id = watchdog_jobs.id)
          AND NOT EXISTS (SELECT 1 FROM watchdog_submissions s WHERE s.job_id = watchdog_jobs.id)
          AND NOT EXISTS (SELECT 1 FROM watchdog_stream_seals s WHERE s.job_id = watchdog_jobs.id)
          AND EXISTS (SELECT 1 FROM upgrade_room_jobs r WHERE r.job_id = watchdog_jobs.id AND r.created_at <= ?)`)
        .run(jobId, olderThan);
      if (updated.changes !== 1) return false;
      this.#db.prepare("INSERT INTO watchdog_stream_seals (job_id) VALUES (?)").run(jobId);
      return true;
    });
  }

  upgradeRoomJob(jobId: string): UpgradeRoomJobRecord | undefined {
    const row = this.#db
      .prepare(`SELECT job_id, turn_event_id, turn_sequence, request, offline_questions, continuity,
        projection, created_at FROM upgrade_room_jobs WHERE job_id = ?`)
      .get(jobId) as UpgradeRoomJobRow | undefined;
    return row && fromUpgradeRoomRow(row);
  }

  listUpgradeRoomJobs(): ReadonlyArray<UpgradeRoomJobRecord> {
    const rows = this.#db
      .prepare(`SELECT job_id, turn_event_id, turn_sequence, request, offline_questions, continuity,
        projection, created_at FROM upgrade_room_jobs ORDER BY created_at, rowid`)
      .all() as unknown as UpgradeRoomJobRow[];
    return rows.map(fromUpgradeRoomRow);
  }

  /** The most recent room job and the cursor its worker recorded, if any. */
  latestUpgradeRoomResume():
    | {
        readonly jobId: string;
        readonly providerInstanceId?: string;
        readonly cursor?: string;
      }
    | undefined {
    const row = this.#db
      .prepare(`SELECT r.job_id, c.provider_instance_id, c.cursor FROM upgrade_room_jobs r
        LEFT JOIN upgrade_room_resume_cursors c ON c.job_id = r.job_id
          AND NOT EXISTS (SELECT 1 FROM watchdog_worker_outcomes o WHERE o.job_id = r.job_id
            AND o.outcome NOT IN ('completed','failed','cancelled'))
        ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`)
      .get() as
      | { job_id: string; provider_instance_id: string | null; cursor: string | null }
      | undefined;
    return (
      row && {
        jobId: row.job_id,
        ...(row.provider_instance_id === null
          ? {}
          : { providerInstanceId: row.provider_instance_id }),
        ...(row.cursor === null ? {} : { cursor: row.cursor }),
      }
    );
  }

  /** A filesystem/chat rewind invalidates the provider conversation that ran past it. */
  clearUpgradeRoomResumeCursors(): void {
    this.#db.exec("DELETE FROM upgrade_room_resume_cursors");
  }

  // A rewind belongs to this backend, not the detached worker. The room journal
  // instance is shared by both backend reactors; a restart releases this latch.
  #roomRewind: ReturnType<typeof Promise.withResolvers<void>> | undefined;

  tryBeginUpgradeRoomRewind(input: {
    readonly threadId: string;
    readonly runId: string;
    readonly consumer: string;
    readonly jobIdForTurn: (eventId: string) => string;
  }): boolean {
    if (
      this.#roomRewind ||
      this.listUnsettledForRun(input.threadId, input.runId, input.consumer).length > 0 ||
      this.listPendingUpgradeRoomTurns(input.jobIdForTurn).length > 0
    )
      return false;
    this.#roomRewind = Promise.withResolvers<void>();
    return true;
  }

  upgradeRoomRewindPending(): Promise<void> | undefined {
    return this.#roomRewind?.promise;
  }

  endUpgradeRoomRewind(): void {
    const rewind = this.#roomRewind;
    this.#roomRewind = undefined;
    rewind?.resolve();
  }

  /** Recorded by the worker before it stops its provider session. */
  recordUpgradeRoomResumeCursor(
    jobId: string,
    capability: string,
    input: {
      readonly providerInstanceId: string;
      readonly cursor: string;
      readonly recordedAt: number;
    },
  ): void {
    if (
      !input.providerInstanceId ||
      !Number.isSafeInteger(input.recordedAt) ||
      input.recordedAt < 0
    )
      throw new Error("Invalid upgrade room resume cursor.");
    this.#transaction(() => {
      this.#authorize(jobId, capability);
      this.#db
        .prepare(`INSERT INTO upgrade_room_resume_cursors (job_id, provider_instance_id, cursor, recorded_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET
          provider_instance_id = excluded.provider_instance_id, cursor = excluded.cursor,
          recorded_at = excluded.recorded_at`)
        .run(jobId, input.providerInstanceId, input.cursor, input.recordedAt);
    });
  }

  recordUpgradeRoomQuestion(
    jobId: string,
    capability: string,
    input: Omit<UpgradeRoomQuestionRecord, "jobId">,
  ): void {
    if (
      !input.requestId ||
      !input.questionId ||
      !Number.isSafeInteger(input.recordedAt) ||
      input.recordedAt < 0
    )
      throw new Error("Invalid upgrade room question.");
    this.#transaction(() => {
      this.#authorize(jobId, capability);
      this.#db
        .prepare(`INSERT OR IGNORE INTO upgrade_room_questions
          (job_id, request_id, question_id, question, handled_as, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          jobId,
          input.requestId,
          input.questionId,
          input.question,
          input.handledAs,
          input.recordedAt,
        );
    });
  }

  listUpgradeRoomQuestions(jobId: string): ReadonlyArray<UpgradeRoomQuestionRecord> {
    const rows = this.#db
      .prepare(`SELECT job_id, request_id, question_id, question, handled_as, recorded_at
        FROM upgrade_room_questions WHERE job_id = ? ORDER BY recorded_at, rowid`)
      .all(jobId) as unknown as {
      job_id: string;
      request_id: string;
      question_id: string;
      question: string;
      handled_as: "decided" | "waiting";
      recorded_at: number;
    }[];
    return rows.map((row) => ({
      jobId: row.job_id,
      requestId: row.request_id,
      questionId: row.question_id,
      question: row.question,
      handledAs: row.handled_as,
      recordedAt: row.recorded_at,
    }));
  }

  writeUpgradeRoomBackendHeartbeat(observedAt: number): void {
    if (!Number.isSafeInteger(observedAt) || observedAt < 0)
      throw new Error("Invalid upgrade room heartbeat.");
    this.#db
      .prepare(`INSERT INTO upgrade_room_backend_heartbeat (id, observed_at) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET observed_at = MAX(observed_at, excluded.observed_at)`)
      .run(observedAt);
  }

  upgradeRoomBackendHeartbeat(): number | undefined {
    const row = this.#db
      .prepare("SELECT observed_at FROM upgrade_room_backend_heartbeat WHERE id = 1")
      .get() as { observed_at: number } | undefined;
    return row?.observed_at;
  }

  /** An existing row keeps its state; a turn is admitted at most once. */
  admitUpgradeRoomTurn(input: {
    readonly turnEventId: string;
    readonly eventSequence: number;
    readonly messageId: string;
    readonly queuedAt: number;
    /** `dropped` records a room turn that was handled without a detached job. */
    readonly state: "queued" | "started" | "dropped";
  }): void {
    if (
      !input.turnEventId ||
      !Number.isSafeInteger(input.eventSequence) ||
      input.eventSequence < 0 ||
      !Number.isSafeInteger(input.queuedAt) ||
      input.queuedAt < 0
    )
      throw new Error("Invalid upgrade room turn.");
    this.#db
      .prepare(`INSERT OR IGNORE INTO upgrade_room_queue
        (turn_event_id, event_sequence, message_id, queued_at, state) VALUES (?, ?, ?, ?, ?)`)
      .run(input.turnEventId, input.eventSequence, input.messageId, input.queuedAt, input.state);
  }

  upgradeRoomTurnState(turnEventId: string): "queued" | "started" | "dropped" | undefined {
    const row = this.#db
      .prepare("SELECT state FROM upgrade_room_queue WHERE turn_event_id = ?")
      .get(turnEventId) as { state: "queued" | "started" | "dropped" } | undefined;
    return row?.state;
  }

  settleUpgradeRoomTurn(turnEventId: string, state: "queued" | "started" | "dropped"): void {
    this.#db
      .prepare(
        "UPDATE upgrade_room_queue SET state = ? WHERE turn_event_id = ? AND state != 'dropped'",
      )
      .run(state, turnEventId);
  }

  /** Admitted turns whose watchdog job was never created, oldest first. */
  listPendingUpgradeRoomTurns(
    jobIdFor: (turnEventId: string) => string,
  ): ReadonlyArray<UpgradeRoomQueuedTurn> {
    const rows = this.#db
      .prepare(`SELECT turn_event_id, event_sequence, message_id, queued_at, state FROM upgrade_room_queue
        WHERE state IN ('queued','started') ORDER BY event_sequence`)
      .all() as unknown as {
      turn_event_id: string;
      event_sequence: number;
      message_id: string;
      queued_at: number;
      state: "queued" | "started";
    }[];
    return rows
      .filter((row) => this.get(jobIdFor(row.turn_event_id)) === undefined)
      .map((row) => ({
        turnEventId: row.turn_event_id,
        eventSequence: row.event_sequence,
        messageId: row.message_id,
        queuedAt: row.queued_at,
        state: row.state,
      }));
  }

  latestUpgradeRoomTurnSequence(): number | undefined {
    const row = this.#db
      .prepare(`SELECT MAX(s) AS latest FROM (
        SELECT MAX(event_sequence) AS s FROM upgrade_room_queue
        UNION ALL SELECT MAX(turn_sequence) AS s FROM upgrade_room_jobs)`)
      .get() as { latest: number | null } | undefined;
    return row?.latest ?? undefined;
  }
}

export interface UpgradeRoomJobRecord {
  readonly jobId: string;
  readonly turnEventId: string;
  readonly turnSequence: number;
  readonly request: string;
  readonly offlineQuestions: "decide" | "wait";
  readonly continuity: "resumed" | "fresh";
  /** JSON written and read by the backend to rebuild the conversation projection. */
  readonly projection: string;
  readonly createdAt: number;
}

export interface UpgradeRoomQuestionRecord {
  readonly jobId: string;
  readonly requestId: string;
  readonly questionId: string;
  readonly question: string;
  readonly handledAs: "decided" | "waiting";
  readonly recordedAt: number;
}

export interface UpgradeRoomQueuedTurn {
  readonly turnEventId: string;
  readonly eventSequence: number;
  readonly messageId: string;
  readonly queuedAt: number;
  readonly state: "queued" | "started";
}

type UpgradeRoomJobRow = {
  job_id: string;
  turn_event_id: string;
  turn_sequence: number;
  request: string;
  offline_questions: "decide" | "wait";
  continuity: "resumed" | "fresh";
  projection: string;
  created_at: number;
};
const fromUpgradeRoomRow = (row: UpgradeRoomJobRow): UpgradeRoomJobRecord => ({
  jobId: row.job_id,
  turnEventId: row.turn_event_id,
  turnSequence: row.turn_sequence,
  request: row.request,
  offlineQuestions: row.offline_questions,
  continuity: row.continuity,
  projection: row.projection,
  createdAt: row.created_at,
});
