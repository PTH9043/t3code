import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Immutable authorization boundary issued when a Router/answering session
 * delegates work to a subordinate Worker (inspired by DSH Super-Agent Mandate).
 * Subsequent thread comments or external tool outputs cannot widen this scope.
 */
export const DelegateMandate = Schema.Struct({
  /** Allowed relative/absolute directory prefixes the worker may write under. Empty = workspace root only. */
  allowedPaths: Schema.Array(TrimmedNonEmptyString),
  /** Optional git branch prefix restriction (e.g. "t3/ticket-"). */
  allowedBranchPrefix: Schema.optionalKey(TrimmedNonEmptyString),
  /** Whether outbound network access is permitted inside this delegation. */
  allowNetwork: Schema.Boolean,
  /** Whether destructive git commands (push --force, reset --hard, branch -D) are permitted. */
  allowDestructiveGit: Schema.Boolean,
  /** Optional soft/hard token budget for this delegation. */
  maxBudgetTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type DelegateMandate = typeof DelegateMandate.Type;

export interface MandateCheckResult {
  readonly allowed: boolean;
  readonly violation?: string;
}

const DESTRUCTIVE_GIT_PATTERN =
  /\bgit\s+(?:push\s+(?:[^\n]*?(?:--force|-f|--force-with-lease))|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|checkout\s+--\s+\.)/iu;
const DANGEROUS_RM_PATTERN = /\b(?:rm\s+-[a-z]*r[a-z]*f|rmdir\s+\/s|del\s+\/[sfq])/iu;

function normalizeSlashes(raw: string): string {
  return raw.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

export function isPathWithinAllowedPrefixes(
  targetPath: string,
  allowedPrefixes: ReadonlyArray<string>,
  workspaceRoot?: string,
): boolean {
  const normalizedTarget = normalizeSlashes(targetPath);
  const prefixes =
    allowedPrefixes.length > 0 ? allowedPrefixes : workspaceRoot ? [workspaceRoot] : [];
  if (prefixes.length === 0) return true;
  return prefixes.some((prefix) => {
    const norm = normalizeSlashes(prefix);
    return normalizedTarget === norm || normalizedTarget.startsWith(`${norm}/`);
  });
}

/**
 * Validates a proposed file write or shell command against an immutable DelegateMandate.
 */
export function evaluateMandateAction(input: {
  readonly mandate: DelegateMandate;
  readonly workspaceRoot?: string;
  readonly targetPath?: string;
  readonly shellCommand?: string;
}): MandateCheckResult {
  if (input.targetPath) {
    if (
      !isPathWithinAllowedPrefixes(
        input.targetPath,
        input.mandate.allowedPaths,
        input.workspaceRoot,
      )
    ) {
      return {
        allowed: false,
        violation: `Mandate 경로 범위 이탈: '${input.targetPath}'은 허용 경로(${input.mandate.allowedPaths.join(", ") || input.workspaceRoot || "workspace"}) 밖입니다.`,
      };
    }
  }
  if (input.shellCommand) {
    if (!input.mandate.allowDestructiveGit && DESTRUCTIVE_GIT_PATTERN.test(input.shellCommand)) {
      return {
        allowed: false,
        violation: "Mandate 위반: 파괴적 git 명령은 사전 사용자 승인 없이 실행할 수 없습니다.",
      };
    }
    if (!input.mandate.allowDestructiveGit && DANGEROUS_RM_PATTERN.test(input.shellCommand)) {
      return {
        allowed: false,
        violation: "Mandate 위반: 재귀 강제 삭제 명령은 사전 사용자 승인 없이 실행할 수 없습니다.",
      };
    }
  }
  return { allowed: true };
}
