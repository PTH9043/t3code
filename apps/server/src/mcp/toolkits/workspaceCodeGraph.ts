import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  getOrCreateWorkspaceCodeGraph,
  type CodeGraphEdgeProvenance,
} from "../codeGraph/CodeGraphIndex.ts";

export const WorkspaceCodeGraphInput = Schema.Struct({
  /**
   * Deterministic local AST/dependency query action:
   * - `symbols`: list/search functions, classes, types, interfaces in a file or by name.
   * - `imports`: inspect outgoing imports and incoming importers for a file.
   * - `callers`: find all callers of a symbol with EXTRACTED/INFERRED/AMBIGUOUS provenance.
   * - `callees`: find all symbols called by a symbol or file.
   * - `impact_radius`: BFS blast-radius across importers and callers (depth 1..4).
   */
  action: Schema.Literals(["symbols", "imports", "callers", "callees", "impact_radius"]),
  /** File path (relative to workspace) or symbol name to inspect. */
  target: TrimmedNonEmptyString,
  /** Optional relative subdirectory to scope indexing (faster on monorepos). */
  scopePath: Schema.optionalKey(TrimmedNonEmptyString),
  /** Traversal depth for `impact_radius` (1..4, default 2). */
  depth: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
  /** Max items returned (default 50, max 100). */
  maxResults: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type WorkspaceCodeGraphInput = typeof WorkspaceCodeGraphInput.Type;

export const WorkspaceCodeGraphResult = Schema.Struct({
  action: Schema.String,
  target: Schema.String,
  indexedFiles: Schema.Int,
  indexedSymbols: Schema.Int,
  provenanceCounts: Schema.Struct({
    EXTRACTED: Schema.Int,
    INFERRED: Schema.Int,
    AMBIGUOUS: Schema.Int,
  }),
  result: Schema.Unknown,
});
export type WorkspaceCodeGraphResult = typeof WorkspaceCodeGraphResult.Type;

export class WorkspaceCodeGraphError extends Schema.TaggedErrorClass<WorkspaceCodeGraphError>()(
  "WorkspaceCodeGraphError",
  { message: Schema.String },
) {}

function countProvenances(
  items: ReadonlyArray<{ readonly provenance?: CodeGraphEdgeProvenance }>,
): { readonly EXTRACTED: number; readonly INFERRED: number; readonly AMBIGUOUS: number } {
  let EXTRACTED = 0;
  let INFERRED = 0;
  let AMBIGUOUS = 0;
  for (const item of items) {
    if (item.provenance === "EXTRACTED") EXTRACTED += 1;
    else if (item.provenance === "INFERRED") INFERRED += 1;
    else if (item.provenance === "AMBIGUOUS") AMBIGUOUS += 1;
  }
  return { EXTRACTED, INFERRED, AMBIGUOUS };
}

export function runWorkspaceCodeGraph(input: {
  readonly workspaceRoot: string;
  readonly request: WorkspaceCodeGraphInput;
}): Effect.Effect<WorkspaceCodeGraphResult, WorkspaceCodeGraphError> {
  return Effect.try({
    try: () => {
      const graph = getOrCreateWorkspaceCodeGraph(input.workspaceRoot);
      const stats = graph.refresh(input.request.scopePath);
      const maxResults = input.request.maxResults ?? 50;

      switch (input.request.action) {
        case "symbols": {
          const symbols = graph.querySymbols(input.request.target, maxResults);
          return {
            action: "symbols",
            target: input.request.target,
            indexedFiles: stats.indexedFiles,
            indexedSymbols: stats.indexedSymbols,
            provenanceCounts: { EXTRACTED: symbols.length, INFERRED: 0, AMBIGUOUS: 0 },
            result: { symbols },
          };
        }
        case "imports": {
          const imports = graph.queryImports(input.request.target);
          return {
            action: "imports",
            target: input.request.target,
            indexedFiles: stats.indexedFiles,
            indexedSymbols: stats.indexedSymbols,
            provenanceCounts: countProvenances([...imports.outgoing, ...imports.incoming]),
            result: imports,
          };
        }
        case "callers": {
          const callers = graph.queryCallers(input.request.target, maxResults);
          return {
            action: "callers",
            target: input.request.target,
            indexedFiles: stats.indexedFiles,
            indexedSymbols: stats.indexedSymbols,
            provenanceCounts: countProvenances(callers),
            result: { callers },
          };
        }
        case "callees": {
          const callees = graph.queryCallees(input.request.target, maxResults);
          return {
            action: "callees",
            target: input.request.target,
            indexedFiles: stats.indexedFiles,
            indexedSymbols: stats.indexedSymbols,
            provenanceCounts: countProvenances(callees),
            result: { callees },
          };
        }
        case "impact_radius": {
          const impact = graph.queryImpactRadius(
            input.request.target,
            input.request.depth ?? 2,
            maxResults,
          );
          return {
            action: "impact_radius",
            target: input.request.target,
            indexedFiles: stats.indexedFiles,
            indexedSymbols: stats.indexedSymbols,
            provenanceCounts: countProvenances(impact.impacted),
            result: impact,
          };
        }
      }
    },
    catch: (cause) =>
      new WorkspaceCodeGraphError({
        message: cause instanceof Error ? cause.message : "코드 그래프 조회에 실패했습니다.",
      }),
  });
}
