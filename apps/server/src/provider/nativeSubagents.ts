import type { ProviderSessionStartInput } from "@t3tools/contracts";
import { DELEGATE_NODE_PREFIX } from "../mcp/toolkits/workspaceDelegate.ts";

/** A workspace_delegate child cannot create another worker, including through native tools. */
export const restrictNativeSubagents = (
  input: Pick<ProviderSessionStartInput, "execution"> & {
    readonly restrictNativeSubagents?: boolean;
  },
): boolean =>
  input.restrictNativeSubagents === true ||
  input.execution?.nodeId.startsWith(DELEGATE_NODE_PREFIX) === true;
