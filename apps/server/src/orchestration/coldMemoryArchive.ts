// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as Schema from "effect/Schema";

export const COLD_OFFLOAD_INACTIVE_MS = 30 * 24 * 60 * 60 * 1000;

export const ColdMemoryArchiveRecord = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  scope: Schema.String,
  topic: Schema.String,
  text: Schema.String,
  sourceJson: Schema.String,
  origin: Schema.String,
  verification: Schema.String,
  createdAt: Schema.String,
  validFrom: Schema.NullOr(Schema.Number),
  validTo: Schema.NullOr(Schema.Number),
  lastAccessedAt: Schema.NullOr(Schema.Number),
  accessCount: Schema.Number,
});
export type ColdMemoryArchiveRecord = typeof ColdMemoryArchiveRecord.Type;

const encodeArchiveRecord = Schema.encodeSync(Schema.fromJsonString(ColdMemoryArchiveRecord));
const decodeArchiveRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(ColdMemoryArchiveRecord),
);

export function coldMemoryArchivePath(stateDir: string, projectId: string): string {
  const safeId = projectId.replace(/[^a-zA-Z0-9._-]+/gu, "_").slice(0, 64) || "default";
  const digest = NodeCrypto.createHash("sha256").update(projectId).digest("hex").slice(0, 12);
  return NodePath.join(stateDir, "memory-cold-archive", `${safeId}-${digest}.ndjson.gz`);
}

export interface ColdMemoryArchiveResult {
  readonly archivePath: string;
  readonly archivedCount: number;
  readonly rawBytes: number;
  readonly gzipBytes: number;
}

/**
 * Atomically write inactive (>30d) cold memory records to a gzipped NDJSON archive
 * (`memory-cold-archive/<project>.ndjson.gz`) while keeping original rows non-destructive.
 */
export async function writeColdMemoryGzipArchive(
  archivePath: string,
  records: ReadonlyArray<ColdMemoryArchiveRecord>,
): Promise<ColdMemoryArchiveResult> {
  if (records.length === 0) {
    return { archivePath, archivedCount: 0, rawBytes: 0, gzipBytes: 0 };
  }
  const ndjson = `${records.map((record) => encodeArchiveRecord(record)).join("\n")}\n`;
  const rawBuffer = Buffer.from(ndjson, "utf8");
  const gzipBuffer = NodeZlib.gzipSync(rawBuffer, { level: 6 });

  await NodeFSP.mkdir(NodePath.dirname(archivePath), { recursive: true });
  const tempPath = `${archivePath}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(tempPath, gzipBuffer);
    await NodeFSP.rename(tempPath, archivePath);
  } finally {
    await NodeFSP.rm(tempPath, { force: true });
  }

  return {
    archivePath,
    archivedCount: records.length,
    rawBytes: rawBuffer.byteLength,
    gzipBytes: gzipBuffer.byteLength,
  };
}

export async function readColdMemoryGzipArchive(
  archivePath: string,
): Promise<ReadonlyArray<ColdMemoryArchiveRecord>> {
  const compressed = await NodeFSP.readFile(archivePath);
  const raw = NodeZlib.gunzipSync(compressed).toString("utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => decodeArchiveRecord(line));
}
