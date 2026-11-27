// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";

const execFileAsync = promisify(execFile);

/**
 * 제로 토큰(Zero-Token) 결정론적 리액터 게이트.
 *
 * 하트비트 상태 점검, git 변경 감지, 린트/테스트 exit_code 1차 검증 등
 * LLM이 판단할 필요 없는 루틴을 순수 Node.js/Effect 코드로 처리해 대기 토큰을 0으로 차단한다.
 */

export interface ZeroTokenWorkspacePulse {
  readonly llmCalled: false;
  readonly isGitRepo: boolean;
  readonly dirtyFiles: ReadonlyArray<string>;
  readonly dirtyFilesCount: number;
  readonly hasChanges: boolean;
  readonly summary: string;
}

export function evaluateWorkspacePulseZeroToken(
  cwd: string,
): Effect.Effect<ZeroTokenWorkspacePulse, never> {
  return Effect.tryPromise({
    try: async () => {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
        cwd,
        timeout: 4_000,
        windowsHide: true,
      });
      const dirtyFiles = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.slice(3).trim());
      return {
        llmCalled: false as const,
        isGitRepo: true,
        dirtyFiles,
        dirtyFilesCount: dirtyFiles.length,
        hasChanges: dirtyFiles.length > 0,
        summary:
          dirtyFiles.length === 0
            ? "변경 파일 0건 — Zero-Token 게이트가 LLM 호출을 생략했습니다."
            : `변경 파일 ${dirtyFiles.length}건 감지됨 (LLM 미호출 결정론적 점검).`,
      };
    },
    catch: () => ({
      llmCalled: false as const,
      isGitRepo: false,
      dirtyFiles: [] as ReadonlyArray<string>,
      dirtyFilesCount: 0,
      hasChanges: false,
      summary: "Git 저장소가 아니거나 상태 점검을 건너뛰었습니다 (LLM 미호출).",
    }),
  }).pipe(Effect.catch((fallback) => Effect.succeed(fallback)));
}

export interface DeterministicCommandVerdict {
  readonly llmCalled: false;
  readonly passed: boolean;
  readonly exitCode: number;
  readonly summaryLine: string;
  readonly matchedErrorCount: number;
}

const ERROR_LINE_PATTERN = /\b(?:error|fail|failed|exception|ts\d{4}|assertionerror)\b/i;

export function evaluateVerificationExitZeroToken(input: {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}): DeterministicCommandVerdict {
  if (input.exitCode === 0) {
    return {
      llmCalled: false,
      passed: true,
      exitCode: 0,
      summaryLine: `PASS (exit 0) · ${input.command}`,
      matchedErrorCount: 0,
    };
  }
  const combined = `${input.stderr}\n${input.stdout}`;
  const errorLines = combined.split(/\r?\n/).filter((line) => ERROR_LINE_PATTERN.test(line));
  return {
    llmCalled: false,
    passed: false,
    exitCode: input.exitCode,
    summaryLine: `FAIL (exit ${input.exitCode}, 오류 라인 ${errorLines.length}건) · ${input.command}`,
    matchedErrorCount: errorLines.length,
  };
}

/**
 * 위험 작업(파괴적 연산 / 외부 부수효과) 여부 결정론적 사전 분류기.
 * LLM 추론 없이 키워드·명령 패턴으로 Tier 2 결재 게이트 상신 여부를 판정한다.
 */
const DESTRUCTIVE_OP_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bdrop\s+(?:table|database|schema)\b/i,
  /\brm\s+-rf\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\s+\w+\s*(?:;|$)/i,
  /\bdeploy\s+prod(?:uction)?\b/i,
  /운영\s*(?:서버|DB|프로덕션).*(?:삭제|배포|초기화)/,
];

const EXTERNAL_SIDE_EFFECT_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:publish|release)\s+(?:npm|package|github)\b/i,
  /외부\s*(?:이메일|메일|웹훅|결제|송금)\s*(?:발송|전송|실행)/,
  /\bcurl\s+-X\s+(?:POST|PUT|DELETE)\s+https?:\/\/(?!127\.0\.0\.1|localhost)/i,
];

export function classifyGoalRiskZeroToken(text: string): {
  readonly llmCalled: false;
  readonly requiresTier2Approval: boolean;
  readonly triggerReason: "DESTRUCTIVE_OP" | "EXTERNAL_SIDE_EFFECT" | null;
  readonly matchedPattern: string | null;
} {
  for (const pattern of DESTRUCTIVE_OP_PATTERNS) {
    if (pattern.test(text)) {
      return {
        llmCalled: false,
        requiresTier2Approval: true,
        triggerReason: "DESTRUCTIVE_OP",
        matchedPattern: pattern.source,
      };
    }
  }
  for (const pattern of EXTERNAL_SIDE_EFFECT_PATTERNS) {
    if (pattern.test(text)) {
      return {
        llmCalled: false,
        requiresTier2Approval: true,
        triggerReason: "EXTERNAL_SIDE_EFFECT",
        matchedPattern: pattern.source,
      };
    }
  }
  return {
    llmCalled: false,
    requiresTier2Approval: false,
    triggerReason: null,
    matchedPattern: null,
  };
}
