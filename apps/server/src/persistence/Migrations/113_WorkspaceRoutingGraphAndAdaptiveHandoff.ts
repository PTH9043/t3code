import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Migration 113 — Disk-Resident Zero-Heap Routing Graph (`WITHOUT ROWID` + `fts5vocab`)
 * and Read-Only Operational Telemetry Audit Views.
 *
 * Keeps all graph topology on SQLite disk B-Trees (`0 MB` extra V8 heap) while
 * enabling sub-10ms 2-Hop Truncated Push PPR routing and deterministic SHA-256
 * staleness propagation (`VALID` / `SUSPECT` / `STALE`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS workspace_routing_nodes (
    node_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT NOT NULL,
    node_kind       INTEGER NOT NULL,
    canonical_key   TEXT NOT NULL,
    title           TEXT NOT NULL,
    summary_moc     TEXT NOT NULL,
    body_markdown   TEXT NOT NULL DEFAULT '',
    body_ref_kind   TEXT,
    body_ref_id     TEXT,
    epistemic_state TEXT NOT NULL DEFAULT 'fact',
    stale_status    INTEGER NOT NULL DEFAULT 0,
    file_path       TEXT,
    start_line      INTEGER,
    end_line        INTEGER,
    blob_sha256     TEXT,
    updated_at_ms   INTEGER NOT NULL,
    UNIQUE (project_id, node_kind, canonical_key)
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_routing_nodes_project_kind
    ON workspace_routing_nodes(project_id, node_kind, updated_at_ms DESC)`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_routing_nodes_file_path
    ON workspace_routing_nodes(project_id, file_path)
    WHERE file_path IS NOT NULL`;

  // Forward adjacency clustered B-Tree (WITHOUT ROWID -> ~36 bytes/edge, zero secondary lookup).
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_routing_edges (
    project_id     TEXT NOT NULL,
    src_id         INTEGER NOT NULL,
    edge_type      INTEGER NOT NULL,
    dst_id         INTEGER NOT NULL,
    weight         REAL NOT NULL DEFAULT 1.0,
    valid_from_ms  INTEGER,
    valid_to_ms    INTEGER,
    PRIMARY KEY (project_id, src_id, edge_type, dst_id)
  ) WITHOUT ROWID`;

  // Reverse adjacency clustered B-Tree for instant 1-Hop/2-Hop backlinks & SHA-256 staleness propagation.
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_routing_edges_rev (
    project_id     TEXT NOT NULL,
    dst_id         INTEGER NOT NULL,
    edge_type      INTEGER NOT NULL,
    src_id         INTEGER NOT NULL,
    weight         REAL NOT NULL DEFAULT 1.0,
    valid_from_ms  INTEGER,
    valid_to_ms    INTEGER,
    PRIMARY KEY (project_id, dst_id, edge_type, src_id)
  ) WITHOUT ROWID`;

  // External-content FTS5 index + O(1) document-frequency `fts5vocab` table.
  yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS workspace_routing_fts USING fts5(
    title,
    summary_moc,
    body_markdown,
    content='workspace_routing_nodes',
    content_rowid='node_id',
    tokenize='unicode61'
  )`;

  yield* sql`CREATE TRIGGER IF NOT EXISTS trg_workspace_routing_nodes_ai
    AFTER INSERT ON workspace_routing_nodes BEGIN
      INSERT INTO workspace_routing_fts(rowid, title, summary_moc, body_markdown)
      VALUES (new.node_id, new.title, new.summary_moc, new.body_markdown);
    END`;

  yield* sql`CREATE TRIGGER IF NOT EXISTS trg_workspace_routing_nodes_ad
    AFTER DELETE ON workspace_routing_nodes BEGIN
      INSERT INTO workspace_routing_fts(workspace_routing_fts, rowid, title, summary_moc, body_markdown)
      VALUES ('delete', old.node_id, old.title, old.summary_moc, old.body_markdown);
    END`;

  yield* sql`CREATE TRIGGER IF NOT EXISTS trg_workspace_routing_nodes_au
    AFTER UPDATE OF title, summary_moc, body_markdown ON workspace_routing_nodes BEGIN
      INSERT INTO workspace_routing_fts(workspace_routing_fts, rowid, title, summary_moc, body_markdown)
      VALUES ('delete', old.node_id, old.title, old.summary_moc, old.body_markdown);
      INSERT INTO workspace_routing_fts(rowid, title, summary_moc, body_markdown)
      VALUES (new.node_id, new.title, new.summary_moc, new.body_markdown);
    END`;

  yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS workspace_routing_fts_vocab
    USING fts5vocab(workspace_routing_fts, row)`;

  // Read-only operational audit views (0 runtime write overhead).
  yield* sql`CREATE VIEW IF NOT EXISTS v_t3_audit_graph_health AS
    SELECT
      n.project_id,
      COUNT(*) AS total_nodes,
      SUM(CASE WHEN n.node_kind = 4 THEN 1 ELSE 0 END) AS master_reports,
      SUM(CASE WHEN n.stale_status = 2 THEN 1 ELSE 0 END) AS stale_nodes,
      COALESCE(e.edge_count, 0) AS total_edges,
      ROUND(CAST(COALESCE(e.edge_count, 0) AS REAL) / MAX(1, COUNT(*)), 3) AS avg_out_degree
    FROM workspace_routing_nodes n
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS edge_count
      FROM workspace_routing_edges
      WHERE valid_to_ms IS NULL
      GROUP BY project_id
    ) e ON e.project_id = n.project_id
    GROUP BY n.project_id`;

  yield* sql`CREATE VIEW IF NOT EXISTS v_t3_audit_ccr_vault AS
    SELECT
      COUNT(*) AS stored_entries,
      COALESCE(SUM(raw_bytes), 0) AS total_raw_bytes,
      COALESCE(SUM(compressed_bytes), 0) AS total_compressed_bytes,
      ROUND(
        CASE WHEN COALESCE(SUM(raw_bytes), 0) > 0
          THEN (1.0 - CAST(COALESCE(SUM(compressed_bytes), 0) AS REAL) / SUM(raw_bytes)) * 100.0
          ELSE 0.0
        END,
        2
      ) AS gzip_saved_percent
    FROM ccr_tool_outputs`;

  yield* sql`CREATE VIEW IF NOT EXISTS v_t3_audit_prompt_budget AS
    SELECT
      thread_id,
      COUNT(*) AS prepared_turns,
      MAX(created_at) AS latest_at
    FROM projection_thread_activities
    WHERE kind = 'input.composition.prepared'
    GROUP BY thread_id`;

  yield* sql`CREATE VIEW IF NOT EXISTS v_t3_audit_handoff_savings AS
    SELECT
      thread_id,
      kind,
      COUNT(*) AS events,
      MAX(created_at) AS latest_at
    FROM projection_thread_activities
    WHERE kind LIKE 'conversation.handoff.%'
    GROUP BY thread_id, kind`;
});
