import { BookOpenIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { openAiHelp } from "./aiHelpStore";

export function AiHelpButton({
  className,
  onBackdrop = false,
}: {
  className?: string;
  onBackdrop?: boolean;
}) {
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        "h-[var(--workspace-titlebar-control-size)]! w-[var(--workspace-help-control-width)] gap-1 px-2 text-xs [-webkit-app-region:no-drag]",
        onBackdrop &&
          "border-white/25 bg-white/10 text-white shadow-none hover:bg-white/20 focus-visible:ring-white [&_svg]:text-white",
        className,
      )}
      aria-label="AI 사용 도움말 열기"
      aria-keyshortcuts="F1"
      title="AI 사용 도움말 (F1)"
      onClick={() => {
        if (isMobile) setOpenMobile(false);
        openAiHelp();
      }}
    >
      <BookOpenIcon className="size-3.5" />
      도움말
    </Button>
  );
}
