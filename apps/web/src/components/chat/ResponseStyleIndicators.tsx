import type {
  ResponseStyleUiProfile,
  ResponseStyleUiVariant,
} from "@t3tools/client-runtime/state/response-style-presentation";
import { useMemo } from "react";
import { responseStyleResultSummary, responseStyleScopeShortLabel } from "~/responseStyleUi";
import { Badge } from "../ui/badge";

/** Header pill naming the style in effect, e.g. "최고 비서실장 · 이 방". Nothing when no style has a name. */
export function ResponseStylePill({ profile }: { profile: ResponseStyleUiProfile }) {
  if (profile.personaBadge === undefined) return null;
  const scope = responseStyleScopeShortLabel(profile.scopeLabel);
  const fullLabel = scope ? `${profile.personaBadge} · ${scope}` : profile.personaBadge;
  return (
    <Badge
      size="sm"
      variant="secondary"
      title={fullLabel}
      className="max-w-[180px] truncate max-sm:hidden"
      data-response-style-pill={profile.variant}
    >
      <span className="truncate">{fullLabel}</span>
    </Badge>
  );
}

/**
 * Turn viewer digest shown above the full answer: the advice teaser and the status tag tally
 * of an executive-style answer. Nothing for other styles or answers without an advice section.
 */
export function ResponseStyleResultSummary({
  text,
  variant,
}: {
  text: string | undefined;
  variant: ResponseStyleUiVariant;
}) {
  const summary = useMemo(() => responseStyleResultSummary(text, variant), [text, variant]);
  if (!summary || (!summary.adviceLine && !summary.tally)) return null;
  return (
    <section aria-label="응답 요약" className="grid gap-1 break-words">
      {summary.adviceLine && (
        <p>
          <span className="text-muted-foreground">비서실장의 조언 · </span>
          {summary.adviceLine}
        </p>
      )}
      {summary.tally && <p className="text-muted-foreground">{summary.tally}</p>}
    </section>
  );
}
