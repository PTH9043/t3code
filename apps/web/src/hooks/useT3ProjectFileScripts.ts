import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, T3ProjectFileScript } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { projectEnvironment } from "~/state/projects";

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

/**
 * Scripts declared in the project's checked-in `t3.json`, offered in the
 * scripts menu for import. A project without the file declares nothing, which
 * the server reports as `projectFile: null` rather than a read failure, so an
 * absent file no longer looks like an error in the logs.
 */
export function useT3ProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<T3ProjectFileScript> {
  const result = useAtomValue(
    projectEnvironment.readT3File({ environmentId, input: { cwd: cwd ?? "" } }),
  );
  if (cwd === null) return NO_SCRIPTS;
  const data = Option.getOrNull(AsyncResult.value(result));
  return data?.projectFile?.scripts ?? NO_SCRIPTS;
}
