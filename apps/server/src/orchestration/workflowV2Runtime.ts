// @effect-diagnostics-next-line nodeBuiltinImport:off - Explicit windowsHide & direct execFile without shell are required for deterministic Windows verifiers.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Synchronous contained disk existence checks for deterministic verifiers.
import * as NodeFs from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Contained path resolution for path-traversal guards.
import * as NodePath from "node:path";
import {
  WorkflowGraphV2,
  type BudgetPolicy,
  type CapabilityProfile,
  type DeterministicVerifierNodeV2,
  type GitDiffGuardVerifierSpec,
  type HumanGateNodeV2,
  type HumanResolutionAction,
  type LegacyWorkflowAgent,
  type LoopExhaustedAction,
  type LoopSpecV2,
  type MapFanOutNodeV2,
  type ModelRoutingRequirements,
  type PrivacyTier,
  type ProviderFamily,
  type ReconcileWorktreesNodeV2,
  type RouterNodeV2,
  type SchemaAssertVerifierSpec,
  type StructuredReportVerifierSpec,
  type VerifierSpec,
  type WorkflowValues,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeUnknownJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// ============================================================================
// 1. Safe Sandboxed Expression & Template Evaluator (No eval / No Function)
// ============================================================================

export interface WorkflowNodeRuntimeOutput {
  readonly status?: string;
  readonly output?: unknown;
  readonly rawOutput?: string;
}

export interface WorkflowEvaluationContext {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly nodes: Readonly<Record<string, WorkflowNodeRuntimeOutput>>;
  readonly locals?: Readonly<Record<string, unknown>>;
}

const TEMPLATE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

function readPathSegment(target: unknown, segment: string): unknown {
  if (target === null || target === undefined) return undefined;
  if (Array.isArray(target)) {
    if (segment === "length") return target.length;
    const index = Number(segment);
    if (Number.isInteger(index) && index >= 0 && index < target.length) {
      return target[index];
    }
    return undefined;
  }
  if (typeof target === "object") {
    if (segment === "__proto__" || segment === "constructor" || segment === "prototype") {
      return undefined;
    }
    return (target as Record<string, unknown>)[segment];
  }
  return undefined;
}

function resolveDotPath(rawPath: string, ctx: WorkflowEvaluationContext): unknown {
  const normalized = rawPath.trim().replace(/^\$\./, "");
  if (normalized.length === 0) return undefined;
  const segments = normalized
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return undefined;

  const root = segments[0]!;
  let current: unknown;
  if (root === "inputs") {
    current = ctx.inputs;
  } else if (root === "nodes") {
    current = ctx.nodes;
  } else if (ctx.locals && root in ctx.locals) {
    current = ctx.locals[root];
    segments.shift();
    for (const seg of segments) {
      current = readPathSegment(current, seg);
    }
    return current;
  } else if (root in ctx.inputs) {
    current = ctx.inputs[root];
    segments.shift();
    for (const seg of segments) {
      current = readPathSegment(current, seg);
    }
    return current;
  } else {
    return undefined;
  }

  for (let i = 1; i < segments.length; i += 1) {
    current = readPathSegment(current, segments[i]!);
  }
  return current;
}

function parseLiteralOrPath(rawToken: string, ctx: WorkflowEvaluationContext): unknown {
  const token = rawToken.trim();
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "null") return null;
  if (token === "undefined") return undefined;
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  if (/^-?\d+(?:\.\d+)?$/.test(token)) {
    return Number(token);
  }
  if (token.startsWith("{{") && token.endsWith("}}")) {
    return resolveDotPath(token.slice(2, -2), ctx);
  }
  return resolveDotPath(token, ctx);
}

export function resolveWorkflowExpression(
  expression: string,
  ctx: WorkflowEvaluationContext,
): unknown {
  return parseLiteralOrPath(expression, ctx);
}

export function interpolateWorkflowTemplate(
  template: string,
  ctx: WorkflowEvaluationContext,
): string {
  return template.replace(TEMPLATE_PATTERN, (match, expr: string) => {
    const value = resolveDotPath(expr, ctx);
    if (value === undefined) return match;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return encodeUnknownJson(value);
  });
}

function splitTopLevelOperator(expr: string, operator: "&&" | "||"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i]!;
    if (quote !== null) {
      if (ch === quote && expr[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && expr.slice(i, i + operator.length) === operator) {
      parts.push(expr.slice(start, i));
      i += operator.length - 1;
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

function stripOuterParens(expr: string): string {
  let trimmed = expr.trim();
  while (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    let depth = 0;
    let wrapsWhole = true;
    for (let i = 0; i < trimmed.length - 1; i += 1) {
      if (trimmed[i] === "(") depth += 1;
      else if (trimmed[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          wrapsWhole = false;
          break;
        }
      }
    }
    if (!wrapsWhole) break;
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function evaluateWorkflowCondition(
  expression: string,
  ctx: WorkflowEvaluationContext,
): boolean {
  const expr = stripOuterParens(expression);
  if (expr.length === 0) return false;

  const orParts = splitTopLevelOperator(expr, "||");
  if (orParts.length > 1) {
    return orParts.some((part) => evaluateWorkflowCondition(part, ctx));
  }

  const andParts = splitTopLevelOperator(expr, "&&");
  if (andParts.length > 1) {
    return andParts.every((part) => evaluateWorkflowCondition(part, ctx));
  }

  if (expr.startsWith("!")) {
    return !evaluateWorkflowCondition(expr.slice(1), ctx);
  }

  const comparatorMatch = expr.match(/^(.+?)\s*(===|!==|==|!=|>=|<=|>|<|contains)\s*(.+)$/);
  if (comparatorMatch) {
    const left = parseLiteralOrPath(comparatorMatch[1]!, ctx);
    const op = comparatorMatch[2]!;
    const right = parseLiteralOrPath(comparatorMatch[3]!, ctx);
    switch (op) {
      case "===":
      case "==":
        return left === right;
      case "!==":
      case "!=":
        return left !== right;
      case ">":
        return typeof left === "number" && typeof right === "number" && left > right;
      case ">=":
        return typeof left === "number" && typeof right === "number" && left >= right;
      case "<":
        return typeof left === "number" && typeof right === "number" && left < right;
      case "<=":
        return typeof left === "number" && typeof right === "number" && left <= right;
      case "contains":
        if (typeof left === "string" && typeof right === "string") return left.includes(right);
        if (Array.isArray(left)) return left.includes(right);
        return false;
    }
  }

  return Boolean(parseLiteralOrPath(expr, ctx));
}

// ============================================================================
// 2. Deterministic Verifier Runners
// ============================================================================

export interface VerifierFailureEntry {
  readonly file?: string;
  readonly line?: number;
  readonly rule?: string;
  readonly message: string;
}

export interface VerifierExecutionResult {
  readonly verifierType: VerifierSpec["type"];
  readonly passed: boolean;
  readonly exitCode: number;
  readonly summary: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly failures: ReadonlyArray<VerifierFailureEntry>;
  readonly details?: Readonly<Record<string, unknown>>;
}

function resolveContainedPath(rootCwd: string, relativePath: string): string | null {
  const resolvedRoot = NodePath.resolve(rootCwd);
  const resolvedTarget = NodePath.resolve(resolvedRoot, relativePath);
  const rel = NodePath.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith("..") || NodePath.isAbsolute(rel)) {
    return null;
  }
  return resolvedTarget;
}

function buildFilteredEnv(allowlist?: ReadonlyArray<string>): NodeJS.ProcessEnv {
  if (!allowlist || allowlist.length === 0) {
    return { ...process.env };
  }
  const allowed = new Set(allowlist.map((entry) => entry.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toUpperCase())) {
      env[key] = value;
    }
  }
  return env;
}

interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function execFileDirect(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
}): Effect.Effect<ExecResult> {
  return Effect.callback<ExecResult>((resume) => {
    const child = NodeChildProcess.execFile(
      input.command,
      [...input.args],
      {
        cwd: input.cwd,
        timeout: input.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        ...(input.env !== undefined ? { env: input.env } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resume(
            Effect.succeed({
              exitCode: 0,
              stdout: String(stdout),
              stderr: String(stderr),
              timedOut: false,
            }),
          );
          return;
        }
        const errRecord = error as NodeJS.ErrnoException & {
          code?: number | string;
          killed?: boolean;
          signal?: string;
        };
        const timedOut = Boolean(errRecord.killed && errRecord.signal === "SIGTERM");
        const exitCode = typeof errRecord.code === "number" ? errRecord.code : timedOut ? 124 : 1;
        resume(
          Effect.succeed({
            exitCode,
            stdout: String(stdout),
            stderr: String(stderr || error.message),
            timedOut,
          }),
        );
      },
    );
    return Effect.sync(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    });
  });
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/");
  let regex = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        regex += ".*";
        i += 1;
        if (normalized[i + 1] === "/") i += 1;
      } else {
        regex += "[^/]*";
      }
    } else if (ch === "?") {
      regex += "[^/]";
    } else if ("+.^$|()[]{}".includes(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
  }
  regex += "$";
  return new RegExp(regex, "i");
}

