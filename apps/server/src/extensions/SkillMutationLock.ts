// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import {
  currentSkillProcessIdentity,
  skillProcessLiveness,
  type SkillProcessIdentity,
} from "./SkillProcessIdentity.ts";

const LOCK_WAIT_MS = 120_000;
const LOCK_RETRY_MS = 100;
const OWNER_FILE = "owner";
const IDENTITY_FILE = "identity.json";

export class SkillMutationLockBusyError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string) {
    super(
      `다른 스킬 작업이 끝나지 않았습니다. 실행 중인 작업을 확인하세요. 잠금 위치: ${lockPath}`,
    );
    this.lockPath = lockPath;
  }
}

export type SkillMutationLock = {
  readonly path: string;
  readonly owner: string;
  readonly device: number;
  readonly inode: number;
  readonly process: SkillProcessIdentity | null;
  readonly target?: string;
};

type LockRecord = {
  readonly version: 1;
  readonly owner: string;
  readonly process: SkillProcessIdentity | null;
  readonly target?: string;
};
let cachedIdentity: SkillProcessIdentity | null = null;
async function ownIdentity(
  platform: NodeJS.Platform | undefined,
): Promise<SkillProcessIdentity | null> {
  if (!platform) return null;
  if (cachedIdentity?.platform !== platform) cachedIdentity = null;
  cachedIdentity ??= await currentSkillProcessIdentity(platform);
  return cachedIdentity;
}

