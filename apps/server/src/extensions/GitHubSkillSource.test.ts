// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { downloadGitHubSkill, parseGitHubSkillSource } from "./GitHubSkillSource.ts";

const commit = "a".repeat(40);
const blob = (body: string) =>
  NodeCrypto.createHash("sha1")
    .update(`blob ${Buffer.byteLength(body)}\0`)
    .update(body)
    .digest("hex");
const skill = "---\nname: example\ndescription: A skill\n---\nUse it.\n";
const source = parseGitHubSkillSource("https://github.com/example/repo/tree/main/skills/example");
async function cleanupTestDirectory(directory: string) {
  if (NodePath.dirname(NodePath.resolve(directory)) !== NodePath.resolve(NodeOS.tmpdir()))
    throw new Error("invalid test directory");
  await NodeFSP.rm(directory, { recursive: true, force: true });
}

it("accepts a GitHub skill folder and rejects unsafe or ambiguous addresses", () => {
  expect(source).toEqual({
    owner: "example",
    repo: "repo",
    ref: "main",
    directory: "skills/example",
  });
  expect(
    parseGitHubSkillSource("https://github.com/example/repo/tree/feature%2Fwriting/skills/example")
      .ref,
  ).toBe("feature/writing");
  for (const bad of [
    "https://example.com/example/repo/tree/main/skill",
    "http://github.com/a/b/tree/main/skill",
    "https://github.com/a/b/tree/main/foo%2fbar",
    "https://github.com/a/b/tree/main/CON",
    "https://github.com/a/b/blob/main/skill/SKILL.md",
    "https://github.com/a/b/tree/main/skill?x=1",
  ]) {
    expect(() => parseGitHubSkillSource(bad)).toThrow();
  }
});

it("pins the commit and verifies each installed file against its Git blob", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-github-skill-test-"));
  try {
    const reference = "참고 자료";
    const tree = [
      {
        path: "skills/example/SKILL.md",
        type: "blob",
        mode: "100644",
        sha: blob(skill),
        size: Buffer.byteLength(skill),
      },
      {
        path: "skills/example/references/guide.txt",
        type: "blob",
        mode: "100644",
        sha: blob(reference),
        size: Buffer.byteLength(reference),
      },
      { path: "skills/other/SKILL.md", type: "blob", mode: "100644", sha: blob("other"), size: 5 },
    ];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/commits/main")) return Response.json({ sha: commit });
      if (value.includes(`/git/trees/${commit}`)) return Response.json({ tree, truncated: false });
      if (value.endsWith("/SKILL.md")) return new Response(skill);
      if (value.endsWith("/references/guide.txt")) return new Response(reference);
      throw new Error(`unexpected ${value}`);
    });
    expect(await downloadGitHubSkill(source, directory, fetcher)).toBe(commit);
    expect(await NodeFSP.readFile(NodePath.join(directory, "SKILL.md"), "utf8")).toBe(skill);
    expect(
      await NodeFSP.readFile(NodePath.join(directory, "references", "guide.txt"), "utf8"),
    ).toBe(reference);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes(`/repo/${commit}/`))).toBe(true);
  } finally {
    await cleanupTestDirectory(directory);
  }
});

it("rejects symlinks and files that differ from the pinned revision", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-github-skill-test-"));
  try {
    const fetcher = (mode: string) =>
      vi.fn(async (url: string | URL | Request) => {
        const value = String(url);
        if (value.endsWith("/commits/main")) return Response.json({ sha: commit });
        if (value.includes("/git/trees/"))
          return Response.json({
            tree: [
              {
                path: "skills/example/SKILL.md",
                type: "blob",
                mode,
                sha: blob(skill),
                size: Buffer.byteLength(skill),
              },
            ],
            truncated: false,
          });
        return new Response("unexpected content");
      });
    await expect(downloadGitHubSkill(source, directory, fetcher("120000"))).rejects.toThrow();
    await expect(downloadGitHubSkill(source, directory, fetcher("100644"))).rejects.toThrow();
  } finally {
    await cleanupTestDirectory(directory);
  }
});
