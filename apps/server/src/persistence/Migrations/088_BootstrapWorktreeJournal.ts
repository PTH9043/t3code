import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS bootstrap_worktree_journal (
    command_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    creation_command_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('initial', 'provisioning', 'worktree-ready', 'setting-up', 'setup-finished')),
    worktree_path TEXT,
    worktree_ref TEXT,
    setup_outcome TEXT CHECK (setup_outcome IS NULL OR setup_outcome IN ('started', 'no-script', 'failed')),
    CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
    CHECK (
      (phase IN ('initial', 'provisioning') AND worktree_path IS NULL AND worktree_ref IS NULL AND setup_outcome IS NULL)
      OR (phase IN ('worktree-ready', 'setting-up') AND worktree_path IS NOT NULL AND worktree_ref IS NOT NULL AND length(worktree_path) > 0 AND length(worktree_ref) > 0 AND setup_outcome IS NULL)
      OR (phase = 'setup-finished' AND worktree_path IS NOT NULL AND worktree_ref IS NOT NULL AND length(worktree_path) > 0 AND length(worktree_ref) > 0 AND setup_outcome IS NOT NULL)
    )
  )`;
});
