// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type { QueryComplexityProfile } from "./workspacePromptTokens.ts";

export interface ContextAssemblyPlanInput {
  readonly skipWorkspaceRetrieval: boolean;
  readonly hasNativeHistory: boolean;
  readonly needsHandoff: boolean;
  readonly userInitiated: boolean;
  readonly complexityProfile: QueryComplexityProfile;
  readonly routingGraphReady?: boolean | undefined;
  readonly hasHandoffPayload?: boolean | undefined;
}

export interface ContextAssemblyPlan {
  readonly mode:
    | "skipped"
    | "handoff-minimal"
    | "native-continuation-graph"
    | "native-continuation"
    | "fresh-session-graph"
    | "fresh-session";
  readonly includeWorkspacePrompt: boolean;
  readonly includeRag: boolean;
  readonly includeWorkingMemory: boolean;
  readonly includeLongTermMemory: boolean;
  readonly workspacePromptMaxChars: number;
  readonly includeMemoryContext: boolean;
  readonly excludeRecentConversation: boolean;
  readonly includeRoutingMoc: boolean;
  readonly hardInjectedContextBudgetChars: number;
}

/**
 * Single mutual-exclusion gate for turn prompt assembly.
 *
 * Guarantees that a single turn never stacks duplicate `composeWorkspacePrompt`
 * RAG chunks (16 KB) + `<t3_memory_v2>` (14 KB) + `<t3_recent_conversation>` (16 KB)
 * + `<t3_conversation_handoff>` (16 KB) simultaneously.
 */
export function planContextAssembly(input: ContextAssemblyPlanInput): ContextAssemblyPlan {
  if (input.skipWorkspaceRetrieval) {
    return {
      mode: "skipped",
      includeWorkspacePrompt: false,
      includeRag: false,
      includeWorkingMemory: false,
      includeLongTermMemory: false,
      workspacePromptMaxChars: 0,
      includeMemoryContext: false,
      excludeRecentConversation: true,
      includeRoutingMoc: false,
      hardInjectedContextBudgetChars: 4_000,
    };
  }

  const isTrivial = input.complexityProfile === "trivial";
  const graphReady = input.routingGraphReady === true;

  // Model / provider switch with a structured handoff payload:
  // Handoff already carries recent decisions, code ledger, and diff. Keep only
  // mandatory directives from workspacePrompt and never re-inject 16 KB raw chat.
  if (input.needsHandoff && input.hasHandoffPayload !== false) {
    return {
      mode: "handoff-minimal",
      includeWorkspacePrompt: true,
      includeRag: false,
      includeWorkingMemory: false,
      includeLongTermMemory: false,
      workspacePromptMaxChars: 3_000,
      includeMemoryContext: !graphReady,
      excludeRecentConversation: true,
      includeRoutingMoc: graphReady,
      hardInjectedContextBudgetChars: 24_000,
    };
  }

  // Same-provider native continuation: provider already holds prior messages[].
  if (input.hasNativeHistory && input.userInitiated && !input.needsHandoff) {
    if (graphReady) {
      return {
        mode: "native-continuation-graph",
        includeWorkspacePrompt: true,
        includeRag: false,
        includeWorkingMemory: false,
        includeLongTermMemory: false,
        workspacePromptMaxChars: 2_800,
        includeMemoryContext: false,
        excludeRecentConversation: true,
        includeRoutingMoc: !isTrivial,
        hardInjectedContextBudgetChars: isTrivial ? 4_000 : 8_000,
      };
    }

    const continuationChars =
      input.complexityProfile === "trivial"
        ? 2_500
        : input.complexityProfile === "focused-lookup"
          ? 6_000
          : input.complexityProfile === "standard-dev"
            ? 8_000
            : 12_000;

    return {
      mode: "native-continuation",
      includeWorkspacePrompt: true,
      includeRag: !isTrivial,
      includeWorkingMemory: !isTrivial,
      includeLongTermMemory: !isTrivial,
      workspacePromptMaxChars: continuationChars,
      includeMemoryContext: true,
      excludeRecentConversation: true,
      includeRoutingMoc: false,
      hardInjectedContextBudgetChars:
        input.complexityProfile === "deep-architectural" ? 18_000 : 12_000,
    };
  }

  // Fresh session without native history: rehydrate bounded context.
  if (graphReady) {
    return {
      mode: "fresh-session-graph",
      includeWorkspacePrompt: true,
      includeRag: false,
      includeWorkingMemory: !isTrivial,
      includeLongTermMemory: false,
      workspacePromptMaxChars: 4_000,
      includeMemoryContext: true,
      excludeRecentConversation: false,
      includeRoutingMoc: !isTrivial,
      hardInjectedContextBudgetChars: 16_000,
    };
  }

  const freshChars =
    input.complexityProfile === "trivial"
      ? 4_000
      : input.complexityProfile === "focused-lookup"
        ? 9_000
        : input.complexityProfile === "standard-dev"
          ? 11_000
          : 15_000;

  return {
    mode: "fresh-session",
    includeWorkspacePrompt: true,
    includeRag: !isTrivial,
    includeWorkingMemory: !isTrivial,
    includeLongTermMemory: !isTrivial,
    workspacePromptMaxChars: freshChars,
    includeMemoryContext: true,
    excludeRecentConversation: false,
    includeRoutingMoc: false,
    hardInjectedContextBudgetChars:
      input.complexityProfile === "deep-architectural" ? 24_000 : 16_000,
  };
}

