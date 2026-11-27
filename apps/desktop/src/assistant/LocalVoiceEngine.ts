// @effect-diagnostics nodeBuiltinImport:off - Python needs Windows hidden spawn and Electron asar-aware reads.
import * as childProcess from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type VoiceRequest = {
  task: "transcribe" | "clone";
  audio?: string;
  text?: string;
  referenceText?: string;
};

const MAX_AUDIO_BASE64 = Math.ceil((25 * 1024 * 1024) / 3) * 4;
const MAX_OUTPUT_CHARS = 64 * 1024 * 1024;
const MAX_RUN_MS = 5 * 60 * 1000;
type ActiveVoiceRun = { child: childProcess.ChildProcess | null; cancelled: boolean };
class VoiceStoppedError extends Error {}
let activeRun: ActiveVoiceRun | null = null;
const sampleQueues = new Map<string, Promise<void>>();
const sampleGenerations = new Map<string, string>();
const activeSampleDatabases = new Map<string, DatabaseSync>();
const sampleDatabase = ".assistant-voice-coordination.sqlite";
const sampleIntent = ".assistant-voice-intent";
const sampleLockWaitMs = 5_000;
const sampleFile = "assistant-voice-sample.wav";
const sampleBackup = ".assistant-voice-sample-backup.wav";
const sampleJournal = ".assistant-voice-sample-transaction.json";
const sampleJournalTemp = ".assistant-voice-sample-transaction.tmp";
const sampleRestoreTemp = ".assistant-voice-sample-restore.tmp";
const sampleCandidatePattern =
  /^\.assistant-voice-sample-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

