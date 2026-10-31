// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- The fixture uses local files and JSON manifests.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { prepareWslManagedRuntime } from "./DesktopWslManagedRuntime.ts";

it("rejects a modified portable runtime before starting a WSL process", async () => {
  const parent = NodeFS.realpathSync(NodeOS.tmpdir());
  const fixture = NodeFS.mkdtempSync(NodePath.join(parent, "t3-wsl-checksum-test-"));
  try {
    const manifestPath = NodePath.join(fixture, "manifest.json");
    NodeFS.writeFileSync(NodePath.join(fixture, "archive.tar.gz"), "not the expected archive");
    NodeFS.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        archive: "archive.tar.gz",
        sha256: "0".repeat(64),
        platform: "linux",
        arch: "x64",
        libc: "musl",
        nodePty: "1.1.0",
      }),
    );
    await expect(
      prepareWslManagedRuntime({
        distro: "must-not-be-started",
        manifestPath,
        serverDirectory: fixture,
        nodeEngineRange: ">=24",
      }),
    ).rejects.toThrow("Managed WSL runtime checksum mismatch");
  } finally {
    removeFixture(fixture, parent);
  }
});

function removeFixture(fixture: string, parent: string) {
  if (
    NodePath.dirname(NodeFS.realpathSync(fixture)) !== parent ||
    !NodePath.basename(fixture).startsWith("t3-wsl-checksum-test-")
  )
    throw new Error("Refusing to remove a non-test directory.");
  NodeFS.rmSync(fixture, { recursive: true, force: true });
}
