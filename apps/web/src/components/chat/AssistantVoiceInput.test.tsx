import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const lifecycle = vi.hoisted(() => ({
  mounted: false,
  cleanup: undefined as undefined | (() => void),
}));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useEffect: (effect: () => void | (() => void)) => {
      if (!lifecycle.mounted) {
        lifecycle.mounted = true;
        lifecycle.cleanup = effect() || undefined;
      }
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import { AssistantVoiceInput } from "./AssistantVoiceInput";

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const button = (tree: ReturnType<typeof AssistantVoiceInput>, label: string) => {
  const found = visitElements(
    tree,
    (element) => element.type === "button" && element.props.children === label,
  );
  expect(found).not.toBeNull();
  return found!;
};

beforeEach(() => {
  hooks.reset();
  lifecycle.mounted = false;
  lifecycle.cleanup = undefined;
  vi.useFakeTimers();
});
afterEach(() => {
  lifecycle.cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("uses the latest send choice, blocks cloning during recording and permits retry after a failed transcription", async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, error: "temporary" })
    .mockResolvedValueOnce({ ok: true, text: "새 음성 전사" });
  const oldHandler = vi.fn();
  const newHandler = vi.fn();
  const paths = {
    python: "python",
    whisper: "whisper",
    qwen: "qwen",
    script: "script",
    sample: "sample",
  };
  const end = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("window", {
    desktopBridge: {
      getAssistantVoiceStatus: async () => ({
        paths,
        python: true,
        whisper: true,
        qwen: true,
        script: true,
        sample: true,
      }),
      beginAssistantVoiceRecording: async () => "recording-token",
      endAssistantVoiceRecording: end,
      runAssistantVoice: send,
    },
  });
  const stopTrack = vi.fn();
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }) },
  });
  class FakeRecorder {
    state = "inactive";
    mimeType = "audio/webm";
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    onerror?: () => void;
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["audio"]) });
      this.onstop?.();
    }
  }
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal(
    "AudioContext",
    class {
      async decodeAudioData() {
        return {
          length: 16,
          duration: 0.001,
          sampleRate: 16000,
          numberOfChannels: 1,
          getChannelData: () => new Float32Array(16),
        };
      }
      async close() {}
    },
  );
  const render = (mode: "auto" | "confirm", onTranscript: (text: string) => void) => {
    hooks.beginRender();
    return AssistantVoiceInput({ text: "마지막 답변", sendMode: mode, onTranscript });
  };
  let tree = render("auto", oldHandler);
  (button(tree, "다시 확인").props.onClick as () => void)();
  await flush();
  tree = render("auto", oldHandler);
  (button(tree, "마이크 켜기").props.onClick as () => void)();
  await flush();
  tree = render("confirm", newHandler);
  expect(button(tree, "복제 음성으로 답변 듣기").props.disabled).toBe(true);
  (button(tree, "복제 음성으로 답변 듣기").props.onClick as () => void)();
  await flush();
  expect(send).not.toHaveBeenCalled();
  (button(tree, "녹음 중지 후 전사").props.onClick as () => void)();
  await flush();
  tree = render("confirm", newHandler);
  expect(end).not.toHaveBeenCalled();
  expect(button(tree, "녹음 다시 전사").props.disabled).toBe(false);
  (button(tree, "녹음 다시 전사").props.onClick as () => void)();
  await flush();
  expect(send).toHaveBeenCalledTimes(2);
  expect(oldHandler).not.toHaveBeenCalled();
  expect(newHandler).toHaveBeenCalledWith("새 음성 전사");
  expect(end).toHaveBeenCalledWith("recording-token");
  expect(stopTrack).toHaveBeenCalled();
});

it("keeps the guard through conversion and failed transcription until the recording is deleted", async () => {
  const end = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue({ ok: false, error: "temporary" });
  let finishDecode!: (value: unknown) => void;
  const decode = new Promise((resolve) => {
    finishDecode = resolve;
  });
  vi.stubGlobal("window", {
    desktopBridge: {
      getAssistantVoiceStatus: async () => ({
        python: true,
        whisper: true,
        qwen: true,
        script: true,
        sample: true,
        paths: {},
      }),
      beginAssistantVoiceRecording: async () => "kept-token",
      endAssistantVoiceRecording: end,
      runAssistantVoice: send,
    },
  });
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) },
  });
  vi.stubGlobal(
    "MediaRecorder",
    class {
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable?: (event: { data: Blob }) => void;
      onstop?: () => void;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"]) });
        this.onstop?.();
      }
    },
  );
  vi.stubGlobal(
    "AudioContext",
    class {
      decodeAudioData() {
        return decode;
      }
      async close() {}
    },
  );
  const render = () => {
    hooks.beginRender();
    return AssistantVoiceInput({ text: "", sendMode: "confirm", onTranscript: vi.fn() });
  };
  let tree = render();
  await flush();
  tree = render();
  (button(tree, "마이크 켜기").props.onClick as () => void)();
  await flush();
  tree = render();
  (button(tree, "녹음 중지 후 전사").props.onClick as () => void)();
  await flush();
  expect(end).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  finishDecode({
    length: 16,
    duration: 0.001,
    sampleRate: 16000,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(16),
  });
  await flush();
  expect(send).toHaveBeenCalledOnce();
  expect(end).not.toHaveBeenCalled();
  tree = render();
  (button(tree, "녹음 삭제").props.onClick as () => void)();
  expect(end).toHaveBeenCalledWith("kept-token");
});

it("releases a late begin response after unmount without requesting the microphone", async () => {
  let finishBegin!: (token: string) => void;
  const begin = new Promise<string>((resolve) => {
    finishBegin = resolve;
  });
  const end = vi.fn().mockResolvedValue(undefined);
  const microphone = vi.fn();
  vi.stubGlobal("window", {
    desktopBridge: {
      getAssistantVoiceStatus: async () => ({
        python: true,
        whisper: true,
        script: true,
        paths: {},
      }),
      beginAssistantVoiceRecording: () => begin,
      endAssistantVoiceRecording: end,
    },
  });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: microphone } });
  vi.stubGlobal("MediaRecorder", class {});
  const render = () => {
    hooks.beginRender();
    return AssistantVoiceInput({ text: "", sendMode: "confirm", onTranscript: vi.fn() });
  };
  let tree = render();
  await flush();
  tree = render();
  (button(tree, "마이크 켜기").props.onClick as () => void)();
  lifecycle.cleanup?.();
  lifecycle.cleanup = undefined;
  finishBegin("late-token");
  await flush();
  expect(end).toHaveBeenCalledOnce();
  expect(end).toHaveBeenCalledWith("late-token");
  expect(microphone).not.toHaveBeenCalled();
});

it("releases the guard when the microphone request fails", async () => {
  const end = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("window", {
    desktopBridge: {
      getAssistantVoiceStatus: async () => ({
        python: true,
        whisper: true,
        script: true,
        paths: {},
      }),
      beginAssistantVoiceRecording: async () => "failed-token",
      endAssistantVoiceRecording: end,
    },
  });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => {
        throw new Error("denied");
      },
    },
  });
  vi.stubGlobal("MediaRecorder", class {});
  const render = () => {
    hooks.beginRender();
    return AssistantVoiceInput({ text: "", sendMode: "confirm", onTranscript: vi.fn() });
  };
  let tree = render();
  await flush();
  tree = render();
  (button(tree, "마이크 켜기").props.onClick as () => void)();
  await flush();
  expect(end).toHaveBeenCalledWith("failed-token");
});