async function unlinkIfPresent(file: string) {
  try {
    await fs.unlink(file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
}

async function writeDurably(file: string, data: string | Buffer) {
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Caller holds the per-state-directory sample queue. The backup remains intact
// until recovery has published the old state and removed the journal.
async function recoverVoiceSample(stateDir: string) {
  const journal = path.join(stateDir, sampleJournal);
  const backup = path.join(stateDir, sampleBackup);
  const restore = path.join(stateDir, sampleRestoreTemp);
  let raw: string;
  try {
    raw = await fs.readFile(journal, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    await unlinkIfPresent(backup);
    await unlinkIfPresent(path.join(stateDir, sampleJournalTemp));
    await unlinkIfPresent(restore);
    return;
  }
  const record: unknown = JSON.parse(raw);
  if (
    !record ||
    typeof record !== "object" ||
    !("version" in record) ||
    (record.version !== 1 && record.version !== 2 && record.version !== 3) ||
    !("previous" in record) ||
    (record.previous !== "present" && record.previous !== "absent") ||
    (record.version !== 1 &&
      (!("candidate" in record) ||
        typeof record.candidate !== "string" ||
        !sampleCandidatePattern.test(record.candidate))) ||
    (record.version === 3 &&
      (!("phase" in record) ||
        (record.phase !== "pending" && record.phase !== "owned") ||
        (record.phase === "owned" &&
          (!("dev" in record) ||
            typeof record.dev !== "string" ||
            !/^\d+$/.test(record.dev) ||
            !("ino" in record) ||
            typeof record.ino !== "string" ||
            !/^[1-9]\d*$/.test(record.ino)))))
  ) {
    throw new Error("음성 샘플 복구 기록이 유효하지 않습니다. 복구 파일을 보존했습니다.");
  }
  await unlinkIfPresent(restore);
  if (record.previous === "present") {
    await fs.copyFile(backup, restore);
    await fs.rename(restore, path.join(stateDir, sampleFile));
  } else {
    await unlinkIfPresent(path.join(stateDir, sampleFile));
  }
  if (record.version === 2 && "candidate" in record && typeof record.candidate === "string") {
    const legacy = await fs.lstat(path.join(stateDir, record.candidate)).then(
      () => true,
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return false;
        throw cause;
      },
    );
    if (legacy)
      throw new Error(
        "이전 버전의 샘플 복구 폴더를 안전하게 자동 삭제할 수 없습니다. 복구 파일을 보존했습니다.",
      );
  }
  if (
    record.version === 3 &&
    "phase" in record &&
    record.phase === "owned" &&
    "candidate" in record &&
    typeof record.candidate === "string" &&
    "dev" in record &&
    "ino" in record
  ) {
    const candidate = path.join(stateDir, record.candidate);
    let info: fsSync.BigIntStats | null;
    try {
      info = fsSync.lstatSync(candidate, { bigint: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      info = null;
    }
    if (
      info &&
      (!info.isFile() ||
        info.isSymbolicLink() ||
        String(info.dev) !== record.dev ||
        String(info.ino) !== record.ino)
    ) {
      throw new Error("음성 샘플 후보 파일이 바뀌었습니다. 복구 파일을 보존했습니다.");
    }
    if (info) fsSync.unlinkSync(candidate);
  }
  await unlinkIfPresent(journal);
  await unlinkIfPresent(backup);
  await unlinkIfPresent(path.join(stateDir, sampleJournalTemp));
  await unlinkIfPresent(restore);
}

function sampleQueueKey(stateDir: string) {
  const resolved = path.resolve(stateDir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function openSampleDatabase(stateDir: string, timeout: number) {
  fsSync.mkdirSync(stateDir, { recursive: true });
  return new DatabaseSync(path.join(stateDir, sampleDatabase), { timeout });
}

function initializeSampleDatabase(db: DatabaseSync) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS generation (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL)",
  );
}

function writeSampleGeneration(stateDir: string, token: string) {
  const key = sampleQueueKey(stateDir);
  const db = activeSampleDatabases.get(key);
  if (!db) throw new Error("음성 샘플 잠금이 없습니다.");
  db.prepare(
    "INSERT INTO generation (id, token) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET token = excluded.token",
  ).run(token);
}

function isSampleDatabaseBusy(cause: unknown) {
  const error = cause as { errcode?: number; message?: string };
  return (
    (typeof error?.errcode === "number" && (error.errcode & 255) === 5) ||
    /database is locked/i.test(error?.message ?? "")
  );
}

function readSampleGeneration(db: DatabaseSync) {
  try {
    const row = db.prepare("SELECT token FROM generation WHERE id = 1").get();
    return typeof row?.token === "string" ? row.token : null;
  } catch (cause) {
    if (/no such table/i.test(String(cause))) return null;
    throw cause;
  }
}

function writeSampleIntent(stateDir: string, token: string) {
  fsSync.mkdirSync(stateDir, { recursive: true });
  const temporary = path.join(stateDir, `.assistant-voice-intent-${token}.tmp`);
  let created = false;
  try {
    const fd = fsSync.openSync(temporary, "wx", 0o600);
    created = true;
    try {
      fsSync.writeFileSync(fd, token);
    } finally {
      fsSync.closeSync(fd);
    }
    fsSync.renameSync(temporary, path.join(stateDir, sampleIntent));
    created = false;
  } finally {
    if (created) {
      try {
        fsSync.unlinkSync(temporary);
      } catch {}
    }
  }
}

function sampleIntentMatches(stateDir: string, token: string) {
  try {
    return fsSync.readFileSync(path.join(stateDir, sampleIntent), "utf8") === token;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

function sampleGenerationMatches(stateDir: string, token: string) {
  const key = sampleQueueKey(stateDir);
  const db = activeSampleDatabases.get(key);
  if (!db) throw new Error("음성 샘플 잠금이 없습니다.");
  return (
    sampleGenerations.get(key) === token &&
    sampleIntentMatches(stateDir, token) &&
    readSampleGeneration(db) === token
  );
}

async function acquireSampleDatabase(stateDir: string) {
  const db = openSampleDatabase(stateDir, 0);
  let attempts = 0;
  try {
    for (;;) {
      try {
        db.exec("BEGIN IMMEDIATE");
        break;
      } catch (cause) {
        const busy = isSampleDatabaseBusy(cause);
        if (!busy || attempts++ >= sampleLockWaitMs / 25) throw cause;
        // @effect-diagnostics-next-line globalTimers:off - Bounded wait for another process's SQLite transaction.
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    initializeSampleDatabase(db);
    activeSampleDatabases.set(sampleQueueKey(stateDir), db);
    return db;
  } catch (cause) {
    db.close();
    throw cause;
  }
}

function serializeSample<T>(
  stateDir: string,
  operation: () => Promise<T>,
  onCommitFailure?: (value: T, cause: unknown) => T,
): Promise<T> {
  const key = sampleQueueKey(stateDir);
  const previous = sampleQueues.get(key) ?? Promise.resolve();
  const result = previous.then(async () => {
    const db = await acquireSampleDatabase(stateDir);
    try {
      let value: T;
      try {
        value = await operation();
      } catch (cause) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw cause;
      }
      try {
        db.exec("COMMIT");
      } catch (cause) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        if (onCommitFailure) return onCommitFailure(value, cause);
        throw cause;
      }
      return value;
    } finally {
      activeSampleDatabases.delete(key);
      db.close();
    }
  });
  const tail = result.then(
    () => {},
    () => {},
  );
  sampleQueues.set(key, tail);
  void tail.then(() => {
    if (sampleQueues.get(key) === tail) sampleQueues.delete(key);
  });
  return result;
}

function terminateOwnedProcess(child: childProcess.ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    const taskkill = path.join(process.env.SystemRoot || "C:/Windows", "System32", "taskkill.exe");
    childProcess.execFile(
      taskkill,
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true },
      (error) => {
        if (error && child.exitCode === null && child.signalCode === null) child.kill();
      },
    );
  } else {
    child.kill();
  }
}

export function cancelVoice(): boolean {
  if (!activeRun) return false;
  activeRun.cancelled = true;
  if (activeRun.child) terminateOwnedProcess(activeRun.child);
  return true;
}

export function voicePaths(
  appRoot: string,
  home = process.env.T3_ASSISTANT_VOICE_HOME,
  resourcesPath?: string,
  runtimeBase = appRoot,
) {
  const root = home || path.join(runtimeBase, ".t3", "assistant-voice-runtime");
  return {
    python:
      process.platform === "win32"
        ? path.join(root, "venv", "Scripts", "python.exe")
        : path.join(root, "venv", "bin", "python"),
    whisper: path.join(root, "models", "whisper"),
    qwen: path.join(root, "models", "qwen"),
    script: resourcesPath
      ? path.join(resourcesPath, "assistant-voice", "engine.py")
      : path.join(appRoot, "apps", "desktop", "resources", "assistant-voice", "engine.py"),
  };
}

export async function voiceStatus(
  appRoot: string,
  resourcesPath?: string,
  runtimeBase?: string,
  stateDir?: string,
) {
  const paths = voicePaths(appRoot, undefined, resourcesPath, runtimeBase);
  const exists = (file: string, directory = false) =>
    fs.stat(file).then(
      (stat) => (directory ? stat.isDirectory() : stat.isFile()),
      () => false,
    );
  const [python, whisper, qwen, script] = await Promise.all([
    exists(paths.python),
    exists(paths.whisper, true),
    exists(paths.qwen, true),
    exists(paths.script),
  ]);
  const samplePath = stateDir ? path.join(stateDir, sampleFile) : "";
  const sample = stateDir
    ? await serializeSample(stateDir, async () => {
        await recoverVoiceSample(stateDir);
        return await fs.stat(samplePath).then(
          (s) => s.isFile(),
          () => false,
        );
      })
    : false;
  return { paths: { ...paths, sample: samplePath }, python, whisper, qwen, script, sample };
}

export function beginVoiceSampleUpdate(stateDir: string): Promise<string> {
  const token = randomUUID();
  const key = sampleQueueKey(stateDir);
  sampleGenerations.set(key, token);
  try {
    writeSampleIntent(stateDir, token);
  } catch (cause) {
    return Promise.reject(cause);
  }
  return serializeSample(stateDir, async () => {
    if (sampleGenerations.get(key) !== token || !sampleIntentMatches(stateDir, token))
      throw new Error("새로운 샘플 변경이나 삭제로 이전 선택이 취소되었습니다.");
    writeSampleGeneration(stateDir, token);
    return token;
  }).catch((cause) => {
    if (sampleGenerations.get(key) === token) sampleGenerations.delete(key);
    throw cause;
  });
}

export function saveVoiceSample(
  stateDir: string,
  audio: string,
  token: string | Promise<string>,
): Promise<{ ok: boolean; error?: string; warning?: string }> {
  if (typeof token !== "string")
    return token.then((resolved) => saveVoiceSample(stateDir, audio, resolved));
  return serializeSample(
    stateDir,
    async () => {
      try {
        await recoverVoiceSample(stateDir);
      } catch (cause) {
        return {
          ok: false,
          error: `음성 샘플을 복구하지 못했습니다. 복구 파일을 보존했습니다: ${String(cause)}`,
        };
      }
      if (!sampleGenerationMatches(stateDir, token))
        return { ok: false, error: "새로운 샘플 변경이나 삭제로 이전 저장이 취소되었습니다." };
      if (!audio || audio.length > MAX_AUDIO_BASE64)
        return { ok: false, error: "음성 샘플이 비어 있거나 25 MiB를 초과했습니다." };
      const data = Buffer.from(audio, "base64");
      if (data.length > 25 * 1024 * 1024)
        return { ok: false, error: "음성 샘플이 25 MiB를 초과했습니다." };
      if (
        data.length < 44 ||
        data.toString("ascii", 0, 4) !== "RIFF" ||
        data.toString("ascii", 8, 12) !== "WAVE"
      ) {
        return { ok: false, error: "유효한 WAV 음성 샘플이 아닙니다." };
      }
      await fs.mkdir(stateDir, { recursive: true });
      const file = path.join(stateDir, sampleFile);
      const candidate = `.assistant-voice-sample-${randomUUID()}.tmp`;
      const temporary = path.join(stateDir, candidate);
      let journalPublished = false;
      try {
        const previous = await fs.readFile(file).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT") return null;
          throw cause;
        });
        if (!sampleGenerationMatches(stateDir, token))
          return { ok: false, error: "새로운 샘플 변경이나 삭제로 이전 저장이 취소되었습니다." };
        if (previous !== null) await writeDurably(path.join(stateDir, sampleBackup), previous);
        const journalTemp = path.join(stateDir, sampleJournalTemp);
        const originalState = previous === null ? "absent" : "present";
        await writeDurably(
          journalTemp,
          JSON.stringify({ version: 3, previous: originalState, candidate, phase: "pending" }),
        );
        await fs.rename(journalTemp, path.join(stateDir, sampleJournal));
        journalPublished = true;
        if (!sampleGenerationMatches(stateDir, token)) {
          await recoverVoiceSample(stateDir);
          return { ok: false, error: "새로운 샘플 변경이나 삭제로 이전 저장이 취소되었습니다." };
        }
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
          const info = await handle.stat({ bigint: true });
          if (!info.isFile() || info.ino === 0n)
            throw new Error("음성 샘플 후보의 파일 식별자를 확인할 수 없습니다.");
          await writeDurably(
            journalTemp,
            JSON.stringify({
              version: 3,
              previous: originalState,
              candidate,
              phase: "owned",
              dev: String(info.dev),
              ino: String(info.ino),
            }),
          );
          await fs.rename(journalTemp, path.join(stateDir, sampleJournal));
          if (sampleGenerationMatches(stateDir, token)) {
            await handle.writeFile(data);
            await handle.sync();
          }
        } finally {
          await handle.close();
        }
        if (!sampleGenerationMatches(stateDir, token)) {
          await recoverVoiceSample(stateDir);
          return { ok: false, error: "새로운 샘플 변경이나 삭제로 이전 저장이 취소되었습니다." };
        }
        await fs.rename(temporary, file);
        if (!sampleGenerationMatches(stateDir, token)) {
          try {
            await recoverVoiceSample(stateDir);
          } catch (cause) {
            return {
              ok: false,
              error: `취소된 샘플 저장 후 이전 샘플을 복원하지 못했습니다. 복구 파일을 보존했습니다: ${String(cause)}`,
            };
          }
          return { ok: false, error: "새로운 샘플 변경이나 삭제로 이전 저장이 취소되었습니다." };
        }
        // The generation check above and this synchronous unlink form the commit
        // point: no other window's begin/delete handler can run between them.
        try {
          fsSync.unlinkSync(path.join(stateDir, sampleJournal));
        } catch (cause) {
          if (!fsSync.existsSync(path.join(stateDir, sampleJournal))) {
            return {
              ok: false,
              error: `샘플 저장의 확정 여부를 확인하지 못했습니다. 복구 파일을 보존했습니다: ${String(cause)}`,
            };
          }
          throw cause;
        }
        try {
          fsSync.unlinkSync(path.join(stateDir, sampleBackup));
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
            return {
              ok: true,
              warning: `샘플을 저장했지만 이전 샘플의 임시 백업을 정리하지 못했습니다: ${String(cause)}`,
            };
          }
        }
        return { ok: true };
      } catch (cause) {
        if (journalPublished) {
          try {
            await recoverVoiceSample(stateDir);
          } catch (recovery) {
            return {
              ok: false,
              error: `음성 샘플 저장 및 복구에 실패했습니다. 복구 파일을 보존했습니다: ${String(recovery)}`,
            };
          }
        }
        return { ok: false, error: `음성 샘플을 저장하지 못했습니다: ${String(cause)}` };
      }
    },
    (value, cause) =>
      value.ok
        ? {
            ...value,
            warning: `${value.warning ? `${value.warning} ` : ""}샘플은 저장했지만 잠금 상태를 확정하지 못했습니다: ${String(cause)}`,
          }
        : {
            ...value,
            error: `${value.error ?? "샘플 저장 실패"}; 잠금 상태를 확정하지 못했습니다: ${String(cause)}`,
          },
  );
}

export function deleteVoiceSample(stateDir: string) {
  const key = sampleQueueKey(stateDir);
  const deletion = randomUUID();
  sampleGenerations.set(key, deletion);
  try {
    writeSampleIntent(stateDir, deletion);
  } catch (cause) {
    return Promise.resolve({
      ok: false,
      error: `음성 샘플 상태를 기록하지 못했습니다: ${String(cause)}`,
    });
  }
  return serializeSample(stateDir, async () => {
    const db = activeSampleDatabases.get(key);
    if (
      !db ||
      sampleGenerations.get(key) !== deletion ||
      !sampleIntentMatches(stateDir, deletion)
    ) {
      return { ok: false, error: "새로운 샘플 선택으로 이전 삭제가 취소되었습니다." };
    }
    writeSampleGeneration(stateDir, deletion);
    return { ok: true };
  })
    .then((reserved) => {
      if (!reserved.ok) return reserved;
      return serializeSample(
        stateDir,
        async () => {
          const db = activeSampleDatabases.get(key);
          if (
            !db ||
            sampleGenerations.get(key) !== deletion ||
            !sampleIntentMatches(stateDir, deletion) ||
            readSampleGeneration(db) !== deletion
          ) {
            return { ok: false, error: "새로운 샘플 선택으로 이전 삭제가 취소되었습니다." };
          }
          try {
            await recoverVoiceSample(stateDir);
          } catch (cause) {
            return {
              ok: false,
              error: `음성 샘플을 복구하지 못했습니다. 복구 파일을 보존했습니다: ${String(cause)}`,
            };
          }
          if (
            sampleGenerations.get(key) !== deletion ||
            !sampleIntentMatches(stateDir, deletion) ||
            readSampleGeneration(db) !== deletion
          ) {
            return { ok: false, error: "새로운 샘플 선택으로 이전 삭제가 취소되었습니다." };
          }
          try {
            fsSync.unlinkSync(path.join(stateDir, sampleFile));
            return { ok: true };
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { ok: true };
            return { ok: false, error: `음성 샘플을 삭제하지 못했습니다: ${String(cause)}` };
          }
        },
        (value, cause) =>
          value.ok
            ? value
            : {
                ...value,
                error: `${value.error ?? "샘플 삭제 실패"}; 잠금 상태를 확정하지 못했습니다: ${String(cause)}`,
              },
      );
    })
    .catch((cause) => ({ ok: false, error: `음성 샘플 잠금을 얻지 못했습니다: ${String(cause)}` }));
}

async function invoke(
  python: string,
  script: string,
  request: Record<string, unknown>,
  scratch: string,
  run: ActiveVoiceRun,
): Promise<{ ok: boolean; text?: string; audio?: string; error?: string }> {
  if (run.cancelled) throw new Error("음성 작업이 취소되었습니다.");
  const source = await fs.readFile(script, "utf8");
  if (run.cancelled) throw new Error("음성 작업이 취소되었습니다.");
  return await new Promise((resolve, reject) => {
    const child = childProcess.spawn(python, ["-B", "-c", source], {
      windowsHide: true,
      cwd: scratch,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
        HF_HOME: path.join(scratch, "hf"),
        XDG_CACHE_HOME: path.join(scratch, "cache"),
        NUMBA_CACHE_DIR: path.join(scratch, "numba"),
        TORCHINDUCTOR_CACHE_DIR: path.join(scratch, "torch"),
        TEMP: scratch,
        TMP: scratch,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    run.child = child;
    if (run.cancelled) terminateOwnedProcess(child);
    let stopped = "";
    // @effect-diagnostics-next-line globalTimers:off - Bound the lifetime of this native child process.
    const timer = setTimeout(() => {
      stopped = "음성 작업 시간이 초과되었습니다.";
      terminateOwnedProcess(child);
    }, MAX_RUN_MS);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stopped) return;
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_CHARS && !stopped) {
        stopped = "음성 출력이 허용 크기를 초과했습니다.";
        terminateOwnedProcess(child);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      if (run.child === child) run.child = null;
      if (run.cancelled || stopped) {
        reject(new VoiceStoppedError(run.cancelled ? "음성 작업이 취소되었습니다." : stopped));
        return;
      }
      try {
        const value: unknown = JSON.parse(stdout);
        if (
          !value ||
          typeof value !== "object" ||
          !("ok" in value) ||
          typeof value.ok !== "boolean"
        ) {
          throw new Error("잘못된 음성 엔진 응답");
        }
        resolve(value as { ok: boolean; text?: string; audio?: string; error?: string });
      } catch {
        reject(new Error(`음성 엔진을 실행하지 못했습니다 (종료 코드 ${code}): ${stderr}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function runVoice(
  appRoot: string,
  request: VoiceRequest,
  resourcesPath?: string,
  runtimeBase?: string,
  stateDir?: string,
) {
  if (activeRun) return { ok: false, error: "다른 음성 작업이 진행 중입니다." };
  if (
    request.task === "transcribe" &&
    (!request.audio || request.audio.length > MAX_AUDIO_BASE64)
  ) {
    return { ok: false, error: "음성 입력이 비어 있거나 25 MiB를 초과했습니다." };
  }
  const run: ActiveVoiceRun = { child: null, cancelled: false };
  activeRun = run;
  let scratch: string | undefined;
  try {
    if (stateDir) await sampleQueues.get(sampleQueueKey(stateDir));
    const status = await voiceStatus(appRoot, resourcesPath, runtimeBase, stateDir);
    const modelReady = request.task === "clone" ? status.qwen : status.whisper;
    if (!status.python || !status.script || !modelReady) {
      return {
        ok: false,
        error: `음성 엔진 또는 모델 경로를 확인하세요: ${JSON.stringify(status.paths)}`,
      };
    }
    const temporaryRoot = await fs.realpath(os.tmpdir());
    const candidate = await fs.mkdtemp(path.join(temporaryRoot, "t3-assistant-voice-"));
    const resolvedScratch = await fs.realpath(candidate);
    if (
      path.dirname(resolvedScratch).toLowerCase() !== temporaryRoot.toLowerCase() ||
      !path.basename(resolvedScratch).startsWith("t3-assistant-voice-")
    ) {
      throw new Error("음성 임시 폴더 경로를 검증하지 못했습니다.");
    }
    scratch = resolvedScratch;
    const model = request.task === "clone" ? status.paths.qwen : status.paths.whisper;
    let audio = request.audio;
    if (request.task === "clone") {
      if (!status.sample)
        return { ok: false, error: "설정에서 복제할 로컬 음성 샘플을 선택하세요." };
      const data = stateDir
        ? await serializeSample(stateDir, async () => {
            await recoverVoiceSample(stateDir);
            return await fs.readFile(status.paths.sample);
          })
        : await fs.readFile(status.paths.sample);
      if (data.length > 25 * 1024 * 1024)
        return { ok: false, error: "저장된 음성 샘플이 25 MiB를 초과했습니다." };
      audio = data.toString("base64");
    }
    const input = { ...request, audio, model };
    let gpuError = "";
    try {
      const gpu = await invoke(
        status.paths.python,
        status.paths.script,
        { ...input, device: "cuda:0" },
        scratch,
        run,
      );
      if (gpu.ok) return { ...gpu, device: "cuda:0" };
      gpuError =
        gpu.error ??
        (request.task === "transcribe" ? "CUDA 음성 인식 실패" : "CUDA 음성 합성 실패");
    } catch (cause) {
      if (cause instanceof VoiceStoppedError) throw cause;
      gpuError = String(cause);
    }
    if (run.cancelled) return { ok: false, error: "음성 작업이 취소되었습니다." };
    const cpu = await invoke(
      status.paths.python,
      status.paths.script,
      { ...input, device: "cpu" },
      scratch,
      run,
    );
    return cpu.ok ? { ...cpu, device: "cpu" } : { ...cpu, error: `${gpuError}; CPU: ${cpu.error}` };
  } catch (cause) {
    return { ok: false, error: String(cause) };
  } finally {
    if (activeRun === run) activeRun = null;
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  }
}
