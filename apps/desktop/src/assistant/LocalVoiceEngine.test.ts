// @effect-diagnostics nodeBuiltinImport:off - Exercise local files and a hidden Python process.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as NodeChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { voiceSampleSave } from "../ipc/methods/assistantVoice.ts";
import {
  beginVoiceSampleUpdate,
  cancelVoice,
  deleteVoiceSample,
  runVoice,
  saveVoiceSample,
  voicePaths,
  voiceStatus,
} from "./LocalVoiceEngine.ts";

const directories: string[] = [];
const temporary = async () => {
  const root = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, "t3-voice-test-"));
  directories.push(directory);
  return directory;
};
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (!path.basename(directory).startsWith("t3-voice-test-"))
      throw new Error("Unexpected temporary path");
    await fs.rm(directory, { recursive: true, force: true });
  }
});

const wav = (marker: number) => {
  const buffer = Buffer.alloc(48, marker);
  buffer.write("RIFF", 0);
  buffer.write("WAVE", 8);
  return buffer;
};

function sampleWorker(source: string) {
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let closed = false;
  const listeners = new Set<() => void>();
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    for (const listener of listeners) listener();
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = new Promise<void>((resolve) => {
    child.once("close", () => {
      closed = true;
      for (const listener of listeners) listener();
      resolve();
    });
  });
  const waitFor = (marker: string) =>
    new Promise<string>((resolve, reject) => {
      const check = () => {
        const line = stdout.split("\n").find((item) => item.startsWith(marker));
        if (line !== undefined) {
          listeners.delete(check);
          resolve(line.slice(marker.length));
        } else if (closed) {
          listeners.delete(check);
          reject(new Error(`worker exited before ${marker}: ${stderr}`));
        }
      };
      listeners.add(check);
      check();
    });
  const stop = async () => {
    if (!closed) child.kill();
    await exit;
  };
  return { child, waitFor, stop };
}

