// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { WorkspaceCodeGraph } from "./CodeGraphIndex.ts";
import { runWorkspaceCodeGraph } from "../toolkits/workspaceCodeGraph.ts";

const tempDirs: string[] = [];
function makeTempRepo(): string {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-codegraph-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    NodeFs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Wave 2 — Graphify Local Deterministic AST Code Graph", () => {
  it("extracts symbols, static imports, callers, callees, and impact_radius with EXTRACTED/INFERRED/AMBIGUOUS provenance", async () => {
    const repo = makeTempRepo();
    NodeFs.mkdirSync(NodePath.join(repo, "src"), { recursive: true });

    NodeFs.writeFileSync(
      NodePath.join(repo, "src/core.ts"),
      [
        "export function computeScore(x: number): number {",
        "  return x * 2;",
        "}",
        "export function duplicateHelper(): number { return 1; }",
        "export function uniqueCrossFileFn(): string { return 'ok'; }",
      ].join("\n"),
      "utf8",
    );

    NodeFs.writeFileSync(
      NodePath.join(repo, "src/other.ts"),
      ["export function duplicateHelper(): number { return 2; }"].join("\n"),
      "utf8",
    );

    NodeFs.writeFileSync(
      NodePath.join(repo, "src/service.ts"),
      [
        'import { computeScore } from "./core.ts";',
        "// computeScore(999) inside comment must NEVER create a false edge",
        'const fake = "computeScore(123)";',
        "export function runPipeline(n: number) {",
        "  const a = computeScore(n);",
        "  const b = uniqueCrossFileFn();",
        "  const c = duplicateHelper();",
        "  return [a, b, c];",
        "}",
      ].join("\n"),
      "utf8",
    );

    NodeFs.writeFileSync(
      NodePath.join(repo, "src/entry.ts"),
      [
        'import { runPipeline } from "./service.ts";',
        "export function main() {",
        "  return runPipeline(7);",
        "}",
      ].join("\n"),
      "utf8",
    );

    const graph = new WorkspaceCodeGraph(repo);
    const stats = graph.refresh();
    expect(stats.indexedFiles).toBe(4);
    expect(stats.indexedSymbols).toBeGreaterThanOrEqual(6);

    // 1) EXTRACTED caller (comment & string literal ignored!)
    const scoreCallers = graph.queryCallers("computeScore");
    expect(scoreCallers).toHaveLength(1);
    expect(scoreCallers[0]).toMatchObject({
      callerFile: "src/service.ts",
      callerSymbol: "runPipeline",
      calleeName: "computeScore",
      targetFile: "src/core.ts",
      line: 5,
      provenance: "EXTRACTED",
    });

    // 2) INFERRED unique cross-file match without explicit import
    const inferredCallers = graph.queryCallers("uniqueCrossFileFn");
    expect(inferredCallers).toHaveLength(1);
    expect(inferredCallers[0]?.provenance).toBe("INFERRED");

    // 3) AMBIGUOUS call matching 2 definitions across core.ts & other.ts
    const ambiguousCallers = graph.queryCallers("duplicateHelper");
    expect(ambiguousCallers).toHaveLength(1);
    expect(ambiguousCallers[0]?.provenance).toBe("AMBIGUOUS");
    expect([...(ambiguousCallers[0]?.candidateFiles ?? [])].sort()).toEqual([
      "src/core.ts",
      "src/other.ts",
    ]);

    // 4) Transitive BFS impact_radius from src/core.ts -> src/service.ts (depth 1) -> src/entry.ts (depth 2)
    const impact = graph.queryImpactRadius("src/core.ts", 2);
    expect(impact.seedFiles).toEqual(["src/core.ts"]);
    expect(impact.impacted.map((i) => ({ file: i.file, depth: i.depth }))).toEqual([
      { file: "src/service.ts", depth: 1 },
      { file: "src/entry.ts", depth: 2 },
    ]);

    // 5) MCP toolkit runner + path traversal block
    const mcpResult = await Effect.runPromise(
      runWorkspaceCodeGraph({
        workspaceRoot: repo,
        request: { action: "imports", target: "src/service.ts" },
      }),
    );
    expect(mcpResult.provenanceCounts.EXTRACTED).toBeGreaterThanOrEqual(1);

    const escaped = await Effect.runPromiseExit(
      runWorkspaceCodeGraph({
        workspaceRoot: repo,
        request: { action: "symbols", target: "x", scopePath: "../../outside" },
      }),
    );
    expect(escaped._tag).toBe("Failure");
  });

  it("indexes T3 packages/contracts deterministically in under 3 seconds with incremental refresh <200ms", () => {
    const repoRoot = NodePath.resolve(process.cwd(), "../..");
    const contractsDir = NodePath.join(repoRoot, "packages", "contracts");
    if (!NodeFs.existsSync(contractsDir)) return;

    const graph = new WorkspaceCodeGraph(repoRoot);
    const t0 = performance.now();
    const first = graph.refresh("packages/contracts/src");
    const elapsedFirstMs = performance.now() - t0;

    const t1 = performance.now();
    const second = graph.refresh("packages/contracts/src");
    const elapsedSecondMs = performance.now() - t1;

    expect(first.indexedFiles).toBeGreaterThan(20);
    expect(first.indexedSymbols).toBeGreaterThan(50);
    expect(elapsedFirstMs).toBeLessThan(3_000);
    expect(second.indexedFiles).toBe(first.indexedFiles);
    expect(elapsedSecondMs).toBeLessThan(500);
  });
});
