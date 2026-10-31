import {
  WorkspaceAutomationError,
  WORKSPACE_EVIDENCE_MAX_BYTES,
  type ProjectId,
  type WorkspaceAutomationEvidenceInput,
  type WorkspaceAutomationOverview,
  type WorkspaceAutomationRow,
  type WorkspaceCollaborationRun,
  type WorkspaceDevelopmentState,
  type WorkspaceSchedule,
  type ThreadTokenUsageReport,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { redactConversationRagSensitiveData } from "./workspaceConversationRag.ts";
import {
  isEvidenceDescendant,
  readBoundedEvidenceBytes,
} from "./WorkspaceVerificationArtifacts.ts";

export const AUTOMATION_WINDOW = 50;
export const isWorkspaceAutomationError = Schema.is(WorkspaceAutomationError);
export function collaborationThread(run: WorkspaceCollaborationRun) {
  return (
    run.graph?.nodes.flatMap((node) => node.attempts).at(-1)?.threadId ??
    run.steps.findLast((step) => step.threadId !== null)?.threadId ??
    null
  );
}
function duration(start: string, end: string | null) {
  if (end === null) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Derive one bounded window from durable records, without interpreting model output. */
export function automationOverview(input: {
  projectId: ProjectId;
  generatedAt: string;
  runs: readonly WorkspaceCollaborationRun[];
  schedules: readonly WorkspaceSchedule[];
  development: WorkspaceDevelopmentState | null;
  usage?: ReadonlyMap<string, ThreadTokenUsageReport>;
}): WorkspaceAutomationOverview {
  const runs = input.runs.filter((run) => run.projectId === input.projectId);
  const development = input.development?.projectId === input.projectId ? input.development : null;
  const rows: WorkspaceAutomationRow[] = runs.map((run) => {
    const nodes = run.graph?.nodes ?? [];
    const receipts = nodes.flatMap((node) => (node.validation ? [node.validation] : []));
    const report = input.usage?.get(`run:${run.id}`);
    const sameWork = report?.work?.workId === `run:${run.id}`;
    const finishedAt = ["completed", "failed", "cancelled"].includes(run.status)
      ? run.updatedAt
      : null;
    return {
      id: `collaboration:${run.id}`,
      source: "collaboration",
      title: run.task.slice(0, 300),
      status: run.status,
      requestedAt: run.createdAt,
      finishedAt,
      durationMs: duration(run.createdAt, finishedAt),
      attempts: run.graph ? nodes.reduce((sum, node) => sum + node.attempts.length, 0) : null,
      retries: run.graph
        ? nodes.reduce((sum, node) => sum + Math.max(0, node.attempts.length - 1), 0)
        : null,
      verification: receipts.some((receipt) => receipt.verdict !== "pass")
        ? "reported-fail"
        : receipts.length > 0
          ? "reported-pass"
          : "unverified",
      measuredTokens: sameWork ? report.counts.total : null,
      tokenCoverage: sameWork ? report.coverage : "unavailable",
      threadId: collaborationThread(run),
      evidence: [],
    };
  });
  for (const task of development?.tasks ?? []) {
    const report = input.usage?.get(`development:${task.id}`);
    const workspace = development?.workspaces.find((item) => item.id === task.workspaceId);
    const verification = development?.verifications.findLast(
      (item) =>
        task.candidateSha !== null &&
        item.workspaceId === task.workspaceId &&
        item.candidateSha === task.candidateSha,
    );
    const current =
      verification &&
      workspace &&
      verification.generation === workspace.generation &&
      verification.requirementRevision === workspace.requirementRevision &&
      workspace.control === "managed" &&
      !workspace.summaryPending &&
      !workspace.externalUnmanaged;
    const verifiedStatus = !verification
      ? "unverified"
      : !current
        ? "stale"
        : verification.status !== "passed"
          ? verification.status
          : verification.artifacts?.some((artifact) => artifact.error !== null)
            ? "failed"
            : verification.commands.length === 0
              ? "unverified"
              : verification.commands.every(
                    (command) => command.exitCode === 0 && !command.timedOut,
                  )
                ? "passed"
                : "failed";
    const integration = development?.integrations.findLast(
      (item) => verification && item.verificationIds.includes(verification.id),
    );
    rows.push({
      id: `development:${task.id}`,
      source: "development",
      title: task.objective.slice(0, 300),
      status: task.status,
      requestedAt: task.requestedAt,
      finishedAt: task.completedAt,
      durationMs: duration(task.requestedAt, task.completedAt),
      attempts: task.delivery === "accepted" ? 1 : null,
      retries: null,
      verification: verifiedStatus,
      measuredTokens: report?.counts.total ?? null,
      tokenCoverage: report?.coverage ?? "unavailable",
      threadId: development?.conversationId ?? null,
      evidence: [
        ...(verification?.artifacts?.map((artifact, index) => ({
          kind: "verification-artifact" as const,
          recordId: verification.id,
          index,
          label: `${artifact.label}${artifact.error ? " · 보관 실패" : " · 검증 결과물"}`,
        })) ?? []),
        ...(verification?.commands.map((command, index) => ({
          kind: "verification-log" as const,
          recordId: verification.id,
          index,
          label: `${`${command.command} ${command.args.join(" ")}`.slice(0, 240)} · ${command.timedOut ? "시간 초과" : `종료 ${command.exitCode ?? "미확인"}`}`,
        })) ?? []),
        ...(integration?.logPaths.map((_path, index) => ({
          kind: "integration-log" as const,
          recordId: integration.id,
          index,
          label: `통합 검증 ${index + 1} · ${integration.status}`,
        })) ?? []),
        ...(integration?.artifacts?.map((artifact, index) => ({
          kind: "integration-artifact" as const,
          recordId: integration.id,
          index,
          label: `${artifact.label}${artifact.error ? " · 보관 실패" : " · 통합 결과물"}`,
        })) ?? []),
      ].slice(0, 16),
    });
  }
  const unique = new Map(rows.map((row) => [row.id, row]));
  const window = [...unique.values()]
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || a.id.localeCompare(b.id))
    .slice(0, AUTOMATION_WINDOW);
  const measured = window.filter((row) => row.measuredTokens !== null);
  const measuredTotal = measured.reduce((sum, row) => sum + (row.measuredTokens ?? 0), 0);
  const schedules = input.schedules.filter((schedule) => schedule.projectId === input.projectId);
  return {
    projectId: input.projectId,
    generatedAt: input.generatedAt,
    totalRows: unique.size,
    rows: window,
    totalSchedules: schedules.length,
    schedules: schedules.slice(0, 50).map((schedule) => ({
      id: schedule.id,
      title: schedule.title.slice(0, 300),
      enabled: schedule.enabled,
      nextTriggerAt: schedule.nextTriggerAt,
      lastError: schedule.lastError?.slice(0, 1_000) ?? null,
    })),
    metrics: {
      completed: window.filter((row) => row.status === "completed").length,
      failed: window.filter((row) => row.status === "failed").length,
      active: window.filter((row) => ["queued", "running", "cancel-requested"].includes(row.status))
        .length,
      verified: window.filter((row) => row.verification === "passed").length,
      retried: window.filter((row) => (row.retries ?? 0) > 0).length,
      firstAttemptCompleted: window.filter(
        (row) => row.status === "completed" && row.retries === 0 && (row.attempts ?? 0) > 0,
      ).length,
      knownAttemptRows: window.filter((row) => row.retries !== null).length,
      measuredTokens: measured.length && Number.isSafeInteger(measuredTotal) ? measuredTotal : null,
      measuredRows: measured.length,
    },
  };
}

/** Resolve recorded evidence owned by this project and bound each read before decoding. */
export const readAutomationEvidence = Effect.fn("readAutomationEvidence")(
  function* (
    state: WorkspaceDevelopmentState | null,
    input: WorkspaceAutomationEvidenceInput,
    dbPath: string,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (state?.projectId !== input.projectId) {
      return yield* new WorkspaceAutomationError({
        message: "이 프로젝트의 검증 기록을 찾을 수 없습니다.",
      });
    }
    if (input.kind === "verification-artifact" || input.kind === "integration-artifact") {
      const artifact =
        input.kind === "verification-artifact"
          ? state.verifications.find((item) => item.id === input.recordId)?.artifacts?.[input.index]
          : state.integrations.find((item) => item.id === input.recordId)?.artifacts?.[input.index];
      if (!artifact)
        return yield* new WorkspaceAutomationError({
          message: "이 실행에 등록된 결과물이 없습니다.",
        });
      if (artifact.error || !artifact.snapshotPath || !artifact.sha256 || !artifact.mediaType) {
        return yield* new WorkspaceAutomationError({
          message: artifact.error ?? "보관된 결과물을 찾을 수 없습니다.",
        });
      }
      const directory = yield* fs.realPath(
        path.join(path.dirname(dbPath), "workspace-development", "evidence"),
      );
      const canonical = yield* fs.realPath(artifact.snapshotPath);
      const relative = path.relative(directory, canonical);
      if (!isEvidenceDescendant(relative, path.sep, path.isAbsolute(relative))) {
        return yield* new WorkspaceAutomationError({
          message: "검증 결과물 저장 영역 밖의 파일은 열 수 없습니다.",
        });
      }
      const bytes = yield* readBoundedEvidenceBytes(canonical, WORKSPACE_EVIDENCE_MAX_BYTES);
      const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== artifact.sha256 || bytes.length !== artifact.byteLength) {
        return yield* new WorkspaceAutomationError({
          message: "보관된 결과물이 검증 당시 파일과 달라졌습니다.",
        });
      }
      const text = artifact.mediaType.startsWith("text/");
      return {
        label: artifact.label,
        contents: text
          ? redactConversationRagSensitiveData(new TextDecoder().decode(bytes)).content
          : Buffer.from(bytes).toString("base64"),
        byteLength: bytes.length,
        truncated: false,
        mediaType: artifact.mediaType,
        encoding: text ? ("utf8" as const) : ("base64" as const),
        sha256,
      };
    }
    const record =
      input.kind === "verification-log"
        ? state.verifications.find((item) => item.id === input.recordId)?.commands[input.index]
        : state.integrations.find((item) => item.id === input.recordId)?.logPaths[input.index];
    const logPath = typeof record === "string" ? record : record?.logPath;
    if (!logPath)
      return yield* new WorkspaceAutomationError({ message: "검증 로그 기록이 없습니다." });
    const directory = yield* fs.realPath(
      path.join(path.dirname(dbPath), "workspace-development", "logs"),
    );
    const canonical = yield* fs.realPath(logPath);
    const relative = path.relative(directory, canonical);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return yield* new WorkspaceAutomationError({
        message: "검증 로그 저장 영역 밖의 파일은 열 수 없습니다.",
      });
    }
    const stat = yield* fs.stat(canonical);
    const chunks = yield* fs
      .stream(canonical, { bytesToRead: 65_536, chunkSize: 16_384 })
      .pipe(Stream.runCollect);
    const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return {
      label: path.basename(canonical),
      contents: redactConversationRagSensitiveData(new TextDecoder().decode(bytes)).content,
      byteLength: Number(stat.size),
      truncated: Number(stat.size) > bytes.length,
    };
  },
  Effect.mapError((cause) =>
    isWorkspaceAutomationError(cause)
      ? cause
      : new WorkspaceAutomationError({ message: "검증 로그를 읽지 못했습니다.", cause }),
  ),
);
