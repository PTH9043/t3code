export type PendingVoice = { id: string; text: string; reason: string };

export function isolateVoiceContext<
  T extends {
    images: unknown[];
    terminalContexts: unknown[];
    elementContexts: unknown[];
    previewAnnotations: unknown[];
    reviewComments: unknown[];
  },
>(draft: T): T {
  return {
    ...draft,
    images: [],
    terminalContexts: [],
    elementContexts: [],
    previewAnnotations: [],
    reviewComments: [],
  };
}

export function readPendingVoice(storage: Pick<Storage, "getItem">, key: string): PendingVoice[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (entry) =>
          entry &&
          typeof entry.id === "string" &&
          typeof entry.text === "string" &&
          typeof entry.reason === "string",
      )
      .map((entry) => ({
        ...entry,
        reason: entry.reason.includes("시도")
          ? "이전 전송의 수락 여부를 확인하지 못했습니다. 대화 내역을 확인한 뒤 다시 보내세요."
          : entry.reason,
      }));
  } catch {
    return [];
  }
}

export function writePendingVoice(
  storage: Pick<Storage, "setItem" | "removeItem">,
  key: string,
  entries: PendingVoice[],
): boolean {
  try {
    if (entries.length) storage.setItem(key, JSON.stringify(entries));
    else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
