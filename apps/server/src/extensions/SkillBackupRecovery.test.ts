// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { acquireSkillMutationLock, releaseSkillMutationLock } from "./SkillMutationLock.ts";
import * as Identity from "./SkillProcessIdentity.ts";
import { recoverSkillBackup, writeSkillBackupManifest } from "./SkillBackupRecovery.ts";

const platform = NodePath.sep === "\\" ? "win32" : "linux";
async function fixture(run: (root: string) => Promise<void>) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-skill-recovery-test-"));
  if (
    NodePath.dirname(NodePath.resolve(root)) !== NodePath.resolve(NodeOS.tmpdir()) ||
    !NodePath.basename(root).startsWith("t3-skill-recovery-test-")
  )
    throw new Error("invalid fixture path");
  try {
    await run(root);
  } finally {
    vi.restoreAllMocks();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

async function deadOwner(root: string) {
  const script =
    `import {acquireSkillMutationLock} from ${JSON.stringify(new URL("./SkillMutationLock.ts", import.meta.url).href)};` +
    `const v=await acquireSkillMutationLock(process.argv[1],'sample',{platform:process.platform});if(!v.process)process.exit(3);process.stdout.write(JSON.stringify({owner:v.owner,identity:v.process})+'\\n');process.stdin.resume();`;
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["--input-type=module", "--eval", script, root],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stderr.resume();
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const ready = new Promise<Buffer>((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.stdout.once("error", reject);
  });
  try {
    const message = await Promise.race([
      ready,
      exit.then((code) => {
        throw new Error(`child exited: ${code}`);
      }),
    ]);
    const record = JSON.parse(String(message)) as {
      owner: string;
      identity: Identity.SkillProcessIdentity;
    };
    expect(child.kill("SIGKILL")).toBe(true);
    await exit;
    expect(await Identity.skillProcessLiveness(record.identity, platform)).toBe("dead");
    const lock = await acquireSkillMutationLock(root, "sample", { platform });
    return { ...record, lock };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
  }
}

async function backup(root: string, owner: Identity.SkillProcessIdentity, ownerToken: string) {
  const target = NodePath.join(root, "sample");
  await NodeFSP.mkdir(target);
  await NodeFSP.writeFile(NodePath.join(target, "SKILL.md"), "original skill\n");
  await NodeFSP.writeFile(NodePath.join(target, "script.js"), "original script\n");
  await NodeFSP.writeFile(
    NodePath.join(target, ".t3-installed-skill.json"),
    JSON.stringify({
      name: "sample",
      provider: "codex",
      source: "fixture",
      installedAt: "2000-01-01T00:00:00Z",
    }),
  );
  const folder = await NodeFSP.mkdtemp(NodePath.join(root, ".t3-skill-backup-"));
  await writeSkillBackupManifest({
    backup: folder,
    destination: target,
    parent: "enabled",
    owner,
    ownerToken,
  });
  const previous = NodePath.join(folder, "previous");
  await NodeFSP.rename(target, previous);
  return { folder, previous, target };
}

it("restores a single verified backup while retaining the original backup", async () => {
  await fixture(async (root) => {
    const { identity, owner, lock } = await deadOwner(root);
    const saved = await backup(root, identity, owner);
    try {
      expect(await recoverSkillBackup(root, "sample", platform, lock)).toBe(saved.previous);
      expect(await NodeFSP.readFile(NodePath.join(saved.target, "SKILL.md"), "utf8")).toBe(
        "original skill\n",
      );
      expect(await NodeFSP.readFile(NodePath.join(saved.previous, "script.js"), "utf8")).toBe(
        "original script\n",
      );
    } finally {
      await releaseSkillMutationLock(lock);
    }
  });
});

it("leaves live or unknown owners and unidentifiable old backups untouched", async () => {
  await fixture(async (root) => {
    const lock = await acquireSkillMutationLock(root, "sample", { platform });
    const live = lock.process;
    expect(live).not.toBeNull();
    if (!live) return;
    const saved = await backup(root, live, lock.owner);
    await expect(recoverSkillBackup(root, "sample", platform, lock)).rejects.toThrow(/출처/);
    expect(await NodeFSP.readFile(NodePath.join(saved.previous, "SKILL.md"), "utf8")).toBe(
      "original skill\n",
    );
    const legacy = await NodeFSP.mkdtemp(NodePath.join(root, ".t3-skill-backup-"));
    await NodeFSP.mkdir(NodePath.join(legacy, "previous"));
    await NodeFSP.writeFile(NodePath.join(legacy, "previous", "SKILL.md"), "legacy\n");
    await expect(recoverSkillBackup(root, "sample", platform, lock)).rejects.toThrow(/출처/);
    expect(await NodeFSP.readFile(NodePath.join(legacy, "previous", "SKILL.md"), "utf8")).toBe(
      "legacy\n",
    );
    await expect(NodeFSP.lstat(saved.target)).rejects.toMatchObject({ code: "ENOENT" });
    await releaseSkillMutationLock(lock);
  });
  await fixture(async (root) => {
    const { identity, owner, lock } = await deadOwner(root);
    const saved = await backup(
      root,
      { ...identity, boot: "f".repeat(identity.boot.length) },
      owner,
    );
    await expect(recoverSkillBackup(root, "sample", platform, lock)).rejects.toThrow(/출처/);
    expect(await NodeFSP.readFile(NodePath.join(saved.previous, "SKILL.md"), "utf8")).toBe(
      "original skill\n",
    );
    await expect(NodeFSP.lstat(saved.target)).rejects.toMatchObject({ code: "ENOENT" });
    await releaseSkillMutationLock(lock);
  });
});

it("does not block an unrelated new target solely because a legacy backup exists", async () => {
  await fixture(async (root) => {
    const legacy = await NodeFSP.mkdtemp(NodePath.join(root, ".t3-skill-backup-"));
    await NodeFSP.mkdir(NodePath.join(legacy, "previous"));
    await NodeFSP.writeFile(NodePath.join(legacy, "previous", "SKILL.md"), "do not alter\n");
    const lock = await acquireSkillMutationLock(root, "unrelated", { platform });
    try {
      expect(await recoverSkillBackup(root, "unrelated", platform, lock)).toBeNull();
      expect(await NodeFSP.readFile(NodePath.join(legacy, "previous", "SKILL.md"), "utf8")).toBe(
        "do not alter\n",
      );
    } finally {
      await releaseSkillMutationLock(lock);
    }
  });
});

it("keeps an unnamed backup untouched when a dead owner's matching backup could be ambiguous", async () => {
  await fixture(async (root) => {
    const { identity, owner, lock } = await deadOwner(root);
    const saved = await backup(root, identity, owner);
    const legacy = await NodeFSP.mkdtemp(NodePath.join(root, ".t3-skill-backup-"));
    await NodeFSP.mkdir(NodePath.join(legacy, "previous"));
    await NodeFSP.writeFile(NodePath.join(legacy, "previous", "SKILL.md"), "unidentified\n");
    try {
      await expect(recoverSkillBackup(root, "sample", platform, lock)).rejects.toThrow(/출처/);
      expect(await NodeFSP.readFile(NodePath.join(saved.previous, "SKILL.md"), "utf8")).toBe(
        "original skill\n",
      );
      expect(await NodeFSP.readFile(NodePath.join(legacy, "previous", "SKILL.md"), "utf8")).toBe(
        "unidentified\n",
      );
      await expect(NodeFSP.lstat(saved.target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await releaseSkillMutationLock(lock);
    }
  });
});

it("does not choose between multiple backups or restore a changed backup", async () => {
  await fixture(async (root) => {
    const { identity, owner, lock } = await deadOwner(root);
    const first = await backup(root, identity, owner);
    const second = await backup(root, identity, owner);
    await expect(recoverSkillBackup(root, "sample", platform, lock)).rejects.toThrow(/여러 개/);
    expect(await NodeFSP.readFile(NodePath.join(first.previous, "SKILL.md"), "utf8")).toBe(
      "original skill\n",
    );
    expect(await NodeFSP.readFile(NodePath.join(second.previous, "SKILL.md"), "utf8")).toBe(
      "original skill\n",
    );
    await releaseSkillMutationLock(lock);
  });
  await fixture(async (root) => {
    const { identity, owner, lock } = await deadOwner(root);
    const saved = await backup(root, identity, owner);
    await NodeFSP.writeFile(NodePath.join(saved.previous, "script.js"), "changed by user\n");
    await expect(recoverSkillBackup(root, "sample", platform, lock)).rejects.toThrow(/무결성/);
    expect(await NodeFSP.readFile(NodePath.join(saved.previous, "script.js"), "utf8")).toBe(
      "changed by user\n",
    );
    await expect(NodeFSP.lstat(saved.target)).rejects.toMatchObject({ code: "ENOENT" });
    await releaseSkillMutationLock(lock);
  });
});

it("never overwrites a destination created during restoration", async () => {
  await fixture(async (root) => {
    const { identity, owner, lock } = await deadOwner(root);
    const saved = await backup(root, identity, owner);
    const move = Identity.moveSkillDirectoryNoReplace;
    vi.spyOn(Identity, "moveSkillDirectoryNoReplace").mockImplementationOnce(
      async (source, destination, actualPlatform) => {
        await NodeFSP.mkdir(destination);
        await NodeFSP.writeFile(NodePath.join(destination, "user.txt"), "keep\n");
        return move(source, destination, actualPlatform);
      },
    );
    await expect(recoverSkillBackup(root, "sample", platform, lock)).rejects.toThrow(/덮지 않고/);
    expect(await NodeFSP.readFile(NodePath.join(saved.target, "user.txt"), "utf8")).toBe("keep\n");
    expect(await NodeFSP.readFile(NodePath.join(saved.previous, "SKILL.md"), "utf8")).toBe(
      "original skill\n",
    );
    await releaseSkillMutationLock(lock);
  });
});
