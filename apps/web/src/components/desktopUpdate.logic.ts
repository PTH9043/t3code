import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
import { isWindowsPlatform } from "../lib/utils";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const DESKTOP_RELEASE_TAG_URL = "https://github.com/pingdotgg/t3code/releases/tag";

/**
 * The main process fills `downloadedVersion` from the updater's `update-downloaded`
 * event, which is dispatched on its own fiber. A download RPC can therefore resolve
 * before that write lands, so fall back to the version the download was started for.
 */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

/** Release notes for an exact downloaded build; nightly suffixes are part of the tag. */
export function getDesktopUpdateReleaseUrl(version: string | null): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${DESKTOP_RELEASE_TAG_URL}/v${encodeURIComponent(normalizedVersion)}`;
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (state.downloadedVersion) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }
  if (state.status === "downloading") {
    return true;
  }
  return resolveDesktopUpdateButtonAction(state) !== "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "현재 설치는 올바른 아키텍처를 사용하고 있습니다.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "이 Mac은 Apple Silicon을 사용하지만 T3 Code가 Rosetta에서 Intel 빌드로 실행 중입니다. 업데이트를 다운로드하면 Apple Silicon 네이티브 빌드로 전환됩니다.";
  }
  if (action === "install") {
    return "이 Mac은 Apple Silicon을 사용하지만 T3 Code가 Rosetta에서 Intel 빌드로 실행 중입니다. 다시 시작해 다운로드한 Apple Silicon 빌드를 설치하세요.";
  }
  return "이 Mac은 Apple Silicon을 사용하지만 T3 Code가 Rosetta에서 Intel 빌드로 실행 중입니다. 다음 앱 업데이트에서 Apple Silicon 네이티브 빌드로 교체됩니다.";
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.status === "available") {
    return `업데이트 ${state.availableVersion ?? "새 버전"} 다운로드 가능`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `업데이트 다운로드 중${progress}`;
  }
  if (state.status === "downloaded") {
    return `업데이트 ${state.downloadedVersion ?? state.availableVersion ?? "새 버전"} 다운로드 완료. 눌러서 다시 시작하고 설치하세요.`;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return `${state.availableVersion} 다운로드 실패. 눌러서 다시 시도하세요.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `${state.downloadedVersion} 설치 실패. 눌러서 다시 시도하세요.`;
    }
    return state.message && /[가-힣]/.test(state.message) ? state.message : "업데이트 실패";
  }
  return "최신 버전";
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
  platform = "",
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  const windowsInstallWarning = isWindowsPlatform(platform)
    ? "\n\nWindows에서는 업데이트 설치 중 T3 Code가 몇 분 동안 닫혀 있을 수 있으며 설치 창이 표시되지 않을 수도 있습니다. 설치가 끝나면 T3 Code가 자동으로 다시 열립니다."
    : "";
  return `${version ? `업데이트 ${version}을` : "업데이트를"} 설치하고 T3 Code를 다시 시작할까요?\n\n실행 중인 작업은 중단됩니다. 계속하기 전에 준비되었는지 확인하세요.${windowsInstallWarning}`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  if (message.length === 0) return null;
  return /[가-힣]/.test(message) ? message : "업데이트 작업을 완료하지 못했습니다.";
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state || state.status !== "error") return false;
  return state.errorContext === "download" || state.errorContext === "install";
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" &&
    state.status !== "downloading" &&
    state.status !== "downloaded" &&
    state.status !== "disabled"
  );
}