function matchesAnyGlob(filePath: string, globs: ReadonlyArray<string>): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

const SECRET_PATTERNS: ReadonlyArray<{ readonly rule: string; readonly regex: RegExp }> = [
  { rule: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "github-token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { rule: "github-pat", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { rule: "openai-key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/ },
  { rule: "anthropic-key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { rule: "private-key-header", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

export function parseStructuredReportFailures(
  format: StructuredReportVerifierSpec["reportFormat"],
  rawText: string,
  maxExtractedFailures: number,
): ReadonlyArray<VerifierFailureEntry> {
  const failures: VerifierFailureEntry[] = [];
  const push = (entry: VerifierFailureEntry) => {
    if (failures.length < maxExtractedFailures) {
      failures.push(entry);
    }
  };

  if (format === "tsc_diagnostics") {
    const lines = rawText.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^(.+?)\((\d+),\d+\):\s*error\s+(TS\d+):\s*(.+)$/);
      if (match) {
        push({
          file: match[1]!.trim(),
          line: Number(match[2]!),
          rule: match[3]!,
          message: match[4]!.trim(),
        });
      }
    }
    return failures;
  }

  if (format === "junit_xml") {
    const failureTagRegex = /<failure\b([^>]*)>([\s\S]*?)<\/failure>/gi;
    let match = failureTagRegex.exec(rawText);
    while (match !== null && failures.length < maxExtractedFailures) {
      const attrs = match[1] ?? "";
      const messageAttr = attrs.match(/message="([^"]*)"/i)?.[1];
      const body = (match[2] ?? "").trim();
      push({
        message: messageAttr || body.slice(0, 300) || "JUnit test failure",
      });
      match = failureTagRegex.exec(rawText);
    }
    return failures;
  }

  const decoded = decodeUnknownJsonOption(rawText);
  if (Option.isNone(decoded)) {
    return failures;
  }
  const parsed: unknown = decoded.value;

  if (format === "vitest_json" && parsed && typeof parsed === "object") {
    const testResults = (parsed as { testResults?: unknown[] }).testResults;
    if (Array.isArray(testResults)) {
      for (const suite of testResults) {
        if (!suite || typeof suite !== "object") continue;
        const suiteRecord = suite as {
          name?: string;
          assertionResults?: ReadonlyArray<{
            status?: string;
            fullName?: string;
            title?: string;
            failureMessages?: ReadonlyArray<string>;
          }>;
        };
        for (const testCase of suiteRecord.assertionResults ?? []) {
          if (testCase.status === "failed") {
            push({
              ...(suiteRecord.name ? { file: suiteRecord.name } : {}),
              message: `${testCase.fullName ?? testCase.title ?? "failed test"}: ${(testCase.failureMessages?.[0] ?? "assertion failed").slice(0, 300)}`,
            });
          }
        }
      }
    }
    return failures;
  }

  if (format === "eslint_json" && Array.isArray(parsed)) {
    for (const fileEntry of parsed) {
      if (!fileEntry || typeof fileEntry !== "object") continue;
      const record = fileEntry as {
        filePath?: string;
        messages?: ReadonlyArray<{
          severity?: number;
          line?: number;
          ruleId?: string | null;
          message?: string;
        }>;
      };
      for (const msg of record.messages ?? []) {
        if ((msg.severity ?? 0) >= 2) {
          push({
            ...(record.filePath ? { file: record.filePath } : {}),
            ...(typeof msg.line === "number" ? { line: msg.line } : {}),
            ...(msg.ruleId ? { rule: msg.ruleId } : {}),
            message: msg.message ?? "ESLint error",
          });
        }
      }
    }
    return failures;
  }

  if (format === "sarif" && parsed && typeof parsed === "object") {
    const runs = (parsed as { runs?: ReadonlyArray<{ results?: ReadonlyArray<unknown> }> }).runs;
    for (const run of runs ?? []) {
      for (const res of run.results ?? []) {
        if (!res || typeof res !== "object") continue;
        const entry = res as {
          level?: string;
          ruleId?: string;
          message?: { text?: string };
          locations?: ReadonlyArray<{
            physicalLocation?: {
              artifactLocation?: { uri?: string };
              region?: { startLine?: number };
            };
          }>;
        };
        if (entry.level === "error" || entry.level === undefined) {
          const loc = entry.locations?.[0]?.physicalLocation;
          push({
            ...(loc?.artifactLocation?.uri ? { file: loc.artifactLocation.uri } : {}),
            ...(typeof loc?.region?.startLine === "number" ? { line: loc.region.startLine } : {}),
            ...(entry.ruleId ? { rule: entry.ruleId } : {}),
            message: entry.message?.text ?? "SARIF error",
          });
        }
      }
    }
  }

  return failures;
}

