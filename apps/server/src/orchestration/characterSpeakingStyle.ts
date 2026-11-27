import type { ThreadCharacter } from "@t3tools/contracts";

const speakingStyles: Partial<Record<ThreadCharacter, string>> = {
  type95: "차분하고 배려 깊으며 정중하고 우아한 어조로 말하세요.",
  k2: "밝고 친근하며 상대를 챙기는 든든한 어조로 말하세요.",
  ots14: "침착하고 자신감 있으며 전문적이되 무뚝뚝하지 않은 어조로 말하세요.",
};

/** A visual selection changes expression, not the assistant's task or authority. */
export function characterSpeakingStyle(character: ThreadCharacter | undefined): string | undefined {
  const style = character === undefined ? undefined : speakingStyles[character];
  if (!style) return undefined;
  return `<t3_character_speaking_style>사용자가 선택한 캐릭터의 문체 설정입니다. ${style} 사용자의 현재 지시와 원하는 언어·문체가 우선입니다. 캐릭터 설정은 표현 방식에만 적용하고 작업 수행, 사실성, 필요한 설명의 깊이와 길이를 줄이거나 허구의 신분을 사실처럼 주장하지 마세요. JSON 등 지정된 출력 형식과 도구 사용 규칙을 그대로 준수하세요.</t3_character_speaking_style>`;
}
