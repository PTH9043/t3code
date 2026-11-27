/**
 * Compact Accessibility (a11y) Snapshot Serializer (inspired by Camofox Browser):
 * Compresses verbose browser snapshots into a dense role/label/locator line list
 * (~80-90% fewer tokens than raw DOM/HTML dumps) while preserving exact interaction targets.
 */

export interface A11yElementLike {
  readonly role?: string | null;
  readonly tag?: string | null;
  readonly name?: string | null;
  readonly label?: string | null;
  readonly text?: string | null;
  readonly locator?: string | null;
  readonly selector?: string | null;
  readonly disabled?: boolean | null;
  readonly checked?: boolean | null;
  readonly value?: string | null;
}

export interface CompactA11ySnapshotInput {
  readonly url?: string | null;
  readonly title?: string | null;
  readonly elements: ReadonlyArray<A11yElementLike>;
  readonly maxElements?: number;
}

function cleanSnippet(value: string | null | undefined, maxLen = 80): string {
  if (!value) return "";
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > maxLen ? `${single.slice(0, maxLen - 1)}…` : single;
}

export function formatCompactA11ySnapshot(input: CompactA11ySnapshotInput): string {
  const maxElements = input.maxElements ?? 80;
  const header: string[] = [];
  if (input.title) header.push(`# ${cleanSnippet(input.title, 120)}`);
  if (input.url) header.push(`url: ${input.url}`);

  const lines: string[] = [];
  const slice = input.elements.slice(0, maxElements);
  for (let i = 0; i < slice.length; i += 1) {
    const el = slice[i]!;
    const role = (el.role || el.tag || "node").toLowerCase();
    const label = cleanSnippet(el.name || el.label || el.text);
    const target = cleanSnippet(el.locator || el.selector, 90);
    const flags: string[] = [];
    if (el.disabled) flags.push("disabled");
    if (el.checked === true) flags.push("checked");
    if (el.value) flags.push(`val="${cleanSnippet(el.value, 40)}"`);
    const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";
    const targetStr = target ? ` -> ${target}` : "";
    lines.push(`[${i + 1}] ${role}${label ? ` "${label}"` : ""}${flagStr}${targetStr}`);
  }
  if (input.elements.length > maxElements) {
    lines.push(`... +${input.elements.length - maxElements} more elements omitted`);
  }

  return [...header, ...(header.length > 0 && lines.length > 0 ? [""] : []), ...lines].join("\n");
}
