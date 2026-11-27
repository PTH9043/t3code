import * as Schema from "effect/Schema";

export const ThreadCharacter = Schema.Literals([
  "off",
  "pixel",
  "agustina",
  "vrm",
  "type95",
  "k2",
  "ots14",
  "livliv",
]);
export type ThreadCharacter = typeof ThreadCharacter.Type;
