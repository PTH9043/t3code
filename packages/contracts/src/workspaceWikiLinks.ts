import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, WorkspaceKnowledgeItemId } from "./baseSchemas.ts";

export const WorkspaceWikiLinksInput = Schema.Struct({
  projectId: ProjectId,
  itemId: WorkspaceKnowledgeItemId,
});
export type WorkspaceWikiLinksInput = typeof WorkspaceWikiLinksInput.Type;

export const WorkspaceWikiLink = Schema.Struct({
  sourceItemId: WorkspaceKnowledgeItemId,
  sourceTitle: Schema.String,
  targetTitle: Schema.String,
  targetItemId: Schema.NullOr(WorkspaceKnowledgeItemId),
  context: Schema.String,
  start: NonNegativeInt,
  end: NonNegativeInt,
});
export type WorkspaceWikiLink = typeof WorkspaceWikiLink.Type;

export const WorkspaceWikiLinksResult = Schema.Struct({
  outgoing: Schema.Array(WorkspaceWikiLink),
  backlinks: Schema.Array(WorkspaceWikiLink),
  unresolved: Schema.Array(WorkspaceWikiLink),
});
export type WorkspaceWikiLinksResult = typeof WorkspaceWikiLinksResult.Type;