function readJsonPointer(target: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return target;
  const parts = pointer
    .replace(/^\//, "")
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current = target;
  for (const part of parts) {
    current = readPathSegment(current, part);
  }
  return current;
}

function validateSimpleJsonSchema(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path = "$",
): VerifierFailureEntry[] {
  const failures: VerifierFailureEntry[] = [];
  const expectedType = schema.type;
  if (typeof expectedType === "string") {
    const matches =
      (expectedType === "object" &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)) ||
      (expectedType === "array" && Array.isArray(value)) ||
      (expectedType === "string" && typeof value === "string") ||
      (expectedType === "number" && typeof value === "number" && Number.isFinite(value)) ||
      (expectedType === "integer" && typeof value === "number" && Number.isInteger(value)) ||
      (expectedType === "boolean" && typeof value === "boolean") ||
      (expectedType === "null" && value === null);
    if (!matches) {
      failures.push({ message: `${path}: expected type "${expectedType}".` });
      return failures;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    failures.push({ message: `${path}: value is not in allowed enum.` });
  }

  if (typeof value === "string" && typeof schema.minLength === "number") {
    if (value.length < schema.minLength) {
      failures.push({ message: `${path}: string length < ${schema.minLength}.` });
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      failures.push({ message: `${path}: number < ${schema.minimum}.` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      failures.push({ message: `${path}: number > ${schema.maximum}.` });
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (typeof reqKey === "string" && !(reqKey in record)) {
          failures.push({ message: `${path}.${reqKey}: required property is missing.` });
        }
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const [propKey, propSchema] of Object.entries(
        schema.properties as Record<string, unknown>,
      )) {
        if (
          propKey in record &&
          propSchema &&
          typeof propSchema === "object" &&
          !Array.isArray(propSchema)
        ) {
          failures.push(
            ...validateSimpleJsonSchema(
              record[propKey],
              propSchema as Record<string, unknown>,
              `${path}.${propKey}`,
            ),
          );
        }
      }
    }
  }

  if (
    Array.isArray(value) &&
    schema.items &&
    typeof schema.items === "object" &&
    !Array.isArray(schema.items)
  ) {
    for (let i = 0; i < value.length; i += 1) {
      failures.push(
        ...validateSimpleJsonSchema(
          value[i],
          schema.items as Record<string, unknown>,
          `${path}[${i}]`,
        ),
      );
    }
  }

  return failures;
}

export function runDeterministicVerifier(
  spec: VerifierSpec,
  options: {
    readonly cwd: string;
    readonly context: WorkflowEvaluationContext;
  },
): Effect.Effect<VerifierExecutionResult> {
  return Effect.gen(function* () {
    switch (spec.type) {
      case "command_exit": {
        const targetCwd =
          spec.cwdRelative !== undefined
            ? resolveContainedPath(options.cwd, spec.cwdRelative)
            : NodePath.resolve(options.cwd);
        if (targetCwd === null) {
          return {
            verifierType: "command_exit",
            passed: false,
            exitCode: 1,
            summary: `cwdRelative "${spec.cwdRelative}"가 워크스페이스 범위를 벗어납니다.`,
            stdout: "",
            stderr: "Path traversal blocked.",
            failures: [{ message: "cwdRelative path escapes workspace root." }],
          };
        }
        const result = yield* execFileDirect({
          command: spec.command,
          args: spec.args,
          cwd: targetCwd,
          timeoutMs: spec.timeoutMs,
          env: buildFilteredEnv(spec.envAllowlist),
        });
        const expected = spec.expectedExitCodes ?? [0];
        const passed = !result.timedOut && expected.includes(result.exitCode);
        return {
          verifierType: "command_exit",
          passed,
          exitCode: result.exitCode,
          summary: passed
            ? `명령 검증 통과 (exitCode=${result.exitCode})`
            : result.timedOut
              ? `명령 검증 시간 초과 (${spec.timeoutMs}ms)`
              : `명령 검증 실패 (exitCode=${result.exitCode}, expected=${expected.join(",")})`,
          stdout: result.stdout.slice(0, 16_000),
          stderr: result.stderr.slice(0, 16_000),
          failures: passed
            ? []
            : [
                {
                  message:
                    result.stderr.trim().slice(0, 400) ||
                    `Command exited with code ${result.exitCode}`,
                },
              ],
        };
      }

      case "structured_report": {
        const result = yield* execFileDirect({
          command: spec.command,
          args: spec.args,
          cwd: NodePath.resolve(options.cwd),
          timeoutMs: spec.timeoutMs,
        });
        let reportText = result.stdout;
        if (spec.reportFilePath !== undefined) {
          const resolvedReport = resolveContainedPath(options.cwd, spec.reportFilePath);
          if (resolvedReport && NodeFs.existsSync(resolvedReport)) {
            reportText = NodeFs.readFileSync(resolvedReport, "utf8");
          }
        } else if (!reportText.trim() && result.stderr.trim()) {
          reportText = result.stderr;
        }
        const failures = parseStructuredReportFailures(
          spec.reportFormat,
          reportText,
          spec.maxExtractedFailures,
        );
        const passed = !result.timedOut && result.exitCode === 0 && failures.length === 0;
        return {
          verifierType: "structured_report",
          passed,
          exitCode: result.exitCode,
          summary: passed
            ? `구조화 리포트(${spec.reportFormat}) 검증 통과`
            : `구조화 리포트(${spec.reportFormat}) 실패: ${failures.length}건 (exitCode=${result.exitCode})`,
          stdout: result.stdout.slice(0, 16_000),
          stderr: result.stderr.slice(0, 16_000),
          failures,
        };
      }

      case "git_diff_guard": {
        return yield* runGitDiffGuard(spec, options.cwd);
      }

      case "schema_assert": {
        return runSchemaAssert(spec, options.cwd, options.context);
      }
    }
  });
}

function runGitDiffGuard(
  spec: GitDiffGuardVerifierSpec,
  cwd: string,
): Effect.Effect<VerifierExecutionResult> {
  return Effect.gen(function* () {
    const resolvedCwd = NodePath.resolve(cwd);
    const numstat = yield* execFileDirect({
      command: "git",
      args: ["diff", "--numstat", "HEAD"],
      cwd: resolvedCwd,
      timeoutMs: 15_000,
    });
    const status = yield* execFileDirect({
      command: "git",
      args: ["status", "--porcelain"],
      cwd: resolvedCwd,
      timeoutMs: 15_000,
    });

    const changedFiles = new Set<string>();
    let addedLines = 0;
    let deletedLines = 0;

    for (const line of numstat.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\t/);
      if (parts.length >= 3) {
        const add = Number(parts[0]);
        const del = Number(parts[1]);
        if (Number.isFinite(add)) addedLines += add;
        if (Number.isFinite(del)) deletedLines += del;
        changedFiles.add(parts[2]!.trim());
      }
    }

    for (const line of status.stdout.split(/\r?\n/)) {
      if (line.length < 4) continue;
      const rawPath = line.slice(3).trim();
      const target = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
      if (target) changedFiles.add(target.replace(/^"|"$/g, ""));
    }

    const failures: VerifierFailureEntry[] = [];
    const fileList = [...changedFiles];

    for (const file of fileList) {
      if (spec.forbiddenPathGlobs.length > 0 && matchesAnyGlob(file, spec.forbiddenPathGlobs)) {
        failures.push({ file, rule: "forbidden-path", message: `금지된 경로 변경: ${file}` });
      }
      if (
        spec.allowedPathGlobs !== undefined &&
        spec.allowedPathGlobs.length > 0 &&
        !matchesAnyGlob(file, spec.allowedPathGlobs)
      ) {
        failures.push({
          file,
          rule: "outside-allowed-paths",
          message: `허용 경로 외부 파일 변경: ${file}`,
        });
      }
    }

    if (spec.maxChangedFiles !== undefined && fileList.length > spec.maxChangedFiles) {
      failures.push({
        rule: "max-changed-files",
        message: `변경 파일 수(${fileList.length})가 상한(${spec.maxChangedFiles})을 초과했습니다.`,
      });
    }

    const totalTouched = addedLines + deletedLines;
    const deletedRatio = totalTouched > 0 ? deletedLines / totalTouched : 0;
    if (
      spec.maxDeletedLinesRatio !== undefined &&
      totalTouched > 0 &&
      deletedRatio > spec.maxDeletedLinesRatio
    ) {
      failures.push({
        rule: "max-deleted-lines-ratio",
        message: `삭제 라인 비율(${deletedRatio.toFixed(2)})이 상한(${spec.maxDeletedLinesRatio})을 초과했습니다.`,
      });
    }

    if (spec.blockPotentialSecrets) {
      const diff = yield* execFileDirect({
        command: "git",
        args: ["diff", "-U0", "HEAD"],
        cwd: resolvedCwd,
        timeoutMs: 15_000,
      });
      let currentFile = "";
      for (const line of diff.stdout.split(/\r?\n/)) {
        if (line.startsWith("+++ b/")) {
          currentFile = line.slice(6);
          continue;
        }
        if (!line.startsWith("+") || line.startsWith("+++")) continue;
        const addedContent = line.slice(1);
        for (const pattern of SECRET_PATTERNS) {
          if (pattern.regex.test(addedContent)) {
            failures.push({
              ...(currentFile ? { file: currentFile } : {}),
              rule: `secret:${pattern.rule}`,
              message: `잠재적 비밀키 패턴(${pattern.rule})이 추가된 변경에서 감지되었습니다.`,
            });
            break;
          }
        }
      }
    }

    const passed = failures.length === 0;
    return {
      verifierType: "git_diff_guard",
      passed,
      exitCode: passed ? 0 : 1,
      summary: passed
        ? `Git Diff 가드 통과 (변경 파일 ${fileList.length}개)`
        : `Git Diff 가드 위반 ${failures.length}건`,
      stdout: "",
      stderr: "",
      failures,
      details: {
        changedFiles: fileList,
        addedLines,
        deletedLines,
        deletedRatio,
      },
    };
  });
}

function runSchemaAssert(
  spec: SchemaAssertVerifierSpec,
  cwd: string,
  context: WorkflowEvaluationContext,
): VerifierExecutionResult {
  const target = resolveWorkflowExpression(spec.targetExpression, context);
  const failures = validateSimpleJsonSchema(target, spec.jsonSchema);

  if (spec.verifyDiskPathsAtPointer !== undefined && failures.length === 0) {
    const pointerValue = readJsonPointer(target, spec.verifyDiskPathsAtPointer);
    const paths = Array.isArray(pointerValue)
      ? pointerValue.filter((entry): entry is string => typeof entry === "string")
      : typeof pointerValue === "string"
        ? [pointerValue]
        : null;
    if (paths === null) {
      failures.push({
        rule: "disk-path-pointer",
        message: `JSON Pointer "${spec.verifyDiskPathsAtPointer}"에서 파일 경로를 찾지 못했습니다.`,
      });
    } else {
      for (const rawPath of paths) {
        const resolved = resolveContainedPath(cwd, rawPath);
        if (resolved === null) {
          failures.push({
            file: rawPath,
            rule: "path-traversal",
            message: `워크스페이스 외부 경로 참조 차단: ${rawPath}`,
          });
        } else if (!NodeFs.existsSync(resolved)) {
          failures.push({
            file: rawPath,
            rule: "missing-disk-path",
            message: `디스크에 존재하지 않는 경로: ${rawPath}`,
          });
        }
      }
    }
  }

  const passed = failures.length === 0;
  return {
    verifierType: "schema_assert",
    passed,
    exitCode: passed ? 0 : 1,
    summary: passed
      ? `스키마 검증 통과 (${spec.targetExpression})`
      : `스키마 검증 실패: ${failures.length}건`,
    stdout: "",
    stderr: "",
    failures,
  };
}

// ============================================================================
// 3. Router, Bounded Loop, Human Gate, MapFanOut, Worktree Reconcile, Routing
// ============================================================================

export interface RouterEvaluationResult {
  readonly nodeId: string;
  readonly selectedRouteKey: string;
  readonly matchedByDefault: boolean;
  readonly activeEdgeIds: ReadonlyArray<string>;
  readonly skippedEdgeIds: ReadonlyArray<string>;
  readonly activeTargetNodeIds: ReadonlyArray<string>;
  readonly skippedTargetNodeIds: ReadonlyArray<string>;
}

export function evaluateRouterNode(
  node: RouterNodeV2,
  graph: Pick<WorkflowGraphV2, "edges">,
  context: WorkflowEvaluationContext,
): RouterEvaluationResult {
  let selectedRouteKey = node.defaultRouteKey;
  let matchedByDefault = true;

  if (node.mode === "deterministic_rules") {
    for (const route of node.routes) {
      if (route.conditionExpr && evaluateWorkflowCondition(route.conditionExpr, context)) {
        selectedRouteKey = route.routeKey;
        matchedByDefault = false;
        break;
      }
    }
  }

  const outgoingRouteEdges = graph.edges.filter(
    (edge) => edge.from === node.id && edge.kind === "route_match",
  );
  const activeEdges = outgoingRouteEdges.filter((edge) => edge.routeKey === selectedRouteKey);
  const skippedEdges = outgoingRouteEdges.filter((edge) => edge.routeKey !== selectedRouteKey);

  return {
    nodeId: node.id,
    selectedRouteKey,
    matchedByDefault,
    activeEdgeIds: activeEdges.map((edge) => edge.id),
    skippedEdgeIds: skippedEdges.map((edge) => edge.id),
    activeTargetNodeIds: activeEdges.map((edge) => edge.to),
    skippedTargetNodeIds: skippedEdges.map((edge) => edge.to),
  };
}

export interface LoopIterationFingerprint {
  readonly gitDiffHash: string;
  readonly errorSignature: string;
}

export interface LoopTransitionDecision {
  readonly loopId: string;
  readonly action: "exit" | "continue" | LoopExhaustedAction;
  readonly reason:
    | "exit_condition_met"
    | "stagnation_detected"
    | "max_iterations_reached"
    | "next_iteration";
  readonly nextIteration: number;
}

export function evaluateLoopTransition(input: {
  readonly loop: LoopSpecV2;
  readonly currentIteration: number;
  readonly context: WorkflowEvaluationContext;
  readonly history: ReadonlyArray<LoopIterationFingerprint>;
}): LoopTransitionDecision {
  const { loop, currentIteration, context, history } = input;
  if (loop.exitConditionExpr && evaluateWorkflowCondition(loop.exitConditionExpr, context)) {
    return {
      loopId: loop.loopId,
      action: "exit",
      reason: "exit_condition_met",
      nextIteration: currentIteration,
    };
  }

  if (loop.stagnationDetection.enabled && history.length >= 2) {
    const windowSlice = history.slice(-loop.stagnationDetection.historyWindowSize);
    const latest = windowSlice.at(-1)!;
    const repeated = windowSlice
      .slice(0, -1)
      .some(
        (entry) =>
          entry.gitDiffHash === latest.gitDiffHash &&
          entry.errorSignature === latest.errorSignature,
      );
    if (repeated) {
      return {
        loopId: loop.loopId,
        action: loop.onExhausted,
        reason: "stagnation_detected",
        nextIteration: currentIteration,
      };
    }
  }

  if (currentIteration >= loop.maxIterations) {
    return {
      loopId: loop.loopId,
      action: loop.onExhausted,
      reason: "max_iterations_reached",
      nextIteration: currentIteration,
    };
  }

  return {
    loopId: loop.loopId,
    action: "continue",
    reason: "next_iteration",
    nextIteration: currentIteration + 1,
  };
}

export interface HumanGatePromptPayload {
  readonly nodeId: string;
  readonly instructions: string;
  readonly allowedActions: ReadonlyArray<HumanResolutionAction>;
  readonly reviewArtifacts: ReadonlyArray<{
    readonly expression: string;
    readonly value: unknown;
  }>;
  readonly revisionTargetNodeId?: string;
}

export function buildHumanGatePrompt(
  node: HumanGateNodeV2,
  context: WorkflowEvaluationContext,
): HumanGatePromptPayload {
  return {
    nodeId: node.id,
    instructions: interpolateWorkflowTemplate(node.instructions, context),
    allowedActions: node.allowedActions,
    reviewArtifacts: node.reviewTargets.map((expression) => ({
      expression,
      value: resolveWorkflowExpression(expression, context),
    })),
    ...(node.revisionTargetNodeId !== undefined
      ? { revisionTargetNodeId: node.revisionTargetNodeId }
      : {}),
  };
}

export interface HumanGateResolution {
  readonly directive: "proceed" | "revise" | "abort";
  readonly action: HumanResolutionAction;
  readonly targetNodeId?: string;
  readonly editedPayload?: Readonly<Record<string, unknown>>;
}

export function resolveHumanGateDecision(
  node: HumanGateNodeV2,
  decision: {
    readonly action: HumanResolutionAction;
    readonly editedPayload?: Readonly<Record<string, unknown>>;
  },
): HumanGateResolution {
  if (!node.allowedActions.includes(decision.action)) {
    throw new Error(`HumanGate "${node.id}"에서는 "${decision.action}" 동작을 허용하지 않습니다.`);
  }
  switch (decision.action) {
    case "approve":
      return { directive: "proceed", action: "approve" };
    case "edit_and_approve":
      return {
        directive: "proceed",
        action: "edit_and_approve",
        ...(decision.editedPayload !== undefined ? { editedPayload: decision.editedPayload } : {}),
      };
    case "request_revision":
      return {
        directive: "revise",
        action: "request_revision",
        ...(node.revisionTargetNodeId !== undefined
          ? { targetNodeId: node.revisionTargetNodeId }
          : {}),
      };
    case "abort":
      return { directive: "abort", action: "abort" };
  }
}

export interface ExpandedMapFanOutTask {
  readonly index: number;
  readonly taskId: string;
  readonly item: unknown;
  readonly prompt?: string;
  readonly subworkflow?: {
    readonly definitionId: string;
    readonly pinnedRevision: number;
  };
}

export interface ExpandedMapFanOutPlan {
  readonly nodeId: string;
  readonly totalItems: number;
  readonly truncated: boolean;
  readonly concurrencyLimit: number;
  readonly isolationPerItem: MapFanOutNodeV2["isolationPerItem"];
  readonly failurePolicy: MapFanOutNodeV2["failurePolicy"];
  readonly tasks: ReadonlyArray<ExpandedMapFanOutTask>;
}

export function expandMapFanOut(
  node: MapFanOutNodeV2,
  context: WorkflowEvaluationContext,
): ExpandedMapFanOutPlan {
  const resolved = resolveWorkflowExpression(node.itemsExpression, context);
  if (!Array.isArray(resolved)) {
    throw new Error(
      `MapFanOut "${node.id}"의 itemsExpression("${node.itemsExpression}")이 배열로 평가되지 않았습니다.`,
    );
  }
  const truncated = resolved.length > node.maxFanOut;
  const bounded = resolved.slice(0, node.maxFanOut);
  const tasks: ExpandedMapFanOutTask[] = bounded.map((item, index) => {
    const childContext: WorkflowEvaluationContext = {
      inputs: context.inputs,
      nodes: context.nodes,
      locals: {
        ...context.locals,
        [node.itemVariableName]: item,
        itemIndex: index,
      },
    };
    const taskId = `${node.id}__item_${index}`;
    if (node.workerTemplate.targetKind === "inline_agent") {
      return {
        index,
        taskId,
        item,
        prompt: interpolateWorkflowTemplate(node.workerTemplate.promptTemplate, childContext),
      };
    }
    return {
      index,
      taskId,
      item,
      subworkflow: {
        definitionId: node.workerTemplate.definitionId,
        pinnedRevision: node.workerTemplate.pinnedRevision,
      },
    };
  });

  return {
    nodeId: node.id,
    totalItems: resolved.length,
    truncated,
    concurrencyLimit: node.concurrencyLimit,
    isolationPerItem: node.isolationPerItem,
    failurePolicy: node.failurePolicy,
    tasks,
  };
}

export interface WorktreeReconcilePlan {
  readonly nodeId: string;
  readonly strategy: ReconcileWorktreesNodeV2["strategy"];
  readonly sourceNodeIds: ReadonlyArray<string>;
  readonly commits: ReadonlyArray<{ readonly nodeId: string; readonly ref: string }>;
  readonly conflictResolverCapability?: CapabilityProfile;
  readonly postMergeVerifyCommand?: string;
}

export function planWorktreeReconcile(
  node: ReconcileWorktreesNodeV2,
  graph: Pick<WorkflowGraphV2, "edges">,
  commitByNodeId: Readonly<Record<string, string>>,
): WorktreeReconcilePlan {
  const sourceNodeIds =
    node.sourceNodeIds.length > 0
      ? [...node.sourceNodeIds]
      : graph.edges
          .filter((edge) => edge.to === node.id && edge.kind !== "loop_back")
          .map((edge) => edge.from);

  const commits = sourceNodeIds
    .filter((id) => typeof commitByNodeId[id] === "string" && commitByNodeId[id]!.trim().length > 0)
    .map((id) => ({ nodeId: id, ref: commitByNodeId[id]!.trim() }));

  return {
    nodeId: node.id,
    strategy: node.strategy,
    sourceNodeIds,
    commits,
    ...(node.conflictResolverCapability !== undefined
      ? { conflictResolverCapability: node.conflictResolverCapability }
      : {}),
    ...(node.postMergeVerifyCommand !== undefined
      ? { postMergeVerifyCommand: node.postMergeVerifyCommand }
      : {}),
  };
}

export interface StrictMergeTreeResult {
  readonly clean: boolean;
  readonly treeOid: string | null;
  readonly conflictedPaths: ReadonlyArray<string>;
  readonly rawOutput: string;
}

export function runWorktreeReconcileStrict(input: {
  readonly cwd: string;
  readonly baseRef: string;
  readonly headRef: string;
}): Effect.Effect<StrictMergeTreeResult> {
  return execFileDirect({
    command: "git",
    args: ["merge-tree", "--write-tree", "--name-only", input.baseRef, input.headRef],
    cwd: NodePath.resolve(input.cwd),
    timeoutMs: 30_000,
  }).pipe(
    Effect.map((res) => {
      const lines = res.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const treeOid = lines[0] && /^[0-9a-f]{40}$/i.test(lines[0]) ? lines[0] : null;
      if (res.exitCode === 0 && treeOid !== null) {
        return {
          clean: true,
          treeOid,
          conflictedPaths: [],
          rawOutput: res.stdout,
        };
      }
      const conflictedPaths = lines
        .slice(treeOid ? 1 : 0)
        .filter((line) => !line.startsWith("CONFLICT ") && !line.startsWith("Auto-merging "));
      return {
        clean: false,
        treeOid,
        conflictedPaths,
        rawOutput: `${res.stdout}\n${res.stderr}`.trim(),
      };
    }),
  );
}

export interface CapabilityRoutingResolution {
  readonly capability: CapabilityProfile;
  readonly legacyAgent: LegacyWorkflowAgent;
  readonly preferredProviders: ReadonlyArray<ProviderFamily>;
  readonly excludedProviders: ReadonlyArray<ProviderFamily>;
  readonly privacy: PrivacyTier;
}

const DEFAULT_PROVIDERS_BY_CAPABILITY: Record<CapabilityProfile, ReadonlyArray<ProviderFamily>> = {
  "deep-architect": ["anthropic", "openai", "antigravity"],
  "code-surgeon": ["openai", "anthropic", "antigravity"],
  "fast-scout": ["xai", "opencode", "google", "antigravity"],
  "adversarial-reviewer": ["anthropic", "openai", "google"],
  "local-zero-cost": ["local-ollama", "local-exaone"],
  custom: ["openai", "anthropic", "opencode"],
};

export function resolveCapabilitySelection(
  capability: CapabilityProfile,
  routing?: ModelRoutingRequirements,
): CapabilityRoutingResolution {
  const privacy: PrivacyTier = routing?.privacy ?? "standard";
  const excluded = new Set<ProviderFamily>(routing?.excludeProviderFamilies ?? []);

  let candidates: ReadonlyArray<ProviderFamily> =
    routing?.preferredProviders && routing.preferredProviders.length > 0
      ? routing.preferredProviders
      : DEFAULT_PROVIDERS_BY_CAPABILITY[capability];

  if (privacy === "local_only") {
    candidates = candidates.filter(
      (provider) => provider === "local-ollama" || provider === "local-exaone",
    );
    if (candidates.length === 0) {
      candidates = ["local-ollama", "local-exaone"];
    }
  }

  const preferredProviders = candidates.filter((provider) => !excluded.has(provider));

  const legacyAgent: LegacyWorkflowAgent =
    routing?.legacyAgentHint ??
    (capability === "deep-architect" || capability === "adversarial-reviewer"
      ? "fable"
      : capability === "fast-scout" || capability === "local-zero-cost"
        ? "grok"
        : "codex");

  return {
    capability,
    legacyAgent,
    preferredProviders,
    excludedProviders: [...excluded],
    privacy,
  };
}

// ============================================================================
// 4. Deterministic Special-Node Dispatcher for WorkspaceCollaborationReactor
// ============================================================================

export function buildEvaluationContextFromOutputs(input: {
  readonly workflowValues: WorkflowValues;
  readonly nodeOutputs: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly output: string | null;
  }>;
}): WorkflowEvaluationContext {
  const nodes: Record<string, WorkflowNodeRuntimeOutput> = {};
  for (const entry of input.nodeOutputs) {
    let parsed: unknown = entry.output;
    if (typeof entry.output === "string") {
      const trimmed = entry.output.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        const decoded = decodeUnknownJsonOption(trimmed);
        if (Option.isSome(decoded)) {
          parsed = decoded.value;
        }
      }
    }
    nodes[entry.id] = {
      status: entry.status,
      output: parsed,
      ...(entry.output !== null ? { rawOutput: entry.output } : {}),
    };
  }
  return {
    inputs: { ...input.workflowValues },
    nodes,
  };
}

