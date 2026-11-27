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

/**
 * 로그인된 Google 계정 목록의 Drive 백업 상태 요약을 계산한다.
 */
export function summarizeGoogleAccountsState(status: GoogleEnrollmentStatusResult | null): {
  readonly accountCount: number;
  readonly driveLinkedCount: number;
  readonly activeDriveAccount: EnrolledGoogleAccountSummary | null;
} {
  const accounts = status?.accounts ?? [];
  const driveLinkedCount = accounts.filter((a) => a.driveBackupLinked).length;
  const activeDriveAccount =
    (status?.activeDriveSubject
      ? accounts.find((a) => a.subject === status.activeDriveSubject)
      : undefined) ?? null;
  return {
    accountCount: accounts.length,
    driveLinkedCount,
    activeDriveAccount,
  };
}

export function GoogleAccountSection() {
  const bridge = typeof window !== "undefined" ? window.desktopBridge?.googleSignIn : undefined;
  const supportsLocalMultiAccount = Boolean(
    bridge?.listAccountsT3 && bridge?.addAccountT3 && bridge?.configureOAuthAppT3,
  );

  return (
    <SettingsSection {...searchableSetting("google-account")}>
      {supportsLocalMultiAccount ? (
        <LocalMultiGoogleAccountsPanel />
      ) : (
        <WebOnlyGoogleAccountNotice />
      )}
      {hasClerkPublicConfig() ? <T3ConnectClerkRelayCollapsible /> : null}
    </SettingsSection>
  );
}

