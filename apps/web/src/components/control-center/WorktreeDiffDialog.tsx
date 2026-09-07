import { useMemo } from "react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { GitBranchIcon, RefreshCcwIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { reviewEnvironment } from "~/state/review";
import { useEnvironmentQuery } from "~/state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { combineWorktreeDiffSources } from "./worktreeDiffPresentation";

export interface WorktreeDiffTarget {
  readonly environmentId: EnvironmentProject["environmentId"];
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly nodeTitle: string;
}

function DiffLine({ line }: { line: string }) {
  return (
    <div
      className={cn(
        "whitespace-pre px-2",
        line.startsWith("+") && !line.startsWith("+++")
          ? "bg-success/10 text-success-foreground"
          : line.startsWith("-") && !line.startsWith("---")
            ? "bg-destructive/10 text-destructive"
            : line.startsWith("@@")
              ? "bg-info/10 text-info-foreground"
              : "text-muted-foreground",
      )}
    >
      {line.length === 0 ? " " : line}
    </div>
  );
}

/**
 * The chain worktree's diff against its base branch — committed and
 * uncommitted parts both, because merging takes the union. Read-only review;
 * committing/pushing happens through the usual source-control flow inside
 * the worktree.
 */
export function WorktreeDiffDialog({
  target,
  onClose,
}: {
  readonly target: WorktreeDiffTarget | null;
  readonly onClose: () => void;
}) {
  const preview = useEnvironmentQuery(
    target === null
      ? null
      : reviewEnvironment.diffPreview({
          environmentId: target.environmentId,
          input: { cwd: target.worktreePath },
        }),
  );
  const sections = useMemo(
    () => combineWorktreeDiffSources(preview.data?.sources ?? []),
    [preview.data],
  );

  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <GitBranchIcon className="size-4" aria-hidden />
            worktree diff · {target?.nodeTitle}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1.5">
            {target?.branch ? <Badge variant="outline">{target.branch}</Badge> : null}
            <code className="text-[11px] text-muted-foreground">{target?.worktreePath}</code>
            <Button size="xs" variant="ghost" onClick={preview.refresh}>
              <RefreshCcwIcon />
              새로고침
            </Button>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[70vh]">
          {preview.error ? (
            <p className="text-xs text-destructive">{String(preview.error)}</p>
          ) : preview.isPending ? (
            <p className="text-xs text-muted-foreground">diff를 불러오는 중…</p>
          ) : sections.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
              base 브랜치와 차이가 없습니다. 이 worktree는 정리해도 안전합니다.
            </p>
          ) : (
            <div className="grid gap-3">
              {sections.map((section) => (
                <section key={section.title} className="grid gap-1.5">
                  <h4 className="text-xs font-semibold">{section.title}</h4>
                  {section.files.map((file) => (
                    <details
                      key={`${section.title}:${file.path}`}
                      className="rounded-lg border border-border/65"
                      open={section.files.length <= 3}
                    >
                      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5">
                        <code className="min-w-0 flex-1 truncate text-[11px] font-medium">
                          {file.path}
                        </code>
                        <span className="text-[10px] text-success-foreground">+{file.added}</span>
                        <span className="text-[10px] text-destructive">-{file.removed}</span>
                      </summary>
                      <div className="max-h-80 overflow-auto border-t border-border/50 py-1 font-mono text-[11px] leading-relaxed">
                        {file.text.split("\n").map((line, index) => (
                          // eslint-disable-next-line react/no-array-index-key -- static patch lines
                          <DiffLine key={index} line={line} />
                        ))}
                      </div>
                    </details>
                  ))}
                </section>
              ))}
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
