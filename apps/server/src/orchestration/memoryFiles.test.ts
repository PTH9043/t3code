// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
  archiveMemoryFile,
  publishMemoryFile,
  verifyHistoryArchive,
  withdrawMemoryPages,
  writeHistoryArchive,
} from "./memoryFiles.ts";

const memory = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  writes: [] as string[],
  removals: [] as string[],
}));

vi.mock("node:fs/promises", () => {
  const missing = () => Object.assign(new Error("File not found"), { code: "ENOENT" });
  return {
    mkdir: async () => undefined,
    readFile: async (filename: string) => {
      const value = memory.files.get(filename);
      if (!value) throw missing();
      return value.toString("utf8");
    },
    writeFile: async (filename: string, text: string, options: { flag: string }) => {
      if (options.flag === "wx" && memory.files.has(filename)) throw new Error("File exists");
      memory.writes.push(filename);
      memory.files.set(filename, Buffer.from(text));
    },
    readdir: async (directory: string) =>
      [...memory.files.keys()]
        .filter((filename) => NodePath.dirname(filename) === directory)
        .map((filename) => NodePath.basename(filename)),
    open: async (filename: string) => {
      if (!memory.files.has(filename)) throw missing();
      return {
        readFile: async () => memory.files.get(filename)!.toString("utf8"),
        write: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const bytesWritten = Math.min(length, 7);
          const current = memory.files.get(filename)!;
          const next = Buffer.alloc(Math.max(current.length, position + bytesWritten));
          current.copy(next);
          buffer.copy(next, position, offset, offset + bytesWritten);
          memory.files.set(filename, next);
          memory.writes.push(filename);
          return { bytesWritten };
        },
        truncate: async (length: number) => {
          memory.files.set(filename, memory.files.get(filename)!.subarray(0, length));
        },
        close: async () => undefined,
      };
    },
    stat: async (filename: string) => ({ size: memory.files.get(filename)!.length }),
    rm: async (filename: string) => {
      memory.removals.push(filename);
      memory.files.delete(filename);
    },
  };
});

vi.mock("node:fs", async () => {
  const { Readable, Writable } = await import("node:stream");
  return {
    createReadStream: (filename: string) => Readable.from([memory.files.get(filename)!]),
    createWriteStream: (filename: string) => {
      const chunks: Buffer[] = [];
      const output = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          memory.files.set(filename, Buffer.concat(chunks));
          callback();
        },
      });
      process.nextTick(() => output.emit("open", 1));
      return output;
    },
  };
});

beforeEach(() => {
  memory.files.clear();
  memory.writes.length = 0;
  memory.removals.length = 0;
});

it("escapes large Unicode records and verifies the archive SHA-256", async () => {
  const record = { payload: '😀\\"\n\t'.repeat(40000), id: "tool", nested: { okay: true } };
  const result = await writeHistoryArchive(
    "memory",
    (async function* () {
      yield record;
    })(),
  );
  const bytes = NodeZlib.gunzipSync(memory.files.get(result.path)!);
  expect(bytes.toString("utf8")).toBe(JSON.stringify(record) + "\n");
  expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(result.sha256);
  await verifyHistoryArchive(result.path, result.sha256);
  await expect(verifyHistoryArchive(result.path, "0".repeat(64))).rejects.toThrow("SHA-256");
});

it("removes the incomplete final archive after producer failure", async () => {
  const rows = async function* () {
    yield { id: 1 };
    throw new Error("source disconnected");
  };
  await expect(writeHistoryArchive("memory", rows())).rejects.toThrow("source disconnected");
  expect(memory.files.size).toBe(0);
  expect(memory.removals).toHaveLength(1);
  expect(memory.removals[0]).toMatch(/\.ndjson\.gz$/);
});

it("updates an existing page directly and skips unchanged publication", async () => {
  const file = NodePath.join("memory", "topic.md");
  await publishMemoryFile(file, "Initial decision");
  await publishMemoryFile(file, "Later explicit correction");
  await publishMemoryFile(file, "Later explicit correction");
  expect(memory.files.get(file)!.toString("utf8")).toBe("Later explicit correction");
  expect(memory.writes).toEqual([file, file]);
  expect([...memory.files.keys()]).toEqual([file]);
});

it("marks withdrawn pages inactive in place, including partial writes", async () => {
  const retained = NodePath.join("memory", "topic-0000.md");
  const obsolete = NodePath.join("memory", "topic-0001.md");
  memory.files.set(retained, Buffer.from("Keep this"));
  memory.files.set(obsolete, Buffer.from("Old content ".repeat(100)));
  await withdrawMemoryPages("memory", "topic", 1);
  expect(memory.files.get(retained)!.toString("utf8")).toBe("Keep this");
  expect(memory.files.get(obsolete)!.toString("utf8")).toContain("비활성화된 기억");
  expect(memory.files.get(obsolete)!.toString("utf8")).not.toContain("Old content");
  const writes = memory.writes.length;
  await archiveMemoryFile(obsolete);
  await archiveMemoryFile(NodePath.join("memory", "missing.md"));
  expect(memory.writes).toHaveLength(writes);
  expect(memory.removals).toEqual([]);
  expect([...memory.files.keys()]).toEqual([retained, obsolete]);
});
