// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { currentSkillProcessIdentity, skillProcessLiveness } from "./SkillProcessIdentity.ts";

const platform = NodePath.sep === "\\" ? "win32" : "linux";

it("distinguishes the live identity, PID reuse, and an unknown boot", async () => {
  const identity = await currentSkillProcessIdentity(platform);
  expect(identity).not.toBeNull();
  if (!identity) return;
  expect(await skillProcessLiveness(identity, platform)).toBe("alive");
  expect(
    await skillProcessLiveness(
      { ...identity, started: String(BigInt(identity.started) + 1n) },
      platform,
    ),
  ).toBe("dead");
  expect(
    await skillProcessLiveness({ ...identity, boot: "f".repeat(identity.boot.length) }, platform),
  ).toBe("unknown");
});

it("observes the termination of an exact synthetic child process", async () => {
  const script =
    `import { currentSkillProcessIdentity } from ${JSON.stringify(new URL("./SkillProcessIdentity.ts", import.meta.url).href)};\n` +
    `const identity=await currentSkillProcessIdentity(process.platform); if(!identity) process.exit(3);\n` +
    `process.stdout.write(JSON.stringify(identity)+'\\n'); process.stdin.resume();`;
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["--input-type=module", "--eval", script],
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
    const identity = JSON.parse(String(message));
    expect(await skillProcessLiveness(identity, platform)).toBe("alive");
    expect(child.kill("SIGKILL")).toBe(true);
    await exit;
    expect(await skillProcessLiveness(identity, platform)).toBe("dead");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
  }
});
