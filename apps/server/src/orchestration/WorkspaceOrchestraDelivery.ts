import type { WorkspaceCollaborationRun, WorkspaceOrchestraDelivery } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { WorkspaceDevelopmentGit } from "./WorkspaceDevelopmentGit.ts";

/** Verify the combined checkout and retain exact process receipts, never an AI verdict. */
export const checkOrchestraDelivery = Effect.fn("checkOrchestraDelivery")(function* (
  run: WorkspaceCollaborationRun,
  cwd: string,
  checkedAt: string,
) {
  const git = yield* WorkspaceDevelopmentGit;
  const platform = yield* HostProcessPlatform;
  const worktrees = [
    ...new Set(
      run.graph?.nodes.flatMap((node) => (node.worktreePath === null ? [] : [node.worktreePath])) ??
        [],
    ),
  ];
  const receipt = (
    status: WorkspaceOrchestraDelivery["status"],
    detail: string,
    fingerprint: string | null = null,
    commands: WorkspaceOrchestraDelivery["commands"] = [],
  ): WorkspaceOrchestraDelivery => ({
    status,
    detail,
    fingerprint,
    commands,
    worktrees,
    checkedAt,
  });
  const before = yield* git.inspect(cwd);
  for (const worktree of worktrees) {
    const snapshot = yield* git.inspect(worktree);
    if (snapshot.commonDirectory !== before.commonDirectory)
      return receipt(
        "failed",
        "작업 폴더가 프로젝트 저장소와 일치하지 않습니다.",
        before.fingerprint,
      );
    const integrated =
      snapshot.clean &&
      (yield* git.git(cwd, ["merge-base", "--is-ancestor", snapshot.sha, before.sha]).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ));
    if (!integrated)
      return receipt(
        "awaiting-integration",
        "분리된 작업 폴더에 반영되지 않은 변경이 있습니다. 변경을 통합한 뒤 다시 검증하세요.",
        before.fingerprint,
      );
  }
  const commands = run.orchestra?.verificationCommands ?? [];
  if (
    commands.length === 0 &&
    run.graph?.workspaceBaseline === before.fingerprint &&
    !run.graph.nodes.some((node) => ["implementation", "debug"].includes(node.kind))
  )
    return receipt(
      "passed",
      "조사·분석 작업이 완료되었으며 작업 폴더 변경이 없습니다.",
      before.fingerprint,
    );
  if (commands.length === 0)
    return receipt(
      "needs-verification",
      "코드 작업 결과를 검증할 명령을 입력하세요.",
      before.fingerprint,
    );
  if (commands.some((command) => /\b(?:powershell|pwsh)(?:\.exe)?\b|\.ps1\b/iu.test(command)))
    return receipt("failed", "PowerShell 검증 명령은 사용할 수 없습니다.", before.fingerprint);
  const result = yield* git.verify(
    cwd,
    commands.map((command) =>
      platform === "win32"
        ? { command: "cmd.exe", args: ["/d", "/s", "/c", command] }
        : { command: "/bin/sh", args: ["-c", command] },
    ),
    "orchestra-" + run.id + "-" + (yield* (yield* Crypto.Crypto).randomUUIDv4),
  );
  const receipts = result.commands.map((command, index) => ({
    command: commands[index]!,
    exitCode: command.exitCode,
    timedOut: command.timedOut,
    logPath: command.logPath,
  }));
  const after = yield* git.inspect(cwd);
  if (before.fingerprint !== after.fingerprint)
    return receipt(
      "failed",
      "검증 중 코드가 바뀌었습니다. 현재 변경을 다시 검증하세요.",
      after.fingerprint,
      receipts,
    );
  return receipt(
    result.passed ? "passed" : "failed",
    result.passed
      ? "통합된 작업 폴더에서 검증 명령을 통과했습니다."
      : "검증 명령이 실패했습니다. 종료 코드와 로그를 확인하세요.",
    after.fingerprint,
    receipts,
  );
});
