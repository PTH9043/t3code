import { useCallback, useEffect, useState } from "react";
import type {
  EnrolledGoogleAccountSummary,
  GoogleAccountTier,
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

export function tierLabelKr(tier: GoogleAccountTier | undefined): string {
  if (tier === "ultra") return "Ultra";
  if (tier === "pro") return "Pro";
  if (tier === "free") return "무료";
  return "";
}

export function GoogleAccountSection() {
  return (
    <div className="grid gap-6">
      {hasClerkPublicConfig() ? (
        <ConfiguredGoogleAccountSection />
      ) : (
        <BrowserGoogleAccountSection />
      )}
      <LocalMultiGoogleAccountsSection />
    </div>
  );
}

function ConfiguredGoogleAccountSection() {
  const clerk = useClerk();
  const { isLoaded, isSignedIn, sessionId } = useAuth();
  const { user } = useUser();
  const { isLoaded: sessionsLoaded, sessions } = useSessionList();
  const [busySessionId, setBusySessionId] = useState<string | null>(null);

  const account =
    user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? user?.username ?? null;
  const authProps = resolveClerkAuthProps(window.location.href, isElectron);

  const handleSwitchSession = async (targetSessionId: string) => {
    setBusySessionId(targetSessionId);
    try {
      await clerk.setActive({ session: targetSessionId });
      toastManager.add({
        type: "success",
        title: "Google 계정 전환 완료",
        description: "선택한 세션이 활성 계정으로 전환되었습니다.",
      });
    } catch {
      toastManager.add({
        type: "error",
        title: "계정 전환 실패",
        description: "선택한 세션으로 전환하지 못했습니다. 다시 로그인해 주세요.",
      });
    } finally {
      setBusySessionId(null);
    }
  };

  const handleSignOutSession = async (targetSessionId?: string) => {
    setBusySessionId(targetSessionId ?? "all");
    try {
      await clerk.signOut(targetSessionId ? { sessionId: targetSessionId } : undefined);
    } finally {
      setBusySessionId(null);
    }
  };

  return (
    <SettingsSection {...searchableSetting("google-account")}>
      <SettingsRow
        title={!isLoaded ? "확인 중" : isSignedIn ? "로그인됨 (T3 Connect)" : "로그인 필요"}
        description={
          !isLoaded
            ? "로그인 상태를 확인하는 중입니다."
            : isSignedIn
              ? `${account ?? "계정"}(으)로 로그인되어 있습니다. 여러 Google 계정을 추가·전환할 수 있습니다.`
              : "처음 연결하는 Google 계정은 '새 Google 계정 가입'을 사용하세요. 기본 브라우저에서 계정을 선택하면 앱으로 자동 복귀합니다."
        }
        control={
          !isLoaded ? null : isSignedIn ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => clerk.openSignIn(authProps)}
              >
                + 다른 Google 계정 추가
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => clerk.openSignUp(authProps)}
              >
                새 계정 가입
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busySessionId !== null}
                onClick={() => void handleSignOutSession(sessionId ?? undefined)}
              >
                로그아웃
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" onClick={() => clerk.openSignIn(authProps)}>
                Google로 로그인
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => clerk.openSignUp(authProps)}
              >
                새 Google 계정 가입
              </Button>
            </div>
          )
        }
      />

      {isSignedIn && sessionsLoaded && sessions && sessions.length > 0 ? (
        <div className="mt-3 grid gap-2 rounded-xl border border-border/70 bg-muted/20 p-3">
          <p className="text-xs font-medium text-muted-foreground">
            연결된 T3 Connect 세션 ({sessions.length}개)
          </p>
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
                <div className="flex min-w-0 items-center gap-2">
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
                      disabled={busySessionId !== null}
                      onClick={() => void handleSwitchSession(session.id)}
                    >
                      이 계정으로 전환
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busySessionId !== null}
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

function LocalMultiGoogleAccountsSection() {
  const bridge = typeof window !== "undefined" ? window.desktopBridge?.googleSignIn : undefined;
  const [status, setStatus] = useState<GoogleEnrollmentStatusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [label, setLabel] = useState("");
  const [tier, setTier] = useState<GoogleAccountTier>("ultra");
  const [linkDriveBackup, setLinkDriveBackup] = useState(true);
  const [showAdvancedOAuth, setShowAdvancedOAuth] = useState(false);

  const refresh = useCallback(async () => {
    if (!bridge?.listAccountsT3) return;
    setLoading(true);
    try {
      const data = await bridge.listAccountsT3();
      setStatus(data);
      if (data.defaultClientId && !clientId) {
        setClientId(data.defaultClientId);
      }
    } catch {
      // Ignore transient unavailable state when unauthenticated
    } finally {
      setLoading(false);
    }
  }, [bridge, clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!bridge?.listAccountsT3) return null;

  const hasSavedClientId = Boolean(status?.defaultClientId);

  const handleAddAccount = async () => {
    if (!bridge.enrollT3) return;
    const effectiveClientId = clientId.trim() || status?.defaultClientId || "";
    if (!effectiveClientId) {
      toastManager.add({
        type: "error",
        title: "OAuth Client ID 필요",
        description: "최초 1회 Google Cloud OAuth Client ID를 입력해 주세요.",
      });
      return;
    }
    setBusy("add");
    try {
      const identity = await bridge.enrollT3({
        clientId: effectiveClientId,
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        ...(label.trim() ? { label: label.trim() } : {}),
        tier,
        linkDriveBackup,
      });
      setLabel("");
      setClientSecret("");
      toastManager.add({
        type: "success",
        title: "로컬 Google 계정 등록 완료",
        description: `${identity.email ?? identity.name ?? identity.subject} 계정이 추가되었습니다.${linkDriveBackup ? " (Google Drive 백업 연결 포함)" : ""}`,
      });
      await refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Google 계정 등록 실패",
        description:
          error instanceof Error ? error.message : "OAuth 설정과 브라우저 인증을 확인해 주세요.",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleSetDefault = async (account: EnrolledGoogleAccountSummary) => {
    if (!bridge.setDefaultAccountT3) return;
    setBusy(`default:${account.subject}`);
    try {
      await bridge.setDefaultAccountT3({ subject: account.subject });
      toastManager.add({
        type: "success",
        title: "기본 계정 변경됨",
        description: `${account.email ?? account.label ?? account.subject} 계정을 기본으로 설정했습니다.`,
      });
      await refresh();
    } catch {
      toastManager.add({ type: "error", title: "기본 계정 변경 실패" });
    } finally {
      setBusy(null);
    }
  };

  const handleSwitchLogin = async (account: EnrolledGoogleAccountSummary) => {
    if (!bridge.loginT3) return;
    setBusy(`login:${account.subject}`);
    try {
      const identity = await bridge.loginT3({
        subject: account.subject,
        ...(account.email ? { loginHint: account.email } : {}),
      });
      toastManager.add({
        type: "success",
        title: "로컬 세션 전환 완료",
        description: `${identity.email ?? identity.subject} 계정으로 T3 로컬 세션이 갱신되었습니다.`,
      });
      await refresh();
    } catch {
      toastManager.add({ type: "error", title: "Google 계정 전환 로그인 실패" });
    } finally {
      setBusy(null);
    }
  };

  const handleBindDrive = async (account: EnrolledGoogleAccountSummary) => {
    if (!bridge.bindDriveBackupAccountT3) return;
    setBusy(`drive:${account.subject}`);
    try {
      const res = await bridge.bindDriveBackupAccountT3(account.subject);
      toastManager.add({
        type: "success",
        title: "Google Drive 백업 계정 연결됨",
        description: `${res.email ?? account.email ?? account.subject} 계정이 선택형 Drive 백업 기본 계정으로 활성화되었습니다.`,
      });
      await refresh();
    } catch {
      toastManager.add({
        type: "error",
        title: "Drive 백업 연결 실패",
        description:
          "Drive 권한이 아직 연결되지 않은 계정입니다. '+ Google 계정 추가'에서 Drive 연결 체크 후 재인증해 주세요.",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (account: EnrolledGoogleAccountSummary) => {
    if (!bridge.unenrollT3) return;
    setBusy(`remove:${account.subject}`);
    try {
      await bridge.unenrollT3(account.subject);
      toastManager.add({
        type: "success",
        title: "Google 계정 연결 해제",
        description: `${account.email ?? account.subject} 계정을 목록에서 제거했습니다.`,
      });
      await refresh();
    } catch {
      toastManager.add({ type: "error", title: "계정 연결 해제 실패" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection title="T3 로컬 다중 Google 계정 (Ultra · Pro · Drive 백업 브리지)">
      <div className="grid gap-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Clerk와 별도로 T3 로컬 환경에 여러 Google 계정을 등록·전환하고, 선택한 계정의 Google
          Drive(`drive.file`)를 백업 대상으로 1클릭 연결합니다. 최초 1회 OAuth Client ID 입력 후
          2번째 계정부터는 버튼 1클릭으로 추가됩니다.
        </p>
        {status && status.accounts.length > 0 ? (
          <div className="grid gap-2">
            {status.accounts.map((account) => (
              <div
                key={account.subject}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-card/60 px-3.5 py-2.5 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold">
                      {account.label || account.name || account.email || account.subject}
                    </span>
                    {account.isDefault ? (
                      <Badge variant="success" size="sm">
                        기본
                      </Badge>
                    ) : null}
                    {account.tier ? (
                      <Badge variant={account.tier === "ultra" ? "info" : "outline"} size="sm">
                        {tierLabelKr(account.tier)}
                      </Badge>
                    ) : null}
                    {account.driveBackupLinked ? (
                      <Badge variant="success" size="sm">
                        Drive 백업 연결됨
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {account.email ?? account.subject}
                    {account.lastUsedAt
                      ? ` · 최근 사용: ${new Date(account.lastUsedAt).toLocaleString("ko-KR")}`
                      : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {!account.isDefault ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void handleSetDefault(account)}
                    >
                      기본 지정
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void handleSwitchLogin(account)}
                  >
                    전환 로그인
                  </Button>
                  {account.driveBackupLinked ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void handleBindDrive(account)}
                    >
                      Drive 백업 사용
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void handleRemove(account)}
                  >
                    연결 해제
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {loading
              ? "등록된 로컬 Google 계정을 확인하는 중..."
              : "아직 등록된 T3 로컬 Google 계정이 없습니다. 아래에서 첫 계정을 추가해 보세요."}
          </p>
        )}

        <div className="grid gap-2.5 rounded-xl border border-dashed border-border bg-muted/15 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold">+ Google 계정 추가</span>
            {hasSavedClientId ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setShowAdvancedOAuth((v) => !v)}
              >
                {showAdvancedOAuth ? "OAuth 설정 접기" : "저장된 Client ID 변경"}
              </Button>
            ) : null}
          </div>

          {!hasSavedClientId || showAdvancedOAuth ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="Google Cloud OAuth Client ID (최초 1회)"
              />
              <Input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={
                  status?.hasClientSecret
                    ? "OAuth Client Secret (저장됨 · 변경 시 입력)"
                    : "OAuth Client Secret (Desktop 앱 타입 시 입력)"
                }
              />
            </div>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-12">
            <Input
              className="sm:col-span-5"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="계정 별칭 (예: 메인 Ultra 30TB / 보조 Pro)"
            />
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as GoogleAccountTier)}
              className="h-9 rounded-lg border border-input bg-background px-2.5 text-xs sm:col-span-3"
            >
              <option value="ultra">Google AI Ultra</option>
              <option value="pro">Google AI Pro</option>
              <option value="free">무료 / 일반</option>
            </select>
            <Button
              type="button"
              size="sm"
              className="sm:col-span-4"
              disabled={busy !== null}
              onClick={() => void handleAddAccount()}
            >
              {busy === "add" ? "브라우저 인증 대기 중..." : "+ Google 계정 추가"}
            </Button>
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={linkDriveBackup}
              onChange={(e) => setLinkDriveBackup(e.target.checked)}
              className="size-3.5 rounded border-input"
            />
            <span>
              Google Drive 선택형 백업 권한(`drive.file`)도 함께 원클릭 연결 (수동 토큰 입력 불필요)
            </span>
          </label>
        </div>
      </div>
    </SettingsSection>
  );
}
