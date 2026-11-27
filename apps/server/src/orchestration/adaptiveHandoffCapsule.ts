// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import type {
  MessageId,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { applyMonorepoPathAliases, formatPipeTable } from "./contextAssemblyGate.ts";

export type AdaptiveHandoffProfile =
  | "profile-a-codex"
  | "profile-b-antigravity"
  | "profile-c-micro"
  | "profile-claude-return";

export interface ExploredCodeLedgerEntry {
  readonly path: string;
  readonly lineRanges: ReadonlyArray<string>;
  readonly status: "UNCHANGED" | "MODIFIED" | "REVERTED" | "CHANGED_ON_DISK";
  readonly sha256Short: string;
  readonly note?: string | undefined;
}

export interface AdaptiveHandoffCapsuleInput {
  readonly thread: Pick<
    OrchestrationThread,
    "id" | "projectId" | "messages" | "activities" | "proposedPlans" | "checkpoints"
  >;
  readonly currentMessageId?: MessageId | undefined;
  readonly targetDriverKind: ProviderDriverKind | string;
  readonly targetModel?: string | undefined;
  readonly cwd?: string | undefined;
  readonly workingTreeDiffStat?: string | undefined;
  readonly archiveRef?: string | undefined;
  readonly priorProvider?: string | undefined;
}

export interface AdaptiveHandoffCapsuleResult {
  readonly profile: AdaptiveHandoffProfile;
  readonly text: string;
  readonly ledger: ReadonlyArray<ExploredCodeLedgerEntry>;
  readonly chars: number;
}

export function resolveAdaptiveHandoffProfile(
  targetDriverKind: string,
  targetModel?: string,
  priorProvider?: string,
): AdaptiveHandoffProfile {
  const lowerModel = (targetModel ?? "").toLowerCase();
  if (lowerModel.includes("haiku") || lowerModel.includes("flash-lite")) {
    return "profile-c-micro";
  }
  if (targetDriverKind === "codex") return "profile-a-codex";
  if (targetDriverKind === "gemini") return "profile-b-antigravity";
  if (targetDriverKind === "claudeAgent" && priorProvider && priorProvider !== "claudeAgent") {
    return "profile-claude-return";
  }
  if (
    targetDriverKind === "muse" ||
    targetDriverKind === "opencode" ||
    targetDriverKind === "grok" ||
    targetDriverKind === "cursor"
  ) {
    return "profile-c-micro";
  }
  return "profile-a-codex";
}

function normalizeRelPath(rawPath: string, cwd?: string): string {
  const cleaned = rawPath.trim().replaceAll("\\", "/");
  if (!cwd) return cleaned;
  const normCwd = cwd.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
  if (cleaned.toLowerCase().startsWith(`${normCwd.toLowerCase()}/`)) {
    return cleaned.slice(normCwd.length + 1);
  }
  return cleaned;
}

function computeFileSha256Short(relPath: string, cwd?: string): string {
  if (!cwd) return "-";
  try {
    const abs = NodePath.isAbsolute(relPath) ? relPath : NodePath.join(cwd, relPath);
    const stat = NodeFs.statSync(abs);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return "-";
    const buf = NodeFs.readFileSync(abs);
    return NodeCrypto.createHash("sha256").update(buf).digest("hex").slice(0, 8);
  } catch {
    return "-";
  }
}

interface MutableLedgerRow {
  ranges: Array<[number, number]>;
  fullRead: boolean;
  status: "UNCHANGED" | "MODIFIED" | "REVERTED";
  note?: string;
}

function mergeLineRanges(ranges: ReadonlyArray<[number, number]>, fullRead: boolean): string[] {
  if (fullRead) return ["FULL"];
  if (ranges.length === 0) return ["*"];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 2) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged.slice(0, 4).map(([s, e]) => `L${s}-${e}`);
}

/**
 * Algebraically folds file-related thread activities & checkpoints into a compact
 * `EXPLORED_CODE_LEDGER (DO_NOT_REREAD)`:
 * - `Read + Read` -> merged line range union
 * - `Read -> Edit/Write` -> `MODIFIED`
 * - `Edit -> Revert` -> `REVERTED`
 */
