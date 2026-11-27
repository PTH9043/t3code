import { describe, expect, it } from "vite-plus/test";
import { resolveClerkAuthProps, resolveClerkSignInProps } from "../clerk/authRedirect";
import { tierLabelKr } from "./GoogleAccountSection";

describe("GoogleAccountSection & Clerk auth redirect helpers", () => {
  it("omits redirect override on Electron and preserves href on web for both sign-in and sign-up", () => {
    expect(resolveClerkAuthProps("t3code://app/settings", true)).toEqual({});
    expect(resolveClerkSignInProps("t3code://app/settings", true)).toEqual({});
    expect(resolveClerkAuthProps("https://t3.example/settings", false)).toEqual({
      forceRedirectUrl: "https://t3.example/settings",
    });
  });

  it("maps Google account subscription tiers to concise Korean labels", () => {
    expect(tierLabelKr("ultra")).toBe("Ultra");
    expect(tierLabelKr("pro")).toBe("Pro");
    expect(tierLabelKr("free")).toBe("무료");
    expect(tierLabelKr(undefined)).toBe("");
  });
});
