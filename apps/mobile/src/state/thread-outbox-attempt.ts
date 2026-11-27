import type { QueuedThreadMessage } from "./thread-outbox-model";

export function matchesQueuedAttempt(message: QueuedThreadMessage, fingerprint: string): boolean {
  return (
    message.deliveryAttemptFingerprint === undefined ||
    message.deliveryAttemptFingerprint === fingerprint
  );
}

/** Persist the exact request identity before a new task can be dispatched. */
export async function prepareQueuedCreationAttempt(input: {
  readonly message: QueuedThreadMessage;
  readonly fingerprint: () => Promise<string>;
  readonly attemptWorktree?: QueuedThreadMessage["deliveryAttemptWorktree"];
  readonly isEditing: () => boolean;
  readonly updateIfCurrent: (
    expected: QueuedThreadMessage,
    replacement: QueuedThreadMessage,
  ) => Promise<boolean>;
}): Promise<QueuedThreadMessage | null> {
  const fingerprint = await input.fingerprint();
  if (input.isEditing()) return null;
  const { deliveryFailure: _failure, deliveryReceiptChecked: _checked, ...message } = input.message;
  const prepared = {
    ...message,
    deliveryAttemptFingerprint: fingerprint,
    ...(input.attemptWorktree ? { deliveryAttemptWorktree: input.attemptWorktree } : {}),
  };
  if (!(await input.updateIfCurrent(input.message, prepared))) return null;
  if (input.isEditing()) {
    await input.updateIfCurrent(prepared, input.message);
    return null;
  }
  return prepared;
}
