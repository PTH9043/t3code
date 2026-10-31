import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { verifyResearchUpgradeEvidence } from "./research-upgrade-evidence.ts";

const args = process.argv.slice(2);
const argument = (name: string) => {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`);
  return NodePath.resolve(value);
};
const manifestPath = argument("--manifest");
const result = await verifyResearchUpgradeEvidence({
  manifest: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
    await NodeFSP.readFile(manifestPath, "utf8"),
  ),
  workspaceRoot: argument("--workspace"),
  evidenceRoot: NodePath.dirname(manifestPath),
});
console.log(JSON.stringify(result));
