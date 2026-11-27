// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type {
  OrchestrationCommand,
  ProjectId,
  TelegramChannelCliPolicy,
  TelegramChannelRegistration,
  WorkspaceKnowledgeItemId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import type { Page } from "./summary.ts";

export type Mapping = { projectId: ProjectId; peerId: string };
export type DocCommand = Extract<OrchestrationCommand, { type: "project.knowledge.item.upsert" }>;
export type Branch = {
  id: WorkspaceKnowledgeItemId;
  summary: string;
  first: number;
  last: number;
  height: number;
};
export type Progress = {
  cursor: number;
  processedCount: number;
  missingTextCount: number;
  unavailableCount: number;
  frontier: Branch[];
  documentId: WorkspaceKnowledgeItemId | null;
  lastSyncedAt: string | null;
  exhausted: boolean;
};
const initial: Progress = {
  cursor: 0,
  processedCount: 0,
  missingTextCount: 0,
  unavailableCount: 0,
  frontier: [],
  documentId: null,
  lastSyncedAt: null,
  exhausted: false,
};
export type Pending = { commands: DocCommand[]; progress: Progress };
export type Registration = Mapping & {
  channel: string;
  generation: string;
  paused: boolean;
  progress: Progress;
  readCursor: number;
  fetchedCount: number;
  readEnded: boolean;
  readError: string | null;
  retryAt?: number;
  manualRetry?: boolean;
  pending: Pending | null;
  error: string | null;
  policy: TelegramChannelCliPolicy | null;
};
const parse = (row: unknown) => JSON.parse((row as { data: string }).data) as Registration;

export class Journal {
  private db: NodeSqlite.DatabaseSync;
  constructor(stateDir: string) {
    NodeFS.mkdirSync(stateDir, { recursive: true });
    this.db = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "telegram-project-rag.sqlite"));
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS mappings(project TEXT, peer TEXT, data TEXT NOT NULL, PRIMARY KEY(project,peer));",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS inbox(project TEXT,peer TEXT,after_id INTEGER,page TEXT NOT NULL,PRIMARY KEY(project,peer,after_id))",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS bridge_wait (id INTEGER PRIMARY KEY CHECK(id=1),until_ms INTEGER NOT NULL)",
    );
  }
  close() {
    this.db.close();
  }
  bridgeWaitUntil() {
    return Number(
      this.db.prepare("SELECT until_ms FROM bridge_wait WHERE id=1").get()?.until_ms ?? 0,
    );
  }
  waitForBridge(seconds: number) {
    const until = Math.min(Number.MAX_SAFE_INTEGER, Date.now() + seconds * 1000);
    this.db
      .prepare(
        "INSERT INTO bridge_wait VALUES(1,?) ON CONFLICT(id) DO UPDATE SET until_ms=max(until_ms,excluded.until_ms)",
      )
      .run(until);
  }
  private transaction<T>(f: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = f();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private write(r: Registration) {
    this.db
      .prepare(
        "INSERT INTO mappings VALUES(?,?,?) ON CONFLICT(project,peer) DO UPDATE SET data=excluded.data",
      )
      .run(r.projectId, r.peerId, JSON.stringify(r));
  }
  get(m: Mapping): Registration {
    const row = this.db
      .prepare("SELECT data FROM mappings WHERE project=? AND peer=?")
      .get(m.projectId, m.peerId);
    if (!row) throw new Error("등록되지 않은 프로젝트 채널입니다.");
    return parse(row);
  }
  register(m: Mapping, channel: string) {
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT 1 FROM mappings WHERE project=? AND peer=?")
        .get(m.projectId, m.peerId);
      if (!row)
        this.write({
          ...m,
          channel,
          paused: false,
          generation: NodeCrypto.randomUUID(),
          progress: initial,
          readCursor: 0,
          fetchedCount: 0,
          readEnded: false,
          readError: null,
          pending: null,
          error: null,
          policy: null,
        });
    });
  }
  unregister(m: Mapping) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM inbox WHERE project=? AND peer=?").run(m.projectId, m.peerId);
      this.db.prepare("DELETE FROM mappings WHERE project=? AND peer=?").run(m.projectId, m.peerId);
    });
  }
  enqueue(r: Registration, page: Page) {
    this.edit(r, (current) => {
      this.checkMapping(r, current);
      if (current.readCursor !== r.readCursor) throw new Error("읽기 커서가 변경되었습니다.");
      this.db
        .prepare("INSERT INTO inbox VALUES(?,?,?,?)")
        .run(r.projectId, r.peerId, r.readCursor, JSON.stringify(page));
      current.readCursor = page.continuation;
      current.fetchedCount += page.messages.length;
      current.readEnded = page.endReached;
      current.progress.exhausted = false;
    });
  }
  nextPage(r: Registration): Page | null {
    const row = this.db
      .prepare("SELECT page FROM inbox WHERE project=? AND peer=? AND after_id=?")
      .get(r.projectId, r.peerId, r.progress.cursor);
    return row ? (JSON.parse(String(row.page)) as Page) : null;
  }
  acknowledge(r: Registration, pending: Pending) {
    this.edit(r, (current) => {
      this.check(r, current);
      this.db
        .prepare("DELETE FROM inbox WHERE project=? AND peer=? AND after_id=?")
        .run(r.projectId, r.peerId, r.progress.cursor);
      current.progress = {
        ...pending.progress,
        exhausted: current.readEnded && pending.progress.cursor === current.readCursor,
      };
      current.pending = null;
      current.error = null;
    });
  }
  list(projectId?: ProjectId) {
    const rows =
      projectId === undefined
        ? this.db.prepare("SELECT data FROM mappings ORDER BY project,peer").all()
        : this.db.prepare("SELECT data FROM mappings WHERE project=? ORDER BY peer").all(projectId);
    return rows.map(parse);
  }
  edit(m: Mapping, mutate: (r: Registration) => void) {
    return this.transaction(() => {
      const r = this.get(m);
      mutate(r);
      this.write(r);
      return r;
    });
  }
  checkMapping(expected: Registration, r = this.get(expected)) {
    if (r.generation !== expected.generation || r.paused)
      throw new Error("채널 등록 상태가 변경되었습니다.");
    return r;
  }
  check(expected: Registration, r = this.get(expected)) {
    this.checkMapping(expected, r);
    if (r.progress.cursor !== expected.progress.cursor)
      throw new Error("채널 진행 상태가 변경되었습니다.");
    return r;
  }
  status(r: Registration, syncing: boolean): TelegramChannelRegistration {
    const p = r.progress;
    return {
      registrationId: r.peerId,
      channel: r.channel,
      phase: r.paused
        ? "paused"
        : r.error || r.readError
          ? "error"
          : p.exhausted
            ? p.missingTextCount + p.unavailableCount > 0
              ? "partial"
              : "incremental"
            : syncing || p.cursor
              ? "backfill"
              : "queued",
      readThroughId: r.readCursor,
      fetchedCount: r.fetchedCount,
      processedCount: p.processedCount,
      missingTextCount: p.missingTextCount,
      unavailableCount: p.unavailableCount,
      ...(p.lastSyncedAt ? { lastSyncedAt: p.lastSyncedAt } : {}),
      ...(r.readError || r.error
        ? { error: [r.readError, r.error].filter(Boolean).join(" ") }
        : {}),
      sourceDocumentIds: p.documentId ? [p.documentId] : [],
      policy: r.policy,
    };
  }
}
