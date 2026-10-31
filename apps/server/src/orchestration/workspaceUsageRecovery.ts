import * as DateTime from "effect/DateTime";
import * as NodeCrypto from "node:crypto";
import type { ServerProviderUsage, WorkspaceTaskNode } from "@t3tools/contracts";
import { isActualRateLimitFailure } from "../provider/providerAccountSwitch.ts";

/** Only a real limit failure with a known reset may schedule a new attempt. */
export function planWorkspaceUsageRecovery(input: {
  enabled: boolean;
  error: string;
  providerInstanceId: string;
  usage?: ServerProviderUsage | undefined;
  previous?: WorkspaceTaskNode["usageRecovery"];
  attempts: number;
  nowMs: number;
}): WorkspaceTaskNode["usageRecovery"] {
  if (!input.enabled || input.attempts >= 10 || (input.previous?.count ?? 0) >= 3) return undefined;
  const limit =
    isActualRateLimitFailure(input.error) ||
    /(?:usage|rate|message) limit (?:reached|exceeded)|you(?:'|’)ve (?:hit|reached) your (?:usage )?limit|사용량 한도.*(?:도달|초과)/iu.test(
      input.error,
    );
  if (!limit) return undefined;
  const resets = [input.usage?.primary, input.usage?.secondary].flatMap((window) =>
    window &&
    window.usedPercent >= 100 &&
    window.resetsAt !== undefined &&
    window.resetsAt * 1000 > input.nowMs
      ? [window.resetsAt * 1000]
      : [],
  );
  const retryAfter = /retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:s(?:ec(?:onds?)?)?)?\b/iu.exec(
    input.error,
  );
  const delay = retryAfter ? Number(retryAfter[1]) * 1000 : 0;
  const reset = resets.length ? Math.max(...resets) : delay > 0 ? input.nowMs + delay : 0;
  if (!Number.isFinite(reset) || reset <= input.nowMs || reset > input.nowMs + 14 * 86400000)
    return undefined;
  const resumeAt = DateTime.formatIso(DateTime.makeUnsafe(reset + 1000));
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(input.providerInstanceId + ":" + (resets.length ? reset : "retry-after:" + delay))
    .digest("hex");
  if (input.previous?.fingerprint === fingerprint) return undefined;
  return {
    fingerprint,
    resumeAt,
    count: (input.previous?.count ?? 0) + 1,
    phase: "waiting",
    lastError: input.error.slice(0, 8000),
  };
}