export function foldExploredCodeLedger(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly checkpoints?: OrchestrationThread["checkpoints"] | undefined;
  readonly cwd?: string | undefined;
  readonly maxEntries?: number | undefined;
}): ReadonlyArray<ExploredCodeLedgerEntry> {
  const byPath = new Map<string, MutableLedgerRow>();

  const ensure = (rawPath: string): MutableLedgerRow | undefined => {
    const rel = normalizeRelPath(rawPath, input.cwd);
    if (!rel || rel.length > 260) return undefined;
    let row = byPath.get(rel);
    if (!row) {
      row = { ranges: [], fullRead: false, status: "UNCHANGED" };
      byPath.set(rel, row);
    }
    return row;
  };

  for (const activity of input.activities) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    const rawPath =
      (typeof payload?.path === "string" && payload.path) ||
      (typeof payload?.filePath === "string" && payload.filePath) ||
      (typeof payload?.file_path === "string" && payload.file_path) ||
      undefined;
    if (!rawPath) continue;
    const row = ensure(rawPath);
    if (!row) continue;

    const toolName = String(
      payload?.toolName ?? payload?.tool ?? activity.kind ?? "",
    ).toLowerCase();
    const isRevert =
      activity.kind.includes("revert") ||
      toolName.includes("revert") ||
      /revert|rollback|되돌림/iu.test(activity.summary);
    const isEdit =
      !isRevert &&
      (/(?:edit|write|patch|create|modify|replace)/iu.test(toolName) ||
        activity.kind.includes("file.modified"));

    if (isRevert) {
      row.status = "REVERTED";
      row.note = "reverted";
    } else if (isEdit) {
      row.status = "MODIFIED";
    }

    const startLine =
      typeof payload?.startLine === "number"
        ? payload.startLine
        : typeof payload?.offset === "number"
          ? payload.offset
          : undefined;
    const endLine =
      typeof payload?.endLine === "number"
        ? payload.endLine
        : startLine !== undefined && typeof payload?.limit === "number"
          ? startLine + payload.limit
          : undefined;
    if (startLine !== undefined && endLine !== undefined && startLine > 0 && endLine >= startLine) {
      row.ranges.push([startLine, endLine]);
    } else if (!isEdit && !isRevert) {
      row.fullRead = true;
    }
  }

  for (const cp of input.checkpoints ?? []) {
    for (const file of cp.files ?? []) {
      const row = ensure(file.path);
      if (row) {
        row.status = "MODIFIED";
        row.note = `+${file.additions}/-${file.deletions}`;
      }
    }
  }

  const limit = input.maxEntries ?? 18;
  const entries: ExploredCodeLedgerEntry[] = [];
  for (const [relPath, row] of byPath.entries()) {
    if (entries.length >= limit) break;
    const sha256Short = computeFileSha256Short(relPath, input.cwd);
    entries.push({
      path: relPath,
      lineRanges: mergeLineRanges(row.ranges, row.fullRead),
      status: row.status,
      sha256Short,
      ...(row.note ? { note: row.note } : {}),
    });
  }
  return entries;
}

const DECISION_PATTERN =
  /(?:때문에|이유로|채택|결정|전환|고정|하기로\s*했|선택했|ADR|decided|chosen)/iu;
const REJECTION_PATTERN =
  /(?:기각|제외|보류|금지|실패해서|안\s*하기로|불가|rejected|failed\s+because|do\s+not\s+use)/iu;
const ASSISTANT_FILLER_LINE =
  /^(?:안녕하세요|알겠습니다|네,\s*확인|잠시만|진행해\s*보겠습니다|검토하겠습니다|감사합니다|도움이\s*되셨)/iu;

function cleanLine(text: string, maxChars: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > maxChars ? `${single.slice(0, maxChars - 1)}…` : single;
}

function readTargetCodeSlice(
  relPath: string,
  cwd: string | undefined,
  maxLines = 45,
): string | null {
  if (!cwd) return null;
  try {
    const abs = NodePath.isAbsolute(relPath) ? relPath : NodePath.join(cwd, relPath);
    const stat = NodeFs.statSync(abs);
    if (!stat.isFile() || stat.size > 512 * 1024) return null;
    const lines = NodeFs.readFileSync(abs, "utf8").split(/\r?\n/);
    const slice = lines.slice(0, maxLines).join("\n").trim();
    return slice
      ? `--- ${relPath} (L1-${Math.min(lines.length, maxLines)}/${lines.length}) ---\n${slice}`
      : null;
  } catch {
    return null;
  }
}

