import { pipe } from "effect/Function";
import { importedConversationMessages, importedConversationActivity } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as O from "effect/Order";
import type {
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";

export type ThreadDetailReducerResult =
  | { readonly kind: "updated"; readonly thread: OrchestrationThread }
  | { readonly kind: "deleted" }
  | { readonly kind: "unchanged" };

const proposedPlanOrder = O.combine<OrchestrationThread["proposedPlans"][number]>(
  O.mapInput(O.String, (p) => p.createdAt),
  O.mapInput(O.String, (p) => p.id),
);

const checkpointOrder = O.mapInput(
  O.Number,
  (cp: OrchestrationThread["checkpoints"][number]) =>
    cp.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER,
);

const activityOrder = O.combineAll<OrchestrationThreadActivity>([
  O.mapInput(O.Number, (a) => a.sequence ?? Number.MAX_SAFE_INTEGER),
  O.mapInput(O.String, (a) => a.createdAt),
  O.mapInput(O.String, (a) => a.id),
]);

/**
 * Matches the validity rule in `deriveLatestContextWindowSnapshot` (and the
 * server's snapshot-side `dropStaleContextWindowActivities`): rows without a
 * finite, non-negative `usedTokens` are skipped during the consumer's backward
 * walk, so they must not replace an earlier resolvable row here.
 */
function isResolvableContextWindowActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") {
    return false;
  }
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const usedTokens = payload?.usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}

/**
 * Keep the full `payload` (tool `data.rawOutput`/`data.item` bodies, long
 * `detail` command output) only for the most recent activities. On a
 * long-lived thread that receives events indefinitely, these bodies grow the
 * renderer heap without bound (~1GB/hr on a monitoring thread) because
 * `thread.activities` is append-only and holds every payload verbatim.
 */
const PAYLOAD_RETENTION_ACTIVITIES = 300;

/**
 * Hard cap on retained activity rows. Payload compaction bounds the bytes per
 * row; this bounds the row COUNT so an append-only thread cannot grow the heap
 * without limit through sheer number of (even small) rows. The most recent
 * resolvable `context-window.updated` row is preserved past the cap so the
 * context-usage display keeps resolving after old rows are evicted.
 */
const ACTIVITY_ROW_CAP = 2000;

/** Marker written onto a compacted payload so the pass is idempotent. */
const COMPACTED_MARKER = "__payloadCompacted";

/**
 * Shared, frozen placeholder reused for every compacted payload that has no
 * routing/marker fields to preserve (the common case: monitoring rows and tool
 * outputs without agent/task markers). Interning one object instead of
 * allocating a fresh `{ __payloadCompacted: true }` per row removes per-row
 * allocation and GC churn. Safe to share because every payload reader is
 * read-only (guarded reads via asString/asRecord/optional chaining).
 */
const EMPTY_COMPACTED_PAYLOAD: Readonly<Record<string, unknown>> = Object.freeze({
  [COMPACTED_MARKER]: true,
});

/**
 * True when this activity's payload was blanked by compaction. Readers that treat a
 * missing field as a positive signal (a withdrawn plan, a cleared list) must check this
 * first: compaction means "unknown", never "empty".
 */
export function isCompactedActivityPayload(activity: OrchestrationThreadActivity): boolean {
  return isCompactedPayload(activity);
}

function isCompactedPayload(activity: OrchestrationThreadActivity): boolean {
  const payload = activity.payload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as Record<string, unknown>)[COMPACTED_MARKER] === true
  );
}

/**
 * Blank only the byte-heavy parts of an old activity's payload while keeping
 * every small scalar/marker field that downstream routing and the subagent
 * roster read (see the payload readers in session-logic.ts and
 * subagentRuntime.ts). `context-window.updated` rows are never compacted so
 * context-window resolution keeps working. Returns a NEW activity object
 * (fresh identity, same id/turnId/kind/createdAt/summary) so the identity-keyed
 * work-log caches re-derive and the reducer's id-keyed logic still matches.
 */
