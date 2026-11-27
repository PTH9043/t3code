import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EnrolledGoogleAccountSummary,
  GoogleEnrollmentStatusResult,
} from "@t3tools/contracts";
import { useAuth, useClerk, useSessionList, useUser } from "@clerk/react";

import { hasClerkPublicConfig } from "../../cloud/publicConfig";
import { configuredHostedAppUrl } from "../../hostedPairing";
import { isElectron } from "../../env";
import { resolveClerkAuthProps } from "../clerk/authRedirect";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Clerk 인스턴스의 single_session_mode 여부를 판별한다.
 * single_session_mode === true인 환경에서 로그인된 채로 openSignIn/openSignUp을 호출하면
 * @clerk/clerk-js 프로덕션 번들이 아무 응답 없이 return(멈춤)하므로,
 * 반드시 signOut이 완료되어 !isSignedIn이 된 직후 모달을 열어야 한다.
 */
export function isClerkSingleSessionMode(clerk: unknown): boolean {
  const env = (
    clerk as {
      readonly __unstable__environment?: {
        readonly authConfig?: { readonly singleSessionMode?: boolean };
      };
    } | null
  )?.__unstable__environment;
  if (typeof env?.authConfig?.singleSessionMode === "boolean") {
    return env.authConfig.singleSessionMode;
  }
  return true;
}

export function GoogleAccountSection() {
  return hasClerkPublicConfig() ? <UnifiedGoogleAccountSection /> : <BrowserGoogleAccountSection />;
}

