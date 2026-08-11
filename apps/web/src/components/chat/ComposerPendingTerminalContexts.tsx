import { cn } from "~/lib/utils";
import {
  type TerminalContextDraft,
  formatTerminalContextDisplayLabel,
  isTerminalContextExpired,
} from "~/lib/terminalContext";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";

interface ComposerPendingTerminalContextsProps {
  contexts: ReadonlyArray<TerminalContextDraft>;
  className?: string;
}

interface ComposerPendingTerminalContextChipProps {
  context: TerminalContextDraft;
}

export function ComposerPendingTerminalContextChip({
  context,
}: ComposerPendingTerminalContextChipProps) {
  const label = formatTerminalContextDisplayLabel(context);
  const expired = isTerminalContextExpired(context);
  const tooltipText = expired
    ? `터미널 문맥이 만료되었습니다. 메시지에 포함하려면 ${label}을(를) 제거한 뒤 다시 추가하세요.`
    : context.text;

  return <TerminalContextInlineChip label={label} tooltipText={tooltipText} expired={expired} />;
}

export function ComposerPendingTerminalContexts(props: ComposerPendingTerminalContextsProps) {
  const { contexts, className } = props;

  if (contexts.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {contexts.map((context) => (
        <ComposerPendingTerminalContextChip key={context.id} context={context} />
      ))}
    </div>
  );
}
