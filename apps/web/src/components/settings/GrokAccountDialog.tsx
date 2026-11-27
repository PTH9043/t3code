"use client";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
  type GrokDeviceAuthBeginResult,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LoaderIcon,
  LogInIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn, randomUUID } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { GrokIcon } from "../Icons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";

export type GrokAccountAuthTab = "device-auth" | "oauth" | "api-key";

export const XAI_API_KEY_ENV_NAME = "XAI_API_KEY";

export function buildGrokApiInstance(input: {
  readonly displayName: string;
  readonly apiKey: string;
  readonly accentColor?: string;
  readonly binaryPath?: string;
}): ProviderInstanceConfig {
  const displayName = input.displayName.trim();
  const apiKey = input.apiKey.trim();
  if (!displayName || !apiKey) {
    throw new Error("연결 이름과 xAI API 키를 입력하세요.");
  }
  const normalizedAccentColor = normalizeProviderAccentColor(input.accentColor);
  const binaryPath = input.binaryPath?.trim() ?? "";
  return {
    driver: ProviderDriverKind.make("grok"),
    displayName,
    enabled: true,
    ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
    ...(binaryPath.length > 0 && binaryPath !== "grok" ? { config: { binaryPath } } : {}),
    environment: [{ name: XAI_API_KEY_ENV_NAME, value: apiKey, sensitive: true }],
  };
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export interface GrokAccountDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly mode: "add" | "reauth";
  readonly initialTab?: GrokAccountAuthTab;
  readonly instanceId?: ProviderInstanceId;
  readonly instanceDisplayName?: string;
  readonly defaultBinaryPath?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onBack?: () => void;
  readonly onOpenManualWizard?: () => void;
  readonly onAuthenticated?: (result?: {
    readonly instanceId: ProviderInstanceId;
    readonly email?: string;
  }) => void;
}