function UnifiedGoogleAccountSection() {
  const clerk = useClerk();
  const { isLoaded, isSignedIn, sessionId } = useAuth();
  const { user } = useUser();
  const { isLoaded: sessionsLoaded, sessions } = useSessionList();

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pendingAuthAction, setPendingAuthAction] = useState<"signIn" | "signUp" | null>(null);

  // 선택적 Google Drive 백업 직접 연결 (같은 카드 하단 접힘 영역)
  const bridge = typeof window !== "undefined" ? window.desktopBridge?.googleSignIn : undefined;
  const [localStatus, setLocalStatus] = useState<GoogleEnrollmentStatusResult | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [showDriveConnect, setShowDriveConnect] = useState(false);
  const clientIdHydratedRef = useRef(false);

  const authProps = resolveClerkAuthProps(window.location.href, isElectron);
  const singleSession = isClerkSingleSessionMode(clerk);
  const primaryAccount =
    user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? user?.username ?? null;

  const refreshDriveAccounts = useCallback(async () => {
    if (!bridge?.listAccountsT3) return;
    try {
      const data = await bridge.listAccountsT3();
      setLocalStatus(data);
      if (data.defaultClientId && !clientIdHydratedRef.current) {
        clientIdHydratedRef.current = true;
        setClientId(data.defaultClientId);
      }
    } catch {
      // Ignore when unauthenticated or unavailable
    }
  }, [bridge]);

  useEffect(() => {
    void refreshDriveAccounts();
  }, [refreshDriveAccounts]);

  // single_session_mode에서 다른 Google 아이디로 전환/가입 시:
  // signOut 완료로 !isSignedIn이 되는 정확한 순간에 openSignIn / openSignUp을 자동 실행해 멈춤을 방지한다.
  useEffect(() => {
    if (!isLoaded || isSignedIn || !pendingAuthAction) return;
    const action = pendingAuthAction;
    setPendingAuthAction(null);
    setBusyAction(null);
    const props = resolveClerkAuthProps(window.location.href, isElectron);
    if (action === "signUp") {
      clerk.openSignUp(props);
    } else {
      clerk.openSignIn(props);
    }
  }, [clerk, isLoaded, isSignedIn, pendingAuthAction]);

  const handleOpenGoogleAuth = async (mode: "signIn" | "signUp") => {
    if (!isLoaded) return;
    if (isSignedIn && singleSession) {
      setBusyAction(`switch:${mode}`);
      setPendingAuthAction(mode);
      try {
        await clerk.signOut();
      } catch {
        setPendingAuthAction(null);
        setBusyAction(null);
        toastManager.add({
          type: "error",
          title: "Google 계정 전환 준비 실패",
          description: "현재 세션을 종료하지 못했습니다. 로그아웃 후 다시 시도해 주세요.",
        });
      }
      return;
    }

    try {
      if (mode === "signUp") {
        clerk.openSignUp(authProps);
      } else {
        clerk.openSignIn(authProps);
      }
    } catch {
      toastManager.add({
        type: "error",
        title: "Google 로그인 창 열기 실패",
        description:
          "이전 인증이 진행 중이거나 세션 충돌이 발생했습니다. 잠시 후 다시 시도해 주세요.",
      });
    }
  };

  const handleSwitchSession = async (targetSessionId: string) => {
    setBusyAction(`session:${targetSessionId}`);
    try {
      await clerk.setActive({ session: targetSessionId });
      toastManager.add({
        type: "success",
        title: "Google 계정 전환 완료",
        description: "선택한 계정으로 전환되었습니다.",
      });
    } catch {
      toastManager.add({
        type: "error",
        title: "계정 전환 실패",
        description: "선택한 계정으로 전환하지 못했습니다.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSignOutSession = async (targetSessionId?: string) => {
    setBusyAction(`signout:${targetSessionId ?? "all"}`);
    try {
      await clerk.signOut(targetSessionId ? { sessionId: targetSessionId } : undefined);
    } finally {
      setBusyAction(null);
    }
  };

  const handleConnectDriveOAuth = async () => {
    if (!bridge?.enrollT3) return;
    const effectiveClientId = clientId.trim() || localStatus?.defaultClientId || "";
    if (!effectiveClientId) {
      toastManager.add({
        type: "error",
        title: "OAuth Client ID 필요",
        description: "Google Cloud OAuth Client ID를 입력해 주세요.",
      });
      return;
    }
    setBusyAction("drive-connect");
    try {
      const identity = await bridge.enrollT3({
        clientId: effectiveClientId,
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        linkDriveBackup: true,
      });
      setClientSecret("");
      toastManager.add({
        type: "success",
        title: "Google Drive 백업 연결 완료",
        description: `${identity.email ?? identity.name ?? identity.subject} 계정이 드라이브 백업에 연결되었습니다.`,
      });
      await refreshDriveAccounts();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Google Drive 연결 실패",
        description:
          error instanceof Error ? error.message : "OAuth 설정과 브라우저 인증을 확인해 주세요.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancelDriveAuth = async () => {
    try {
      await bridge?.cancel?.();
    } finally {
      setBusyAction(null);
    }
  };

  const handleBindDriveAccount = async (account: EnrolledGoogleAccountSummary) => {
    if (!bridge?.bindDriveBackupAccountT3) return;
    setBusyAction(`bind:${account.subject}`);
    try {
      const res = await bridge.bindDriveBackupAccountT3(account.subject);
      toastManager.add({
        type: "success",
        title: "Drive 백업 계정 변경됨",
        description: `${res.email ?? account.email ?? account.subject} 계정이 백업 대상으로 지정되었습니다.`,
      });
      await refreshDriveAccounts();
    } finally {
      setBusyAction(null);
    }
  };

  const handleRemoveDriveAccount = async (account: EnrolledGoogleAccountSummary) => {
    if (!bridge?.unenrollT3) return;
    setBusyAction(`remove:${account.subject}`);
    try {
      await bridge.unenrollT3(account.subject);
      toastManager.add({
        type: "success",
        title: "Drive 연결 해제됨",
        description: `${account.email ?? account.subject} 계정의 Drive 연결을 해제했습니다.`,
      });
      await refreshDriveAccounts();
    } finally {
      setBusyAction(null);
    }
  };

  const driveAccounts = localStatus?.accounts ?? [];
  const hasSavedClientId = Boolean(localStatus?.defaultClientId);

  return (
    <SettingsSection {...searchableSetting("google-account")}>
      <SettingsRow
        title={!isLoaded ? "확인 중" : isSignedIn ? "Google 계정 연결됨" : "Google 로그인 필요"}
        description={
          !isLoaded
            ? "로그인 상태를 확인하는 중입니다."
            : pendingAuthAction !== null
              ? "기존 세션을 정리하고 새 Google 계정 선택 창을 여는 중입니다..."
              : isSignedIn
                ? `${primaryAccount ?? "계정"}(으)로 로그인되어 있습니다. 다른 Google 아이디로 바로 전환하거나 새 아이디를 가입·연결할 수 있습니다.`
                : "처음 쓰는 Google 아이디는 '새 Google 계정 가입'을, 기존 아이디는 'Google로 로그인'을 누르세요."
        }
        control={
          !isLoaded ? null : isSignedIn ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction !== null}
                onClick={() => void handleOpenGoogleAuth("signIn")}
              >
                {singleSession ? "다른 Google 계정으로 전환" : "+ 다른 Google 계정 추가"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction !== null}
                onClick={() => void handleOpenGoogleAuth("signUp")}
              >
                새 Google 계정 가입·전환
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busyAction !== null}
                onClick={() => void handleSignOutSession(sessionId ?? undefined)}
              >
                로그아웃
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busyAction !== null}
                onClick={() => void handleOpenGoogleAuth("signIn")}
              >
                Google로 로그인
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction !== null}
                onClick={() => void handleOpenGoogleAuth("signUp")}
              >
                새 Google 계정 가입
              </Button>
            </div>
          )
        }
      />

      {isSignedIn && sessionsLoaded && sessions && sessions.length > 1 ? (
        <div className="mt-3 grid gap-2 rounded-xl border border-border/70 bg-muted/20 p-3">
          {sessions.map((session) => {
            const isActive = session.id === sessionId;
            const sessionEmail =
              session.user?.primaryEmailAddress?.emailAddress ??
              session.user?.fullName ??
              session.user?.username ??
              session.id;
            return (
              <div
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-xs"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium">{sessionEmail}</span>
                  {isActive ? (
                    <Badge variant="success" size="sm">
                      활성
                    </Badge>
                  ) : null}
                </div>
                <div className="flex items-center gap-1.5">
                  {!isActive ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={busyAction !== null}
                      onClick={() => void handleSwitchSession(session.id)}
                    >
                      이 계정으로 전환
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busyAction !== null}
                    onClick={() => void handleSignOutSession(session.id)}
                  >
                    로그아웃
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {bridge?.listAccountsT3 ? (
        <div className="mt-3 rounded-xl border border-border/60 bg-muted/10 px-3.5 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-muted-foreground">
                Google Drive 백업 직접 연결 (선택)
              </span>
              {driveAccounts.length > 0 ? (
                <Badge variant="success" size="sm">
                  {driveAccounts[0]?.email ?? "연결됨"}
                </Badge>
              ) : null}
            </div>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setShowDriveConnect((v) => !v)}
            >
              {showDriveConnect ? "접기" : driveAccounts.length > 0 ? "관리" : "연결 설정"}
            </Button>
          </div>

          {showDriveConnect ? (
            <div className="mt-3 grid gap-2.5 border-t border-border/60 pt-3">
              {driveAccounts.map((acc) => (
                <div
                  key={acc.subject}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-xs"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">{acc.email ?? acc.name ?? acc.subject}</span>
                    {acc.driveBackupLinked ? (
                      <Badge variant="success" size="sm">
                        Drive 연결됨
                      </Badge>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {acc.driveBackupLinked && driveAccounts.length > 1 ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={busyAction !== null}
                        onClick={() => void handleBindDriveAccount(acc)}
                      >
                        백업에 사용
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busyAction !== null}
                      onClick={() => void handleRemoveDriveAccount(acc)}
                    >
                      해제
                    </Button>
                  </div>
                </div>
              ))}

              <div className="grid gap-2 sm:grid-cols-12">
                {!hasSavedClientId ? (
                  <>
                    <Input
                      className="sm:col-span-5"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      placeholder="Google Cloud OAuth Client ID"
                    />
                    <Input
                      className="sm:col-span-4"
                      type="password"
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                      placeholder="Client Secret (Desktop 앱)"
                    />
                  </>
                ) : (
                  <p className="flex items-center text-[11px] text-muted-foreground sm:col-span-9">
                    저장된 OAuth 설정으로 Google Drive(`drive.file`) 권한을 연결합니다.
                  </p>
                )}
                {busyAction === "drive-connect" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="sm:col-span-3"
                    onClick={() => void handleCancelDriveAuth()}
                  >
                    인증 취소
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    className="sm:col-span-3"
                    disabled={busyAction !== null}
                    onClick={() => void handleConnectDriveOAuth()}
                  >
                    Google Drive 연결
                  </Button>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
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
