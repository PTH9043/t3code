import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { BrainCircuitIcon } from "lucide-react";

import { ControlCenterDisplayControls } from "~/components/control-center/ControlCenterDisplayControls";
import { SidebarInset } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

function ControlCenterLayout() {
  return (
    <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header
          className={cn(
            "workspace-topbar border-b border-border/60 px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex w-full items-center gap-2">
            <BrainCircuitIcon className="size-4 text-primary" />
            <span className="text-sm font-medium text-foreground">AI 제어센터</span>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              사용자 명령 우선 · 폴더별 완전 격리
            </span>
            <ControlCenterDisplayControls />
          </div>
        </header>
        <Outlet />
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/control-center")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ControlCenterLayout,
});
