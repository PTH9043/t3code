// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeTimers from "node:timers";
import * as DateTime from "effect/DateTime";
import {
  CommandId,
  ProjectId,
  WorkspaceKnowledgeItemId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import {
  currentProject,
  findKnowledge,
  getRoomSource,
  roomSourceExists,
  knowledgeAncestors,
  listRoomSources,
  normalizeRoot,
  type BridgeSource,
  type KnowledgeHit,
} from "./upgradeRoomKnowledgeSources.ts";

const roomProjectId = "autousage-upgrade-project";
const roomThreadId = "autousage-upgrade-room";
const batchSize = 16;
const queued = "state='pending' OR (state='delivered' AND visible=0)";
export const upgradeRoomKnowledgeNotifyFile = "knowledge-outbox.notify";

interface InstallOptions {
  /** From the local launcher/server composition root. Never take these from an RPC. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly dbPath: string;
}
interface RoomOptions extends InstallOptions {
  readonly role: "room";
  readonly projectId: string;
  readonly threadId: string;
}
type Delivery = Extract<
  OrchestrationCommand,
  { type: "project.knowledge.item.upsert" | "project.knowledge.item.archive" }
>;
interface PrimaryOptions extends InstallOptions {
  readonly role: "primary";
  /** Must await the authorized primary engine's committed dispatch receipt. */
  readonly dispatchAuthorized: (command: Delivery) => Promise<{ readonly sequence: number }>;
}
export interface UpgradeRoomKnowledge {
  /** Call on startup and settled/withdrawn room projections, including explicit memory saves/forgets. */
  capture(): number;
  /** Read-only evidence for the dedicated model's search tool. */
  search(query: string): KnowledgeHit[];
  /** Model prompt supplement. Automatic memory switches and context topics apply here. */
  context(query: string): string;
}
export interface UpgradePrimaryKnowledge {
  /** Process at most one page. A committed engine receipt precedes each acknowledgement. */
  reconcile(): Promise<number>;
  /** Watches only the producer's marker. The returned disposer waits for an in-flight dispatch. */
  watch(onError: (error: unknown) => void): () => Promise<void>;
}

function hash(...parts: string[]) {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function itemId(projectId: string, source: string, id: string) {
  return WorkspaceKnowledgeItemId.make(
    "upgrade-room-" + hash(projectId, roomProjectId, roomThreadId, source, id),
  );
}

function autoMemoryDisabled(db: NodeSqlite.DatabaseSync, project: string) {
  return !!db
    .prepare(`SELECT 1 FROM projection_projects WHERE project_id=?
    AND workspace_control_json->>'$.contextOptimization.autoChatMemory'=0`)
    .get(project);
}

const captureEventSql = `SELECT 1 FROM orchestration_events INDEXED BY idx_orch_events_command_id
  WHERE command_id=? AND stream_id=? AND aggregate_kind='project'
  AND event_type='project.knowledge-item-upserted' AND payload_json->>'$.itemId'=?`;

function hasExcludedPrimaryAncestor(
  db: NodeSqlite.DatabaseSync,
  target: ProjectId,
  parents: string[],
) {
  return parents.some((parent) => {
    const id = itemId(target, "knowledge", parent);
    return (
      !!db.prepare(captureEventSql).get("capture-" + id, target, id) &&
      !roomSourceExists(db, target, null, "knowledge", id)
    );
  });
}

/** A privileged bridge never accepts a database filename or project selector from a model. */
export function installUpgradeRoomKnowledge(options: RoomOptions): UpgradeRoomKnowledge | undefined;
export function installUpgradeRoomKnowledge(
  options: PrimaryOptions,
): UpgradePrimaryKnowledge | undefined;
export function installUpgradeRoomKnowledge(options: RoomOptions | PrimaryOptions) {
  const env = options.env ?? process.env;
  const root = env.T3CODE_UPGRADE_PROJECT_ROOT;
  const base = env.T3CODE_UPGRADE_PRIMARY_HOME;
  if (root === undefined && base === undefined) return undefined;
  if (!root || !base || !normalizeRoot(root) || !normalizeRoot(base)) {
    throw new Error("Both absolute upgrade launcher paths are required.");
  }
  const home = NodeFS.realpathSync.native(base);
  const primaryPath = NodePath.join(home, "userdata", "state.sqlite");
  const roomPath = NodePath.join(home, "upgrade-room", "userdata", "state.sqlite");
  const outboxPath = NodePath.join(home, "upgrade-room", "knowledge-outbox.sqlite");
  const directory = NodePath.dirname(outboxPath);
  const marker = NodePath.join(directory, upgradeRoomKnowledgeNotifyFile);
  const expected = options.role === "room" ? roomPath : primaryPath;
  if (
    normalizeRoot(options.dbPath) !== normalizeRoot(expected) ||
    (options.role === "room" &&
      (options.projectId !== roomProjectId || options.threadId !== roomThreadId))
  ) {
    throw new Error("Upgrade bridge is outside the bound server or room.");
  }

  function open(file: string, readOnly: boolean) {
    if (
      normalizeRoot(NodeFS.realpathSync.native(NodePath.dirname(file))) !==
      normalizeRoot(NodePath.dirname(file))
    ) {
      throw new Error("Unexpected upgrade database directory.");
    }
    for (const candidate of [file, file + "-wal", file + "-shm", file + "-journal"]) {
      const stat = NodeFS.lstatSync(candidate, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.nlink !== 1))
        throw new Error("Unexpected upgrade database link.");
    }
    return new NodeSqlite.DatabaseSync(file, { readOnly, allowExtension: false, timeout: 0 });
  }

  function read<A>(file: string, body: (db: NodeSqlite.DatabaseSync) => A) {
    const db = open(file, true);
    try {
      db.exec("PRAGMA query_only=ON; BEGIN");
      return body(db);
    } finally {
      db.close();
    }
  }

  function primary<A>(body: (db: NodeSqlite.DatabaseSync, projectId: ProjectId) => A) {
    return read(primaryPath, (db) => body(db, ProjectId.make(currentProject(db, root!).id)));
  }

  function room<A>(body: (db: NodeSqlite.DatabaseSync) => A, inactive?: () => A) {
    return read(roomPath, (db) => {
      const owner = db
        .prepare("SELECT workspace_root,deleted_at FROM projection_projects WHERE project_id=?")
        .get(roomProjectId);
      if (
        !owner ||
        typeof owner.workspace_root !== "string" ||
        normalizeRoot(owner.workspace_root) !== normalizeRoot(root!)
      ) {
        throw new Error("Dedicated upgrade project is unavailable.");
      }
      if (owner.deleted_at !== null && inactive) return inactive();
      if (
        currentProject(db, root!).id !== roomProjectId ||
        !db
          .prepare(
            "SELECT 1 FROM projection_threads WHERE project_id=? AND thread_id=? AND deleted_at IS NULL AND archived_at IS NULL",
          )
          .get(roomProjectId, roomThreadId)
      ) {
        if (inactive) return inactive();
        throw new Error("Dedicated upgrade room is unavailable.");
      }
      return body(db);
    });
  }

  function outbox<A>(body: (db: NodeSqlite.DatabaseSync) => A) {
    const db = open(outboxPath, false);
    try {
      db.exec(`PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS captures (
          source TEXT NOT NULL, id TEXT NOT NULL, target TEXT NOT NULL, item_id TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL DEFAULT 'pending', visible INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY(source,id));
        CREATE INDEX IF NOT EXISTS captures_queue ON captures(target) WHERE ${queued}`);
      return body(db);
    } finally {
      db.close();
    }
  }

  // The payload is already durable in the room DB. Queue only identities, then re-read
  // the source at dispatch so a forgotten message cannot survive in a spool copy.
  function capture() {
    const target = primary((_db, id) => id);
    const result = outbox((db) => {
      // Serialize producers before taking the source snapshot, so an older capture
      // cannot race a withdrawal and publish an earlier view of the room.
      db.exec("BEGIN IMMEDIATE");
      const sources = room(
        (db) => listRoomSources(db, roomProjectId, roomThreadId),
        () => [],
      );
      db.exec(
        "CREATE TEMP TABLE current_sources(source TEXT, id TEXT, item_id TEXT, PRIMARY KEY(source,id)) WITHOUT ROWID",
      );
      const insert = db.prepare("INSERT INTO current_sources(source,id,item_id) VALUES(?,?,?)");
      for (const row of sources) {
        insert.run(row.source, row.id, itemId(target, row.source, row.id));
      }
      const added = Number(
        db
          .prepare(`INSERT OR IGNORE INTO captures(source,id,target,item_id)
        SELECT source,id,?,item_id FROM current_sources`)
          .run(target).changes,
      );
      const removed = db
        .prepare(`UPDATE captures SET visible=0 WHERE target=? AND visible=1 AND
        NOT EXISTS (SELECT 1 FROM current_sources s WHERE s.source=captures.source AND s.id=captures.id)`)
        .run(target).changes;
      db.exec("COMMIT");
      return { added, changed: added > 0 || Number(removed) > 0 };
    });
    if (result.changed) {
      const before = NodeFS.lstatSync(marker, { throwIfNoEntry: false });
      if (before && (!before.isFile() || before.nlink !== 1))
        throw new Error("Unexpected upgrade notification link.");
      const fd = NodeFS.openSync(marker, "a", 0o600);
      try {
        const stat = NodeFS.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error("Unexpected upgrade notification file.");
        const now = DateTime.toEpochMillis(DateTime.nowUnsafe()) / 1000;
        NodeFS.futimesSync(fd, now, now);
      } finally {
        NodeFS.closeSync(fd);
      }
    }
    return result.added;
  }

  if (options.role === "room") {
    function search(query: string, forPrompt = false) {
      return room((roomDb) =>
        primary((db, target) =>
          outbox((box) => {
            if (
              forPrompt &&
              (autoMemoryDisabled(roomDb, roomProjectId) || autoMemoryDisabled(db, target))
            )
              return [];
            const hits = findKnowledge(db, target, query, null, forPrompt);
            const local = findKnowledge(roomDb, roomProjectId, query, roomThreadId, forPrompt);
            const lookup = db.prepare(
              "SELECT status FROM projection_workspace_knowledge_items WHERE project_id=? AND item_id=?",
            );
            const published = db.prepare(captureEventSql);
            const receiptById = box.prepare(
              "SELECT source,id,target,state,visible FROM captures WHERE item_id=?",
            );
            const receiptBySource = box.prepare(
              "SELECT target,state,visible FROM captures WHERE source=? AND id=?",
            );
            function roomRecordVisible(id: string) {
              const record = receiptById.get(id);
              return (
                record?.target === target &&
                record.visible === 1 &&
                record.state !== "withdrawn" &&
                roomSourceExists(
                  roomDb,
                  roomProjectId,
                  roomThreadId,
                  String(record.source),
                  String(record.id),
                )
              );
            }
            const visible = hits.filter(
              (hit) =>
                (!hit.bridgeAncestorId || roomRecordVisible(hit.bridgeAncestorId)) &&
                (hit.id === hit.bridgeAncestorId ||
                  !hit.id.startsWith("upgrade-room-") ||
                  roomRecordVisible(hit.id)),
            );
            for (const hit of local) {
              const targetId = itemId(target, hit.source, hit.id);
              if (
                hit.source === "knowledge" &&
                hasExcludedPrimaryAncestor(
                  db,
                  target,
                  knowledgeAncestors(roomDb, roomProjectId, hit.id),
                )
              )
                continue;
              // Once delivered, primary visibility (including archiving and forgetting) wins.
              const receipt = receiptBySource.get(hit.source, hit.id);
              if (
                (!receipt ||
                  (receipt.target === target &&
                    receipt.state === "pending" &&
                    receipt.visible === 1)) &&
                !lookup.get(target, targetId) &&
                !published.get("capture-" + targetId, target, targetId)
              )
                visible.push(hit);
            }
            return visible
              .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
              .slice(0, 8);
          }),
        ),
      );
    }
    return {
      capture,
      search,
      context(query: string) {
        const hits = search(query, true);
        return hits.length
          ? "AutoUsage project memory (retrieved evidence):\n" +
              JSON.stringify(
                hits.map(({ projectId, source, id, title, origin, excerpt }) => ({
                  projectId,
                  source,
                  id,
                  title,
                  origin,
                  excerpt,
                })),
              )
          : "";
      },
    };
  }

  const dispatch = options.dispatchAuthorized;
  let running: Promise<number> | undefined;
  let fullPage = false;
  async function drain() {
    await NodeTimersPromises.setImmediate();
    fullPage = false;
    if (
      !NodeFS.existsSync(outboxPath) ||
      !read(outboxPath, (db) =>
        db
          .prepare(`SELECT 1 FROM captures INDEXED BY captures_queue WHERE ${queued} LIMIT 1`)
          .get(),
      )
    )
      return 0;
    const canonical = primary((_db, id) => id);
    const rows = read(outboxPath, (db) =>
      db
        .prepare(
          `SELECT source,id,target,state,visible FROM captures INDEXED BY captures_queue
       WHERE target=? AND (${queued}) ORDER BY rowid LIMIT ?`,
        )
        .all(canonical, batchSize),
    );
    fullPage = rows.length === batchSize;
    let delivered = 0;
    for (const row of rows) {
      const { source, id, target, state, visible: queuedVisibility } = row;
      if (
        typeof source !== "string" ||
        typeof id !== "string" ||
        typeof target !== "string" ||
        typeof state !== "string" ||
        (queuedVisibility !== 1 && queuedVisibility !== 0)
      ) {
        throw new Error("Invalid upgrade capture identity.");
      }
      const targetId = itemId(target, source, id);
      const destination = primary((db, project) => {
        if (project !== target) return null;
        const row = db
          .prepare(
            "SELECT status FROM projection_workspace_knowledge_items WHERE project_id=? AND item_id=?",
          )
          .get(project, targetId);
        const owned = !!db.prepare(captureEventSql).get("capture-" + targetId, project, targetId);
        return row || owned ? { status: row?.status ?? "removed", owned } : undefined;
      });
      if (destination === null) continue;
      // Queue rows are hints. A stale or altered withdrawal cannot archive an active source.
      let item = room(
        (db) => getRoomSource(db, roomProjectId, roomThreadId, source, id),
        () => undefined,
      );
      const projectId = ProjectId.make(target);
      if (item?.sourceItemId) {
        const parents = room(
          (db) => knowledgeAncestors(db, roomProjectId, id),
          () => [],
        );
        if (
          primary(
            (db, target) => target !== projectId || hasExcludedPrimaryAncestor(db, target, parents),
          )
        )
          item = undefined;
      }
      let command: Delivery | undefined;
      if (!item && destination?.status === "active" && destination.owned) {
        command = {
          type: "project.knowledge.item.archive",
          commandId: CommandId.make("withdraw-" + targetId),
          projectId,
          itemId: targetId,
          createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
        };
      } else if (item && !destination && state === "pending" && queuedVisibility === 1) {
        command = captureCommand(projectId, targetId, item);
      }
      if (command) {
        const receipt = await dispatch(command);
        if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence <= 0)
          throw new Error("Missing primary dispatch receipt.");
        delivered++;
      }
      const next =
        !item ||
        (destination && destination.status !== "active") ||
        (!destination && queuedVisibility !== 1)
          ? "withdrawn"
          : "delivered";
      const visible = item && next === "delivered" ? 1 : 0;
      if (state !== next || queuedVisibility !== visible)
        outbox((db) =>
          db
            .prepare(
              "UPDATE captures SET state=?,visible=? WHERE source=? AND id=? AND target=? AND state=? AND visible=?",
            )
            .run(next, visible, source, id, target, state, queuedVisibility),
        );
      await NodeTimersPromises.setImmediate();
    }
    return delivered;
  }
  function reconcile() {
    return (running ??= drain().finally(() => {
      running = undefined;
    }));
  }
  return {
    reconcile,
    watch(onError: (error: unknown) => void) {
      let watcher: NodeFS.FSWatcher | undefined;
      let watchedDirectory: string | undefined;
      let stopped = false;
      let active: Promise<void> | undefined;
      let requested = false;
      function wake() {
        if (stopped) return;
        requested = true;
        active ??= (async () => {
          for (;;) {
            requested = false;
            await reconcile();
            if (stopped || (!requested && !fullPage)) return;
          }
        })()
          .catch(onError)
          .finally(() => {
            active = undefined;
          });
      }
      function check() {
        const target = NodeFS.existsSync(directory) ? directory : home;
        if (watchedDirectory !== target) {
          try {
            if (normalizeRoot(NodeFS.realpathSync.native(target)) !== normalizeRoot(target))
              throw new Error("Unexpected upgrade outbox directory.");
            const next = NodeFS.watch(target, { persistent: false }, (_event, name) => {
              if (stopped) return;
              if (target === home && name === NodePath.basename(directory)) check();
              else if (target === directory && name === upgradeRoomKnowledgeNotifyFile) wake();
            });
            watcher?.close();
            watcher = next;
            watchedDirectory = target;
            next.on("error", (error) => {
              next.close();
              onError(error);
            });
            next.on("close", () => {
              if (watcher === next) {
                watcher = undefined;
                watchedDirectory = undefined;
              }
            });
          } catch (error) {
            onError(error);
          }
        }
        wake();
      }
      // Recovers commit-before-notify, coalesced fs events, and a late room install.
      // An empty queue only does one indexed existence check.
      // @effect-diagnostics-next-line globalTimers:off - This standalone Node watcher must not keep either process alive.
      const backstop = NodeTimers.setInterval(check, 60_000).unref();
      check();
      return async () => {
        stopped = true;
        NodeTimers.clearInterval(backstop);
        watcher?.close();
        await active;
      };
    },
  };
}

