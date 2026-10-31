// @effect-diagnostics nodeBuiltinImport:off -- Jasna is a local native program.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { DesktopJasnaJob, DesktopJasnaSnapshot, DesktopJasnaStart } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const LOG_TAIL_LENGTH = 16_384;

export class DesktopJasnaError extends Schema.TaggedErrorClass<DesktopJasnaError>()(
  "DesktopJasnaError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

interface InternalJob {
  readonly process: NodeChildProcess.ChildProcess;
  readonly finished: Promise<void>;
  readonly finish: () => void;
  snapshot: DesktopJasnaJob;
  settled: boolean;
}

export interface JasnaController {
  readonly snapshot: () => DesktopJasnaSnapshot;
  readonly restoreExecutable: () => Promise<void>;
  readonly selectExecutable: (path: string) => Promise<DesktopJasnaSnapshot>;
  readonly clearExecutable: () => Promise<DesktopJasnaSnapshot>;
  readonly selectInput: (path: string) => Promise<DesktopJasnaSnapshot>;
  readonly selectOutput: (path: string) => Promise<DesktopJasnaSnapshot>;
  readonly start: (selection: DesktopJasnaStart) => Promise<DesktopJasnaSnapshot>;
  readonly cancel: (id: string) => Promise<DesktopJasnaSnapshot>;
  readonly waitForJob: (id: string) => Promise<DesktopJasnaSnapshot>;
}

export function makeController(
  platform: NodeJS.Platform,
  spawn: typeof NodeChildProcess.spawn = NodeChildProcess.spawn,
  windowsSystemRoot?: string,
  settingsPath?: string,
  defaultExecutablePath?: string,
): JasnaController {
  let executablePath: string | null = null;
  let inputPath: string | null = null;
  let outputPath: string | null = null;
  const jobs = new Map<string, InternalJob>();
  const reservedOutputs = new Set<string>();

  const snapshot = (): DesktopJasnaSnapshot => ({
    executablePath,
    inputPath,
    outputPath,
    jobs: [...jobs.values()].map(({ snapshot: job }) => ({ ...job })),
  });
  const active = (job: InternalJob) => !job.settled;
  const pathKey = (path: string) => {
    const normalized = NodePath.resolve(path);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const file = async (path: string, label: string) => {
    const resolved = await NodeFSP.realpath(path);
    if (!(await NodeFSP.stat(resolved)).isFile()) throw new Error(`${label}은 파일이어야 합니다.`);
    return resolved;
  };
  const assertOutputAvailable = async (path: string) => {
    const parent = await NodeFSP.stat(NodePath.dirname(path));
    if (!parent.isDirectory()) throw new Error("출력 폴더가 존재하지 않습니다.");
    try {
      await NodeFSP.lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new Error("출력 파일이 이미 있습니다. 다른 파일 이름을 선택하세요.");
  };

  const validateExecutable = async (path: string) => {
    const selected = await file(path, "Jasna 실행 파일");
    const name = NodePath.basename(selected).toLowerCase();
    if (name !== (platform === "win32" ? "jasna.exe" : "jasna")) {
      throw new Error("Jasna 실행 파일을 선택하세요.");
    }
    if ([...NodePath.dirname(selected)].some((character) => character.codePointAt(0)! > 127)) {
      throw new Error("Jasna 설치 폴더의 경로에는 영문 문자만 사용할 수 있습니다.");
    }
    return selected;
  };
  const restoreExecutable = async () => {
    if (!settingsPath) return;
    let saved: unknown;
    try {
      saved = JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (defaultExecutablePath) {
          try {
            executablePath = await validateExecutable(defaultExecutablePath);
          } catch (discoveryError) {
            if ((discoveryError as NodeJS.ErrnoException).code !== "ENOENT") throw discoveryError;
          }
        }
        return;
      }
      throw error;
    }
    if (
      typeof saved !== "object" ||
      saved === null ||
      !("executablePath" in saved) ||
      (saved.executablePath !== null && typeof saved.executablePath !== "string")
    ) {
      throw new Error("저장된 Jasna 실행 파일 설정을 읽지 못했습니다.");
    }
    executablePath =
      saved.executablePath === null ? null : await validateExecutable(saved.executablePath);
  };
  const saveExecutable = async (selected: string | null) => {
    if (settingsPath) {
      await NodeFSP.mkdir(NodePath.dirname(settingsPath), { recursive: true });
      const temporary = `${settingsPath}.${NodeCrypto.randomUUID()}.pending`;
      let created = false;
      try {
        await NodeFSP.writeFile(
          temporary,
          JSON.stringify({ version: 1, executablePath: selected }),
          { flag: "wx" },
        );
        created = true;
        await NodeFSP.rename(temporary, settingsPath);
      } finally {
        if (created) await NodeFSP.unlink(temporary).catch(() => undefined);
      }
    }
  };
  const selectExecutable = async (path: string) => {
    const selected = await validateExecutable(path);
    await saveExecutable(selected);
    executablePath = selected;
    return snapshot();
  };
  const selectInput = async (path: string) => {
    inputPath = await file(path, "입력 영상");
    return snapshot();
  };
  const clearExecutable = async () => {
    await saveExecutable(null);
    executablePath = null;
    return snapshot();
  };
  const selectOutput = async (path: string) => {
    outputPath = NodePath.resolve(path);
    return snapshot();
  };

  const start = async (selection: DesktopJasnaStart) => {
    if (!executablePath || !inputPath || !outputPath) {
      throw new Error("Jasna 실행 파일, 입력 영상과 출력 파일을 선택하세요.");
    }
    if (
      selection.executablePath !== executablePath ||
      selection.inputPath !== inputPath ||
      selection.outputPath !== outputPath
    ) {
      throw new Error("선택한 파일이 변경됐습니다. 파일을 확인한 뒤 다시 시작하세요.");
    }
    const executable = await file(selection.executablePath, "Jasna 실행 파일");
    const input = await file(selection.inputPath, "입력 영상");
    const output = selection.outputPath;
    if (pathKey(input) === pathKey(output)) throw new Error("입력과 출력 파일은 달라야 합니다.");
    await assertOutputAvailable(output);
    const outputKey = pathKey(output);
    if (reservedOutputs.has(outputKey)) {
      throw new Error("같은 출력 파일을 사용하는 복원 작업이 이미 실행 중입니다.");
    }
    reservedOutputs.add(outputKey);
    const id = NodeCrypto.randomUUID();
    const extension = NodePath.extname(output);
    if (!extension) {
      reservedOutputs.delete(outputKey);
      throw new Error("출력 파일의 영상 형식을 선택하세요.");
    }
    const temporary = NodePath.join(NodePath.dirname(output), `.t3-jasna-${id}${extension}`);
    let child: NodeChildProcess.ChildProcess;
    let temporaryReserved = false;
    try {
      const reservation = await NodeFSP.open(temporary, "wx");
      temporaryReserved = true;
      await reservation.close();
      const args = ["--input", input, "--output", temporary];
      if (selection.model !== null) args.push("--restoration-model-name", selection.model);
      child = spawn(executable, args, {
        cwd: NodePath.dirname(executable),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      if (temporaryReserved) await NodeFSP.unlink(temporary).catch(() => undefined);
      reservedOutputs.delete(outputKey);
      throw error;
    }
    let finish = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const job: InternalJob = {
      process: child,
      finished,
      finish,
      settled: false,
      snapshot: {
        id,
        inputPath: input,
        outputPath: output,
        model: selection.model,
        status: "starting",
        exitCode: null,
        logTail: "",
        error: null,
      },
    };
    jobs.set(id, job);
    const append = (chunk: Buffer | string) => {
      job.snapshot = {
        ...job.snapshot,
        logTail: (job.snapshot.logTail + chunk.toString()).slice(-LOG_TAIL_LENGTH),
      };
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.stdout?.on("error", (error) => append(`\n출력 읽기 오류: ${error.message}`));
    child.stderr?.on("error", (error) => append(`\n오류 기록 읽기 실패: ${error.message}`));
    child.once("spawn", () => {
      if (!job.settled && job.snapshot.status === "starting") {
        job.snapshot = { ...job.snapshot, status: "running" };
      }
    });
    child.once("error", (error) => {
      if (job.settled) return;
      job.settled = true;
      reservedOutputs.delete(outputKey);
      job.snapshot = {
        ...job.snapshot,
        status: "failed",
        error: `${error.message} 임시 파일: ${temporary}`,
      };
      job.finish();
    });
    child.once("close", (code) => {
      if (job.settled) return;
      if (job.snapshot.status === "cancelling") {
        job.settled = true;
        reservedOutputs.delete(outputKey);
        job.snapshot = {
          ...job.snapshot,
          status: "cancelled",
          exitCode: code,
          error: `중지된 작업의 임시 파일: ${temporary}`,
        };
        job.finish();
      } else if (code !== 0) {
        job.settled = true;
        reservedOutputs.delete(outputKey);
        job.snapshot = {
          ...job.snapshot,
          status: "failed",
          exitCode: code,
          error: `Jasna가 오류로 종료됐습니다. 실행 기록과 임시 파일을 확인하세요: ${temporary}`,
        };
        job.finish();
      } else {
        void (async () => {
          try {
            const info = await NodeFSP.stat(temporary);
            if (!info.isFile() || info.size === 0)
              throw new Error("출력 영상이 없거나 비어 있습니다.");
            // link is atomic and fails if another process has created the destination.
            await NodeFSP.link(temporary, output);
            await NodeFSP.unlink(temporary).catch(() => undefined);
            job.snapshot = { ...job.snapshot, status: "completed", exitCode: code };
          } catch (error) {
            job.snapshot = {
              ...job.snapshot,
              status: "failed",
              exitCode: code,
              error: `${error instanceof Error ? error.message : "출력 영상을 저장하지 못했습니다."} 임시 파일: ${temporary}`,
            };
          } finally {
            job.settled = true;
            reservedOutputs.delete(outputKey);
            job.finish();
          }
        })();
      }
    });
    return snapshot();
  };

  const cancel = async (id: string) => {
    const job = jobs.get(id);
    if (!job || !active(job)) throw new Error("실행 중인 복원 작업을 찾지 못했습니다.");
    const pid = job.process.pid;
    if (pid === undefined || job.process.exitCode !== null || job.process.signalCode !== null) {
      throw new Error("복원 프로세스가 이미 종료되었습니다.");
    }
    job.snapshot = { ...job.snapshot, status: "cancelling" };
    if (platform === "win32") {
      if (!windowsSystemRoot) {
        job.snapshot = { ...job.snapshot, status: "running" };
        throw new Error("Windows 시스템 경로를 확인하지 못해 복원 작업을 중지하지 못했습니다.");
      }
      await new Promise<void>((resolve, reject) => {
        const killer = spawn(
          NodePath.join(windowsSystemRoot, "System32", "taskkill.exe"),
          ["/PID", String(pid), "/T", "/F"],
          {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          },
        );
        killer.once("error", reject);
        killer.once("close", (code) =>
          code === 0 || job.settled
            ? resolve()
            : reject(new Error("복원 프로세스를 중지하지 못했습니다.")),
        );
      }).catch((error: unknown) => {
        if (!job.settled) job.snapshot = { ...job.snapshot, status: "running" };
        throw error;
      });
    } else if (!job.process.kill("SIGTERM")) {
      job.snapshot = { ...job.snapshot, status: "running" };
      throw new Error("복원 프로세스를 중지하지 못했습니다.");
    }
    return snapshot();
  };

  const waitForJob = async (id: string) => {
    const job = jobs.get(id);
    if (!job) throw new Error("복원 작업을 찾지 못했습니다.");
    await job.finished;
    return snapshot();
  };

  return {
    snapshot,
    restoreExecutable,
    selectExecutable,
    clearExecutable,
    selectInput,
    selectOutput,
    start,
    cancel,
    waitForJob,
  };
}

export class JasnaSupervisor extends Context.Service<JasnaSupervisor, JasnaController>()(
  "@t3tools/desktop/jasna/JasnaSupervisor",
) {}

export const layer = Layer.effect(
  JasnaSupervisor,
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const environment = yield* HostProcessEnvironment;
    const desktop = yield* DesktopEnvironment.DesktopEnvironment;
    const controller = makeController(
      platform,
      NodeChildProcess.spawn,
      environment.SystemRoot ?? environment.SYSTEMROOT,
      NodePath.join(desktop.stateDir, "jasna-settings.json"),
      platform === "win32"
        ? NodePath.join(desktop.stateDir, "jasna", "0.11.3", "jasna.exe")
        : undefined,
    );
    yield* attempt(controller.restoreExecutable).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not restore the selected Jasna executable.", {
          error: error.message,
        }),
      ),
    );
    return JasnaSupervisor.of(controller);
  }),
);

export const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new DesktopJasnaError({
        detail: error instanceof Error ? error.message : "Jasna 요청을 처리하지 못했습니다.",
      }),
  });
