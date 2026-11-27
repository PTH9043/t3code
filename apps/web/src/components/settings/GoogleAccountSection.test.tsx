import { describe, expect, it } from "vite-plus/test";
import { resolveClerkAuthProps, resolveClerkSignInProps } from "../clerk/authRedirect";
import { isClerkSingleSessionMode, summarizeGoogleAccountsState } from "./GoogleAccountSection";

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

  it("summarizes multi-account Google login state and active Drive account accurately", () => {
    expect(summarizeGoogleAccountsState(null)).toEqual({
      accountCount: 0,
      driveLinkedCount: 0,
      activeDriveAccount: null,
    });

    const summary = summarizeGoogleAccountsState({
      registered: true,
      oauthConfigured: true,
      activeDriveSubject: "sub-2",
      defaultSubject: "sub-1",
      defaultClientId: "cid-1",
      hasClientSecret: true,
      accounts: [
        {
          subject: "sub-1",
          clientId: "cid-1",
          email: "first@example.com",
          driveBackupLinked: false,
          addedAt: "2026-11-27T00:00:00Z",
          isDefault: true,
        },
        {
          subject: "sub-2",
          clientId: "cid-1",
          email: "second@example.com",
          driveBackupLinked: true,
          addedAt: "2026-11-27T00:01:00Z",
          isDefault: false,
        },
      ],
    });
    expect(summary.accountCount).toBe(2);
    expect(summary.driveLinkedCount).toBe(1);
    expect(summary.activeDriveAccount?.email).toBe("second@example.com");
  });
});
