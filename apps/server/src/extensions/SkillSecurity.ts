// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import type { SkillSecurityReport } from "@t3tools/contracts";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 512;
const MAX_DEPTH = 32;
const MAX_FINDINGS = 200;
const MAX_SKIPS = 200;
const MAX_LINES = 50_000;
const MAX_LINE_CHARS = 64 * 1024;

type Finding = SkillSecurityReport["findings"][number];
type Skip = SkillSecurityReport["skipped"][number];
type OpenFile = (path: string, flags: number) => Promise<NodeFSP.FileHandle>;
const openFile: OpenFile = (path, flags) => NodeFSP.open(path, flags);

// Never put source text, absolute paths, URLs, or exception messages in a report.
function displayPath(relative: string): string {
  if (!relative) return ".";
  if (
    NodePath.isAbsolute(relative) ||
    /^[a-z]:[\\/]/iu.test(relative) ||
    relative.startsWith("\\\\")
  )
    return "[경로 숨김]";
  return relative
    .split(/[\\/]/u)
    .map((part) =>
      part.length > 100 ||
      Array.from(part).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      /[\u202a-\u202e\u2066-\u2069]/u.test(part) ||
      /[:?@#]/u.test(part) ||
      /(?:password|secret|token|api[_-]?key)[=_-][a-z0-9_-]{6,}/iu.test(part) ||
      /(?:^|[^a-z0-9])(?:sk|ghp|github_pat|xox[baprs])[-_][a-z0-9_-]{12,}/iu.test(part) ||
      /(?:^|[^a-z0-9])(?:akia|asia)[a-z0-9]{16}(?:[^a-z0-9]|$)/iu.test(part) ||
      /[a-z0-9_+=-]{32,}/iu.test(part)
        ? "[이름 숨김]"
        : part,
    )
    .join("/");
}

function inside(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return (
    relative === "" ||
    (!NodePath.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`))
  );
}

/** Verify that the staged entrypoint is a readable, unchanged regular file. */
export async function validateStagedSkillDocument(
  root: string,
  open: OpenFile = openFile,
): Promise<{ digest: string; version?: string }> {
  const rootStat = await NodeFSP.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("invalid skill root");
  const rootReal = await NodeFSP.realpath(root);
  const file = NodePath.join(root, "SKILL.md");
  const before = await NodeFSP.lstat(file);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink > 1 ||
    !inside(rootReal, await NodeFSP.realpath(file))
  )
    throw new Error("invalid skill document");
  const handle = await open(file, NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink > 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      throw new Error("changed skill document");
    const hash = NodeCrypto.createHash("sha256");
    const bytes = Buffer.allocUnsafe(64 * 1024);
    const header: Buffer[] = [];
    let headerBytes = 0;
    let offset = 0;
    while (offset < before.size) {
      const result = await handle.read(
        bytes,
        0,
        Math.min(bytes.length, before.size - offset),
        offset,
      );
      if (!result.bytesRead) throw new Error("unreadable skill document");
      hash.update(bytes.subarray(0, result.bytesRead));
      if (headerBytes < 64_000) {
        const part = Buffer.from(
          bytes.subarray(0, Math.min(result.bytesRead, 64_000 - headerBytes)),
        );
        header.push(part);
        headerBytes += part.length;
      }
      offset += result.bytesRead;
    }
    const extra = await handle.read(bytes, 0, 1, offset);
    const after = await handle.stat();
    const current = await NodeFSP.lstat(file);
    if (
      extra.bytesRead ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("changed skill document");
    const version = /^\s*version:\s*["']?([^\r\n"']+)["']?\s*$/mu
      .exec(Buffer.concat(header).toString("utf8").slice(0, 16_000))?.[1]
      ?.trim();
    const safeVersion =
      version &&
      /^[a-z0-9][a-z0-9._+ -]{0,63}$/iu.test(version) &&
      !/(?:password|secret|token|api[_-]?key|credential)/iu.test(version) &&
      !/^(?:(?:sk|ghp|github_pat|xox[baprs])[-_][a-z0-9_-]{12,}|akia[a-z0-9]{16})$/iu.test(
        version,
      ) &&
      !/[a-z0-9_+=-]{32,}/iu.test(version)
        ? version
        : undefined;
    return { digest: hash.digest("hex"), ...(safeVersion ? { version: safeVersion } : {}) };
  } finally {
    await handle.close();
  }
}

const rules: ReadonlyArray<{ kind: Finding["kind"]; pattern: RegExp }> = [
  {
    kind: "instruction-override",
    pattern:
      /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+(?:instructions?|rules?|prompts?)|(?:이전|시스템|개발자)\s*(?:지시|규칙|명령).{0,20}무시/iu,
  },
  { kind: "hidden-text", pattern: /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u },
  {
    kind: "download-execution",
    pattern:
      /\b(?:curl|wget|invoke-webrequest|iwr)\b.{0,300}(?:\|\s*(?:ba?sh|zsh|sh|cmd|powershell|pwsh)\b|(?:&&|;)\s*(?:ba?sh|sh|cmd|powershell|pwsh)\b)/iu,
  },
  {
    kind: "credential-access",
    pattern:
      /(?:~[/\\]|\$HOME[/\\]|%USERPROFILE%[/\\])\.(?:ssh|aws|config[/\\]gcloud)|\b(?:process\.env|os\.environ|\$env:)\s*(?:\[\s*["']?)?(?:[a-z0-9_]*(?:api[_-]?key|token|secret|password|credential))/iu,
  },
  {
    kind: "embedded-secret",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"'\s]{12,}["']|\b(?:sk|ghp|github_pat|xox[baprs])[-_][a-z0-9_-]{16,}|\b(?:akia|asia)[a-z0-9]{16}\b/iu,
  },
  {
    kind: "encoded-execution",
    pattern:
      /(?:eval|exec|invoke-expression|iex)\s*\(?\s*(?:atob|base64|buffer\.from|\[text\.encoding\]|frombase64string)/iu,
  },
  {
    kind: "permission-change",
    pattern:
      /--dangerously-skip-permissions\b|\bbypassPermissions\b|\bapproval_policy\s*[:=]\s*["']never["']/iu,
  },
];
const network =
  /\b(?:fetch|axios|curl|wget|invoke-webrequest|iwr|requests\.(?:post|put)|https?\.request|sendBeacon)\s*\(?|https?:\/\//iu;

export function failedSkillSecurityScan(): SkillSecurityReport {
  return {
    version: 1,
    complete: false,
    scannedFiles: 0,
    findings: [],
    skipped: [{ reason: "scan-error", file: "." }],
  };
}

/** Inspect a staged skill as data only. No source content is returned in the report. */
export async function inspectSkillSecurity(
  root: string,
  open: OpenFile = openFile,
): Promise<{ report: SkillSecurityReport }> {
  const findings: Finding[] = [];
  const skipped: Skip[] = [];
  let complete = true;
  let scannedFiles = 0;
  let total = 0;
  let entries = 0;
  const skip = (reason: Skip["reason"], file: string) => {
    complete = false;
    if (skipped.length < MAX_SKIPS) skipped.push({ reason, file: displayPath(file) });
  };
  const addFinding = (kind: Finding["kind"], file: string, line: number) => {
    if (findings.length >= MAX_FINDINGS) {
      if (complete || !skipped.some((item) => item.reason === "finding-limit"))
        skip("finding-limit", ".");
      return;
    }
    findings.push({ kind, file: displayPath(file), line });
  };

  let rootReal: string;
  try {
    const stat = await NodeFSP.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      skip(stat.isSymbolicLink() ? "symlink" : "non-regular", ".");
      return { report: { version: 1, complete, scannedFiles, findings, skipped } };
    }
    rootReal = await NodeFSP.realpath(root);
  } catch {
    return { report: failedSkillSecurityScan() };
  }

  const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) {
      skip("depth-limit", relative);
      return;
    }
    let dir: NodeFS.Dir;
    try {
      const stat = await NodeFSP.lstat(directory);
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        !inside(rootReal, await NodeFSP.realpath(directory))
      ) {
        skip("symlink", relative);
        return;
      }
      dir = await NodeFSP.opendir(directory);
    } catch {
      skip("unreadable", relative);
      return;
    }
    try {
      for await (const entry of dir) {
        if (++entries > MAX_ENTRIES) {
          skip("file-limit", relative);
          return;
        }
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const full = NodePath.join(directory, entry.name);
        let before: NodeFS.Stats;
        try {
          before = await NodeFSP.lstat(full);
        } catch {
          skip("unreadable", childRelative);
          continue;
        }
        if (entry.isSymbolicLink() || before.isSymbolicLink()) {
          skip("symlink", childRelative);
          continue;
        }
        if (before.isDirectory()) {
          await walk(full, childRelative, depth + 1);
          continue;
        }
        if (!before.isFile() || before.nlink > 1) {
          skip("non-regular", childRelative);
          continue;
        }
        if (before.size > MAX_FILE_BYTES) {
          skip("too-large", childRelative);
          continue;
        }
        if (total + before.size > MAX_TOTAL_BYTES) {
          skip("total-limit", childRelative);
          continue;
        }
        let handle: NodeFSP.FileHandle | undefined;
        try {
          if (!inside(rootReal, await NodeFSP.realpath(full))) {
            skip("symlink", childRelative);
            continue;
          }
          handle = await open(full, NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0));
          const opened = await handle.stat();
          if (
            !opened.isFile() ||
            opened.nlink > 1 ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            opened.size !== before.size
          ) {
            skip("changed", childRelative);
            continue;
          }
          const bytes = Buffer.alloc(before.size + 1);
          let length = 0;
          while (length < bytes.length) {
            const read = await handle.read(bytes, length, bytes.length - length, length);
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          const after = await handle.stat();
          const current = await NodeFSP.lstat(full);
          if (
            length !== before.size ||
            !current.isFile() ||
            current.isSymbolicLink() ||
            current.dev !== before.dev ||
            current.ino !== before.ino ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs
          ) {
            skip("changed", childRelative);
            continue;
          }
          total += length;
          let text: string;
          try {
            if (bytes.subarray(0, length).includes(0)) throw new Error("binary");
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
          } catch {
            skip("encoding", childRelative);
            continue;
          }
          scannedFiles++;
          let credentialLine = 0;
          let networkLine = 0;
          let start = 0;
          let lineNumber = 0;
          while (start <= text.length) {
            if (++lineNumber > MAX_LINES) {
              skip("line-limit", childRelative);
              break;
            }
            const endMatch = /\r\n|\n|\r/gu;
            endMatch.lastIndex = start;
            const end = endMatch.exec(text);
            const next = end?.index ?? text.length;
            const line = text.slice(start, Math.min(next, start + MAX_LINE_CHARS));
            if (next - start > MAX_LINE_CHARS) skip("line-length", childRelative);
            for (const rule of rules)
              if (rule.pattern.test(line)) {
                addFinding(rule.kind, childRelative, lineNumber);
                if (rule.kind === "credential-access") credentialLine ||= lineNumber;
              }
            if (!networkLine && network.test(line)) networkLine = lineNumber;
            if (!end) break;
            start = endMatch.lastIndex;
          }
          if (credentialLine && networkLine)
            addFinding("credential-network", childRelative, networkLine);
        } catch {
          skip("unreadable", childRelative);
        } finally {
          await handle?.close().catch(() => {});
        }
      }
    } catch {
      skip("unreadable", relative);
    }
  };
  await walk(root, "", 0);
  return {
    report: { version: 1, complete, scannedFiles, findings, skipped },
  };
}
