// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  acquireSkillMutationLock,
  releaseSkillMutationLock,
  SkillMutationLockBusyError,
} from "./SkillMutationLock.ts";
const platform = NodePath.sep === "\\" ? "win32" : "linux";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-skill-lock-test-"));
  if (
    NodePath.dirname(NodePath.resolve(root)) !== NodePath.resolve(NodeOS.tmpdir()) ||
    !NodePath.basename(root).startsWith("t3-skill-lock-test-")
  )
    throw new Error("invalid fixture path");
  try {
    await run(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

it("serializes a shared target but permits another target and never deletes a foreign lock", async () => {
  await fixture(async (root) => {
    const first = await acquireSkillMutationLock(root, "sample");
    let contended!: () => void;
    const waiting = new Promise<void>((resolve) => {
      contended = resolve;
    });
    const second = acquireSkillMutationLock(root, "sample", { onContention: contended });
    try {
      await waiting;
      const other = await acquireSkillMutationLock(root, "other", { timeoutMs: 0 });
      await releaseSkillMutationLock(other);
      await expect(
        acquireSkillMutationLock(root, "sample", { timeoutMs: 0 }),
      ).rejects.toBeInstanceOf(SkillMutationLockBusyError);
      await releaseSkillMutationLock({ ...first, owner: "another-owner" });
      expect(await NodeFSP.readFile(NodePath.join(first.path, "owner"), "utf8")).toBe(first.owner);
    } finally {
      await releaseSkillMutationLock(first);
    }
    await releaseSkillMutationLock(await second);
  });
});

it("coordinates independent processes using the same target directory", async () => {
  await fixture(async (root) => {
    const script =
      `import { acquireSkillMutationLock, releaseSkillMutationLock } from ${JSON.stringify(new URL("./SkillMutationLock.ts", import.meta.url).href)};\n` +
      `const lock = await acquireSkillMutationLock(process.argv[1], "sample");\n` +
      `process.stdout.write("locked\\n");\nfor await (const _ of process.stdin) break;\n` +
      `await releaseSkillMutationLock(lock);`;
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["--input-type=module", "--eval", script, root],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdin.on("error", () => {});
    let childError = "";
    child.stderr.on("data", (data) => {
      childError += String(data);
    });
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
          throw new Error(`lock test child exited before readiness: ${code}`);
        }),
      ]);
      expect(String(message)).toContain("locked");
      await expect(
        acquireSkillMutationLock(root, "sample", { timeoutMs: 0 }),
      ).rejects.toBeInstanceOf(SkillMutationLockBusyError);
    } finally {
      child.stdin.end("release\n");
      const code = await exit;
      expect(code, childError).toBe(0);
    }
    await releaseSkillMutationLock(
      await acquireSkillMutationLock(root, "sample", { timeoutMs: 0 }),
    );
  });
});

it("preserves a live owner and a legacy lock whose owner cannot be verified", async () => {
  await fixture(async (root) => {
    const live = await acquireSkillMutationLock(root, "live", { platform });
    expect(live.process).not.toBeNull();
    await expect(
      acquireSkillMutationLock(root, "live", { platform, timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(SkillMutationLockBusyError);
    expect(await NodeFSP.readFile(NodePath.join(live.path, "owner"), "utf8")).toBe(live.owner);
    await releaseSkillMutationLock(live);
    const unknown = await acquireSkillMutationLock(root, "unknown", { platform });
    const identityPath = NodePath.join(unknown.path, "identity.json");
    const original = await NodeFSP.readFile(identityPath, "utf8");
    const record = JSON.parse(original);
    record.process.boot = "f".repeat(record.process.boot.length);
    const uncertain = JSON.stringify(record);
    await NodeFSP.writeFile(identityPath, uncertain);
    await expect(
      acquireSkillMutationLock(root, "unknown", { platform, timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(SkillMutationLockBusyError);
    expect(await NodeFSP.readFile(identityPath, "utf8")).toBe(uncertain);
    await NodeFSP.writeFile(identityPath, original);
    await releaseSkillMutationLock(unknown);
    const legacy = await acquireSkillMutationLock(root, "legacy", { platform });
    await NodeFSP.unlink(NodePath.join(legacy.path, "identity.json"));
    await expect(
      acquireSkillMutationLock(root, "legacy", { platform, timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(SkillMutationLockBusyError);
    expect(await NodeFSP.readFile(NodePath.join(legacy.path, "owner"), "utf8")).toBe(legacy.owner);
  });
});

it("reclaims a lock only after its exact synthetic owner is terminated", async () => {
  await fixture(async (root) => {
    const script =
      `import { acquireSkillMutationLock } from ${JSON.stringify(new URL("./SkillMutationLock.ts", import.meta.url).href)};\n` +
      `const lock=await acquireSkillMutationLock(process.argv[1],'sample',{platform:process.platform});\n` +
      `if(!lock.process) process.exit(3); process.stdout.write('locked\\n'); process.stdin.resume();`;
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
      await Promise.race([
        ready,
        exit.then((code) => {
          throw new Error(`child exited: ${code}`);
        }),
      ]);
      await expect(
        acquireSkillMutationLock(root, "sample", { platform, timeoutMs: 0 }),
      ).rejects.toBeInstanceOf(SkillMutationLockBusyError);
      expect(child.kill("SIGKILL")).toBe(true);
      await exit;
      let firstHeld!: () => void;
      let contended!: () => void;
      let releaseFirst!: () => void;
      const held = new Promise<void>((resolve) => {
        firstHeld = resolve;
      });
      const contention = new Promise<void>((resolve) => {
        contended = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let active = 0;
      let peak = 0;
      let acquired = 0;
      const worker = async () => {
        const lock = await acquireSkillMutationLock(root, "sample", {
          platform,
          timeoutMs: 10_000,
          onContention: () => {
            if (active > 0) contended();
          },
        });
        active++;
        peak = Math.max(peak, active);
        acquired++;
        if (acquired === 1) {
          firstHeld();
          await gate;
        }
        active--;
        await releaseSkillMutationLock(lock);
      };
      const first = worker();
      const second = worker();
      await held;
      await contention;
      releaseFirst();
      await Promise.all([first, second]);
      expect(peak).toBe(1);
      expect(acquired).toBe(2);
      const retained = (await NodeFSP.readdir(root)).filter((name) =>
        name.startsWith(".t3-skill-lock-"),
      );
      expect(retained).toHaveLength(1);
      expect(retained[0]).toContain(".dead-");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
    }
  });
});