export type WorkflowV2SpecialNodeExecution =
  | { readonly handled: false }
  | {
      readonly handled: true;
      readonly passed: boolean;
      readonly output: string;
      readonly error?: string;
    };

export function tryExecuteWorkflowV2SpecialNode(input: {
  readonly graphV2: WorkflowGraphV2;
  readonly nodeId: string;
  readonly cwd: string;
  readonly workflowValues: WorkflowValues;
  readonly nodeOutputs: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly output: string | null;
  }>;
}): Effect.Effect<WorkflowV2SpecialNodeExecution> {
  return Effect.gen(function* () {
    const v2Node = input.graphV2.nodes.find((entry) => entry.id === input.nodeId);
    if (!v2Node) return { handled: false } as const;

    const context = buildEvaluationContextFromOutputs({
      workflowValues: input.workflowValues,
      nodeOutputs: input.nodeOutputs,
    });

    if (v2Node.kind === "verifier") {
      const result = yield* runDeterministicVerifier(v2Node.verifier, {
        cwd: input.cwd,
        context,
      });
      const serialized = encodeUnknownJson(result);
      if (!result.passed) {
        return {
          handled: true,
          passed: false,
          output: serialized,
          error: result.summary,
        } as const;
      }
      return {
        handled: true,
        passed: true,
        output: serialized,
      } as const;
    }

    if (v2Node.kind === "router" && v2Node.mode === "deterministic_rules") {
      const decision = evaluateRouterNode(v2Node, input.graphV2, context);
      return {
        handled: true,
        passed: true,
        output: encodeUnknownJson(decision),
      } as const;
    }

    return { handled: false } as const;
  });
}

