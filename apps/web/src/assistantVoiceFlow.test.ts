import { describe, expect, it, vi } from "vite-plus/test";
import { isolateVoiceContext, readPendingVoice, writePendingVoice } from "./assistantVoiceFlow";

describe("assistant voice send isolation", () => {
  it("sends only voice and preserves both drafts and their attachments through a failed attempt and retry", async () => {
    const mainDraft = {
      prompt: "main draft",
      images: [{ id: "main-image" }],
      terminalContexts: [],
      elementContexts: [],
      previewAnnotations: [],
      reviewComments: [],
    };
    const assistantDraft = {
      prompt: "unfinished assistant draft",
      images: [{ id: "assistant-image" }],
      terminalContexts: [{ id: "terminal" }],
      elementContexts: [],
      previewAnnotations: [{ id: "annotation" }],
      reviewComments: [],
    };
    const beforeMain = structuredClone(mainDraft);
    const beforeAssistant = structuredClone(assistantDraft);
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce("accepted");
    const voice = "별도로 보내는 음성 전사";
    const attempt = async () => send({ ...isolateVoiceContext(assistantDraft), prompt: voice });
    await expect(attempt()).rejects.toThrow("connection lost");
    expect(mainDraft).toEqual(beforeMain);
    expect(assistantDraft).toEqual(beforeAssistant);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      prompt: voice,
      images: [],
      terminalContexts: [],
      previewAnnotations: [],
    });
    await expect(attempt()).resolves.toBe("accepted");
    expect(send.mock.calls[1]?.[0]).toEqual(send.mock.calls[0]?.[0]);
    expect(mainDraft).toEqual(beforeMain);
    expect(assistantDraft).toEqual(beforeAssistant);
  });

  it("restores unsent transcripts per conversation and marks interrupted sends uncertain", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
    };
    expect(
      writePendingVoice(storage, "thread-a", [
        { id: "a", text: "첫 번째 전사", reason: "자동 전송을 시도합니다." },
      ]),
    ).toBe(true);
    expect(
      writePendingVoice(storage, "thread-b", [
        { id: "b", text: "두 번째 전사", reason: "연결되지 않았습니다." },
      ]),
    ).toBe(true);
    expect(readPendingVoice(storage, "thread-a")[0]).toMatchObject({
      text: "첫 번째 전사",
      reason: expect.stringContaining("수락 여부"),
    });
    expect(readPendingVoice(storage, "thread-b")[0]?.text).toBe("두 번째 전사");
    expect(writePendingVoice(storage, "thread-a", [])).toBe(true);
    expect(readPendingVoice(storage, "thread-a")).toEqual([]);
    expect(readPendingVoice(storage, "thread-b")).toHaveLength(1);
    expect(
      writePendingVoice(
        {
          setItem: () => {
            throw new Error("full");
          },
          removeItem: () => {},
        },
        "x",
        [{ id: "x", text: "보존", reason: "시도" }],
      ),
    ).toBe(false);
  });
});
