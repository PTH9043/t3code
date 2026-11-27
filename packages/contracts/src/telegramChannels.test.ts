import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { TelegramChannelReference, TelegramChannelsManageInput } from "./telegramChannels.ts";

it("accepts public channel references and exact marked peer IDs without integer rounding", () => {
  const valid = Schema.is(TelegramChannelReference);
  for (const value of [
    "@Example",
    "t.me/example",
    "https://t.me/example/",
    "-1000000000001",
    "-1012345678901",
    "-9223372036854775807",
  ])
    expect(valid(value)).toBe(true);
  for (const value of [
    "",
    "Some title",
    "12345",
    "-12",
    "-1000000000000",
    "-9223372036854775808",
    "https://t.me/+secret",
    "t.me/joinchat/secret",
    "https://example.test/example",
    "t.me/example/321",
  ])
    expect(valid(value)).toBe(false);
});

it("requires a project for every action and a complete exact CLI approval to enable fallback", () => {
  const valid = Schema.is(TelegramChannelsManageInput);
  const target = { projectId: "project", registrationId: "-1000000000001" };
  for (const action of ["pause", "resume", "sync", "retry", "remove"]) {
    expect(valid({ action, ...target })).toBe(true);
    expect(valid({ action, registrationId: target.registrationId })).toBe(false);
  }
  const change = { ...target, action: "setPolicy" };
  expect(valid({ ...change, policy: null })).toBe(true);
  expect(
    valid({
      ...change,
      policy: { instanceId: "cli", modelId: "exact", allowExternalTransfer: true },
    }),
  ).toBe(true);
  for (const policy of [
    { instanceId: "cli", modelId: "exact", allowExternalTransfer: false },
    { instanceId: "cli", modelId: "exact" },
    { modelId: "exact", allowExternalTransfer: true },
    { instanceId: "cli", allowExternalTransfer: true },
  ])
    expect(valid({ ...change, policy })).toBe(false);
  expect(valid({ action: "lookup", projectId: "project", title: "Same title" })).toBe(true);
  expect(valid({ action: "lookup", projectId: "project", title: "" })).toBe(false);
  expect(valid({ action: "register", projectId: "project", channel: "Same title" })).toBe(false);
  expect(valid({ ...target, action: "send", text: "example" })).toBe(false);
});
