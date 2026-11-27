/**
 * Conversation-scoped runtime plugin lifecycle. The host only owns effects a
 * plugin explicitly registers for disposal; it cannot undo arbitrary external
 * side effects. A caller must authenticate and authorize the scope and loader.
 */
export type RuntimePluginHandler = (input: unknown) => unknown | Promise<unknown>;
export type RuntimePluginCleanup = () => void | Promise<void>;

export interface RuntimePluginContext {
  readonly register: (handler: RuntimePluginHandler) => void;
  readonly onDispose: (cleanup: RuntimePluginCleanup) => void;
  readonly onCancel: (cancel: RuntimePluginCleanup) => void;
}

export type RuntimePluginActivation = (context: RuntimePluginContext) => void | Promise<void>;

interface Version {
  readonly revision: string;
  readonly handler: RuntimePluginHandler;
  readonly cleanups: ReadonlyArray<RuntimePluginCleanup>;
  readonly cancellations: ReadonlyArray<RuntimePluginCleanup>;
  active: number;
  retired: boolean;
  disposal?: Promise<void>;
}

interface Slot {
  current?: Version;
  readonly retiring: Set<Version>;
  cleanupFailures: string[];
}

const keyFor = (scope: string, id: string): string => JSON.stringify([scope, id]);

async function runCleanups(cleanups: ReadonlyArray<RuntimePluginCleanup>): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    const details = failures.map((failure) =>
      failure instanceof Error ? failure.message : String(failure),
    );
    throw new AggregateError(failures, `Plugin cleanup did not complete: ${details.join("; ")}`);
  }
}

export class RuntimePluginHost {
  private readonly slots = new Map<string, Slot>();
  private readonly pending = new Map<string, Promise<void>>();

  private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key);
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending.set(key, next);
    if (previous) await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.pending.get(key) === next) this.pending.delete(key);
    }
  }

  private retire(slot: Slot, version: Version): void {
    version.retired = true;
    slot.retiring.add(version);
    if (version.active !== 0 || version.disposal) return;
    version.disposal = runCleanups(version.cleanups)
      .catch((error: unknown) => {
        slot.cleanupFailures.push(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        slot.retiring.delete(version);
      });
  }

  async load(scope: string, id: string, revision: string, activate: RuntimePluginActivation) {
    if (!scope.trim() || !id.trim() || !revision.trim())
      throw new Error("Invalid plugin identity.");
    const key = keyFor(scope, id);
    return this.serial(key, async () => {
      const slot = this.slots.get(key) ?? { cleanupFailures: [], retiring: new Set<Version>() };
      const cleanups: RuntimePluginCleanup[] = [];
      const cancellations: RuntimePluginCleanup[] = [];
      let handler: RuntimePluginHandler | undefined;
      let open = true;
      const context: RuntimePluginContext = {
        register(next) {
          if (!open || handler || typeof next !== "function")
            throw new Error("Invalid plugin handler.");
          handler = next;
        },
        onDispose(cleanup) {
          if (!open || typeof cleanup !== "function") throw new Error("Invalid plugin cleanup.");
          cleanups.push(cleanup);
        },
        onCancel(cancel) {
          if (!open || typeof cancel !== "function")
            throw new Error("Invalid plugin cancellation.");
          cancellations.push(cancel);
        },
      };
      try {
        await activate(context);
        open = false;
        if (!handler) throw new Error("Plugin did not register a handler.");
      } catch (error) {
        open = false;
        try {
          await runCleanups(cleanups);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Plugin activation and rollback failed.");
        }
        throw error;
      }
      const previous = slot.current;
      slot.current = { revision, handler, cleanups, cancellations, active: 0, retired: false };
      this.slots.set(key, slot);
      if (previous) {
        this.retire(slot, previous);
        if (previous.disposal) await previous.disposal;
      }
      return {
        revision,
        replaced: previous?.revision ?? null,
        pendingCleanup: slot.retiring.size,
        cleanupFailures: [...slot.cleanupFailures],
      };
    });
  }

  async invoke(scope: string, id: string, input: unknown): Promise<unknown> {
    const slot = this.slots.get(keyFor(scope, id));
    const version = slot?.current;
    if (!slot || !version) throw new Error("Plugin is not loaded in this conversation.");
    version.active += 1;
    try {
      return await version.handler(input);
    } finally {
      version.active -= 1;
      if (version.retired) this.retire(slot, version);
    }
  }

  async unload(scope: string, id: string) {
    const key = keyFor(scope, id);
    return this.serial(key, async () => {
      const slot = this.slots.get(key);
      if (!slot?.current)
        return {
          removed: false,
          pendingCleanup: slot?.retiring.size ?? 0,
          cleanupFailures: [...(slot?.cleanupFailures ?? [])],
        };
      const version = slot.current;
      delete slot.current;
      this.retire(slot, version);
      if (version.disposal) await version.disposal;
      return {
        removed: true,
        pendingCleanup: slot.retiring.size,
        cleanupFailures: [...slot.cleanupFailures],
      };
    });
  }

  async unloadDisabled(enabledScopes: ReadonlySet<string>): Promise<void> {
    const keys = new Set([...this.slots.keys(), ...this.pending.keys()]);
    await Promise.all(
      [...keys].map(async (key) => {
        const [scope, id] = JSON.parse(key) as [string, string];
        if (enabledScopes.has(scope)) return;
        const slot = this.slots.get(key);
        const active =
          slot && [slot.current, ...slot.retiring].some((version) => version && version.active > 0);
        if (active) await this.cancel(scope, id);
        else await this.unload(scope, id);
      }),
    );
  }

  async cancel(scope: string, id: string) {
    const key = keyFor(scope, id);
    return this.serial(key, async () => {
      const slot = this.slots.get(key);
      if (!slot) return { cancelled: false, pendingCleanup: 0, cleanupFailures: [] };
      const versions = new Set(slot.retiring);
      if (slot.current) versions.add(slot.current);
      delete slot.current;
      for (const version of versions) {
        try {
          await runCleanups(version.cancellations);
        } catch (error) {
          slot.cleanupFailures.push(error instanceof Error ? error.message : String(error));
        }
        this.retire(slot, version);
        if (version.disposal) await version.disposal;
      }
      return {
        cancelled: versions.size > 0,
        pendingCleanup: slot.retiring.size,
        cleanupFailures: [...slot.cleanupFailures],
      };
    });
  }

  status(scope: string, id: string) {
    const slot = this.slots.get(keyFor(scope, id));
    return {
      revision: slot?.current?.revision ?? null,
      pendingCleanup: slot?.retiring.size ?? 0,
      cleanupFailures: [...(slot?.cleanupFailures ?? [])],
    };
  }
}
