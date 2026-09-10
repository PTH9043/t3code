import { expect, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

it("ships the Gemini multi-account driver", () => {
  const gemini = BUILT_IN_DRIVERS.find((driver) => driver.driverKind === "gemini");

  expect(gemini?.metadata).toMatchObject({
    displayName: "Gemini",
    supportsMultipleInstances: true,
  });
});
