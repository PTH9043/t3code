import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Artifact = Schema.Struct({ path: Schema.NonEmptyString, sha256: Hash });
export const ResearchUpgradeEvidence = Schema.Struct({
  version: Schema.Literal(1),
  problem: Schema.NonEmptyString,
  sources: Schema.Array(
    Schema.Struct({
      url: Schema.String.check(Schema.isPattern(/^https:\/\//)),
      revision: Schema.NonEmptyString,
      capturedAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T/)),
    }),
  ).check(Schema.isMinLength(1)),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.NonEmptyString,
      before: Schema.NullOr(Hash),
      after: Hash,
      rollback: Schema.NullOr(Artifact),
    }),
  ).check(Schema.isMinLength(1)),
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      command: Schema.NonEmptyString,
      exitCode: Schema.Literal(0),
      log: Artifact,
    }),
  ).check(Schema.isMinLength(1)),
  comparisons: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      baseline: Artifact,
      candidate: Artifact,
      datasetHash: Hash,
    }),
  ),
  limitations: Schema.Array(Schema.NonEmptyString),
});

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const decodeEvidence = Schema.decodeUnknownSync(ResearchUpgradeEvidence);
const decodeReport = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ datasetHash: Hash })),
);

async function scopedFile(root: string, relative: string): Promise<string> {
  if (NodePath.isAbsolute(relative))
    throw new Error(`Expected a relative artifact path: ${relative}`);
  const resolvedRoot = await NodeFSP.realpath(root);
  const resolved = await NodeFSP.realpath(NodePath.resolve(root, relative));
  const suffix = NodePath.relative(resolvedRoot, resolved);
  if (suffix === ".." || suffix.startsWith(".." + NodePath.sep) || NodePath.isAbsolute(suffix))
    throw new Error(`Artifact escapes its declared root: ${relative}`);
  return resolved;
}

/** Verify recorded evidence without executing commands, changing skills or contacting sources. */
export async function verifyResearchUpgradeEvidence(input: {
  manifest: unknown;
  workspaceRoot: string;
  evidenceRoot: string;
}) {
  const manifest = decodeEvidence(input.manifest);
  const checkedArtifact = async (artifact: typeof Artifact.Type) => {
    const bytes = await NodeFSP.readFile(await scopedFile(input.evidenceRoot, artifact.path));
    if (sha256(bytes) !== artifact.sha256) throw new Error(`Evidence changed: ${artifact.path}`);
    return bytes;
  };
  const paths = new Set<string>();
  for (const file of manifest.files) {
    const path = await scopedFile(input.workspaceRoot, file.path);
    if (paths.has(path)) throw new Error(`Duplicate candidate file: ${file.path}`);
    paths.add(path);
    if (sha256(await NodeFSP.readFile(path)) !== file.after)
      throw new Error(`Candidate changed after verification: ${file.path}`);
    if (file.before === null) {
      if (file.rollback !== null)
        throw new Error(`New file has a conflicting rollback: ${file.path}`);
    } else {
      if (file.rollback === null || file.rollback.sha256 !== file.before)
        throw new Error(`Missing original for rollback: ${file.path}`);
      await checkedArtifact(file.rollback);
    }
  }
  for (const source of manifest.sources) {
    const url = new URL(source.url);
    if (url.hostname === "github.com" && url.pathname.includes("/blob/")) {
      const commit = url.pathname.split("/blob/")[1]?.split("/")[0];
      if (!commit || !/^[a-f0-9]{40}$/i.test(commit) || source.revision !== commit)
        throw new Error(`Pin GitHub source to its recorded commit: ${source.url}`);
    }
    if (!Number.isFinite(Date.parse(source.capturedAt)))
      throw new Error(`Invalid source capture time: ${source.url}`);
  }
  for (const check of manifest.checks) await checkedArtifact(check.log);
  for (const comparison of manifest.comparisons) {
    for (const artifact of [comparison.baseline, comparison.candidate]) {
      const report = decodeReport((await checkedArtifact(artifact)).toString("utf8"));
      if (report.datasetHash !== comparison.datasetHash)
        throw new Error(`Comparison dataset differs: ${comparison.name}`);
    }
  }
  return {
    status: "evidence-consistent" as const,
    candidateFiles: manifest.files.length,
    recordedChecks: manifest.checks.length,
    comparisons: manifest.comparisons.length,
    limitations: manifest.limitations,
  };
}
