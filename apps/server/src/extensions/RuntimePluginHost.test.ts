import { describe, expect, it } from "vite-plus/test";
import { RuntimePluginHost } from "./RuntimePluginHost.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("runtime plugin lifecycle", () => {
  it("keeps the previous version when activation fails and rolls back staged effects", async () => {
    const host = new RuntimePluginHost();
    const cleanup: string[] = [];
    await host.load("chat-a", "lookup", "one", ({ register }) => register(() => "old"));
    await expect(
      host.load("chat-a", "lookup", "two", ({ onDispose }) => {
        onDispose(() => {
          cleanup.push("first");
        });
        onDispose(() => {
          cleanup.push("second");
        });
        throw new Error("candidate failed");
      }),
    ).rejects.toThrow("candidate failed");
    expect(cleanup).toEqual(["second", "first"]);
    expect(await host.invoke("chat-a", "lookup", null)).toBe("old");
    expect(host.status("chat-a", "lookup").revision).toBe("one");
  });

  it("routes new calls to the new revision while an old call drains before cleanup", async () => {
    const host = new RuntimePluginHost();
    const started = deferred<void>();
    const release = deferred<void>();
    const disposed = deferred<void>();
    await host.load("chat-a", "lookup", "one", ({ register, onDispose }) => {
      register(async () => {
        started.resolve();
        await release.promise;
        return "old";
      });
      onDispose(() => disposed.resolve());
    });
    const previousCall = host.invoke("chat-a", "lookup", null);
    await started.promise;
    const reload = await host.load("chat-a", "lookup", "two", ({ register }) =>
      register(() => "new"),
    );
    expect(reload.pendingCleanup).toBe(1);
    expect(await host.invoke("chat-a", "lookup", null)).toBe("new");
    release.resolve();
    expect(await previousCall).toBe("old");
    await disposed.promise;
  });

  it("isolates conversations and serializes competing updates", async () => {
    const host = new RuntimePluginHost();
    const gate = deferred<void>();
    const started = deferred<void>();
    const first = host.load("chat-a", "tool", "one", async ({ register }) => {
      started.resolve();
      await gate.promise;
      register(() => "one");
    });
    await started.promise;
    const second = host.load("chat-a", "tool", "two", ({ register }) => register(() => "two"));
    await host.load("chat-b", "tool", "other", ({ register }) => register(() => "other"));
    gate.resolve();
    await Promise.all([first, second]);
    expect(await host.invoke("chat-a", "tool", null)).toBe("two");
    expect(await host.invoke("chat-b", "tool", null)).toBe("other");
    expect(await host.unload("chat-a", "tool")).toMatchObject({ removed: true, pendingCleanup: 0 });
    await expect(host.invoke("chat-a", "tool", null)).rejects.toThrow("not loaded");
    expect(await host.invoke("chat-b", "tool", null)).toBe("other");
  });

  it("drains a pending activation if its conversation disables creator mode", async () => {
    const host = new RuntimePluginHost();
    const gate = deferred<void>();
    const started = deferred<void>();
    const cleaned = deferred<void>();
    const loading = host.load("chat-a", "tool", "one", async ({ register, onDispose }) => {
      started.resolve();
      await gate.promise;
      register(() => "one");
      onDispose(() => cleaned.resolve());
    });
    await started.promise;
    const disabling = host.unloadDisabled(new Set());
    gate.resolve();
    await Promise.all([loading, disabling, cleaned.promise]);
    expect(host.status("chat-a", "tool").revision).toBeNull();
  });

  it("surfaces cleanup failures without claiming the retired effect was undone", async () => {
    const host = new RuntimePluginHost();
    const attempted = deferred<void>();
    await host.load("chat-a", "tool", "one", ({ register, onDispose }) => {
      register(() => null);
      onDispose(() => {
        attempted.resolve();
        throw new Error("cleanup failed");
      });
    });
    await host.unload("chat-a", "tool");
    await attempted.promise;
    expect(host.status("chat-a", "tool").cleanupFailures).toEqual([
      "Plugin cleanup did not complete: cleanup failed",
    ]);
  });
});
