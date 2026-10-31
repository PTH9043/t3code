import type { ThreadId, WorkspaceTaskNodeStatus } from "@t3tools/contracts";
import { ListTreeIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { OrchestraNodeConversation } from "./orchestraNodeConversations";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const STATUS_LABELS: Readonly<Record<WorkspaceTaskNodeStatus, string>> = {
  blocked: "선행 작업 대기",
  queued: "실행 대기",
  running: "실행 중",
  "awaiting-validation": "검증 대기",
  "awaiting-user": "내 답변 대기",
  completed: "완료",
  failed: "실패",
  cancelled: "취소",
  skipped: "건너뜀",
};

const STATUS_DOT_CLASSES: Readonly<Record<WorkspaceTaskNodeStatus, string>> = {
  blocked: "bg-muted-foreground/45",
  queued: "bg-muted-foreground/45",
  running: "bg-primary",
  "awaiting-validation": "bg-primary/60",
  "awaiting-user": "bg-warning",
  completed: "bg-success",
  failed: "bg-error",
  cancelled: "bg-muted-foreground/45",
  skipped: "bg-muted-foreground/45",
};

/**
 * The way into an orchestra run's node conversations.
 *
 * Those conversations are deliberately absent from the conversation list — a
 * run spawns one per parallel node, which would bury everything the person
 * actually started. The run's own conversation carries this instead, so the
 * work stays reachable without the list paying for it.
 */
export function OrchestraNodeConversationsPopover({
  nodes,
  onOpen,
}: {
  nodes: readonly OrchestraNodeConversation[];
  onOpen: (threadId: ThreadId) => void;
}) {
  if (nodes.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`오케스트라 노드 대화 ${nodes.length}개 보기`}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors",
              "hover:bg-accent hover:text-foreground data-[popup-open]:bg-accent data-[popup-open]:text-foreground",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
          >
            <ListTreeIcon className="size-3.5" />
            노드 대화 {nodes.length}
          </button>
        }
      />
      <PopoverPopup align="end" className="w-80 p-1">
        <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
          각 노드는 자기 대화에서 실행됩니다. 목록에는 숨겨져 있고 여기서 엽니다.
        </p>
        <div className="max-h-80 overflow-y-auto">
          {nodes.map((node) => (
            <button
              key={node.threadId}
              type="button"
              onClick={() => onOpen(node.threadId)}
              className={cn(
                "flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors",
                "hover:bg-accent focus-visible:bg-accent",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  STATUS_DOT_CLASSES[node.status],
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{node.title}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {STATUS_LABELS[node.status]}
                  {node.seatLabel === null ? "" : ` · ${node.seatLabel}`}
                </span>
              </span>
            </button>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
