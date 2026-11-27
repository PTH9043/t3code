import { expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import { buildModelOptions, groupByProvider } from "./modelOptions";

it("groups model choices on Android without Array.toSorted", () => {
  const options = [
    ...buildModelOptions(null, { instanceId: ProviderInstanceId.make("first"), model: "a" }),
    ...buildModelOptions(null, { instanceId: ProviderInstanceId.make("second"), model: "b" }),
  ];
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
  let keys: string[];
  try {
    Object.defineProperty(Array.prototype, "toSorted", { configurable: true, value: undefined });
    keys = groupByProvider(options).map((group) => group.providerKey);
  } finally {
    if (descriptor) Object.defineProperty(Array.prototype, "toSorted", descriptor);
    else Reflect.deleteProperty(Array.prototype, "toSorted");
  }
  expect(keys).toEqual(["first", "second"]);
  expect(options.map((option) => option.providerKey)).toEqual(["first", "second"]);
});
