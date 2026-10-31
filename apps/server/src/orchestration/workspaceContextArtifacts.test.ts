import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { describe, expect, it } from "vite-plus/test";
import {
  compactEvidenceHandoff,
  boundedEvidencePreview,
  contextArtifactHash,
  saveWorkspaceContextArtifact,
} from "./workspaceContextArtifacts.ts";
import { describeInputComposition } from "./inputComposition.ts";

const report = [
  "## Conclusion\nParser fixed.",
  "## Changes\nparser.ts",
  "## Checks\nvp test run parser.test.ts: exit 0",
  "## Pending\nRemote service check is still required.",
  "## Evidence\ncommit abc; log test-1.txt",
  "## Details\n" + "Trace of completed parser processing. ".repeat(250),
].join("\n\n");
const source = {
  path: "D:/isolated/source.txt",
  sha256: contextArtifactHash(report),
  chars: report.length,
};

describe("evidence handoff", () => {
  it("keeps whole preview paragraphs and the exact original reference for long persisted output", () => {
    const text =
      "First complete paragraph.\n\n" +
      "unbroken output ".repeat(3000) +
      "\n\nFinal dissent: the check failed.";
    const original = {
      path: "D:/isolated/full-output.txt",
      sha256: contextArtifactHash(text),
      chars: text.length,
    };
    const preview = boundedEvidencePreview(text, original, 2000);
    expect(preview!.length).toBeLessThanOrEqual(2000);
    expect(preview).toContain("First complete paragraph.");
    expect(preview).not.toContain("unbroken output");
    expect(preview).toContain(original.sha256);
    expect(preview).toContain("미리보기만으로 검증을 통과시키지 마세요");
    expect(boundedEvidencePreview(text + "changed", original, 2000)).toBeNull();
    expect(boundedEvidencePreview(text, original, 10)).toBeNull();
  });
  it("retains all decisions, checks, and pending work while referencing optional logs", () => {
    const compact = compactEvidenceHandoff(report, source);
    expect(compact.length).toBeLessThan(report.length);
    expect(compact).toContain("Remote service check is still required.");
    expect(compact).toContain("exit 0");
    expect(compact).toContain(source.sha256);
    expect(compact).not.toContain("Trace of completed");
  });
  it("keeps unknown reports and missing originals whole, including the tail", () => {
    expect(compactEvidenceHandoff(report)).toBe(report);
    const unknown = "unstructured ".repeat(400) + "tail evidence";
    expect(compactEvidenceHandoff(unknown, source)).toBe(unknown);
  });
  it("never discards an error or dissent hidden in details", () => {
    const failed = report + "\nThe final check failed; peer disagrees.";
    expect(compactEvidenceHandoff(failed, source)).toBe(failed);
  });
});

effectIt.effect("source is isolated by project/run, immutable and readable before use", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped();
    const first = yield* saveWorkspaceContextArtifact({
      stateDir,
      projectId: "a",
      runId: "r",
      content: report,
    });
    const second = yield* saveWorkspaceContextArtifact({
      stateDir,
      projectId: "b",
      runId: "r",
      content: report,
    });
    expect(first).not.toBeNull();
    expect(first!.path).not.toBe(second!.path);
    expect(yield* fs.readFileString(first!.path)).toBe(report);
    const modified = yield* saveWorkspaceContextArtifact({
      stateDir,
      projectId: "a",
      runId: "r",
      content: report + "revision 2",
    });
    expect(modified!.path).not.toBe(first!.path);
    expect(yield* fs.readFileString(first!.path)).toBe(report);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("records only visible input and distinguishes unknown tokens from zero", () => {
  const observed = describeInputComposition({
    prompt: "기억\n\n작업",
    path: "chat",
    parts: [
      { kind: "handoff", chars: 2 },
      { kind: "task", chars: 2 },
    ],
    attachmentCount: 1,
  });
  expect(observed.parts.reduce((sum, part) => sum + part.chars, 0)).toBe(6);
  expect(observed.estimatedTokens).toBeNull();
  expect(observed.nativeContext).toBe("unknown");
  expect(observed.contextRevision).not.toBe(
    describeInputComposition({ prompt: "변경", path: "chat", parts: [] }).contextRevision,
  );
});
