import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const mocks = vi.hoisted(() => ({ fetchSession: vi.fn(), login: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useEffect: () => {},
    useCallback: (fn: unknown) => fn,
    startTransition: (fn: () => void) => fn(),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../environments/primary", () => ({
  peekPairingTokenFromUrl: () => null,
  stripPairingTokenFromUrl: () => {},
  submitServerAuthCredential: vi.fn(),
  fetchSessionState: mocks.fetchSession,
}));
vi.mock("../../connection/onboarding", () => ({ connectPairing: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("../../hostedPairing", () => ({ readHostedPairingRequest: () => null }));

import { PairingRouteSurface } from "./PairingRouteSurface";

describe("Google login before pairing", () => {
  beforeEach(() => {
    hooks.reset();
    mocks.fetchSession.mockReset();
    mocks.login.mockReset().mockResolvedValue({ subject: "user" });
    vi.stubGlobal("window", { desktopBridge: { googleSignIn: { loginT3: mocks.login } } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("enters only after the environment confirms a session", async () => {
    const onAuthenticated = vi.fn();
    const auth = { bootstrapMethods: ["one-time-token"] } as never;
    mocks.fetchSession.mockResolvedValue({ authenticated: true });
    hooks.beginRender();
    const button = visitElements(
      PairingRouteSurface({ auth, onAuthenticated }),
      (element) => element.props.children === "Google 계정으로 T3 로그인",
    );
    expect(button).not.toBeNull();
    (button!.props.onClick as () => void)();
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
    expect(mocks.login).toHaveBeenCalledOnce();
    expect(mocks.fetchSession).toHaveBeenCalledOnce();
  });

  it("does not enter if the browser session was not established", async () => {
    const onAuthenticated = vi.fn();
    const auth = { bootstrapMethods: ["one-time-token"] } as never;
    mocks.fetchSession.mockResolvedValue({ authenticated: false });
    hooks.beginRender();
    const button = visitElements(
      PairingRouteSurface({ auth, onAuthenticated }),
      (element) => element.props.children === "Google 계정으로 T3 로그인",
    );
    (button!.props.onClick as () => void)();
    await vi.waitFor(() => expect(mocks.fetchSession).toHaveBeenCalledOnce());
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
});
