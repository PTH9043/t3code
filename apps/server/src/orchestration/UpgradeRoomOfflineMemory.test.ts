// @effect-diagnostics nodeBuiltinImport:off - The importer reads a real queue file.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { afterEach, expect, it } from "vite-plus/test";
import { WATCHDOG_OFFLINE_MEMORY_FILE } from "../mcp/WatchdogOfflineTools.ts";
import {
  importUpgradeRoomOfflineMemory,
  type UpgradeRoomOfflineMemoryRecord,
} from "./UpgradeRoomOfflineMemory.ts";

class MemoryConflict extends Data.TaggedError("MemoryConflict")<{ readonly message: string }> {}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const line = (requestId: string, text: string, folder: string | null = "") =>
  `{"version":1,"kind":"workspace_memory.remember","projectId":"project-1","threadId":"autousage-upgrade-room","providerInstanceId":"codex","requestId":"${requestId}","topic":"topic","text":"${text}","scope":"project","folder":${folder === null ? "null" : `"${folder}"`},"recordedAt":"2026-11-19T00:00:00.000Z"}`;

it("imports queued memories once, keeps rejects aside and removes the processed queue", async () => {
  const stateDir = mkdtempSync(NodePath.join(tmpdir(), "t3-room-memory-"));
  dirs.push(stateDir);
  const file = NodePath.join(stateDir, WATCHDOG_OFFLINE_MEMORY_FILE);
  // A leftover from an interrupted import is replayed before the new queue.
  writeFileSync(`${file}.importing`, `${line("r1", "first")}\n`);
  writeFileSync(
    file,
    [
      line("r1", "first"),
      line("r2", "second", null),
      "not json",
      line("r3", "boom", "docs"),
      "",
    ].join("\n"),
  );
  const remembered: UpgradeRoomOfflineMemoryRecord[] = [];
  const result = await Effect.runPromise(
    importUpgradeRoomOfflineMemory({
      stateDir,
      remember: (record) =>
        record.requestId === "r3"
          ? Effect.fail(new MemoryConflict({ message: "memory conflict" }))
          : Effect.sync(() => void remembered.push(record)),
    }),
  );

  expect(remembered.map((record) => [record.requestId, record.folder])).toEqual([
    ["r1", ""],
    ["r2", null],
  ]);
  expect(result).toEqual({ imported: 2, rejected: 2 });
  expect(existsSync(file)).toBe(false);
  expect(existsSync(`${file}.importing`)).toBe(false);
  const rejected = readFileSync(`${file}.rejected`, "utf8").trim().split("\n");
  expect(rejected).toHaveLength(2);
  expect(rejected[0]).toContain("invalid-record");
  expect(rejected[1]).toContain("memory conflict");
});