export interface WorkflowBudgetGuardDecision {
  readonly state: "ok" | "soft_limit" | "hard_limit";
  readonly usageRatio: number;
  readonly recommendedActions: ReadonlyArray<
    "compact_context" | "downgrade_capability" | "pause_run"
  >;
  readonly downgradedCapability?: CapabilityProfile;
  readonly reason: string;
}

/**
 * Evaluates a `WorkflowGraphV2` `BudgetPolicy` against live spend (tokens, cost, or runtime).
 * At `softThresholdRatio` (default 0.8), recommends step-wise compaction and capability downgrade
 * (`deep-architect` -> `code-surgeon` -> `fast-scout`); at 1.0, triggers `pause_run`.
 */
export function evaluateWorkflowBudgetGuard(input: {
  readonly policy?: BudgetPolicy | undefined;
  readonly currentCapability: CapabilityProfile;
  readonly spentTokens?: number | undefined;
  readonly spentCostUsd?: number | undefined;
  readonly elapsedMs?: number | undefined;
  readonly spentToolCalls?: number | undefined;
}): WorkflowBudgetGuardDecision {
  const policy = input.policy;
  if (!policy) {
    return {
      state: "ok",
      usageRatio: 0,
      recommendedActions: [],
      reason: "예산 정책 미설정",
    };
  }
  const ratios: number[] = [];
  if (policy.maxTotalTokens !== undefined && input.spentTokens !== undefined) {
    ratios.push(input.spentTokens / Math.max(1, policy.maxTotalTokens));
  }
  if (policy.maxCostUsd !== undefined && input.spentCostUsd !== undefined) {
    ratios.push(input.spentCostUsd / Math.max(0.0001, policy.maxCostUsd));
  }
  if (policy.maxWallTimeMs !== undefined && input.elapsedMs !== undefined) {
    ratios.push(input.elapsedMs / Math.max(1, policy.maxWallTimeMs));
  }
  if (policy.maxToolCalls !== undefined && input.spentToolCalls !== undefined) {
    ratios.push(input.spentToolCalls / Math.max(1, policy.maxToolCalls));
  }
  const usageRatio = ratios.length > 0 ? Math.max(...ratios) : 0;
  const softThreshold = policy.softThresholdRatio ?? 0.8;

  if (usageRatio >= 1) {
    return {
      state: "hard_limit",
      usageRatio,
      recommendedActions: ["pause_run"],
      reason: `예산 상한(${Math.round(usageRatio * 100)}%)에 도달해 실행을 안전 일시정지합니다.`,
    };
  }

  if (usageRatio >= softThreshold) {
    const downgradedCapability: CapabilityProfile =
      input.currentCapability === "deep-architect"
        ? "code-surgeon"
        : input.currentCapability === "code-surgeon" ||
            input.currentCapability === "adversarial-reviewer"
          ? "fast-scout"
          : input.currentCapability;
    return {
      state: "soft_limit",
      usageRatio,
      recommendedActions: ["compact_context", "downgrade_capability"],
      downgradedCapability,
      reason: `소프트 예산 임계치(${Math.round(softThreshold * 100)}%) 도달(${Math.round(usageRatio * 100)}%): 문맥 마스킹 및 역량 강등(${input.currentCapability} → ${downgradedCapability})을 적용합니다.`,
    };
  }

  return {
    state: "ok",
    usageRatio,
    recommendedActions: [],
    reason: `예산 여유(${Math.round(usageRatio * 100)}%)`,
  };
}

