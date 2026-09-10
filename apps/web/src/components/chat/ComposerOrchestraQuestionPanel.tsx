import { memo, useEffect } from "react";
import { cn } from "~/lib/utils";

/**
 * The composer card for an 오케스트라 run's pending question. Unlike the provider
 * user-input card (fed by `user-input.requested` activities), this reads the
 * live run's `meeting.pendingQuestion` — a question that stops the whole run
 * until the person answers. Clicking an option answers it directly through the
 * run's answer command; when the question carries no options the person types
 * the answer into the composer and sends it (handled by the send path).
 */
export const ComposerOrchestraQuestionPanel = memo(function ComposerOrchestraQuestionPanel({
  question,
  options,
  isAnswering,
  onAnswer,
}: {
  question: string;
  options: readonly string[];
  isAnswering: boolean;
  onAnswer: (answer: string) => void;
}) {
  // Number keys 1–9 pick the matching option when focus is outside an editable
  // field — mirrors the provider question card so the muscle memory carries.
  useEffect(() => {
    if (isAnswering || options.length === 0) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const option = options[digit - 1];
      if (option === undefined) return;
      event.preventDefault();
      onAnswer(option);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isAnswering, options, onAnswer]);

  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="mb-2 flex items-center gap-3">
        <span className="text-secondary-label text-[11px] font-semibold tracking-widest uppercase">
          오케스트라 질문
        </span>
      </div>
      <p className="text-sm text-foreground/90">{question}</p>
      {options.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          {options.map((option, index) => {
            const shortcutKey = index < 9 ? index + 1 : null;
            return (
              <button
                key={`${index}:${option}`}
                type="button"
                disabled={isAnswering}
                onClick={() => onAnswer(option)}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-all duration-150 focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/25",
                  "border-transparent bg-muted/22 text-foreground/85 hover:border-border/45 hover:bg-muted/34",
                  isAnswering ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                )}
              >
                <span className="min-w-0 flex-1 text-sm font-medium">{option}</span>
                {shortcutKey !== null ? (
                  <kbd className="flex size-5 shrink-0 items-center justify-center rounded border border-border/50 bg-background/35 text-[11px] font-medium tabular-nums text-secondary-label group-hover:border-border/70 group-hover:text-foreground">
                    {shortcutKey}
                  </kbd>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="mt-2 text-secondary-label text-xs">
          아래 입력창에 답을 적어 보내면 오케스트라가 이어집니다.
        </p>
      )}
    </div>
  );
});