function LocalMultiGoogleAccountsPanel() {
  const bridge = window.desktopBridge?.googleSignIn;

  const [status, setStatus] = useState<GoogleEnrollmentStatusResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [showOAuthConfig, setShowOAuthConfig] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const clientIdHydratedRef = useRef(false);

  const refreshAccounts = useCallback(async () => {
    if (!bridge?.listAccountsT3) return;
    try {
      const data = await bridge.listAccountsT3();
      setStatus(data);
      if (data.defaultClientId && !clientIdHydratedRef.current) {
        clientIdHydratedRef.current = true;
        setClientId(data.defaultClientId);
      }
    } catch {
      // Ignore transient errors while local environment initializes
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void refreshAccounts();
  }, [refreshAccounts]);

  const isAuthInProgress =
    busyAction === "add-account" || (busyAction !== null && busyAction.startsWith("grant-drive:"));

  const handleSaveOAuthConfig = async (thenAddAccount = false) => {
    if (!bridge?.configureOAuthAppT3) return;
    const trimmedId = clientId.trim();
    if (!trimmedId) {
      toastManager.add({
        type: "error",
        title: "OAuth Client ID 필요",
        description: "Google Cloud Console에서 발급한 데스크톱 앱 OAuth Client ID를 입력해 주세요.",
      });
      return;
    }
    setBusyAction("save-oauth-config");
    try {
      const saved = await bridge.configureOAuthAppT3({
        clientId: trimmedId,
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      });
      setClientSecret("");
      setShowOAuthConfig(false);
      await refreshAccounts();
      toastManager.add({
        type: "success",
        title: "Google OAuth 앱 설정 저장 완료",
        description: saved.hasClientSecret
          ? "로컬 비밀 저장소(Windows DPAPI · 비-Windows 0600 권한)에 암호화 저장되었습니다. 이제 버튼 클릭만으로 계정을 추가하고 Drive 권한을 허용할 수 있습니다."
          : "Client ID가 저장되었습니다. Drive 권한 허용을 사용하려면 Client Secret도 함께 입력해 주세요.",
      });
      if (thenAddAccount) {
        setBusyAction(null);
        await handleAddAccount(false);
        return;
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "OAuth 앱 설정 저장 실패",
        description:
          error instanceof Error
            ? error.message
            : "Client ID와 Client Secret 형식을 확인해 주세요.",
      });
    } finally {
      setBusyAction((prev) => (prev === "save-oauth-config" ? null : prev));
    }
  };

  const handleAddAccount = async (grantDrive = false) => {
    if (!bridge?.addAccountT3) return;
    if (!status?.oauthConfigured && !clientId.trim()) {
      setShowOAuthConfig(true);
      toastManager.add({
        type: "error",
        title: "최초 1회 OAuth 앱 설정 필요",
        description: "아래에서 Google Cloud OAuth Client ID와 Secret을 1회만 저장해 주세요.",
      });
      return;
    }
    if (grantDrive && !status?.hasClientSecret) {
      setShowOAuthConfig(true);
      toastManager.add({
        type: "error",
        title: "Client Secret 필요",
        description:
          "Google Drive 백업 권한을 유지하려면 OAuth 앱 설정에 Client Secret을 1회 저장해 주세요.",
      });
      return;
    }
    setBusyAction("add-account");
    try {
      const added = await bridge.addAccountT3({ grantDrive });
      toastManager.add({
        type: "success",
        title: "Google 계정 로그인 완료",
        description: `${added.email ?? added.name ?? added.subject} 계정이 추가되었습니다.`,
      });
      await refreshAccounts();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Google 계정 추가 실패",
        description:
          error instanceof Error ? error.message : "브라우저 인증을 완료하지 못했습니다.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleGrantDrivePermission = async (account: EnrolledGoogleAccountSummary) => {
    if (!bridge?.grantDrivePermissionT3) return;
    if (!status?.hasClientSecret) {
      setShowOAuthConfig(true);
      toastManager.add({
        type: "error",
        title: "OAuth Client Secret 1회 입력 필요",
        description:
          "Google Drive 백업 토큰(Refresh Token)을 로컬 비밀 저장소(Windows DPAPI · 비-Windows 0600)에 암호화 보관하려면 OAuth 앱 설정에 Client Secret을 먼저 저장해 주세요.",
      });
      return;
    }
    setBusyAction(`grant-drive:${account.subject}`);
    try {
      const updated = await bridge.grantDrivePermissionT3({
        subject: account.subject,
        ...(account.email ? { loginHint: account.email } : {}),
      });
      toastManager.add({
        type: "success",
        title: "Google Drive 백업 권한 허용 완료",
        description: `${updated.email ?? account.email ?? account.subject} 계정의 Drive 백업이 활성화되었습니다.`,
      });
      await refreshAccounts();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Google Drive 권한 허용 실패",
        description:
          error instanceof Error
            ? error.message
            : "브라우저에서 Google Drive 접근 권한을 허용해 주세요.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleBindDriveAccount = async (account: EnrolledGoogleAccountSummary) => {
    if (!bridge?.bindDriveBackupAccountT3) return;
    setBusyAction(`bind-drive:${account.subject}`);
    try {
      const res = await bridge.bindDriveBackupAccountT3(account.subject);
      toastManager.add({
        type: "success",
        title: "Drive 백업 계정 전환 완료",
        description: `${res.email ?? account.email ?? account.subject} 계정이 기본 Drive 백업 대상으로 지정되었습니다.`,
      });
      await refreshAccounts();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Drive 백업 계정 전환 실패",
        description:
          error instanceof Error ? error.message : "해당 계정의 Drive 권한을 먼저 허용해 주세요.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRevokeDrivePermission = async (account: EnrolledGoogleAccountSummary) => {
    if (!bridge?.revokeDrivePermissionT3) return;
    setBusyAction(`revoke-drive:${account.subject}`);
    try {
      await bridge.revokeDrivePermissionT3(account.subject);
      toastManager.add({
        type: "success",
        title: "Google Drive 권한 해제됨",
        description: `${account.email ?? account.subject} 계정의 Drive 백업 권한만 해제했습니다. 계정 로그인은 유지됩니다.`,
      });
      await refreshAccounts();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Drive 권한 해제 실패",
        description: error instanceof Error ? error.message : "권한 해제 중 오류가 발생했습니다.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSetDefaultAccount = async (account: EnrolledGoogleAccountSummary) => {
    if (!bridge?.setDefaultAccountT3) return;
    setBusyAction(`default:${account.subject}`);
    try {
      await bridge.setDefaultAccountT3({ subject: account.subject });
      toastManager.add({
        type: "success",
        title: "기본 Google 계정 변경됨",
        description: `${account.email ?? account.subject} 계정을 기본 계정으로 지정했습니다.`,
      });
      await refreshAccounts();
    } finally {
      setBusyAction(null);
    }
  };

  const handleLogoutAccount = async (account: EnrolledGoogleAccountSummary) => {
    if (!bridge?.unenrollT3) return;
    setBusyAction(`remove:${account.subject}`);
    try {
      await bridge.unenrollT3(account.subject);
      toastManager.add({
        type: "success",
        title: "Google 계정 로그아웃됨",
        description: `${account.email ?? account.subject} 계정을 T3에서 제거했습니다.`,
      });
      await refreshAccounts();
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancelAuth = async () => {
    try {
      await bridge?.cancel?.();
    } finally {
      setBusyAction(null);
    }
  };

  const accounts = status?.accounts ?? [];
  const summary = summarizeGoogleAccountsState(status);
  const oauthConfigured = Boolean(status?.oauthConfigured);
  const needsSetupBox = !loading && (!oauthConfigured || showOAuthConfig);

  return (
    <div className="grid gap-3">
      <SettingsRow
        title={
          loading
            ? "Google 계정 확인 중"
            : summary.accountCount > 0
              ? `Google 계정 (${summary.accountCount}개 로그인됨)`
              : "Google 계정"
        }
        description={
          loading
            ? "로그인된 Google 계정과 Drive 백업 권한 상태를 불러오는 중입니다."
            : isAuthInProgress
              ? "브라우저에서 Google 계정 선택 또는 Drive 권한 허용을 완료해 주세요..."
              : summary.accountCount > 0
                ? "Google 계정을 2개 이상 동시에 로그인해 두고, 원하는 계정에서 'Drive 권한 허용'만 누르면 Google Drive 백업이 바로 연결됩니다."
                : "여러 Google 계정을 동시에 로그인하고, 로그인된 계정에서 클릭 한 번으로 Google Drive 백업 권한을 허용할 수 있습니다."
        }
        control={
          <div className="flex flex-wrap items-center gap-2">
            {isAuthInProgress ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleCancelAuth()}
              >
                인증 취소
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={loading || busyAction !== null}
                onClick={() => void handleAddAccount(false)}
              >
                + Google 계정 추가
              </Button>
            )}
            {oauthConfigured ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busyAction !== null}
                onClick={() => setShowOAuthConfig((v) => !v)}
              >
                {showOAuthConfig ? "설정 닫기" : "OAuth 앱 설정"}
              </Button>
            ) : null}
          </div>
        }
      />

      {needsSetupBox ? (
        <div className="grid gap-2.5 rounded-xl border border-border/70 bg-muted/20 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">
              {oauthConfigured
                ? "Google OAuth 앱 설정 변경"
                : "최초 1회 Google OAuth 앱 설정 (저장 후 재입력 불필요)"}
            </span>
            {status?.hasClientSecret ? (
              <Badge variant="success" size="sm">
                Client Secret 암호화 보관 중 (Windows DPAPI)
              </Badge>
            ) : null}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="OAuth Client ID (xxxx.apps.googleusercontent.com)"
            />
            <Input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={
                status?.hasClientSecret
                  ? "Client Secret 저장됨 (변경 시에만 입력)"
                  : "Client Secret (GOCSPX-... · Drive 권한 허용에 필요)"
              }
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busyAction !== null}
              onClick={() => void handleSaveOAuthConfig(false)}
            >
              설정 저장
            </Button>
            {!oauthConfigured ? (
              <Button
                type="button"
                size="sm"
                disabled={busyAction !== null}
                onClick={() => void handleSaveOAuthConfig(true)}
              >
                저장 후 Google 계정 로그인
              </Button>
            ) : null}
          </div>
          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground/80">
              1분 발급 가이드 (Google Cloud Console · 무료)
            </summary>
            <ol className="mt-1.5 list-decimal space-y-1 pl-4 leading-relaxed">
              <li>
                Google Cloud Console → <strong>API 및 서비스 → 라이브러리</strong>에서{" "}
                <strong>Google Drive API</strong>를 사용 설정합니다.
              </li>
              <li>
                <strong>사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID</strong>
                에서 애플리케이션 유형을 <strong>데스크톱 앱</strong>으로 선택해 생성합니다.
              </li>
              <li>
                발급된 <strong>Client ID</strong>와 <strong>Client Secret</strong>을 위 입력칸에
                1회만 저장하면, 이후 계정 2개 이상 추가와 Drive 권한 허용이 모두 버튼 1클릭으로
                동작합니다.
              </li>
              <li>
                <strong>403 access_denied (테스트 중 차단)</strong>가 뜨면 Google Cloud Console →{" "}
                <strong>Google Auth Platform → 대상(Audience)</strong>에서{" "}
                <strong>앱 게시(프로덕션)</strong>를 누르거나, 로그인할 Google 이메일을{" "}
                <strong>테스트 사용자</strong>에 추가하세요. (프로덕션 게시 시 7일 토큰 만료도 함께
                해제됩니다.)
              </li>
            </ol>
          </details>
        </div>
      ) : null}

      {accounts.length > 0 ? (
        <div className="grid gap-2">
          {accounts.map((acc) => {
            const isActiveDrive =
              acc.driveBackupLinked && status?.activeDriveSubject === acc.subject;
            const displayLabel = acc.email ?? acc.name ?? acc.subject;
            return (
              <div
                key={acc.subject}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-background/70 px-3.5 py-2.5 text-xs"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate font-medium text-foreground">{displayLabel}</span>
                  {acc.name && acc.email && acc.name !== acc.email ? (
                    <span className="text-[11px] text-muted-foreground">({acc.name})</span>
                  ) : null}
                  {acc.isDefault ? (
                    <Badge variant="outline" size="sm">
                      기본
                    </Badge>
                  ) : null}
                  {isActiveDrive ? (
                    <Badge variant="success" size="sm">
                      Drive 백업 활성 ✓
                    </Badge>
                  ) : acc.driveBackupLinked ? (
                    <Badge variant="info" size="sm">
                      Drive 권한 허용됨
                    </Badge>
                  ) : (
                    <Badge variant="outline" size="sm">
                      Drive 미허용
                    </Badge>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {!acc.driveBackupLinked ? (
                    <Button
                      type="button"
                      size="xs"
                      disabled={busyAction !== null}
                      onClick={() => void handleGrantDrivePermission(acc)}
                    >
                      Drive 권한 허용
                    </Button>
                  ) : (
                    <>
                      {!isActiveDrive ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={busyAction !== null}
                          onClick={() => void handleBindDriveAccount(acc)}
                        >
                          이 계정 Drive로 백업
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={busyAction !== null}
                        onClick={() => void handleRevokeDrivePermission(acc)}
                      >
                        Drive 권한 해제
                      </Button>
                    </>
                  )}
                  {!acc.isDefault ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busyAction !== null}
                      onClick={() => void handleSetDefaultAccount(acc)}
                    >
                      기본 지정
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busyAction !== null}
                    onClick={() => void handleLogoutAccount(acc)}
                  >
                    로그아웃
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function WebOnlyGoogleAccountNotice() {
  return (
    <SettingsRow
      title="Google 계정"
      description="다중 Google 계정 로그인과 1클릭 Google Drive 백업 권한 허용은 T3 데스크톱 앱에서 직접 관리합니다."
      control={
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            window.desktopBridge?.openExternal(configuredHostedAppUrl()) ??
            window.open(configuredHostedAppUrl(), "_blank")
          }
        >
          웹 앱 열기
        </Button>
      }
    />
  );
}

function T3ConnectClerkRelayCollapsible() {
  const clerk = useClerk();
  const { isLoaded, isSignedIn, sessionId } = useAuth();
  const { user } = useUser();
  const { isLoaded: sessionsLoaded, sessions } = useSessionList();

  const [expanded, setExpanded] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pendingAuthAction, setPendingAuthAction] = useState<"signIn" | "signUp" | null>(null);

  const authProps = resolveClerkAuthProps(window.location.href, isElectron);
  const singleSession = isClerkSingleSessionMode(clerk);
  const primaryAccount =
    user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? user?.username ?? null;

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

  const handleOpenClerkAuth = async (mode: "signIn" | "signUp") => {
    if (!isLoaded) return;
    if (isSignedIn && singleSession) {
      setBusyAction(`clerk:${mode}`);
      setPendingAuthAction(mode);
      try {
        await clerk.signOut();
      } catch {
        setPendingAuthAction(null);
        setBusyAction(null);
        toastManager.add({
          type: "error",
          title: "T3 Connect 계정 전환 실패",
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
        title: "T3 Connect 로그인 창 열기 실패",
        description: "잠시 후 다시 시도해 주세요.",
      });
    }
  };

  const handleSwitchSession = async (targetSessionId: string) => {
    setBusyAction(`clerk-switch:${targetSessionId}`);
    try {
      await clerk.setActive({ session: targetSessionId });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSignOut = async (targetSessionId?: string) => {
    setBusyAction(`clerk-signout:${targetSessionId ?? "all"}`);
    try {
      await clerk.signOut(targetSessionId ? { sessionId: targetSessionId } : undefined);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-border/60 bg-muted/10 px-3.5 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-muted-foreground">
            T3 Connect 원격 릴레이 로그인 (선택 · 외부 원격 접속용)
          </span>
          {isLoaded && isSignedIn ? (
            <Badge variant="outline" size="sm">
              {primaryAccount ?? "연결됨"}
            </Badge>
          ) : null}
        </div>
        <Button type="button" size="xs" variant="ghost" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "접기" : "관리"}
        </Button>
      </div>

      {expanded ? (
        <div className="mt-2.5 grid gap-2 border-t border-border/60 pt-2.5 text-xs">
          <p className="text-[11px] text-muted-foreground">
            {!isLoaded
              ? "T3 Connect 상태를 확인하는 중입니다."
              : pendingAuthAction !== null
                ? "기존 세션을 정리하고 새 로그인 창을 여는 중입니다..."
                : isSignedIn
                  ? `${primaryAccount ?? "계정"}(으)로 T3 Connect 원격 릴레이에 로그인되어 있습니다.`
                  : "원격 터널/모바일 릴레이가 필요할 때만 T3 Connect에 로그인하세요. 로컬 다중 Google 계정과 Drive 백업은 위 섹션에서 독립적으로 동작합니다."}
          </p>
          {isLoaded ? (
            <div className="flex flex-wrap items-center gap-2">
              {isSignedIn ? (
                <>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={busyAction !== null}
                    onClick={() => void handleOpenClerkAuth("signIn")}
                  >
                    계정 전환
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={busyAction !== null}
                    onClick={() => void handleOpenClerkAuth("signUp")}
                  >
                    새 계정 가입
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busyAction !== null}
                    onClick={() => void handleSignOut(sessionId ?? undefined)}
                  >
                    로그아웃
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={busyAction !== null}
                    onClick={() => void handleOpenClerkAuth("signIn")}
                  >
                    T3 Connect 로그인
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busyAction !== null}
                    onClick={() => void handleOpenClerkAuth("signUp")}
                  >
                    새 계정 가입
                  </Button>
                </>
              )}
            </div>
          ) : null}

          {isSignedIn && sessionsLoaded && sessions && sessions.length > 1 ? (
            <div className="grid gap-1.5 pt-1">
              {sessions.map((session) => {
                const isActive = session.id === sessionId;
                const label =
                  session.user?.primaryEmailAddress?.emailAddress ??
                  session.user?.fullName ??
                  session.id;
                return (
                  <div
                    key={session.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/70 px-2.5 py-1.5"
                  >
                    <span className="truncate font-medium">{label}</span>
                    <div className="flex items-center gap-1.5">
                      {!isActive ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={busyAction !== null}
                          onClick={() => void handleSwitchSession(session.id)}
                        >
                          전환
                        </Button>
                      ) : (
                        <Badge variant="success" size="sm">
                          활성
                        </Badge>
                      )}
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={busyAction !== null}
                        onClick={() => void handleSignOut(session.id)}
                      >
                        로그아웃
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
