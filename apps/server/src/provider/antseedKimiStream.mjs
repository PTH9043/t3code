import { StringDecoder } from "node:string_decoder";

// Delay only an unidentified tool call; never guess its name or execute it.
export function createAntseedKimiStreamNormalizer({ maxBufferedBytes = 1024 * 1024 } = {}) {
  const decoder = new StringDecoder("utf8");
  let input = "";
  let queued = [];
  let queuedBytes = 0;
  let failed = false;
  const known = new Map();
  const pending = new Map();

  function failure() {
    failed = true;
    input = "";
    queued = [];
    pending.clear();
    return 'data: {"error":{"type":"invalid_response_error","message":"Antseed: incomplete or ambiguous streamed tool call was withheld."}}\n\ndata: [DONE]\n\n';
  }

  function consume(frame, separator) {
    const lines = frame.split(/\r?\n/);
    const indexes = [];
    const data = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("data:")) {
        indexes.push(i);
        data.push(lines[i].slice(5).replace(/^ /, ""));
      }
    }
    const payload = data.join("\n");
    if (payload === "[DONE]" && pending.size) return failure();
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      /* Preserve non-JSON SSE events. */
    }
    let changed = false;
    if (json && typeof json === "object" && Array.isArray(json.choices)) {
      for (const choice of json.choices) {
        if (!Array.isArray(choice?.delta?.tool_calls)) continue;
        const choiceIndex = Number.isInteger(choice.index) ? choice.index : 0;
        for (const call of choice.delta.tool_calls) {
          if (!call || typeof call !== "object") continue;
          const fn = call.function && typeof call.function === "object" ? call.function : {};
          const name = typeof fn.name === "string" && fn.name.trim() ? fn.name : undefined;
          const id = typeof call.id === "string" && call.id ? call.id : undefined;
          const key = Number.isInteger(call.index)
            ? `${choiceIndex}:index:${call.index}`
            : id
              ? `${choiceIndex}:id:${id}`
              : undefined;
          if (!key) return failure();
          const previous = known.get(key);
          if (previous && id && previous.id && id !== previous.id) return failure();
          if (!previous) {
            const entry = { id, first: call, name };
            known.set(key, entry);
            if (!name) pending.set(key, entry);
          } else if (!previous.name && name) {
            previous.name = name;
            previous.first.function ??= {};
            previous.first.function.name = name;
            delete fn.name;
            pending.delete(key);
            changed = true;
          } else if (previous.name && name && previous.name !== name) {
            return failure();
          }
          if (fn.name === null) {
            delete fn.name;
            changed = true;
          }
        }
      }
    }
    const entry = { frame, separator, lines, indexes, json, changed };
    queued.push(entry);
    queuedBytes += Buffer.byteLength(frame + separator);
    if (queuedBytes > maxBufferedBytes) return failure();
    if (pending.size) return "";
    const output = queued
      .map((item) => {
        // Queued JSON can be changed by a later name delta, so reserialize it.
        if (item.json && item.indexes.length) {
          const first = item.indexes[0];
          item.lines[first] = `data: ${JSON.stringify(item.json)}`;
          for (const index of item.indexes.slice(1).reverse()) item.lines.splice(index, 1);
          return item.lines.join("\n") + item.separator;
        }
        return item.frame + item.separator;
      })
      .join("");
    queued = [];
    queuedBytes = 0;
    return output;
  }

  function drain() {
    let result = "";
    while (!failed) {
      const match = /\r?\n\r?\n/.exec(input);
      if (!match) break;
      const frame = input.slice(0, match.index);
      input = input.slice(match.index + match[0].length);
      result += consume(frame, match[0]);
    }
    if (!failed && Buffer.byteLength(input) + queuedBytes > maxBufferedBytes) result += failure();
    return result;
  }

  return {
    write(bytes) {
      if (failed) return "";
      input += decoder.write(Buffer.from(bytes));
      return drain();
    },
    end() {
      if (failed) return "";
      input += decoder.end();
      let result = drain();
      if (!failed && input) {
        const finalFrame = input;
        input = "";
        result += consume(finalFrame, "");
      }
      if (pending.size) return result + failure();
      return result;
    },
  };
}
