import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// The server keeps Claude's raw refusal text inside its Korean guidance, so one pattern covers both.
const SAFEGUARD_BLOCK_PATTERN =
  /safeguards?\s+(?:flagged|stopped|blocked)\s+this\s+(?:session|message)/i;

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
  onNewThread,
}: {
  error: string | null;
  onDismiss?: () => void;
  onNewThread?: () => void;
}) {
  if (!error) return null;
  const isSafeguardBlocked = SAFEGUARD_BLOCK_PATTERN.test(error);
  return (
    <div className="mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant="error" controlAlignment="first-line">
        <CircleAlertIcon />
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3" />}>{error}</TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {error}
            </TooltipPopup>
          </Tooltip>
        </AlertDescription>
        {(onDismiss || (isSafeguardBlocked && onNewThread)) && (
          <AlertAction>
            {isSafeguardBlocked && onNewThread && (
              <Button variant="outline" size="xs" onClick={onNewThread}>
                새 대화 열기
              </Button>
            )}
            {onDismiss && (
              <Button variant="ghost" size="icon-xs" aria-label="오류 닫기" onClick={onDismiss}>
                <XIcon className="text-destructive" />
              </Button>
            )}
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
