import * as NodeCrypto from "node:crypto";
import type { WorkspacePromptComposeInput, WorkspacePromptComposeResult } from "@t3tools/contracts";

export type WorkspaceTokenCounter = (text: string) => number;
export interface WorkspacePromptParts {
  result: WorkspacePromptComposeResult;
  sections: { task: string; instructions: string; memory: string; library: string };
}

let counterPromise: Promise<WorkspaceTokenCounter> | undefined;

/** Load the reference vocabulary on first use. Cache hashes/counts, never retained prompt text. */
export function loadWorkspaceTokenCounter(): Promise<WorkspaceTokenCounter> {
  counterPromise ??= import("gpt-tokenizer/encoding/o200k_base")
    .then(({ countTokens, setMergeCacheSize }) => {
      setMergeCacheSize(4096);
      const cache = new Map<string, number>();
      const options = { disallowedSpecial: new Set<string>() };
      return (text: string) => {
        const key = NodeCrypto.createHash("sha256").update(text).digest("hex");
        const cached = cache.get(key);
        if (cached !== undefined) {
          cache.delete(key);
          cache.set(key, cached);
          return cached;
        }
        const count = countTokens(text, options);
        cache.set(key, count);
        if (cache.size > 512) cache.delete(cache.keys().next().value!);
        return count;
      };
    })
    .catch((cause: unknown) => {
      counterPromise = undefined;
      throw cause;
    });
  return counterPromise;
}

/** Recompose whole optional evidence units, then verify the complete serialized prompt. */
export function composeWithTokenBudget(
  request: WorkspacePromptComposeInput,
  counter: WorkspaceTokenCounter | undefined,
  compose: (budgetChars: number) => WorkspacePromptParts,
  requiredSuffix = "",
): WorkspacePromptComposeResult {
  const composeComplete = (budget: number): WorkspacePromptParts => {
    const parts = compose(budget);
    if (!requiredSuffix) return parts;
    const prompt = parts.result.prompt + requiredSuffix;
    return {
      ...parts,
      result: {
        ...parts.result,
        prompt,
        ...(parts.result.diagnostics
          ? {
              diagnostics: {
                ...parts.result.diagnostics,
                promptChars: prompt.length,
                contextRevision: NodeCrypto.createHash("sha256").update(prompt).digest("hex"),
              },
            }
          : {}),
      },
    };
  };
  const budgetChars = request.maxContextChars ?? 60_000;
  const limit = request.maxContextTokens ?? null;
  if (!counter) {
    if (limit !== null) throw new Error("문맥 토큰 예산을 확인할 토크나이저를 사용할 수 없습니다.");
    return composeComplete(budgetChars).result;
  }
  let selected = composeComplete(budgetChars);
  let total = counter(selected.result.prompt);
  if (limit !== null && total > limit) {
    const minimum = composeComplete(0);
    const minimumTokens = counter(minimum.result.prompt);
    if (minimumTokens >= limit) {
      selected = minimum;
      total = minimumTokens;
    } else {
      let low = 0;
      let high = budgetChars;
      selected = minimum;
      total = minimumTokens;
      // Selection is discrete; always retain a measured fitting result even if BPE boundaries
      // make counts non-monotone. Bounded work also limits latency on very large memories.
      for (let attempt = 0; attempt < 12 && high - low > 1; attempt++) {
        const middle = Math.floor((low + high) / 2);
        const candidate = composeComplete(middle);
        const count = counter(candidate.result.prompt);
        if (count <= limit) {
          selected = candidate;
          total = count;
          low = middle;
        } else {
          high = middle;
        }
      }
    }
  }
  return {
    ...selected.result,
    tokenEstimate: {
      version: 1,
      status: "estimated",
      scope: "workspace-prompt",
      encoding: "o200k_base",
      total,
      limit,
      mandatoryOverflow: limit === null ? 0 : Math.max(0, total - limit),
      sections: {
        task: counter(selected.sections.task),
        instructions: counter(selected.sections.instructions),
        memory: counter(selected.sections.memory),
        library: counter(selected.sections.library),
      },
    },
  };
}