export function GrokAccountDialog({
  open,
  environmentId,
  mode,
  initialTab,
  instanceId,
  instanceDisplayName,
  defaultBinaryPath,
  onOpenChange,
  onBack,
  onOpenManualWizard,
  onAuthenticated,
}: GrokAccountDialogProps) {
  const defaultTab: GrokAccountAuthTab =
    initialTab ?? (mode === "reauth" ? "oauth" : "device-auth");
  const availableTabs: ReadonlyArray<{
    readonly id: GrokAccountAuthTab;
    readonly label: string;
    readonly badge?: string;
  }> =
    mode === "add"
      ? [
          { id: "device-auth", label: "다른 계정 (장치 코드)", badge: "추천" },
          { id: "oauth", label: "브라우저 OAuth" },
          { id: "api-key", label: "xAI API 키" },
        ]
      : [
          { id: "oauth", label: "브라우저 OAuth" },
          { id: "device-auth", label: "다른 계정 (장치 코드)" },
        ];

  const beginDeviceAuth = useAtomCommand(serverEnvironment.beginGrokDeviceAuth, {
    reportFailure: false,
  });
  const waitDeviceAuth = useAtomCommand(serverEnvironment.waitGrokDeviceAuth, {
    reportFailure: false,
  });
  const cancelDeviceAuth = useAtomCommand(serverEnvironment.cancelGrokDeviceAuth, {
    reportFailure: false,
  });
  const loginProviderAccount = useAtomCommand(serverEnvironment.loginProviderAccount, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });

  const activeRef = useRef(true);
  const deviceSessionIdRef = useRef<string | null>(null);
  const [activeTab, setActiveTab] = useState<GrokAccountAuthTab>(
    mode === "reauth" && defaultTab === "api-key" ? "oauth" : defaultTab,
  );
  const [displayName, setDisplayName] = useState(
    mode === "add" && defaultTab === "api-key" ? "Grok API" : "",
  );
  const [accentColor, setAccentColor] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiInstanceId] = useState(() =>
    ProviderInstanceId.make(`grok_api_${randomUUID().slice(0, 8)}`),
  );

  const [deviceSession, setDeviceSession] = useState<GrokDeviceAuthBeginResult | null>(null);
  const [isStartingDevice, setIsStartingDevice] = useState(false);
  const [isWaitingDevice, setIsWaitingDevice] = useState(false);
  const [isLoggingInOAuth, setIsLoggingInOAuth] = useState(false);
  const [isSavingApiKey, setIsSavingApiKey] = useState(false);
  const [copiedField, setCopiedField] = useState<"url" | "code" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isBusy = isStartingDevice || isLoggingInOAuth || isSavingApiKey;

  const cancelActiveDeviceSession = useCallback(() => {
    const sessionId = deviceSessionIdRef.current;
    deviceSessionIdRef.current = null;
    if (!sessionId) return;
    void cancelDeviceAuth({ environmentId, input: { sessionId } });
  }, [cancelDeviceAuth, environmentId]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      cancelActiveDeviceSession();
    };
  }, [cancelActiveDeviceSession]);

  const copyText = async (field: "url" | "code", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => {
        setCopiedField((current) => (current === field ? null : current));
      }, 2_000);
    } catch {
      toastManager.add({
        type: "error",
        title: "클립보드에 복사하지 못했습니다",
        description: "직접 선택해 복사해 주세요.",
      });
    }
  };

  const handleTabChange = (nextTab: GrokAccountAuthTab) => {
    if (isBusy || nextTab === activeTab) return;
    cancelActiveDeviceSession();
    setDeviceSession(null);
    setIsWaitingDevice(false);
    setError(null);
    if (mode === "add" && nextTab === "api-key" && displayName.trim().length === 0) {
      setDisplayName("Grok API");
    } else if (mode === "add" && activeTab === "api-key" && displayName === "Grok API") {
      setDisplayName("");
    }
    setActiveTab(nextTab);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      if (isLoggingInOAuth || isSavingApiKey) return;
      cancelActiveDeviceSession();
      setDeviceSession(null);
      setIsWaitingDevice(false);
    }
    onOpenChange(nextOpen);
  };

  const startDeviceAuth = async () => {
    cancelActiveDeviceSession();
    setDeviceSession(null);
    setIsStartingDevice(true);
    setIsWaitingDevice(false);
    setError(null);

    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);
    const trimmedName = displayName.trim();
    const beginResult = await beginDeviceAuth({
      environmentId,
      input: {
        ...(mode === "reauth" && instanceId ? { instanceId } : {}),
        ...(mode === "add" && trimmedName ? { displayName: trimmedName } : {}),
        ...(mode === "add" && normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      },
    });
    if (!activeRef.current) {
      if (beginResult._tag === "Success") {
        void cancelDeviceAuth({
          environmentId,
          input: { sessionId: beginResult.value.sessionId },
        });
      }
      return;
    }
    setIsStartingDevice(false);
    if (beginResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(beginResult)) {
        setError(
          failureMessage(
            squashAtomCommandFailure(beginResult),
            "Grok 장치 코드를 발급하지 못했습니다.",
          ),
        );
      }
      return;
    }

    const session = beginResult.value;
    deviceSessionIdRef.current = session.sessionId;
    setDeviceSession(session);
    setIsWaitingDevice(true);

    const waitResult = await waitDeviceAuth({
      environmentId,
      input: { sessionId: session.sessionId },
    });
    if (!activeRef.current || deviceSessionIdRef.current !== session.sessionId) {
      return;
    }
    deviceSessionIdRef.current = null;
    setIsWaitingDevice(false);

    if (waitResult._tag === "Failure") {
      setDeviceSession(null);
      if (!isAtomCommandInterrupted(waitResult)) {
        setError(
          failureMessage(
            squashAtomCommandFailure(waitResult),
            "Grok 장치 코드 로그인을 완료하지 못했습니다.",
          ),
        );
      }
      return;
    }

    toastManager.add({
      type: "success",
      title: mode === "reauth" ? "Grok 계정을 다시 로그인했습니다" : "Grok 계정을 추가했습니다",
      description: waitResult.value.email
        ? `${waitResult.value.email} 계정이 연결되었습니다.`
        : `${waitResult.value.displayName ?? waitResult.value.instanceId} 계정이 연결되었습니다.`,
    });
    onAuthenticated?.({
      instanceId: waitResult.value.instanceId,
      ...(waitResult.value.email ? { email: waitResult.value.email } : {}),
    });
    onOpenChange(false);
  };

  const startOAuthLogin = async () => {
    setIsLoggingInOAuth(true);
    setError(null);
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);
    const trimmedName = displayName.trim();
    const result = await loginProviderAccount({
      environmentId,
      input: {
        driver: "grok",
        ...(mode === "reauth" && instanceId ? { instanceId } : {}),
        ...(mode === "add" && trimmedName ? { displayName: trimmedName } : {}),
        ...(mode === "add" && normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      },
    });
    if (!activeRef.current) return;
    setIsLoggingInOAuth(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(
          failureMessage(squashAtomCommandFailure(result), "Grok 브라우저 로그인에 실패했습니다."),
        );
      }
      return;
    }

    toastManager.add({
      type: "success",
      title: mode === "reauth" ? "Grok 계정을 다시 로그인했습니다" : "Grok 계정을 추가했습니다",
      description: result.value.email
        ? `${result.value.email} 계정이 연결되었습니다.`
        : `${result.value.displayName ?? result.value.instanceId} 계정이 연결되었습니다.`,
    });
    onAuthenticated?.({
      instanceId: result.value.instanceId,
      ...(result.value.email ? { email: result.value.email } : {}),
    });
    onOpenChange(false);
  };

  const saveApiKeyAccount = async () => {
    if (!displayName.trim() || !apiKey.trim() || isSavingApiKey) return;
    setIsSavingApiKey(true);
    setError(null);
    try {
      const instance = buildGrokApiInstance({
        displayName,
        apiKey,
        ...(accentColor ? { accentColor } : {}),
        ...(defaultBinaryPath ? { binaryPath: defaultBinaryPath } : {}),
      });
      const result = await updateSettings({
        environmentId,
        input: {
          patch: {
            providerInstancesToUpsert: {
              [apiInstanceId]: instance,
            },
          },
        },
      });
      if (!activeRef.current) return;
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          setError("Grok (xAI) API 계정을 저장하지 못했습니다.");
        }
        return;
      }
      setApiKey("");
      toastManager.add({
        type: "success",
        title: "Grok (xAI) API 계정을 추가했습니다",
        description: `${instance.displayName ?? apiInstanceId} 연결이 등록되었습니다.`,
      });
      onAuthenticated?.({ instanceId: apiInstanceId });
      onOpenChange(false);
    } catch (cause) {
      setError(failureMessage(cause, "Grok (xAI) API 계정을 저장하지 못했습니다."));
    } finally {
      if (activeRef.current) {
        setIsSavingApiKey(false);
      }
    }
  };

  const duplicateAccountError = Boolean(error && error.includes("이미 등록된 Grok 계정"));
  const canSaveApiKey = Boolean(displayName.trim() && apiKey.trim()) && !isSavingApiKey;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-xl overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GrokIcon className="size-4" aria-hidden />
              {mode === "reauth" ? "Grok 계정 로그인 · 변경" : "Grok 계정 추가"}
            </DialogTitle>
            <DialogDescription>
              {mode === "reauth"
                ? `${instanceDisplayName ?? instanceId ?? "Grok"} 계정의 로그인 세션을 새로 연결하거나 다른 Grok 계정으로 교체합니다.`
                : "각 Grok 계정은 별도 전용 홈 폴더(GROK_HOME)에 격리되어 저장됩니다. 다른 계정을 추가할 때는 장치 코드 방식을 권장합니다."}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[70vh] space-y-4 overflow-y-auto bg-zinc-25/80 px-6 py-5 ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5">
            <div role="tablist" aria-label="Grok 계정 연결 방식" className="flex flex-wrap gap-1.5">
              {availableTabs.map((tab) => {
                const selected = activeTab === tab.id;
                return (
                  <Button
                    key={tab.id}
                    type="button"
                    role="tab"
                    size="sm"
                    variant={selected ? "default" : "outline"}
                    aria-selected={selected}
                    disabled={isBusy}
                    onClick={() => handleTabChange(tab.id)}
                  >
                    <span>{tab.label}</span>
                    {tab.badge ? (
                      <Badge variant={selected ? "secondary" : "outline"} size="sm">
                        {tab.badge}
                      </Badge>
                    ) : null}
                  </Button>
                );
              })}
            </div>

            {activeTab === "device-auth" ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-border/70 bg-background/80 p-3 text-xs leading-relaxed text-muted-foreground">
                  <p className="flex items-center gap-1.5 font-medium text-foreground">
                    <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
                    시크릿 창 · 다른 브라우저 프로필 로그인 (쿠키 충돌 방지)
                  </p>
                  <p className="mt-1">
                    인증 링크와 일회용 코드를 발급한 뒤 시크릿 창이나 다른 프로필에 붙여 넣어 새
                    Grok 계정으로 승인하세요. 기존 계정의 로그인 세션은 유지됩니다.
                  </p>
                </div>

                {mode === "add" && deviceSession === null ? (
                  <div className="grid gap-4">
                    <label className="grid gap-1.5 text-sm">
                      <span className="text-xs font-medium text-foreground">표시 이름 (선택)</span>
                      <Input
                        className="bg-background"
                        value={displayName}
                        disabled={isStartingDevice}
                        placeholder="예: Grok 업무용 (비워 두면 로그인 이메일로 자동 설정)"
                        onChange={(event) => setDisplayName(event.target.value)}
                      />
                    </label>
                    <ProviderAccentColorPicker
                      displayName="Grok 계정"
                      value={accentColor}
                      onCommit={setAccentColor}
                      description="모델 선택 목록에서 여러 Grok 계정을 빠르게 구분하는 색상입니다."
                    />
                  </div>
                ) : null}

                {deviceSession !== null ? (
                  <div className="space-y-3 rounded-lg border border-border/80 bg-background p-4">
                    <div className="space-y-1.5">
                      <span className="text-xs font-medium text-foreground">
                        1. 시크릿 창 또는 다른 브라우저 프로필에서 아래 링크를 여세요
                      </span>
                      <div className="flex items-center gap-2">
                        <Input
                          readOnly
                          value={deviceSession.verificationUrl}
                          aria-label="Grok 인증 URL"
                          className="font-mono text-xs"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void copyText("url", deviceSession.verificationUrl)}
                        >
                          {copiedField === "url" ? <CheckIcon /> : <CopyIcon />}
                          {copiedField === "url" ? "복사됨" : "링크 복사"}
                        </Button>
                      </div>
                      <div className="pt-1">
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            window.open(
                              deviceSession.verificationUrl,
                              "_blank",
                              "noopener,noreferrer",
                            )
                          }
                        >
                          <ExternalLinkIcon />
                          현재 브라우저 새 탭에서 열기
                        </Button>
                      </div>
                    </div>

                    {deviceSession.userCode ? (
                      <div className="space-y-1.5 border-t border-border/60 pt-3">
                        <span className="text-xs font-medium text-foreground">
                          2. 브라우저에 표시되는 코드가 일치하는지 확인하거나 아래 코드를 입력하세요
                        </span>
                        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                          <code className="font-mono text-base font-semibold tracking-widest text-foreground">
                            {deviceSession.userCode}
                          </code>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => void copyText("code", deviceSession.userCode!)}
                          >
                            {copiedField === "code" ? <CheckIcon /> : <CopyIcon />}
                            {copiedField === "code" ? "복사됨" : "코드 복사"}
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {isWaitingDevice ? (
                      <div className="flex items-center gap-2 rounded-md bg-primary/8 px-3 py-2 text-xs text-foreground">
                        <LoaderIcon className="size-3.5 shrink-0 animate-spin" aria-hidden />
                        <span>
                          브라우저에서 승인을 기다리는 중입니다. 승인이 끝나면 계정이 자동으로
                          등록됩니다.
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            {activeTab === "oauth" ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-border/70 bg-background/80 p-3 text-xs leading-relaxed text-muted-foreground">
                  <p className="flex items-center gap-1.5 font-medium text-foreground">
                    <LogInIcon className="size-3.5 shrink-0" aria-hidden />
                    기본 브라우저 OAuth 로그인
                  </p>
                  <p className="mt-1">
                    {mode === "reauth"
                      ? "기본 브라우저에서 Grok 로그인 페이지를 열어 이 계정의 인증을 갱신합니다."
                      : "기본 브라우저에서 Grok 로그인 페이지를 엽니다. 이미 같은 브라우저에 로그인된 계정이 있다면 중복을 피하기 위해 '다른 계정 (장치 코드)' 탭을 권장합니다."}
                  </p>
                </div>

                {mode === "add" ? (
                  <div className="grid gap-4">
                    <label className="grid gap-1.5 text-sm">
                      <span className="text-xs font-medium text-foreground">표시 이름 (선택)</span>
                      <Input
                        className="bg-background"
                        value={displayName}
                        disabled={isLoggingInOAuth}
                        placeholder="예: Grok 개인용 (비워 두면 로그인 이메일로 자동 설정)"
                        onChange={(event) => setDisplayName(event.target.value)}
                      />
                    </label>
                    <ProviderAccentColorPicker
                      displayName="Grok 계정"
                      value={accentColor}
                      onCommit={setAccentColor}
                      description="모델 선택 목록에서 계정을 구분하는 색상입니다."
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            {activeTab === "api-key" && mode === "add" ? (
              <div className="space-y-4">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  render={
                    <a href="https://console.x.ai" target="_blank" rel="noopener noreferrer" />
                  }
                >
                  <ExternalLinkIcon />
                  xAI Console에서 API 키 발급
                </Button>

                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-medium text-foreground">연결 이름</span>
                  <Input
                    className="bg-background"
                    value={displayName}
                    disabled={isSavingApiKey}
                    placeholder="예: Grok API"
                    onChange={(event) => {
                      setDisplayName(event.target.value);
                      setError(null);
                    }}
                  />
                </label>

                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-medium text-foreground">
                    xAI API 키 (XAI_API_KEY)
                  </span>
                  <Input
                    className="bg-background"
                    type="password"
                    autoComplete="off"
                    maxLength={4096}
                    value={apiKey}
                    disabled={isSavingApiKey}
                    placeholder="xai-..."
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      setError(null);
                    }}
                  />
                </label>

                <ProviderAccentColorPicker
                  displayName="Grok API 계정"
                  value={accentColor}
                  onCommit={setAccentColor}
                  description="구독 계정과 API 키 계정을 한눈에 구분하는 색상입니다."
                />

                <p className="text-xs leading-relaxed text-muted-foreground">
                  기존 Grok OAuth 계정과 분리된 전용 홈 경로로 실행되어 세션 토큰과 충돌하지
                  않습니다. 키는 서버의 로컬 비밀 저장소에 암호화되어 보관됩니다.
                </p>
              </div>
            ) : null}

            {error ? (
              <div
                role="alert"
                className={cn(
                  "space-y-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-sm text-destructive",
                )}
              >
                <p>{error}</p>
                {duplicateAccountError && activeTab === "oauth" ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => handleTabChange("device-auth")}
                  >
                    다른 계정 (장치 코드 · 시크릿 창) 방식으로 전환
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          <DialogFooter
            variant="bare"
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <div>
              {mode === "add" && onOpenManualWizard ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={isBusy}
                  onClick={() => {
                    cancelActiveDeviceSession();
                    onOpenManualWizard();
                  }}
                >
                  고급 수동 설정
                </Button>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isLoggingInOAuth || isSavingApiKey}
                onClick={() => {
                  cancelActiveDeviceSession();
                  if (onBack) {
                    onBack();
                  } else {
                    onOpenChange(false);
                  }
                }}
              >
                {onBack ? "이전" : "취소"}
              </Button>

              {activeTab === "device-auth" ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={isStartingDevice}
                  onClick={() => void startDeviceAuth()}
                >
                  {isStartingDevice ? <LoaderIcon className="animate-spin" /> : <ShieldCheckIcon />}
                  {isStartingDevice
                    ? "장치 코드 발급 중"
                    : deviceSession
                      ? "장치 코드 다시 발급"
                      : "장치 코드 발급"}
                </Button>
              ) : null}

              {activeTab === "oauth" ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={isLoggingInOAuth}
                  onClick={() => void startOAuthLogin()}
                >
                  {isLoggingInOAuth ? <LoaderIcon className="animate-spin" /> : <LogInIcon />}
                  {isLoggingInOAuth ? "브라우저 로그인 대기 중" : "브라우저로 Grok 로그인"}
                </Button>
              ) : null}

              {activeTab === "api-key" && mode === "add" ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={!canSaveApiKey}
                  onClick={() => void saveApiKeyAccount()}
                >
                  {isSavingApiKey ? <LoaderIcon className="animate-spin" /> : <KeyRoundIcon />}
                  {isSavingApiKey ? "저장 중" : "xAI API 계정 추가"}
                </Button>
              ) : null}
            </div>
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
