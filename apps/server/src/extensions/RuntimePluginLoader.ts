// @effect-diagnostics nodeBuiltinImport:off - Node ESM imports require native file URLs and real paths.
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import { RuntimePluginHost } from "./RuntimePluginHost.ts";
import { startRuntimePluginWorker } from "./RuntimePluginWorker.ts";

const validId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Loads a conversation's explicitly named project plugin. Plugins execute as
 * server-side JavaScript, with the server's OS permissions; this is not a VM.
 * The plugin module should create effects in activate and register disposal.
 */
export function makeRuntimePluginLoader(host = new RuntimePluginHost()) {
  return {
    async load(scope: string, projectRoot: string, id: string) {
      if (!validId.test(id)) throw new Error("Invalid plugin identifier.");
      const root = await NodeFs.realpath(NodePath.join(projectRoot, ".t3", "runtime-plugins"));
      const project = await NodeFs.realpath(projectRoot);
      const relativeRoot = NodePath.relative(project, root);
      if (!relativeRoot || relativeRoot.startsWith("..") || NodePath.isAbsolute(relativeRoot))
        throw new Error("Plugin directory is outside the project.");
      const file = await NodeFs.realpath(NodePath.join(root, `${id}.mjs`));
      const relativeFile = NodePath.relative(root, file);
      if (!relativeFile || relativeFile.startsWith("..") || NodePath.isAbsolute(relativeFile))
        throw new Error("Plugin file is outside the plugin directory.");
      const content = await NodeFs.readFile(file);
      const revision = NodeCrypto.createHash("sha256").update(content).digest("hex");
      return host.load(scope, id, revision, async (context) => {
        const worker = await startRuntimePluginWorker({ file, revision });
        context.onDispose(() => worker.dispose());
        context.onCancel(() => worker.terminate());
        context.register((input) => worker.invoke(input));
      });
    },
    invoke: (scope: string, id: string, input: unknown) => host.invoke(scope, id, input),
    unload: (scope: string, id: string) => host.unload(scope, id),
    cancel: (scope: string, id: string) => host.cancel(scope, id),
    unloadDisabled: (enabled: ReadonlySet<string>) => host.unloadDisabled(enabled),
    status: (scope: string, id: string) => host.status(scope, id),
  };
}
