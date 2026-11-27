import { OpenCodeApiConnection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { parseQianfanModels, QIANFAN_BASE_URL } from "./QianfanConnectionDialog";

describe("Qianfan connection", () => {
  it("reads model names separated by commas or lines, without blanks or repeats", () => {
    expect(parseQianfanModels(" ernie-5.1, ernie-speed\n\nernie-5.1 ,")).toEqual([
      "ernie-5.1",
      "ernie-speed",
    ]);
    expect(parseQianfanModels("  ")).toEqual([]);
  });

  it("builds a connection the server accepts as a helper API account", () => {
    const connection = Schema.decodeSync(OpenCodeApiConnection)({
      providerId: "t3_qianfan",
      baseUrl: QIANFAN_BASE_URL,
      protocol: "chat-completions",
      models: parseQianfanModels("ernie-5.1"),
    });
    expect(connection.baseUrl).toBe("https://qianfan.baidubce.com/v2");
    expect(connection.protocol).toBe("chat-completions");
  });
});
