import { AI_HELP_CHANNEL, AI_HELP_HTML, parseAiHelpMessage } from "@t3tools/shared/aiHelp";
import { DownloadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";

async function copyGuideText(text: string) {
  try {
    return await writeTextToClipboard(text, "AI help");
  } catch {
    // LAN HTTP clients can lack the Clipboard API; the selection path still
    // lets their explicit Copy click work where the browser permits it.
    const previousFocus = document.activeElement;
    const selection = document.createElement("textarea");
    selection.value = text;
    selection.style.position = "fixed";
    selection.style.opacity = "0";
    document.body.appendChild(selection);
    selection.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      selection.remove();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    }
  }
}

function downloadGuide() {
  const url = URL.createObjectURL(new Blob([AI_HELP_HTML], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "AI-사용-도움말.html";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AiHelpDialog({ onClose }: { readonly onClose: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [guideUrl, setGuideUrl] = useState<string | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const sender = frameRef.current?.contentWindow;
      if (!sender || event.source !== sender) return;
      const message = parseAiHelpMessage(event.data);
      if (message?.action === "close") onClose();
      if (message?.action === "copy") {
        void copyGuideText(message.text).then((success) => {
          if (frameRef.current?.contentWindow !== sender) return;
          sender.postMessage(
            {
              channel: AI_HELP_CHANNEL,
              action: "copy-result",
              requestId: message.requestId,
              success,
            },
            "*",
          );
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onClose]);

  useEffect(() => {
    // A blob document avoids routing the embedded guide through the desktop app origin.
    const url = URL.createObjectURL(new Blob([AI_HELP_HTML], { type: "text/html;charset=utf-8" }));
    setGuideUrl(url);
    return () => URL.revokeObjectURL(url);
  }, []);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        bottomStickOnMobile={false}
        className="flex h-[min(90dvh,1000px)] w-[calc(100vw-2rem)] max-w-[1440px] flex-col overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 border-b px-5 py-4 pr-14">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-2">
              <DialogTitle className="text-lg">AI 사용 도움말</DialogTitle>
              <DialogDescription>
                스킬·유틸리티·Codex·Claude 명령어와 작업 요청 예시
              </DialogDescription>
            </div>
            <Button size="sm" variant="outline" onClick={downloadGuide}>
              <DownloadIcon className="size-3.5" />
              HTML 저장
            </Button>
          </div>
        </DialogHeader>
        {guideUrl ? (
          <iframe
            ref={frameRef}
            title="AI 사용 도움말 본문"
            src={guideUrl}
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals"
            className="min-h-0 w-full flex-1 border-0"
          />
        ) : (
          <div
            className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
            role="status"
          >
            도움말 준비 중…
          </div>
        )}
      </DialogPopup>
    </Dialog>
  );
}
