// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  moveSkillDirectoryNoReplace,
  skillProcessLiveness,
  type SkillProcessIdentity,
} from "./SkillProcessIdentity.ts";
import { validateStagedSkillDocument } from "./SkillSecurity.ts";
import {
  pendingSkillRecoveryEvidence,
  settleSkillRecoveryEvidence,
  type SkillMutationLock,
} from "./SkillMutationLock.ts";

const MANIFEST = "recovery.json";
const MAX_FILES = 512;
const MAX_BYTES = 64 * 1024 * 1024;
const BACKUP_PREFIX = ".t3-skill-backup-";

type BackupManifest = {
  readonly version: 1;
  readonly target: string;
  readonly parent: "enabled" | "disabled";
  readonly owner: SkillProcessIdentity | null;
  readonly ownerToken: string;
  readonly device: string;
  readonly inode: string;
  readonly digest: string | null;
};

/** Hash data and paths without following links or exposing their contents. */
export async function fingerprintSkillTree(root: string): Promise<string | null> {
  try {
    const rootStat = await NodeFSP.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const realRoot = await NodeFSP.realpath(root);
    const hash = NodeCrypto.createHash("sha256");
    let count = 0;
    let bytes = 0;
    const walk = async (directory: string, relative: string): Promise<void> => {
      const beforeDir = await NodeFSP.lstat(directory);
      const real = await NodeFSP.realpath(directory);
      const relativeReal = NodePath.relative(realRoot, real);
      if (
        !beforeDir.isDirectory() ||
        beforeDir.isSymbolicLink() ||
        NodePath.isAbsolute(relativeReal) ||
        relativeReal === ".." ||
        relativeReal.startsWith(`..${NodePath.sep}`)
      )
        throw new Error("outside root");
      const entries = (await NodeFSP.readdir(directory)).sort();
      for (const name of entries) {
        if (++count > MAX_FILES) throw new Error("too many files");
        const next = relative ? `${relative}/${name}` : name;
        const file = NodePath.join(directory, name);
        const before = await NodeFSP.lstat(file);
        if (before.isSymbolicLink()) {
          hash.update(`L${JSON.stringify(next)}:${JSON.stringify(await NodeFSP.readlink(file))}\n`);
        } else if (before.isDirectory()) {
          hash.update(`D${JSON.stringify(next)}\n`);
          await walk(file, next);
        } else if (before.isFile() && before.nlink === 1) {
          bytes += before.size;
          if (bytes > MAX_BYTES) throw new Error("too large");
          const handle = await NodeFSP.open(
            file,
            NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
          );
          try {
            const opened = await handle.stat();
            if (
              !opened.isFile() ||
              opened.dev !== before.dev ||
              opened.ino !== before.ino ||
              opened.size !== before.size
            )
              throw new Error("changed");
            hash.update(`F${JSON.stringify(next)}:${before.size}:${before.mode & 0o777}\n`);
            const buffer = Buffer.allocUnsafe(64 * 1024);
            let offset = 0;
            while (offset < before.size) {
              const result = await handle.read(
                buffer,
                0,
                Math.min(buffer.length, before.size - offset),
                offset,
              );
              if (!result.bytesRead) throw new Error("unreadable");
              hash.update(buffer.subarray(0, result.bytesRead));
              offset += result.bytesRead;
            }
            const after = await handle.stat();
            const current = await NodeFSP.lstat(file);
            if (
              !current.isFile() ||
              current.isSymbolicLink() ||
              current.dev !== before.dev ||
              current.ino !== before.ino ||
              after.size !== before.size ||
              after.mtimeMs !== before.mtimeMs ||
              after.ctimeMs !== before.ctimeMs
            )
              throw new Error("changed");
          } finally {
            await handle.close();
          }
        } else throw new Error("unsupported file");
      }
      const afterDir = await NodeFSP.lstat(directory);
      if (
        !afterDir.isDirectory() ||
        afterDir.isSymbolicLink() ||
        afterDir.dev !== beforeDir.dev ||
        afterDir.ino !== beforeDir.ino ||
        afterDir.mtimeMs !== beforeDir.mtimeMs ||
        afterDir.ctimeMs !== beforeDir.ctimeMs
      )
        throw new Error("changed directory");
    };
    await walk(root, "");
    return hash.digest("hex");
  } catch {
    return null;
  }
}

