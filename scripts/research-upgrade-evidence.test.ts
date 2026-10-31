import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { verifyResearchUpgradeEvidence } from "./research-upgrade-evidence.ts";

const directories: string[] = [];
// oxlint-disable-next-line t3code/no-global-process-runtime -- Disposable CLI evidence fixture.
const temporaryRoot = NodePath.resolve(NodeOS.tmpdir());
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const target = NodePath.resolve(directory);
    if (
      NodePath.dirname(target) !== temporaryRoot ||
      !NodePath.basename(target).startsWith("t3-evidence-")
    )
      throw new Error("Refusing cleanup outside the captured fixture directories.");
    await NodeFSP.rm(target, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(temporaryRoot, "t3-evidence-"));
  directories.push(root);
  const artifact = async (path: string, text: string) => {
    await NodeFSP.writeFile(NodePath.join(root, path), text);
    return { path, sha256: NodeCrypto.createHash("sha256").update(text).digest("hex") };
  };
  const original = await artifact("original.md", "old skill");
  const candidate = await artifact("SKILL.md", "improved skill");
  const log = await artifact("checks.log", "focused verification passed");
  const datasetHash = "a".repeat(64);
  const report = await artifact("report.json", JSON.stringify({ datasetHash }));
  return {
    root,
    artifact,
    manifest: {
      version: 1,
      problem: "Repeated failure lacked a pinned source.",
      sources: [
        {
          url: "https://github.com/example/repo/blob/" + "b".repeat(40) + "/test.ts",
          revision: "b".repeat(40),
          capturedAt: "2026-10-24T00:00:00.000Z",
        },
      ],
      files: [
        {
          path: candidate.path,
          before: original.sha256,
          after: candidate.sha256,
          rollback: original,
        },
      ],
      checks: [{ name: "focused", command: "vp test run scoped.test.ts", exitCode: 0, log }],
      comparisons: [{ name: "same dataset", baseline: report, candidate: report, datasetHash }],
      limitations: ["Recorded evidence is checked; no model answer quality is inferred."],
    },
  };
}
const verify = (f: Awaited<ReturnType<typeof fixture>>) =>
  verifyResearchUpgradeEvidence({
    manifest: f.manifest,
    workspaceRoot: f.root,
    evidenceRoot: f.root,
  });
it("checks candidate, rollback, successful check logs, pinned sources and comparison identity", async () => {
  const f = await fixture();
  expect(await verify(f)).toMatchObject({
    status: "evidence-consistent",
    candidateFiles: 1,
    recordedChecks: 1,
    comparisons: 1,
  });
});
it("rejects candidate edits and altered test logs after their checks", async () => {
  const f = await fixture();
  await NodeFSP.writeFile(NodePath.join(f.root, "SKILL.md"), "untested change");
  await expect(verify(f)).rejects.toThrow("Candidate changed");
  const g = await fixture();
  await NodeFSP.writeFile(NodePath.join(g.root, "checks.log"), "different output");
  await expect(verify(g)).rejects.toThrow("Evidence changed");
});
it("requires a recoverable original and rejects a failed check", async () => {
  const f = await fixture();
  f.manifest.files[0]!.rollback.sha256 = "f".repeat(64);
  await expect(verify(f)).rejects.toThrow("Missing original");
  const g = await fixture();
  await expect(
    verifyResearchUpgradeEvidence({
      manifest: { ...g.manifest, checks: [{ ...g.manifest.checks[0], exitCode: 1 }] },
      workspaceRoot: g.root,
      evidenceRoot: g.root,
    }),
  ).rejects.toThrow();
});
it("rejects a different dataset and mutable GitHub branch references", async () => {
  const f = await fixture();
  f.manifest.comparisons[0]!.candidate = await f.artifact(
    "other.json",
    JSON.stringify({ datasetHash: "c".repeat(64) }),
  );
  await expect(verify(f)).rejects.toThrow("dataset differs");
  const g = await fixture();
  g.manifest.sources[0]!.url = "https://github.com/example/repo/blob/main/test.ts";
  await expect(verify(g)).rejects.toThrow("Pin GitHub source");
});
it("does not read artifacts outside their declared root", async () => {
  const f = await fixture();
  const outside = await fixture();
  f.manifest.checks[0]!.log.path = NodePath.relative(
    f.root,
    NodePath.join(outside.root, "checks.log"),
  );
  await expect(verify(f)).rejects.toThrow("escapes its declared root");
  f.manifest.checks[0]!.log.path = NodePath.join(outside.root, "checks.log");
  await expect(verify(f)).rejects.toThrow("Expected a relative");
});