export function isDeterministicVerifierNode(
  node: WorkflowGraphV2["nodes"][number],
): node is DeterministicVerifierNodeV2 {
  return node.kind === "verifier";
}

// ============================================================================
// 5. Graph Engineering Production Defenses & Built-In Presets
// ============================================================================

export type ReviewFindingSeverity = "critical" | "high" | "medium" | "low";
export type AdversarialCheckCategory = "static_code" | "runtime_behavior";
export type AdversarialVerdictKind = "CONFIRM" | "REJECT" | "UNVERIFIED_ERROR";

export interface ReviewFinding {
  readonly file: string;
  readonly line: number;
  readonly severity: ReviewFindingSeverity;
  readonly category?: AdversarialCheckCategory;
  readonly title: string;
  readonly detail: string;
  readonly reviewer: string;
  readonly suggestedFix?: string;
}

export interface DeduplicatedReviewFinding {
  readonly file: string;
  readonly line: number;
  readonly mergedLines: ReadonlyArray<number>;
  readonly severity: ReviewFindingSeverity;
  readonly category: AdversarialCheckCategory;
  readonly title: string;
  readonly details: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<string>;
  readonly suggestedFix?: string;
}

const SEVERITY_RANK: Record<ReviewFindingSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function normalizeFindingFilePath(rawPath: string): string {
  return rawPath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Merges overlapping findings emitted by parallel reviewers when they refer to
 * the same file within `lineTolerance` lines (default: ±3 lines).
 * Preserves the highest severity and combines reviewer attributions without duplicates.
 */
export function deduplicateReviewFindings(
  findings: ReadonlyArray<ReviewFinding>,
  options?: { readonly lineTolerance?: number },
): ReadonlyArray<DeduplicatedReviewFinding> {
  const tolerance = Math.max(0, options?.lineTolerance ?? 3);
  const clusters: Array<{
    file: string;
    line: number;
    lines: number[];
    severity: ReviewFindingSeverity;
    category: AdversarialCheckCategory;
    title: string;
    details: string[];
    reviewers: string[];
    suggestedFix?: string;
  }> = [];

  for (const finding of findings) {
    const file = normalizeFindingFilePath(finding.file);
    const category: AdversarialCheckCategory = finding.category ?? "static_code";
    const existing = clusters.find(
      (cluster) =>
        cluster.file === file &&
        cluster.lines.some((existingLine) => Math.abs(existingLine - finding.line) <= tolerance),
    );

    if (!existing) {
      clusters.push({
        file,
        line: finding.line,
        lines: [finding.line],
        severity: finding.severity,
        category,
        title: finding.title.trim(),
        details: finding.detail.trim() ? [finding.detail.trim()] : [],
        reviewers: finding.reviewer.trim() ? [finding.reviewer.trim()] : [],
        ...(finding.suggestedFix?.trim() ? { suggestedFix: finding.suggestedFix.trim() } : {}),
      });
      continue;
    }

    if (!existing.lines.includes(finding.line)) {
      existing.lines.push(finding.line);
      existing.lines.sort((a, b) => a - b);
      existing.line = existing.lines[0]!;
    }
    if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity]) {
      existing.severity = finding.severity;
      existing.title = finding.title.trim() || existing.title;
    }
    if (category === "runtime_behavior") {
      existing.category = "runtime_behavior";
    }
    const detail = finding.detail.trim();
    if (detail && !existing.details.includes(detail)) {
      existing.details.push(detail);
    }
    const reviewer = finding.reviewer.trim();
    if (reviewer && !existing.reviewers.includes(reviewer)) {
      existing.reviewers.push(reviewer);
    }
    if (!existing.suggestedFix && finding.suggestedFix?.trim()) {
      existing.suggestedFix = finding.suggestedFix.trim();
    }
  }

  return clusters
    .map((cluster) => ({
      file: cluster.file,
      line: cluster.line,
      mergedLines: cluster.lines,
      severity: cluster.severity,
      category: cluster.category,
      title: cluster.title,
      details: cluster.details,
      reviewers: cluster.reviewers,
      ...(cluster.suggestedFix !== undefined ? { suggestedFix: cluster.suggestedFix } : {}),
    }))
    .toSorted(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        a.file.localeCompare(b.file) ||
        a.line - b.line,
    );
}

export interface AdversarialVerifierEvaluation {
  readonly verdict: AdversarialVerdictKind;
  readonly action: "confirm" | "reject" | "retry" | "keep_unverified";
  readonly checkCategory: AdversarialCheckCategory;
  readonly requiresRuntimeVerification: boolean;
  readonly reason: string;
}

/**
 * Evaluates an adversarial verifier response with strict fail-safe semantics:
 * - A `null`, empty, timed-out, or malformed verifier output is NEVER silently downgraded to `REJECT`.
 * - Instead it is classified as `UNVERIFIED_ERROR`, allowing `maxRetries` (default 1) retries
 *   before conservatively preserving the finding (`keep_unverified`).
 * - Distinguishes `static_code` findings from `runtime_behavior` findings that require runtime evidence.
 */
export function evaluateAdversarialVerifierOutcome(input: {
  readonly rawVerdict: string | null | undefined;
  readonly checkCategory: AdversarialCheckCategory;
  readonly attempt: number;
  readonly maxRetries?: number;
  readonly timedOut?: boolean;
  readonly parseError?: string;
  readonly hasRuntimeEvidence?: boolean;
}): AdversarialVerifierEvaluation {
  const maxRetries = Math.max(0, input.maxRetries ?? 1);
  const normalized = input.rawVerdict?.trim().toUpperCase() ?? "";
  const isError =
    input.timedOut === true ||
    (input.parseError !== undefined && input.parseError.trim().length > 0) ||
    (normalized !== "CONFIRM" && normalized !== "REJECT");

  if (isError) {
    const canRetry = input.attempt <= maxRetries;
    const detail = input.timedOut
      ? "검증기 타임아웃"
      : input.parseError?.trim() || `유효하지 않은 판정 출력(${input.rawVerdict ?? "null"})`;
    return {
      verdict: "UNVERIFIED_ERROR",
      action: canRetry ? "retry" : "keep_unverified",
      checkCategory: input.checkCategory,
      requiresRuntimeVerification: input.checkCategory === "runtime_behavior",
      reason: canRetry
        ? `검증기 오류(${detail})로 기각(REJECT)하지 않고 재시도합니다 (${input.attempt}/${maxRetries}).`
        : `검증기 오류(${detail})가 재시도 후에도 지속되어 기각하지 않고 보수적으로 미검증 보존(keep_unverified)합니다.`,
    };
  }

  if (normalized === "CONFIRM") {
    const requiresRuntimeVerification =
      input.checkCategory === "runtime_behavior" && input.hasRuntimeEvidence !== true;
    return {
      verdict: "CONFIRM",
      action: "confirm",
      checkCategory: input.checkCategory,
      requiresRuntimeVerification,
      reason: requiresRuntimeVerification
        ? "런타임 동작 결함으로 확인되었으며 실행/재현 테스트 증거 첨부가 필요합니다."
        : "독립 검증기에서 실제 결함으로 확정(CONFIRM)되었습니다.",
    };
  }

  return {
    verdict: "REJECT",
    action: "reject",
    checkCategory: input.checkCategory,
    requiresRuntimeVerification: false,
    reason: "독립 검증기가 명시적 반증 근거와 함께 오탐(REJECT)으로 기각했습니다.",
  };
}

export const GRAPH_PR_REVIEW_DEFAULT_MAX_ROUNDS = 3 as const;

export interface GraphPresetOptions {
  readonly testCommand?: string;
  readonly testArgs?: ReadonlyArray<string>;
  readonly maxRounds?: number;
}

/**
 * Built-in Graph Engineering preset:
 * Cross-vendor parallel review -> Adversarial verification (static vs runtime + UNVERIFIED_ERROR guard)
 * -> Minimal fix -> Deterministic test + git_diff_guard with bounded fix/verify loop (default MAX_ROUNDS=3).
 */
