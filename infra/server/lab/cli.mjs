import * as NodeUtil from "node:util";

import {
  buildImage,
  defaultStateDir,
  deploy,
  replaceActive,
  rollback,
  start,
  status,
  stop,
} from "./manager.mjs";

const parsed = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    "state-dir": { type: "string", default: defaultStateDir },
    image: { type: "string" },
    version: { type: "string", default: "0.1.0" },
    variant: { type: "string", default: "complete" },
    fault: { type: "string", default: "none" },
  },
});
const action = parsed.positionals[0] ?? "status";
const directory = parsed.values["state-dir"];
try {
  let result;
  switch (action) {
    case "build":
      result = await buildImage(directory, parsed.values);
      break;
    case "deploy":
      if (!parsed.values.image) throw new Error("deploy requires --image");
      result = await deploy(directory, parsed.values.image, { fault: parsed.values.fault });
      break;
    case "status":
      result = await status(directory);
      break;
    case "rollback":
      result = await rollback(directory);
      break;
    case "replace":
      result = await replaceActive(directory);
      break;
    case "start":
      result = await start(directory);
      break;
    case "stop":
      result = await stop(directory);
      break;
    default:
      throw new Error("Use build, deploy, status, rollback, replace, start or stop");
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