export async function writeSkillBackupManifest(input: {
  backup: string;
  destination: string;
  parent: "enabled" | "disabled";
  owner: SkillProcessIdentity | null;
  ownerToken: string;
}): Promise<void> {
  const stat = await NodeFSP.lstat(input.destination, { bigint: true });
  const digest = await fingerprintSkillTree(input.destination);
  const record: BackupManifest = {
    version: 1,
    target: NodePath.basename(input.destination),
    parent: input.parent,
    owner: input.owner,
    ownerToken: input.ownerToken,
    device: String(stat.dev),
    inode: String(stat.ino),
    digest,
  };
  await NodeFSP.writeFile(NodePath.join(input.backup, MANIFEST), JSON.stringify(record), {
    flag: "wx",
  });
}

function identityValid(value: unknown): value is SkillProcessIdentity {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    (item.platform === "win32" || item.platform === "linux") &&
    Number.isSafeInteger(item.pid) &&
    (item.pid as number) > 0 &&
    typeof item.boot === "string" &&
    /^[a-f0-9-]{32,36}$/u.test(item.boot) &&
    typeof item.namespace === "string" &&
    /^(?:windows|pid:\[\d+\])$/u.test(item.namespace) &&
    typeof item.started === "string" &&
    /^\d{1,24}$/u.test(item.started)
  );
}