export function buildGraphPrReviewPreset(options?: GraphPresetOptions): WorkflowGraphV2 {
  const testCommand = options?.testCommand ?? "vp";
  const testArgs = options?.testArgs ?? ["test", "run"];
  const maxRounds = Math.min(
    Math.max(1, options?.maxRounds ?? GRAPH_PR_REVIEW_DEFAULT_MAX_ROUNDS),
    20,
  );

  return Schema.decodeUnknownSync(WorkflowGraphV2)({
    schemaVersion: 2,
    id: "graph-pr-review",
    title: "교차 모델 PR 리뷰 · 적대적 검증 · 자동 수정 루프",
    description:
      "서로 다른 모델 계열 2종이 병렬 리뷰 후 적대적 검증(UNVERIFIED_ERROR 비기각)과 중복 제거를 거쳐 최대 3라운드 내 최소 수정 및 결정론적 테스트/Diff 가드를 통과시킵니다.",
    inputs: [
      {
        key: "targetRef",
        label: "검토 대상 범위 (git diff / 파일)",
        valueType: "string",
        required: false,
        defaultValue: "HEAD",
      },
    ],
    nodes: [
      {
        id: "review_security",
        kind: "agent",
        title: "보안·경계 병렬 리뷰",
        joinPolicy: "all_succeeded",
        promptTemplate:
          "Read-only security and boundary review for {{inputs.targetRef}}. Return JSON array of findings with {file, line, severity, category: 'static_code'|'runtime_behavior', title, detail, reviewer: 'review_security'}. Never edit files.",
        capability: "adversarial-reviewer",
        routing: {
          requiresStructuredOutput: true,
          excludeProviderFamilies: ["openai"],
        },
        isolation: "shared_readonly",
        sideEffectPolicy: "pure_readonly",
        inputBindings: { targetRef: "{{inputs.targetRef}}" },
        advisoryCriteria: [],
        cleanContext: true,
        cacheable: true,
      },
      {
        id: "review_logic",
        kind: "agent",
        title: "정확성·회귀 병렬 리뷰",
        joinPolicy: "all_succeeded",
        promptTemplate:
          "Read-only correctness, edge-case, and performance regression review for {{inputs.targetRef}}. Return JSON array of findings with {file, line, severity, category: 'static_code'|'runtime_behavior', title, detail, reviewer: 'review_logic'}. Never edit files.",
        capability: "adversarial-reviewer",
        routing: {
          requiresStructuredOutput: true,
          excludeProviderFamilies: ["anthropic"],
        },
        isolation: "shared_readonly",
        sideEffectPolicy: "pure_readonly",
        inputBindings: { targetRef: "{{inputs.targetRef}}" },
        advisoryCriteria: [],
        cleanContext: true,
        cacheable: true,
      },
      {
        id: "verify_findings",
        kind: "agent",
        title: "적대적 검증 및 중복 병합",
        joinPolicy: "all_succeeded",
        promptTemplate:
          "Deduplicate overlapping findings within ±3 lines from review_security and review_logic. Verify each finding independently: classify as CONFIRM, REJECT (requires concrete counter-evidence), or UNVERIFIED_ERROR (never silently treat missing/timeout checks as REJECT). Separate static_code vs runtime_behavior checks.",
        capability: "adversarial-reviewer",
        routing: { requiresStructuredOutput: true },
        isolation: "shared_readonly",
        sideEffectPolicy: "pure_readonly",
        inputBindings: {
          securityFindings: "$.nodes.review_security.output",
          logicFindings: "$.nodes.review_logic.output",
        },
        advisoryCriteria: [],
        cleanContext: true,
        cacheable: true,
      },
      {
        id: "fix_verified",
        kind: "agent",
        title: "검증 결함 최소 수정",
        joinPolicy: "all_succeeded",
        promptTemplate:
          "Apply minimal, surgical fixes only for CONFIRM (and explicitly escalated UNVERIFIED_ERROR) findings from verify_findings. Do not refactor unrelated code.",
        capability: "code-surgeon",
        isolation: "shared_write",
        sideEffectPolicy: "workspace_mutation",
        inputBindings: {
          verifiedFindings: "$.nodes.verify_findings.output",
        },
        advisoryCriteria: [],
        cleanContext: false,
        cacheable: false,
      },
      {
        id: "verify_tests",
        kind: "verifier",
        title: "결정론적 테스트 게이트",
        joinPolicy: "all_succeeded",
        isolation: "shared_readonly",
        verifier: {
          type: "command_exit",
          command: testCommand,
          args: [...testArgs],
          expectedExitCodes: [0],
          timeoutMs: 120_000,
        },
      },
      {
        id: "guard_diff",
        kind: "verifier",
        title: "클린 Diff·비밀키 가드",
        joinPolicy: "all_succeeded",
        isolation: "shared_readonly",
        verifier: {
          type: "git_diff_guard",
          forbiddenPathGlobs: [".env", "**/.env", "**/*.pem", "**/*.key"],
          blockPotentialSecrets: true,
        },
      },
    ],
    edges: [
      { id: "e_sec_verify", from: "review_security", to: "verify_findings", kind: "unconditional" },
      { id: "e_logic_verify", from: "review_logic", to: "verify_findings", kind: "unconditional" },
      { id: "e_verify_fix", from: "verify_findings", to: "fix_verified", kind: "unconditional" },
      { id: "e_fix_tests", from: "fix_verified", to: "verify_tests", kind: "unconditional" },
      { id: "e_tests_guard", from: "verify_tests", to: "guard_diff", kind: "unconditional" },
      {
        id: "e_loop_retry_fix",
        from: "verify_tests",
        to: "fix_verified",
        kind: "loop_back",
        loopId: "pr_fix_verify_loop",
      },
    ],
    loops: [
      {
        loopId: "pr_fix_verify_loop",
        entryNodeId: "fix_verified",
        exitNodeId: "verify_tests",
        maxIterations: maxRounds,
        exitConditionExpr: "$.nodes.verify_tests.output.passed == true",
        stagnationDetection: {
          enabled: true,
          historyWindowSize: 3,
        },
        onExhausted: "interrupt_for_human",
      },
    ],
    runBudget: {
      maxTotalTokens: 400_000,
      softThresholdRatio: 0.8,
      onSoftThreshold: "downgrade_capability",
      onHardExceeded: "pause_run",
    },
  });
}

/**
 * Built-in Graph Engineering preset:
 * 3-Way parallel Simplify review (Reuse, Quality, Efficiency) -> Consolidate & minimal fix
 * -> Deterministic verification + git_diff_guard.
 */
export function buildGraphSimplify3WayPreset(options?: GraphPresetOptions): WorkflowGraphV2 {
  const testCommand = options?.testCommand ?? "vp";
  const testArgs = options?.testArgs ?? ["test", "run"];

  return Schema.decodeUnknownSync(WorkflowGraphV2)({
    schemaVersion: 2,
    id: "graph-simplify-3way",
    title: "3-Way 병렬 코드 정리 (재사용·품질·효율)",
    description:
      "Reuse·Quality·Efficiency 3개 읽기 전용 관점으로 변경분을 병렬 검토하고, ±3줄 중복을 병합한 뒤 동작을 유지하며 최소 정리 및 결정론적 검증을 수행합니다.",
    inputs: [
      {
        key: "scope",
        label: "정리 대상 파일/범위",
        valueType: "string",
        required: false,
        defaultValue: "git diff",
      },
    ],
    nodes: [
      {
        id: "review_reuse",
        kind: "agent",
        title: "관점 A: 재사용·중복 검토",
        joinPolicy: "all_succeeded",
        promptTemplate:
          "Read-only review of {{inputs.scope}} for code reuse opportunities and duplication against existing helpers in packages/shared and packages/contracts. Return structured findings with file, line, severity, detail.",
        capability: "fast-scout",
        isolation: "shared_readonly",
        sideEffectPolicy: "pure_readonly",
        inputBindings: { scope: "{{inputs.scope}}" },
        advisoryCriteria: [],
        cleanContext: true,
        cacheable: true,
      },
      {
        id: "review_quality",
        kind: "agent",
        title: "관점 B: 명확성·과잉설계 검토",
        joinPolicy: "all_succeeded",
        promptTemplate:
          "Read-only review of {{inputs.scope}} for dead code, over-engineering, unnecessary wrappers, and type safety violations. Return structured findings with file, line, severity, detail.",
        capability: "adversarial-reviewer",
        isolation: "shared_readonly",
        sideEffectPolicy: "pure_readonly",
        inputBindings: { scope: "{{inputs.scope}}" },
        advisoryCriteria: [],
        cleanContext: true,
        cacheable: true,
      },
      {
        id: "review_efficiency",
        kind: "agent",
        title: "관점 C: 효율성·운영 안전성 검토",
        joinPolicy: "all_succeeded",
        promptTemplate:
          "Read-only review of {{inputs.scope}} for O(N^2) loops, unbounded caches, WebSocket payload bloat, GPU CSS spikes, and Windows path/handle cleanup bugs. Return structured findings with file, line, severity, detail.",
        capability: "adversarial-reviewer",
        isolation: "shared_readonly",
        sideEffectPolicy: "pure_readonly",
        inputBindings: { scope: "{{inputs.scope}}" },
        advisoryCriteria: [],
        cleanContext: true,
        cacheable: true,
      },
      {
        id: "consolidate_fix",
        kind: "agent",
        title: "중복 병합 및 동작 보존 최소 정리",
        joinPolicy: "all_succeeded",
        promptTemplate:
          "Merge findings within ±3 lines from review_reuse, review_quality, and review_efficiency. Apply only behavior-preserving high/medium cleanups; skip stylistic nits.",
        capability: "code-surgeon",
        isolation: "shared_write",
        sideEffectPolicy: "workspace_mutation",
        inputBindings: {
          reuse: "$.nodes.review_reuse.output",
          quality: "$.nodes.review_quality.output",
          efficiency: "$.nodes.review_efficiency.output",
        },
        advisoryCriteria: [],
        cleanContext: false,
        cacheable: false,
      },
      {
        id: "verify_simplify",
        kind: "verifier",
        title: "회귀 테스트 검증",
        joinPolicy: "all_succeeded",
        isolation: "shared_readonly",
        verifier: {
          type: "command_exit",
          command: testCommand,
          args: [...testArgs],
          expectedExitCodes: [0],
          timeoutMs: 120_000,
        },
      },
      {
        id: "guard_diff",
        kind: "verifier",
        title: "Diff 범위·비밀키 가드",
        joinPolicy: "all_succeeded",
        isolation: "shared_readonly",
        verifier: {
          type: "git_diff_guard",
          forbiddenPathGlobs: [".env", "**/.env", "**/*.pem", "**/*.key"],
          blockPotentialSecrets: true,
        },
      },
    ],
    edges: [
      { id: "e_reuse_fix", from: "review_reuse", to: "consolidate_fix", kind: "unconditional" },
      { id: "e_quality_fix", from: "review_quality", to: "consolidate_fix", kind: "unconditional" },
      {
        id: "e_efficiency_fix",
        from: "review_efficiency",
        to: "consolidate_fix",
        kind: "unconditional",
      },
      { id: "e_fix_verify", from: "consolidate_fix", to: "verify_simplify", kind: "unconditional" },
      { id: "e_verify_guard", from: "verify_simplify", to: "guard_diff", kind: "unconditional" },
    ],
    loops: [],
    runBudget: {
      maxTotalTokens: 300_000,
      softThresholdRatio: 0.8,
      onSoftThreshold: "downgrade_capability",
      onHardExceeded: "pause_run",
    },
  });
}