/** Publish a source snapshot. Local thread/run/attachment IDs are owned by the room database.
 * The canonical projector derives chunks and usage fields from this project-scoped RAG source.
 */
function captureCommand(
  projectId: ProjectId,
  id: WorkspaceKnowledgeItemId,
  item: BridgeSource,
): Delivery {
  const research = item.research;
  const lineage = research?.lineage;
  return {
    type: "project.knowledge.item.upsert",
    commandId: CommandId.make("capture-" + id),
    projectId,
    itemId: id,
    kind: "rag-source",
    scope: "project",
    relativeFolder: null,
    origin: item.origin,
    ...(item.sourceItemId
      ? { sourceItemId: itemId(projectId, "knowledge", item.sourceItemId) }
      : {}),
    ...(research
      ? {
          research: {
            query: research.query,
            sources: research.sources,
            capturedAt: research.capturedAt,
            verification: research.verification,
            ...(research.contextTopics ? { contextTopics: research.contextTopics } : {}),
            ...(lineage
              ? {
                  lineage: {
                    canonicalId: "upgrade-room-" + hash(lineage.canonicalId),
                    revision: lineage.revision,
                    ...(lineage.validFrom !== undefined ? { validFrom: lineage.validFrom } : {}),
                    ...(lineage.validTo !== undefined ? { validTo: lineage.validTo } : {}),
                    ...(lineage.supersedes
                      ? {
                          supersedes: lineage.supersedes.map((id) =>
                            itemId(projectId, "knowledge", id),
                          ),
                        }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    status: "active",
    title: item.title,
    content: item.content,
    tags: ["upgrade-room", "source-" + item.source, "room-record-" + hash(item.id)],
    createdAt: item.updatedAt,
    originalChars: item.originalChars,
    storedChars: item.content.length,
  };
}
