// @effect-diagnostics nodeBuiltinImport:off - Verify the sample handlers against disposable local files.
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
const enginePath = new URL("../../../../desktop/src/assistant/LocalVoiceEngine.ts", import.meta.url)
  .href;
const { beginVoiceSampleUpdate, deleteVoiceSample, saveVoiceSample } = await import(
  /* @vite-ignore */ enginePath
);

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useEffect: (effect: () => void) => {
      effect();
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import { AssistantVoiceSampleSettings } from "./AssistantVoiceInput";

const dirs: string[] = [];
beforeEach(() => hooks.reset());
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) {
    if (!path.basename(dir).startsWith("t3-voice-race-"))
      throw new Error("Unexpected temporary directory");
    await fs.rm(dir, { recursive: true, force: true });
  }
});
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

it("does not restore an old selection after settings remount and deletion in another window", async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "t3-voice-race-"));
  dirs.push(root);
  const original = Buffer.alloc(48);
  original.write("RIFF", 0);
  original.write("WAVE", 8);
  expect(
    (await saveVoiceSample(root, original.toString("base64"), beginVoiceSampleUpdate(root))).ok,
  ).toBe(true);
  let decodeStarted!: () => void;
  let finishDecode!: (value: unknown) => void;
  let deletionFinished!: () => void;
  let saveFinished!: (value: { ok: boolean; error?: string }) => void;
  const decoding = new Promise<void>((resolve) => {
    decodeStarted = resolve;
  });
  const decodeGate = new Promise((resolve) => {
    finishDecode = resolve;
  });
  const deleted = new Promise<void>((resolve) => {
    deletionFinished = resolve;
  });
  const saved = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    saveFinished = resolve;
  });
  let present = true;
  vi.stubGlobal(
    "AudioContext",
    class {
      decodeAudioData() {
        decodeStarted();
        return decodeGate;
      }
      async close() {}
    },
  );
  vi.stubGlobal("window", {
    desktopBridge: {
      getAssistantVoiceStatus: async () => ({ sample: present, paths: { sample: root } }),
      beginAssistantVoiceSample: async () => beginVoiceSampleUpdate(root),
      saveAssistantVoiceSample: async ({ audio, token }: { audio: string; token: string }) => {
        const result = await saveVoiceSample(root, audio, token);
        saveFinished(result);
        return result;
      },
      deleteAssistantVoiceSample: async () => {
        const result = await deleteVoiceSample(root);
        present = false;
        deletionFinished();
        return result;
      },
    },
  });
  const render = () => {
    hooks.beginRender();
    return AssistantVoiceSampleSettings();
  };
  let tree = render();
  await flush();
  tree = render();
  const input = visitElements(
    tree,
    (element) => element.type === "input" && element.props.type === "file",
  );
  expect(input).not.toBeNull();
  (input!.props.onChange as (event: unknown) => void)({
    currentTarget: { files: [new Blob(["sample"])], value: "sample.wav" },
  });
  await decoding;
  hooks.reset();
  tree = render();
  await flush();
  tree = render();
  const remove = visitElements(
    tree,
    (element) => element.type === "button" && element.props.children === "저장된 샘플 삭제",
  );
  expect(remove?.props.disabled).toBe(false);
  (remove!.props.onClick as () => void)();
  await deleted;
  finishDecode({
    length: 16,
    duration: 0.001,
    sampleRate: 16000,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(16),
  });
  expect((await saved).ok).toBe(false);
  expect(
    await fs.stat(path.join(root, "assistant-voice-sample.wav")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});

it("shows that the sample was saved when old-backup cleanup needs attention", async () => {
  let finish!: () => void;
  const saved = new Promise<void>((resolve) => {
    finish = resolve;
  });
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
  vi.stubGlobal("window", {
    desktopBridge: {
      getAssistantVoiceStatus: async () => ({ sample: true, paths: { sample: "sample.wav" } }),
      beginAssistantVoiceSample: async () => "token",
      saveAssistantVoiceSample: async () => {
        finish();
        return { ok: true, warning: "샘플을 저장했지만 임시 백업을 정리하지 못했습니다." };
      },
    },
  });
  const render = () => {
    hooks.beginRender();
    return AssistantVoiceSampleSettings();
  };
  let tree = render();
  await flush();
  tree = render();
  const input = visitElements(
    tree,
    (element) => element.type === "input" && element.props.type === "file",
  );
  (input!.props.onChange as (event: unknown) => void)({
    currentTarget: { files: [new Blob(["sample"])], value: "sample.wav" },
  });
  await saved;
  await flush();
  tree = render();
  const status = visitElements(tree, (element) => element.props.role === "status");
  expect(status?.props.children).toContain("저장했지만 임시 백업");
});
