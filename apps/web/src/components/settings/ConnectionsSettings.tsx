import {
  ChevronsLeftRightEllipsisIcon,
  PlusIcon,
  QrCodeIcon,
  RefreshCwIcon,
  TerminalIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { type ReactNode, memo, useCallback, useId, useMemo, useState } from "react";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthReviewWriteScope,
  AuthStandardClientScopes,
  AuthTerminalOperateScope,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type AuthPairingLink,
  type AdvertisedEndpoint,
  type DesktopDiscoveredSshHost,
  type DesktopSshEnvironmentTarget,
  type DesktopServerExposureState,
  type DesktopWslState,
  type EnvironmentId,
} from "@t3tools/contracts";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { formatElapsedDurationLabel, formatExpiresInLabel } from "../../timestampFormat";
import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";
import {
  applyWslEnableSelection,
  isQrShareableEndpoint,
  selectQrEndpointOption,
} from "./ConnectionsSettings.logic";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { AnimatedHeight } from "../AnimatedHeight";
import { Textarea } from "../ui/textarea";
import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "../../pairingUrl";
import { readHostedPairingRequest } from "../../hostedPairing";
import {
  createServerPairingCredential,
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  isLoopbackHostname,
  usePrimarySessionState,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "~/environments/primary";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { useUiStateStore } from "~/uiStateStore";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
} from "~/versionSkew";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { authEnvironment } from "~/state/auth";
import { environmentCatalog } from "~/connection/catalog";
import {
  connectPairing as connectPairingAtom,
  connectSshEnvironment as connectSshEnvironmentAtom,
} from "~/connection/onboarding";
import { useEnvironmentQuery } from "~/state/query";
import {
  desktopNetworkAccessStateAtom,
  refreshDesktopNetworkAccessState,
} from "~/state/desktopNetworkAccess";
import { desktopSshHostsStateAtom } from "~/state/desktopSshHosts";
import { desktopWslStateAtom, refreshDesktopWslState } from "~/state/desktopWslState";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironment,
} from "~/state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "~/state/server";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { ServerUpdateAction, ServerUpdateProgress } from "../ServerUpdateAction";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";

const DEFAULT_TAILSCALE_SERVE_PORT = 443;
const EMPTY_ADVERTISED_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];
const EMPTY_DISCOVERED_SSH_HOSTS: ReadonlyArray<DesktopDiscoveredSshHost> = [];

// Sentinels for the consolidated WSL backend picker. The colon is
// rejected by DISTRO_NAME_PATTERN (validated on the desktop side) so
// neither can collide with a real distro name.
const BACKEND_VALUE_DEFAULT_WSL = "backend:default-wsl";
const BACKEND_VALUE_WSL_OFF = "backend:wsl-off";

const accessTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatAccessTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return accessTimestampFormatter.format(parsed);
}

const PAIRING_SCOPE_OPTIONS: ReadonlyArray<{
  readonly scope: AuthEnvironmentScope;
  readonly title: string;
  readonly description: string;
}> = [
  {
    scope: AuthOrchestrationReadScope,
    title: "실행 환경 보기",
    description: "대화, 상태, 변경 사항과 설정을 읽을 수 있습니다.",
  },
  {
    scope: AuthOrchestrationOperateScope,
    title: "작업 실행",
    description: "작업을 시작하고 실행 환경의 내용을 변경할 수 있습니다.",
  },
  {
    scope: AuthTerminalOperateScope,
    title: "터미널 사용",
    description: "터미널을 만들고 실행 중인 셸에 입력을 보낼 수 있습니다.",
  },
  {
    scope: AuthReviewWriteScope,
    title: "검토 작성",
    description: "변경 사항을 검토하면서 댓글을 작성할 수 있습니다.",
  },
  {
    scope: AuthAccessReadScope,
    title: "접근 권한 보기",
    description: "페어링 링크와 승인된 클라이언트를 확인할 수 있습니다.",
  },
  {
    scope: AuthAccessWriteScope,
    title: "접근 권한 관리",
    description: "다른 클라이언트의 자격 증명을 발급하고 취소할 수 있습니다.",
  },
  {
    scope: AuthRelayReadScope,
    title: "릴레이 보기",
    description: "관리형 릴레이 연결 상태를 확인할 수 있습니다.",
  },
  {
    scope: AuthRelayWriteScope,
    title: "릴레이 관리",
    description: "관리형 터널 연결을 변경할 수 있습니다.",
  },
];

function AccessScopeSummary({
  scopes,
  label,
}: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly label: string;
}) {
  const scopeCountLabel = `권한 ${scopes.length}개`;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        closeDelay={100}
        render={
          <button
            type="button"
            aria-label={`${label}: ${scopeCountLabel} 보기`}
            className="cursor-help underline decoration-border underline-offset-2 outline-hidden hover:text-foreground focus-visible:text-foreground"
          />
        }
      >
        {scopeCountLabel}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        tooltipStyle
        className="w-max max-w-80 whitespace-normal"
      >
        <p className="mb-1 font-medium">허용된 권한</p>
        <div className="flex flex-col gap-0.5">
          {scopes.map((scope) => (
            <code key={scope} className="font-mono text-foreground/85">
              {scope}
            </code>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function formatDesktopSshTarget(target: DesktopSshEnvironmentTarget): string {
  const authority = target.username ? `${target.username}@${target.hostname}` : target.hostname;
  return target.port ? `${authority}:${target.port}` : authority;
}

function parseManualDesktopSshTarget(input: {
  readonly host: string;
  readonly username: string;
  readonly port: string;
}): DesktopSshEnvironmentTarget {
  const rawHost = input.host.trim();
  if (rawHost.length === 0) {
    throw new Error("SSH 호스트 또는 별칭을 입력하세요.");
  }

  let hostname = rawHost;
  let username = input.username.trim() || null;
  let port: number | null = null;

  const atIndex = hostname.lastIndexOf("@");
  if (atIndex > 0) {
    const inlineUsername = hostname.slice(0, atIndex).trim();
    hostname = hostname.slice(atIndex + 1).trim();
    if (!username && inlineUsername.length > 0) {
      username = inlineUsername;
    }
  }

  const bracketedHostMatch = /^\[([^\]]+)\](?::(\d+))?$/u.exec(hostname);
  if (bracketedHostMatch) {
    hostname = bracketedHostMatch[1]!.trim();
    if (bracketedHostMatch[2]) {
      port = Number.parseInt(bracketedHostMatch[2], 10);
    }
  } else {
    const colonSegments = hostname.split(":");
    if (colonSegments.length === 2 && /^\d+$/u.test(colonSegments[1] ?? "")) {
      hostname = colonSegments[0]!.trim();
      port = Number.parseInt(colonSegments[1]!, 10);
    }
  }

  const rawPort = input.port.trim();
  if (rawPort.length > 0) {
    port = Number.parseInt(rawPort, 10);
  }

  if (hostname.length === 0) {
    throw new Error("SSH 호스트 또는 별칭을 입력하세요.");
  }

  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
    throw new Error("SSH 포트는 1~65535 사이여야 합니다.");
  }

  return {
    alias: hostname,
    hostname,
    username,
    port,
  };
}

function parsePairingUrlFields(
  input: string,
): { readonly host: string; readonly pairingCode: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const urlLikeInput =
      /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed) || trimmed.startsWith("//")
        ? trimmed
        : `https://${trimmed}`;
    const url = new URL(urlLikeInput, window.location.origin);
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest) {
      return {
        host: hostedPairingRequest.host,
        pairingCode: hostedPairingRequest.token,
      };
    }

    const pairingCode = getPairingTokenFromUrl(url);
    if (!pairingCode) return null;
    return {
      host: url.origin,
      pairingCode,
    };
  } catch {
    return null;
  }
}

function parseRemotePairingFields(input: { readonly host: string; readonly pairingCode: string }): {
  readonly host: string;
  readonly pairingCode: string;
} {
  const parsedPairingUrl = parsePairingUrlFields(input.host);
  if (parsedPairingUrl) return parsedPairingUrl;

  const host = input.host.trim();
  const pairingCode = input.pairingCode.trim();
  if (!host) {
    throw new Error("백엔드 호스트를 입력하세요.");
  }
  if (!pairingCode) {
    throw new Error("페어링 코드를 입력하세요.");
  }
  return { host, pairingCode };
}

function formatDesktopSshConnectionError(error: unknown): string {
  const fallback = "SSH 호스트에 연결하지 못했습니다.";
  const rawMessage = error instanceof Error ? error.message : fallback;
  const withoutIpcPrefix = rawMessage.replace(
    /^Error invoking remote method 'desktop:ensure-ssh-environment':\s*/u,
    "",
  );
  const withoutTaggedErrorPrefix = withoutIpcPrefix.replace(/^Ssh[A-Za-z]+Error:\s*/u, "");
  const message = withoutTaggedErrorPrefix.trim();
  return message && /[가-힣]/.test(message) ? message : fallback;
}

const ENDPOINT_ROW_CLASSNAME = "rounded-xl px-3 py-2.5 sm:px-4";

type AccessSectionPresentation = "current" | "endpoint-rail";

function accessRowClassName(_presentation: AccessSectionPresentation) {
  return ITEM_ROW_CLASSNAME;
}

function endpointRowClassName(presentation: AccessSectionPresentation, isAvailable: boolean) {
  if (presentation === "endpoint-rail") {
    return cn("relative rounded-xl px-3 py-3 sm:px-4", !isAvailable && "bg-muted/15");
  }

  return cn(ENDPOINT_ROW_CLASSNAME, !isAvailable && "bg-muted/24");
}

function sortDesktopPairingLinks(links: ReadonlyArray<ServerPairingLinkRecord>) {
  return [...links].toSorted(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

function sortDesktopClientSessions(sessions: ReadonlyArray<ServerClientSessionRecord>) {
  return [...sessions].toSorted((left, right) => {
    if (left.current !== right.current) {
      return left.current ? -1 : 1;
    }
    if (left.connected !== right.connected) {
      return left.connected ? -1 : 1;
    }
    return new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime();
  });
}

function toDesktopPairingLinkRecord(pairingLink: AuthPairingLink): ServerPairingLinkRecord {
  return {
    ...pairingLink,
    createdAt: DateTime.formatIso(pairingLink.createdAt),
    expiresAt: DateTime.formatIso(pairingLink.expiresAt),
  };
}

function toDesktopClientSessionRecord(clientSession: AuthClientSession): ServerClientSessionRecord {
  return {
    ...clientSession,
    issuedAt: DateTime.formatIso(clientSession.issuedAt),
    expiresAt: DateTime.formatIso(clientSession.expiresAt),
    lastConnectedAt:
      clientSession.lastConnectedAt === null
        ? null
        : DateTime.formatIso(clientSession.lastConnectedAt),
  };
}

function selectPairingEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  defaultEndpointKey?: string | null,
): AdvertisedEndpoint | null {
  const availableEndpoints = endpoints.filter((endpoint) => endpoint.status !== "unavailable");
  if (defaultEndpointKey) {
    const selectedEndpoint = availableEndpoints.find(
      (endpoint) => endpointDefaultPreferenceKey(endpoint) === defaultEndpointKey,
    );
    if (selectedEndpoint) {
      return selectedEndpoint;
    }
  }
  return (
    availableEndpoints.find((endpoint) => endpoint.isDefault) ??
    availableEndpoints.find((endpoint) => endpoint.reachability !== "loopback") ??
    availableEndpoints.find((endpoint) => endpoint.compatibility.hostedHttpsApp === "compatible") ??
    null
  );
}

function isTailscaleHttpsEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.id.startsWith("tailscale-magicdns:");
}

function endpointDefaultPreferenceKey(endpoint: AdvertisedEndpoint): string {
  if (endpoint.id.startsWith("desktop-loopback:")) {
    return "desktop-core:loopback:http";
  }
  if (endpoint.id.startsWith("desktop-lan:")) {
    return "desktop-core:lan:http";
  }
  if (endpoint.id.startsWith("tailscale-ip:")) {
    return "tailscale:ip:http";
  }
  if (isTailscaleHttpsEndpoint(endpoint)) {
    return "tailscale:magicdns:https";
  }

  let scheme = "unknown";
  try {
    scheme = new URL(endpoint.httpBaseUrl).protocol.replace(/:$/u, "");
  } catch {
    // Keep the stored preference stable even if a custom endpoint is malformed.
  }

  return `${endpoint.provider.id}:${endpoint.reachability}:${scheme}:${endpoint.label}`;
}

function resolveAdvertisedEndpointPairingUrl(
  endpoint: AdvertisedEndpoint,
  credential: string,
): string {
  if (endpoint.compatibility.hostedHttpsApp === "compatible") {
    return (
      resolveHostedPairingUrl(endpoint.httpBaseUrl, credential) ??
      resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential)
    );
  }
  return resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential);
}

function resolveCurrentOriginPairingUrl(credential: string): string {
  const url = new URL("/pair", window.location.href);
  return setPairingTokenOnUrl(url, credential).toString();
}

function isHostedAppPairingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname === "/pair" && url.searchParams.has("host");
  } catch {
    return false;
  }
}

function endpointShareHint(endpoint: AdvertisedEndpoint, url: string): string {
  if (isHostedAppPairingUrl(url)) {
    return "설치 없이 호스팅 앱에서 열립니다";
  }
  switch (endpoint.reachability) {
    case "lan":
      return "같은 네트워크의 기기에서 사용 가능";
    case "private-network":
      return "개인 네트워크의 기기에서 사용 가능";
    case "public":
      return "어디서나 연결 가능";
    case "loopback":
      return "이 컴퓨터의 클라이언트에서 사용 가능";
  }
}

function advertisedEndpointLabel(endpoint: AdvertisedEndpoint): string {
  if (endpoint.id.startsWith("desktop-loopback:")) return "이 컴퓨터";
  if (endpoint.id.startsWith("desktop-lan:")) return "로컬 네트워크";
  if (endpoint.id.startsWith("tailscale-ip:")) return "Tailscale IP";
  if (isTailscaleHttpsEndpoint(endpoint)) return "Tailscale HTTPS";
  if (endpoint.id.startsWith("manual:")) {
    return endpoint.httpBaseUrl.startsWith("https://")
      ? "사용자 지정 HTTPS"
      : "사용자 지정 연결 주소";
  }
  return endpoint.label;
}

