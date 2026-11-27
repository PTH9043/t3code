import type {
  OrchestrationThreadActivity as Activity,
  WorkspaceOrchestraBlock,
} from "@t3tools/contracts";
import {
  isSensitiveFilePath,
  redactCommandLineForDisplay,
  redactToolActivityText,
} from "./toolActivityRedaction.ts";

export type ToolActivityAction = "read" | "search" | "list" | "edit" | "command" | "other";
export type ToolActivitySubject =
  | "diff"
  | "read-search"
  | "database-read"
  | "repository-status"
  | "history-fetch"
  | "history-read"
  | "history-fetch-read"
  | "test";
export type ToolActivityPhase =
  | "started"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "declined";
export type ToolActivityEvidence = "planned" | "observed" | "tool-reported" | "confirmed-diff";

/** The only fields intended for a summary model. Keep free text out of this boundary. */
export interface ToolActivityFact {
  readonly action: ToolActivityAction;
  readonly phase: ToolActivityPhase;
  readonly evidence: ToolActivityEvidence;
  readonly subject?: ToolActivitySubject;
  readonly compound?: true;
  readonly targetCount: number;
  readonly confirmedDiffCount: number;
}

type Model = { readonly model: string; readonly instanceId?: string };
export interface ToolActivityGroupOptions {
  readonly assignedModels?: ReadonlyMap<string, Model>;
  /** The durable block for these execution receipts. Its model is an assignment, not a provider report. */
  readonly assignedExecution?: WorkspaceOrchestraBlock;
  /** Only trusted diffs explicitly linked to an individual call. Turn checkpoints belong to the turn. */
  readonly confirmedDiffs?: readonly {
    turnId: string;
    eventId: string;
    paths: readonly string[];
  }[];
}
type LifecycleKind = "tool.started" | "tool.progress" | "tool.updated" | "tool.completed";
const commandDiagnostics = {
  "unclosed-shell-quote": "셸 오류 출력 · 닫는 따옴표 누락",
  "file-not-found": "실행 오류 출력 · 파일 또는 경로를 찾지 못함",
} as const;
type CommandDiagnostic = keyof typeof commandDiagnostics;
const WINDOWS_FILE_NOT_FOUND_EXIT_CODES = new Set([-2147024894, -2147024893]);

function reportedCommandDiagnostic(
  output: string,
  exitCode?: number,
): CommandDiagnostic | undefined {
  const tail = output ? output.slice(-4096) : "";
  const quote =
    tail.length > 0 &&
    /^(?:[^\r\n]*\/)?(?:ba)?sh: (?:-c: )?line \d+: unexpected EOF while looking for matching [\x60'"]{1,3}\r?$/mu.test(
      tail,
    );
  const missingFile =
    (exitCode !== undefined && WINDOWS_FILE_NOT_FOUND_EXIT_CODES.has(exitCode)) ||
    (tail.length > 0 &&
      (/^FileNotFoundError: \[Errno 2\] No such file or directory(?:\s*:|\s*$)/mu.test(tail) ||
        /\b(?:0x80070002|0x80070003|ERROR_FILE_NOT_FOUND|ERROR_PATH_NOT_FOUND|ENOENT)\b/iu.test(
          tail,
        ) ||
        /(?:지정된 (?:파일|경로)을 찾을 수 없습니다|cannot find the (?:file|path) specified)/iu.test(
          tail,
        )));
  if (quote === missingFile) return;
  return quote ? "unclosed-shell-quote" : "file-not-found";
}
export interface ToolActivityEvent {
  readonly id: Activity["id"];
  readonly createdAt: string;
  readonly kind: LifecycleKind;
  readonly phase: ToolActivityPhase;
  readonly exitCode?: number;
}
export interface ToolActivityEditSummary {
  readonly mode: "create" | "edit" | "delete" | "move";
  readonly addedLines?: number;
  readonly removedLines?: number;
  readonly excerpt?: string;
}

export interface ToolActivityPreview {
  readonly intent?: string;
  readonly commandSnippet?: string;
  readonly lineRange?: string;
  readonly editSummary?: ToolActivityEditSummary;
  readonly searchQuery?: string;
  readonly outputSnippet?: string;
  readonly durationMs?: number;
}

/** Safe for the existing local activity projection. Only ToolActivityFact crosses into inference. */
export interface ToolActivityOperation {
  readonly delegation?: true;
  readonly commandDiagnostic?: CommandDiagnostic;
  readonly action: ToolActivityAction;
  readonly subject?: ToolActivitySubject;
  readonly compound?: true;
  readonly targetPaths: readonly string[];
  readonly confirmedDiffPaths?: readonly string[];
  readonly phase: ToolActivityPhase;
  readonly exitCode?: number;
  readonly editCompletionReported?: true;
  readonly preview?: true;
  readonly activityPreview?: ToolActivityPreview;
}
export interface ToolActivityGroup {
  readonly id: Activity["id"];
  readonly eventIds: readonly Activity["id"][];
  readonly events: readonly ToolActivityEvent[];
  readonly turnId: Activity["turnId"];
  readonly createdAt: string;
  readonly callId: string | null;
  readonly phase: ToolActivityPhase;
  readonly action: ToolActivityAction;
  readonly subject?: ToolActivitySubject;
  readonly compound?: true;
  readonly evidence: ToolActivityEvidence;
  readonly summary: string;
  readonly summarySource: "local";
  readonly executorLabel: string;
  readonly commandFailureNote?: string;
  readonly executorSource: "unknown" | "turn-assigned" | "execution-assigned" | "provider-reported";
  readonly targetPaths: readonly string[];
  readonly confirmedDiffPaths: readonly string[];
  readonly preview?: ToolActivityPreview;
}

type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}
function id(value: unknown) {
  return Number.isSafeInteger(value) ? String(value) : str(value);
}
export function hasChildActivityScope(payload: unknown): boolean {
  const p = object(payload);
  return Boolean(p.agentId || p.parentToolUseId || p.taskId || p.executionId || p.messageId);
}
/** Shared by raw history, the live projection and compact receipts. */
export function toolActivityCallIdentity(payload: unknown): {
  toolCallId?: string;
  toolCallIdAmbiguous?: true;
} {
  const p = object(payload);
  if (p.toolCallIdAmbiguous === true) return { toolCallIdAmbiguous: true };
  function identifier(value: unknown) {
    const candidate = Number.isSafeInteger(value) ? String(value) : value;
    return typeof candidate === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]{0,255}$/u.test(candidate)
      ? candidate
      : undefined;
  }
  const canonical = identifier(p.toolCallId);
  if (canonical) return { toolCallId: canonical };
  const data = object(p.data),
    result = object(data.result);
  const ids = new Set(
    [
      p.itemId,
      p.providerItemId,
      p.toolUseId,
      data.toolCallId,
      object(data.item).id,
      result.type === "tool_result" ? result.tool_use_id : undefined,
    ]
      .map(identifier)
      .filter((v) => v !== undefined),
  );
  if (ids.size > 1) return { toolCallIdAmbiguous: true };
  const [toolCallId] = ids;
  return toolCallId ? { toolCallId } : {};
}
function safeModel(value: unknown) {
  const name = str(value);
  return name && /^[\p{L}\d][\p{L}\d._:/ -]*$/u.test(name) && !looksSensitive(name)
    ? name
    : undefined;
}
function looksSensitive(value: string) {
  return /(?:[?&#=]|\bBearer\s|(?:sk|gh[pousr]|github_pat|xox[baprs])[-_]|(?:token|secret|password|credential|api[_-]?key)(?:[=:/_-]|$))/iu.test(
    value,
  );
}
function displayPath(input: unknown): string | undefined {
  const value = str(input);
  if (
    !value ||
    /[:][/]{2}|[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value) ||
    looksSensitive(value)
  )
    return;
  const path = value.replaceAll("\\", "/");
  const absolute = /^(?:[A-Za-z]:\/|\/|~\/)/u.test(path);
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.includes("..")) return;
  const label = absolute ? parts.at(-1)! : parts.join("/");
  if (
    !/^[\p{L}\p{M}\p{N}._/() -]+$/u.test(label) ||
    /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|credentials(?:\..*)?|[^/]+\.(?:pem|key|p12))$/iu.test(
      label,
    )
  )
    return;
  return label;
}
function addPaths(target: Set<string>, source: unknown) {
  const values = Array.isArray(source) ? source : [source];
  for (const entry of values) {
    const record = object(entry);
    const candidates =
      typeof entry === "string"
        ? [entry]
        : [
            record.path,
            record.Path,
            record.file_path,
            record.filePath,
            record.relativePath,
            record.filename,
            record.oldPath,
            record.newPath,
          ];
    for (const value of candidates) {
      const name = displayPath(value);
      if (name) target.add(name);
    }
  }
}
function lifecycle(kind: string): kind is LifecycleKind {
  return (
    kind === "tool.started" ||
    kind === "tool.updated" ||
    kind === "tool.progress" ||
    kind === "tool.completed"
  );
}
function statusPhase(value: unknown): ToolActivityPhase | undefined {
  switch (str(value)?.toLowerCase()) {
    case "failed":
    case "failure":
    case "error":
      return "failed";
    case "declined":
    case "denied":
    case "rejected":
      return "declined";
    case "interrupted":
    case "canceled":
    case "cancelled":
    case "stopped":
    case "aborted":
      return "stopped";
    case "completed":
    case "success":
    case "succeeded":
      return "completed";
    default:
      return;
  }
}
function unsuccessful(phase: ToolActivityPhase | undefined) {
  return phase === "failed" || phase === "stopped" || phase === "declined";
}

