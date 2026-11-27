// @effect-diagnostics nodeBuiltinImport:off - A worker thread isolates plugin faults from the T3 event loop.
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";

// This bootstrap is bundled with the server, so no separate worker artifact is
// needed. It executes in an independent JS isolate, not an OS security sandbox.
const bootstrap = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
let handler;
let open = true;
const cleanups = [];
const message = error => error instanceof Error ? error.message : String(error);
async function dispose() {
  const failures = [];
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch (error) { failures.push(message(error)); }
  }
  if (failures.length) throw new Error('Plugin cleanup failed: ' + failures.join('; '));
}
const ctx = {
  register(next) {
    if (!open || handler || typeof next !== 'function') throw new Error('Invalid plugin handler.');
    handler = next;
  },
  onDispose(cleanup) {
    if (!open || typeof cleanup !== 'function') throw new Error('Invalid plugin cleanup.');
    cleanups.push(cleanup);
  },
};
(async () => {
  try {
    const original = await fs.readFile(workerData.file);
    if (crypto.createHash('sha256').update(original).digest('hex') !== workerData.revision)
      throw new Error('Plugin changed before loading.');
    const url = pathToFileURL(workerData.file);
    url.searchParams.set('revision', workerData.revision);
    url.searchParams.set('generation', workerData.generation);
    const module = await import(url.href);
    if (!original.equals(await fs.readFile(workerData.file))) throw new Error('Plugin changed during loading.');
    if (typeof module.activate !== 'function') throw new Error('Plugin must export activate(context).');
    await module.activate(ctx);
    open = false;
    if (!handler) throw new Error('Plugin did not register a handler.');
    parentPort.postMessage({ type: 'ready' });
  } catch (error) {
    open = false;
    let cleanupError;
    try { await dispose(); } catch (failure) { cleanupError = message(failure); }
    parentPort.postMessage({ type: 'startup-error', message: message(error), cleanupError });
    return;
  }
  parentPort.on('message', async request => {
    if (request.type === 'invoke') {
      try {
        const output = await handler(request.input);
        parentPort.postMessage({ type: 'result', id: request.id, output });
      } catch (error) { parentPort.postMessage({ type: 'failure', id: request.id, message: message(error) }); }
    } else if (request.type === 'dispose') {
      try { await dispose(); parentPort.postMessage({ type: 'disposed' }); }
      catch (error) { parentPort.postMessage({ type: 'dispose-error', message: message(error) }); }
    }
  });
})();
`;

export interface RuntimePluginWorker {
  invoke(input: unknown): Promise<unknown>;
  dispose(): Promise<void>;
  terminate(): Promise<void>;
}

/** Start one exact module revision without blocking the server's event loop. */
export async function startRuntimePluginWorker(input: {
  file: string;
  revision: string;
  startupTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}): Promise<RuntimePluginWorker> {
  const worker = new Worker(bootstrap, {
    eval: true,
    // Node's dev watch mode normally registers modules imported by worker
    // threads with the server watcher. Plugin files are intentionally edited
    // at runtime and must be replaced by this host, not restart the server.
    env: { ...process.env, WATCH_REPORT_DEPENDENCIES: "" },
    workerData: { file: input.file, revision: input.revision, generation: randomUUID() },
  });
  const requests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let startupResolve!: () => void;
  let startupReject!: (error: Error) => void;
  let disposalResolve: (() => void) | undefined;
  let disposalReject: ((error: Error) => void) | undefined;
  let stopped = false;
  const ready = new Promise<void>((resolve, reject) => {
    startupResolve = resolve;
    startupReject = reject;
  });
  const failPending = (error: Error) => {
    startupReject(error);
    disposalReject?.(error);
    for (const pending of requests.values()) pending.reject(error);
    requests.clear();
  };
  worker.on(
    "message",
    (event: {
      type: string;
      id?: string;
      output?: unknown;
      message?: string;
      cleanupError?: string;
    }) => {
      if (event.type === "ready") startupResolve();
      else if (event.type === "startup-error")
        startupReject(
          new Error(event.cleanupError ? `${event.message}; ${event.cleanupError}` : event.message),
        );
      else if (event.type === "disposed") disposalResolve?.();
      else if (event.type === "dispose-error") disposalReject?.(new Error(event.message));
      else if (event.id) {
        const pending = requests.get(event.id);
        if (!pending) return;
        requests.delete(event.id);
        if (event.type === "result") pending.resolve(event.output);
        else pending.reject(new Error(event.message ?? "Plugin invocation failed."));
      }
    },
  );
  worker.on("error", (error) => failPending(error));
  worker.on("exit", (code) => {
    stopped = true;
    failPending(new Error(`Plugin worker exited (${code}).`));
  });
  // A plugin that never finishes activation must not block the T3 server.
  // @effect-diagnostics-next-line globalTimers:off - Worker startup must be bounded even when plugin code blocks its own event loop.
  const timer = setTimeout(
    () => startupReject(new Error("Plugin activation timed out.")),
    input.startupTimeoutMs ?? 30_000,
  );
  try {
    await ready;
  } catch (error) {
    await worker.terminate();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    invoke(inputValue) {
      if (stopped) return Promise.reject(new Error("Plugin worker is not running."));
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        requests.set(id, { resolve, reject });
        try {
          worker.postMessage({ type: "invoke", id, input: inputValue });
        } catch (error) {
          requests.delete(id);
          reject(error);
        }
      });
    },
    async dispose() {
      if (stopped) throw new Error("Plugin worker ended before cleanup could be confirmed.");
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          disposalResolve = resolve;
          disposalReject = reject;
          // @effect-diagnostics-next-line globalTimers:off - A stalled plugin cleanup must not hang replacement or server shutdown.
          cleanupTimer = setTimeout(
            () => reject(new Error("Plugin cleanup timed out; effects may remain.")),
            input.cleanupTimeoutMs ?? 30_000,
          );
          worker.postMessage({ type: "dispose" });
        });
      } finally {
        if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
        await worker.terminate();
      }
    },
    async terminate() {
      if (!stopped) await worker.terminate();
    },
  };
}
