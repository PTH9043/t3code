import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const clerkState = vi.hoisted(() => ({
  configured: false,
  isLoaded: true,
  isSignedIn: false,
  user: null as null | { primaryEmailAddress?: { emailAddress: string } },
}));

vi.mock("@clerk/react", () => ({
  useClerk: () => ({ openSignIn: vi.fn(), signOut: vi.fn() }),
  useAuth: () => ({ isLoaded: clerkState.isLoaded, isSignedIn: clerkState.isSignedIn }),
  useUser: () => ({ user: clerkState.user }),
}));
vi.mock("../../cloud/publicConfig", () => ({
  hasClerkPublicConfig: () => clerkState.configured,
}));
vi.mock("../../hostedPairing", () => ({
  configuredHostedAppUrl: () => "https://app.t3.codes",
}));

import { GoogleAccountSection } from "./GoogleAccountSection";
import { searchSettings } from "./settingsSearch";

describe("Google account settings", () => {
  beforeEach(() => {
    Object.assign(clerkState, { configured: false, isLoaded: true, isSignedIn: false, user: null });
  });

  it("explains the hosted login when this build has no T3 Connect config", () => {
    const html = renderToStaticMarkup(<GoogleAccountSection />);
    expect(html).toContain("웹 앱에서 로그인");
    expect(searchSettings("Google 로그인")[0]).toMatchObject({
      id: "google-account",
      to: "/settings/connections",
    });
  });

  it("shows the signed-in account instead of the login button", () => {
    Object.assign(clerkState, {
      configured: true,
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: "me@example.com" } },
    });
    const html = renderToStaticMarkup(<GoogleAccountSection />);
    expect(html).toContain("me@example.com");
    expect(html).toContain("로그아웃");
    expect(html).not.toContain("Google로 로그인");
  });

  it("offers login when signed out and waits while Clerk loads", () => {
    clerkState.configured = true;
    expect(renderToStaticMarkup(<GoogleAccountSection />)).toContain("Google로 로그인");
    clerkState.isLoaded = false;
    const loading = renderToStaticMarkup(<GoogleAccountSection />);
    expect(loading).toContain("확인하는 중");
    expect(loading).not.toContain("Google로 로그인");
  });
});