interface Operation {
  action: ToolActivityAction;
  subject?: ToolActivitySubject;
  compound?: true;
  targets?: readonly unknown[];
}
/** Recognize simple argv and shell separators only. Quoted arguments are never scanned as commands. */
function shellSegments(line: string): string[][] {
  // Retain finished segments when syntax becomes opaque. Quoted program text, substitutions
  // and here-doc bodies never start a new command for this classifier.
  const token =
    /[ \t]+|\r?\n|2>&1(?=\s|[|;&]|$)|&&|\|\||[|;]|"((?:\\.|[^"\\])*)"|'([^']*)'|[^\s"'\\|;&<>$\x60(){}^]+/gy;
  const segments: string[][] = [];
  let words: string[] = [];
  for (let cursor = 0; cursor < line.length; ) {
    if (line[cursor] === "#") {
      const newline = line.indexOf("\n", cursor);
      if (newline < 0) break;
      cursor = newline;
    }
    token.lastIndex = cursor;
    const match = token.exec(line);
    if (!match) return [...segments, ["?"]];
    cursor = token.lastIndex;
    const [raw, doubleQuoted, singleQuoted] = match;
    if ((raw.trim() === "" && !raw.includes("\n")) || raw === "2>&1") continue;
    if (
      raw === "&&" ||
      raw === "||" ||
      raw === "|" ||
      raw === ";" ||
      raw === "\n" ||
      raw === "\r\n"
    ) {
      if (words.length) segments.push(words);
      words = [];
    } else {
      if (cursor < line.length && !/[\s;&|<>]/u.test(line[cursor]!)) return [...segments, ["?"]];
      // A double-quoted substitution may contain nested command text or quotes.
      if (doubleQuoted !== undefined && /[$\x60]/u.test(doubleQuoted)) return [...segments, ["?"]];
      words.push(
        doubleQuoted !== undefined && doubleQuoted.includes("\\")
          ? "\0"
          : (doubleQuoted ?? singleQuoted ?? raw),
      );
    }
  }
  if (words.length) segments.push(words);
  return segments;
}
function searchTargets(args: readonly string[]): readonly string[] {
  let hasPattern = false,
    terminated = false;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!terminated && arg === "--") {
      terminated = true;
      continue;
    }
    if (!terminated && arg.startsWith("-")) {
      if (arg === "-e" || arg === "--regexp" || arg === "-f" || arg === "--file") {
        hasPattern = true;
        i++;
      } else if (/^--(?:regexp|file)=/u.test(arg)) hasPattern = true;
      else if (
        ["-A", "-B", "-C", "-m", "-g", "--glob", "-t", "--type", "--include", "--exclude"].includes(
          arg,
        )
      )
        i++;
      else if (
        !/^-[inHlFErsvwxohq]+$/u.test(arg) &&
        !/^--(?:line-number|ignore-case|fixed-strings|hidden|no-heading|files-with-matches)$/u.test(
          arg,
        )
      )
        return [];
    } else if (!hasPattern) hasPattern = true;
    else paths.push(arg);
  }
  return paths;
}
function specificCommand(words: readonly string[]): Operation {
  const exe = words[0]
    ?.split(/[\\/]/u)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.exe$/u, "");
  const args = words.slice(1);
  const afterDash = args.indexOf("--");
  const explicit = afterDash === -1 ? [] : args.slice(afterDash + 1);
  if (
    exe === "vitest" ||
    exe === "pytest" ||
    exe === "jest" ||
    (exe === "node" && args[0] === "--test") ||
    ((exe === "npm" ||
      exe === "pnpm" ||
      exe === "yarn" ||
      exe === "bun" ||
      exe === "vp" ||
      exe === "cargo" ||
      exe === "go") &&
      (args[0] === "test" || (args[0] === "run" && args[1] === "test"))) ||
    ((exe === "python" || exe === "python3") &&
      args[0] === "-m" &&
      (args[1] === "pytest" || args[1] === "unittest"))
  ) {
    return { action: "command", subject: "test" };
  }
  if (exe === "git") {
    let i = 0;
    while (args[i] === "-C" && args[i + 1]) i += 2;
    const verb = args[i];
    if (
      verb === "diff" &&
      !args.some((v) => v === "--output" || v.startsWith("--output=") || v === "--ext-diff")
    )
      return { action: "read", subject: "diff", targets: explicit };
    if (verb === "fetch") return { action: "command", subject: "history-fetch" };
    if (verb === "log" || verb === "show" || verb === "rev-list" || verb === "reflog")
      return { action: "read", subject: "history-read", targets: explicit };
    if (verb === "status")
      return { action: "read", subject: "repository-status", targets: explicit };
  }
  if (exe === "sqlite3") {
    // Only attribute reads to a readonly connection with a single literal SELECT.
    const [mode, database, query, ...rest] = args;
    if (
      mode === "-readonly" &&
      database &&
      !database.startsWith("-") &&
      typeof query === "string" &&
      /^\s*SELECT\b[^;]*;?\s*$/iu.test(query) &&
      rest.length === 0
    )
      return { action: "read", subject: "database-read", targets: [database] };
  }
  if (exe === "rg" || exe === "grep") {
    if (
      args.some(
        (v) =>
          v === "--pre" ||
          v.startsWith("--pre=") ||
          v === "--hostname-bin" ||
          v.startsWith("--hostname-bin="),
      )
    )
      return { action: "command" };
    if (exe === "rg" && args.includes("--files")) return { action: "list", targets: explicit };
    return { action: "search", targets: searchTargets(args) };
  }
  if (exe === "sed") {
    // sed programs can write files or launch processes. Recognize only a literal print range.
    const [quiet, ...rest] = args;
    if (quiet !== "-n" && quiet !== "--quiet" && quiet !== "--silent") return { action: "command" };
    if (rest[0] === "-e") rest.shift();
    if (!/^(?:(?:\d+|\$)(?:,(?:\d+|\$))?)?p$/u.test(rest.shift() ?? ""))
      return { action: "command" };
    if (rest[0] === "--") rest.shift();
    if (rest.some((r) => r.startsWith("-"))) return { action: "command" };
    return rest.length ? { action: "read", targets: rest } : { action: "command" };
  }
  if (exe === "ls" || exe === "dir") return { action: "list" };
  if (exe === "cat" || exe === "type" || exe === "head" || exe === "tail") {
    const targets = args.filter((v) => !v.startsWith("-") && !/^\+?\d+$/u.test(v));
    return targets.length ? { action: "read", targets } : { action: "command" };
  }
  return { action: "command" };
}
/** Inspect only a literal Python stdin program. A matching connection and its own SELECT
 * are evidence of a query in the command, not of successful execution of the script. */