function compactActivityPayload(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  if (
    activity.kind === "context-window.updated" ||
    activity.kind === "orchestra.block" ||
    activity.kind === "conversation.handoff.prepared" ||
    activity.kind === "conversation.imported"
  )
    return activity;
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null) return activity;
  const source = payload as Record<string, unknown>;
  if (source[COMPACTED_MARKER] === true) return activity;
  const preservedKeys = [
    "taskId",
    "agentId",
    "agentKind",
    "timelineBypass",
    "taskType",
    "workflowName",
    "status",
    "endedAt",
    "requestId",
    "requestKind",
    "requestType",
    "itemType",
    "title",
    "role",
    "summary",
    // A `user-input.requested` row IS the pending question: deriveOpenUserInputRequests
    // drops the request outright when `questions` is missing, so compacting it away
    // takes the answer UI with it and leaves the agent blocked on a prompt the user can
    // no longer see. The array is small — a few options — so it stays.
    "questions",
  ] as const;
  const next: Record<string, unknown> = { [COMPACTED_MARKER]: true };
  let preservedAny = false;
  for (const key of preservedKeys) {
    if (source[key] !== undefined) {
      next[key] = source[key];
      preservedAny = true;
    }
  }
  // Pool: rows with nothing to preserve all share one frozen placeholder.
  return { ...activity, payload: preservedAny ? next : EMPTY_COMPACTED_PAYLOAD };
}

/**
 * Bound the retained activity row count to the most recent ACTIVITY_ROW_CAP.
 * Preserve the latest context window and at most MESSAGE_ROW_CAP older block
 * headers, so retained messages keep their identity after noisy tool output.
 */
export function capActivityRows(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  if (activities.length <= ACTIVITY_ROW_CAP) return activities;
  const cut = activities.length - ACTIVITY_ROW_CAP;
  const tail = activities.slice(cut);
  let hasContextWindow = tail.some(isResolvableContextWindowActivity);
  const preserved: OrchestrationThreadActivity[] = [];
  let blockCount = 0;
  for (let i = cut - 1; i >= 0; i--) {
    const evicted = activities[i];
    if (evicted === undefined) continue;
    if (evicted.kind === "orchestra.block" && blockCount < MESSAGE_ROW_CAP) {
      preserved.push(evicted);
      blockCount++;
    } else if (!hasContextWindow && isResolvableContextWindowActivity(evicted)) {
      preserved.push(evicted);
      hasContextWindow = true;
    }
  }
  return preserved.length === 0 ? tail : [...preserved.toReversed(), ...tail];
}

/**
 * Hard cap on retained message rows. `thread.messages` is append-only on the
 * live event path and, unlike activities, keeps every row's full text, so a
 * long-lived thread (e.g. a monitoring thread streaming reports for days)
 * grows the renderer heap — and the transcript's React/DOM tree — without
 * bound. The tail is kept, so the currently streaming message always survives.
 */
const MESSAGE_ROW_CAP = 1000;

