// @effect-diagnostics nodeBuiltinImport:off
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";
const locks = new Map<string, Promise<unknown>>();
export async function withPdfAnalysisLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key);
  const current = (async () => {
    if (prior) await prior.catch(() => undefined);
    return fn();
  })();
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}
type Predicate = (row: {
  project_id: string;
  thread_id: string;
  message_id: string;
  attachment_id: string;
  content_hash: string;
}) => boolean;
async function purge(stateDir: string, predicate: Predicate) {
  const dir = Path.join(stateDir, "document-rag", "pdf-analysis");
  const entries = await Fs.readdir(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  for (const name of entries) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sqlite$/i.test(name)
    )
      continue;
    const file = Path.join(dir, name);
    await withPdfAnalysisLock(file, async () => {
      const stat = await Fs.lstat(file).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (!stat?.isFile() || stat.isSymbolicLink()) return;
      let match = false;
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const row = db
          .prepare(
            "SELECT project_id,thread_id,message_id,attachment_id,content_hash FROM analysis LIMIT 1",
          )
          .get() as Parameters<Predicate>[0] | undefined;
        match = row !== undefined && predicate(row);
      } finally {
        db.close();
      }
      if (match) await Fs.unlink(file);
    });
  }
}
export const purgePdfAnalysisForThread = (
  stateDir: string,
  threadId: string,
  retainedMessageIds?: ReadonlySet<string>,
) =>
  purge(stateDir, (row) => row.thread_id === threadId && !retainedMessageIds?.has(row.message_id));
export const purgePdfAnalysisForVersion = (
  stateDir: string,
  projectId: string,
  attachmentId: string,
  contentHash: string,
) =>
  purge(
    stateDir,
    (row) =>
      row.project_id === projectId &&
      row.attachment_id === attachmentId &&
      row.content_hash === contentHash,
  );
