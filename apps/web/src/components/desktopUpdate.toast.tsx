import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { ArrowRightIcon } from "lucide-react";

import {
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateReleaseUrl,
} from "./desktopUpdate.logic";
import { toastManager } from "./ui/toast";

type DesktopUpdateShell = Pick<DesktopBridge, "openExternal">;

function ReleaseNotesLink({
  shell,
  releaseUrl,
}: {
  shell: DesktopUpdateShell;
  releaseUrl: string;
}) {
  return (
    <button
      className="ml-2 inline-flex cursor-pointer items-center gap-1 align-baseline text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
      onClick={() => {
        void (async () => {
          try {
            if (await shell.openExternal(releaseUrl)) return;
          } catch {
            // Surface rejected IPC calls through the same user-visible fallback.
          }
          toastManager.add({ type: "error", title: "릴리스 노트를 열지 못했습니다" });
        })();
      }}
      type="button"
    >
      자세히 보기
      <ArrowRightIcon aria-hidden className="size-3 -rotate-45" strokeWidth={2.25} />
    </button>
  );
}

export function showDesktopUpdateDownloadedToast(
  shell: DesktopUpdateShell,
  state: DesktopUpdateState,
): void {
  const releaseUrl = getDesktopUpdateReleaseUrl(getDesktopUpdateDownloadedVersion(state));
  toastManager.add({
    type: "success",
    title: "업데이트 다운로드 완료",
    description: (
      <>
        업데이트 버튼에서 앱을 다시 시작해 설치하세요.
        {releaseUrl ? <ReleaseNotesLink releaseUrl={releaseUrl} shell={shell} /> : null}
      </>
    ),
  });
}
