import type { WorkspaceProgram } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Hub memory for workspace programs.
 *
 * The hub never owns a program's heap — process address spaces are separate
 * and Python objects cannot live in shared memory. What it does own:
 *
 * 1. the *shared data files* a program should map instead of parsing its own
 *    copy (published as `T3_HUB_DATASET_<NAME>` absolute paths), and
 * 2. the *commit budget*: on Windows the program runs inside a Job Object with
 *    `JOB_OBJECT_LIMIT_PROCESS_MEMORY`, so a runaway allocation fails inside
 *    that process instead of paging the machine. Read-only file mappings do
 *    not count toward commit, so 1 and 2 never fight.
 *
 * Measured 2026-09-12 (docs/internals/hub-memory-feasibility-2026-09-12.md):
 * 506 MB → 32 MB per reader on a 119 MB journal once readers map the shared
 * Arrow file.
 */

export const HUB_COMMAND_ENV = "T3_HUB_GUARDED_COMMAND";
export const HUB_LIMIT_ENV = "T3_HUB_MEMORY_HARD_CAP_MB";
export const HUB_MANIFEST_ENV = "T3_HUB_MANIFEST";
/** Set for programs in a concurrency group: wait loops may exit instead of sleeping. */
export const HUB_YIELD_ENV = "T3_HUB_YIELD_ON_WAIT";
/** EX_TEMPFAIL — a program handed its slot back; restart it later, no incident. */
export const HUB_YIELD_EXIT_CODE = 75;

/** The path operations `hubEnvironment` needs — `Path.Path` from effect fits. */
export interface HubPathOperations {
  readonly resolve: (...segments: ReadonlyArray<string>) => string;
  readonly relative: (from: string, to: string) => string;
  readonly isAbsolute: (target: string) => boolean;
}

const HubManifest = Schema.Struct({
  commitLimitMb: Schema.NullOr(Schema.Int),
  datasets: Schema.Record(Schema.String, Schema.String),
});
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(HubManifest));

export interface HubEnvironmentResult {
  readonly env: Record<string, string>;
  /** Datasets skipped because their source escaped the project root. */
  readonly rejectedDatasets: ReadonlyArray<string>;
}

/** Variables the hub computes for a program (nothing when it has no budget). */
export function hubEnvironment(
  program: Pick<WorkspaceProgram, "hubMemory">,
  workspaceRoot: string,
  path: HubPathOperations,
): HubEnvironmentResult {
  const root = path.resolve(workspaceRoot);
  const env: Record<string, string> = {};
  const datasets: Record<string, string> = {};
  const rejectedDatasets: string[] = [];
  for (const dataset of program.hubMemory.sharedDatasets) {
    const source = path.resolve(root, dataset.relativeSource);
    const relative = path.relative(root, source).replaceAll("\\", "/");
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith("../") ||
      path.isAbsolute(relative)
    ) {
      rejectedDatasets.push(dataset.name);
      continue;
    }
    datasets[dataset.name] = source;
    env[`T3_HUB_DATASET_${dataset.name}`] = source;
  }
  if (program.hubMemory.commitLimitMb !== null) {
    env[HUB_LIMIT_ENV] = String(program.hubMemory.commitLimitMb);
  }
  if (program.hubMemory.concurrencyGroup !== null) {
    env[HUB_YIELD_ENV] = "1";
  }
  if (Object.keys(env).length > 0) {
    env[HUB_MANIFEST_ENV] = encodeManifest({
      commitLimitMb: program.hubMemory.commitLimitMb,
      datasets,
    });
  }
  return { env, rejectedDatasets };
}

/** Bundled builds and source checkouts use the same precompiled Windows guard. */
export function windowsJobGuardCandidates(
  path: Pick<HubPathOperations, "resolve">,
  architecture: string,
): string[] {
  return [
    path.resolve(import.meta.dirname, "hub-memory", `win32-${architecture}`, "t3-hub-guard.exe"),
    path.resolve(import.meta.dirname, "../hub-memory", `win32-${architecture}`, "t3-hub-guard.exe"),
    path.resolve(
      import.meta.dirname,
      "../../../../native/hub-memory/target",
      architecture,
      "t3-hub-guard.exe",
    ),
    path.resolve(
      import.meta.dirname,
      "../../../native/hub-memory/target",
      architecture,
      "t3-hub-guard.exe",
    ),
  ];
}