/** Bound the retained message row count to the most recent MESSAGE_ROW_CAP. */
export function capMessageRows(
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<OrchestrationMessage> {
  if (messages.length <= MESSAGE_ROW_CAP) return messages;
  return messages.slice(messages.length - MESSAGE_ROW_CAP);
}

/**
 * Compact payloads of activities older than the retention window. Amortized
 * O(1) on the common in-order append: only the row that just fell out of the
 * window needs compacting, and the backward walk stops at the first
 * already-compacted row (everything before it was compacted on earlier
 * events). `context-window.updated` rows are skipped, not treated as a stop.
 */
export function compactOldActivityPayloads(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const boundary = activities.length - PAYLOAD_RETENTION_ACTIVITIES - 1;
  if (boundary < 0) return activities;
  let out: OrchestrationThreadActivity[] | null = null;
  for (let i = boundary; i >= 0; i--) {
    const current = activities[i];
    if (current === undefined) continue;
    if (isCompactedPayload(current)) break;
    const compacted = compactActivityPayload(current);
    if (compacted === current) continue; // context-window / non-object: skip, keep walking
    if (out === null) out = activities.slice();
    out[i] = compacted;
  }
  return out ?? activities;
}

/**
 * Apply a single orchestration event to an `OrchestrationThread`, returning
 * the updated thread, a deletion signal, or an "unchanged" marker when the
 * event doesn't affect this thread.
 *
 * This is a pure reducer operating on contract types. UI-specific mapping
 * (e.g. resolving attachment preview URLs, normalising model slugs, adding
 * scoped fields like `environmentId`) is the caller's responsibility.
 */
export function applyThreadDetailEvent(
  thread: OrchestrationThread,
  event: OrchestrationEvent,
  // The row caps bound live growth on a thread the user never paged. Once older
  // pages are merged in, the loaded window IS history the user asked for, and
  // capping from the head silently deletes exactly that page — so the caller
  // passes `capRows: false` while a widened window is in play. Payloads are
  // still compacted regardless; only row eviction is suspended.
  options?: { readonly capRows?: boolean },
): ThreadDetailReducerResult {
  const capRows = options?.capRows ?? true;
  switch (event.type) {
    // ── Project events (irrelevant to thread detail) ────────────────
    case "project.created":
    case "project.meta-updated":
    case "project.deleted":
      return { kind: "unchanged" };

    // ── Thread lifecycle ────────────────────────────────────────────
    case "thread.created":
      return {
        kind: "updated",
        thread: {
          id: event.payload.threadId,
          projectId: event.payload.projectId,
          title: event.payload.title,
          modelSelection: event.payload.modelSelection,
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          branch: event.payload.branch,
          worktreePath: event.payload.worktreePath,
          latestTurn: null,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          deletedAt: null,
          messages: event.payload.importedConversation
            ? importedConversationMessages(
                event.payload.threadId,
                event.payload.importedConversation,
                event.payload.createdAt,
              )
            : [],
          proposedPlans: [],
          activities: event.payload.importedConversation
            ? [
                importedConversationActivity(
                  event.payload.threadId,
                  event.payload.importedConversation,
                  event.payload.createdAt,
                ),
              ]
            : [],
          checkpoints: [],
          session: null,
        },
      };

    case "thread.deleted":
      return { kind: "deleted" };

    case "thread.archived":
      return {
        kind: "updated",
        thread: {
          ...thread,
          archivedAt: event.payload.archivedAt,
          titleRegeneration: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unarchived":
      return {
        kind: "updated",
        thread: { ...thread, archivedAt: null, updatedAt: event.payload.updatedAt },
      };

    case "thread.settled":
      return {
        kind: "updated",
        thread: {
          ...thread,
          settledOverride: "settled",
          settledAt: event.payload.settledAt,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unsettled":
      return {
        kind: "updated",
        thread: {
          ...thread,
          settledOverride: event.payload.reason === "user" ? "active" : null,
          settledAt: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.snoozed":
      return {
        kind: "updated",
        thread: {
          ...thread,
          snoozedUntil: event.payload.snoozedUntil,
          snoozedAt: event.payload.snoozedAt,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unsnoozed":
      return {
        kind: "updated",
        thread: {
          ...thread,
          snoozedUntil: null,
          snoozedAt: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.pinned":
      return {
        kind: "updated",
        thread: {
          ...thread,
          pinnedAt: event.payload.pinnedAt,
          ...(event.payload.pinOrderKey !== undefined
            ? { pinOrderKey: event.payload.pinOrderKey }
            : {}),
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unpinned":
      return {
        kind: "updated",
        thread: {
          ...thread,
          pinnedAt: null,
          pinOrderKey: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.pin-reordered":
      return {
        kind: "updated",
        thread: {
          ...thread,
          pinOrderKey: event.payload.orderKey,
          updatedAt: event.payload.updatedAt,
        },
      };

    // ── Thread metadata ─────────────────────────────────────────────
    case "thread.meta-updated":
      return {
        kind: "updated",
        thread: {
          ...thread,
          ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
          ...(event.payload.handoffMode !== undefined
            ? { handoffMode: event.payload.handoffMode }
            : {}),
          ...(event.payload.titleRegeneration !== undefined
            ? { titleRegeneration: event.payload.titleRegeneration }
            : {}),
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
          ...(event.payload.worktreePath !== undefined
            ? { worktreePath: event.payload.worktreePath }
            : {}),
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.runtime-mode-set":
      return {
        kind: "updated",
        thread: {
          ...thread,
          runtimeMode: event.payload.runtimeMode,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.interaction-mode-set":
      return {
        kind: "updated",
        thread: {
          ...thread,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.payload.updatedAt,
        },
      };

    // ── Turn lifecycle ──────────────────────────────────────────────
    case "thread.turn-start-requested":
      return {
        kind: "updated",
        thread: {
          ...thread,
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.occurredAt,
        },
      };

    case "thread.turn-interrupt-requested": {
      if (event.payload.turnId === undefined) {
        return { kind: "unchanged" };
      }
      const latestTurn = thread.latestTurn;
      if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
        return { kind: "unchanged" };
      }
      return {
        kind: "updated",
        thread: {
          ...thread,
          latestTurn: {
            ...latestTurn,
            state: "interrupted",
            startedAt: latestTurn.startedAt ?? event.payload.createdAt,
            completedAt: latestTurn.completedAt ?? event.payload.createdAt,
          },
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Messages ────────────────────────────────────────────────────
    case "thread.message-sent": {
      const message: OrchestrationMessage = {
        id: event.payload.messageId,
        role: event.payload.role,
        text: event.payload.text,
        ...(event.payload.attachments !== undefined
          ? { attachments: event.payload.attachments }
          : {}),
        turnId: event.payload.turnId,
        streaming: event.payload.streaming,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
      };

      const existingMessage = thread.messages.find((entry) => entry.id === message.id);
      const messages = existingMessage
        ? Arr.map(thread.messages, (entry) =>
            entry.id !== message.id
              ? entry
              : {
                  ...entry,
                  text: message.streaming
                    ? `${entry.text}${message.text}`
                    : message.text.length > 0
                      ? message.text
                      : entry.text,
                  streaming: message.streaming,
                  ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
                  ...(message.streaming ? {} : { updatedAt: message.updatedAt }),
                  ...(message.attachments !== undefined
                    ? { attachments: message.attachments }
                    : {}),
                },
          )
        : Arr.append(thread.messages, message);
      // Update latestTurn for assistant messages bound to a turn. A completed
      // assistant message only settles the turn once the session is no longer
      // running it — providers may emit several assistant messages per turn
      // (commentary between tool calls), and the turn must stay unsettled
      // until the provider reports turn end.
      const turnStillRunning =
        event.payload.turnId !== null &&
        thread.session?.status === "running" &&
        thread.session.activeTurnId === event.payload.turnId;
      const settlesTurn = !event.payload.streaming && !turnStillRunning;
      const latestTurn: OrchestrationThread["latestTurn"] =
        event.payload.role === "assistant" &&
        event.payload.turnId !== null &&
        (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
          ? {
              turnId: event.payload.turnId,
              state: settlesTurn
                ? thread.latestTurn?.state === "interrupted"
                  ? "interrupted"
                  : thread.latestTurn?.state === "error"
                    ? "error"
                    : "completed"
                : "running",
              requestedAt:
                thread.latestTurn?.turnId === event.payload.turnId
                  ? thread.latestTurn.requestedAt
                  : event.payload.createdAt,
              startedAt:
                thread.latestTurn?.turnId === event.payload.turnId
                  ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
                  : event.payload.createdAt,
              completedAt: settlesTurn
                ? event.payload.updatedAt
                : thread.latestTurn?.turnId === event.payload.turnId
                  ? (thread.latestTurn.completedAt ?? null)
                  : null,
              assistantMessageId: event.payload.messageId,
            }
          : thread.latestTurn;

      // Rebind checkpoint assistant message IDs for assistant messages.
      const checkpoints =
        event.payload.role === "assistant" && event.payload.turnId !== null
          ? rebindCheckpointAssistantMessage(
              thread.checkpoints,
              event.payload.turnId,
              event.payload.messageId,
            )
          : thread.checkpoints;

      return {
        kind: "updated",
        thread: {
          ...thread,
          messages: capRows ? capMessageRows(messages) : messages,
          checkpoints,
          latestTurn,
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Session ─────────────────────────────────────────────────────
    case "thread.session-set": {
      // Leaving the "running" session status is the turn-end signal: settle a
      // still-running latest turn so its duration reflects the whole turn.
      const settledTurnState = settledTurnStateForSessionStatus(event.payload.session.status);
      const latestTurn: OrchestrationLatestTurn | null =
        event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
          ? {
              turnId: event.payload.session.activeTurnId,
              state: "running",
              requestedAt:
                thread.latestTurn?.turnId === event.payload.session.activeTurnId
                  ? thread.latestTurn.requestedAt
                  : event.payload.session.updatedAt,
              startedAt:
                thread.latestTurn?.turnId === event.payload.session.activeTurnId
                  ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                  : event.payload.session.updatedAt,
              completedAt: null,
              assistantMessageId:
                thread.latestTurn?.turnId === event.payload.session.activeTurnId
                  ? thread.latestTurn.assistantMessageId
                  : null,
            }
          : thread.latestTurn !== null &&
              thread.latestTurn.state === "running" &&
              settledTurnState !== null
            ? {
                ...thread.latestTurn,
                state: settledTurnState,
                // A running turn's completedAt can only hold a mid-turn
                // placeholder checkpoint timestamp — the session leaving
                // "running" is the authoritative turn end.
                completedAt: event.payload.session.updatedAt,
              }
            : thread.latestTurn;

      return {
        kind: "updated",
        thread: {
          ...thread,
          session: event.payload.session,
          latestTurn,
          updatedAt: event.occurredAt,
        },
      };
    }

    case "thread.session-stop-requested":
      return thread.session === null
        ? { kind: "unchanged" }
        : {
            kind: "updated",
            thread: {
              ...thread,
              session: {
                ...thread.session,
                status: "stopped",
                activeTurnId: null,
                updatedAt: event.payload.createdAt,
              },
              updatedAt: event.occurredAt,
            },
          };

    // ── Proposed plans ──────────────────────────────────────────────
    case "thread.proposed-plan-upserted": {
      const proposedPlan = event.payload.proposedPlan;

      const proposedPlans = pipe(
        thread.proposedPlans,
        Arr.filter((entry) => entry.id !== proposedPlan.id),
        Arr.append(proposedPlan),
        Arr.sort(proposedPlanOrder),
      );

      return {
        kind: "updated",
        thread: { ...thread, proposedPlans, updatedAt: event.occurredAt },
      };
    }

    // ── Checkpoints / turn diffs ────────────────────────────────────
    case "thread.turn-diff-completed": {
      const checkpoint: OrchestrationCheckpointSummary = {
        turnId: event.payload.turnId,
        checkpointTurnCount: event.payload.checkpointTurnCount,
        checkpointRef: event.payload.checkpointRef,
        status: event.payload.status,
        files: event.payload.files,
        assistantMessageId: event.payload.assistantMessageId,
        completedAt: event.payload.completedAt,
      };

      const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
      // Don't overwrite a non-missing checkpoint with a missing one.
      if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
        return { kind: "unchanged" };
      }

      const checkpoints = pipe(
        thread.checkpoints,
        Arr.filter((entry) => entry.turnId !== checkpoint.turnId),
        Arr.append(checkpoint),
        Arr.sort(checkpointOrder),
      );

      // Mid-turn diff updates produce placeholder checkpoints; record the
      // checkpoint, but don't settle a turn its session is still running.
      const diffTurnStillRunning =
        thread.session?.status === "running" &&
        thread.session.activeTurnId === event.payload.turnId;
      const latestTurn =
        !diffTurnStillRunning &&
        (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
          ? {
              turnId: event.payload.turnId,
              state: checkpointStatusToTurnState(event.payload.status),
              requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
              startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
              completedAt: event.payload.completedAt,
              assistantMessageId: event.payload.assistantMessageId,
            }
          : thread.latestTurn;

      return {
        kind: "updated",
        thread: { ...thread, checkpoints, latestTurn, updatedAt: event.occurredAt },
      };
    }

    // ── Revert ──────────────────────────────────────────────────────
    case "thread.reverted": {
      const checkpoints = pipe(
        thread.checkpoints,
        Arr.filter(
          (entry) =>
            entry.checkpointTurnCount !== undefined &&
            entry.checkpointTurnCount <= event.payload.turnCount,
        ),
        Arr.sort(checkpointOrder),
      );

      const retainedTurnIds = new Set(Arr.map(checkpoints, (entry) => entry.turnId));
      const messages = retainMessagesAfterRevert(thread.messages, retainedTurnIds);
      const proposedPlans = pipe(
        thread.proposedPlans,
        Arr.filter((plan) => plan.turnId === null || retainedTurnIds.has(plan.turnId)),
      );
      const activities = pipe(
        thread.activities,
        Arr.filter((activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId)),
      );
      const latestCheckpoint = checkpoints.at(-1) ?? null;

      return {
        kind: "updated",
        thread: {
          ...thread,
          checkpoints,
          messages,
          proposedPlans,
          activities,
          latestTurn:
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToTurnState(
                    latestCheckpoint.status as "ready" | "missing" | "error",
                  ),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                },
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Activities ──────────────────────────────────────────────────
    case "thread.activity-appended": {
      const activity = event.payload.activity;
      // A resolvable context-window update supersedes earlier resolvable ones
      // for the same turn: consumers only read the latest value (walking the
      // array backwards), and providers stream these updates continuously, so
      // retaining the history grows the thread by thousands of rows over a
      // long session. Mirrors the server-side snapshot rule in
      // dropStaleContextWindowActivities; retention stays per turn so a
      // thread.reverted that discards turns can still resolve a value from
      // the turns that survive.
      const supersedesContextWindow = isResolvableContextWindowActivity(activity);
      const dropped = (entry: OrchestrationThreadActivity) =>
        entry.id === activity.id ||
        (supersedesContextWindow &&
          entry.turnId === activity.turnId &&
          isResolvableContextWindowActivity(entry));
      // Providers stream rows in order, so the new one almost always belongs
      // at the end: append, and leave the full re-sort for the rare row that
      // arrives out of order. A long thread holds tens of thousands of rows,
      // and sorting all of them on every event was the client's dominant idle
      // cost. Appending also keeps every earlier row's identity and position,
      // which is what lets the web's derived-work-log caches skip re-checking
      // them.
      const base = thread.activities.some(dropped)
        ? thread.activities.filter((entry) => !dropped(entry))
        : thread.activities;
      const last = base[base.length - 1];
      const appended =
        last === undefined || activityOrder(last, activity) <= 0
          ? [...base, activity]
          : Arr.sort([...base, activity], activityOrder);
      const activities = compactOldActivityPayloads(capRows ? capActivityRows(appended) : appended);

      return {
        kind: "updated",
        thread: { ...thread, activities, updatedAt: event.occurredAt },
      };
    }

    // ── Events that don't mutate thread state directly ──────────────
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.checkpoint-revert-requested":
      return { kind: "unchanged" };
  }

  // Forward-compatible: ignore unrecognized event types.
  return { kind: "unchanged" };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Turn state to settle a still-running latest turn with when its session
 * leaves the "running" status, or null while the session is (re)starting or
 * running and the turn must stay unsettled.
 */
function settledTurnStateForSessionStatus(
  status: OrchestrationSession["status"],
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

function checkpointStatusToTurnState(
  status: "ready" | "missing" | "error",
): OrchestrationLatestTurn["state"] {
  switch (status) {
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "missing":
      return "completed";
  }
}

function rebindCheckpointAssistantMessage(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
  messageId: MessageId,
): OrchestrationCheckpointSummary[] {
  return Arr.map(checkpoints, (entry) =>
    entry.turnId === turnId ? { ...entry, assistantMessageId: messageId } : entry,
  );
}

function retainMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
): OrchestrationMessage[] {
  // Keep messages that belong to a retained turn, plus system messages and
  // messages without a turn binding (pre-turn-0 user messages).
  return Arr.filter(messages, (message) => {
    if (message.role === "system") {
      return true;
    }
    if (message.turnId === null) {
      return true;
    }
    return retainedTurnIds.has(message.turnId);
  });
}
