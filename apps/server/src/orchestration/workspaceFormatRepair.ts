import * as NodeCrypto from "node:crypto";
import {
  MessageId,
  type ProviderExecutionContext,
  type WorkspaceTaskAttempt,
  type WorkspaceTaskNode,
} from "@t3tools/contracts";

export const workspaceExecutionMessageId = (
  execution: Pick<ProviderExecutionContext, "executionId" | "attempt">,
) => MessageId.make("orchestra-message:" + execution.executionId + ":" + execution.attempt);
export const formatRepairDigest = (output: string) =>
  NodeCrypto.createHash("sha256").update(output).digest("hex");

/** Only the immediately preceding settled attempt can request a format-only recovery. */
export function latestFormatFailure(node: WorkspaceTaskNode): WorkspaceTaskAttempt | undefined {
  const previous = node.attempts.findLast((attempt) => attempt.status !== "running");
  return previous?.status === "failed" && previous.formatRepair !== undefined
    ? previous
    : undefined;
}

export function verifiedFormatRepairOutput(
  attempt: WorkspaceTaskAttempt,
  output: string | undefined | null,
): string | undefined {
  const receipt = attempt.formatRepair;
  return receipt !== undefined &&
    output != null &&
    output.length === receipt.chars &&
    formatRepairDigest(output) === receipt.sha256
    ? output
    : undefined;
}
