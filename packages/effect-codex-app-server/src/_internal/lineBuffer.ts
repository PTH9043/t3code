/** Accumulates JSONL fragments without rescanning or copying an unfinished line. */
export function makeLineBuffer() {
  let fragments: string[] = [];
  return {
    push(chunk: string): string[] {
      const lines: string[] = [];
      let offset = 0;
      let newline = chunk.indexOf("\n");
      while (newline !== -1) {
        const end = chunk.slice(offset, newline);
        const line = fragments.length === 0 ? end : [...fragments, end].join("");
        fragments = [];
        lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
        offset = newline + 1;
        newline = chunk.indexOf("\n", offset);
      }
      if (offset < chunk.length) fragments.push(chunk.slice(offset));
      return lines;
    },
    flush(): string {
      const line = fragments.join("");
      fragments = [];
      return line;
    },
  };
}