type PairingLinkListRowProps = {
  pairingLink: ServerPairingLinkRecord;
  endpointUrl: string | null | undefined;
  endpoints: ReadonlyArray<AdvertisedEndpoint>;
  defaultEndpointKey: string | null;
  presentation?: AccessSectionPresentation;
  revokingPairingLinkId: string | null;
  onRevoke: (id: string) => void;
};

const PairingLinkListRow = memo(function PairingLinkListRow({
  pairingLink,
  endpointUrl,
  endpoints,
  defaultEndpointKey,
  presentation = "current",
  revokingPairingLinkId,
  onRevoke,
}: PairingLinkListRowProps) {
  const nowMs = useRelativeTimeTick(1_000);
  const expiresAtMs = useMemo(
    () => new Date(pairingLink.expiresAt).getTime(),
    [pairingLink.expiresAt],
  );
  const [isRevealDialogOpen, setIsRevealDialogOpen] = useState(false);
  const [isQrPanelOpen, setIsQrPanelOpen] = useState(false);
  // Ephemeral per-row choice of which endpoint the QR encodes (AdvertisedEndpoint.id);
  // null falls back to the saved default endpoint.
  const [qrEndpointId, setQrEndpointId] = useState<string | null>(null);
  const qrPanelId = useId();

  const currentOriginPairingUrl = useMemo(
    () => resolveCurrentOriginPairingUrl(pairingLink.credential),
    [pairingLink.credential],
  );
  const hostedPairingUrl = useMemo(
    () =>
      endpointUrl != null && endpointUrl !== ""
        ? resolveHostedPairingUrl(endpointUrl, pairingLink.credential)
        : null,
    [endpointUrl, pairingLink.credential],
  );
  const endpointPairingUrl = useMemo(() => {
    const endpoint = selectPairingEndpoint(endpoints, defaultEndpointKey);
    return endpoint ? resolveAdvertisedEndpointPairingUrl(endpoint, pairingLink.credential) : null;
  }, [defaultEndpointKey, endpoints, pairingLink.credential]);
  const endpointCopyOptions = useMemo(() => {
    const options: Array<{
      readonly id: string;
      readonly preferenceKey: string;
      readonly label: string;
      readonly url: string;
      readonly detail: string;
      readonly qrShareable: boolean;
    }> = [];
    for (const endpoint of endpoints) {
      if (endpoint.status === "unavailable") {
        continue;
      }
      const url = resolveAdvertisedEndpointPairingUrl(endpoint, pairingLink.credential);
      options.push({
        id: endpoint.id,
        preferenceKey: endpointDefaultPreferenceKey(endpoint),
        label: advertisedEndpointLabel(endpoint),
        url,
        detail: endpointShareHint(endpoint, url),
        qrShareable: isQrShareableEndpoint(endpoint),
      });
    }
    return options;
  }, [endpoints, pairingLink.credential]);
  const shareablePairingUrl =
    endpointPairingUrl ??
    (endpointUrl != null && endpointUrl !== ""
      ? (hostedPairingUrl ?? resolveDesktopPairingUrl(endpointUrl, pairingLink.credential))
      : isLoopbackHostname(window.location.hostname)
        ? null
        : currentOriginPairingUrl);
  // Value of the copy attempt that last failed. The clipboard-failure reveal
  // dialog must show exactly what failed to copy, not the row's default URL.
  const [failedCopyValue, setFailedCopyValue] = useState<string | null>(null);
  const revealValue = failedCopyValue ?? shareablePairingUrl ?? pairingLink.credential;
  const isRevealValueUrl = revealValue !== pairingLink.credential;
  const isRevealValueHostedAppPairingUrl = isRevealValueUrl && isHostedAppPairingUrl(revealValue);
  // Never render a QR for a loopback URL, even in the manual-copy fallback.
  const isRevealValueQrShareable =
    endpointCopyOptions.find((option) => option.url === revealValue)?.qrShareable ?? true;
  const canCopyToClipboard =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    navigator.clipboard?.writeText != null;

  const { copyToClipboard } = useCopyToClipboard<{
    value: string;
    kind: "code" | "hosted-link" | "link";
  }>({
    onCopy: ({ kind }) => {
      toastManager.add({
        type: "success",
        title:
          kind === "hosted-link"
            ? "호스팅 앱 링크를 복사했습니다"
            : kind === "link"
              ? "페어링 URL을 복사했습니다"
              : "페어링 코드를 복사했습니다",
        description:
          kind === "hosted-link"
            ? "연결할 기기의 브라우저에서 여세요."
            : kind === "link"
              ? "이 실행 환경과 페어링할 클라이언트에서 여세요."
              : "다른 클라이언트에 붙여 넣어 페어링을 완료하세요.",
      });
    },
    onError: (error, { value, kind }) => {
      // Captured per attempt so concurrent copies cannot make the dialog
      // reveal a different value than the one that failed.
      setFailedCopyValue(value);
      setIsRevealDialogOpen(true);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: canCopyToClipboard
            ? kind === "hosted-link"
              ? "호스팅 앱 링크를 복사하지 못했습니다"
              : kind === "link"
                ? "페어링 URL을 복사하지 못했습니다"
                : "페어링 코드를 복사하지 못했습니다"
            : "클립보드 복사를 사용할 수 없습니다",
          description: "직접 복사할 수 있도록 전체 값을 표시합니다.",
        }),
      );
    },
  });

  const copyPairingValue = useCallback(
    (value: string, kind: "code" | "hosted-link" | "link") => {
      copyToClipboard(value, { value, kind });
    },
    [copyToClipboard],
  );

  const copyKindForUrl = useCallback(
    (url: string): "hosted-link" | "link" => (isHostedAppPairingUrl(url) ? "hosted-link" : "link"),
    [],
  );

  const handleCopyCode = useCallback(() => {
    copyPairingValue(pairingLink.credential, "code");
  }, [copyPairingValue, pairingLink.credential]);

  const expiresAbsolute = formatAccessTimestamp(pairingLink.expiresAt);

  const primaryLabel = pairingLink.label ?? "페어링 링크";
  const selectedQrOption = selectQrEndpointOption(
    endpointCopyOptions,
    qrEndpointId,
    defaultEndpointKey,
  );
  const qrPairingUrl = selectedQrOption?.url ?? shareablePairingUrl;
  // With no endpoint list the fallback is never loopback: selectPairingEndpoint
  // skips loopback and the current-origin fallback is guarded by
  // isLoopbackHostname, so only an explicit loopback selection hides the QR.
  const canRenderQrForSelection = selectedQrOption?.qrShareable ?? true;
  if (expiresAtMs <= nowMs) {
    return null;
  }

  return (
    <div className={accessRowClassName(presentation)}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={`링크 생성 시각: ${formatAccessTimestamp(pairingLink.createdAt)}`}
              dotClassName="bg-amber-400"
            />
            <h3 className="text-sm font-medium text-foreground">{primaryLabel}</h3>
          </div>
          <p className="text-xs text-muted-foreground" title={expiresAbsolute}>
            {formatExpiresInLabel(pairingLink.expiresAt, nowMs)}
            <span aria-hidden> · </span>
            <AccessScopeSummary scopes={pairingLink.scopes} label="페어링 링크 권한" />
          </p>
          {shareablePairingUrl === null ? (
            <p className="text-[11px] text-muted-foreground/70">
              토큰을 복사한 뒤 이 백엔드에 연결 가능한 호스트 주소로 다른 클라이언트에서
              페어링하세요.
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {shareablePairingUrl && canCopyToClipboard ? (
            <Button
              size="xs"
              variant="outline"
              aria-expanded={isQrPanelOpen}
              aria-controls={qrPanelId}
              onClick={() => setIsQrPanelOpen((open) => !open)}
            >
              <QrCodeIcon aria-hidden />
              공유
            </Button>
          ) : null}
          <Dialog
            open={isRevealDialogOpen}
            onOpenChange={(open) => {
              setIsRevealDialogOpen(open);
              if (!open) setFailedCopyValue(null);
            }}
          >
            {canCopyToClipboard ? (
              shareablePairingUrl ? null : (
                <Button size="xs" variant="outline" onClick={handleCopyCode}>
                  코드 복사
                </Button>
              )
            ) : (
              <DialogTrigger render={<Button size="xs" variant="outline" />}>
                {shareablePairingUrl ? "링크 보기" : "코드 보기"}
              </DialogTrigger>
            )}
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {isRevealValueUrl
                    ? isRevealValueHostedAppPairingUrl
                      ? "호스팅 앱 페어링 링크"
                      : "페어링 링크"
                    : "페어링 코드"}
                </DialogTitle>
                <DialogDescription>
                  {isRevealValueUrl
                    ? isRevealValueHostedAppPairingUrl
                      ? "클립보드 복사를 사용할 수 없습니다. 연결할 기기에서 이 호스팅 앱 링크를 열거나 직접 복사하세요."
                      : "클립보드 복사를 사용할 수 없습니다. 연결할 기기에서 전체 페어링 URL을 열거나 직접 복사하세요."
                    : "클립보드 복사를 사용할 수 없습니다. 이 코드를 다른 클라이언트에 직접 입력하세요."}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel className="space-y-4">
                <Textarea
                  readOnly
                  value={revealValue}
                  rows={isRevealValueUrl ? 4 : 3}
                  className="text-xs leading-relaxed"
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                />
                {isRevealValueUrl && isRevealValueQrShareable ? (
                  <div className="flex justify-center rounded-xl border border-border/60 bg-muted/30 p-4">
                    <QRCodeSvg
                      value={revealValue}
                      size={132}
                      level="M"
                      marginSize={2}
                      title="페어링 링크 — 다른 기기에서 스캔해 열기"
                    />
                  </div>
                ) : null}
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button variant="outline" onClick={() => setIsRevealDialogOpen(false)}>
                  완료
                </Button>
                {canCopyToClipboard ? (
                  <Button variant="outline" size="xs" onClick={handleCopyCode}>
                    코드 복사
                  </Button>
                ) : null}
              </DialogFooter>
            </DialogPopup>
          </Dialog>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={revokingPairingLinkId === pairingLink.id}
            onClick={() => void onRevoke(pairingLink.id)}
          >
            {revokingPairingLinkId === pairingLink.id ? "취소 중…" : "취소"}
          </Button>
        </div>
      </div>
      {isQrPanelOpen && qrPairingUrl !== null ? (
        <div
          id={qrPanelId}
          className="mt-3 flex flex-col gap-4 border-t border-border/50 pt-3 sm:flex-row sm:items-start sm:justify-between"
        >
          <div className="min-w-0 flex-1 space-y-3">
            {endpointCopyOptions.length > 1 ? (
              <div
                className="space-y-1.5"
                role="radiogroup"
                aria-label="페어링 QR 코드와 URL에 사용할 연결 주소"
              >
                <p className="text-[11px] text-muted-foreground/70">이 컴퓨터 연결 방식</p>
                {endpointCopyOptions.map((option) => {
                  const isSelected = option.id === selectedQrOption?.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      className={cn(
                        "flex w-full items-baseline gap-2 rounded-lg border px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isSelected
                          ? "border-foreground/60 bg-muted/30"
                          : "border-border/50 hover:bg-muted/20",
                      )}
                      onClick={() => setQrEndpointId(option.id)}
                    >
                      <span
                        className={cn(
                          "text-xs font-medium",
                          isSelected ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {option.label}
                      </span>
                      <span className="min-w-0 truncate text-[11px] text-muted-foreground/70">
                        {option.detail}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
              <code
                title={qrPairingUrl}
                className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
              >
                {qrPairingUrl}
              </code>
              <Button
                size="xs"
                variant="ghost"
                className="shrink-0"
                onClick={() => copyPairingValue(qrPairingUrl, copyKindForUrl(qrPairingUrl))}
              >
                링크 복사
              </Button>
            </div>
            <Button size="xs" variant="ghost" onClick={handleCopyCode}>
              코드만 복사
            </Button>
          </div>
          {canRenderQrForSelection ? (
            <div className="w-fit shrink-0 self-center rounded-xl bg-white p-3 sm:self-start">
              <QRCodeSvg
                value={qrPairingUrl}
                size={168}
                level="M"
                marginSize={1}
                title="페어링 링크 — 다른 기기에서 스캔해 열기"
              />
            </div>
          ) : (
            <div className="flex size-[192px] shrink-0 items-center justify-center self-center rounded-xl border border-border/50 p-4 sm:self-start">
              <p className="text-center text-[11px] text-muted-foreground/70">
                이 연결 주소에는 QR 코드를 사용할 수 없습니다. 다른 기기에서 루프백 링크를 스캔하면
                해당 기기 자신으로 연결되므로, 이 컴퓨터에서 쓸 URL을 복사하세요.
              </p>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
});

type ConnectedClientListRowProps = {
  clientSession: ServerClientSessionRecord;
  presentation?: AccessSectionPresentation;
  revokingClientSessionId: string | null;
  onRevokeSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
};

const ConnectedClientListRow = memo(function ConnectedClientListRow({
  clientSession,
  presentation = "current",
  revokingClientSessionId,
  onRevokeSession,
}: ConnectedClientListRowProps) {
  const nowMs = useRelativeTimeTick(1_000);
  const isLive = clientSession.current || clientSession.connected;
  const lastConnectedAt = clientSession.lastConnectedAt;
  const statusTooltip = isLive
    ? lastConnectedAt
      ? `${formatElapsedDurationLabel(lastConnectedAt, nowMs)} 동안 연결됨`
      : "연결됨"
    : lastConnectedAt
      ? `마지막 연결: ${formatAccessTimestamp(lastConnectedAt)}`
      : "아직 연결된 적이 없습니다.";
  const deviceInfoBits = [
    clientSession.client.deviceType !== "unknown"
      ? clientSession.client.deviceType[0]?.toUpperCase() + clientSession.client.deviceType.slice(1)
      : null,
    clientSession.client.os ?? null,
    clientSession.client.browser ?? null,
    clientSession.client.ipAddress ?? null,
  ].filter((value): value is string => value !== null);
  const primaryLabel =
    clientSession.client.label ??
    ([clientSession.client.os, clientSession.client.browser].filter(Boolean).join(" · ") ||
      clientSession.subject);

  return (
    <div className={accessRowClassName(presentation)}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusTooltip}
              dotClassName={isLive ? "bg-success" : "bg-muted-foreground/30"}
              pingClassName={isLive ? "bg-success/60 duration-2000" : null}
            />
            <h3 className="text-sm font-medium text-foreground">{primaryLabel}</h3>
            {clientSession.current ? (
              <span className="text-[10px] text-muted-foreground/80 rounded-md border border-border/50 bg-muted/50 px-1 py-0.5">
                이 기기
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {deviceInfoBits.length > 0 ? (
              <>
                {deviceInfoBits.join(" · ")}
                <span aria-hidden> · </span>
              </>
            ) : null}
            <AccessScopeSummary scopes={clientSession.scopes} label="클라이언트 권한" />
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {!clientSession.current ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={revokingClientSessionId === clientSession.sessionId}
              onClick={() => void onRevokeSession(clientSession.sessionId)}
            >
              {revokingClientSessionId === clientSession.sessionId ? "취소 중…" : "취소"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

type AuthorizedClientsHeaderActionProps = {
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  isRevokingOtherClients: boolean;
  onRevokeOtherClients: () => void;
};

const AuthorizedClientsHeaderAction = memo(function AuthorizedClientsHeaderAction({
  clientSessions,
  isRevokingOtherClients,
  onRevokeOtherClients,
}: AuthorizedClientsHeaderActionProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pairingLabel, setPairingLabel] = useState("");
  const [pairingScopes, setPairingScopes] = useState<ReadonlyArray<AuthEnvironmentScope>>([
    ...AuthStandardClientScopes,
  ]);
  const [isCreatingPairingLink, setIsCreatingPairingLink] = useState(false);

  const handleCreatePairingLink = useCallback(async () => {
    setIsCreatingPairingLink(true);
    try {
      await createServerPairingCredential({ label: pairingLabel, scopes: pairingScopes });
      setPairingLabel("");
      setPairingScopes([...AuthStandardClientScopes]);
      setDialogOpen(false);
    } catch (error) {
      const message = "새 페어링 링크를 만들지 못했습니다.";
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "페어링 링크를 만들지 못했습니다",
          description: message,
        }),
      );
    } finally {
      setIsCreatingPairingLink(false);
    }
  }, [pairingLabel, pairingScopes]);

  const togglePairingScope = useCallback((scope: AuthEnvironmentScope, checked: boolean) => {
    setPairingScopes((current) =>
      checked ? [...current, scope] : current.filter((currentScope) => currentScope !== scope),
    );
  }, []);

  return (
    <div className="flex items-center gap-2">
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={
          isRevokingOtherClients || clientSessions.every((clientSession) => clientSession.current)
        }
        onClick={() => void onRevokeOtherClients()}
      >
        {isRevokingOtherClients ? "취소 중…" : "다른 클라이언트 취소"}
      </Button>
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setPairingLabel("");
            setPairingScopes([...AuthStandardClientScopes]);
          }
        }}
      >
        <DialogTrigger
          render={
            <Button size="xs" variant="default">
              <PlusIcon className="size-3" />
              링크 만들기
            </Button>
          }
        />
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>페어링 링크 만들기</DialogTitle>
            <DialogDescription>
              다른 기기가 이 백엔드의 승인된 클라이언트로 페어링할 수 있는 일회용 링크를 만듭니다.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                클라이언트 이름(선택 사항)
              </span>
              <Input
                value={pairingLabel}
                onChange={(event) => setPairingLabel(event.target.value)}
                placeholder="예: 거실 iPad"
                disabled={isCreatingPairingLink}
                autoFocus
              />
            </label>
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-xs font-medium text-foreground">권한</h3>
                  <p className="text-xs text-muted-foreground">
                    페어링된 클라이언트가 할 수 있는 작업을 제한합니다.
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={isCreatingPairingLink}
                    onClick={() => setPairingScopes([AuthOrchestrationReadScope])}
                  >
                    읽기 전용
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={isCreatingPairingLink}
                    onClick={() => setPairingScopes([...AuthStandardClientScopes])}
                  >
                    표준
                  </Button>
                </div>
              </div>
              <div className="divide-y divide-border/60 rounded-lg border border-input bg-muted/25">
                {PAIRING_SCOPE_OPTIONS.map(({ scope, title, description }) => (
                  <label
                    key={scope}
                    className="flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={pairingScopes.includes(scope)}
                      disabled={isCreatingPairingLink}
                      onCheckedChange={(checked) => togglePairingScope(scope, checked === true)}
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-foreground">{title}</span>
                      <span className="block text-xs leading-snug text-muted-foreground">
                        {description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {pairingScopes.length === 0 ? (
                <p className="text-xs text-destructive">권한을 하나 이상 선택하세요.</p>
              ) : pairingScopes.includes(AuthAccessWriteScope) ? (
                <p className="text-xs text-warning">
                  이 클라이언트는 다른 기기의 접근 권한을 만들거나 취소할 수 있습니다.
                </p>
              ) : null}
            </section>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              variant="outline"
              disabled={isCreatingPairingLink}
              onClick={() => setDialogOpen(false)}
            >
              취소
            </Button>
            <Button
              disabled={isCreatingPairingLink || pairingScopes.length === 0}
              onClick={() => void handleCreatePairingLink()}
            >
              {isCreatingPairingLink ? "만드는 중…" : "링크 만들기"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});

type PairingClientsListProps = {
  endpointUrl: string | null | undefined;
  endpoints: ReadonlyArray<AdvertisedEndpoint>;
  defaultEndpointKey: string | null;
  presentation?: AccessSectionPresentation;
  isLoading: boolean;
  pairingLinks: ReadonlyArray<ServerPairingLinkRecord>;
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  revokingPairingLinkId: string | null;
  revokingClientSessionId: string | null;
  onRevokePairingLink: (id: string) => void;
  onRevokeClientSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
};

const PairingClientsList = memo(function PairingClientsList({
  endpointUrl,
  endpoints,
  defaultEndpointKey,
  presentation = "current",
  isLoading,
  pairingLinks,
  clientSessions,
  revokingPairingLinkId,
  revokingClientSessionId,
  onRevokePairingLink,
  onRevokeClientSession,
}: PairingClientsListProps) {
  return (
    <>
      {pairingLinks.map((pairingLink) => (
        <PairingLinkListRow
          key={pairingLink.id}
          pairingLink={pairingLink}
          endpointUrl={endpointUrl}
          endpoints={endpoints}
          defaultEndpointKey={defaultEndpointKey}
          presentation={presentation}
          revokingPairingLinkId={revokingPairingLinkId}
          onRevoke={onRevokePairingLink}
        />
      ))}

      {clientSessions.map((clientSession) => (
        <ConnectedClientListRow
          key={clientSession.sessionId}
          clientSession={clientSession}
          presentation={presentation}
          revokingClientSessionId={revokingClientSessionId}
          onRevokeSession={onRevokeClientSession}
        />
      ))}

      {pairingLinks.length === 0 && clientSessions.length === 0 && !isLoading ? (
        <div className={accessRowClassName(presentation)}>
          <p className="text-xs text-muted-foreground/60">
            페어링 링크나 클라이언트 세션이 없습니다.
          </p>
        </div>
      ) : null}
    </>
  );
});

type AdvertisedEndpointListRowProps = {
  endpoint: AdvertisedEndpoint;
  isDefault: boolean;
  presentation?: AccessSectionPresentation;
  onSetDefault: (endpoint: AdvertisedEndpoint) => void;
  onSetupTailscaleServe: (endpoint: AdvertisedEndpoint) => void;
  onDisableTailscaleServe: (endpoint: AdvertisedEndpoint) => void;
  isUpdatingTailscaleServe: boolean;
};

const AdvertisedEndpointListRow = memo(function AdvertisedEndpointListRow({
  endpoint,
  isDefault,
  presentation = "current",
  onSetDefault,
  onSetupTailscaleServe,
  onDisableTailscaleServe,
  isUpdatingTailscaleServe,
}: AdvertisedEndpointListRowProps) {
  const isAvailable = endpoint.status === "available";
  const needsTailscaleSetup = isTailscaleHttpsEndpoint(endpoint) && endpoint.status !== "available";
  const canDisableTailscaleServe =
    isTailscaleHttpsEndpoint(endpoint) && endpoint.status === "available";
  const shouldShowEndpointUrl = !needsTailscaleSetup;
  const isEndpointRail = presentation === "endpoint-rail";
  return (
    <div className={endpointRowClassName(presentation, isAvailable)}>
      {isEndpointRail && isDefault ? (
        <span className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-primary" aria-hidden />
      ) : null}
      <div className="flex min-h-6 min-w-0 flex-col gap-2 sm:-my-0.5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-baseline gap-3">
          <h3 className="shrink-0 text-sm leading-5 font-medium text-foreground">
            {advertisedEndpointLabel(endpoint)}
          </h3>
          {shouldShowEndpointUrl ? (
            <p
              className="min-w-0 truncate text-xs leading-5 text-muted-foreground"
              title={endpoint.httpBaseUrl}
            >
              {endpoint.httpBaseUrl}
            </p>
          ) : null}
          {!isAvailable ? (
            <span className="shrink-0 rounded-md border border-border/70 px-1 py-0.5 text-[10px] text-muted-foreground">
              설정 필요
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex min-h-6 shrink-0 items-center justify-end gap-2">
          {isDefault ? (
            <span className="rounded-md border border-primary/30 bg-primary/10 px-1 py-0.5 text-[10px] text-primary">
              기본값
            </span>
          ) : null}
          {needsTailscaleSetup ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => onSetupTailscaleServe(endpoint)}
              disabled={isUpdatingTailscaleServe}
            >
              {isUpdatingTailscaleServe ? "다시 시작 중…" : "설정"}
            </Button>
          ) : null}
          {canDisableTailscaleServe ? (
            <Button
              size="xs"
              variant="destructive-outline"
              onClick={() => onDisableTailscaleServe(endpoint)}
              disabled={isUpdatingTailscaleServe}
            >
              {isUpdatingTailscaleServe ? "다시 시작 중…" : "사용 안 함"}
            </Button>
          ) : null}
          {!needsTailscaleSetup && !isDefault ? (
            <Button size="xs" variant="outline" onClick={() => onSetDefault(endpoint)}>
              기본값으로 설정
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

function NetworkAccessDescription({
  endpoint,
  hiddenEndpointCount,
  expanded,
  onToggleExpanded,
  fallback,
}: {
  endpoint: AdvertisedEndpoint | null;
  hiddenEndpointCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  fallback: ReactNode;
}) {
  if (!endpoint) {
    return fallback;
  }

  const summary = (
    <>
      <span className="min-w-0 truncate">{endpoint.httpBaseUrl}</span>
      {hiddenEndpointCount > 0 ? (
        <span className="shrink-0 text-xs font-medium">
          {expanded ? "숨기기" : `+${hiddenEndpointCount}`}
        </span>
      ) : null}
    </>
  );

  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1">
      <span className="shrink-0">연결 주소</span>
      {hiddenEndpointCount > 0 ? (
        <button
          type="button"
          className="inline-flex min-w-0 max-w-full items-baseline gap-2 border-b border-dotted border-muted-foreground/60 text-left text-muted-foreground underline-offset-4 hover:border-foreground hover:text-foreground"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
        >
          {summary}
        </button>
      ) : (
        <span className="inline-flex min-w-0 max-w-full items-baseline gap-2">{summary}</span>
      )}
    </span>
  );
}

type SavedBackendListRowProps = {
  environment: EnvironmentPresentation;
  removingEnvironmentId: EnvironmentId | null;
  onConnect: (environmentId: EnvironmentId) => void;
  onRemove: (environmentId: EnvironmentId) => void;
};

function SavedBackendListRow({
  environment,
  removingEnvironmentId,
  onConnect,
  onRemove,
}: SavedBackendListRowProps) {
  const environmentId = environment.environmentId;
  const connectionState = environment.connection.phase;
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting" || connectionState === "reconnecting";
  const stateDotClassName =
    connectionState === "connected"
      ? "bg-success"
      : connectionState === "connecting" || connectionState === "reconnecting"
        ? "bg-warning"
        : connectionState === "error"
          ? "bg-destructive"
          : "bg-muted-foreground/40";
  const statusTooltip = connectionStatusText(environment.connection);
  const errorTraceId = environment.connection.traceId;
  const { copyToClipboard: copyTraceIdToClipboard } = useCopyToClipboard<{ traceId: string }>({
    target: "추적 ID",
    onCopy: ({ traceId }) => {
      toastManager.add({
        type: "success",
        title: "추적 ID를 복사했습니다",
        description: traceId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "추적 ID를 복사하지 못했습니다",
          description: "클립보드 권한을 확인해 주세요.",
        }),
      );
    },
  });
  const copyTraceId = useCallback(
    (traceId: string) => {
      copyTraceIdToClipboard(traceId, { traceId });
    },
    [copyTraceIdToClipboard],
  );
  const versionMismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
  const serverUpdateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const resumingServerUpdate =
    serverUpdateState.status === "running" && serverUpdateState.stage === "resuming";
  const sshTarget =
    environment.entry.target._tag === "SshConnectionTarget" &&
    Option.isSome(environment.entry.profile) &&
    environment.entry.profile.value._tag === "SshConnectionProfile"
      ? environment.entry.profile.value.target
      : null;
  const metadataBits = [
    sshTarget ? `SSH ${formatDesktopSshTarget(sshTarget)}` : null,
    environment.relayManaged ? "T3 Connect" : null,
  ].filter((value): value is string => value !== null);

  // The WSL backend is a desktop-managed local backend (it surfaces as a bearer
  // environment whose connection id is prefixed "local:"), not a remote
  // environment you connect to or remove here — its lifecycle is driven by the
  // WSL on/off + distro picker on this page.
  const isWslEnvironment = isDesktopLocalConnectionTarget(environment.entry.target);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusTooltip}
              dotClassName={stateDotClassName}
              pingClassName={
                connectionState === "connecting" || connectionState === "reconnecting"
                  ? "bg-warning/60 duration-2000"
                  : null
              }
            />
            <h3 className="text-sm font-medium text-foreground">{environment.label}</h3>
          </div>
          {metadataBits.length > 0 ? (
            <p className="text-xs text-muted-foreground">{metadataBits.join(" · ")}</p>
          ) : null}
          {serverUpdateState.status !== "idle" ? (
            <div className="max-w-md">
              <ServerUpdateProgress state={serverUpdateState} />
            </div>
          ) : versionMismatch ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="w-fit cursor-help rounded-sm text-left text-muted-foreground text-xs"
                  >
                    서버 업데이트 사용 가능
                  </button>
                }
              />
              <TooltipPopup side="top">
                {versionMismatch.serverVersion} <span aria-hidden="true">→</span>{" "}
                {versionMismatch.clientVersion}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {environment.connection.error && !resumingServerUpdate ? (
            <p className="flex min-w-0 items-center gap-2 text-destructive text-xs">
              <span className="truncate">{connectionStatusText(environment.connection)}</span>
              {errorTraceId ? (
                <button
                  type="button"
                  className="shrink-0 underline underline-offset-2"
                  onClick={() => copyTraceId(errorTraceId)}
                >
                  추적 ID 복사
                </button>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {versionMismatch &&
          (serverUpdateState.status === "idle" || serverUpdateState.status === "failed") ? (
            <ServerUpdateAction
              environmentId={environmentId}
              serverLabel={`${environment.label} 서버`}
              selfUpdate={resolveServerSelfUpdateCapability(environment.serverConfig)}
              targetVersion={versionMismatch.clientVersion}
              label={serverUpdateState.status === "failed" ? "다시 시도" : "업데이트"}
            />
          ) : null}
          {isWslEnvironment ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button size="xs" variant="outline" disabled>
                    위 설정에서 관리됨
                  </Button>
                }
              />
              <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
                WSL 백엔드는 위의 WSL 설정에서 관리합니다. 해당 설정에서 켜거나 끄세요.
              </TooltipPopup>
            </Tooltip>
          ) : (
            <>
              {!isConnected ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={removingEnvironmentId === environmentId}
                  onClick={() => void onRemove(environmentId)}
                >
                  {removingEnvironmentId === environmentId ? "제거 중…" : "제거"}
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                disabled={isConnecting || removingEnvironmentId === environmentId}
                onClick={() =>
                  void (isConnected ? onRemove(environmentId) : onConnect(environmentId))
                }
              >
                {isConnected
                  ? removingEnvironmentId === environmentId
                    ? "연결 해제 중…"
                    : "연결 해제"
                  : isConnecting
                    ? "연결 중…"
                    : "연결"}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface DesktopSshHostRowProps {
  target: DesktopDiscoveredSshHost;
  connectingHostAlias: string | null;
  onConnect: (target: DesktopDiscoveredSshHost) => void;
}

const DesktopSshHostRow = memo(function DesktopSshHostRow({
  target,
  connectingHostAlias,
  onConnect,
}: DesktopSshHostRowProps) {
  const address = formatDesktopSshTarget(target);
  const showAddress = address !== target.alias;
  const buttonLabel = connectingHostAlias === target.alias ? "추가 중…" : "실행 환경 추가";

  return (
    <div className="rounded-xl px-3 py-3 sm:px-4">
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-foreground">{target.alias}</h3>
          {showAddress ? <p className="truncate text-xs text-muted-foreground">{address}</p> : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Button
            size="xs"
            variant="outline"
            disabled={connectingHostAlias === target.alias}
            onClick={() => onConnect(target)}
          >
            {connectingHostAlias === target.alias ? (
              <RefreshCwIcon className="size-3 animate-spin" />
            ) : null}
            {buttonLabel}
          </Button>
        </div>
      </div>
    </div>
  );
});

function CloudLinkSwitch({
  checked,
  disabled,
  disabledReason,
  onCheckedChange,
  ariaLabel = "T3 Connect 사용",
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly onCheckedChange?: (enabled: boolean) => void;
  readonly ariaLabel?: string;
}) {
  const control = (
    <Switch
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      {...(onCheckedChange ? { onCheckedChange } : {})}
    />
  );
  return disabledReason ? (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{control}</span>} />
      <TooltipPopup side="top">{disabledReason}</TooltipPopup>
    </Tooltip>
  ) : (
    control
  );
}

function ConfiguredCloudLinkRow({ canManageRelay }: { readonly canManageRelay: boolean }) {
  const {
    isSignedIn,
    linkState: primaryCloudLinkState,
    managedTunnelActive,
    publishAgentActivity,
    operationError,
    reconcileCloudState,
  } = useCloudLinkController();
  const [isUpdating, setIsUpdating] = useState(false);
  const [isUpdatingPreference, setIsUpdatingPreference] = useState(false);

  const disabledReason = !isSignedIn
    ? "이 실행 환경을 관리하려면 T3 Connect에 로그인하세요."
    : !canManageRelay
      ? "현재 세션에는 T3 Connect 접근을 관리할 권한이 없습니다."
      : null;
  const isBusy = isUpdating || isUpdatingPreference;

  const updateManagedTunnel = async (enabled: boolean) => {
    setIsUpdating(true);
    const ok = await reconcileCloudState({ managedTunnel: enabled, publish: publishAgentActivity });
    if (ok) {
      // Turning the tunnel off while publishing stays on downgrades the link
      // rather than removing it — say so instead of claiming an unlink.
      toastManager.add({
        type: "success",
        title: enabled
          ? "T3 Connect 연결됨"
          : publishAgentActivity
            ? "T3 Connect 터널 사용 안 함"
            : "T3 Connect 연결 해제됨",
        description: enabled
          ? "이 실행 환경을 T3 Connect에서 사용할 수 있습니다."
          : publishAgentActivity
            ? "관리형 터널을 제거했습니다. 에이전트 활동 공유는 계속됩니다."
            : "이 실행 환경은 더 이상 T3 Connect에서 사용할 수 없습니다.",
      });
    }
    setIsUpdating(false);
  };

  const updatePublishAgentActivity = async (enabled: boolean) => {
    setIsUpdatingPreference(true);
    const ok = await reconcileCloudState({ managedTunnel: managedTunnelActive, publish: enabled });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled ? "에이전트 활동 공유 켜짐" : "에이전트 활동 공유 꺼짐",
        description: enabled
          ? "이 실행 환경의 에이전트 활동을 모바일 클라이언트에 공유합니다."
          : "이 실행 환경의 에이전트 활동 공유를 중지합니다.",
      });
    }
    setIsUpdatingPreference(false);
  };

  return (
    <>
      <SettingsRow
        title="T3 Connect"
        description={
          managedTunnelActive
            ? "다른 기기에서 T3 Connect를 통해 이 실행 환경을 사용할 수 있습니다."
            : "다른 기기에서 T3 Connect를 통해 이 실행 환경을 사용할 수 있게 합니다."
        }
        status={
          operationError || primaryCloudLinkState.error
            ? "T3 Connect 작업을 완료하지 못했습니다."
            : null
        }
        control={
          <CloudLinkSwitch
            checked={managedTunnelActive}
            disabled={!canManageRelay || !isSignedIn || primaryCloudLinkState.isPending || isBusy}
            disabledReason={disabledReason}
            onCheckedChange={(enabled) => void updateManagedTunnel(enabled)}
          />
        }
      />
      <SettingsRow
        title="에이전트 활동 공유"
        description="이 실행 환경의 활동을 모바일 클라이언트로 보내 푸시 알림과 실시간 현황에 표시합니다. T3 Connect 터널 없이도 작동합니다."
        control={
          <CloudLinkSwitch
            ariaLabel="모바일 클라이언트에 에이전트 활동 공유"
            checked={publishAgentActivity}
            disabled={!canManageRelay || !isSignedIn || primaryCloudLinkState.isPending || isBusy}
            disabledReason={disabledReason}
            onCheckedChange={(enabled) => void updatePublishAgentActivity(enabled)}
          />
        }
      />
    </>
  );
}

function CloudLinkRow({ canManageRelay }: { readonly canManageRelay: boolean }) {
  return hasCloudPublicConfig() ? <ConfiguredCloudLinkRow canManageRelay={canManageRelay} /> : null;
}

function EmptyRemoteEnvironments({ cloudEnabled = true }: { readonly cloudEnabled?: boolean }) {
  return (
    <Empty className="min-h-52">
      <EmptyMedia variant="icon">
        <ChevronsLeftRightEllipsisIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>저장된 원격 실행 환경이 없습니다</EmptyTitle>
        <EmptyDescription>
          {cloudEnabled
            ? "‘실행 환경 추가’를 눌러 다른 실행 환경을 페어링하거나 T3 Connect에서 연결하세요."
            : "‘실행 환경 추가’를 눌러 다른 실행 환경을 페어링하세요."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function CloudRemoteEnvironmentRows({
  primaryEnvironmentId,
  savedEnvironments,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
}) {
  return hasCloudPublicConfig() ? (
    <CloudEnvironmentConnectRows
      primaryEnvironmentId={primaryEnvironmentId}
      savedEnvironments={savedEnvironments}
      empty={<EmptyRemoteEnvironments />}
    />
  ) : savedEnvironments.length === 0 ? (
    <EmptyRemoteEnvironments cloudEnabled={false} />
  ) : null;
}

export function ConnectionsSettings() {
  const desktopBridge = window.desktopBridge;
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const primarySessionState = usePrimarySessionState();
  const currentSessionScopes = desktopBridge
    ? AuthAdministrativeScopes
    : primarySessionState.data?.authenticated
      ? (primarySessionState.data.scopes ?? null)
      : null;
  const currentAuthPolicy = desktopBridge ? null : (primarySessionState.data?.auth.policy ?? null);
  const savedEnvironments = useMemo(
    () =>
      environments
        .filter((environment) => environment.entry.target._tag !== "PrimaryConnectionTarget")
        .toSorted((left, right) => left.label.localeCompare(right.label)),
    [environments],
  );
  const savedDesktopSshEnvironmentsByAlias = useMemo(
    () =>
      savedEnvironments.reduce<Record<string, EnvironmentPresentation>>(
        (accumulator, environment) => {
          const profile = environment.entry.profile;
          if (
            environment.entry.target._tag === "SshConnectionTarget" &&
            Option.isSome(profile) &&
            profile.value._tag === "SshConnectionProfile"
          ) {
            accumulator[profile.value.target.alias] = environment;
          }
          return accumulator;
        },
        {},
      ),
    [savedEnvironments],
  );
  const savedDesktopSshEnvironmentKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const environment of savedEnvironments) {
      const profile = environment.entry.profile;
      if (
        environment.entry.target._tag !== "SshConnectionTarget" ||
        Option.isNone(profile) ||
        profile.value._tag !== "SshConnectionProfile"
      ) {
        continue;
      }
      const target = profile.value.target;
      keys.add(target.alias);
      keys.add(formatDesktopSshTarget(target));
    }
    return keys;
  }, [savedEnvironments]);
  const [sshConnectionError, setSshConnectionError] = useState<string | null>(null);
  const [connectingSshHostAlias, setConnectingSshHostAlias] = useState<string | null>(null);

  const [desktopServerExposureMutationError, setDesktopServerExposureMutationError] = useState<
    string | null
  >(null);
  const [desktopAccessManagementMutationError, setDesktopAccessManagementMutationError] = useState<
    string | null
  >(null);
  const [revokingDesktopPairingLinkId, setRevokingDesktopPairingLinkId] = useState<string | null>(
    null,
  );
  const [revokingDesktopClientSessionId, setRevokingDesktopClientSessionId] = useState<
    string | null
  >(null);
  const [isRevokingOtherDesktopClients, setIsRevokingOtherDesktopClients] = useState(false);
  const [addBackendDialogOpen, setAddBackendDialogOpen] = useState(false);
  const [savedBackendMode, setSavedBackendMode] = useState<"remote" | "ssh">("remote");
  const [savedBackendHost, setSavedBackendHost] = useState("");
  const [savedBackendPairingCode, setSavedBackendPairingCode] = useState("");
  const [savedBackendSshHost, setSavedBackendSshHost] = useState("");
  const [savedBackendSshUsername, setSavedBackendSshUsername] = useState("");
  const [savedBackendSshPort, setSavedBackendSshPort] = useState("");
  const [savedBackendError, setSavedBackendError] = useState<string | null>(null);
  const [isAddingSavedBackend, setIsAddingSavedBackend] = useState(false);
  const [removingSavedEnvironmentId, setRemovingSavedEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const [isUpdatingDesktopServerExposure, setIsUpdatingDesktopServerExposure] = useState(false);
  const [isDesktopServerExposureDialogOpen, setIsDesktopServerExposureDialogOpen] = useState(false);
  const [isUpdatingTailscaleServe, setIsUpdatingTailscaleServe] = useState(false);
  const [isUpdatingWslBackend, setIsUpdatingWslBackend] = useState(false);
  const [desktopWslMutationError, setDesktopWslMutationError] = useState<string | null>(null);
  // Pending WSL setting change waiting on user confirmation. Set when
  // the user tries a destructive change (disable, switch distro,
  // toggle wsl-only) while the WSL backend has saved-env state on this
  // machine. Confirming applies the change; cancelling drops it
  // without touching the persisted setting. Null when nothing is
  // pending.
  type PendingWslChange =
    // wasWslOnly is true when the user picked Off while wsl-only mode
    // was active. In that case "disable" also clears wsl-only and
    // relaunches onto the Windows backend, because leaving wsl-only on
    // with wslBackendEnabled off is a meaningless state (wsl-only is
    // only honoured when the WSL backend is enabled).
    | { readonly kind: "disable"; readonly wasWslOnly: boolean }
    | { readonly kind: "distro"; readonly nextDistro: string | null }
    // Asked at enable time so the user picks the mode upfront instead
    // of being dropped into "both backends" and having to discover the
    // wsl-only switch separately. Resolved through enable-mode action
    // buttons on the dialog rather than a single Confirm.
    | { readonly kind: "enable"; readonly nextDistro: string | null }
    | { readonly kind: "wsl-only"; readonly nextValue: boolean };
  const [pendingWslChange, setPendingWslChange] = useState<PendingWslChange | null>(null);
  const isWslConfirmDialogOpen = pendingWslChange !== null;
  const [pendingTailscaleServeEndpoint, setPendingTailscaleServeEndpoint] =
    useState<AdvertisedEndpoint | null>(null);
  const [disableTailscaleServeDialogOpen, setDisableTailscaleServeDialogOpen] = useState(false);
  const [tailscaleServePortInput, setTailscaleServePortInput] = useState(
    String(DEFAULT_TAILSCALE_SERVE_PORT),
  );
  const [pendingDesktopServerExposureMode, setPendingDesktopServerExposureMode] = useState<
    DesktopServerExposureState["mode"] | null
  >(null);
  const primaryServerConfig = primaryEnvironment?.serverConfig ?? null;
  const primaryVersionMismatch = resolveServerConfigVersionMismatch(primaryServerConfig);
  const primaryServerUpdateState = useAtomValue(
    serverEnvironment.updateStateAtom(primaryEnvironmentId),
  );
  const [isAdvertisedEndpointListExpanded, setIsAdvertisedEndpointListExpanded] = useState(false);
  const defaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.defaultAdvertisedEndpointKey,
  );
  const setDefaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.setDefaultAdvertisedEndpointKey,
  );
  const canManageLocalBackend = currentSessionScopes?.includes(AuthAccessWriteScope) ?? false;
  const canManageRelay = currentSessionScopes?.includes(AuthRelayWriteScope) ?? false;
  const authAccessChanges = useEnvironmentQuery(
    canManageLocalBackend && primaryEnvironmentId !== null
      ? authEnvironment.accessChanges({
          environmentId: primaryEnvironmentId,
          input: null,
        })
      : null,
  );
  const desktopNetworkAccess = useEnvironmentQuery(
    canManageLocalBackend && desktopBridge ? desktopNetworkAccessStateAtom : null,
  );
  const desktopSshHosts = useEnvironmentQuery(
    desktopBridge && addBackendDialogOpen && savedBackendMode === "ssh"
      ? desktopSshHostsStateAtom
      : null,
  );
  const desktopWsl = useEnvironmentQuery(
    canManageLocalBackend && desktopBridge ? desktopWslStateAtom : null,
  );
  const desktopWslState = desktopWsl.data;
  const desktopWslError =
    desktopWslMutationError ?? (desktopWsl.error ? "WSL 백엔드 상태를 불러오지 못했습니다." : null);
  const isLoadingWslState = desktopWsl.isPending && desktopWsl.data === null;
  const discoveredSshHosts = desktopSshHosts.data ?? EMPTY_DISCOVERED_SSH_HOSTS;
  const unsavedDiscoveredSshHosts = useMemo(
    () =>
      discoveredSshHosts.filter((target) => {
        const address = formatDesktopSshTarget(target);
        return (
          !savedDesktopSshEnvironmentKeys.has(target.alias) &&
          !savedDesktopSshEnvironmentKeys.has(address)
        );
      }),
    [discoveredSshHosts, savedDesktopSshEnvironmentKeys],
  );
  const hasLoadedDiscoveredSshHosts =
    desktopSshHosts.data !== null || desktopSshHosts.error !== null;
  const isLoadingDiscoveredSshHosts = desktopSshHosts.isPending;
  const discoveredSshHostsError =
    sshConnectionError ?? (desktopSshHosts.error ? "SSH 호스트 목록을 불러오지 못했습니다." : null);
  const desktopServerExposureState = desktopNetworkAccess.data?.serverExposureState ?? null;
  const desktopAdvertisedEndpoints =
    desktopNetworkAccess.data?.advertisedEndpoints ?? EMPTY_ADVERTISED_ENDPOINTS;
  const desktopServerExposureError =
    desktopServerExposureMutationError ??
    (desktopNetworkAccess.error ? "네트워크 접근 상태를 불러오지 못했습니다." : null);
  const desktopAccessManagementError =
    desktopAccessManagementMutationError ??
    (authAccessChanges.error ? "승인된 클라이언트 목록을 불러오지 못했습니다." : null);
  const isLoadingDesktopAccessManagement =
    authAccessChanges.isPending && authAccessChanges.data === null;
  const desktopPairingLinks = useMemo(() => {
    const event = authAccessChanges.data;
    if (event?.type !== "snapshot") return [];
    return sortDesktopPairingLinks(
      event.payload.pairingLinks.map((pairingLink: AuthPairingLink) =>
        toDesktopPairingLinkRecord(pairingLink),
      ),
    );
  }, [authAccessChanges.data]);
  const desktopClientSessions = useMemo(() => {
    const event = authAccessChanges.data;
    if (event?.type !== "snapshot") return [];
    return sortDesktopClientSessions(
      event.payload.clientSessions.map((clientSession: AuthClientSession) =>
        toDesktopClientSessionRecord(clientSession),
      ),
    );
  }, [authAccessChanges.data]);
  const isLocalBackendNetworkAccessible = desktopBridge
    ? desktopServerExposureState?.mode === "network-accessible"
    : currentAuthPolicy === "remote-reachable";
  const trimmedTailscaleServePortInput = tailscaleServePortInput.trim();
  const parsedTailscaleServePort = Number(trimmedTailscaleServePortInput);
  const isTailscaleServePortValid =
    /^\d+$/u.test(trimmedTailscaleServePortInput) &&
    Number.isInteger(parsedTailscaleServePort) &&
    parsedTailscaleServePort >= 1 &&
    parsedTailscaleServePort <= 65_535;

  const pendingTailscaleServeBaseUrl = useMemo(() => {
    if (!pendingTailscaleServeEndpoint) return null;
    if (!isTailscaleServePortValid) return pendingTailscaleServeEndpoint.httpBaseUrl;
    if (parsedTailscaleServePort === DEFAULT_TAILSCALE_SERVE_PORT) {
      return pendingTailscaleServeEndpoint.httpBaseUrl;
    }
    try {
      const url = new URL(pendingTailscaleServeEndpoint.httpBaseUrl);
      url.port = String(parsedTailscaleServePort);
      return url.toString().replace(/\/$/u, "");
    } catch {
      return pendingTailscaleServeEndpoint.httpBaseUrl;
    }
  }, [isTailscaleServePortValid, parsedTailscaleServePort, pendingTailscaleServeEndpoint]);

  const handleDesktopServerExposureChange = useCallback(
    async (checked: boolean) => {
      if (!desktopBridge) return;
      setIsUpdatingDesktopServerExposure(true);
      setDesktopServerExposureMutationError(null);
      try {
        await desktopBridge.setServerExposureMode(checked ? "network-accessible" : "local-only");
        refreshDesktopNetworkAccessState();
        setIsDesktopServerExposureDialogOpen(false);
        setIsUpdatingDesktopServerExposure(false);
      } catch (error) {
        const message = "네트워크 접근 설정을 변경하지 못했습니다.";
        setIsDesktopServerExposureDialogOpen(false);
        setDesktopServerExposureMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "네트워크 접근을 변경하지 못했습니다",
            description: message,
          }),
        );
        setIsUpdatingDesktopServerExposure(false);
      }
    },
    [desktopBridge],
  );

  const handleConfirmDesktopServerExposureChange = useCallback(() => {
    if (pendingDesktopServerExposureMode === null) return;
    const checked = pendingDesktopServerExposureMode === "network-accessible";
    void handleDesktopServerExposureChange(checked);
  }, [handleDesktopServerExposureChange, pendingDesktopServerExposureMode]);

  const handleConfirmTailscaleServeSetup = useCallback(async () => {
    if (!desktopBridge) return;
    if (!isTailscaleServePortValid) return;
    setIsUpdatingTailscaleServe(true);
    setDesktopServerExposureMutationError(null);
    try {
      await desktopBridge.setTailscaleServeEnabled({
        enabled: true,
        port: parsedTailscaleServePort,
      });
      refreshDesktopNetworkAccessState();
      setPendingTailscaleServeEndpoint(null);
    } catch (error) {
      const message = "Tailscale HTTPS를 설정하지 못했습니다.";
      setDesktopServerExposureMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Tailscale HTTPS를 설정하지 못했습니다",
          description: message,
        }),
      );
    } finally {
      setIsUpdatingTailscaleServe(false);
    }
  }, [desktopBridge, isTailscaleServePortValid, parsedTailscaleServePort]);

  const handleStartTailscaleServeSetup = useCallback(
    (endpoint: AdvertisedEndpoint) => {
      setTailscaleServePortInput(
        String(desktopServerExposureState?.tailscaleServePort ?? DEFAULT_TAILSCALE_SERVE_PORT),
      );
      setPendingTailscaleServeEndpoint(endpoint);
    },
    [desktopServerExposureState?.tailscaleServePort],
  );

  const handleConfirmTailscaleServeDisable = useCallback(async () => {
    if (!desktopBridge) return;
    setIsUpdatingTailscaleServe(true);
    setDesktopServerExposureMutationError(null);
    try {
      await desktopBridge.setTailscaleServeEnabled({
        enabled: false,
        port: desktopServerExposureState?.tailscaleServePort ?? DEFAULT_TAILSCALE_SERVE_PORT,
      });
      refreshDesktopNetworkAccessState();
      setDisableTailscaleServeDialogOpen(false);
    } catch (error) {
      const message = "Tailscale HTTPS를 끄지 못했습니다.";
      setDesktopServerExposureMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Tailscale HTTPS를 끄지 못했습니다",
          description: message,
        }),
      );
    } finally {
      setIsUpdatingTailscaleServe(false);
    }
  }, [desktopBridge, desktopServerExposureState?.tailscaleServePort]);

  const handleStartTailscaleServeDisable = useCallback((_endpoint: AdvertisedEndpoint) => {
    setDisableTailscaleServeDialogOpen(true);
  }, []);

  const handleRevokeDesktopPairingLink = useCallback(async (id: string) => {
    setRevokingDesktopPairingLinkId(id);
    setDesktopAccessManagementMutationError(null);
    try {
      await revokeServerPairingLink(id);
    } catch (error) {
      const message = "페어링 링크를 취소하지 못했습니다.";
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "페어링 링크를 취소하지 못했습니다",
          description: message,
        }),
      );
    } finally {
      setRevokingDesktopPairingLinkId(null);
    }
  }, []);

  const handleRevokeDesktopClientSession = useCallback(
    async (sessionId: ServerClientSessionRecord["sessionId"]) => {
      setRevokingDesktopClientSessionId(sessionId);
      setDesktopAccessManagementMutationError(null);
      try {
        await revokeServerClientSession(sessionId);
      } catch (error) {
        const message = "클라이언트 접근 권한을 취소하지 못했습니다.";
        setDesktopAccessManagementMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "클라이언트 접근 권한을 취소하지 못했습니다",
            description: message,
          }),
        );
      } finally {
        setRevokingDesktopClientSessionId(null);
      }
    },
    [],
  );

  const handleRevokeOtherDesktopClients = useCallback(async () => {
    setIsRevokingOtherDesktopClients(true);
    setDesktopAccessManagementMutationError(null);
    try {
      const revokedCount = await revokeOtherServerClientSessions();
      toastManager.add({
        type: "success",
        title: `다른 클라이언트 ${revokedCount}개의 접근을 취소했습니다`,
        description: "해당 클라이언트가 다시 연결하려면 새 페어링 링크가 필요합니다.",
      });
    } catch (error) {
      const message = "다른 클라이언트의 접근 권한을 취소하지 못했습니다.";
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "다른 클라이언트의 접근 권한을 취소하지 못했습니다",
          description: message,
        }),
      );
    } finally {
      setIsRevokingOtherDesktopClients(false);
    }
  }, []);

  const handleAddSavedBackend = useCallback(async () => {
    if (savedBackendMode === "ssh") {
      setIsAddingSavedBackend(true);
      setSavedBackendError(null);
      let target: DesktopSshEnvironmentTarget;
      try {
        target = parseManualDesktopSshTarget({
          host: savedBackendSshHost,
          username: savedBackendSshUsername,
          port: savedBackendSshPort,
        });
      } catch (error) {
        setSavedBackendError(formatDesktopSshConnectionError(error));
        setIsAddingSavedBackend(false);
        return;
      }

      const result = await connectSshEnvironment({ target, label: "" });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          setSavedBackendError(formatDesktopSshConnectionError(squashAtomCommandFailure(result)));
        }
        setIsAddingSavedBackend(false);
        return;
      }

      setSavedBackendHost("");
      setSavedBackendPairingCode("");
      setSavedBackendSshHost("");
      setSavedBackendSshUsername("");
      setSavedBackendSshPort("");
      setAddBackendDialogOpen(false);
      toastManager.add({
        type: "success",
        title: "실행 환경 연결됨",
        description: `${target.alias}을(를) SSH 관리형 터널로 사용할 수 있습니다.`,
      });
      setIsAddingSavedBackend(false);
      return;
    }

    setIsAddingSavedBackend(true);
    setSavedBackendError(null);
    let remotePairingInput: ReturnType<typeof parseRemotePairingFields>;
    try {
      remotePairingInput = parseRemotePairingFields({
        host: savedBackendHost,
        pairingCode: savedBackendPairingCode,
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "";
      const message = /[가-힣]/.test(rawMessage) ? rawMessage : "백엔드를 추가하지 못했습니다.";
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "백엔드를 추가하지 못했습니다",
          description: message,
        }),
      );
      setIsAddingSavedBackend(false);
      return;
    }

    const result = await connectPairing(remotePairingInput);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const message = "백엔드를 추가하지 못했습니다. 호스트와 페어링 코드를 확인해 주세요.";
        setSavedBackendError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "백엔드를 추가하지 못했습니다",
            description: message,
          }),
        );
      }
      setIsAddingSavedBackend(false);
      return;
    }

    setSavedBackendHost("");
    setSavedBackendPairingCode("");
    setSavedBackendSshHost("");
    setSavedBackendSshUsername("");
    setSavedBackendSshPort("");
    setAddBackendDialogOpen(false);
    toastManager.add({
      type: "success",
      title: "백엔드 추가됨",
      description: "실행 환경을 저장했으며 앱을 시작할 때 자동으로 다시 연결합니다.",
    });
    setIsAddingSavedBackend(false);
  }, [
    connectPairing,
    connectSshEnvironment,
    savedBackendHost,
    savedBackendMode,
    savedBackendPairingCode,
    savedBackendSshHost,
    savedBackendSshPort,
    savedBackendSshUsername,
  ]);

  const handleConnectSavedBackend = useCallback(
    async (environmentId: EnvironmentId) => {
      setSavedBackendError(null);
      const result = await retryEnvironment(environmentId);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const message = "백엔드에 연결하지 못했습니다. 연결 설정을 확인해 주세요.";
        setSavedBackendError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "백엔드에 연결하지 못했습니다",
            description: message,
          }),
        );
      }
    },
    [retryEnvironment],
  );

  const handleRemoveSavedBackend = useCallback(
    async (environmentId: EnvironmentId) => {
      setRemovingSavedEnvironmentId(environmentId);
      setSavedBackendError(null);
      const result = await removeEnvironment(environmentId);
      setRemovingSavedEnvironmentId(null);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const message = "백엔드를 제거하지 못했습니다.";
        setSavedBackendError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "백엔드를 제거하지 못했습니다",
            description: message,
          }),
        );
      }
    },
    [removeEnvironment],
  );

  const handleConnectSshHost = useCallback(
    async (target: DesktopSshEnvironmentTarget, label?: string) => {
      setConnectingSshHostAlias(target.alias);
      if (savedBackendMode === "ssh") {
        setSavedBackendError(null);
      } else {
        setSshConnectionError(null);
      }
      const result = await connectSshEnvironment({
        target,
        ...(label === undefined ? {} : { label }),
      });
      setConnectingSshHostAlias(null);
      if (result._tag === "Success") {
        setSavedBackendSshHost("");
        setSavedBackendSshUsername("");
        setSavedBackendSshPort("");
        setAddBackendDialogOpen(false);
        toastManager.add({
          type: "success",
          title: savedDesktopSshEnvironmentsByAlias[target.alias]
            ? "실행 환경 다시 연결됨"
            : "실행 환경 연결됨",
          description: `${label?.trim() || target.alias}을(를) SSH 관리형 터널로 사용할 수 있습니다.`,
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const message = formatDesktopSshConnectionError(error);
        if (savedBackendMode === "ssh") {
          setSavedBackendError(message);
        } else {
          setSshConnectionError(message);
        }
      }
    },
    [connectSshEnvironment, savedBackendMode, savedDesktopSshEnvironmentsByAlias],
  );

  const visibleDesktopPairingLinks = desktopPairingLinks;
  const tailscaleHttpsEndpoint = useMemo(
    () => desktopAdvertisedEndpoints.find(isTailscaleHttpsEndpoint) ?? null,
    [desktopAdvertisedEndpoints],
  );
  const visibleDesktopNetworkAdvertisedEndpoints = useMemo(
    () =>
      isLocalBackendNetworkAccessible
        ? desktopAdvertisedEndpoints.filter((endpoint) => !isTailscaleHttpsEndpoint(endpoint))
        : [],
    [desktopAdvertisedEndpoints, isLocalBackendNetworkAccessible],
  );
  const visibleDesktopAdvertisedEndpoints = useMemo(
    () =>
      tailscaleHttpsEndpoint
        ? [...visibleDesktopNetworkAdvertisedEndpoints, tailscaleHttpsEndpoint]
        : visibleDesktopNetworkAdvertisedEndpoints,
    [tailscaleHttpsEndpoint, visibleDesktopNetworkAdvertisedEndpoints],
  );
  const isLocalBackendRemotelyReachable =
    isLocalBackendNetworkAccessible || tailscaleHttpsEndpoint?.status === "available";
  const defaultDesktopNetworkAdvertisedEndpoint = useMemo(
    () =>
      selectPairingEndpoint(visibleDesktopNetworkAdvertisedEndpoints, defaultAdvertisedEndpointKey),
    [defaultAdvertisedEndpointKey, visibleDesktopNetworkAdvertisedEndpoints],
  );
  const defaultDesktopAdvertisedEndpoint = useMemo(
    () =>
      defaultDesktopNetworkAdvertisedEndpoint ??
      selectPairingEndpoint(
        tailscaleHttpsEndpoint ? [tailscaleHttpsEndpoint] : [],
        defaultAdvertisedEndpointKey,
      ),
    [defaultAdvertisedEndpointKey, defaultDesktopNetworkAdvertisedEndpoint, tailscaleHttpsEndpoint],
  );
  const defaultDesktopAdvertisedEndpointKey = defaultDesktopAdvertisedEndpoint
    ? endpointDefaultPreferenceKey(defaultDesktopAdvertisedEndpoint)
    : null;
  const handleSetDefaultAdvertisedEndpoint = useCallback(
    (endpoint: AdvertisedEndpoint) => {
      setDefaultAdvertisedEndpointKey(endpointDefaultPreferenceKey(endpoint));
    },
    [setDefaultAdvertisedEndpointKey],
  );
  const handleSavedBackendHostChange = useCallback((value: string) => {
    const parsedPairingUrl = parsePairingUrlFields(value);
    if (parsedPairingUrl) {
      setSavedBackendHost(parsedPairingUrl.host);
      setSavedBackendPairingCode(parsedPairingUrl.pairingCode);
      return;
    }
    setSavedBackendHost(value);
  }, []);

  const renderConnectionModeCard = (input: {
    readonly mode: "remote" | "ssh";
    readonly title: string;
    readonly description: string;
    readonly icon?: ReactNode;
  }) => {
    const selected = savedBackendMode === input.mode;
    return (
      <button
        type="button"
        aria-pressed={selected}
        className={cn(
          "group flex min-h-24 items-start gap-3 rounded-lg border p-4 text-left",
          selected ? "border-primary/50 bg-primary/5" : "border-border/60 hover:bg-muted/40",
        )}
        disabled={isAddingSavedBackend}
        onClick={() => {
          setSavedBackendMode(input.mode);
        }}
      >
        {input.icon ? (
          <span
            className={cn(
              "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
              selected
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-border/70 bg-background text-muted-foreground group-hover:text-foreground",
            )}
          >
            {input.icon}
          </span>
        ) : null}
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{input.title}</span>
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {input.description}
          </span>
        </span>
      </button>
    );
  };

  const renderRemoteFields = () => (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">호스트</span>
          <Input
            value={savedBackendHost}
            onChange={(event) => handleSavedBackendHostChange(event.target.value)}
            placeholder="backend.example.com"
            disabled={isAddingSavedBackend}
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">페어링 코드</span>
          <Input
            value={savedBackendPairingCode}
            onChange={(event) => setSavedBackendPairingCode(event.target.value)}
            placeholder="PAIRCODE"
            disabled={isAddingSavedBackend}
            spellCheck={false}
          />
        </label>
      </div>
      <div>
        <span className="mt-1 block text-[11px] text-muted-foreground">
          전체 페어링 URL을 붙여 넣으면 두 입력란이 자동으로 채워집니다.
        </span>
      </div>
    </div>
  );
  const renderRemoteModeBody = () => (
    <div className="space-y-4">
      {renderRemoteFields()}
      {savedBackendError ? <p className="text-xs text-destructive">{savedBackendError}</p> : null}
      <Button
        variant="outline"
        className="w-full"
        disabled={isAddingSavedBackend}
        onClick={() => void handleAddSavedBackend()}
      >
        <PlusIcon className="size-3.5" />
        {isAddingSavedBackend ? "추가 중…" : "실행 환경 추가"}
      </Button>
    </div>
  );
  const renderSshFields = () => (
    <div className="space-y-4">
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            SSH 호스트 또는 별칭
          </span>
          <Input
            value={savedBackendSshHost}
            onChange={(event) => setSavedBackendSshHost(event.target.value)}
            placeholder="호스트 검색 또는 devbox 입력"
            disabled={isAddingSavedBackend}
            spellCheck={false}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">사용자 이름</span>
            <Input
              value={savedBackendSshUsername}
              onChange={(event) => setSavedBackendSshUsername(event.target.value)}
              placeholder="root"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">포트</span>
            <Input
              value={savedBackendSshPort}
              onChange={(event) => setSavedBackendSshPort(event.target.value)}
              placeholder="22"
              inputMode="numeric"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
          </label>
        </div>
        {savedBackendError || discoveredSshHostsError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {savedBackendError ?? discoveredSshHostsError}
          </div>
        ) : null}
        <Button
          variant="outline"
          className="w-full"
          disabled={isAddingSavedBackend}
          onClick={() => void handleAddSavedBackend()}
        >
          <PlusIcon className="size-3.5" />
          {isAddingSavedBackend ? "추가 중…" : "실행 환경 추가"}
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border/60">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/30 px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">추천 호스트</p>
            <p className="text-[11px] text-muted-foreground">SSH 설정 및 알려진 호스트에서 검색</p>
          </div>
          <Button
            size="xs"
            variant="ghost"
            disabled={isLoadingDiscoveredSshHosts}
            onClick={desktopSshHosts.refresh}
          >
            {isLoadingDiscoveredSshHosts ? (
              <RefreshCwIcon className="size-3 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3" />
            )}
            새로 고침
          </Button>
        </div>
        <ScrollArea scrollFade className="max-h-56">
          <div>
            {unsavedDiscoveredSshHosts.map((target) => (
              <DesktopSshHostRow
                key={`${target.alias}:${target.hostname}:${target.port ?? ""}`}
                target={target}
                connectingHostAlias={connectingSshHostAlias}
                onConnect={(nextTarget) => void handleConnectSshHost(nextTarget)}
              />
            ))}
            {hasLoadedDiscoveredSshHosts &&
            !isLoadingDiscoveredSshHosts &&
            unsavedDiscoveredSshHosts.length === 0 ? (
              <div className={ITEM_ROW_CLASSNAME}>
                <p className="text-xs text-muted-foreground">
                  새로운 SSH 호스트를 찾지 못했습니다.
                </p>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
  const renderNetworkAccessToggle = () => (
    <Switch
      checked={desktopServerExposureState?.mode === "network-accessible"}
      disabled={!desktopServerExposureState || isUpdatingDesktopServerExposure}
      onCheckedChange={(checked) => {
        setPendingDesktopServerExposureMode(checked ? "network-accessible" : "local-only");
        setIsDesktopServerExposureDialogOpen(true);
      }}
      aria-label="네트워크 접근 사용"
    />
  );
  const renderEndpointRows = (presentation: AccessSectionPresentation) =>
    isAdvertisedEndpointListExpanded
      ? visibleDesktopNetworkAdvertisedEndpoints.map((endpoint) => {
          const endpointKey = endpointDefaultPreferenceKey(endpoint);
          return (
            <AdvertisedEndpointListRow
              key={endpoint.id}
              endpoint={endpoint}
              isDefault={endpointKey === defaultDesktopAdvertisedEndpointKey}
              presentation={presentation}
              onSetDefault={handleSetDefaultAdvertisedEndpoint}
              onSetupTailscaleServe={handleStartTailscaleServeSetup}
              onDisableTailscaleServe={handleStartTailscaleServeDisable}
              isUpdatingTailscaleServe={isUpdatingTailscaleServe}
            />
          );
        })
      : null;
  // Apply a setting change immediately. The orchestrator reconciles the
  // pool in the background and the primary backend is untouched, so we
  // don't gate this behind a confirmation dialog. After the desktop
  // side persists the change and nudges its orchestrator, we trigger
  // the renderer's reconciler so the WSL backend's saved-env-shaped
  // entry catches up (registers/unregisters) without a reload.
  const applyWslSettingChange = useCallback(
    async (apply: () => Promise<DesktopWslState>) => {
      if (!desktopBridge) return;
      setIsUpdatingWslBackend(true);
      setDesktopWslMutationError(null);
      try {
        await apply();
        refreshDesktopWslState();
        // The connection platform source polls the desktop bootstrap list and
        // reconciles the environment catalog automatically, so toggling the WSL
        // backend on/off or switching distros is picked up here without an
        // explicit renderer reconcile.
      } catch (error) {
        const message = "WSL 백엔드 설정을 변경하지 못했습니다.";
        setDesktopWslMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "WSL 백엔드 설정을 변경하지 못했습니다",
            description: message,
          }),
        );
        refreshDesktopWslState();
      } finally {
        setIsUpdatingWslBackend(false);
      }
    },
    [desktopBridge],
  );

  // Reload the keep-alive WSL state atom. Clearing the mutation error before
  // refresh lets the atom-owned load error become the visible retry state.
  const loadWslState = useCallback(() => {
    setDesktopWslMutationError(null);
    refreshDesktopWslState();
  }, []);

  // True when a desktop-local WSL backend is currently registered as an
  // environment on this machine. We use this as a proxy for "the user has work
  // that lives on the WSL side": if WSL has connected in a way that registered
  // the env, disabling or switching distros could disrupt open threads/projects.
  // If WSL never connected (fresh install, toggled on then immediately off,
  // etc.) there's no local environment, so we skip the confirmation dialog.
  const hasWslRegistrationToLose = useMemo(() => {
    return environments.some((environment) =>
      isDesktopLocalConnectionTarget(environment.entry.target),
    );
  }, [environments]);

  // Single picker for "WSL backend off" vs "running on distro X". The
  // dropdown maps "Off" to disable and any distro entry to enable +
  // run on that distro. Splitting these into a separate switch and
  // dropdown was confusing — they're the same decision.
  const handleSelectWslMode = useCallback(
    (value: string) => {
      if (!desktopBridge || !desktopWslState) return;
      const defaultDistroName =
        desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null;
      if (value === BACKEND_VALUE_WSL_OFF) {
        // Match the recovery row's visibility (`enabled || wslOnly`): when WSL
        // went unavailable while wsl-only was persisted, `enabled` can be false
        // while `wslOnly` is true, and the "Switch to Windows" button must
        // still clear that state instead of silently no-op'ing.
        if (!desktopWslState.enabled && !desktopWslState.wslOnly) return;
        const wasWslOnly = desktopWslState.wslOnly;
        // Confirm when there's WSL state to lose, OR when wsl-only is
        // on (turning the only running backend off needs to switch
        // back to Windows and restart — always consequential).
        if (hasWslRegistrationToLose || wasWslOnly) {
          setPendingWslChange({ kind: "disable", wasWslOnly });
          return;
        }
        void applyWslSettingChange(() => desktopBridge.setWslBackendEnabled(false));
        return;
      }
      const nextDistro = value === BACKEND_VALUE_DEFAULT_WSL ? null : value;
      const resolvedNext = nextDistro ?? defaultDistroName;
      if (!desktopWslState.enabled) {
        // Was off, user picked a distro: ask whether to run both
        // backends or only WSL. We always ask here so the user picks
        // the mode upfront instead of having to discover the wsl-only
        // switch afterwards.
        setPendingWslChange({ kind: "enable", nextDistro });
        return;
      }
      // Already enabled — treat as a distro switch. Skip the change if
      // the user re-picked the row that's already selected.
      const resolvedCurrent = desktopWslState.distro ?? defaultDistroName;
      if (resolvedCurrent === resolvedNext) return;
      // Confirm when there's WSL registration to lose, OR in wsl-only mode:
      // there the primary IS the WSL backend, so a distro change relaunches
      // the app (the IPC handler does this) rather than swapping a secondary,
      // and the user should see that coming.
      if (hasWslRegistrationToLose || desktopWslState.wslOnly) {
        setPendingWslChange({ kind: "distro", nextDistro });
        return;
      }
      void applyWslSettingChange(() => desktopBridge.setWslDistro(nextDistro));
    },
    [applyWslSettingChange, desktopBridge, desktopWslState, hasWslRegistrationToLose],
  );

  // Dispatched from the enable modal's two action buttons.
  const handleConfirmEnableWsl = useCallback(
    (mode: "both" | "wsl-only") => {
      if (!desktopBridge || !pendingWslChange || pendingWslChange.kind !== "enable") return;
      const nextDistro = pendingWslChange.nextDistro;
      setPendingWslChange(null);
      const persistedDistro = desktopWslState?.distro ?? null;
      void applyWslSettingChange(() =>
        applyWslEnableSelection({
          bridge: desktopBridge,
          mode,
          nextDistro,
          persistedDistro,
        }),
      );
    },
    [applyWslSettingChange, desktopBridge, desktopWslState, pendingWslChange],
  );

  const handleToggleWslOnly = useCallback(
    (enabled: boolean) => {
      if (!desktopBridge || !desktopWslState || desktopWslState.wslOnly === enabled) return;
      // wsl-only changes which backend the pool uses as "primary",
      // which is decided once at app launch. The desktop side persists
      // the setting immediately but doesn't tear down or restart
      // anything itself; the renderer warns the user to expect a
      // restart and (in a follow-up) can trigger it automatically.
      // Always prompt — even enabling is consequential here.
      setPendingWslChange({ kind: "wsl-only", nextValue: enabled });
    },
    [desktopBridge, desktopWslState],
  );

  const handleConfirmWslChange = useCallback(() => {
    if (!desktopBridge || !pendingWslChange) return;
    const change = pendingWslChange;
    // The enable kind resolves through handleConfirmEnableWsl, not
    // this single Confirm path.
    if (change.kind === "enable") return;
    setPendingWslChange(null);
    if (change.kind === "disable") {
      void applyWslSettingChange(async () => {
        const next = await desktopBridge.setWslBackendEnabled(false);
        if (change.wasWslOnly) {
          // Clearing wsl-only relaunches onto the Windows backend.
          return await desktopBridge.setWslOnly(false);
        }
        return next;
      });
      return;
    }
    if (change.kind === "distro") {
      void applyWslSettingChange(() => desktopBridge.setWslDistro(change.nextDistro));
      return;
    }
    void applyWslSettingChange(() => desktopBridge.setWslOnly(change.nextValue));
  }, [applyWslSettingChange, desktopBridge, pendingWslChange]);

  const renderWslRow = () => {
    if (!desktopWslState) {
      // A load failed: keep a recovery row (with retry) visible instead of
      // silently hiding the section. The error persists across an in-flight
      // retry so the row doesn't flicker away, and the button reflects the
      // loading state. With no error we simply haven't loaded yet (or WSL
      // management isn't available), so render nothing.
      if (desktopWslError && canManageLocalBackend) {
        return (
          <SettingsRow
            title="WSL 백엔드"
            description="WSL 백엔드 상태를 불러오지 못했습니다."
            status={<span className="block text-destructive">{desktopWslError}</span>}
            control={
              <Button
                size="xs"
                variant="outline"
                onClick={loadWslState}
                disabled={isLoadingWslState}
              >
                {isLoadingWslState ? "다시 시도 중…" : "다시 시도"}
              </Button>
            }
          />
        );
      }
      return null;
    }
    // WSL went unavailable while the user still has the WSL backend persisted
    // (it may have been uninstalled or its distro removed). The desktop side
    // falls back to the Windows backend, but the normal distro picker needs a
    // live distro list it no longer has. Without a control here the user would
    // be stranded on a WSL preference they can't clear, so render a recovery
    // row that switches back to Windows. When WSL is unavailable AND unused,
    // there's nothing to recover — keep the section hidden as before.
    if (!desktopWslState.available) {
      if (!desktopWslState.enabled && !desktopWslState.wslOnly) return null;
      return (
        <SettingsRow
          title="WSL 백엔드"
          description="WSL을 더 이상 사용할 수 없어 Windows 백엔드로 실행 중입니다. 이 설정을 지우려면 WSL 백엔드를 꺼 주세요."
          status={
            desktopWslError ? (
              <span className="block text-destructive">{desktopWslError}</span>
            ) : null
          }
          control={
            <Button
              variant="outline"
              disabled={isUpdatingWslBackend}
              onClick={() => handleSelectWslMode(BACKEND_VALUE_WSL_OFF)}
            >
              Windows로 전환
            </Button>
          }
        />
      );
    }
    // Distro is null when the user wants the WSL default. Map it to the
    // real default's name so the Select highlights a real option; fall
    // back to the sentinel only when no distros are listed yet (the
    // dropdown then renders a single placeholder that matches).
    const defaultDistroName =
      desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null;
    const selectValue = !desktopWslState.enabled
      ? BACKEND_VALUE_WSL_OFF
      : (desktopWslState.distro ?? defaultDistroName ?? BACKEND_VALUE_DEFAULT_WSL);
    const selectLabel =
      selectValue === BACKEND_VALUE_WSL_OFF
        ? "사용 안 함"
        : selectValue === BACKEND_VALUE_DEFAULT_WSL
          ? "기본 배포판"
          : selectValue;
    return (
      <>
        <SettingsRow
          title="WSL 백엔드"
          description="Windows 백엔드와 함께 WSL 배포판 안에서 두 번째 백엔드를 실행합니다. 시작할 배포판을 선택하고, 중지하려면 사용 안 함을 선택하세요. WSL에서 연 프로젝트는 Linux 쪽에, Windows 프로젝트는 기존 위치에 유지됩니다."
          status={
            desktopWslError ? (
              <span className="block text-destructive">{desktopWslError}</span>
            ) : desktopWslState.preflightError ? (
              <span className="block text-destructive">
                WSL 백엔드를 시작하지 못했습니다. WSL 설치와 배포판 상태를 확인하세요.
              </span>
            ) : null
          }
          control={
            <Select
              value={selectValue}
              onValueChange={(value) => {
                if (typeof value !== "string") return;
                handleSelectWslMode(value);
              }}
            >
              <SelectTrigger
                className="w-full sm:w-56"
                aria-label="WSL 백엔드"
                disabled={isUpdatingWslBackend}
              >
                <SelectValue>{selectLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={BACKEND_VALUE_WSL_OFF}>
                  사용 안 함
                </SelectItem>
                {desktopWslState.distros.length === 0 ? (
                  <SelectItem hideIndicator value={BACKEND_VALUE_DEFAULT_WSL}>
                    기본 배포판
                  </SelectItem>
                ) : (
                  desktopWslState.distros.map((distro) => (
                    <SelectItem hideIndicator key={distro.name} value={distro.name}>
                      {distro.name}
                      {distro.isDefault ? " (기본값)" : ""}
                    </SelectItem>
                  ))
                )}
              </SelectPopup>
            </Select>
          }
        />
        {desktopWslState.enabled ? (
          <SettingsRow
            title="WSL만 사용"
            description="Windows 백엔드를 중지하고 WSL 백엔드만 실행합니다. 모든 개발을 WSL 안에서 하고 두 번째 백엔드 프로세스가 필요하지 않을 때 유용합니다. 이 설정을 바꾸면 T3 Code가 다시 시작됩니다."
            className="bg-muted/20 pl-7 sm:pl-8"
            control={
              <Switch
                checked={desktopWslState.wslOnly}
                disabled={isUpdatingWslBackend}
                onCheckedChange={(checked) => handleToggleWslOnly(checked)}
                aria-label="WSL만 사용"
              />
            }
          />
        ) : null}
      </>
    );
  };

  const renderTailscaleRow = () => (
    <SettingsRow
      title="Tailscale HTTPS"
      description={
        tailscaleHttpsEndpoint
          ? tailscaleHttpsEndpoint.status === "available"
            ? tailscaleHttpsEndpoint.httpBaseUrl
            : "Tailscale Serve로 MagicDNS HTTPS URL을 통해 이 백엔드에 접근할 수 있게 합니다."
          : "MagicDNS를 통한 HTTPS 접근을 설정하려면 Tailscale을 시작하세요."
      }
      control={
        tailscaleHttpsEndpoint ? (
          <Switch
            checked={tailscaleHttpsEndpoint.status === "available"}
            disabled={isUpdatingTailscaleServe}
            onCheckedChange={(checked) => {
              if (checked) {
                handleStartTailscaleServeSetup(tailscaleHttpsEndpoint);
                return;
              }
              handleStartTailscaleServeDisable(tailscaleHttpsEndpoint);
            }}
            aria-label="Tailscale HTTPS 사용"
          />
        ) : null
      }
    />
  );
  const renderAuthorizedClients = (presentation: AccessSectionPresentation) => (
    <>
      {desktopAccessManagementError ? (
        <div className={accessRowClassName(presentation)}>
          <p className="text-xs text-destructive">{desktopAccessManagementError}</p>
        </div>
      ) : null}
      <PairingClientsList
        endpointUrl={desktopServerExposureState?.endpointUrl}
        endpoints={visibleDesktopAdvertisedEndpoints}
        defaultEndpointKey={defaultDesktopAdvertisedEndpointKey}
        presentation={presentation}
        isLoading={isLoadingDesktopAccessManagement}
        pairingLinks={visibleDesktopPairingLinks}
        clientSessions={desktopClientSessions}
        revokingPairingLinkId={revokingDesktopPairingLinkId}
        revokingClientSessionId={revokingDesktopClientSessionId}
        onRevokePairingLink={handleRevokeDesktopPairingLink}
        onRevokeClientSession={handleRevokeDesktopClientSession}
      />
    </>
  );
  const renderNetworkAccessRow = () => (
    <SettingsRow
      title="네트워크 접근"
      description={
        isLocalBackendNetworkAccessible ? (
          <NetworkAccessDescription
            endpoint={defaultDesktopNetworkAdvertisedEndpoint}
            hiddenEndpointCount={Math.max(visibleDesktopNetworkAdvertisedEndpoints.length - 1, 0)}
            expanded={isAdvertisedEndpointListExpanded}
            onToggleExpanded={() => setIsAdvertisedEndpointListExpanded((expanded) => !expanded)}
            fallback={
              desktopServerExposureState?.endpointUrl
                ? `연결 주소: ${desktopServerExposureState.endpointUrl}`
                : desktopServerExposureState?.advertisedHost
                  ? `모든 네트워크 인터페이스에 공개됩니다. 페어링 링크는 ${desktopServerExposureState.advertisedHost}을(를) 사용합니다.`
                  : "모든 네트워크 인터페이스에 공개됩니다."
            }
          />
        ) : desktopServerExposureState ? (
          "이 컴퓨터에서만 접근할 수 있습니다."
        ) : (
          "불러오는 중…"
        )
      }
      status={
        desktopServerExposureError ? (
          <span className="block text-destructive">{desktopServerExposureError}</span>
        ) : null
      }
      control={renderNetworkAccessToggle()}
    />
  );
  const renderDisabledNetworkAccessRow = () => (
    <SettingsRow
      title="네트워크 접근"
      description={
        currentAuthPolicy === "remote-reachable"
          ? "이 백엔드는 이미 원격 접근이 설정되어 있습니다. 네트워크 공개 설정은 서버를 실행한 곳에서 변경해야 합니다."
          : "이 백엔드는 현재 이 컴퓨터에서만 접근할 수 있습니다. 원격 페어링을 사용하려면 루프백이 아닌 호스트로 다시 시작하세요."
      }
      control={
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Switch
                  checked={isLocalBackendNetworkAccessible}
                  disabled
                  aria-label="네트워크 접근 사용"
                />
              </span>
            }
          />
          <TooltipPopup side="top">
            네트워크 공개 설정을 바꾸면 백엔드가 다시 시작됩니다. 서버 프로세스를 실행한 곳에서
            변경해야 합니다.
          </TooltipPopup>
        </Tooltip>
      }
    />
  );

  return (
    <SettingsPageContainer>
      {canManageLocalBackend ? (
        <>
          <SettingsSection title="이 실행 환경">
            {primaryVersionMismatch || primaryServerUpdateState.status !== "idle" ? (
              <SettingsRow
                title={
                  primaryServerUpdateState.status === "failed"
                    ? "업데이트 실패"
                    : primaryServerUpdateState.status === "running"
                      ? "서버 업데이트 중"
                      : "서버 업데이트 사용 가능"
                }
                description={
                  primaryServerUpdateState.status !== "idle" ? (
                    <ServerUpdateProgress state={primaryServerUpdateState} />
                  ) : primaryVersionMismatch ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button type="button" className="w-fit cursor-help rounded-sm text-left">
                            이 클라이언트 버전에 맞춰 업데이트합니다.
                          </button>
                        }
                      />
                      <TooltipPopup side="top">
                        {primaryVersionMismatch.serverVersion} <span aria-hidden="true">→</span>{" "}
                        {primaryVersionMismatch.clientVersion}
                      </TooltipPopup>
                    </Tooltip>
                  ) : null
                }
                control={
                  primaryVersionMismatch &&
                  primaryEnvironmentId !== null &&
                  primaryServerUpdateState.status !== "running" ? (
                    <ServerUpdateAction
                      environmentId={primaryEnvironmentId}
                      serverLabel={primaryEnvironment?.label ?? "이 서버"}
                      selfUpdate={resolveServerSelfUpdateCapability(primaryServerConfig)}
                      targetVersion={primaryVersionMismatch.clientVersion}
                      label={
                        primaryServerUpdateState.status === "failed" ? "다시 시도" : "업데이트"
                      }
                    />
                  ) : undefined
                }
              />
            ) : null}
            {desktopBridge ? (
              <>
                {renderNetworkAccessRow()}
                {renderEndpointRows("endpoint-rail")}
                {renderTailscaleRow()}
                {renderWslRow()}
                <CloudLinkRow canManageRelay={canManageRelay} />
              </>
            ) : (
              <>
                {renderDisabledNetworkAccessRow()}
                <CloudLinkRow canManageRelay={canManageRelay} />
              </>
            )}
          </SettingsSection>

          {isLocalBackendRemotelyReachable ? (
            <SettingsSection
              title="승인된 클라이언트"
              headerAction={
                <AuthorizedClientsHeaderAction
                  clientSessions={desktopClientSessions}
                  isRevokingOtherClients={isRevokingOtherDesktopClients}
                  onRevokeOtherClients={handleRevokeOtherDesktopClients}
                />
              }
            >
              <ScrollArea
                scrollFade
                className="max-h-[22.5rem]"
                data-testid="authorized-clients-scroll-area"
              >
                {renderAuthorizedClients("current")}
              </ScrollArea>
            </SettingsSection>
          ) : null}
          <AlertDialog
            open={isDesktopServerExposureDialogOpen}
            onOpenChange={(open) => {
              if (isUpdatingDesktopServerExposure) return;
              setIsDesktopServerExposureDialogOpen(open);
            }}
            onOpenChangeComplete={(open) => {
              if (!open) setPendingDesktopServerExposureMode(null);
            }}
          >
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pendingDesktopServerExposureMode === "network-accessible"
                    ? "네트워크 접근을 사용할까요?"
                    : "네트워크 접근을 끌까요?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingDesktopServerExposureMode === "network-accessible"
                    ? "이 실행 환경을 네트워크에 공개하기 위해 T3 Code가 다시 시작됩니다."
                    : "이 실행 환경을 다시 이 컴퓨터에서만 접근할 수 있게 하며 T3 Code가 다시 시작됩니다."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingDesktopServerExposure}
                  render={<Button variant="outline" disabled={isUpdatingDesktopServerExposure} />}
                >
                  취소
                </AlertDialogClose>
                <Button
                  variant={
                    pendingDesktopServerExposureMode === "local-only" ? "destructive" : "default"
                  }
                  onClick={handleConfirmDesktopServerExposureChange}
                  disabled={
                    pendingDesktopServerExposureMode === null || isUpdatingDesktopServerExposure
                  }
                >
                  {isUpdatingDesktopServerExposure ? (
                    <>
                      <Spinner className="size-3.5" />
                      다시 시작 중…
                    </>
                  ) : pendingDesktopServerExposureMode === "network-accessible" ? (
                    "다시 시작하고 사용"
                  ) : (
                    "다시 시작하고 끄기"
                  )}
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
          <AlertDialog
            open={isWslConfirmDialogOpen}
            onOpenChange={(open) => {
              if (isUpdatingWslBackend) return;
              if (!open) setPendingWslChange(null);
            }}
          >
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pendingWslChange?.kind === "disable"
                    ? pendingWslChange.wasWslOnly
                      ? "WSL을 끄고 Windows로 돌아갈까요?"
                      : "WSL 백엔드를 끌까요?"
                    : pendingWslChange?.kind === "distro"
                      ? "WSL 배포판을 전환할까요?"
                      : pendingWslChange?.kind === "enable"
                        ? "WSL 백엔드 시작"
                        : pendingWslChange?.nextValue
                          ? "WSL 백엔드만 실행할까요?"
                          : "Windows 백엔드를 다시 사용할까요?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingWslChange?.kind === "disable"
                    ? pendingWslChange.wasWslOnly
                      ? "T3 Code가 Windows 백엔드로 다시 시작됩니다. WSL에서 연 대화와 프로젝트는 배포판 안에 안전하게 유지되며 WSL을 다시 켜면 사용할 수 있습니다."
                      : "WSL 백엔드가 중지됩니다. WSL에서 연 대화와 프로젝트는 배포판 안에 안전하게 유지되지만 WSL을 다시 켤 때까지 T3 Code에서 사용할 수 없습니다."
                    : pendingWslChange?.kind === "distro"
                      ? "새 배포판에서 WSL 백엔드를 다시 시작합니다. 현재 배포판에서 실행 중인 세션은 중단됩니다."
                      : pendingWslChange?.kind === "enable"
                        ? "Windows 백엔드와 WSL 백엔드를 함께 실행하거나 Windows 백엔드를 중지하고 WSL만 사용할 수 있습니다. 나중에 설정에서 변경할 수 있습니다."
                        : pendingWslChange?.nextValue
                          ? "T3 Code가 다시 시작되고 WSL 백엔드만 실행됩니다. 이 설정을 다시 끌 때까지 Windows 쪽 프로젝트에 접근할 수 없습니다."
                          : "T3 Code가 다시 시작되고 WSL과 함께 Windows 백엔드도 실행됩니다."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingWslBackend}
                  render={<Button variant="outline" disabled={isUpdatingWslBackend} />}
                >
                  취소
                </AlertDialogClose>
                {pendingWslChange?.kind === "enable" ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => handleConfirmEnableWsl("wsl-only")}
                      disabled={isUpdatingWslBackend}
                    >
                      {isUpdatingWslBackend ? (
                        <>
                          <Spinner className="size-3.5" />
                          적용 중…
                        </>
                      ) : (
                        "WSL만 사용"
                      )}
                    </Button>
                    <Button
                      variant="default"
                      onClick={() => handleConfirmEnableWsl("both")}
                      disabled={isUpdatingWslBackend}
                    >
                      {isUpdatingWslBackend ? (
                        <>
                          <Spinner className="size-3.5" />
                          적용 중…
                        </>
                      ) : (
                        "두 백엔드 함께 실행"
                      )}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant={
                      pendingWslChange?.kind === "disable" ||
                      (pendingWslChange?.kind === "wsl-only" && pendingWslChange.nextValue)
                        ? "destructive"
                        : "default"
                    }
                    onClick={handleConfirmWslChange}
                    disabled={isUpdatingWslBackend}
                  >
                    {isUpdatingWslBackend ? (
                      <>
                        <Spinner className="size-3.5" />
                        적용 중…
                      </>
                    ) : pendingWslChange?.kind === "disable" ? (
                      pendingWslChange.wasWslOnly ? (
                        "Windows로 전환"
                      ) : (
                        "WSL 끄기"
                      )
                    ) : pendingWslChange?.kind === "distro" ? (
                      "배포판 전환"
                    ) : pendingWslChange?.nextValue ? (
                      "다시 시작하고 사용"
                    ) : (
                      "다시 시작하고 끄기"
                    )}
                  </Button>
                )}
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
          <AlertDialog
            open={disableTailscaleServeDialogOpen}
            onOpenChange={(open) => {
              if (isUpdatingTailscaleServe) return;
              setDisableTailscaleServeDialogOpen(open);
            }}
          >
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Tailscale HTTPS를 끌까요?</AlertDialogTitle>
                <AlertDialogDescription>
                  Tailscale Serve를 사용하지 않고 로컬 백엔드를 다시 시작합니다.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingTailscaleServe}
                  render={<Button variant="outline" disabled={isUpdatingTailscaleServe} />}
                >
                  취소
                </AlertDialogClose>
                <Button
                  variant="destructive"
                  onClick={() => void handleConfirmTailscaleServeDisable()}
                  disabled={isUpdatingTailscaleServe}
                >
                  {isUpdatingTailscaleServe ? (
                    <>
                      <Spinner className="size-3.5" />
                      다시 시작 중…
                    </>
                  ) : (
                    "다시 시작하고 끄기"
                  )}
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
          <Dialog
            open={pendingTailscaleServeEndpoint !== null}
            onOpenChange={(open) => {
              if (isUpdatingTailscaleServe) return;
              if (!open) setPendingTailscaleServeEndpoint(null);
            }}
          >
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>Tailscale HTTPS를 설정할까요?</DialogTitle>
                <DialogDescription>
                  Tailscale Serve를 켠 상태로 로컬 백엔드를 다시 시작하고, HTTPS 트래픽을 이
                  백엔드로 전달하도록 Tailscale에 요청합니다.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel className="space-y-4">
                <label className="block">
                  <span className="text-sm font-medium text-foreground">HTTPS 포트</span>
                  <Input
                    className="mt-2"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={65_535}
                    step={1}
                    value={tailscaleServePortInput}
                    onChange={(event) => setTailscaleServePortInput(event.target.value)}
                    disabled={isUpdatingTailscaleServe}
                  />
                </label>
                {!isTailscaleServePortValid ? (
                  <p className="mt-2 text-xs text-destructive">1~65535 사이의 포트를 입력하세요.</p>
                ) : null}
                <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                  <p className="text-xs font-medium text-muted-foreground">HTTPS 연결 주소</p>
                  <p
                    className="mt-1 truncate text-sm text-foreground"
                    title={pendingTailscaleServeBaseUrl ?? undefined}
                  >
                    {pendingTailscaleServeBaseUrl ?? "MagicDNS 연결 주소 준비 중"}
                  </p>
                </div>
              </DialogPanel>
              <DialogFooter>
                <DialogClose
                  disabled={isUpdatingTailscaleServe}
                  render={<Button variant="outline" disabled={isUpdatingTailscaleServe} />}
                >
                  취소
                </DialogClose>
                <Button
                  onClick={() => void handleConfirmTailscaleServeSetup()}
                  disabled={isUpdatingTailscaleServe || !isTailscaleServePortValid}
                >
                  {isUpdatingTailscaleServe ? (
                    <>
                      <Spinner className="size-3.5" />
                      다시 시작 중…
                    </>
                  ) : (
                    "사용"
                  )}
                </Button>
              </DialogFooter>
            </DialogPopup>
          </Dialog>
        </>
      ) : (
        <SettingsSection title="이 실행 환경">
          <SettingsRow
            title="관리 권한"
            description="이 백엔드의 페어링 링크와 클라이언트 세션을 관리하려면 access:write 권한이 필요합니다."
          />
          <CloudLinkRow canManageRelay={canManageRelay} />
        </SettingsSection>
      )}

      <SettingsSection
        {...searchableSetting("remote-environments")}
        headerAction={
          <Dialog
            open={addBackendDialogOpen}
            onOpenChange={(open) => {
              setAddBackendDialogOpen(open);
              if (!open) {
                setSavedBackendError(null);
              }
            }}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <DialogTrigger
                    render={
                      <Button
                        size="xs"
                        variant="ghost"
                        className="h-5 gap-1 rounded-sm px-1 text-[11px] font-normal text-muted-foreground/60 hover:text-muted-foreground"
                        aria-label="실행 환경 추가"
                      >
                        <PlusIcon className="size-3" />
                        <span>실행 환경 추가</span>
                      </Button>
                    }
                  />
                }
              />
              <TooltipPopup side="top">실행 환경 추가</TooltipPopup>
            </Tooltip>
            <DialogPopup className="max-h-[80dvh] sm:max-w-3xl">
              <DialogHeader>
                <DialogTitle>실행 환경 추가</DialogTitle>
                <DialogDescription>
                  다른 실행 환경을 이 클라이언트와 페어링합니다.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {renderConnectionModeCard({
                      mode: "remote",
                      title: "원격 링크",
                      description: "백엔드 호스트와 페어링 코드를 입력합니다.",
                      icon: <ChevronsLeftRightEllipsisIcon aria-hidden className="size-4" />,
                    })}
                    {desktopBridge
                      ? renderConnectionModeCard({
                          mode: "ssh",
                          title: "SSH",
                          description: "로컬 SSH 설정, 에이전트와 터널을 백엔드 연결에 사용합니다.",
                          icon: <TerminalIcon aria-hidden className="size-4" />,
                        })
                      : null}
                  </div>
                  <AnimatedHeight>
                    {savedBackendMode === "ssh" ? renderSshFields() : renderRemoteModeBody()}
                  </AnimatedHeight>
                </div>
              </DialogPanel>
            </DialogPopup>
          </Dialog>
        }
      >
        {savedEnvironments.map((environment) => (
          <SavedBackendListRow
            key={environment.environmentId}
            environment={environment}
            removingEnvironmentId={removingSavedEnvironmentId}
            onConnect={handleConnectSavedBackend}
            onRemove={handleRemoveSavedBackend}
          />
        ))}
        <CloudRemoteEnvironmentRows
          primaryEnvironmentId={primaryEnvironmentId}
          savedEnvironments={savedEnvironments}
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
