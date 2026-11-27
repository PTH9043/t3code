"use client";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
  type MuseAuthBeginResult,
  type MuseCloudAuthBeginResult,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  CloudIcon,
  CopyIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LoaderIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn, randomUUID } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { MuseIcon } from "../Icons";
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

export type MuseAccountAuthTab = "browser" | "cloud" | "api-key";

export const META_API_KEY_ENV_NAME = "META_API_KEY";

export function buildMuseApiInstance(input: {
  readonly displayName: string;
  readonly apiKey: string;
  readonly accentColor?: string;
  readonly binaryPath?: string;
}): ProviderInstanceConfig {
  const displayName = input.displayName.trim();
  const apiKey = input.apiKey.trim();
  if (!displayName || !apiKey) {
    throw new Error("연결 이름과 Meta API 키를 입력하세요.");
  }
  const normalizedAccentColor = normalizeProviderAccentColor(input.accentColor);
  const binaryPath = input.binaryPath?.trim() ?? "";
  return {
    driver: ProviderDriverKind.make("muse"),
    displayName,
    enabled: true,
    ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
    ...(binaryPath.length > 0 && binaryPath !== "muse" ? { config: { binaryPath } } : {}),
    environment: [{ name: META_API_KEY_ENV_NAME, value: apiKey, sensitive: true }],
  };
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export interface MuseAccountDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly mode: "add" | "reauth";
  readonly initialTab?: MuseAccountAuthTab;
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

export function MuseAccountDialog({
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
}: MuseAccountDialogProps) {
  const defaultTab: MuseAccountAuthTab =
    mode === "reauth" ? (initialTab === "cloud" ? "cloud" : "browser") : (initialTab ?? "browser");
  const availableTabs: ReadonlyArray<{
    readonly id: MuseAccountAuthTab;
    readonly label: string;
    readonly badge?: string;
  }> =
    mode === "add"
      ? [
          { id: "browser", label: "Muse Code (Meta)", badge: "로컬 CLI" },
          { id: "cloud", label: "muse.ai 클라우드", badge: "Google 로그인" },
          { id: "api-key", label: "Meta API 키" },
        ]
      : [
          { id: "browser", label: "Muse Code (Meta)", badge: "로컬 CLI" },
          { id: "cloud", label: "muse.ai 클라우드", badge: "Google 로그인" },
        ];

  const beginMuseAuth = useAtomCommand(serverEnvironment.beginMuseAuth, {
    reportFailure: false,
  });
  const waitMuseAuth = useAtomCommand(serverEnvironment.waitMuseAuth, {
    reportFailure: false,
  });
  const cancelMuseAuth = useAtomCommand(serverEnvironment.cancelMuseAuth, {
    reportFailure: false,
  });
  const beginMuseCloudAuth = useAtomCommand(serverEnvironment.beginMuseCloudAuth, {
    reportFailure: false,
  });
  const waitMuseCloudAuth = useAtomCommand(serverEnvironment.waitMuseCloudAuth, {
    reportFailure: false,
  });
  const cancelMuseCloudAuth = useAtomCommand(serverEnvironment.cancelMuseCloudAuth, {
    reportFailure: false,
  });
  const importMuseCloudCookies = useAtomCommand(serverEnvironment.importMuseCloudCookies, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });

  const activeRef = useRef(true);
  const authSessionIdRef = useRef<string | null>(null);
  const cloudAuthSessionIdRef = useRef<string | null>(null);
  const [activeTab, setActiveTab] = useState<MuseAccountAuthTab>(defaultTab);
  const [displayName, setDisplayName] = useState(
    mode === "add" && defaultTab === "api-key" ? "Muse API" : "",
  );
  const [accentColor, setAccentColor] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiInstanceId] = useState(() =>
    ProviderInstanceId.make(`muse_api_${randomUUID().slice(0, 8)}`),
  );

  // Muse Code (official dev.meta.ai) state
  const [authSession, setAuthSession] = useState<MuseAuthBeginResult | null>(null);
  const [isStartingAuth, setIsStartingAuth] = useState(false);
  const [isWaitingAuth, setIsWaitingAuth] = useState(false);

  // muse.ai Cloud (Google login) state
  const [cloudAuthSession, setCloudAuthSession] = useState<MuseCloudAuthBeginResult | null>(null);
  const [isStartingCloudAuth, setIsStartingCloudAuth] = useState(false);
  const [isWaitingCloudAuth, setIsWaitingCloudAuth] = useState(false);
  const [showManualCookieInput, setShowManualCookieInput] = useState(false);
  const [manualCookies, setManualCookies] = useState("");
  const [isImportingCookies, setIsImportingCookies] = useState(false);

  // Meta API key state
  const [isSavingApiKey, setIsSavingApiKey] = useState(false);
  const [copiedField, setCopiedField] = useState<"url" | "code" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isBusy = isStartingAuth || isStartingCloudAuth || isImportingCookies || isSavingApiKey;
  const isWaitingAny = isWaitingAuth || isWaitingCloudAuth;

  const cancelActiveAuthSessions = useCallback(() => {
    const codeSessionId = authSessionIdRef.current;
    authSessionIdRef.current = null;
    if (codeSessionId) {
      void cancelMuseAuth({ environmentId, input: { sessionId: codeSessionId } });
    }
    const cloudSessionId = cloudAuthSessionIdRef.current;
    cloudAuthSessionIdRef.current = null;
    if (cloudSessionId) {
      void cancelMuseCloudAuth({ environmentId, input: { sessionId: cloudSessionId } });
    }
  }, [cancelMuseAuth, cancelMuseCloudAuth, environmentId]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      cancelActiveAuthSessions();
    };
  }, [cancelActiveAuthSessions]);

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

  const handleTabChange = (nextTab: MuseAccountAuthTab) => {
    if (isBusy || nextTab === activeTab) return;
    cancelActiveAuthSessions();
    setAuthSession(null);
    setIsWaitingAuth(false);
    setCloudAuthSession(null);
    setIsWaitingCloudAuth(false);
    setError(null);
    if (mode === "add" && nextTab === "api-key" && displayName.trim().length === 0) {
      setDisplayName("Muse API");
    } else if (mode === "add" && activeTab === "api-key" && displayName === "Muse API") {
      setDisplayName("");
    }
    setActiveTab(nextTab);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      if (isSavingApiKey || isImportingCookies) return;
      cancelActiveAuthSessions();
      setAuthSession(null);
      setIsWaitingAuth(false);
      setCloudAuthSession(null);
      setIsWaitingCloudAuth(false);
    }
    onOpenChange(nextOpen);
  };

  const startBrowserAuth = async () => {
    cancelActiveAuthSessions();
    setAuthSession(null);
    setIsStartingAuth(true);
    setIsWaitingAuth(false);
    setError(null);

    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);
    const trimmedName = displayName.trim();
    const beginResult = await beginMuseAuth({
      environmentId,
      input: {
        ...(mode === "reauth" && instanceId ? { instanceId } : {}),
        ...(mode === "add" && trimmedName ? { displayName: trimmedName } : {}),
        ...(mode === "add" && normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      },
    });
    if (!activeRef.current) {
      if (beginResult._tag === "Success") {
        void cancelMuseAuth({
          environmentId,
          input: { sessionId: beginResult.value.sessionId },
        });
      }
      return;
    }
    setIsStartingAuth(false);
    if (beginResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(beginResult)) {
        setError(
          failureMessage(
            squashAtomCommandFailure(beginResult),
            "Muse Code 로그인 링크와 코드를 발급하지 못했습니다.",
          ),
        );
      }
      return;
    }

    const session = beginResult.value;
    authSessionIdRef.current = session.sessionId;
    setAuthSession(session);
    setIsWaitingAuth(true);

    const waitResult = await waitMuseAuth({
      environmentId,
      input: { sessionId: session.sessionId },
    });
    if (!activeRef.current || authSessionIdRef.current !== session.sessionId) {
      return;
    }
    authSessionIdRef.current = null;
    setIsWaitingAuth(false);

    if (waitResult._tag === "Failure") {
      setAuthSession(null);
      if (!isAtomCommandInterrupted(waitResult)) {
        setError(
          failureMessage(
            squashAtomCommandFailure(waitResult),
            "Muse Code 로그인을 완료하지 못했습니다.",
          ),
        );
      }
      return;
    }

    toastManager.add({
      type: "success",
      title:
        mode === "reauth"
          ? "Muse Code 계정을 다시 로그인했습니다"
          : "Muse Code 계정을 추가했습니다",
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

  const startCloudGoogleAuth = async () => {
    cancelActiveAuthSessions();
    setCloudAuthSession(null);
    setIsStartingCloudAuth(true);
    setIsWaitingCloudAuth(false);
    setError(null);

    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);
    const trimmedName = displayName.trim();
    const beginResult = await beginMuseCloudAuth({
      environmentId,
      input: {
        ...(mode === "reauth" && instanceId ? { instanceId } : {}),
        ...(mode === "add" && trimmedName ? { displayName: trimmedName } : {}),
        ...(mode === "add" && normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      },
    });
    if (!activeRef.current) {
      if (beginResult._tag === "Success") {
        void cancelMuseCloudAuth({
          environmentId,
          input: { sessionId: beginResult.value.sessionId },
        });
      }
      return;
    }
    setIsStartingCloudAuth(false);
    if (beginResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(beginResult)) {
        setError(
          failureMessage(
            squashAtomCommandFailure(beginResult),
            "muse.ai 로그인 브라우저를 열지 못했습니다. 아래 쿠키 직접 붙여넣기를 사용해 보세요.",
          ),
        );
        setShowManualCookieInput(true);
      }
      return;
    }

    const session = beginResult.value;
    cloudAuthSessionIdRef.current = session.sessionId;
    setCloudAuthSession(session);
    setIsWaitingCloudAuth(true);

    const waitResult = await waitMuseCloudAuth({
      environmentId,
      input: { sessionId: session.sessionId },
    });
    if (!activeRef.current || cloudAuthSessionIdRef.current !== session.sessionId) {
      return;
    }
    cloudAuthSessionIdRef.current = null;
    setIsWaitingCloudAuth(false);

    if (waitResult._tag === "Failure") {
      setCloudAuthSession(null);
      if (!isAtomCommandInterrupted(waitResult)) {
        setError(
          failureMessage(
            squashAtomCommandFailure(waitResult),
            "muse.ai Google 로그인을 완료하지 못했습니다.",
          ),
        );
      }
      return;
    }

    toastManager.add({
      type: "success",
      title:
        mode === "reauth"
          ? "muse.ai (Google) 계정을 다시 로그인했습니다"
          : "muse.ai (Google) 클라우드 계정을 추가했습니다",
      description: waitResult.value.email
        ? `${waitResult.value.email} 클라우드 계정이 연결되었습니다.`
        : `${waitResult.value.displayName ?? waitResult.value.instanceId} 클라우드 계정이 연결되었습니다.`,
    });
    onAuthenticated?.({
      instanceId: waitResult.value.instanceId,
      ...(waitResult.value.email ? { email: waitResult.value.email } : {}),
    });
    onOpenChange(false);
  };

  const submitManualCloudCookies = async () => {
    const trimmedCookies = manualCookies.trim();
    if (!trimmedCookies || isImportingCookies) return;
    cancelActiveAuthSessions();
    setCloudAuthSession(null);
    setIsWaitingCloudAuth(false);
    setIsImportingCookies(true);
    setError(null);

    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);
    const trimmedName = displayName.trim();
    const result = await importMuseCloudCookies({
      environmentId,
      input: {
        cookies: trimmedCookies,
        ...(mode === "reauth" && instanceId ? { instanceId } : {}),
        ...(mode === "add" && trimmedName ? { displayName: trimmedName } : {}),
        ...(mode === "add" && normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      },
    });
    if (!activeRef.current) return;
    setIsImportingCookies(false);

    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(
          failureMessage(
            squashAtomCommandFailure(result),
            "muse.ai 쿠키 인증 확인에 실패했습니다. 최신 `hatch_sess` 쿠키인지 확인해 주세요.",
          ),
        );
      }
      return;
    }

    setManualCookies("");
    toastManager.add({
      type: "success",
      title:
        mode === "reauth"
          ? "muse.ai (Google) 계정을 갱신했습니다"
          : "muse.ai (Google) 클라우드 계정을 추가했습니다",
      description: result.value.email
        ? `${result.value.email} 클라우드 계정이 연결되었습니다.`
        : `${result.value.displayName ?? result.value.instanceId} 클라우드 계정이 연결되었습니다.`,
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
      const instance = buildMuseApiInstance({
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
          setError("Muse API 계정을 저장하지 못했습니다.");
        }
        return;
      }
      setApiKey("");
      toastManager.add({
        type: "success",
        title: "Muse API 계정을 추가했습니다",
        description: `${instance.displayName ?? apiInstanceId} 연결이 등록되었습니다.`,
      });
      onAuthenticated?.({ instanceId: apiInstanceId });
      onOpenChange(false);
    } catch (cause) {
      setError(failureMessage(cause, "Muse API 계정을 저장하지 못했습니다."));
    } finally {
      if (activeRef.current) {
        setIsSavingApiKey(false);
      }
    }
  };

  const canSaveApiKey = Boolean(displayName.trim() && apiKey.trim()) && !isSavingApiKey;
  const canImportCookies = Boolean(manualCookies.trim()) && !isImportingCookies;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-xl overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MuseIcon className="size-4" aria-hidden />
              {mode === "reauth" ? "Muse 계정 로그인 · 방식 변경" : "Muse 계정 추가"}
            </DialogTitle>
            <DialogDescription>
              {mode === "reauth"
                ? `${instanceDisplayName ?? instanceId ?? "Muse"} 계정에 공식 Muse Code (Meta 로그인) 또는 muse.ai 클라우드 (Google 로그인) 중 원하는 방식을 선택해 연결합니다.`
                : "공식 Meta Muse Code (로컬 코딩 CLI)와 muse.ai 클라우드 (Google 로그인) 중 원하는 방식을 선택해 T3 Code에 연결할 수 있습니다."}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[70vh] space-y-4 overflow-y-auto bg-zinc-25/80 px-6 py-5 ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5">
            {availableTabs.length > 1 ? (
              <div
                role="tablist"
                aria-label="Muse 계정 연결 방식"
                className="flex flex-wrap gap-1.5"
              >
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
            ) : null}

            {activeTab === "browser" ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-border/70 bg-background/80 p-3 text-xs leading-relaxed text-muted-foreground">
                  <p className="flex items-center gap-1.5 font-medium text-foreground">
                    <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
                    공식 Meta Muse Code CLI (`dev.meta.ai`) · Meta 로그인
                  </p>
                  <p className="mt-1">
                    로컬 파일·명령 실행·MCP·사용량 조회를 지원하는 공식 Muse Code 에이전트입니다.
                    인증 링크와 8자리 코드를 발급한 뒤 브라우저에서{" "}
                    <strong className="font-medium text-foreground">Meta 계정</strong>으로 로그인해
                    승인하세요. (Google 로그인만 쓰시려면 오른쪽{" "}
                    <strong className="font-medium text-foreground">muse.ai 클라우드</strong> 탭을
                    선택하세요.)
                  </p>
                </div>

                {mode === "add" && authSession === null ? (
                  <div className="grid gap-4">
                    <label className="grid gap-1.5 text-sm">
                      <span className="text-xs font-medium text-foreground">표시 이름 (선택)</span>
                      <Input
                        className="bg-background"
                        value={displayName}
                        disabled={isStartingAuth}
                        placeholder="예: Muse Code 개인용 (비워 두면 로그인 계정으로 자동 설정)"
                        onChange={(event) => setDisplayName(event.target.value)}
                      />
                    </label>
                    <ProviderAccentColorPicker
                      displayName="Muse Code 계정"
                      value={accentColor}
                      onCommit={setAccentColor}
                      description="모델 선택 목록에서 여러 Muse 계정을 빠르게 구분하는 색상입니다."
                    />
                  </div>
                ) : null}

                {authSession !== null ? (
                  <div className="space-y-3 rounded-lg border border-border/80 bg-background p-4">
                    <div className="space-y-1.5">
                      <span className="text-xs font-medium text-foreground">
                        1. 브라우저에서 아래 로그인 페이지를 열어 Meta 계정으로 로그인하세요
                      </span>
                      <div className="flex items-center gap-2">
                        <Input
                          readOnly
                          value={authSession.verificationUrl}
                          aria-label="Muse 로그인 URL"
                          className="font-mono text-xs"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void copyText("url", authSession.verificationUrl)}
                        >
                          {copiedField === "url" ? <CheckIcon /> : <CopyIcon />}
                          {copiedField === "url" ? "복사됨" : "링크 복사"}
                        </Button>
                      </div>
                      <div className="pt-1">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() =>
                            window.open(
                              authSession.verificationUrl,
                              "_blank",
                              "noopener,noreferrer",
                            )
                          }
                        >
                          <ExternalLinkIcon />
                          브라우저에서 열기 (Meta 로그인)
                        </Button>
                      </div>
                    </div>

                    {authSession.userCode ? (
                      <div className="space-y-1.5 border-t border-border/60 pt-3">
                        <span className="text-xs font-medium text-foreground">
                          2. 페이지에 아래 코드가 표시되는지 확인하거나 입력한 뒤 승인하세요
                        </span>
                        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                          <code className="font-mono text-base font-semibold tracking-widest text-foreground">
                            {authSession.userCode}
                          </code>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => void copyText("code", authSession.userCode!)}
                          >
                            {copiedField === "code" ? <CheckIcon /> : <CopyIcon />}
                            {copiedField === "code" ? "복사됨" : "코드 복사"}
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {isWaitingAuth ? (
                      <div className="flex items-center gap-2 rounded-md bg-primary/8 px-3 py-2 text-xs text-foreground">
                        <LoaderIcon className="size-3.5 shrink-0 animate-spin" aria-hidden />
                        <span>
                          브라우저에서 Meta 계정 승인을 기다리는 중입니다. 승인이 끝나면 계정이
                          자동으로 연결됩니다.
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            {activeTab === "cloud" ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-border/70 bg-background/80 p-3 text-xs leading-relaxed text-muted-foreground">
                  <p className="flex items-center gap-1.5 font-medium text-foreground">
                    <CloudIcon className="size-3.5 shrink-0" aria-hidden />
                    muse.ai 클라우드 에이전트 · Google 로그인
                  </p>
                  <p className="mt-1">
                    <strong className="font-medium text-foreground">muse.ai</strong> 웹 계정의
                    클라우드 VM 에이전트를 T3 채팅방에서 직접 사용합니다. 아래{" "}
                    <strong className="font-medium text-foreground">
                      Chrome/Edge로 Google 로그인
                    </strong>{" "}
                    버튼을 누르면 깨끗한 로그인 창이 열리며, Google 로그인을 마치면 세션 쿠키(
                    <code className="font-mono text-[11px]">hatch_sess</code>)가 자동으로
                    검증·저장됩니다.
                  </p>
                </div>

                {mode === "add" && cloudAuthSession === null ? (
                  <div className="grid gap-4">
                    <label className="grid gap-1.5 text-sm">
                      <span className="text-xs font-medium text-foreground">표시 이름 (선택)</span>
                      <Input
                        className="bg-background"
                        value={displayName}
                        disabled={isStartingCloudAuth || isImportingCookies}
                        placeholder="예: muse.ai Google (비워 두면 로그인 계정으로 자동 설정)"
                        onChange={(event) => setDisplayName(event.target.value)}
                      />
                    </label>
                    <ProviderAccentColorPicker
                      displayName="muse.ai 클라우드 계정"
                      value={accentColor}
                      onCommit={setAccentColor}
                      description="모델 선택 목록에서 Muse Code와 muse.ai 클라우드 계정을 쉽게 구분하는 색상입니다."
                    />
                  </div>
                ) : null}

                {cloudAuthSession !== null ? (
                  <div className="space-y-3 rounded-lg border border-border/80 bg-background p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="space-y-0.5">
                        <p className="text-xs font-medium text-foreground">
                          {cloudAuthSession.browserLabel} 로그인 창이 열렸습니다
                        </p>
                        <p className="font-mono text-[11px] text-muted-foreground">
                          {cloudAuthSession.loginUrl}
                        </p>
                      </div>
                      <Badge variant="outline" size="sm">
                        자동 쿠키 캡처 대기
                      </Badge>
                    </div>
                    {isWaitingCloudAuth ? (
                      <div className="flex items-center gap-2 rounded-md bg-primary/8 px-3 py-2 text-xs text-foreground">
                        <LoaderIcon className="size-3.5 shrink-0 animate-spin" aria-hidden />
                        <span>
                          열린 {cloudAuthSession.browserLabel} 창에서 Google로 로그인해 주세요.
                          muse.ai 화면이 열리면 계정이 자동으로 검증·연결됩니다.
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="rounded-lg border border-border/60 bg-background/60">
                  <button
                    type="button"
                    aria-expanded={showManualCookieInput}
                    onClick={() => setShowManualCookieInput((prev) => !prev)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-xs font-medium text-foreground hover:bg-muted/40"
                  >
                    <span>수동 백업: 쿠키 직접 붙여넣기 (`hatch_sess`)</span>
                    <ChevronDownIcon
                      aria-hidden
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform",
                        showManualCookieInput && "rotate-180",
                      )}
                    />
                  </button>
                  {showManualCookieInput ? (
                    <div className="space-y-3 border-t border-border/60 px-3 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] leading-relaxed text-muted-foreground">
                        <span>
                          브라우저에서{" "}
                          <strong className="font-medium text-foreground">muse.ai</strong>에 Google
                          로그인한 뒤 F12 → Application → Cookies에서{" "}
                          <code className="font-mono">hatch_sess</code> 값(또는{" "}
                          <code className="font-mono">cookies.txt</code> / JSON)을 붙여 넣으세요.
                        </span>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            window.open("https://muse.ai/", "_blank", "noopener,noreferrer")
                          }
                        >
                          <ExternalLinkIcon />
                          muse.ai 열기
                        </Button>
                      </div>
                      <textarea
                        rows={3}
                        value={manualCookies}
                        disabled={isImportingCookies}
                        aria-label="muse.ai 세션 쿠키"
                        placeholder="hatch_sess=... 또는 쿠키 값 / cookies.txt / JSON"
                        onChange={(event) => setManualCookies(event.target.value)}
                        className="w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          size="xs"
                          variant="secondary"
                          disabled={!canImportCookies}
                          onClick={() => void submitManualCloudCookies()}
                        >
                          {isImportingCookies ? (
                            <>
                              <LoaderIcon className="size-3 animate-spin" aria-hidden />
                              쿠키 검증 중...
                            </>
                          ) : (
                            "쿠키 검증 및 연결"
                          )}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {activeTab === "api-key" && mode === "add" ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-border/70 bg-background/80 p-3 text-xs leading-relaxed text-muted-foreground">
                  <p className="flex items-center gap-1.5 font-medium text-foreground">
                    <KeyRoundIcon className="size-3.5 shrink-0" aria-hidden />
                    Meta API 키 (`META_API_KEY`) 연결
                  </p>
                  <p className="mt-1">
                    API 키는 T3 Code의 로컬 시크릿 스토어에 안전하게 저장되며, 계정별 독립
                    인스턴스로 연결됩니다.
                  </p>
                </div>

                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-medium text-foreground">연결 이름</span>
                  <Input
                    className="bg-background"
                    value={displayName}
                    disabled={isSavingApiKey}
                    placeholder="예: Muse API"
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </label>

                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-medium text-foreground">Meta API 키</span>
                  <Input
                    type="password"
                    className="bg-background font-mono text-xs"
                    value={apiKey}
                    disabled={isSavingApiKey}
                    placeholder="META_API_KEY 값을 붙여 넣으세요"
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                </label>

                <ProviderAccentColorPicker
                  displayName="Muse API 계정"
                  value={accentColor}
                  onCommit={setAccentColor}
                  description="모델 선택 목록에서 계정을 구분하는 색상입니다."
                />
              </div>
            ) : null}

            {error ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {error}
              </div>
            ) : null}
          </div>

          <DialogFooter variant="bare" className="flex-wrap justify-between gap-2">
            <div className="flex items-center gap-2">
              {onBack ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={isBusy}
                  onClick={() => {
                    cancelActiveAuthSessions();
                    onBack();
                  }}
                >
                  이전
                </Button>
              ) : null}
              {onOpenManualWizard ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={isBusy}
                  onClick={() => {
                    cancelActiveAuthSessions();
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
                size="sm"
                variant="outline"
                disabled={isSavingApiKey || isImportingCookies}
                onClick={() => handleOpenChange(false)}
              >
                {isWaitingAny ? "로그인 취소" : "닫기"}
              </Button>
              {activeTab === "browser" ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={isStartingAuth}
                  onClick={() => void startBrowserAuth()}
                >
                  {isStartingAuth ? (
                    <>
                      <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
                      로그인 링크 발급 중...
                    </>
                  ) : authSession !== null ? (
                    "새 코드 다시 받기"
                  ) : (
                    "Muse Code (Meta) 로그인 시작"
                  )}
                </Button>
              ) : activeTab === "cloud" ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={isStartingCloudAuth || isImportingCookies}
                  onClick={() => void startCloudGoogleAuth()}
                >
                  {isStartingCloudAuth ? (
                    <>
                      <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
                      브라우저 여는 중...
                    </>
                  ) : cloudAuthSession !== null ? (
                    "로그인 창 다시 열기"
                  ) : (
                    "Chrome/Edge로 Google 로그인"
                  )}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={!canSaveApiKey}
                  onClick={() => void saveApiKeyAccount()}
                >
                  {isSavingApiKey ? (
                    <>
                      <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
                      저장 중...
                    </>
                  ) : (
                    "API 계정 연결"
                  )}
                </Button>
              )}
            </div>
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