async function readManifest(backup: string): Promise<BackupManifest | null> {
  try {
    const file = NodePath.join(backup, MANIFEST);
    const stat = await NodeFSP.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const value: unknown = JSON.parse(await NodeFSP.readFile(file, "utf8"));
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    if (
      item.version !== 1 ||
      typeof item.target !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(item.target) ||
      (item.parent !== "enabled" && item.parent !== "disabled") ||
      !identityValid(item.owner) ||
      typeof item.ownerToken !== "string" ||
      !/^[a-f0-9-]{36}$/u.test(item.ownerToken) ||
      typeof item.device !== "string" ||
      !/^\d+$/u.test(item.device) ||
      typeof item.inode !== "string" ||
      !/^\d+$/u.test(item.inode) ||
      typeof item.digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.digest)
    )
      return null;
    return item as BackupManifest;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await NodeFSP.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Restore only a single, identifiable backup; retain the backup itself. */
export async function recoverSkillBackup(
  root: string,
  name: string,
  platform: NodeJS.Platform,
  lock: SkillMutationLock,
): Promise<string | null> {
  const parents = [
    { path: root, role: "enabled" as const },
    { path: `${root}-disabled`, role: "disabled" as const },
  ];
  const evidence = await pendingSkillRecoveryEvidence(lock, platform);
  if (
    (await exists(NodePath.join(root, name))) ||
    (await exists(NodePath.join(`${root}-disabled`, name)))
  ) {
    for (const item of evidence.pending) await settleSkillRecoveryEvidence(item, platform);
    return null;
  }
  const candidates: Array<{
    backup: string;
    previous: string;
    manifest: BackupManifest;
    destination: string;
    evidence: SkillMutationLock;
  }> = [];
  let ambiguous = evidence.unknown;
  let unidentifiedBackup = false;
  for (const parent of parents) {
    let entries: string[];
    try {
      entries = await NodeFSP.readdir(parent.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (entries.length > 5000)
      throw new Error("스킬 백업 목록이 너무 많아 자동 복구하지 않았습니다.");
    for (const entry of entries.filter((item) => item.startsWith(BACKUP_PREFIX))) {
      const backup = NodePath.join(parent.path, entry);
      const stat = await NodeFSP.lstat(backup);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        unidentifiedBackup = true;
        continue;
      }
      const previous = NodePath.join(backup, "previous");
      if (!(await exists(previous))) continue;
      const manifest = await readManifest(backup);
      if (!manifest || manifest.parent !== parent.role) {
        unidentifiedBackup = true;
        continue;
      }
      if (manifest.target.toLowerCase() === name.toLowerCase()) {
        const owner = evidence.pending.find(
          (item) =>
            item.owner === manifest.ownerToken &&
            item.process?.platform === manifest.owner?.platform &&
            item.process?.pid === manifest.owner?.pid &&
            item.process?.boot === manifest.owner?.boot &&
            item.process?.namespace === manifest.owner?.namespace &&
            item.process?.started === manifest.owner?.started,
        );
        if (!owner) {
          ambiguous = true;
          continue;
        }
        candidates.push({
          backup,
          previous,
          manifest,
          destination: NodePath.join(parent.path, manifest.target),
          evidence: owner,
        });
      }
    }
  }
  if (ambiguous || candidates.length > 1 || (unidentifiedBackup && evidence.pending.length > 0))
    throw new Error("스킬 백업이 여러 개이거나 출처를 확인할 수 없어 자동 복구하지 않았습니다.");
  const candidate = candidates[0];
  if (!candidate) return null;
  const { previous, manifest, destination } = candidate;
  if (!manifest.owner || (await skillProcessLiveness(manifest.owner, platform)) !== "dead")
    throw new Error(
      `백업 작업의 종료 여부를 확인하지 못해 자동 복구하지 않았습니다. 백업 위치: ${previous}`,
    );
  const stat = await NodeFSP.lstat(previous, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    String(stat.dev) !== manifest.device ||
    String(stat.ino) !== manifest.inode ||
    (await fingerprintSkillTree(previous)) !== manifest.digest
  )
    throw new Error(`백업의 무결성을 확인하지 못했습니다. 백업 위치: ${previous}`);
  await validateStagedSkillDocument(previous);
  const receiptPath = NodePath.join(previous, ".t3-installed-skill.json");
  const receiptStat = await NodeFSP.lstat(receiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.size > 1024 * 1024)
    throw new Error("백업의 스킬 기록을 확인하지 못했습니다.");
  const receipt: unknown = JSON.parse(await NodeFSP.readFile(receiptPath, "utf8"));
  if (
    !receipt ||
    typeof receipt !== "object" ||
    (receipt as Record<string, unknown>).name !== manifest.target ||
    !["codex", "claudeAgent", "grok"].includes(
      String((receipt as Record<string, unknown>).provider),
    )
  )
    throw new Error("백업의 스킬 기록이 일치하지 않습니다.");
  const parent = NodePath.resolve(NodePath.dirname(destination));
  const temp = await NodeFSP.mkdtemp(NodePath.join(parent, ".t3-skill-restore-"));
  try {
    const copy = NodePath.join(temp, "skill");
    await NodeFSP.cp(previous, copy, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
    if (
      (await fingerprintSkillTree(copy)) !== manifest.digest ||
      (await fingerprintSkillTree(previous)) !== manifest.digest
    )
      throw new Error("복구 중 백업이 변경돼 자동 복구하지 않았습니다.");
    if (!(await moveSkillDirectoryNoReplace(copy, destination, platform)))
      throw new Error(`기존 파일을 덮지 않고 복구하지 못했습니다. 백업 위치: ${previous}`);
    await settleSkillRecoveryEvidence(candidate.evidence, platform);
    return previous;
  } finally {
    if (
      NodePath.dirname(NodePath.resolve(temp)) === parent &&
      NodePath.basename(temp).startsWith(".t3-skill-restore-")
    )
      await NodeFSP.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Names are hints only; recovery still checks the matching dead-owner record. */
export async function listSkillRecoveryTargets(root: string): Promise<ReadonlyArray<string>> {
  const names = new Set<string>();
  for (const parent of [
    { path: root, role: "enabled" as const },
    { path: `${root}-disabled`, role: "disabled" as const },
  ]) {
    let entries: string[];
    try {
      entries = await NodeFSP.readdir(parent.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (entries.length > 5000) return [];
    for (const entry of entries.filter((item) => item.startsWith(BACKUP_PREFIX))) {
      const folder = NodePath.join(parent.path, entry);
      const stat = await NodeFSP.lstat(folder);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !(await exists(NodePath.join(folder, "previous")))
      )
        continue;
      const manifest = await readManifest(folder);
      if (manifest?.parent === parent.role) names.add(manifest.target);
    }
  }
  return [...names].slice(0, 128);
}
