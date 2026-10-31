import * as NodeCrypto from "node:crypto";
import {
  WorkspaceDevelopmentError,
  type DevelopmentVerificationCommand,
  type DevelopmentVerificationArtifact,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ProcessRunner } from "../processRunner.ts";
import { ServerConfig } from "../config.ts";
import { redactConversationRagSensitiveData } from "./workspaceConversationRag.ts";
import { captureVerificationArtifacts } from "./WorkspaceVerificationArtifacts.ts";

export interface DevelopmentGitSnapshot {
  readonly sha: string;
  readonly branch: string;
  readonly commonDirectory: string;
  readonly clean: boolean;
  readonly fingerprint: string;
}
const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isDevelopmentError = Schema.is(WorkspaceDevelopmentError);

export class WorkspaceDevelopmentGit extends Context.Service<
  WorkspaceDevelopmentGit,
  {
    readonly inspect: (
      cwd: string,
    ) => Effect.Effect<DevelopmentGitSnapshot, WorkspaceDevelopmentError>;
    readonly git: (
      cwd: string,
      args: readonly string[],
    ) => Effect.Effect<string, WorkspaceDevelopmentError>;
    readonly fixedCheckout: (
      repository: string,
      sha: string,
    ) => Effect.Effect<string, WorkspaceDevelopmentError>;
    readonly verify: (
      cwd: string,
      commands: readonly DevelopmentVerificationCommand[],
      label: string,
      evidencePaths?: readonly string[],
    ) => Effect.Effect<
      {
        readonly passed: boolean;
        readonly artifacts: readonly DevelopmentVerificationArtifact[];
        readonly commands: readonly (DevelopmentVerificationCommand & {
          readonly exitCode: number | null;
          readonly timedOut: boolean;
          readonly logPath: string;
        })[];
      },
      WorkspaceDevelopmentError
    >;
    readonly releaseCheckout: (repository: string, checkout: string) => Effect.Effect<void>;
  }
>()("t3/orchestration/WorkspaceDevelopmentGit") {}

export const layer = Layer.effect(
  WorkspaceDevelopmentGit,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const directory = path.join(path.dirname(config.dbPath), "workspace-development");
    const failure = (cause: unknown) =>
      isDevelopmentError(cause)
        ? cause
        : new WorkspaceDevelopmentError({
            message: "Git 또는 검증 명령 실행에 실패했습니다.",
            cause,
          });
    const git = Effect.fn("WorkspaceDevelopmentGit.git")(function* (
      cwd: string,
      args: readonly string[],
    ) {
      const result = yield* runner.run({
        command: "git",
        background: true,
        args,
        cwd,
        timeout: "2 minutes",
        maxOutputBytes: 2_000_000,
      });
      if (result.code !== 0)
        return yield* new WorkspaceDevelopmentError({
          message: redactConversationRagSensitiveData(
            result.stderr || result.stdout || `git exited ${result.code}`,
          ).content.slice(-4_000),
        });
      return args.includes("-z") ? result.stdout : result.stdout.trim();
    }, Effect.mapError(failure));
    const inspect = Effect.fn("WorkspaceDevelopmentGit.inspect")(function* (cwd: string) {
      const sha = yield* git(cwd, ["rev-parse", "HEAD"]);
      const branch = yield* git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(
        Effect.orElseSucceed(() => ""),
      );
      const commonDirectory = yield* git(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      const status = yield* git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
      const diff = yield* git(cwd, ["diff", "--binary", "HEAD"]);
      const untracked = yield* git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
      const hash = NodeCrypto.createHash("sha256").update(`${sha}\n${status}\n${diff}`);
      for (const filename of untracked.split("\0").filter(Boolean)) {
        const content = yield* fs.readFile(path.join(cwd, filename));
        hash.update(filename).update(content);
      }
      return {
        sha,
        branch,
        commonDirectory,
        clean: status.length === 0,
        fingerprint: hash.digest("hex"),
      };
    }, Effect.mapError(failure));
    const fixedCheckout = Effect.fn("WorkspaceDevelopmentGit.fixedCheckout")(function* (
      repository: string,
      sha: string,
    ) {
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha))
        return yield* new WorkspaceDevelopmentError({
          message: "검증 대상은 정확한 커밋 SHA여야 합니다.",
        });
      const checkout = path.join(directory, "checkouts", NodeCrypto.randomUUID());
      yield* fs.makeDirectory(path.dirname(checkout), { recursive: true });
      yield* git(repository, ["worktree", "add", "--detach", checkout, sha]);
      return checkout;
    }, Effect.mapError(failure));
    const verify = Effect.fn("WorkspaceDevelopmentGit.verify")(function* (
      cwd: string,
      commands: readonly DevelopmentVerificationCommand[],
      label: string,
      evidencePaths: readonly string[] = [],
    ) {
      if (commands.length === 0)
        return yield* new WorkspaceDevelopmentError({
          message: "사용자가 승인한 검증 명령을 먼저 설정해야 합니다.",
        });
      const results: Array<
        DevelopmentVerificationCommand & {
          exitCode: number | null;
          timedOut: boolean;
          logPath: string;
        }
      > = [];
      for (const command of commands) {
        const result = yield* runner.run({
          ...command,
          background: true,
          cwd,
          timeout: "10 minutes",
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: 2_000_000,
          outputMode: "truncate",
        });
        const logPath = path.join(directory, "logs", `${label}-${results.length}.log`);
        yield* fs.makeDirectory(path.dirname(logPath), { recursive: true });
        yield* fs.writeFileString(
          logPath,
          redactConversationRagSensitiveData(
            [
              stringify({
                command: command.command,
                args: command.args,
                cwd,
                exitCode: result.code,
                timedOut: result.timedOut,
              }),
              result.stdout,
              result.stderr,
            ].join("\n"),
          ).content,
        );
        results.push({
          ...command,
          exitCode: result.code === null ? null : Number(result.code),
          timedOut: result.timedOut,
          logPath,
        });
        if (result.code !== 0 || result.timedOut) break;
      }
      const artifacts = yield* captureVerificationArtifacts(
        cwd,
        evidencePaths,
        path.join(directory, "evidence"),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      return {
        passed:
          results.length === commands.length &&
          results.every((result) => result.exitCode === 0 && !result.timedOut) &&
          artifacts.every((artifact) => artifact.error === null),
        commands: results,
        artifacts,
      };
    }, Effect.mapError(failure));
    const releaseCheckout = Effect.fn("WorkspaceDevelopmentGit.releaseCheckout")(function* (
      repository: string,
      checkout: string,
    ) {
      yield* git(repository, ["worktree", "remove", checkout]).pipe(
        Effect.catch((error) =>
          Effect.logWarning("검증 체크아웃을 보존합니다", { checkout, reason: error.message }),
        ),
      );
    });
    return WorkspaceDevelopmentGit.of({ git, inspect, fixedCheckout, verify, releaseCheckout });
  }),
);