/**
 * Compiles a deterministic, zero-LLM 6-slot `adaptive_capsule` tailored to the
 * receiving provider's tier and caching geometry.
 *
 * Strictly preserves verbatim user requirements and genuine errors/refusals while
 * removing repetitive assistant filler chatter and preventing redundant file re-reads.
 */
export function buildAdaptiveHandoffCapsule(
  input: AdaptiveHandoffCapsuleInput,
): AdaptiveHandoffCapsuleResult {
  const profile = resolveAdaptiveHandoffProfile(
    input.targetDriverKind,
    input.targetModel,
    input.priorProvider,
  );
  const cutoffIdx =
    input.currentMessageId !== undefined
      ? input.thread.messages.findIndex((m) => m.id === input.currentMessageId)
      : input.thread.messages.length;
  const boundedMessages = (
    cutoffIdx >= 0 ? input.thread.messages.slice(0, cutoffIdx) : input.thread.messages
  ).filter((m) => !m.streaming && m.text.trim().length > 0);

  const userMessages = boundedMessages.filter((m) => m.role === "user");
  const assistantMessages = boundedMessages.filter((m) => m.role === "assistant");

  const maxUserItems = profile === "profile-c-micro" ? 3 : 5;
  const recentUsers = userMessages.slice(-maxUserItems);
  const firstUser = userMessages[0];
  const preservedUsers =
    firstUser && !recentUsers.some((m) => m.id === firstUser.id)
      ? [firstUser, ...recentUsers]
      : recentUsers;

  const decisions: string[] = [];
  const rejections: string[] = [];
  const seen = new Set<string>();
  for (const msg of boundedMessages) {
    const lines = msg.text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 8);
    for (const line of lines) {
      if (msg.role === "assistant" && ASSISTANT_FILLER_LINE.test(line)) continue;
      const key = line.toLowerCase().slice(0, 80);
      if (seen.has(key)) continue;
      if (REJECTION_PATTERN.test(line) && rejections.length < 5) {
        seen.add(key);
        rejections.push(`- [${msg.role}] ${cleanLine(line, 180)}`);
      } else if (DECISION_PATTERN.test(line) && decisions.length < 6) {
        seen.add(key);
        decisions.push(`- [${msg.role}] ${cleanLine(line, 180)}`);
      }
    }
  }

  const ledger = foldExploredCodeLedger({
    activities: input.thread.activities,
    checkpoints: input.thread.checkpoints,
    cwd: input.cwd,
    maxEntries: profile === "profile-c-micro" ? 8 : 16,
  });

  const errorActivities = input.thread.activities
    .filter((a) => a.tone === "error")
    .slice(-3)
    .map((a) => `- [${a.kind}] ${cleanLine(a.summary, 180)}`);

  const latestAssistant = assistantMessages.at(-1);
  const latestAssistantSummary = latestAssistant
    ? latestAssistant.text
        .split(/\r?\n/)
        .filter((l) => !ASSISTANT_FILLER_LINE.test(l.trim()))
        .join("\n")
        .trim()
        .slice(0, profile === "profile-c-micro" ? 600 : 1_200)
    : "";

  const latestPlan = input.thread.proposedPlans.at(-1);

  const rawSections: string[] = [];
  rawSections.push(
    `<t3_adaptive_handoff profile="${profile}">`,
    profile === "profile-a-codex"
      ? "모델 인계 캡슐(Codex 직실행): 아래 사용자 원문 목표·기각 이력·탐색 원장을 근거로 중복 Read 없이 즉시 작업하라."
      : profile === "profile-b-antigravity"
        ? "모델 인계 캡슐(Antigravity 1-Shot): UNCHANGED 파일 전체 재열람을 피하고 동봉 슬라이스·원장을 바탕으로 바로 해법을 수행하라."
        : profile === "profile-claude-return"
          ? "복귀 완료 캡슐(Claude KV 캐시 보존): 보조 모델 작업 결과 요약이다. 변경점과 검증 상태만 이어받아 마무리하라."
          : "마이크로 인계 브리프: 단일 다음 작업에 집중하고 UNCHANGED 파일 재읽기를 생략하라.",
  );

  if (preservedUsers.length > 0) {
    rawSections.push(
      "[OBJECTIVE & USER INVARIANTS]",
      ...preservedUsers.map((m) => `- [user:${m.id}] ${cleanLine(m.text, 600)}`),
    );
  }

  if (decisions.length > 0 || rejections.length > 0) {
    rawSections.push("[DECISIONS & REJECTED APPROACHES]", ...decisions, ...rejections);
  }

  if (ledger.length > 0) {
    const ledgerTable = formatPipeTable(
      ["path", "ranges", "status", "sha256", "note"],
      ledger.map((e) => [e.path, e.lineRanges.join(","), e.status, e.sha256Short, e.note ?? "-"]),
    );
    rawSections.push("[EXPLORED_CODE_LEDGER — DO_NOT_REREAD UNCHANGED FILES]", ledgerTable);
  }

  if (input.workingTreeDiffStat?.trim()) {
    rawSections.push(
      "[ACTIVE WORKING TREE DIFF]",
      input.workingTreeDiffStat.trim().slice(0, 1_000),
    );
  }

  if (errorActivities.length > 0 || latestAssistantSummary) {
    rawSections.push("[VERIFICATION & LATEST STATE]");
    if (errorActivities.length > 0) rawSections.push(...errorActivities);
    if (latestAssistantSummary) rawSections.push(`최근 보고 발췌: ${latestAssistantSummary}`);
  }

  if (profile === "profile-b-antigravity" && input.cwd && ledger.length > 0) {
    const modifiedTargets = ledger.filter((e) => e.status === "MODIFIED").slice(0, 2);
    const slices = modifiedTargets
      .map((entry) => readTargetCodeSlice(entry.path, input.cwd, 40))
      .filter((s): s is string => s !== null);
    if (slices.length > 0) {
      rawSections.push("[INLINE TARGET SLICES]", ...slices);
    }
  }

  if (latestPlan && !latestPlan.implementedAt) {
    rawSections.push("[ACTIVE PLAN]", cleanLine(latestPlan.planMarkdown, 400));
  }

  if (input.archiveRef) {
    rawSections.push(`[ARCHIVE REF] ${input.archiveRef} (누락 사실이 필요할 때만 조회)`);
  }
  rawSections.push("</t3_adaptive_handoff>");

  const joined = rawSections.join("\n");
  const aliased = applyMonorepoPathAliases(joined, 2);
  const finalText = aliased.header
    ? aliased.text.replace(
        `<t3_adaptive_handoff profile="${profile}">`,
        `<t3_adaptive_handoff profile="${profile}">\n${aliased.header}`,
      )
    : aliased.text;

  return {
    profile,
    text: finalText,
    ledger,
    chars: finalText.length,
  };
}

