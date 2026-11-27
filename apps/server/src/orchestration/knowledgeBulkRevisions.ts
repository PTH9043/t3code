import type { OrchestrationCommand, WorkspaceKnowledgeItem } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

export const bulkRevisions = Effect.fn("bulkRevisions")(function* (
  command: Extract<OrchestrationCommand, { type: "project.knowledge.bulk" }>,
  rows: readonly WorkspaceKnowledgeItem[],
) {
  const invalid = (detail: string) =>
    new OrchestrationCommandInvariantError({ commandType: command.type, detail });
  const items = new Map(rows.map((item) => [item.id, item]));
  const { operation } = command;
  if (
    items.size === 0 ||
    items.size !== command.items.length ||
    new Set(command.items.map((item) => item.id)).size !== items.size
  ) {
    return yield* invalid(
      "A selected item has changed, is unavailable, or was selected twice. Reload the selection.",
    );
  }
  if (operation.type === "merge") {
    const target = items.get(operation.targetId);
    if (items.size < 2 || !target || target.supersededBy || target.status === "superseded") {
      return yield* invalid("Select the representative and at least one other item.");
    }
  }
  const revisions = [];
  for (const expected of command.items) {
    const item = items.get(expected.id);
    if (!item || item.projectId !== command.projectId || item.updatedAt !== expected.updatedAt) {
      return yield* invalid("An item has changed. Reload the selection.");
    }
    if (operation.type === "promote" && item.status !== "candidate") {
      return yield* invalid("Only candidate items can be promoted.");
    }
    if (operation.type === "merge" && item.id === operation.targetId) continue;
    if (operation.type === "merge" && (item.supersededBy || item.status === "superseded")) {
      return yield* invalid("A selected source has already been superseded.");
    }
    const status =
      operation.type === "promote"
        ? "active"
        : operation.type === "archive"
          ? "archived"
          : operation.type === "merge"
            ? "superseded"
            : item.status;
    const {
      id,
      projectId,
      kind,
      title,
      content,
      origin,
      relativeFolder,
      scope,
      appliesToFolder,
      research,
      tags,
      originalChars,
      storedChars,
      supersededBy,
      provenance,
      sourceItemId,
    } = item;
    revisions.push({
      projectId,
      itemId: id,
      kind: operation.type === "reclassify" ? operation.kind : kind,
      status,
      title,
      content,
      origin,
      relativeFolder,
      ...(scope === undefined ? {} : { scope }),
      appliesToFolder: appliesToFolder ?? null,
      research: research ?? null,
      tags,
      originalChars,
      storedChars,
      supersededBy: operation.type === "merge" ? operation.targetId : (supersededBy ?? null),
      provenance: provenance ?? null,
      sourceItemId: sourceItemId ?? null,
      updatedAt: nextKnowledgeTimestamp(command.createdAt, item.updatedAt),
    });
  }
  return revisions;
});

export function nextKnowledgeTimestamp(createdAt: string, previous: string | null) {
  return previous !== null && Date.parse(createdAt) <= Date.parse(previous)
    ? DateTime.formatIso(DateTime.makeUnsafe(Date.parse(previous) + 1))
    : createdAt;
}