describe("local voice resources", () => {
  it("uses a T3-specific default and permits an explicit runtime override", () => {
    const paths = voicePaths("C:/app", "D:/voice", "C:/resources");
    expect(paths.python).toBe(
      process.platform === "win32"
        ? path.join("D:/voice", "venv", "Scripts", "python.exe")
        : path.join("D:/voice", "venv", "bin", "python"),
    );
    expect(paths.script).toBe(path.join("C:/resources", "assistant-voice", "engine.py"));
    expect(voicePaths("C:/app", "").whisper).toBe(
      path.join("C:/app", ".t3", "assistant-voice-runtime", "models", "whisper"),
    );
  });

  it("stores, replaces and deletes only the application-owned sample", async () => {
    const root = await temporary();
    const original = path.join(root, "user-original.wav");
    await fs.writeFile(original, wav(1));
    expect(
      (await saveVoiceSample(root, wav(2).toString("base64"), beginVoiceSampleUpdate(root))).ok,
    ).toBe(true);
    expect((await voiceStatus("unused", undefined, undefined, root)).sample).toBe(true);
    expect((await saveVoiceSample(root, "invalid", beginVoiceSampleUpdate(root))).ok).toBe(false);
    expect(await fs.readFile(path.join(root, "assistant-voice-sample.wav"))).toEqual(wav(2));
    expect(
      (await saveVoiceSample(root, wav(3).toString("base64"), beginVoiceSampleUpdate(root))).ok,
    ).toBe(true);
    expect(await fs.readFile(path.join(root, "assistant-voice-sample.wav"))).toEqual(wav(3));
    expect((await deleteVoiceSample(root)).ok).toBe(true);
    expect((await deleteVoiceSample(root)).ok).toBe(true);
    expect(await fs.readFile(original)).toEqual(wav(1));
    expect((await voiceStatus("unused", undefined, undefined, root)).sample).toBe(false);
    expect(cancelVoice()).toBe(false);
  });

  it("does not recreate a sample when an earlier save races with a later delete", async () => {
    const root = await temporary();
    const native = NodeModule.createRequire(import.meta.url)("node:fs/promises") as typeof fs;
    const original = native.rename;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(native, "rename").mockImplementation(async (...args) => {
      if (String(args[1]) === path.join(root, "assistant-voice-sample.wav")) {
        entered();
        await gate;
      }
      return await Reflect.apply(original, native, args);
    });
    NodeModule.syncBuiltinESMExports();
    try {
      const saving = saveVoiceSample(root, wav(5).toString("base64"), beginVoiceSampleUpdate(root));
      await started;
      const deleting = deleteVoiceSample(root);
      release();
      expect((await saving).ok).toBe(false);
      expect((await deleting).ok).toBe(true);
      expect((await voiceStatus("unused", undefined, undefined, root)).sample).toBe(false);
    } finally {
      release();
      spy.mockRestore();
      NodeModule.syncBuiltinESMExports();
    }
  });

  it("rejects an older window's late save after a newer selection or deletion", async () => {
    const root = await temporary();
    const firstWindow = await beginVoiceSampleUpdate(root);
    const secondWindow = await beginVoiceSampleUpdate(root);
    expect((await saveVoiceSample(root, wav(8).toString("base64"), secondWindow)).ok).toBe(true);
    expect((await saveVoiceSample(root, wav(9).toString("base64"), firstWindow)).ok).toBe(false);
    expect(await fs.readFile(path.join(root, "assistant-voice-sample.wav"))).toEqual(wav(8));
    const beforeDelete = await beginVoiceSampleUpdate(root);
    expect((await deleteVoiceSample(root)).ok).toBe(true);
    expect((await saveVoiceSample(root, wav(9).toString("base64"), beforeDelete)).ok).toBe(false);
    expect((await voiceStatus("unused", undefined, undefined, root)).sample).toBe(false);
  });

  it.each([true, false])(
    "restores the previous sample state when a new selection starts during rename (previous exists: %s)",
    async (exists) => {
      const root = await temporary();
      const sample = path.join(root, "assistant-voice-sample.wav");
      if (exists) await fs.writeFile(sample, wav(1));
      const native = NodeModule.createRequire(import.meta.url)("node:fs/promises") as typeof fs;
      const original = native.rename;
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first = true;
      const spy = vi.spyOn(native, "rename").mockImplementation(async (...args) => {
        if (first && String(args[1]) === sample) {
          first = false;
          entered();
          await gate;
        }
        return await Reflect.apply(original, native, args);
      });
      NodeModule.syncBuiltinESMExports();
      try {
        const oldSave = saveVoiceSample(
          root,
          wav(2).toString("base64"),
          beginVoiceSampleUpdate(root),
        );
        await started;
        const newerToken = beginVoiceSampleUpdate(root);
        const failedReplacement = saveVoiceSample(root, "invalid", newerToken);
        release();
        expect((await oldSave).ok).toBe(false);
        expect((await failedReplacement).ok).toBe(false);
        if (exists) expect(await fs.readFile(sample)).toEqual(wav(1));
        else await expect(fs.stat(sample)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      } finally {
        release();
        spy.mockRestore();
        NodeModule.syncBuiltinESMExports();
      }
    },
  );

  it("does not restore a sample after a delete queued during rename completes", async () => {
    const root = await temporary();
    const sample = path.join(root, "assistant-voice-sample.wav");
    await fs.writeFile(sample, wav(1));
    const native = NodeModule.createRequire(import.meta.url)("node:fs/promises") as typeof fs;
    const original = native.rename;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const spy = vi.spyOn(native, "rename").mockImplementation(async (...args) => {
      if (first && String(args[1]) === sample) {
        first = false;
        entered();
        await gate;
      }
      return await Reflect.apply(original, native, args);
    });
    NodeModule.syncBuiltinESMExports();
    try {
      const oldSave = saveVoiceSample(
        root,
        wav(2).toString("base64"),
        beginVoiceSampleUpdate(root),
      );
      await started;
      const deletion = deleteVoiceSample(root);
      release();
      expect((await oldSave).ok).toBe(false);
      expect((await deletion).ok).toBe(true);
      await expect(fs.stat(sample)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release();
      spy.mockRestore();
      NodeModule.syncBuiltinESMExports();
    }
  });

  it("preserves the journal and backup when restoring an invalidated publish fails", async () => {
    const root = await temporary();
    const sample = path.join(root, "assistant-voice-sample.wav");
    const backup = path.join(root, ".assistant-voice-sample-backup.wav");
    const journal = path.join(root, ".assistant-voice-sample-transaction.json");
    await fs.writeFile(sample, wav(1));
    const native = NodeModule.createRequire(import.meta.url)("node:fs/promises") as typeof fs;
    const original = native.rename;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(native, "rename").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith(".assistant-voice-sample-restore.tmp"))
        throw new Error("injected restore failure");
      if (String(args[1]) === sample) {
        entered();
        await gate;
      }
      return await Reflect.apply(original, native, args);
    });
    NodeModule.syncBuiltinESMExports();
    try {
      const oldSave = saveVoiceSample(
        root,
        wav(2).toString("base64"),
        beginVoiceSampleUpdate(root),
      );
      await started;
      const newer = beginVoiceSampleUpdate(root);
      release();
      expect(await oldSave).toMatchObject({
        ok: false,
        error: expect.stringContaining("복원하지 못했습니다"),
      });
      await newer;
      expect(await fs.readFile(backup)).toEqual(wav(1));
      expect(JSON.parse(await fs.readFile(journal, "utf8"))).toMatchObject({
        version: 3,
        phase: "owned",
        previous: "present",
        candidate: expect.stringMatching(/^\.assistant-voice-sample-.*\.tmp$/),
      });
      await expect(voiceStatus("unused", undefined, undefined, root)).rejects.toThrow(
        "injected restore failure",
      );
      expect(await fs.readFile(backup)).toEqual(wav(1));
    } finally {
      release();
      spy.mockRestore();
      NodeModule.syncBuiltinESMExports();
    }
    expect((await voiceStatus("unused", undefined, undefined, root)).sample).toBe(true);
    expect(await fs.readFile(sample)).toEqual(wav(1));
    await expect(fs.stat(backup)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(journal)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([true, false])(
    "recovers the previous sample after the publishing process is killed (previous exists: %s)",
    async (exists) => {
      const root = await temporary();
      const sample = path.join(root, "assistant-voice-sample.wav");
      if (exists) await fs.writeFile(sample, wav(1));
      const moduleUrl = new URL("./LocalVoiceEngine.ts", import.meta.url).href;
      const source = `
      import { createRequire, syncBuiltinESMExports } from "node:module";
      const native = createRequire(import.meta.url)("node:fs/promises");
      const original = native.rename;
      native.rename = async (...args) => {
        await original(...args);
        if (String(args[1]) === ${JSON.stringify(sample)} && String(args[0]).includes(".assistant-voice-sample-")) {
          console.log("PUBLISHED");
          await new Promise(() => {});
        }
      };
      syncBuiltinESMExports();
      const m = await import(${JSON.stringify(moduleUrl)});
      await m.saveVoiceSample(${JSON.stringify(root)}, ${JSON.stringify(wav(2).toString("base64"))}, m.beginVoiceSampleUpdate(${JSON.stringify(root)}));
    `;
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", source],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout.on("data", (chunk) => {
            if (chunk.toString().includes("PUBLISHED")) resolve();
          });
          child.once("error", reject);
          child.once("close", () => reject(new Error(`child exited before publish: ${stderr}`)));
        });
        expect(await fs.readFile(sample)).toEqual(wav(2));
        child.kill();
        await closed;
        expect((await voiceStatus("unused", undefined, undefined, root)).sample).toBe(exists);
        if (exists) expect(await fs.readFile(sample)).toEqual(wav(1));
        else await expect(fs.stat(sample)).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          (await fs.readdir(root)).filter((name) => name.startsWith(".assistant-voice-sample-")),
        ).toEqual([]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await closed;
        }
      }
    },
    20_000,
  );

  it("removes only the journaled candidate after a child is killed before publication", async () => {
    const root = await temporary();
    const sample = path.join(root, "assistant-voice-sample.wav");
    const unrelated = path.join(
      root,
      ".assistant-voice-sample-12345678-1234-4234-8234-123456789abc.tmp",
    );
    await fs.writeFile(sample, wav(1));
    await fs.mkdir(unrelated);
    await fs.writeFile(path.join(unrelated, "candidate.wav"), wav(9));
    const moduleUrl = new URL("./LocalVoiceEngine.ts", import.meta.url).href;
    const source = `
      import { createRequire, syncBuiltinESMExports } from "node:module";
      const native = createRequire(import.meta.url)("node:fs/promises");
      const original = native.open;
      native.open = async (...args) => {
        const handle = await original(...args);
        if (/\\.assistant-voice-sample-[0-9a-f-]{36}\\.tmp$/.test(String(args[0]))) {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async (...values) => {
            await write(...values);
            console.log("CANDIDATE"); setInterval(() => {}, 1000);
            await new Promise(() => {});
          };
        }
        return handle;
      };
      syncBuiltinESMExports();
      const m = await import(${JSON.stringify(moduleUrl)});
      await m.saveVoiceSample(${JSON.stringify(root)}, ${JSON.stringify(wav(2).toString("base64"))}, m.beginVoiceSampleUpdate(${JSON.stringify(root)}));
    `;
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", source],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
          if (chunk.toString().includes("CANDIDATE")) resolve();
        });
        child.once("error", reject);
        child.once("close", () => reject(new Error(`child exited before candidate: ${stderr}`)));
      });
      const journal = JSON.parse(
        await fs.readFile(path.join(root, ".assistant-voice-sample-transaction.json"), "utf8"),
      ) as { version: number; phase: string; candidate: string };
      expect(journal.version).toBe(3);
      expect(journal.phase).toBe("owned");
      expect(journal.candidate).toMatch(/^\.assistant-voice-sample-[0-9a-f-]+\.tmp$/);
      const candidate = path.join(root, journal.candidate);
      expect(await fs.readFile(candidate)).toEqual(wav(2));
      child.kill();
      await closed;
      expect((await voiceStatus("unused", undefined, undefined, root)).sample).toBe(true);
      expect(await fs.readFile(sample)).toEqual(wav(1));
      await expect(fs.stat(candidate)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await deleteVoiceSample(root)).ok).toBe(true);
      expect(await fs.readFile(path.join(unrelated, "candidate.wav"))).toEqual(wav(9));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await closed;
      }
    }
  }, 20_000);

  it("never deletes an unowned pending name after a child dies before ownership is recorded", async () => {
    const root = await temporary();
    const sample = path.join(root, "assistant-voice-sample.wav");
    await fs.writeFile(sample, wav(1));
    const moduleUrl = new URL("./LocalVoiceEngine.ts", import.meta.url).href;
    const source = `
      import { createRequire, syncBuiltinESMExports } from "node:module";
      const native = createRequire(import.meta.url)("node:fs/promises");
      const original = native.open;
      native.open = async (...args) => {
        const handle = await original(...args);
        if (/\\.assistant-voice-sample-[0-9a-f-]{36}\\.tmp$/.test(String(args[0]))) {
          console.log("CREATED"); setInterval(() => {}, 1000);
          await new Promise(() => {});
        }
        return handle;
      };
      syncBuiltinESMExports();
      const m = await import(${JSON.stringify(moduleUrl)});
      await m.saveVoiceSample(${JSON.stringify(root)}, ${JSON.stringify(wav(2).toString("base64"))}, m.beginVoiceSampleUpdate(${JSON.stringify(root)}));
    `;
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", source],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
          if (chunk.toString().includes("CREATED")) resolve();
        });
        child.once("error", reject);
        child.once("close", () => reject(new Error(`child exited before ownership: ${stderr}`)));
      });
      const journal = JSON.parse(
        await fs.readFile(path.join(root, ".assistant-voice-sample-transaction.json"), "utf8"),
      ) as { phase: string; candidate: string };
      expect(journal.phase).toBe("pending");
      const candidate = path.join(root, journal.candidate);
      expect((await fs.stat(candidate)).size).toBe(0);
      child.kill();
      await closed;
      expect((await voiceStatus("unused", undefined, undefined, root)).sample).toBe(true);
      expect(await fs.readFile(sample)).toEqual(wav(1));
      expect((await fs.stat(candidate)).size).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await closed;
      }
    }
  }, 20_000);

  it("keeps the committed sample after a child is killed between journal and backup removal", async () => {
    const root = await temporary();
    const sample = path.join(root, "assistant-voice-sample.wav");
    const backup = path.join(root, ".assistant-voice-sample-backup.wav");
    const journal = path.join(root, ".assistant-voice-sample-transaction.json");
    await fs.writeFile(sample, wav(1));
    const moduleUrl = new URL("./LocalVoiceEngine.ts", import.meta.url).href;
    const source = `
      import { createRequire, syncBuiltinESMExports } from "node:module";
      const native = createRequire(import.meta.url)("node:fs");
      const original = native.unlinkSync;
      native.unlinkSync = (...args) => {
        original(...args);
        if (String(args[0]) === ${JSON.stringify(journal)}) {
          native.writeSync(1, "COMMITTED\\n");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
        }
      };
      syncBuiltinESMExports();
      const m = await import(${JSON.stringify(moduleUrl)});
      await m.saveVoiceSample(${JSON.stringify(root)}, ${JSON.stringify(wav(2).toString("base64"))}, m.beginVoiceSampleUpdate(${JSON.stringify(root)}));
    `;
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", source],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
          if (chunk.toString().includes("COMMITTED")) resolve();
        });
        child.once("error", reject);
        child.once("close", () => reject(new Error(`child exited before commit: ${stderr}`)));
      });
      expect(await fs.readFile(sample)).toEqual(wav(2));
      expect(await fs.readFile(backup)).toEqual(wav(1));
      child.kill();
      await closed;
      expect((await voiceStatus("unused", undefined, undefined, root)).sample).toBe(true);
      expect(await fs.readFile(sample)).toEqual(wav(2));
      await expect(fs.stat(backup)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await closed;
      }
    }
  }, 20_000);

  it.each(["status", "save", "delete", "clone"] as const)(
    "recovers before %s",
    async (operation) => {
      const root = await temporary();
      const sample = path.join(root, "assistant-voice-sample.wav");
      await fs.writeFile(sample, wav(2));
      await fs.writeFile(path.join(root, ".assistant-voice-sample-backup.wav"), wav(1));
      await fs.writeFile(
        path.join(root, ".assistant-voice-sample-transaction.json"),
        JSON.stringify({ version: 1, previous: "present" }),
      );
      if (operation === "status") await voiceStatus("unused", undefined, undefined, root);
      if (operation === "save")
        expect((await saveVoiceSample(root, "invalid", beginVoiceSampleUpdate(root))).ok).toBe(
          false,
        );
      if (operation === "delete") expect((await deleteVoiceSample(root)).ok).toBe(true);
      if (operation === "clone")
        expect(
          (await runVoice("unused", { task: "clone", text: "시험" }, undefined, undefined, root))
            .ok,
        ).toBe(false);
      if (operation === "delete")
        await expect(fs.stat(sample)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await fs.readFile(sample)).toEqual(wav(1));
      expect(
        (await fs.readdir(root)).filter((name) => name.startsWith(".assistant-voice-sample-")),
      ).toEqual([]);
    },
  );

  it("does not report delete success when a journal exists but its backup is missing", async () => {
    const root = await temporary();
    const sample = path.join(root, "assistant-voice-sample.wav");
    const journal = path.join(root, ".assistant-voice-sample-transaction.json");
    await fs.writeFile(sample, wav(2));
    await fs.writeFile(journal, JSON.stringify({ version: 1, previous: "present" }));
    expect(await deleteVoiceSample(root)).toMatchObject({
      ok: false,
      error: expect.stringContaining("복구"),
    });
    expect(await fs.readFile(sample)).toEqual(wav(2));
    expect(await fs.readFile(journal, "utf8")).toContain("present");
  });

  it("reports a committed save with a warning if deleting the old backup fails", async () => {
    const root = await temporary();
    const sample = path.join(root, "assistant-voice-sample.wav");
    const backup = path.join(root, ".assistant-voice-sample-backup.wav");
    const journal = path.join(root, ".assistant-voice-sample-transaction.json");
    await fs.writeFile(sample, wav(1));
    const native = NodeModule.createRequire(import.meta.url)("node:fs") as typeof fsSync;
    const original = native.unlinkSync;
    const spy = vi.spyOn(native, "unlinkSync").mockImplementation((...args) => {
      if (String(args[0]) === backup && fsSync.existsSync(backup) && !fsSync.existsSync(journal))
        throw new Error("injected backup removal failure");
      Reflect.apply(original, native, args);
    });
    NodeModule.syncBuiltinESMExports();
    try {
      const token = await beginVoiceSampleUpdate(root);
      const result = await Effect.runPromise(
        voiceSampleSave
          .handler({ audio: wav(2).toString("base64"), token })
          .pipe(
            Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
              stateDir: root,
            } as never),
          ),
      );
      expect(result).toMatchObject({ ok: true, warning: expect.stringContaining("임시 백업") });
      expect(await fs.readFile(sample)).toEqual(wav(2));
      expect(await fs.readFile(backup)).toEqual(wav(1));
      await expect(fs.stat(journal)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      spy.mockRestore();
      NodeModule.syncBuiltinESMExports();
    }
    expect((await voiceStatus("unused", undefined, undefined, root)).sample).toBe(true);
    expect(await fs.readFile(sample)).toEqual(wav(2));
    await expect(fs.stat(backup)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an invalid journal candidate without touching unrelated files or the backup", async () => {
    const root = await temporary();
    const sample = path.join(root, "assistant-voice-sample.wav");
    const backup = path.join(root, ".assistant-voice-sample-backup.wav");
    const unrelated = path.join(root, "unrelated.wav");
    await fs.writeFile(sample, wav(2));
    await fs.writeFile(backup, wav(1));
    await fs.writeFile(unrelated, wav(9));
    await fs.writeFile(
      path.join(root, ".assistant-voice-sample-transaction.json"),
      JSON.stringify({ version: 2, previous: "present", candidate: "../unrelated.wav" }),
    );
    await expect(voiceStatus("unused", undefined, undefined, root)).rejects.toThrow("복구 기록");
    expect(await fs.readFile(unrelated)).toEqual(wav(9));
    expect(await fs.readFile(backup)).toEqual(wav(1));
    expect(await fs.readFile(sample)).toEqual(wav(2));
  });

  it("does not follow a substituted candidate directory link", async () => {
    const root = await temporary();
    const candidate = ".assistant-voice-sample-12345678-1234-4234-8234-123456789abc.tmp";
    const target = path.join(root, "unrelated-user-data");
    const backup = path.join(root, ".assistant-voice-sample-backup.wav");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "candidate.wav"), wav(9));
    await fs.writeFile(backup, wav(1));
    await fs.symlink(
      target,
      path.join(root, candidate),
      process.platform === "win32" ? "junction" : "dir",
    );
    await fs.writeFile(
      path.join(root, ".assistant-voice-sample-transaction.json"),
      JSON.stringify({ version: 2, previous: "present", candidate }),
    );
    await expect(voiceStatus("unused", undefined, undefined, root)).rejects.toThrow("복구 폴더");
    expect(await fs.readFile(path.join(target, "candidate.wav"))).toEqual(wav(9));
    expect(await fs.readFile(backup)).toEqual(wav(1));
  });

  it("preserves an existing file when exclusive candidate creation collides", async () => {
    const root = await temporary();
    const sample = path.join(root, "assistant-voice-sample.wav");
    await fs.writeFile(sample, wav(1));
    const native = NodeModule.createRequire(import.meta.url)("node:fs/promises") as typeof fs;
    const original = native.open;
    let collision = "";
    const spy = vi.spyOn(native, "open").mockImplementation(async (...args) => {
      const name = String(args[0]);
      if (/\.assistant-voice-sample-[0-9a-f-]{36}\.tmp$/.test(name)) {
        collision = name;
        await fs.writeFile(name, wav(9), { flag: "wx" });
      }
      return await Reflect.apply(original, native, args);
    });
    NodeModule.syncBuiltinESMExports();
    try {
      expect(
        (await saveVoiceSample(root, wav(2).toString("base64"), beginVoiceSampleUpdate(root))).ok,
      ).toBe(false);
      expect(collision).not.toBe("");
      expect(await fs.readFile(collision)).toEqual(wav(9));
      expect(await fs.readFile(sample)).toEqual(wav(1));
      await voiceStatus("unused", undefined, undefined, root);
      expect(await fs.readFile(collision)).toEqual(wav(9));
    } finally {
      spy.mockRestore();
      NodeModule.syncBuiltinESMExports();
    }
  });

  it("never follows a junction swapped in after candidate lstat", async () => {
    const root = await temporary();
    const name = ".assistant-voice-sample-12345678-1234-4234-8234-123456789abc.tmp";
    const candidate = path.join(root, name);
    const target = path.join(root, "unrelated-user-data");
    const backup = path.join(root, ".assistant-voice-sample-backup.wav");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "candidate.wav"), wav(9));
    await fs.writeFile(candidate, wav(2));
    const identity = await fs.lstat(candidate, { bigint: true });
    await fs.writeFile(backup, wav(1));
    await fs.writeFile(
      path.join(root, ".assistant-voice-sample-transaction.json"),
      JSON.stringify({
        version: 3,
        previous: "present",
        candidate: name,
        phase: "owned",
        dev: String(identity.dev),
        ino: String(identity.ino),
      }),
    );
    const native = NodeModule.createRequire(import.meta.url)("node:fs") as typeof fsSync;
    const original = native.lstatSync;
    let swapped = false;
    const spy = vi.spyOn(native, "lstatSync").mockImplementation(((...args: unknown[]) => {
      const info = Reflect.apply(original, native, args);
      if (String(args[0]) === candidate && !swapped) {
        swapped = true;
        native.renameSync(candidate, path.join(root, "owned-moved-aside"));
        native.symlinkSync(target, candidate, process.platform === "win32" ? "junction" : "dir");
      }
      return info;
    }) as typeof native.lstatSync);
    NodeModule.syncBuiltinESMExports();
    try {
      await voiceStatus("unused", undefined, undefined, root).catch(() => undefined);
      expect(swapped).toBe(true);
      expect(await fs.readFile(path.join(target, "candidate.wav"))).toEqual(wav(9));
      expect(await fs.readFile(path.join(root, "assistant-voice-sample.wav"))).toEqual(wav(1));
    } finally {
      spy.mockRestore();
      NodeModule.syncBuiltinESMExports();
    }
  });

  it.each(["selection", "deletion"] as const)(
    "rejects an older publish when %s starts before commit",
    async (action) => {
      const root = await temporary();
      const sample = path.join(root, "assistant-voice-sample.wav");
      await fs.writeFile(sample, wav(1));
      const native = NodeModule.createRequire(import.meta.url)("node:fs/promises") as typeof fs;
      const original = native.rename;
      let newerToken: string | Promise<string> = "";
      let deletion: Promise<{ ok: boolean }> | undefined;
      const spy = vi.spyOn(native, "rename").mockImplementation(async (...args) => {
        await Reflect.apply(original, native, args);
        if (
          String(args[1]) === sample &&
          /\.assistant-voice-sample-[0-9a-f-]{36}\.tmp$/.test(String(args[0]))
        ) {
          if (action === "selection") newerToken = beginVoiceSampleUpdate(root);
          else deletion = deleteVoiceSample(root);
        }
      });
      NodeModule.syncBuiltinESMExports();
      try {
        expect(
          (await saveVoiceSample(root, wav(2).toString("base64"), beginVoiceSampleUpdate(root))).ok,
        ).toBe(false);
        if (action === "selection") {
          expect((await saveVoiceSample(root, "invalid", newerToken)).ok).toBe(false);
          expect(await fs.readFile(sample)).toEqual(wav(1));
        } else {
          expect(await deletion).toMatchObject({ ok: true });
          await expect(fs.stat(sample)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        spy.mockRestore();
        NodeModule.syncBuiltinESMExports();
      }
    },
  );

  it("treats a selection starting immediately after synchronous journal removal as later than the committed save", async () => {
    const root = await temporary();
    const sample = path.join(root, "assistant-voice-sample.wav");
    const journal = path.join(root, ".assistant-voice-sample-transaction.json");
    await fs.writeFile(sample, wav(1));
    const native = NodeModule.createRequire(import.meta.url)("node:fs") as typeof fsSync;
    const original = native.unlinkSync;
    let newerToken: string | Promise<string> = "";
    const spy = vi.spyOn(native, "unlinkSync").mockImplementation((...args) => {
      Reflect.apply(original, native, args);
      if (String(args[0]) === journal) newerToken = beginVoiceSampleUpdate(root);
    });
    NodeModule.syncBuiltinESMExports();
    try {
      expect(
        (await saveVoiceSample(root, wav(2).toString("base64"), beginVoiceSampleUpdate(root))).ok,
      ).toBe(true);
      expect(newerToken).not.toBe("");
      expect((await saveVoiceSample(root, "invalid", newerToken)).ok).toBe(false);
      expect(await fs.readFile(sample)).toEqual(wav(2));
    } finally {
      spy.mockRestore();
      NodeModule.syncBuiltinESMExports();
    }
  });

  it.each(["finish", "crash"] as const)(
    "serializes another process and keeps its event loop responsive when the writer will %s",
    async (ending) => {
      const root = await temporary();
      const sample = path.join(root, "assistant-voice-sample.wav");
      await fs.writeFile(sample, wav(1));
      const moduleUrl = new URL("./LocalVoiceEngine.ts", import.meta.url).href;
      const writer = sampleWorker(`
      import { createRequire, syncBuiltinESMExports } from "node:module";
      const native = createRequire(import.meta.url)("node:fs/promises");
      const original = native.rename;
      native.rename = async (...args) => {
        await original(...args);
        if (String(args[1]) === ${JSON.stringify(sample)} && /\\.assistant-voice-sample-[0-9a-f-]{36}\\.tmp$/.test(String(args[0]))) {
          console.log("PUBLISHED");
          await new Promise(resolve => { process.stdin.once("data", resolve); process.stdin.resume(); });
        }
      };
      syncBuiltinESMExports();
      const m = await import(${JSON.stringify(moduleUrl)});
      const token = await m.beginVoiceSampleUpdate(${JSON.stringify(root)});
      const result = await m.saveVoiceSample(${JSON.stringify(root)}, ${JSON.stringify(wav(2).toString("base64"))}, token);
      console.log("RESULT " + JSON.stringify(result));
    `);
      let follower: ReturnType<typeof sampleWorker> | undefined;
      try {
        await writer.waitFor("PUBLISHED");
        follower = sampleWorker(`
        const m = await import(${JSON.stringify(moduleUrl)});
        const pending = m.beginVoiceSampleUpdate(${JSON.stringify(root)});
        await new Promise(resolve => setImmediate(resolve));
        console.log("RESPONSIVE");
        const token = await pending;
        const result = await m.saveVoiceSample(${JSON.stringify(root)}, ${JSON.stringify(wav(3).toString("base64"))}, token);
        console.log("RESULT " + JSON.stringify(result));
      `);
        await follower.waitFor("RESPONSIVE");
        if (ending === "crash") await writer.stop();
        else {
          writer.child.stdin.write("continue\n");
          expect(JSON.parse(await writer.waitFor("RESULT "))).toMatchObject({ ok: false });
        }
        expect(JSON.parse(await follower.waitFor("RESULT "))).toMatchObject({ ok: true });
        expect(await fs.readFile(sample)).toEqual(wav(3));
      } finally {
        await writer.stop();
        if (follower) await follower.stop();
      }
    },
    20_000,
  );

  it("does not let another process recover an in-flight publish before it reports success", async () => {
    const root = await temporary();
    const sample = path.join(root, "assistant-voice-sample.wav");
    await fs.writeFile(sample, wav(1));
    const moduleUrl = new URL("./LocalVoiceEngine.ts", import.meta.url).href;
    const writer = sampleWorker(`
      import { createRequire, syncBuiltinESMExports } from "node:module";
      const native = createRequire(import.meta.url)("node:fs/promises");
      const original = native.rename;
      native.rename = async (...args) => {
        await original(...args);
        if (String(args[1]) === ${JSON.stringify(sample)} && /\\.assistant-voice-sample-[0-9a-f-]{36}\\.tmp$/.test(String(args[0]))) {
          console.log("PUBLISHED");
          await new Promise(resolve => { process.stdin.once("data", resolve); process.stdin.resume(); });
        }
      };
      syncBuiltinESMExports();
      const m = await import(${JSON.stringify(moduleUrl)});
      const token = await m.beginVoiceSampleUpdate(${JSON.stringify(root)});
      console.log("RESULT " + JSON.stringify(await m.saveVoiceSample(${JSON.stringify(root)}, ${JSON.stringify(wav(2).toString("base64"))}, token)));
    `);
    let observer: ReturnType<typeof sampleWorker> | undefined;
    try {
      await writer.waitFor("PUBLISHED");
      observer = sampleWorker(`
        const m = await import(${JSON.stringify(moduleUrl)});
        const pending = m.voiceStatus("unused", undefined, undefined, ${JSON.stringify(root)});
        await new Promise(resolve => setImmediate(resolve));
        console.log("RESPONSIVE");
        console.log("RESULT " + JSON.stringify(await pending));
      `);
      await observer.waitFor("RESPONSIVE");
      writer.child.stdin.write("continue\n");
      expect(JSON.parse(await writer.waitFor("RESULT "))).toMatchObject({ ok: true });
      expect(JSON.parse(await observer.waitFor("RESULT "))).toMatchObject({ sample: true });
      expect(await fs.readFile(sample)).toEqual(wav(2));
    } finally {
      await writer.stop();
      if (observer) await observer.stop();
    }
  }, 20_000);

  it("cancels an earlier process's pending selection when a later delete starts", async () => {
    const root = await temporary();
    const sample = path.join(root, "assistant-voice-sample.wav");
    await fs.writeFile(sample, wav(1));
    const moduleUrl = new URL("./LocalVoiceEngine.ts", import.meta.url).href;
    const writer = sampleWorker(`
      import { createRequire, syncBuiltinESMExports } from "node:module";
      const native = createRequire(import.meta.url)("node:fs/promises");
      const original = native.rename;
      native.rename = async (...args) => {
        await original(...args);
        if (String(args[1]) === ${JSON.stringify(sample)} && /\\.assistant-voice-sample-[0-9a-f-]{36}\\.tmp$/.test(String(args[0]))) {
          console.log("PUBLISHED");
          await new Promise(resolve => { process.stdin.once("data", resolve); process.stdin.resume(); });
        }
      };
      syncBuiltinESMExports();
      const m = await import(${JSON.stringify(moduleUrl)});
      const token = await m.beginVoiceSampleUpdate(${JSON.stringify(root)});
      console.log("RESULT " + JSON.stringify(await m.saveVoiceSample(${JSON.stringify(root)}, ${JSON.stringify(wav(2).toString("base64"))}, token)));
    `);
    let selecting: ReturnType<typeof sampleWorker> | undefined;
    let deleting: ReturnType<typeof sampleWorker> | undefined;
    try {
      await writer.waitFor("PUBLISHED");
      selecting = sampleWorker(`
        const m = await import(${JSON.stringify(moduleUrl)});
        const pending = m.beginVoiceSampleUpdate(${JSON.stringify(root)});
        await new Promise(resolve => setImmediate(resolve)); console.log("STARTED");
        try { await pending; console.log('RESULT {"ok":true}'); }
        catch { console.log('RESULT {"ok":false}'); }
      `);
      await selecting.waitFor("STARTED");
      deleting = sampleWorker(`
        const m = await import(${JSON.stringify(moduleUrl)});
        const pending = m.deleteVoiceSample(${JSON.stringify(root)});
        await new Promise(resolve => setImmediate(resolve)); console.log("STARTED");
        console.log("RESULT " + JSON.stringify(await pending));
      `);
      await deleting.waitFor("STARTED");
      writer.child.stdin.write("continue\n");
      expect(JSON.parse(await writer.waitFor("RESULT "))).toMatchObject({ ok: false });
      expect(JSON.parse(await selecting.waitFor("RESULT "))).toMatchObject({ ok: false });
      expect(JSON.parse(await deleting.waitFor("RESULT "))).toMatchObject({ ok: true });
      await expect(fs.stat(sample)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await writer.stop();
      if (selecting) await selecting.stop();
      if (deleting) await deleting.stop();
    }
  }, 20_000);

  it("rejects a delayed save from another process after deletion has completed", async () => {
    const root = await temporary();
    const sample = path.join(root, "assistant-voice-sample.wav");
    await fs.writeFile(sample, wav(1));
    const moduleUrl = new URL("./LocalVoiceEngine.ts", import.meta.url).href;
    const waiting = sampleWorker(`
      const m = await import(${JSON.stringify(moduleUrl)});
      const token = await m.beginVoiceSampleUpdate(${JSON.stringify(root)});
      console.log("READY");
      await new Promise(resolve => { process.stdin.once("data", resolve); process.stdin.resume(); });
      const result = await m.saveVoiceSample(${JSON.stringify(root)}, ${JSON.stringify(wav(2).toString("base64"))}, token);
      console.log("RESULT " + JSON.stringify(result));
    `);
    let deleting: ReturnType<typeof sampleWorker> | undefined;
    try {
      await waiting.waitFor("READY");
      deleting = sampleWorker(`
        const m = await import(${JSON.stringify(moduleUrl)});
        console.log("RESULT " + JSON.stringify(await m.deleteVoiceSample(${JSON.stringify(root)})));
      `);
      expect(JSON.parse(await deleting.waitFor("RESULT "))).toMatchObject({ ok: true });
      waiting.child.stdin.write("continue\n");
      expect(JSON.parse(await waiting.waitFor("RESULT "))).toMatchObject({ ok: false });
      await expect(fs.stat(sample)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await waiting.stop();
      if (deleting) await deleting.stop();
    }
  }, 20_000);

  it("cancels a waiting delete when another process commits a newer selection", async () => {
    const root = await temporary();
    const sample = path.join(root, "assistant-voice-sample.wav");
    await fs.writeFile(sample, wav(1));
    await beginVoiceSampleUpdate(root);
    const moduleUrl = new URL("./LocalVoiceEngine.ts", import.meta.url).href;
    const deleting = sampleWorker(`
      const { DatabaseSync } = await import("node:sqlite");
      const execute = DatabaseSync.prototype.exec;
      let allowed = false, announced = false;
      process.stdin.once("data", () => { allowed = true; }); process.stdin.resume();
      DatabaseSync.prototype.exec = function(sql) {
        if (sql === "BEGIN IMMEDIATE" && !allowed) {
          if (!announced) { announced = true; console.log("WAITING"); }
          const error = new Error("database is locked"); error.errcode = 5; throw error;
        }
        return execute.call(this, sql);
      };
      const m = await import(${JSON.stringify(moduleUrl)});
      console.log("RESULT " + JSON.stringify(await m.deleteVoiceSample(${JSON.stringify(root)})));
    `);
    let newer: ReturnType<typeof sampleWorker> | undefined;
    try {
      await deleting.waitFor("WAITING");
      newer = sampleWorker(`
        const m = await import(${JSON.stringify(moduleUrl)});
        const token = await m.beginVoiceSampleUpdate(${JSON.stringify(root)});
        console.log("RESULT " + JSON.stringify(await m.saveVoiceSample(${JSON.stringify(root)}, ${JSON.stringify(wav(2).toString("base64"))}, token)));
      `);
      expect(JSON.parse(await newer.waitFor("RESULT "))).toMatchObject({ ok: true });
      deleting.child.stdin.write("continue\n");
      expect(JSON.parse(await deleting.waitFor("RESULT "))).toMatchObject({ ok: false });
      expect(await fs.readFile(sample)).toEqual(wav(2));
    } finally {
      await deleting.stop();
      if (newer) await newer.stop();
    }
  }, 20_000);

  it.skipIf(process.platform !== "win32").each(["clone", "transcribe"] as const)(
    "cancels %s's tracked process tree and does not retry on CPU",
    async (task) => {
      const root = await temporary();
      const runtime = path.join(root, "runtime");
      const state = path.join(root, "state");
      const app = path.join(root, "app");
      await fs.mkdir(path.join(runtime, "venv", "Scripts"), { recursive: true });
      await fs.mkdir(path.join(runtime, "models", task === "clone" ? "qwen" : "whisper"), {
        recursive: true,
      });
      await fs.mkdir(path.join(app, "apps", "desktop", "resources", "assistant-voice"), {
        recursive: true,
      });
      await fs.writeFile(path.join(runtime, "venv", "Scripts", "python.exe"), "");
      await fs.writeFile(
        path.join(app, "apps", "desktop", "resources", "assistant-voice", "engine.py"),
        "",
      );
      expect(
        (await saveVoiceSample(state, wav(7).toString("base64"), beginVoiceSampleUpdate(state))).ok,
      ).toBe(true);
      const native = NodeModule.createRequire(import.meta.url)(
        "node:child_process",
      ) as typeof NodeChildProcess;
      const child = Object.assign(new EventEmitter(), {
        pid: 321987654,
        exitCode: null,
        signalCode: null,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      let started!: () => void;
      const spawning = new Promise<void>((resolve) => {
        started = resolve;
      });
      const spawnSpy = vi.spyOn(native, "spawn").mockImplementation(() => {
        started();
        return child as unknown as NodeChildProcess.ChildProcess;
      });
      const killSpy = vi.spyOn(native, "execFile").mockImplementation(((
        _file: unknown,
        _args: unknown,
        _options: unknown,
        callback: (error: null) => void,
      ) => {
        queueMicrotask(() => {
          callback(null);
          child.emit("close", 1);
        });
        return new EventEmitter();
      }) as typeof native.execFile);
      NodeModule.syncBuiltinESMExports();
      const previous = process.env.T3_ASSISTANT_VOICE_HOME;
      process.env.T3_ASSISTANT_VOICE_HOME = runtime;
      try {
        expect(NodeChildProcess.execFile).toBe(native.execFile);
        const result = runVoice(
          app,
          task === "clone" ? { task, text: "시험" } : { task, audio: wav(1).toString("base64") },
          undefined,
          undefined,
          state,
        );
        await spawning;
        expect((await runVoice(app, { task: "transcribe", audio: "AAAA" })).ok).toBe(false);
        expect(cancelVoice()).toBe(true);
        expect((await result).error).toContain("취소");
        expect(spawnSpy).toHaveBeenCalledTimes(1);
        expect(killSpy).toHaveBeenCalledWith(
          expect.stringContaining("taskkill.exe"),
          ["/PID", "321987654", "/T", "/F"],
          { windowsHide: true },
          expect.any(Function),
        );
        expect(cancelVoice()).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.T3_ASSISTANT_VOICE_HOME;
        else process.env.T3_ASSISTANT_VOICE_HOME = previous;
        spawnSpy.mockRestore();
        killSpy.mockRestore();
        NodeModule.syncBuiltinESMExports();
      }
    },
  );

  it("retries a failed GPU voice process on CPU with the same voice model and text", async () => {
    const root = await temporary();
    const runtime = path.join(root, "runtime");
    const state = path.join(root, "state");
    const app = path.join(root, "app");
    await fs.mkdir(path.join(runtime, "venv", "Scripts"), { recursive: true });
    await fs.mkdir(path.join(runtime, "models", "qwen"), { recursive: true });
    await fs.mkdir(path.join(app, "apps", "desktop", "resources", "assistant-voice"), {
      recursive: true,
    });
    await fs.writeFile(path.join(runtime, "venv", "Scripts", "python.exe"), "");
    await fs.writeFile(
      path.join(app, "apps", "desktop", "resources", "assistant-voice", "engine.py"),
      "",
    );
    expect(
      (await saveVoiceSample(state, wav(7).toString("base64"), beginVoiceSampleUpdate(state))).ok,
    ).toBe(true);
    const native = NodeModule.createRequire(import.meta.url)(
      "node:child_process",
    ) as typeof NodeChildProcess;
    const inputs: Array<{ device: string; model: string; text: string }> = [];
    const spawnSpy = vi.spyOn(native, "spawn").mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        pid: 321987654,
        exitCode: null,
        signalCode: null,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      let input = "";
      child.stdin.on("data", (chunk) => {
        input += chunk.toString();
      });
      child.stdin.on("finish", () => {
        const request = JSON.parse(input) as { device: string; model: string; text: string };
        inputs.push(request);
        child.stdout.write(
          JSON.stringify(
            request.device === "cuda:0"
              ? { ok: false, error: "GPU failed" }
              : { ok: true, audio: "wav" },
          ),
        );
        child.emit("close", 0);
      });
      return child as unknown as NodeChildProcess.ChildProcess;
    });
    NodeModule.syncBuiltinESMExports();
    const previous = process.env.T3_ASSISTANT_VOICE_HOME;
    process.env.T3_ASSISTANT_VOICE_HOME = runtime;
    try {
      const result = await runVoice(
        app,
        { task: "clone", text: "같은 답변" },
        undefined,
        undefined,
        state,
      );
      expect(result).toMatchObject({ ok: true, audio: "wav", device: "cpu" });
      expect(inputs.map((input) => input.device)).toEqual(["cuda:0", "cpu"]);
      expect(inputs.map((input) => input.text)).toEqual(["같은 답변", "같은 답변"]);
      expect(inputs[0]?.model).toBe(inputs[1]?.model);
      expect(spawnSpy.mock.calls.every((call) => call[2]?.windowsHide === true)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.T3_ASSISTANT_VOICE_HOME;
      else process.env.T3_ASSISTANT_VOICE_HOME = previous;
      spawnSpy.mockRestore();
      NodeModule.syncBuiltinESMExports();
    }
  });

  it.each(["gpu success", "gpu error", "gpu process failure"] as const)(
    "transcribes with %s without changing the input or model",
    async (scenario) => {
      const root = await temporary();
      const runtime = path.join(root, "runtime");
      const app = path.join(root, "app");
      const pythonPath = voicePaths(app, runtime).python;
      await fs.mkdir(path.dirname(pythonPath), { recursive: true });
      await fs.mkdir(path.join(runtime, "models", "whisper"), { recursive: true });
      await fs.mkdir(path.join(app, "apps", "desktop", "resources", "assistant-voice"), {
        recursive: true,
      });
      await fs.writeFile(pythonPath, "");
      await fs.writeFile(
        path.join(app, "apps", "desktop", "resources", "assistant-voice", "engine.py"),
        "",
      );
      const native = NodeModule.createRequire(import.meta.url)(
        "node:child_process",
      ) as typeof NodeChildProcess;
      const requests: Array<{ device: string; model: string; audio: string }> = [];
      const spawnSpy = vi.spyOn(native, "spawn").mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), {
          pid: 321987654,
          exitCode: null,
          signalCode: null,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        });
        let input = "";
        child.stdin.on("data", (chunk) => {
          input += chunk.toString();
        });
        child.stdin.on("finish", () => {
          const request = JSON.parse(input) as { device: string; model: string; audio: string };
          requests.push(request);
          if (request.device === "cuda:0" && scenario === "gpu process failure") {
            child.stderr.write("CUDA library unavailable");
            child.emit("close", 1);
          } else {
            const failed = request.device === "cuda:0" && scenario === "gpu error";
            child.stdout.write(
              JSON.stringify(
                failed ? { ok: false, error: "CUDA 실패" } : { ok: true, text: "한국어 전사" },
              ),
            );
            child.emit("close", failed ? 1 : 0);
          }
        });
        return child as unknown as NodeChildProcess.ChildProcess;
      });
      NodeModule.syncBuiltinESMExports();
      const previous = process.env.T3_ASSISTANT_VOICE_HOME;
      process.env.T3_ASSISTANT_VOICE_HOME = runtime;
      try {
        const audio = wav(4).toString("base64");
        const result = await runVoice(app, { task: "transcribe", audio });
        expect(result).toMatchObject({
          ok: true,
          text: "한국어 전사",
          device: scenario === "gpu success" ? "cuda:0" : "cpu",
        });
        expect(requests.map((request) => request.device)).toEqual(
          scenario === "gpu success" ? ["cuda:0"] : ["cuda:0", "cpu"],
        );
        expect(
          requests.every(
            (request) =>
              request.audio === audio && request.model === path.join(runtime, "models", "whisper"),
          ),
        ).toBe(true);
        expect(spawnSpy.mock.calls.every((call) => call[2]?.windowsHide === true)).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.T3_ASSISTANT_VOICE_HOME;
        else process.env.T3_ASSISTANT_VOICE_HOME = previous;
        spawnSpy.mockRestore();
        NodeModule.syncBuiltinESMExports();
      }
    },
  );
});

