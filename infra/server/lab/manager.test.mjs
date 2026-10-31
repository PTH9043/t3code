import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { atomicJson, readState, withLab } from "./manager.mjs";

function temporary(test) {
  const parent = NodeFS.realpathSync(NodeOS.tmpdir());
  const directory = NodeFS.mkdtempSync(NodePath.join(parent, "naud-lab-test-"));
  test.after(() => {
    const resolved = NodeFS.realpathSync(directory);
    NodeAssert.equal(NodePath.dirname(resolved), parent);
    NodeAssert.ok(NodePath.basename(resolved).startsWith("naud-lab-test-"));
    NodeFS.rmSync(resolved, { recursive: true });
  });
  return directory;
}

NodeTest.test("overlapping mutations fail before entering their operation", async (test) => {
  const directory = temporary(test);
  let release;
  let entered;
  const inside = new Promise((resolve) => {
    entered = resolve;
  });
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const first = withLab(directory, async () => {
    entered();
    await hold;
  });
  await inside;
  let secondEntered = false;
  try {
    await NodeAssert.rejects(
      withLab(directory, async () => {
        secondEntered = true;
      }),
      /owns the lock/,
    );
    NodeAssert.equal(secondEntered, false);
  } finally {
    release();
    await first;
  }
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(directory, "operation.lock")), false);
});

NodeTest.test(
  "failure releases the lock and leaves the last committed registry readable",
  async (test) => {
    const directory = temporary(test);
    await NodeAssert.rejects(
      withLab(directory, async () => {
        throw new Error("deliberate failure");
      }),
      /deliberate failure/,
    );
    const original = readState(directory);
    NodeAssert.equal(original.activeId, null);
    await withLab(directory, async (state) => NodeAssert.equal(state.labId, original.labId));
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(directory, "operation.lock")), false);
    NodeAssert.equal(
      NodeFS.readdirSync(directory).some((name) => name.endsWith(".tmp")),
      false,
    );
  },
);

NodeTest.test("unknown registry versions are refused before any Docker action", async (test) => {
  const directory = temporary(test);
  atomicJson(NodePath.join(directory, "state.json"), { schema: 999, activeId: "do-not-use" });
  let entered = false;
  await NodeAssert.rejects(
    withLab(directory, async () => {
      entered = true;
    }),
  );
  NodeAssert.equal(entered, false);
  NodeAssert.equal(readState(directory).schema, 999);
});

NodeTest.test("public proxy config and private registry use distinct permissions", (test) => {
  const directory = temporary(test);
  const config = NodePath.join(directory, "public.json");
  const registry = NodePath.join(directory, "private.json");
  atomicJson(config, { routes: [] }, 0o644);
  atomicJson(registry, { owner: "test" });
  const control = NodePath.join(directory, "permission-support");
  const fd = NodeFS.openSync(control, "wx", 0o600);
  NodeFS.fchmodSync(fd, 0o600);
  NodeFS.closeSync(fd);
  if ((NodeFS.statSync(control).mode & 0o777) === 0o600) {
    NodeAssert.equal(NodeFS.statSync(config).mode & 0o777, 0o644);
    NodeAssert.equal(NodeFS.statSync(registry).mode & 0o777, 0o600);
  } else {
    test.diagnostic("This filesystem does not expose enforceable POSIX mode bits");
  }
});
