import { expect, it, vi } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Exercise real Node Git fallback filesystem behavior.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Node paths are part of this fallback integration test.
import * as NodePath from "node:path";
import { downloadGitHubSkill, parseGitHubSkillSource } from "./GitHubSkillSource.ts";

const fallback = vi.hoisted(() => vi.fn(async () => "a".repeat(40)));
vi.mock("./GitHubSkillGit.ts", () => ({ downloadGitHubSkillViaGit: fallback }));

it("uses Git for GitHub API rate limits, but does not hide other HTTP failures", async () => {
  const source = parseGitHubSkillSource("https://github.com/example/repo/tree/main/skills/example");
  const limited = async () => new Response("rate limited", { status: 403 });
  expect(await downloadGitHubSkill(source, "destination", limited)).toBe("a".repeat(40));
  expect(fallback).toHaveBeenCalledWith(source, "destination");
  fallback.mockClear();
  await expect(
    downloadGitHubSkill(
      source,
      "destination",
      async () => new Response("not found", { status: 404 }),
    ),
  ).rejects.toThrow("404");
  expect(fallback).not.toHaveBeenCalled();
});

it("does not mix files from an interrupted API download into the fallback revision", async () => {
  const source = parseGitHubSkillSource("https://github.com/example/repo/tree/main/skills/example");
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-github-fallback-test-"),
  );
  const data = "first file";
  const blob = NodeCrypto.createHash("sha1")
    .update(`blob ${Buffer.byteLength(data)}\0`)
    .update(data)
    .digest("hex");
  const tree = ["SKILL.md", "other.txt"].map((name) => ({
    path: `skills/example/${name}`,
    type: "blob",
    mode: "100644",
    sha: blob,
    size: Buffer.byteLength(data),
  }));
  let blobs = 0;
  try {
    fallback.mockClear();
    const fetcher = async (url: string) => {
      if (url.includes("/commits/")) return Response.json({ sha: "b".repeat(40) });
      if (url.includes("/git/trees/")) return Response.json({ tree, truncated: false });
      return ++blobs === 1 ? new Response(data) : new Response("limited", { status: 403 });
    };
    expect(await downloadGitHubSkill(source, directory, fetcher)).toBe("a".repeat(40));
    expect(await NodeFSP.readdir(directory)).toEqual([]);
    expect(fallback).toHaveBeenCalledWith(source, directory);
  } finally {
    await cleanup(directory);
  }
});

async function cleanup(directory: string) {
  if (NodePath.dirname(NodePath.resolve(directory)) !== NodePath.resolve(NodeOS.tmpdir()))
    throw new Error("invalid test directory");
  await NodeFSP.rm(directory, { recursive: true, force: true });
}