const python = process.platform === "win32" ? "python.exe" : "python3";
const available = spawnSync(python, ["--version"], { windowsHide: true }).status === 0;
const engine = fileURLToPath(new URL("../../resources/assistant-voice/engine.py", import.meta.url));
const run = (source: string, request: unknown) =>
  spawnSync(python, ["-B", "-c", source, engine], {
    windowsHide: true,
    encoding: "utf8",
    input: JSON.stringify(request),
    env: {
      ...process.env,
      PYTHONIOENCODING: "cp949",
      PYTHONUTF8: "0",
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });

it.skipIf(!available)(
  "uses UTF-8 for Korean JSON requests, responses and errors even under CP949",
  async () => {
    const root = await temporary();
    const source =
      "import runpy,sys; d=runpy.run_path(sys.argv[1],run_name='voice_test'); d['main'].__globals__['clone']=lambda r:{'text':r['text']}; sys.exit(d['main']())";
    const result = run(source, {
      task: "clone",
      model: root,
      text: "안녕하세요. 음성 합성 시험입니다.",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      text: "안녕하세요. 음성 합성 시험입니다.",
    });
    const failure = run(source, {
      task: "clone",
      model: path.join(root, "없는 모델"),
      text: "시험",
    });
    expect(failure.status).toBe(1);
    expect(JSON.parse(failure.stdout).error).toContain("음성 모델 폴더를 찾을 수 없습니다");
  },
);

it.skipIf(!process.env.T3_ASSISTANT_VOICE_TEST_PYTHON)(
  "matches librosa's HQ resampling and length for mono and stereo WAVs",
  async () => {
    const root = await temporary();
    const source = `
import base64, io, runpy, sys, types
import librosa, numpy as np, soundfile as sf
captured = []
class Model:
    def __init__(self, *args, **kwargs):
        assert kwargs['device'] == 'cpu' and kwargs['compute_type'] == 'int8'
    def transcribe(self, audio):
        captured.append(audio.copy())
        return ([], None)
sys.modules['faster_whisper'] = types.SimpleNamespace(WhisperModel=Model)
engine = runpy.run_path(sys.argv[1], run_name='voice_test')
count = 0
for rate in (8000, 16000, 22050, 24000, 44100, 48000):
    for channels in (1, 2):
        for length in (777, 1025, 10001):
            t = np.arange(length, dtype=np.float32) / rate
            left = np.sin(t * 440 * (2 * np.pi)).astype(np.float32) * 0.3
            data = left if channels == 1 else np.stack((left, left * -0.4), axis=1)
            encoded = io.BytesIO()
            sf.write(encoded, data, rate, format='WAV', subtype='PCM_16')
            raw = encoded.getvalue()
            decoded, _ = sf.read(io.BytesIO(raw), dtype='float32')
            if decoded.ndim == 2: decoded = decoded.mean(axis=1)
            expected = decoded if rate == 16000 else librosa.resample(decoded, orig_sr=rate, target_sr=16000, res_type='soxr_hq')
            engine['transcribe']({'audio': base64.b64encode(raw).decode('ascii'), 'model': 'unused', 'device': 'cpu'})
            actual = captured.pop()
            assert len(actual) == len(expected), (rate, channels, length, len(actual), len(expected))
            assert np.array_equal(actual, expected), (rate, channels, length, float(np.max(np.abs(actual - expected))))
            count += 1
print(count)
`;
    const result = spawnSync(
      process.env.T3_ASSISTANT_VOICE_TEST_PYTHON!,
      ["-B", "-c", source, engine],
      {
        windowsHide: true,
        encoding: "utf8",
        timeout: 110_000,
        env: {
          ...process.env,
          PYTHONUTF8: "1",
          PYTHONDONTWRITEBYTECODE: "1",
          NUMBA_CACHE_DIR: path.join(root, "numba"),
          TEMP: root,
          TMP: root,
        },
      },
    );
    expect(result.error ?? result.stderr).toBeFalsy();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("36");
  },
  120_000,
);
