import { describe, expect, it } from "vite-plus/test";
import { resolveClerkAuthProps, resolveClerkSignInProps } from "../clerk/authRedirect";
import { isClerkSingleSessionMode } from "./GoogleAccountSection";

describe("GoogleAccountSection & Clerk auth redirect helpers", () => {
  it("omits redirect override on Electron and preserves href on web for both sign-in and sign-up", () => {
    expect(resolveClerkAuthProps("t3code://app/settings", true)).toEqual({});
    expect(resolveClerkSignInProps("t3code://app/settings", true)).toEqual({});
    expect(resolveClerkAuthProps("https://t3.example/settings", false)).toEqual({
      forceRedirectUrl: "https://t3.example/settings",
    });
  });

  it("detects Clerk singleSessionMode accurately and defaults safely to true", () => {
    expect(
      isClerkSingleSessionMode({
        __unstable__environment: { authConfig: { singleSessionMode: true } },
      }),
    ).toBe(true);
    expect(
      isClerkSingleSessionMode({
        __unstable__environment: { authConfig: { singleSessionMode: false } },
      }),
    ).toBe(false);
    expect(isClerkSingleSessionMode({})).toBe(true);
  });
});
