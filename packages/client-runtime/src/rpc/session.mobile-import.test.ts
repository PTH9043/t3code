import { afterEach, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("loads the shared RPC session without the desktop EventTarget API", async () => {
  vi.resetModules();
  // Node lazily initializes its web APIs, whose implementation itself needs EventTarget.
  void globalThis.FormData;
  void globalThis.Headers;
  void globalThis.Request;
  void globalThis.Response;
  vi.stubGlobal("EventTarget", undefined);
  const session = await import("./session.ts");
  expect(session.RpcSessionFactory).toBeDefined();
});