/**
 * Compact Boomerang / `workspace_delegate` Fan-in receipt (<= 1,800 chars, ~450-750 tok)
 * so returning control to Claude never blows away Claude's resident KV prefix cache.
 */
export function buildReturnCompletionCapsule(input: {
  readonly workerLabel: string;
  readonly changedFiles: ReadonlyArray<string>;
  readonly diffSummary: string;
  readonly verificationSummary: string;
  readonly openIssues?: ReadonlyArray<string> | undefined;
}): string {
  const lines = [
    `<t3_return_capsule worker="${input.workerLabel}">`,
    `- changed_files: ${input.changedFiles.length > 0 ? input.changedFiles.slice(0, 12).join(", ") : "(none)"}`,
    `- diff_summary: ${cleanLine(input.diffSummary, 500)}`,
    `- verification: ${cleanLine(input.verificationSummary, 400)}`,
    ...(input.openIssues && input.openIssues.length > 0
      ? [
          `- open_issues: ${input.openIssues
            .slice(0, 4)
            .map((i) => cleanLine(i, 160))
            .join(" | ")}`,
        ]
      : []),
    "</t3_return_capsule>",
  ];
  const aliased = applyMonorepoPathAliases(lines.join("\n"), 2);
  return aliased.header ? `${aliased.header}\n${aliased.text}` : aliased.text;
}