function pythonReadonlyQuery(command: string): Operation | undefined {
  const header = /^([^\r\n#]*)<<[ \t]*(["'])([A-Za-z_]\w*)\2[ \t]*\r?\n/u.exec(command);
  if (!header) return;
  const argv = shellSegments(header[1]!).at(-1);
  if (!argv || !/^(?:.*[/\\])?python(?:3(?:\.\d+)?)?(?:\.exe)?$/iu.test(argv[0] ?? "")) return;
  const args = argv.slice(1).join(" ");
  if (!/^(?:(?:-[IBEsSu]|-X utf8) )*-?$/u.test(args)) return;
  const tail = command.slice(header[0].length);
  const end = new RegExp("^" + header[3] + "\\r?$", "mu").exec(tail);
  if (!end) return;
  const program = tail.slice(0, end.index);
  if (program.includes("\0")) return;
  // Replace strings/comments before matching receiver expressions. Neither SQL in a
  // docstring nor a second unrelated connection establishes that the selected DB was read.
  const literal = /#[^\r\n]*|"""|'''|"|'/gu;
  let syntax = "",
    offset = 0;
  const dbPaths: (string | undefined)[] = [];
  for (let m = literal.exec(program); m; m = literal.exec(program)) {
    syntax += program.slice(offset, m.index);
    const q = m[0];
    if (q.startsWith("#")) {
      offset = literal.lastIndex;
      continue;
    }
    const begin = literal.lastIndex;
    let pos = begin;
    while (pos < program.length && !program.startsWith(q, pos)) {
      if (program[pos] === "\\") pos++;
      else if (q.length === 1 && program[pos] === "\n") return;
      pos++;
    }
    if (pos >= program.length) return;
    const value = program.slice(begin, pos);
    let token = "L";
    if (/^\s*SELECT\b[^;]*;?\s*$/iu.test(value)) token = "Q";
    else if (/^file:[^\r\n\\?#]+\?[^\s#]+$/u.test(value)) {
      const [path, query] = value.slice(5).split("?");
      if (new URLSearchParams(query).getAll("mode").join(",") === "ro") {
        token = "D" + dbPaths.length;
        dbPaths.push(displayPath(path));
      }
    }
    syntax += "\0" + token + "\0";
    offset = literal.lastIndex = pos + q.length;
  }
  syntax += program.slice(offset);
  const bind =
    /^\s*(?:import [\w ,]+\s*\n)*?import (?:\w+,\s*)*sqlite3(?:,\s*\w+)*[ \t]*\n\s*(\w+)\s*=\s*sqlite3\.connect\(\s*\x00D(\d+)\x00\s*,\s*uri\s*=\s*True(?:\s*,\s*timeout\s*=\s*\d+(?:\.\d+)?)?\s*\)[ \t]*\r?\n/u.exec(
      syntax,
    );
  if (!bind) return;
  const connection = bind[1]!,
    rest = syntax.slice(bind[0].length);
  const receivers = new Set([connection]);
  for (const line of rest.split(/\r?\n/u)) {
    const assignment = /^\s*(\w+)\s*=(?!=)\s*(.*)$/u.exec(line);
    if (assignment) {
      receivers.delete(assignment[1]!);
      if (receivers.has(connection) && assignment[2]?.trim() === connection + ".cursor()")
        receivers.add(assignment[1]!);
    }
    for (const match of line.matchAll(/(?<![\w.])(\w+)\.execute\(\s*\x00Q\x00/gu)) {
      if (receivers.has(match[1]!))
        return {
          action: "read",
          subject: "database-read",
          compound: true,
          targets: [dbPaths[Number(bind[2])]],
        };
    }
  }
}
function shellOperation(command: unknown): Operation {
  if (
    typeof command === "string" &&
    command.includes("<<") &&
    command.includes("sqlite3.connect")
  ) {
    const query = pythonReadonlyQuery(command);
    if (query) return query;
  }
  const segments =
    typeof command === "string"
      ? shellSegments(command)
      : Array.isArray(command) && command.every((v): v is string => typeof v === "string")
        ? [command]
        : undefined;
  if (!segments?.length) return { action: "command" };
  if (segments.length === 1) return specificCommand(segments[0]!);
  const parts = segments.map(specificCommand);
  const fetch = parts.some((p) => p.subject === "history-fetch"),
    history = parts.some((p) => p.subject === "history-read");
  const read = parts.some((p) => p.action === "read"),
    search = parts.some((p) => p.action === "search");
  const subject =
    fetch && history
      ? "history-fetch-read"
      : fetch
        ? "history-fetch"
        : history
          ? "history-read"
          : (parts.find((p) => p.subject)?.subject ?? (read && search ? "read-search" : undefined));
  const action =
    fetch || history || subject === "test"
      ? "command"
      : search
        ? "search"
        : read
          ? "read"
          : parts.some((p) => p.action === "list")
            ? "list"
            : "command";
  return {
    action,
    compound: true,
    ...(subject ? { subject } : {}),
    targets: parts.flatMap((p) => p.targets ?? []),
  };
}
function toolAction(name: unknown): ToolActivityAction | undefined {
  const value = str(name)
    ?.toLowerCase()
    .replace(/\s+(?:started|completed)$/u, "")
    .split("__")
    .at(-1)
    ?.replace(/[ _-]/gu, "");
  switch (value) {
    case "read":
    case "readfile":
    case "readtextfile":
    case "readmultiplefiles":
    case "viewimage":
      return "read";
    case "grep":
    case "glob":
    case "find":
    case "search":
    case "searchfiles":
    case "websearch":
      return "search";
    case "ls":
    case "list":
    case "listfiles":
    case "listdirectory":
      return "list";
    case "edit":
    case "write":
    case "delete":
    case "move":
    case "editfile":
    case "writefile":
    case "multiedit":
    case "applypatch":
    case "replace":
      return "edit";
    case "bash":
    case "terminal":
    case "execute":
    case "execcommand":
      return "command";
    default:
      return;
  }
}
function countTextLines(value: string): number {
  if (value.length === 0) return 0;
  return value.replace(/\r\n/gu, "\n").replace(/\n$/u, "").split("\n").length;
}

function extractFirstMeaningfulExcerpt(value: string): string | undefined {
  for (const rawLine of value.split(/\r?\n/u)) {
    const cleaned = rawLine
      .replace(/^\s*(?:"""|'''|\/\*\*?|\*\/?|\*|#|\/\/|--)\s*/u, "")
      .replace(/(?:"""|'''|\*\/)\s*$/u, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (cleaned.length < 3 || /^[@#\-=*_`{}[\]()]+$/u.test(cleaned)) continue;
    return redactToolActivityText(cleaned, 110);
  }
  return undefined;
}

export function parseStructuredToolOutput(rawText: string): {
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly outputSnippet?: string;
} {
  const createdMatch = /^Created At:\s*(.+)$/mu.exec(rawText);
  const completedMatch = /^Completed At:\s*(.+)$/mu.exec(rawText);
  let durationMs: number | undefined;
  if (createdMatch?.[1] && completedMatch?.[1]) {
    const startMs = Date.parse(createdMatch[1].trim());
    const endMs = Date.parse(completedMatch[1].trim());
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      durationMs = Math.round(endMs - startMs);
    }
  }
  const exitMatch = /^Command exited with code (-?\d{1,9})\.?$/mu.exec(rawText);
  const exitCode = exitMatch?.[1] !== undefined ? Number(exitMatch[1]) : undefined;

  const outputMarker = /\r?\nCommand output:\r?\n/u.exec(rawText);
  const body = outputMarker ? rawText.slice(outputMarker.index + outputMarker[0].length) : rawText;

  const meaningful: string[] = [];
  for (const rawLine of body.split(/\r?\n/u)) {
    const trimmed = rawLine.replace(/\s+/gu, " ").trim();
    if (
      !trimmed ||
      trimmed === "```" ||
      /^Created At:/iu.test(trimmed) ||
      /^Completed At:/iu.test(trimmed) ||
      /^Command exited with code -?\d+\.?$/iu.test(trimmed) ||
      /^Command output:?$/iu.test(trimmed)
    ) {
      continue;
    }
    meaningful.push(trimmed);
  }
  if (meaningful.length === 0) {
    return {
      ...(exitCode !== undefined && Number.isSafeInteger(exitCode) ? { exitCode } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }
  const priorityPattern =
    /\b(?:DONE|PASS(?:ED)?|FAIL(?:ED)?|ERROR|Exception|Traceback|Saved|Created|Wrote|Summary|Total|Status|Tool is running as a background task)\b/iu;
  const highlighted = meaningful.filter((line) => priorityPattern.test(line));
  const selected = highlighted.length > 0 ? highlighted.slice(-2) : meaningful.slice(-2);
  const snippet = redactToolActivityText(selected.join(" · "), 220);
  return {
    ...(exitCode !== undefined && Number.isSafeInteger(exitCode) ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(snippet ? { outputSnippet: snippet } : {}),
  };
}

function normalizeStampedPreview(value: unknown): ToolActivityPreview | undefined {
  const rec = object(value);
  if (Object.keys(rec).length === 0) return undefined;
  const intent = str(rec.intent);
  const commandSnippet = str(rec.commandSnippet);
  const lineRange = str(rec.lineRange);
  const searchQuery = str(rec.searchQuery);
  const outputSnippet = str(rec.outputSnippet);
  const durationMs =
    typeof rec.durationMs === "number" && Number.isFinite(rec.durationMs) && rec.durationMs >= 0
      ? Math.round(rec.durationMs)
      : undefined;
  const rawEdit = object(rec.editSummary);
  const mode =
    rawEdit.mode === "create" ||
    rawEdit.mode === "edit" ||
    rawEdit.mode === "delete" ||
    rawEdit.mode === "move"
      ? rawEdit.mode
      : undefined;
  const editSummary: ToolActivityEditSummary | undefined = mode
    ? {
        mode,
        ...(typeof rawEdit.addedLines === "number" && Number.isFinite(rawEdit.addedLines)
          ? { addedLines: rawEdit.addedLines }
          : {}),
        ...(typeof rawEdit.removedLines === "number" && Number.isFinite(rawEdit.removedLines)
          ? { removedLines: rawEdit.removedLines }
          : {}),
        ...(str(rawEdit.excerpt) ? { excerpt: str(rawEdit.excerpt)! } : {}),
      }
    : undefined;
  if (
    !intent &&
    !commandSnippet &&
    !lineRange &&
    !editSummary &&
    !searchQuery &&
    !outputSnippet &&
    durationMs === undefined
  ) {
    return undefined;
  }
  return {
    ...(intent ? { intent } : {}),
    ...(commandSnippet ? { commandSnippet } : {}),
    ...(lineRange ? { lineRange } : {}),
    ...(editSummary ? { editSummary } : {}),
    ...(searchQuery ? { searchQuery } : {}),
    ...(outputSnippet ? { outputSnippet } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function mergeToolActivityPreview(
  current: ToolActivityPreview | undefined,
  next: ToolActivityPreview | undefined,
): ToolActivityPreview | undefined {
  if (!current) return next;
  if (!next) return current;
  return {
    ...((next.intent ?? current.intent) ? { intent: next.intent ?? current.intent } : {}),
    ...((next.commandSnippet ?? current.commandSnippet)
      ? { commandSnippet: next.commandSnippet ?? current.commandSnippet }
      : {}),
    ...((next.lineRange ?? current.lineRange)
      ? { lineRange: next.lineRange ?? current.lineRange }
      : {}),
    ...((next.editSummary ?? current.editSummary)
      ? { editSummary: next.editSummary ?? current.editSummary }
      : {}),
    ...((next.searchQuery ?? current.searchQuery)
      ? { searchQuery: next.searchQuery ?? current.searchQuery }
      : {}),
    ...((next.outputSnippet ?? current.outputSnippet)
      ? { outputSnippet: next.outputSnippet ?? current.outputSnippet }
      : {}),
    ...((next.durationMs ?? current.durationMs !== undefined)
      ? { durationMs: next.durationMs ?? current.durationMs }
      : {}),
  };
}

function extractActivityPreviewFromRaw(input: {
  readonly action: ToolActivityAction;
  readonly data: Obj;
  readonly item: Obj;
  readonly rawInput: Obj;
  readonly toolInput: Obj;
  readonly stateInput: Obj;
  readonly rawOutput: Obj;
  readonly command: unknown;
  readonly paths: ReadonlySet<string>;
}): {
  readonly preview?: ToolActivityPreview;
  readonly parsedOutputExitCode?: number;
} {
  const { action, data, item, rawInput, toolInput, stateInput, rawOutput, command, paths } = input;
  const rawIntent =
    str(rawInput.toolSummary) ??
    str(data.intent) ??
    str(toolInput.description) ??
    str(stateInput.description);
  const intent =
    rawIntent && !looksSensitive(rawIntent)
      ? redactToolActivityText(rawIntent.replace(/\s+/gu, " "), 120)
      : undefined;

  const commandSnippet =
    action === "command" && command !== undefined
      ? (redactCommandLineForDisplay(command, 160) ?? undefined)
      : undefined;

  const startLine =
    typeof rawInput.StartLine === "number" && Number.isFinite(rawInput.StartLine)
      ? rawInput.StartLine
      : typeof toolInput.offset === "number" && Number.isFinite(toolInput.offset)
        ? toolInput.offset
        : undefined;
  const endLine =
    typeof rawInput.EndLine === "number" && Number.isFinite(rawInput.EndLine)
      ? rawInput.EndLine
      : startLine !== undefined &&
          typeof toolInput.limit === "number" &&
          Number.isFinite(toolInput.limit)
        ? startLine + toolInput.limit - 1
        : undefined;
  const lineRange =
    action === "read" && startLine !== undefined
      ? endLine !== undefined && endLine >= startLine
        ? `L${startLine}-L${endLine}`
        : `L${startLine}~`
      : undefined;

  const hasSensitiveTarget = [...paths].some((p) => isSensitiveFilePath(p));
  let editSummary: ToolActivityEditSummary | undefined;
  if (action === "edit") {
    const content =
      typeof rawInput.Content === "string"
        ? rawInput.Content
        : typeof toolInput.content === "string"
          ? toolInput.content
          : undefined;
    const oldText =
      typeof rawInput.Target === "string"
        ? rawInput.Target
        : typeof toolInput.old_string === "string"
          ? toolInput.old_string
          : undefined;
    const newText =
      typeof rawInput.Replacement === "string"
        ? rawInput.Replacement
        : typeof toolInput.new_string === "string"
          ? toolInput.new_string
          : undefined;
    const kindLower = str(data.kind)?.toLowerCase();
    if (kindLower === "delete") {
      editSummary = { mode: "delete" };
    } else if (kindLower === "move") {
      editSummary = { mode: "move" };
    } else if (oldText !== undefined || newText !== undefined) {
      const removedLines = oldText !== undefined ? countTextLines(oldText) : 0;
      const addedLines = newText !== undefined ? countTextLines(newText) : 0;
      const excerpt =
        !hasSensitiveTarget && newText ? extractFirstMeaningfulExcerpt(newText) : undefined;
      editSummary = {
        mode: "edit",
        addedLines,
        removedLines,
        ...(excerpt ? { excerpt } : {}),
      };
    } else if (content !== undefined) {
      const addedLines = countTextLines(content);
      const excerpt = !hasSensitiveTarget ? extractFirstMeaningfulExcerpt(content) : undefined;
      editSummary = {
        mode: "create",
        addedLines,
        ...(excerpt ? { excerpt } : {}),
      };
    } else if (Array.isArray(item.changes)) {
      let added = 0;
      let removed = 0;
      for (const entry of item.changes) {
        const diff = object(entry).diff;
        if (typeof diff !== "string") continue;
        for (const diffLine of diff.split(/\r?\n/u)) {
          if (/^\+(?!\+\+)/u.test(diffLine)) added++;
          else if (/^-(?!--)/u.test(diffLine)) removed++;
        }
      }
      if (added > 0 || removed > 0) {
        editSummary = { mode: "edit", addedLines: added, removedLines: removed };
      }
    }
  }

  const rawQuery =
    action === "search"
      ? (str(rawInput.Query) ??
        str(rawInput.query) ??
        str(rawInput.pattern) ??
        str(toolInput.pattern) ??
        str(toolInput.query))
      : undefined;
  const searchQuery =
    rawQuery && !looksSensitive(rawQuery)
      ? redactToolActivityText(rawQuery.replace(/\s+/gu, " "), 80)
      : undefined;

  const rawOutputText =
    typeof rawOutput.output === "string"
      ? rawOutput.output
      : typeof rawOutput.stdout === "string"
        ? rawOutput.stdout
        : typeof item.aggregatedOutput === "string"
          ? item.aggregatedOutput
          : undefined;
  const parsedOutput = rawOutputText ? parseStructuredToolOutput(rawOutputText) : undefined;

  const preview = normalizeStampedPreview({
    ...(intent ? { intent } : {}),
    ...(commandSnippet ? { commandSnippet } : {}),
    ...(lineRange ? { lineRange } : {}),
    ...(editSummary ? { editSummary } : {}),
    ...(searchQuery ? { searchQuery } : {}),
    ...(parsedOutput?.outputSnippet ? { outputSnippet: parsedOutput.outputSnippet } : {}),
    ...(parsedOutput?.durationMs !== undefined ? { durationMs: parsedOutput.durationMs } : {}),
  });

  return {
    ...(preview ? { preview } : {}),
    ...(parsedOutput?.exitCode !== undefined
      ? { parsedOutputExitCode: parsedOutput.exitCode }
      : {}),
  };
}

function inspect(activity: Activity, kind: LifecycleKind, useStamp = true) {
  const p = object(activity.payload),
    data = object(p.data),
    item = object(data.item);
  const result = object(data.result),
    itemResult = object(item.result),
    input = object(data.input),
    rawInput = object(data.rawInput),
    rawOutput = object(data.rawOutput),
    // OpenCode keeps a tool part's arguments under its state.
    stateInput = object(object(data.state).input);
  const callId = toolActivityCallIdentity(p).toolCallId ?? null;
  const command =
    item.command ??
    data.command ??
    input.command ??
    rawInput.CommandLine ??
    rawInput.command ??
    stateInput.command ??
    object(item.input).command ??
    (p.itemType === "command_execution"
      ? str(p.detail)?.match(/^(?:bash|shell|terminal):[ \t]+([^\s][\s\S]*)$/iu)?.[1]
      : undefined);
  const specific =
    toolAction(data.toolName) ??
    toolAction(data.tool) ??
    toolAction(item.tool) ??
    toolAction(p.toolName) ??
    toolAction(data.kind) ??
    toolAction(p.title) ??
    toolAction(activity.summary);
  const stamp = useStamp ? object(p.toolActivityOperation) : {};
  const stampedAction =
    typeof stamp.action === "string" && Object.hasOwn(actions, stamp.action)
      ? (stamp.action as ToolActivityAction)
      : undefined;
  const stampedSubject =
    typeof stamp.subject === "string" && Object.hasOwn(subjects, stamp.subject)
      ? (stamp.subject as ToolActivitySubject)
      : undefined;
  const operation: Operation = stampedAction
    ? {
        action: stampedAction,
        ...(stampedSubject ? { subject: stampedSubject } : {}),
        ...(stamp.compound === true ? { compound: true } : {}),
      }
    : specific === "command" || (!specific && p.itemType === "command_execution")
      ? shellOperation(command)
      : {
          action:
            specific ??
            (p.itemType === "file_change"
              ? "edit"
              : p.itemType === "web_search"
                ? "search"
                : p.itemType === "image_view"
                  ? "read"
                  : "other"),
        };
  const paths = new Set<string>();
  for (const source of stampedAction
    ? [stamp.targetPaths]
    : [
        input,
        rawInput,
        stateInput,
        item.input,
        data.locations,
        data.files,
        item.changes,
        data.changes,
        operation.targets,
      ])
    addPaths(paths, source);
  const extractedPreview = stampedAction
    ? {
        preview: normalizeStampedPreview(stamp.activityPreview),
        parsedOutputExitCode: undefined as number | undefined,
      }
    : extractActivityPreviewFromRaw({
        action: operation.action,
        data,
        item,
        rawInput,
        toolInput: input,
        stateInput,
        rawOutput,
        command,
        paths,
      });
  // Claude's Bash tool returns its exit header and diagnostic in a tool_result.
  // Never classify the command, assistant prose, or a successful command's output as an error.
  const errorOutput =
    p.itemType === "command_execution" &&
    data.toolName === "Bash" &&
    result.type === "tool_result" &&
    result.is_error === true &&
    typeof result.content === "string"
      ? result.content
      : "";
  const exitHeader = /^Exit code (-?\d{1,9})(?:\r?\n|$)/u.exec(errorOutput);
  const code = [
    stamp.exitCode,
    p.exitCode,
    item.exitCode,
    data.exitCode,
    itemResult.exitCode,
    result.exitCode,
    extractedPreview.parsedOutputExitCode,
    exitHeader ? Number(exitHeader[1]) : undefined,
  ].find((v) => typeof v === "number" && Number.isSafeInteger(v)) as number | undefined;
  const failedCommandOutput =
    errorOutput ||
    (p.itemType === "command_execution" &&
    code !== undefined &&
    code !== 0 &&
    typeof item.aggregatedOutput === "string"
      ? item.aggregatedOutput
      : p.itemType === "command_execution" &&
          code !== undefined &&
          code !== 0 &&
          typeof rawOutput.output === "string"
        ? rawOutput.output
        : "");
  const commandDiagnostic: CommandDiagnostic | undefined =
    stampedAction &&
    typeof stamp.commandDiagnostic === "string" &&
    Object.hasOwn(commandDiagnostics, stamp.commandDiagnostic)
      ? (stamp.commandDiagnostic as CommandDiagnostic)
      : reportedCommandDiagnostic(failedCommandOutput, code);
  const statuses = [item.status, data.status, result.status, p.status].map(statusPhase);
  const explicitEdit =
    specific === "edit" ||
    item.type === "fileChange" ||
    typeof input.patch === "string" ||
    Array.isArray(item.changes);
  const explicitlyCompleted =
    stamp.editCompletionReported === true ||
    (explicitEdit &&
      (statuses.includes("completed") ||
        result.is_error === false ||
        itemResult.isError === false));
  const phase: ToolActivityPhase =
    statuses.find(unsuccessful) ??
    (result.is_error === true ||
    itemResult.isError === true ||
    (code !== undefined && code !== 0) ||
    (code === undefined &&
      kind === "tool.completed" &&
      p.itemType === "command_execution" &&
      /^(?:zsh: command not found: [^\s:]+|(?:ba)?sh: (?:line \d+: )?[^\s:]+: (?:command )?not found)$/u.test(
        str(p.detail) ?? "",
      ))
      ? "failed"
      : stampedAction && typeof stamp.phase === "string" && Object.hasOwn(phases, stamp.phase)
        ? (stamp.phase as ToolActivityPhase)
        : kind === "tool.completed" || statuses.includes("completed")
          ? "completed"
          : kind === "tool.started"
            ? "started"
            : "running");
  const scope = [
    p.provider,
    p.providerInstanceId,
    p.providerSessionId,
    p.providerTurnId,
    p.executionId,
    p.messageId,
    p.agentId,
    p.parentToolUseId,
    p.taskId,
    p.attemptId ?? p.attempt ?? p.attemptNumber,
  ].map(id);
  // Delegated executions have their own message and execution IDs and can have no parent turn ID.
  const scoped = activity.turnId || (str(p.executionId) && str(p.messageId));
  const key = callId && scoped ? JSON.stringify([activity.turnId, ...scope, callId]) : null;
  const confirmed = new Set<string>();
  if (operation.action === "edit" && phase === "completed" && kind === "tool.completed") {
    if (stampedAction) addPaths(confirmed, stamp.confirmedDiffPaths);
    else if (
      item.type === "fileChange" &&
      statusPhase(item.status) === "completed" &&
      Array.isArray(item.changes)
    ) {
      for (const value of item.changes) {
        const change = object(value);
        if (
          typeof change.diff === "string" &&
          /^(?:@@ |diff --git |[+-](?![+-]).)/mu.test(change.diff)
        )
          addPaths(confirmed, change);
      }
    }
  }
  return {
    callId,
    key,
    scope,
    // Claude tool_use IDs survive the transition from an unbound notification to a bound turn.
    nativeClaudeCall:
      useStamp &&
      p.provider === "claudeAgent" &&
      str(p.providerInstanceId) &&
      callId?.startsWith("toolu_") &&
      !hasChildActivityScope(p),
    commandDiagnostic,
    // A worker shown as the thread's own turn keeps its execution only in the activity ID.
    executionCall: !!(
      key &&
      (activity.id.startsWith("orchestra:") ||
        (str(p.executionId) && str(p.messageId) && Number.isSafeInteger(p.attempt)))
    ),
    operation,
    paths,
    confirmed,
    phase,
    code,
    kind,
    activity,
    explicitlyCompleted,
    preview:
      stamp.preview === true ||
      input.dryRun === true ||
      rawInput.dryRun === true ||
      data.dryRun === true ||
      input.preview === true,
    child: hasChildActivityScope(p),
    reportedModel: safeModel(p.reportedModel),
    activityPreview: extractedPreview.preview,
    delegation:
      stamp.delegation === true ||
      [p.toolName, data.toolName, item.tool].some(
        (name) => name === "workspace_delegate" || name === "mcp__t3-code__workspace_delegate",
      ),
  };
}
export function projectToolActivityOperation(
  activity: Activity,
): ToolActivityOperation | undefined {
  if (!lifecycle(activity.kind)) return;
  const r = inspect(activity, activity.kind, false);
  return {
    action: r.operation.action,
    ...(r.delegation ? { delegation: true } : {}),
    ...(r.commandDiagnostic ? { commandDiagnostic: r.commandDiagnostic } : {}),
    ...(r.operation.subject ? { subject: r.operation.subject } : {}),
    ...(r.operation.compound ? { compound: true } : {}),
    targetPaths: [...r.paths],
    phase: r.phase,
    ...(r.confirmed.size ? { confirmedDiffPaths: [...r.confirmed] } : {}),
    ...(r.code !== undefined ? { exitCode: r.code } : {}),
    ...(r.explicitlyCompleted ? { editCompletionReported: true } : {}),
    ...(r.preview ? { preview: true } : {}),
    ...(r.activityPreview ? { activityPreview: r.activityPreview } : {}),
  };
}
type Observation = ReturnType<typeof inspect> & { ambiguousAttempt?: true };

/** Join only a uniquely identified native call with one start and one completion at most. */
function resolveUnboundClaudeTurns(rows: Observation[]) {
  const unbound = new Set<string>();
  for (const r of rows) {
    if (!r.activity.turnId && r.nativeClaudeCall && r.callId) unbound.add(r.callId);
  }
  if (!unbound.size) return;
  const calls = new Map<
    string,
    {
      anchor?: Observation;
      unbound: Observation[];
      starts: number;
      ends: number;
      conflicting: boolean;
    }
  >();
  for (const r of rows) {
    if (!r.nativeClaudeCall || !r.callId || !unbound.has(r.callId)) continue;
    const key = JSON.stringify([...r.scope, r.callId]);
    let call = calls.get(key);
    if (!call) {
      call = { unbound: [], starts: 0, ends: 0, conflicting: false };
      calls.set(key, call);
    }
    if (r.kind === "tool.started") call.starts++;
    if (r.kind === "tool.completed") call.ends++;
    if (r.activity.turnId) {
      if (call.anchor && call.anchor.activity.turnId !== r.activity.turnId) call.conflicting = true;
      call.anchor = r;
    } else call.unbound.push(r);
  }
  for (const call of calls.values()) {
    if (!call.anchor || call.conflicting || call.starts > 1 || call.ends > 1) continue;
    for (const r of call.unbound) {
      r.activity = { ...r.activity, turnId: call.anchor.activity.turnId };
      r.key = call.anchor.key;
    }
  }
}

// SQLite can give several receipts the same time and no sequence. Only reorder the
// slots of the same verified invocation. Unrelated calls retain their original order.
function orderTiedReceipts(rows: Observation[]): Observation[] {
  function rank(kind: LifecycleKind) {
    return kind === "tool.started" ? 0 : kind === "tool.completed" ? 2 : 1;
  }
  for (let begin = 0; begin < rows.length; ) {
    const anchor = rows[begin]!.activity;
    let end = begin + 1;
    while (
      end < rows.length &&
      rows[end]!.activity.createdAt === anchor.createdAt &&
      rows[end]!.activity.sequence === anchor.sequence
    )
      end++;
    if (end > begin + 1) {
      const slots = new Map<string, number[]>();
      for (let i = begin; i < end; i++) {
        const key = rows[i]!.key;
        if (!key) continue;
        const indices = slots.get(key);
        if (indices) indices.push(i);
        else slots.set(key, [i]);
      }
      for (const indices of slots.values()) {
        if (indices.length < 2) continue;
        const tied = indices.map((i) => rows[i]!);
        const collision = ["tool.started", "tool.completed"].some(
          (k) => tied.filter((r) => r.kind === k).length > 1,
        );
        if (collision) {
          for (const row of tied) row.ambiguousAttempt = true;
          continue;
        }
        tied.sort(
          (a, b) =>
            rank(a.kind) - rank(b.kind) ||
            (a.activity.id < b.activity.id ? -1 : a.activity.id > b.activity.id ? 1 : 0),
        );
        indices.forEach((slot, i) => {
          rows[slot] = tied[i]!;
        });
      }
    }
    begin = end;
  }
  return rows;
}
const subjects: Record<ToolActivitySubject, string> = {
  diff: "차이 조회",
  "read-search": "파일 읽기·검색",
  "database-read": "읽기 전용 DB 조회",
  "repository-status": "저장소 상태 확인",
  "history-fetch": "Git 이력 가져오기",
  "history-read": "Git 이력 조회",
  "history-fetch-read": "Git 이력 가져오기·조회",
  test: "테스트 실행",
};
const actions: Record<ToolActivityAction, string> = {
  read: "파일 읽기",
  search: "자료 검색",
  list: "목록 조회",
  edit: "파일 편집",
  command: "명령 실행",
  other: "도구 실행",
};
const phases: Record<ToolActivityPhase, string> = {
  started: "시작",
  running: "진행 중",
  completed: "종료",
  failed: "실패",
  declined: "거절됨",
  stopped: "중단됨",
};

function describe(
  rows: readonly Observation[],
  models: ReadonlyMap<string, Model>,
  diffs: ReadonlyMap<string, ReadonlySet<string>>,
  block?: WorkspaceOrchestraBlock,
): ToolActivityGroup {
  const first = rows[0]!,
    last = rows.at(-1)!;
  const terminal = rows.find((row) => row.kind === "tool.completed");
  const paths = new Set<string>(),
    confirmed = new Set<string>(),
    reported = new Set<string>();
  let op = first.operation,
    phase = terminal?.phase ?? last.phase,
    explicit = false,
    preview = false,
    activityPreview: ToolActivityPreview | undefined;
  const events: ToolActivityEvent[] = [];
  for (const r of rows) {
    if (
      r.operation.subject ||
      (!op.subject &&
        (op.action === "other" ||
          (op.action === "command" && r.operation.action !== "other") ||
          (op.action === "edit" &&
            (r.operation.action === "read" ||
              r.operation.action === "list" ||
              r.operation.action === "search"))))
    )
      op = r.operation;
    if (!terminal && (unsuccessful(r.phase) || (phase === "started" && r.phase === "running")))
      phase = r.phase;
    if (r.explicitlyCompleted) explicit = true;
    if (r.preview) preview = true;
    activityPreview = mergeToolActivityPreview(activityPreview, r.activityPreview);
    if (r.reportedModel) reported.add(r.reportedModel);
    for (const path of r.paths) paths.add(path);
    if (!r.preview) for (const path of r.confirmed) confirmed.add(path);
    if (!r.preview && r.operation.action === "edit")
      for (const path of diffs.get(JSON.stringify([r.activity.turnId, r.activity.id])) ?? [])
        confirmed.add(path);
    events.push({
      id: r.activity.id,
      createdAt: r.activity.createdAt,
      kind: r.kind,
      phase: r.phase,
      ...(r.code !== undefined ? { exitCode: r.code } : {}),
    });
  }
  const p = object(first.activity.payload);
  const execution =
    block &&
    p.executionId === block.executionId &&
    p.messageId === block.messageId &&
    p.attempt === block.attempt &&
    !p.agentId &&
    !p.taskId &&
    !p.parentToolUseId &&
    (!p.providerInstanceId || p.providerInstanceId === block.modelSelection.instanceId)
      ? block
      : undefined;
  const turnModel =
    !first.child && first.activity.turnId ? models.get(first.activity.turnId) : undefined;
  const current =
    execution?.modelSelection ??
    (p.providerInstanceId && turnModel?.instanceId && p.providerInstanceId !== turnModel.instanceId
      ? undefined
      : turnModel);
  const assigned = safeModel(current?.model);
  const executorSource =
    reported.size === 1
      ? "provider-reported"
      : !reported.size && assigned
        ? execution
          ? "execution-assigned"
          : "turn-assigned"
        : "unknown";
  const account = safeModel(current?.instanceId);
  const modelLabel =
    executorSource === "provider-reported"
      ? `제공자 보고 · ${[...reported][0]}`
      : assigned && executorSource !== "unknown"
        ? `${execution ? "하위 작업 배정" : "턴 배정"} · ${account ? account + " · " : ""}${assigned}`
        : "작업 모델 확인 안 됨";
  const executorLabel = rows.some((row) => row.delegation)
    ? `위임 호출자 · ${modelLabel}`
    : first.child && executorSource === "provider-reported"
      ? `하위 작업 · ${modelLabel}`
      : modelLabel;
  const evidence = confirmed.size
    ? "confirmed-diff"
    : op.action === "edit" && !preview && phase === "completed" && explicit
      ? "tool-reported"
      : op.action === "edit" && (phase === "started" || phase === "running" || preview)
        ? "planned"
        : "observed";
  const label = op.subject ? subjects[op.subject] : actions[op.action];
  const compoundIntent = op.subject?.startsWith("history-")
    ? label + " 시도 · "
    : op.action === "command" && !op.subject
      ? ""
      : "요청에 " + label + " 포함 · ";
  const editSummary = activityPreview?.editSummary;
  const editVerb =
    editSummary?.mode === "create"
      ? "파일 생성"
      : editSummary?.mode === "delete"
        ? "파일 삭제"
        : editSummary?.mode === "move"
          ? "파일 이동"
          : "파일 수정";
  const editDeltaLabel =
    editSummary && (editSummary.addedLines !== undefined || editSummary.removedLines !== undefined)
      ? editSummary.mode === "create" && editSummary.addedLines !== undefined
        ? ` (+${editSummary.addedLines}줄)`
        : ` (+${editSummary.addedLines ?? 0}/-${editSummary.removedLines ?? 0}줄)`
      : "";
  const detail =
    evidence === "confirmed-diff"
      ? editSummary
        ? `${editVerb} · Diff 확인`
        : "변경 차이 확인"
      : evidence === "tool-reported"
        ? editSummary
          ? editVerb
          : "파일 수정"
        : evidence === "planned"
          ? "편집 요청 · 적용 확인 전"
          : op.action === "edit" && phase === "completed"
            ? editSummary
              ? editVerb
              : "편집 도구 종료 · 적용 확인 전"
            : op.compound
              ? `${compoundIntent}복합 명령 ${phases[phase]}`
              : op.action === "command" && !op.subject && activityPreview?.intent
                ? phase === "completed"
                  ? `명령 실행 · ${activityPreview.intent}`
                  : `명령 실행 ${phases[phase]} · ${activityPreview.intent}`
                : op.action === "read" && activityPreview?.lineRange && phase === "completed"
                  ? "파일 읽기"
                  : op.action === "search" && activityPreview?.searchQuery && phase === "completed"
                    ? `코드 검색 · "${activityPreview.searchQuery}"`
                    : `${label} ${phases[phase]}`;
  const targetPaths = [...paths];
  const targets = confirmed.size ? [...confirmed] : targetPaths;
  let summary = targets.length
    ? `${detail} · ${targets[0]}${targets.length > 1 ? ` 외 ${targets.length - 1}개` : ""}`
    : detail;
  if (op.action === "edit" && editDeltaLabel) {
    summary += editDeltaLabel;
  } else if (op.action === "read" && activityPreview?.lineRange) {
    summary += ` (${activityPreview.lineRange})`;
  }
  const failedCommand =
    phase === "failed" &&
    rows.some((r) => object(r.activity.payload).itemType === "command_execution");
  if (failedCommand) {
    const failures = rows.filter((r) => r.phase === "failed");
    const codes = new Set(failures.flatMap((r) => (r.code === undefined ? [] : [r.code])));
    const diagnostics = new Set(
      failures.flatMap((r) => (r.commandDiagnostic ? [r.commandDiagnostic] : [])),
    );
    if (codes.size === 1) summary += " · 종료 코드 " + [...codes][0];
    summary +=
      diagnostics.size === 1
        ? " · " + commandDiagnostics[[...diagnostics][0]!]
        : " · 구체적 원인 미확인";
  }
  if (events.some((event) => event.phase === "failed") && !detail.includes(phases.failed)) {
    summary += " · 실패 기록 있음";
  }
  return {
    id: first.activity.id,
    turnId: first.activity.turnId,
    createdAt: first.activity.createdAt,
    callId: first.callId,
    eventIds: events.map((e) => e.id),
    events,
    phase,
    action: op.action,
    ...(op.subject ? { subject: op.subject } : {}),
    ...(op.compound ? { compound: true } : {}),
    evidence,
    summary,
    summarySource: "local",
    executorSource,
    executorLabel,
    ...(failedCommand ? { commandFailureNote: "이 명령의 복구 여부 미확인" } : {}),
    targetPaths,
    confirmedDiffPaths: [...confirmed],
    ...(activityPreview ? { preview: activityPreview } : {}),
  };
}

/** Pass activities from exactly one thread. Titles, commands, and clock proximity never identify a call. */
export function groupToolActivities(
  activities: readonly Activity[],
  options: ToolActivityGroupOptions = {},
): ToolActivityGroup[] {
  const models = new Map(options.assignedModels);
  const conflictingTurns = new Set<string>();
  const diffs = new Map<string, Set<string>>();
  for (const d of options.confirmedDiffs ?? []) {
    const key = JSON.stringify([d.turnId, d.eventId]),
      paths = diffs.get(key) ?? new Set<string>();
    addPaths(paths, d.paths);
    diffs.set(key, paths);
  }
  const ordered = activities
    .filter((a) => lifecycle(a.kind) || a.kind === "conversation.turn-assigned")
    .toSorted(
      (a, b) => (a.sequence ?? -1) - (b.sequence ?? -1) || a.createdAt.localeCompare(b.createdAt),
    );
  const groups: Observation[][] = [],
    open = new Map<string, Observation[]>(),
    closed = new Map<string, Observation[]>(),
    ambiguous = new Set<string>(),
    latest = new Map(ordered.map((a) => [a.id, a]));
  const observations: Observation[] = [];
  for (const activity of ordered) {
    if (latest.get(activity.id) !== activity) continue;
    latest.delete(activity.id);
    if (activity.kind === "conversation.turn-assigned") {
      if (hasChildActivityScope(activity.payload)) continue;
      const p = object(activity.payload),
        model = safeModel(p.model),
        instanceId = safeModel(p.instanceId);
      if (activity.turnId && model && !conflictingTurns.has(activity.turnId)) {
        const prior = models.get(activity.turnId);
        if (
          prior &&
          (prior.model !== model ||
            (prior.instanceId && instanceId && prior.instanceId !== instanceId))
        ) {
          conflictingTurns.add(activity.turnId);
          models.delete(activity.turnId);
        } else
          models.set(activity.turnId, {
            model,
            ...(instanceId || prior?.instanceId
              ? { instanceId: instanceId ?? prior!.instanceId! }
              : {}),
          });
      }
      continue;
    }
    if (!lifecycle(activity.kind)) continue;
    observations.push(inspect(activity, activity.kind));
  }
  // An execution adapter can timestamp progress and completion before its start. With one
  // lifecycle per (execution, message, attempt, call) the IDs still identify the same work.
  // Reused IDs retain the ordinary start/retry/ambiguity handling below.
  resolveUnboundClaudeTurns(observations);
  const executionBoundaries = new Map<string, { starts: number; completions: number }>();
  const reusedExecutionCalls = new Set<string>();
  for (const row of observations) {
    if (
      !row.executionCall ||
      !row.key ||
      (row.kind !== "tool.started" && row.kind !== "tool.completed")
    )
      continue;
    const seen = executionBoundaries.get(row.key) ?? { starts: 0, completions: 0 };
    if (row.kind === "tool.started") seen.starts++;
    else seen.completions++;
    executionBoundaries.set(row.key, seen);
    if (seen.starts > 1 || seen.completions > 1) reusedExecutionCalls.add(row.key);
  }
  const executionCalls = new Map<string, Observation[]>();
  for (const row of orderTiedReceipts(observations)) {
    const key = row.key;
    if (key && row.executionCall && !reusedExecutionCalls.has(key)) {
      const call = executionCalls.get(key);
      if (call) call.push(row);
      else {
        const first = [row];
        groups.push(first);
        executionCalls.set(key, first);
      }
      continue;
    }
    if (key && row.ambiguousAttempt) {
      ambiguous.add(key);
      open.delete(key);
      closed.delete(key);
    }
    let group = key ? open.get(key) : undefined;
    // Some providers persist the final update and receipt at the same timestamp.
    // Retain a late update on the last explicitly identified call until another start.
    if (key && row.kind === "tool.started") closed.delete(key);
    if (
      key &&
      !group &&
      !ambiguous.has(key) &&
      (row.kind === "tool.updated" || row.kind === "tool.progress")
    ) {
      const finished = closed.get(key);
      if (finished) {
        finished.push(row);
        continue;
      }
    }
    if (key && group && row.kind === "tool.started") {
      ambiguous.add(key);
      open.delete(key);
      group = undefined;
    }
    if (!group) {
      group = [];
      groups.push(group);
    }
    group.push(row);
    if (!key || ambiguous.has(key)) continue;
    if (row.kind === "tool.completed") {
      open.delete(key);
      closed.set(key, group);
    } else open.set(key, group);
  }
  const described = groups.map((rows) => describe(rows, models, diffs, options.assignedExecution));
  if (!described.some((group) => group.commandFailureNote)) return described;
  // Show chronological outcomes of separate calls. A later success cannot establish recovery.
  const nextCommands = new Map<string, { start: string; group: ToolActivityGroup }>();
  for (let i = groups.length - 1; i >= 0; i--) {
    const rows = groups[i]!;
    const first = rows[0]!;
    const group = described[i]!;
    if (
      !group.turnId ||
      !group.callId ||
      object(first.activity.payload).itemType !== "command_execution"
    )
      continue;
    const scope = JSON.stringify([group.turnId, ...first.scope]);
    const next = nextCommands.get(scope);
    const end = rows.find((r) => r.kind === "tool.completed");
    if (
      group.commandFailureNote &&
      end &&
      next &&
      next.group.callId !== group.callId &&
      next.start > end.activity.createdAt
    ) {
      described[i] = {
        ...group,
        commandFailureNote:
          "이후 시작한 별도 명령 · " + phases[next.group.phase] + " · " + group.commandFailureNote,
      };
    }
    const start = rows.find((r) => r.kind === "tool.started");
    if (start) nextCommands.set(scope, { start: start.activity.createdAt, group });
  }
  return described;
}

export function buildToolActivityFacts(groups: readonly ToolActivityGroup[]): ToolActivityFact[] {
  return groups.map((g) => ({
    action: g.action,
    phase: g.phase,
    evidence: g.evidence,
    ...(g.subject ? { subject: g.subject } : {}),
    ...(g.compound ? { compound: true } : {}),
    targetCount: g.targetPaths.length,
    confirmedDiffCount: g.confirmedDiffPaths.length,
  }));
}

/** Display-only. An uncorrelated, nonterminal signal in a finished turn is still an individual
 * original event, accessible by its ID. It is never attached to a guessed invocation. */
export function partitionToolActivityGroups(
  groups: readonly ToolActivityGroup[],
  completedTurnIds: ReadonlySet<string>,
) {
  const visible: ToolActivityGroup[] = [];
  const technicalByTurn = new Map<string, ToolActivityGroup[]>();
  for (const group of groups) {
    if (
      group.turnId &&
      completedTurnIds.has(group.turnId) &&
      !group.callId &&
      (group.phase === "started" || group.phase === "running") &&
      group.confirmedDiffPaths.length === 0 &&
      group.events.every((e) => e.kind !== "tool.completed" && e.exitCode === undefined)
    ) {
      const existing = technicalByTurn.get(group.turnId);
      if (existing) existing.push(group);
      else technicalByTurn.set(group.turnId, [group]);
    } else visible.push(group);
  }
  return { visible, technicalByTurn };
}

export function selectToolActivitySummaryFamily(
  fact: ToolActivityFact,
  stableActivityId: string,
): "granite" | "qwen-coder" {
  if (
    fact.phase === "failed" ||
    fact.action === "edit" ||
    fact.subject === "diff" ||
    fact.evidence === "confirmed-diff"
  )
    return "qwen-coder";
  if (
    fact.subject === "test" ||
    fact.subject?.startsWith("history-") ||
    fact.action === "read" ||
    fact.action === "search" ||
    fact.action === "list"
  )
    return "granite";
  let hash = 2166136261;
  for (let i = 0; i < stableActivityId.length; i++)
    hash = Math.imul(hash ^ stableActivityId.charCodeAt(i), 16777619);
  return (hash & 1) === 0 ? "granite" : "qwen-coder";
}
