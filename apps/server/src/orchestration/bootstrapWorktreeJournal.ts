import type { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

export type BootstrapPhase =
  | "initial"
  | "provisioning"
  | "worktree-ready"
  | "setting-up"
  | "setup-finished";
export type BootstrapSetupOutcome = "started" | "no-script" | "failed";
export interface BootstrapIdentity {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly requestFingerprint: string;
  readonly creationCommandId: CommandId;
}
export interface BootstrapJournalEntry extends BootstrapIdentity {
  readonly phase: BootstrapPhase;
  readonly worktreePath: string | null;
  readonly worktreeRef: string | null;
  readonly setupOutcome: BootstrapSetupOutcome | null;
}
export type BootstrapTransition =
  | { readonly from: "initial"; readonly to: "provisioning" }
  | {
      readonly from: "provisioning";
      readonly to: "worktree-ready";
      readonly worktreePath: string;
      readonly worktreeRef: string;
    }
  | { readonly from: "worktree-ready"; readonly to: "setting-up" }
  | {
      readonly from: "setting-up";
      readonly to: "setup-finished";
      readonly setupOutcome: BootstrapSetupOutcome;
    };

const conflict = (detail: string) =>
  new OrchestrationCommandInvariantError({ commandType: "thread.turn.start", detail });

export function makeBootstrapWorktreeJournal(sql: SqlClient.SqlClient) {
  const begin = Effect.fn("BootstrapWorktreeJournal.begin")(function* (
    identity: BootstrapIdentity,
  ) {
    yield* sql`INSERT INTO bootstrap_worktree_journal
      (command_id, thread_id, request_fingerprint, creation_command_id, phase)
      VALUES (${identity.commandId}, ${identity.threadId}, ${identity.requestFingerprint}, ${identity.creationCommandId}, 'initial')
      ON CONFLICT(command_id) DO NOTHING`.pipe(
      Effect.mapError(toPersistenceSqlError("BootstrapWorktreeJournal.begin")),
    );
    const [entry] =
      yield* sql<BootstrapJournalEntry>`SELECT command_id AS "commandId", thread_id AS "threadId",
      request_fingerprint AS "requestFingerprint", creation_command_id AS "creationCommandId", phase,
      worktree_path AS "worktreePath", worktree_ref AS "worktreeRef", setup_outcome AS "setupOutcome"
      FROM bootstrap_worktree_journal WHERE command_id=${identity.commandId}`.pipe(
        Effect.mapError(toPersistenceSqlError("BootstrapWorktreeJournal.read")),
      );
    if (
      !entry ||
      entry.threadId !== identity.threadId ||
      entry.requestFingerprint !== identity.requestFingerprint ||
      entry.creationCommandId !== identity.creationCommandId
    )
      return yield* conflict("이 시작 요청의 저장된 식별 정보가 일치하지 않습니다.");
    return entry;
  });

  const advance = Effect.fn("BootstrapWorktreeJournal.advance")(function* (
    identity: BootstrapIdentity,
    transition: BootstrapTransition,
  ) {
    const worktreePath = transition.to === "worktree-ready" ? transition.worktreePath : null;
    const worktreeRef = transition.to === "worktree-ready" ? transition.worktreeRef : null;
    const setupOutcome = transition.to === "setup-finished" ? transition.setupOutcome : null;
    const rows = yield* sql<BootstrapJournalEntry>`UPDATE bootstrap_worktree_journal SET
      phase=${transition.to}, worktree_path=COALESCE(${worktreePath}, worktree_path),
      worktree_ref=COALESCE(${worktreeRef}, worktree_ref), setup_outcome=COALESCE(${setupOutcome}, setup_outcome)
      WHERE command_id=${identity.commandId} AND thread_id=${identity.threadId}
        AND request_fingerprint=${identity.requestFingerprint} AND creation_command_id=${identity.creationCommandId}
        AND phase=${transition.from}
      RETURNING command_id AS "commandId", thread_id AS "threadId", request_fingerprint AS "requestFingerprint",
        creation_command_id AS "creationCommandId", phase, worktree_path AS "worktreePath",
        worktree_ref AS "worktreeRef", setup_outcome AS "setupOutcome"`.pipe(
      Effect.mapError(toPersistenceSqlError("BootstrapWorktreeJournal.advance")),
    );
    if (!rows[0])
      return yield* conflict("작업 트리 준비 단계가 변경되어 안전하게 이어갈 수 없습니다.");
    return rows[0];
  });
  return { begin, advance };
}
