export const LIVE2D_CHARACTER_NAMES = {
  type95: "95type_405",
  k2: "k2_3301",
  ots14: "ots14_3001",
} as const;

export type Live2DCharacterKind = keyof typeof LIVE2D_CHARACTER_NAMES;

const SOURCE = "/agent-characters/live2d-models";

export function live2dCharacterSource(character: Live2DCharacterKind) {
  return `${SOURCE}/${LIVE2D_CHARACTER_NAMES[character]}/normal/normal.model3.json`;
}

export function live2dCharacterMotion(character: Live2DCharacterKind, working: boolean) {
  if (!working) return 0;
  return character === "type95" ? 9 : 8;
}
