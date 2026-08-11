import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  getDesktopUpdateReleaseUrl,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it("shows a download action when an update is available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("눌러서 다시 시도하세요");
  });

  it("keeps install action available after an install error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "shutdown timeout",
      errorContext: "install",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("눌러서 다시 시도하세요");
  });

  it("prefers install when a downloaded version already exists", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
  });

  it("hides the button for non-actionable check errors", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      message: "network unavailable",
      errorContext: "check",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });

  it("disables the button while downloading", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 42.5,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
    expect(getDesktopUpdateButtonTooltip(state)).toContain("42%");
  });
});

describe("getDesktopUpdateActionError", () => {
  it("returns user-visible message for accepted failed attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        message: "checksum mismatch",
        errorContext: "download",
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBe("업데이트 작업을 완료하지 못했습니다.");
  });

  it("ignores messages for non-accepted attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: false,
      completed: false,
      state: {
        ...baseState,
        status: "error",
        message: "background failure",
        errorContext: "check",
        canRetry: false,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });

  it("ignores messages for successful attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: true,
      state: {
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
        availableVersion: "1.1.0",
        message: null,
        errorContext: null,
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });
});

describe("desktop update UI helpers", () => {
  it("builds the stable release URL for a downloaded version", () => {
    expect(getDesktopUpdateReleaseUrl("0.0.30")).toBe(
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.30",
    );
  });

  it("builds the nightly release URL without dropping its version suffix", () => {
    expect(getDesktopUpdateReleaseUrl("0.0.30-nightly.20260728.931")).toBe(
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.30-nightly.20260728.931",
    );
  });

  it("omits the release URL when the updater does not report a version", () => {
    expect(getDesktopUpdateReleaseUrl(null)).toBeNull();
    expect(getDesktopUpdateReleaseUrl("  ")).toBeNull();
  });

  it("toasts only for actionable updater errors", () => {
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: { ...baseState, message: "checksum mismatch" },
      }),
    ).toBe(true);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: { ...baseState, message: null },
      }),
    ).toBe(false);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: true,
        state: { ...baseState, message: "checksum mismatch" },
      }),
    ).toBe(false);
  });

  it("shows an Apple Silicon warning for Intel builds under Rosetta", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
    };

    expect(shouldShowArm64IntelBuildWarning(state)).toBe(true);
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Apple Silicon");
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Intel 빌드");
  });

  it("changes the warning copy when a native build update is ready to download", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
      status: "available",
      availableVersion: "1.1.0",
    };

    expect(getArm64IntelBuildWarningDescription(state)).toContain("업데이트를 다운로드하면");
  });

  it("includes the downloaded version in the install confirmation copy", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.1",
      }),
    ).toContain("업데이트 1.1.1을 설치하고 T3 Code를 다시 시작할까요?");
  });

  it("falls back to generic install confirmation copy when no version is available", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: null,
        downloadedVersion: null,
      }),
    ).toContain("업데이트를 설치하고 T3 Code를 다시 시작할까요?");
  });

  it("warns Windows users that a silent installation can take several minutes", () => {
    const message = getDesktopUpdateInstallConfirmationMessage(
      {
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      },
      "Win32",
    );

    expect(message).toContain("몇 분 동안 닫혀 있을 수 있으며");
    expect(message).toContain("설치 창이 표시되지 않을 수도 있습니다");
    expect(message).toContain("자동으로 다시 열립니다");
  });

  it("keeps the additional silent installation warning Windows-specific", () => {
    const message = getDesktopUpdateInstallConfirmationMessage(
      {
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      },
      "MacIntel",
    );

    expect(message).not.toContain("몇 분 동안 닫혀 있을 수 있으며");
  });
});

describe("canCheckForUpdate", () => {
  it("returns false for null state", () => {
    expect(canCheckForUpdate(null)).toBe(false);
  });

  it("returns false when updates are disabled", () => {
    expect(canCheckForUpdate({ ...baseState, enabled: false, status: "disabled" })).toBe(false);
  });

  it("returns false while checking", () => {
    expect(canCheckForUpdate({ ...baseState, status: "checking" })).toBe(false);
  });

  it("returns false while downloading", () => {
    expect(canCheckForUpdate({ ...baseState, status: "downloading", downloadPercent: 50 })).toBe(
      false,
    );
  });

  it("returns false once an update has been downloaded", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(false);
  });

  it("returns true when idle", () => {
    expect(canCheckForUpdate({ ...baseState, status: "idle" })).toBe(true);
  });

  it("returns true when up-to-date", () => {
    expect(canCheckForUpdate({ ...baseState, status: "up-to-date" })).toBe(true);
  });

  it("returns true when an update is available", () => {
    expect(
      canCheckForUpdate({ ...baseState, status: "available", availableVersion: "1.1.0" }),
    ).toBe(true);
  });

  it("returns true on error so the user can retry", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "error",
        errorContext: "check",
        message: "network",
      }),
    ).toBe(true);
  });
});

describe("getDesktopUpdateButtonTooltip", () => {
  it("returns 'Up to date' for non-actionable states", () => {
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "idle" })).toBe("최신 버전");
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "up-to-date" })).toBe("최신 버전");
  });
});
