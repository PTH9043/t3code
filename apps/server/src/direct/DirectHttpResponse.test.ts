import * as NodeStream from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { prepareDirectHttpResponse } from "./DirectHttpResponse.ts";

describe("direct HTTP response conversion", () => {
  it("streams a Node file response with its status and headers intact", async () => {
    const response = HttpServerResponse.raw(NodeStream.Readable.from([Buffer.from("attachment")]), {
      status: 206,
      headers: { "content-type": "image/png", "content-length": "10" },
    });
    const prepared = prepareDirectHttpResponse(response);
    expect(prepared.body._tag).toBe("Stream");
    const webResponse = HttpServerResponse.toWeb(prepared);
    expect(webResponse.status).toBe(206);
    expect(webResponse.headers.get("content-type")).toBe("image/png");
    expect(webResponse.headers.get("content-length")).toBe("10");
    expect(await webResponse.text()).toBe("attachment");
  });

  it("releases the Node stream when a direct request is cancelled", async () => {
    const readable = new NodeStream.Readable({ read() {} });
    const response = HttpServerResponse.toWeb(
      prepareDirectHttpResponse(HttpServerResponse.raw(readable)),
    );
    const reader = response.body!.getReader();
    const pending = reader.read();
    await reader.cancel();
    await pending;
    expect(readable.destroyed).toBe(true);
  });

  it("does not alter non-Node responses", () => {
    const response = HttpServerResponse.text("ok");
    expect(prepareDirectHttpResponse(response)).toBe(response);
  });
});
