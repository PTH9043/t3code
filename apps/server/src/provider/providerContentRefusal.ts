import { createAndRecordClassifierTelemetry } from "@t3tools/contracts";

/**
 * Claude Code's wording when the API refuses a request outright, e.g.
 * "Opus 5.5's safeguards flagged this session". The mid-response notice
 * "safeguards stopped the response above" is a retry, not a refusal.
 */
const SAFEGUARD_BLOCK_PATTERN =
  /safeguards?\s+(?:flagged|stopped|blocked)\s+this\s+(?:session|message)/iu;

const REFUSAL_ERROR_RULES: ReadonlyArray<{ readonly ruleId: string; readonly rx: RegExp }> = [
  { ruleId: "refusal.cybersecurity_risk", rx: /flagged for possible cybersecurity risk/iu },
  { ruleId: "refusal.trusted_access_cyber", rx: /trusted access for cyber/iu },
  { ruleId: "refusal.content_policy", rx: /\b(?:content|usage) polic(?:y|ies)\b/iu },
  { ruleId: "refusal.claude_safeguards", rx: /flagged by (?:claude(?:'s|’s) )?safeguards/iu },
  { ruleId: "refusal.safeguard_block", rx: SAFEGUARD_BLOCK_PATTERN },
  { ruleId: "refusal.model_refusal", rx: /\bmodel_refusal(?:_no_fallback|_fallback)?\b/iu },
  { ruleId: "refusal.content_filter", rx: /\bcontent_filter(?:ed)?\b/iu },
  {
    ruleId: "refusal.safety_filter_en",
    rx: /(?:blocked|refused|rejected) by (?:the )?safety (?:filter|system)/iu,
  },
  { ruleId: "refusal.safety_filter_ko", rx: /안전\s*필터(?:에|가|로).*?(?:차단|거부)/u },
];

const REFUSAL_OUTPUT_RULES: ReadonlyArray<{ readonly ruleId: string; readonly rx: RegExp }> = [
  { ruleId: "refusal.output.cybersecurity_risk", rx: /flagged for possible cybersecurity risk/iu },
  {
    ruleId: "refusal.output.claude_safeguards",
    rx: /flagged by (?:claude(?:'s|’s) )?safeguards/iu,
  },
  { ruleId: "refusal.output.safeguard_block", rx: SAFEGUARD_BLOCK_PATTERN },
  { ruleId: "refusal.output.model_refusal", rx: /\bmodel_refusal(?:_no_fallback|_fallback)?\b/iu },
  { ruleId: "refusal.output.content_filter", rx: /\bcontent_filter(?:ed)?\b/iu },
  {
    ruleId: "refusal.output.safety_filter_en",
    rx: /(?:blocked|refused|rejected) by (?:the )?safety (?:filter|system)/iu,
  },
  { ruleId: "refusal.output.safety_filter_ko", rx: /안전\s*필터(?:에|가|로).*?(?:차단|거부)/u },
];

/** True for the refusal that ends a Claude turn; the caller must not resend it automatically. */
export function isSafeguardBlock(message: string | null | undefined): boolean {
  const matched = typeof message === "string" && SAFEGUARD_BLOCK_PATTERN.test(message);
  createAndRecordClassifierTelemetry({
    classifier: "provider_content_refusal",
    decision: matched ? "safeguard_block" : "none",
    confidence: matched ? 0.96 : 0.98,
    fallbackUsed: false,
    ruleId: matched ? "refusal.safeguard_block" : "refusal.safeguard_none",
    signalSource: "heuristic",
  });
  return matched;
}

/** Recognize provider policy refusals, including errors returned by Claude. */
export function isProviderContentRefusal(message: string): boolean {
  const hit = REFUSAL_ERROR_RULES.find((rule) => rule.rx.test(message));
  createAndRecordClassifierTelemetry({
    classifier: "provider_content_refusal",
    decision: hit ? "refusal" : "none",
    confidence: hit ? 0.94 : 0.97,
    fallbackUsed: false,
    ruleId: hit ? hit.ruleId : "refusal.error_none",
    signalSource: "heuristic",
  });
  return hit !== undefined;
}

/** A plain provider rejection can arrive as successful text instead of an error. */
export function isProviderContentRefusalOutput(message: string): boolean {
  const text = message.trim();
  if (text.length > 1_000 || /<t3_[a-z_]+>/iu.test(text)) {
    createAndRecordClassifierTelemetry({
      classifier: "provider_content_refusal",
      decision: "none",
      confidence: 0.99,
      fallbackUsed: false,
      ruleId: "refusal.output_length_or_structured_exempt",
      signalSource: "structured",
    });
    return false;
  }
  const hit = REFUSAL_OUTPUT_RULES.find((rule) => rule.rx.test(text));
  createAndRecordClassifierTelemetry({
    classifier: "provider_content_refusal",
    decision: hit ? "refusal_output" : "none",
    confidence: hit ? 0.9 : 0.96,
    fallbackUsed: false,
    ruleId: hit ? hit.ruleId : "refusal.output_none",
    signalSource: "heuristic",
  });
  return hit !== undefined;
}