function validIdentity(value: unknown): value is SkillProcessIdentity {
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

async function readLock(lockPath: string): Promise<SkillMutationLock | null> {
  try {
    const dir = await NodeFSP.lstat(lockPath);
    const ownerPath = NodePath.join(lockPath, OWNER_FILE);
    const identityPath = NodePath.join(lockPath, IDENTITY_FILE);
    const ownerStat = await NodeFSP.lstat(ownerPath);
    const identityStat = await NodeFSP.lstat(identityPath);
    if (
      !dir.isDirectory() ||
      dir.isSymbolicLink() ||
      !ownerStat.isFile() ||
      ownerStat.isSymbolicLink() ||
      ownerStat.size > 128 ||
      !identityStat.isFile() ||
      identityStat.isSymbolicLink() ||
      identityStat.size > 2048
    )
      return null;
    const owner = await NodeFSP.readFile(ownerPath, "utf8");
    const record: unknown = JSON.parse(await NodeFSP.readFile(identityPath, "utf8"));
    if (!/^[a-f0-9-]{36}$/u.test(owner) || !record || typeof record !== "object") return null;
    const item = record as Record<string, unknown>;
    if (
      item.version !== 1 ||
      item.owner !== owner ||
      (item.process !== null && !validIdentity(item.process)) ||
      (item.target !== undefined &&
        (typeof item.target !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(item.target)))
    )
      return null;
    return {
      path: lockPath,
      owner,
      device: dir.dev,
      inode: dir.ino,
      process: item.process as SkillProcessIdentity | null,
      ...(typeof item.target === "string" ? { target: item.target } : {}),
    };
  } catch {
    return null;
  }
}

async function createLock(
  lockPath: string,
  identity: SkillProcessIdentity | null,
  target?: string,
): Promise<SkillMutationLock> {
  await NodeFSP.mkdir(lockPath);
  const owner = NodeCrypto.randomUUID();
  try {
    const stat = await NodeFSP.lstat(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid lock directory");
    await NodeFSP.writeFile(NodePath.join(lockPath, OWNER_FILE), owner, { flag: "wx" });
    const record: LockRecord = {
      version: 1,
      owner,
      process: identity,
      ...(target ? { target } : {}),
    };
    await NodeFSP.writeFile(NodePath.join(lockPath, IDENTITY_FILE), JSON.stringify(record), {
      flag: "wx",
    });
    return {
      path: lockPath,
      owner,
      device: stat.dev,
      inode: stat.ino,
      process: identity,
      ...(target ? { target } : {}),
    };
  } catch (error) {
    await NodeFSP.unlink(NodePath.join(lockPath, OWNER_FILE)).catch(() => {});
    await NodeFSP.rmdir(lockPath).catch(() => {});
    throw error;
  }
}

async function clearMovedLock(lock: SkillMutationLock): Promise<void> {
  const current = await readLock(lock.path);
  if (
    !current ||
    current.owner !== lock.owner ||
    current.device !== lock.device ||
    current.inode !== lock.inode
  )
    return;
  await NodeFSP.unlink(NodePath.join(lock.path, IDENTITY_FILE)).catch(() => {});
  await NodeFSP.unlink(NodePath.join(lock.path, OWNER_FILE)).catch(() => {});
  await NodeFSP.rmdir(lock.path).catch(() => {});
}

async function reclaimDeadLock(
  lockPath: string,
  identity: SkillProcessIdentity,
  platform: NodeJS.Platform,
  depth = 0,
): Promise<boolean> {
  if (depth > 8) return false;
  const old = await readLock(lockPath);
  if (!old?.process || (await skillProcessLiveness(old.process, platform)) !== "dead") return false;
  const guardPath = `${lockPath}.reclaim`;
  let guard: SkillMutationLock;
  try {
    guard = await createLock(guardPath, identity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      await reclaimDeadLock(guardPath, identity, platform, depth + 1);
    return false;
  }
  try {
    const again = await readLock(lockPath);
    if (
      !again?.process ||
      again.owner !== old.owner ||
      again.device !== old.device ||
      again.inode !== old.inode ||
      (await skillProcessLiveness(again.process, platform)) !== "dead"
    )
      return false;
    const moved = `${lockPath}.dead-${NodeCrypto.randomUUID()}`;
    await NodeFSP.rename(lockPath, moved);
    return true;
  } catch {
    return false;
  } finally {
    await releaseSkillMutationLock(guard);
  }
}

/** Keep a dead owner's record until its interrupted publication is resolved. */
export async function pendingSkillRecoveryEvidence(
  lock: SkillMutationLock,
  platform: NodeJS.Platform,
): Promise<{
  readonly pending: ReadonlyArray<SkillMutationLock>;
  readonly unknown: boolean;
}> {
  const root = NodePath.dirname(lock.path);
  const prefix = `${NodePath.basename(lock.path)}.dead-`;
  const names = (await NodeFSP.readdir(root)).filter((name) => name.startsWith(prefix));
  if (names.length > 512) return { pending: [], unknown: true };
  const pending: SkillMutationLock[] = [];
  let unknown = false;
  for (const name of names) {
    const old = await readLock(NodePath.join(root, name));
    if (!old?.process || (await skillProcessLiveness(old.process, platform)) !== "dead")
      unknown = true;
    else pending.push(old);
  }
  return { pending, unknown };
}

export async function settleSkillRecoveryEvidence(
  evidence: SkillMutationLock,
  platform: NodeJS.Platform,
): Promise<void> {
  if (!evidence.process || (await skillProcessLiveness(evidence.process, platform)) !== "dead")
    return;
  await clearMovedLock(evidence);
}

export async function listInterruptedSkillTargets(root: string): Promise<ReadonlyArray<string>> {
  let names: string[];
  try {
    names = await NodeFSP.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (names.length > 5000) return [];
  const targets = new Set<string>();
  for (const name of names) {
    const match = /^\.t3-skill-lock-([a-f0-9]{64})(?:\.dead-[a-f0-9-]{36})?$/u.exec(name);
    if (!match) continue;
    const record = await readLock(NodePath.join(root, name));
    if (!record?.target || !record.process) continue;
    const digest = NodeCrypto.createHash("sha256")
      .update(record.target.toLowerCase())
      .digest("hex");
    if (digest === match[1]) targets.add(record.target);
  }
  return [...targets].slice(0, 128);
}

/** Use an atomic directory shared by all servers writing the same skill root. */
export async function acquireSkillMutationLock(
  root: string,
  name: string,
  options?: {
    readonly timeoutMs?: number;
    readonly onContention?: () => void;
    readonly platform?: NodeJS.Platform;
  },
): Promise<SkillMutationLock> {
  await NodeFSP.mkdir(root, { recursive: true });
  const canonicalRoot = await NodeFSP.realpath(root);
  const key = name.toLowerCase();
  const digest = NodeCrypto.createHash("sha256").update(key).digest("hex");
  const lockPath = NodePath.join(canonicalRoot, `.t3-skill-lock-${digest}`);
  const identity = await ownIdentity(options?.platform);
  const start = performance.now();
  for (;;) {
    try {
      return await createLock(lockPath, identity, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      options?.onContention?.();
      if (
        identity &&
        options?.platform &&
        (await reclaimDeadLock(lockPath, identity, options.platform))
      )
        continue;
      if (performance.now() - start >= (options?.timeoutMs ?? LOCK_WAIT_MS))
        throw new SkillMutationLockBusyError(lockPath);
      await NodeTimersPromises.setTimeout(LOCK_RETRY_MS);
    }
  }
}

/** Never recursively remove a lock or clear one owned by another process. */
export async function releaseSkillMutationLock(lock: SkillMutationLock): Promise<void> {
  try {
    const current = await readLock(lock.path);
    if (
      !current ||
      current.owner !== lock.owner ||
      current.device !== lock.device ||
      current.inode !== lock.inode
    )
      return;
    const moved = `${lock.path}.released-${NodeCrypto.randomUUID()}`;
    await NodeFSP.rename(lock.path, moved);
    await clearMovedLock({ ...current, path: moved });
  } catch {
    // An unknown or changed lock is not ours to remove.
  }
}
