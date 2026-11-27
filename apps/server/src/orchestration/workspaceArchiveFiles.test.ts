// @effect-diagnostics nodeBuiltinImport:off
import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import * as Zlib from "node:zlib";
import { expect, it } from "vite-plus/test";
import { memoryHash, memoryScopeDirectory } from "./memoryFiles.ts";
import { readWorkspaceArchiveFiles } from "./workspaceArchiveFiles.ts";

it("includes verified archived and imported original conversation files, and fails on corruption or escape", async () => {
  const stateDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), "t3-export-fixture-"));
  try {
    const projectId = "test-project";
    const threadId = "test-thread";
    const archiveDir = Path.join(
      memoryScopeDirectory(stateDir, projectId, "project"),
      "sources",
      memoryHash(threadId),
    );
    const importDir = Path.join(stateDir, "conversation-imports");
    await Fs.mkdir(archiveDir, { recursive: true });
    await Fs.mkdir(importDir, { recursive: true });
    const original = '{"record_type":"message","text":"보관된 한글 대화"}\n';
    const hash = Crypto.createHash("sha256").update(original).digest("hex");
    const archive = Path.join(archiveDir, "archive.ndjson.gz");
    await Fs.writeFile(archive, Zlib.gzipSync(original));
    const imported = "가져온 원본 한글";
    const importedHash = Crypto.createHash("sha256").update(imported).digest("hex");
    await Fs.writeFile(Path.join(importDir, importedHash + ".txt"), imported);
    const input = {
      stateDir,
      projectId,
      archives: [
        {
          thread_id: threadId,
          path: archive,
          sha256: hash,
          records: 1,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      imports: [
        {
          thread_id: threadId,
          payload_json: JSON.stringify({ sourceHash: importedHash, format: "codex" }),
        },
      ],
    };
    const result = await readWorkspaceArchiveFiles(input);
    expect(result.sourceArchives[0]?.content).toBe(original);
    expect(result.importedSources[0]?.content).toBe(imported);
    await expect(
      readWorkspaceArchiveFiles({
        ...input,
        archives: [{ ...input.archives[0]!, sha256: "0".repeat(64) }],
      }),
    ).rejects.toThrow("해시");
    await expect(
      readWorkspaceArchiveFiles({
        ...input,
        archives: [{ ...input.archives[0]!, path: Path.join(importDir, importedHash + ".txt") }],
      }),
    ).rejects.toThrow("범위");
    await Fs.unlink(Path.join(importDir, importedHash + ".txt"));
    await expect(readWorkspaceArchiveFiles(input)).rejects.toThrow();
  } finally {
    await Fs.rm(stateDir, { recursive: true, force: true });
  }
});