/**
 * Clips injected context overhead while strictly preserving the user's raw message
 * verbatim. Returns the trimmed context block and whether clipping occurred.
 */
export function clipInjectedContextToBudget(
  injectedContext: string,
  maxChars: number,
): { readonly text: string; readonly clipped: boolean; readonly savedChars: number } {
  if (maxChars <= 0) {
    return { text: "", clipped: injectedContext.length > 0, savedChars: injectedContext.length };
  }
  if (injectedContext.length <= maxChars) {
    return { text: injectedContext, clipped: false, savedChars: 0 };
  }
  const marker =
    "\n[… 예산 상한으로 후행 참고 문맥 생략 — 필요 시 workspace_memory search/read 조회]";
  const keep = Math.max(0, maxChars - marker.length);
  const clippedText = `${injectedContext.slice(0, keep).trimEnd()}${marker}`;
  return {
    text: clippedText,
    clipped: true,
    savedChars: Math.max(0, injectedContext.length - clippedText.length),
  };
}

const DEFAULT_MONOREPO_PATH_ALIASES: ReadonlyArray<readonly [alias: string, prefix: string]> = [
  ["@orch", "apps/server/src/orchestration/"],
  ["@prov", "apps/server/src/provider/"],
  ["@pers", "apps/server/src/persistence/"],
  ["@mcp", "apps/server/src/mcp/"],
  ["@srv", "apps/server/src/"],
  ["@web", "apps/web/src/"],
  ["@desk", "apps/desktop/src/"],
  ["@pkg", "packages/"],
];

/**
 * Replaces repeated long monorepo directory prefixes with compact `@Alias` macros
 * when an alias appears at least `minOccurrences` times (default 2) so BPE tokens
 * are saved without sacrificing exact path recoverability.
 */
export function applyMonorepoPathAliases(
  text: string,
  minOccurrences = 2,
): {
  readonly text: string;
  readonly header: string;
  readonly appliedAliases: ReadonlyArray<string>;
} {
  const normalized = text.replaceAll("\\", "/");
  let working = normalized;
  const applied: Array<string> = [];

  for (const [alias, prefix] of DEFAULT_MONOREPO_PATH_ALIASES) {
    let count = 0;
    let idx = working.indexOf(prefix);
    while (idx !== -1) {
      count += 1;
      idx = working.indexOf(prefix, idx + prefix.length);
    }
    if (count >= minOccurrences) {
      working = working.replaceAll(prefix, `${alias}/`);
      applied.push(`${alias}=${prefix.slice(0, -1)}`);
    }
  }

  return {
    text: working,
    header: applied.length > 0 ? `@aliases: ${applied.join(" | ")}` : "",
    appliedAliases: applied,
  };
}

/**
 * Serializes uniform tabular records into compact pipe-delimited rows instead of
 * pretty-printed JSON arrays (~65% fewer BPE tokens).
 */
export function formatPipeTable(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
): string {
  const sanitizeCell = (value: string | number | null | undefined): string =>
    String(value ?? "-")
      .replace(/\r?\n/g, " ")
      .replaceAll("|", "/")
      .trim();
  const lines = [headers.map(sanitizeCell).join(" | ")];
  for (const row of rows) {
    lines.push(row.map(sanitizeCell).join(" | "));
  }
  return lines.join("\n");
}

/**
 * Builds a deterministic, thread-scoped prompt cache routing key for providers
 * supporting explicit cache affinity (`prompt_cache_key` / conversation affinity).
 */
export function buildPromptCacheKey(input: {
  readonly projectId: string;
  readonly threadId: string;
  readonly driver: string;
  readonly model?: string | undefined;
}): string {
  const raw = `${input.projectId}:${input.threadId}:${input.driver}:${input.model ?? "default"}`;
  const digest = NodeCrypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 24);
  return `t3_${input.driver}_${digest}`;
}
