import { useAuth, useClerk, useUser } from "@clerk/react";

import { hasClerkPublicConfig } from "../../cloud/publicConfig";
import { configuredHostedAppUrl } from "../../hostedPairing";
import { isElectron } from "../../env";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function GoogleAccountSection() {
  return hasClerkPublicConfig() ? (
    <ConfiguredGoogleAccountSection />
  ) : (
    <BrowserGoogleAccountSection />
  );
}

function ConfiguredGoogleAccountSection() {
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const account =
    user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? user?.username ?? null;

  return (
    <SettingsSection {...searchableSetting("google-account")}>
      <SettingsRow
        title={!isLoaded ? "확인 중" : isSignedIn ? "로그인됨" : "로그인 필요"}
        description={
          !isLoaded
            ? "로그인 상태를 확인하는 중입니다."
            : isSignedIn
              ? `${account ?? "계정"}(으)로 로그인되어 있습니다.`
              : "Google로 로그인하면 기본 브라우저에서 Google 계정을 선택하고 인증할 수 있습니다."
        }
        control={
          !isLoaded ? null : isSignedIn ? (
            <Button type="button" size="sm" variant="outline" onClick={() => void clerk.signOut()}>
              로그아웃
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() =>
                clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron))
              }
            >
              Google로 로그인
            </Button>
          )
        }
      />
    </SettingsSection>
  );
}

function BrowserGoogleAccountSection() {
  return (
    <SettingsSection {...searchableSetting("google-account")}>
      <SettingsRow
        title="웹 앱 로그인"
        description="이 빌드에는 T3 Connect 설정이 없어 앱 안에서 로그인 상태를 확인할 수 없습니다. 웹 앱에서 Google 계정으로 로그인합니다."
        control={
          <Button
            type="button"
            size="sm"
            onClick={() =>
              window.desktopBridge?.openExternal(configuredHostedAppUrl()) ??
              window.open(configuredHostedAppUrl(), "_blank")
            }
          >
            웹 앱에서 로그인
          </Button>
        }
      />
    </SettingsSection>
  );
}