/**
 * Built-in WorkflowGraphV2 preset inspired by `ai-job-search` (MIT), built
 * strictly on top of T3's existing `hiring-*` + `docx`/`pdf` skills without
 * coupling job-application domain logic into T3 Core:
 * Posting Fit Analysis -> Tailored CV/Cover-Letter Draft -> Adversarial Red-Team Review
 * (bounded Drafter-Reviewer loop, max 3 rounds) -> Local Tracker & Export Guide.
 */
export function buildGraphJobApplicationPreset(options?: {
  readonly maxRounds?: number;
}): WorkflowGraphV2 {
  const maxRounds = Math.min(Math.max(1, options?.maxRounds ?? 3), 20);

  return Schema.decodeUnknownSync(WorkflowGraphV2)({
    schemaVersion: 2,
    id: "graph-job-application-drafter-reviewer",
    title: "채용 공고 적합도 분석 · CV/커버레터 작성-레드팀 이중 검토 루프",
    description:
      "채용 공고 요구사항과 지원자 이력을 대조해 적합도를 채점하고, 기존 hiring-prep-doc-feedback / hiring-sim-resume-redteam / docx·pdf 스킬을 활용해 최대 3라운드 이중 검토 후 맞춤형 지원서와 로컬 지원 트래커 항목을 생성합니다.",
    inputs: [
      {
        key: "jobPosting",
        label: "채용 공고 전문 또는 파일 경로",
        valueType: "string",
        required: true,
        defaultValue: "",
      },
      {
        key: "candidateProfile",
        label: "지원자 기준 이력서/경력 요약 경로",
        valueType: "string",
        required: true,
        defaultValue: "",
      },
      {
        key: "trackerPath",
        label: "로컬 지원 현황 트래커 파일 경로",
        valueType: "string",
        required: false,
        defaultValue: "applications-tracker.md",
      },
    ],
    nodes: [
      {
        id: "analyze_fit",
        kind: "agent",
        title: "공고 요구사항 분해 및 적합도 채점",
        joinPolicy: "all_succeeded",
        promptTemplate:
          "Read-only job fit analysis comparing {{inputs.jobPosting}} against {{inputs.candidateProfile}}. Extract must-have requirements, nice-to-have signals, concrete gaps, and a 0-100 rubric score. Do NOT fabricate candidate experience.",
        capability: "fast-scout",
        routing: { requiresStructuredOutput: true },
        isolation: "shared_readonly",
        sideEffectPolicy: "pure_readonly",
        inputBindings: {
          jobPosting: "{{inputs.jobPosting}}",
          candidateProfile: "{{inputs.candidateProfile}}",
        },
        advisoryCriteria: [],
        cleanContext: true,
        cacheable: true,
      },
      {
        id: "draft_application",
        kind: "agent",
        title: "맞춤형 이력서·커버레터 초안 작성 (Drafter)",
        joinPolicy: "all_succeeded",
        promptTemplate:
          "Using verified facts only from {{inputs.candidateProfile}} and the fit rubric in analyze_fit (plus any defects from redteam_review on retry), draft a tailored CV delta and cover letter following the hiring-prep-doc-feedback skill standards.",
        capability: "code-surgeon",
        isolation: "shared_write",
        sideEffectPolicy: "workspace_mutation",
        inputBindings: {
          fitAnalysis: "$.nodes.analyze_fit.output",
          candidateProfile: "{{inputs.candidateProfile}}",
        },
        advisoryCriteria: [],
        cleanContext: false,
        cacheable: false,
      },
      {
        id: "redteam_review",
        kind: "agent",
        title: "채용담당자 레드팀 적대적 검토 (Reviewer)",
        joinPolicy: "all_succeeded",
        promptTemplate:
          "Act as a skeptical hiring manager using the hiring-sim-resume-redteam checklist. Audit draft_application against {{inputs.jobPosting}} and {{inputs.candidateProfile}} for unsupported claims, vague metrics, ATS keyword misses, and tone issues. Return structured JSON { passed: boolean, score: number, defects: string[] }.",
        capability: "adversarial-reviewer",
        routing: { requiresStructuredOutput: true },
        isolation: "shared_readonly",
        sideEffectPolicy: "pure_readonly",
        inputBindings: {
          draft: "$.nodes.draft_application.output",
          jobPosting: "{{inputs.jobPosting}}",
          candidateProfile: "{{inputs.candidateProfile}}",
        },
        advisoryCriteria: [],
        cleanContext: true,
        cacheable: false,
      },
      {
        id: "export_and_track",
        kind: "agent",
        title: "문서 내보내기(PDF/DOCX) 및 로컬 트래커 기록",
        joinPolicy: "all_succeeded",
        promptTemplate:
          "Finalize the approved application package (guidance/output compatible with pdf/docx skills) and append a dated status entry (company, role, fitScore, reviewScore, status: 'ready_to_submit') to {{inputs.trackerPath}}.",
        capability: "code-surgeon",
        isolation: "shared_write",
        sideEffectPolicy: "workspace_mutation",
        inputBindings: {
          approvedDraft: "$.nodes.draft_application.output",
          reviewSummary: "$.nodes.redteam_review.output",
          trackerPath: "{{inputs.trackerPath}}",
        },
        advisoryCriteria: [],
        cleanContext: false,
        cacheable: false,
      },
    ],
    edges: [
      { id: "e_fit_draft", from: "analyze_fit", to: "draft_application", kind: "unconditional" },
      {
        id: "e_draft_review",
        from: "draft_application",
        to: "redteam_review",
        kind: "unconditional",
      },
      {
        id: "e_review_export",
        from: "redteam_review",
        to: "export_and_track",
        kind: "unconditional",
      },
      {
        id: "e_loop_revise_draft",
        from: "redteam_review",
        to: "draft_application",
        kind: "loop_back",
        loopId: "job_draft_review_loop",
      },
    ],
    loops: [
      {
        loopId: "job_draft_review_loop",
        entryNodeId: "draft_application",
        exitNodeId: "redteam_review",
        maxIterations: maxRounds,
        exitConditionExpr: "$.nodes.redteam_review.output.passed == true",
        stagnationDetection: {
          enabled: true,
          historyWindowSize: 3,
        },
        onExhausted: "interrupt_for_human",
      },
    ],
    runBudget: {
      maxTotalTokens: 200_000,
      softThresholdRatio: 0.8,
      onSoftThreshold: "downgrade_capability",
      onHardExceeded: "pause_run",
    },
  });
}
