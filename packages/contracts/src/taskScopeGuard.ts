import * as Schema from "effect/Schema";

export const TaskScopeGuardMode = Schema.Literals(["observing", "review", "change"]);
export type TaskScopeGuardMode = typeof TaskScopeGuardMode.Type;

export const TaskScopeGuardSpec = Schema.Struct({
  mode: TaskScopeGuardMode,
  armed: Schema.Boolean,
  allowedFiles: Schema.Array(Schema.String),
  allowHashArtifacts: Schema.Boolean,
  source: Schema.Literals(["default", "directive", "task_conditions"]),
});
export type TaskScopeGuardSpec = typeof TaskScopeGuardSpec.Type;

const DIRECTIVE_HEAD_PATTERN =
  /^\s*(?:\/stop-that-shit(?::stop-that-shit)?|\/guard)\s+(?:lock\s+)?(review|change)(?:\s+(.*))?$/i;

/**
 * Parses an optional first-line Stop-That-Shit guard directive:
 *   `/guard review -- ...`
 *   `/guard change files=src/a.ts|src/b.ts hash=allow -- ...`
 *   `/stop-that-shit review -- ...`
 * Defaults to `OBSERVING` (non-intrusive) unless explicitly armed by directive
 * or `taskConditionsMode === "inspect"`.
 */
export function parseTaskScopeGuardDirective(
  rawText: string,
  options?: { readonly taskConditionsMode?: "inspect" | "work" | null },
): { readonly spec: TaskScopeGuardSpec; readonly strippedText: string } {
  const lines = rawText.split(/\r?\n/);
  const firstLine = lines[0] ?? "";
  const separatorMatch = firstLine.match(/\s+--(?:\s+|$)/);
  const headPart =
    separatorMatch && separatorMatch.index !== undefined
      ? firstLine.slice(0, separatorMatch.index)
      : firstLine;
  const inlineTail =
    separatorMatch && separatorMatch.index !== undefined
      ? firstLine.slice(separatorMatch.index + separatorMatch[0].length).trim()
      : "";
  const match = headPart.match(DIRECTIVE_HEAD_PATTERN);

  if (match) {
    const mode = match[1]!.toLowerCase() as "review" | "change";
    const flagsRaw = (match[2] ?? "").trim();

    let allowedFiles: string[] = [];
    let allowHashArtifacts = false;

    for (const token of flagsRaw.split(/\s+/).filter(Boolean)) {
      if (token.toLowerCase().startsWith("files=")) {
        allowedFiles = token
          .slice(6)
          .split(/[|,]/)
          .map((f) => f.trim().replaceAll("\\", "/"))
          .filter(Boolean);
      } else if (token.toLowerCase() === "hash=allow") {
        allowHashArtifacts = true;
      }
    }

    const restLines = lines.slice(1).join("\n").trim();
    const strippedText = [inlineTail, restLines].filter(Boolean).join("\n").trim() || rawText;

    return {
      spec: {
        mode,
        armed: true,
        allowedFiles,
        allowHashArtifacts,
        source: "directive",
      },
      strippedText,
    };
  }

  if (options?.taskConditionsMode === "inspect") {
    return {
      spec: {
        mode: "review",
        armed: true,
        allowedFiles: [],
        allowHashArtifacts: false,
        source: "task_conditions",
      },
      strippedText: rawText,
    };
  }

  return {
    spec: {
      mode: "observing",
      armed: false,
      allowedFiles: [],
      allowHashArtifacts: false,
      source: "default",
    },
    strippedText: rawText,
  };
}

function normalizePath(p: string): string {
  return p.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase().trim();
}

/** Checks whether modifying `filePath` is permitted under an armed TaskScopeGuard. */
export function isFileMutationAllowedByScopeGuard(
  spec: TaskScopeGuardSpec,
  filePath: string,
): { readonly allowed: boolean; readonly reason?: string } {
  if (!spec.armed || spec.mode === "observing") return { allowed: true };
  if (spec.mode === "review") {
    return {
      allowed: false,
      reason: `ScopeGuard(ARMED:review) blocks file modification on '${filePath}'.`,
    };
  }
  const norm = normalizePath(filePath);
  if (!spec.allowHashArtifacts && /\.(?:sha256|sha512|md5|checksum)$/i.test(norm)) {
    return {
      allowed: false,
      reason: `ScopeGuard(ARMED:change) blocks unrequested checksum artifact '${filePath}' (pass hash=allow if required).`,
    };
  }
  if (spec.allowedFiles.length > 0) {
    const matched = spec.allowedFiles.some((allowed) => {
      const a = normalizePath(allowed);
      return norm === a || norm.endsWith(`/${a}`);
    });
    if (!matched) {
      return {
        allowed: false,
        reason: `ScopeGuard(ARMED:change) restricts edits to [${spec.allowedFiles.join(", ")}]; '${filePath}' is outside scope.`,
      };
    }
  }
  return { allowed: true };
}

/** Builds a compact prompt block injected only when the guard is ARMED. */
export function buildTaskScopeGuardPrompt(spec: TaskScopeGuardSpec): string | undefined {
  if (!spec.armed || spec.mode === "observing") return undefined;
  if (spec.mode === "review") {
    return [
      `<t3_scope_guard state="ARMED" mode="review">`,
      "1. [Intent Lock] 읽기 전용 리뷰/조사 모드입니다. 어떤 프로젝트 파일도 수정·생성·삭제하지 마세요.",
      "2. [No Thrashing] 이미 확인한 파일이나 통과한 검사를 새 근거 없이 반복하지 말고 핵심 문제·근거·수정 제안만 보고하세요.",
      `</t3_scope_guard>`,
    ].join("\n");
  }
  const filesClause =
    spec.allowedFiles.length > 0
      ? `허용 수정 파일 범위: ${spec.allowedFiles.join(", ")} (범위 밖 리팩터링 금지).`
      : "요청된 변경 범위만 최소한으로 수정하고 인접 모듈 리팩터링(Scope creep)을 금지합니다.";
  const hashClause = spec.allowHashArtifacts
    ? "요청된 체크섬/해시 산출물 생성이 허용됩니다."
    : "요청 없는 체크섬 파일(.sha256/.md5)이나 추측성 호환 래퍼(Hashing/hypothetical hardening)를 추가하지 마세요.";
  return [
    `<t3_scope_guard state="ARMED" mode="change">`,
    `1. [Scope Lock] ${filesClause}`,
    `2. [Anti-SHIT] ${hashClause}`,
    "3. [Mandatory Completion Exception] 단, 변경으로 직접 영향받는 기존 배포 데이터 마이그레이션·호출부(reader/writer) 갱신·회귀 테스트는 diff가 커져도 끝까지 완수하세요.",
    "4. [Stop When Verified] 최종 상태에 유효한 검증을 통과하고 범위 내 블로커가 없으면 추가 재확인 루프(Task thrashing) 없이 즉시 종료하세요.",
    `</t3_scope_guard>`,
  ].join("\n");
}
