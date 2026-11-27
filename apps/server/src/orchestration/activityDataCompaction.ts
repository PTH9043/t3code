type TextLimit = { readonly limit: number; readonly head: number; readonly tail: number };

/**
 * Tool output. It dominated the state database (about 12 GB of 14 GB in one
 * real install: megabyte command logs, MCP results and base64 images, each
 * written to both the event store and the activity projection), yet no client
 * renders it: the wire projection in `ActivityPayloadProjection` strips it.
 */
const OUTPUT_TEXT: TextLimit = { limit: 2_048, head: 512, tail: 1_024 };

/** Commands and tool arguments are what the work log shows, so they keep far more. */
const INPUT_TEXT: TextLimit = { limit: 16_384, head: 4_096, tail: 8_192 };
const INPUT_KEYS = new Set(["command", "arguments", "input"]);

/** Longest list a stored tool activity keeps whole, e.g. streamed output chunks. */
const LIST_LIMIT = 48;
const LIST_HEAD = 16;
const LIST_TAIL = 24;

/** Shortest text `compactActivityData` can shorten; anything smaller is stored as is. */
export const ACTIVITY_TEXT_LIMIT = OUTPUT_TEXT.limit;

/**
 * Shrinks the `data` of a tool activity before it is persisted: text over the
 * limit keeps its start and end around a marker saying how much was dropped,
 * and long lists keep their first and last entries the same way. Anything
 * under a `command`, `arguments` or `input` key gets the larger input limit.
 * Structure and short values are untouched, so readers of stored activities
 * (tool names, commands, MCP arguments and small results) keep working.
 * Returns the input itself when nothing was over the limits, and compacting
 * an already compacted value changes nothing.
 */
export function compactActivityData(value: unknown): unknown {
  return compact(value, OUTPUT_TEXT);
}

function compact(value: unknown, text: TextLimit): unknown {
  if (typeof value === "string") {
    if (value.length <= text.limit) {
      return value;
    }
    const omitted = value.length - text.head - text.tail;
    return `${value.slice(0, text.head)}\n…[${omitted.toLocaleString("en-US")}자 생략]…\n${value.slice(-text.tail)}`;
  }

  if (Array.isArray(value)) {
    const kept =
      value.length > LIST_LIMIT
        ? [
            ...value.slice(0, LIST_HEAD),
            `…[${(value.length - LIST_HEAD - LIST_TAIL).toLocaleString("en-US")}개 항목 생략]…`,
            ...value.slice(-LIST_TAIL),
          ]
        : value;
    let changed = kept !== value;
    const compacted = kept.map((entry: unknown) => {
      const next = compact(entry, text);
      changed ||= next !== entry;
      return next;
    });
    return changed ? compacted : value;
  }

  // Binary views serialize through their own toJSON; walking their bytes is wasted work.
  if (value !== null && typeof value === "object" && !ArrayBuffer.isView(value)) {
    let compacted: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const next = compact(entry, INPUT_KEYS.has(key) ? INPUT_TEXT : text);
      if (next !== entry) {
        compacted ??= { ...value };
        compacted[key] = next;
      }
    }
    return compacted ?? value;
  }

  return value;
}
