import * as Schema from "effect/Schema";

export const ThreadResponseStyle = Schema.Struct({
  preset: Schema.Literals(["default", "concise", "detailed", "friendly", "professional"]),
  tone: Schema.String,
  length: Schema.String,
  explanation: Schema.String,
  instructions: Schema.String,
});
export type ThreadResponseStyle = typeof ThreadResponseStyle.Type;

/** A stored style with the default preset and no text asks for nothing, so it is not an override. */
export function isCustomResponseStyle(style: ThreadResponseStyle | null | undefined): boolean {
  return (
    style != null &&
    (style.preset !== "default" ||
      [style.tone, style.length, style.explanation, style.instructions].some((value) =>
        value.trim(),
      ))
  );
}

export function resolveResponseStyle(
  settings: {
    readonly globalResponseStyle?: ThreadResponseStyle | null;
    readonly threadResponseStyles?: Readonly<Record<string, ThreadResponseStyle>>;
  },
  _threadId?: string | null,
) {
  // Unified global-only policy: per-thread overrides are retired so every conversation
  // immediately follows the user's global AI profile.
  return { style: settings.globalResponseStyle ?? null };
}
