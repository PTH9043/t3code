import { expect, it } from "vite-plus/test";
import { makeLineBuffer } from "./lineBuffer.ts";

it("preserves fragmented lines, CRLF and a final line without a newline", () => {
  const text = '\r\n{"first":"한글🙂"}\r\n{"second":2}\n{"last":true}';
  for (let size = 1; size <= text.length; size += 1) {
    const buffer = makeLineBuffer();
    const lines: string[] = [];
    for (let offset = 0; offset < text.length; offset += size) {
      lines.push(...buffer.push(text.slice(offset, offset + size)));
    }
    expect(lines).toEqual(["", '{"first":"한글🙂"}', '{"second":2}']);
    expect(buffer.flush()).toBe('{"last":true}');
    expect(buffer.flush()).toBe("");
    expect(buffer.push('{"next":3}\n')).toEqual(['{"next":3}']);
  }
});

it("assembles a large resume response split across thousands of chunks without losing data", () => {
  const history = "기존 대화🙂".repeat(256 * 1024);
  const wire = JSON.stringify({ id: 1, result: { history } });
  const buffer = makeLineBuffer();
  for (let offset = 0; offset < wire.length; offset += 1024) {
    expect(buffer.push(wire.slice(offset, offset + 1024))).toEqual([]);
  }
  const [line] = buffer.push("\r\n");
  expect(JSON.parse(line!)).toEqual({ id: 1, result: { history } });
  expect(buffer.flush()).toBe("");
});
