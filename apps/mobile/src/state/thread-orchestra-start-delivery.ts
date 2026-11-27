import type { WorkflowStart } from "@t3tools/contracts";
import type { ComposerOrchestraStartAttempt } from "./use-composer-drafts";

export async function deliverOrchestraStart<T>(input: {
  readonly attempt: ComposerOrchestraStartAttempt;
  readonly persist: (threadKey: string, attempt: ComposerOrchestraStartAttempt) => Promise<boolean>;
  readonly send: (request: WorkflowStart) => Promise<T>;
}): Promise<{ readonly kind: "changed" } | { readonly kind: "sent"; readonly result: T }> {
  if (!(await input.persist(input.attempt.threadKey, input.attempt))) return { kind: "changed" };
  return { kind: "sent", result: await input.send(input.attempt.input) };
}
