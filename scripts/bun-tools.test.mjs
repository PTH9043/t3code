import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import { BUN_VERSION, bunArguments, bunExecutable } from "./bun-tools.mjs";

async function removeScratch(scratch) {
  const resolved = await NodeFSP.realpath(scratch);
  NodeAssert.equal(NodePath.dirname(resolved), await NodeFSP.realpath(NodeOS.tmpdir()));
  NodeAssert.ok(NodePath.basename(resolved).startsWith("t3-bun-tools-"));
  await NodeFSP.rm(resolved, { recursive: true });
}

NodeTest.test("requires an explicit check scope", () => {
  NodeAssert.throws(() => bunArguments("fmt-check", []));
  NodeAssert.throws(() => bunArguments("fmt", ["--staged"]));
  NodeAssert.throws(() => bunArguments("check", ["--build"]));
});

NodeTest.test(
  "built-in formatting and type checks cannot run same-named package scripts",
  async () => {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bun-tools-"));
    try {
      await NodeFSP.writeFile(
        NodePath.join(scratch, "package.json"),
        JSON.stringify({
          scripts: { fmt: "node trap.cjs", check: "node trap.cjs" },
        }),
      );
      await NodeFSP.writeFile(
        NodePath.join(scratch, "trap.cjs"),
        "require('node:fs').writeFileSync('unexpected-script', 'ran')",
      );
      await NodeFSP.writeFile(
        NodePath.join(scratch, "fixture.ts"),
        'const value: number = "wrong";\n',
      );
      await NodeFSP.writeFile(
        NodePath.join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, types: [] },
          include: ["fixture.ts"],
        }),
      );
      const format = NodeChildProcess.spawnSync(
        bunExecutable,
        bunArguments("fmt-check", ["fixture.ts"]),
        {
          cwd: scratch,
          encoding: "utf8",
          windowsHide: true,
          shell: false,
        },
      );
      NodeAssert.equal(format.status, 0, format.stdout + format.stderr);
      const check = NodeChildProcess.spawnSync(
        bunExecutable,
        bunArguments("check", ["tsconfig.json"]),
        {
          cwd: scratch,
          encoding: "utf8",
          windowsHide: true,
          shell: false,
        },
      );
      NodeAssert.equal(check.status, 1, check.stdout + check.stderr);
      NodeAssert.match(check.stdout + check.stderr, /not assignable/);
      await NodeAssert.rejects(NodeFSP.access(NodePath.join(scratch, "unexpected-script")));
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(scratch, "fixture.ts"), "utf8"),
        'const value: number = "wrong";\n',
      );
    } finally {
      await removeScratch(scratch);
    }
  },
);

NodeTest.test(
  "setup rejects an unverified archive and preserves an existing unknown binary",
  { skip: NodePath.basename(bunExecutable) !== "bun.exe" },
  async () => {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bun-tools-"));
    try {
      await NodeFSP.mkdir(NodePath.join(scratch, "scripts"));
      const installer = NodePath.join(scratch, "scripts/setup-bun.py");
      await NodeFSP.copyFile(new URL("./setup-bun.py", import.meta.url), installer);
      const manifest = JSON.parse(
        await NodeFSP.readFile(new URL("./bun-release.json", import.meta.url), "utf8"),
      );
      const badArchive = NodePath.join(scratch, "bad.zip");
      await NodeFSP.writeFile(badArchive, "unverified archive");
      manifest.url = NodeURL.pathToFileURL(badArchive).href;
      await NodeFSP.writeFile(
        NodePath.join(scratch, "scripts/bun-release.json"),
        JSON.stringify(manifest),
      );
      const invoke = () =>
        NodeChildProcess.spawnSync("python", [installer], {
          cwd: scratch,
          encoding: "utf8",
          windowsHide: true,
          shell: false,
        });
      const rejected = invoke();
      NodeAssert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
      NodeAssert.match(rejected.stderr, /checksum did not match/);
      const destination = NodePath.join(scratch, ".t3/tools/bun", BUN_VERSION, "bun.exe");
      await NodeAssert.rejects(NodeFSP.access(destination));
      await NodeFSP.writeFile(destination, "existing binary");
      const existing = invoke();
      NodeAssert.equal(existing.status, 1, existing.stdout + existing.stderr);
      NodeAssert.match(existing.stderr, /was not overwritten/);
      NodeAssert.equal(await NodeFSP.readFile(destination, "utf8"), "existing binary");
    } finally {
      await removeScratch(scratch);
    }
  },
);
