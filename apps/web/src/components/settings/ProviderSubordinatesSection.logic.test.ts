import { ProviderInstanceId, type SubordinateAssignment } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  accountSubordinates,
  applyDraft,
  canonicalName,
  claudeWorkerValue,
  commitDraft,
  decidingAssignment,
  draftText,
  formatHelperModelNames,
  formatModelAssignments,
  helperAccountOptions,
  helperModelChoices,
  isCodexSubagentValue,
  isDraftDirty,
  listHelperApiAccounts,
  modelsDecidedByAssignments,
  nextUnassignedModel,
  parseHelperModelNames,
  parseModelAssignments,
  resolveHelperAccount,
  subordinateKey,
  toggleHelperModel,
  withSavedOption,
  withSubordinateAt,
  withSubordinateForModel,
} from "./ProviderSubordinatesSection.logic";

const usable = (value: string) => value.length > 0;

describe("answering-model assignment text", () => {
  it("round-trips entries written with any of the server's separators", () => {
    const rows = parseModelAssignments("gpt-6-sol=gpt-6-luna; terra: inherit\nopus = sonnet");
    expect(rows).toEqual([
      { model: "gpt-6-sol", value: "gpt-6-luna" },
      { model: "terra", value: "inherit" },
      { model: "opus", value: "sonnet" },
    ]);
    const text = formatModelAssignments(rows);
    expect(text).toBe("gpt-6-sol=gpt-6-luna, terra=inherit, opus=sonnet");
    expect(parseModelAssignments(text)).toEqual(rows);
  });

  it("keeps entries the server ignores instead of dropping them", () => {
    const rows = parseModelAssignments("opus=sonnet, just-a-name, =haiku, fable=");
    expect(rows).toEqual([
      { model: "opus", value: "sonnet" },
      { model: "just-a-name", value: "" },
      { model: "", value: "haiku" },
      { model: "fable", value: "" },
    ]);
    expect(parseModelAssignments(formatModelAssignments(rows))).toEqual([
      { model: "just-a-name", value: "" },
      { model: "fable", value: "" },
      { model: "opus", value: "sonnet" },
      { model: "", value: "haiku" },
    ]);
  });

  it("keeps a value that itself contains a separator character", () => {
    expect(parseModelAssignments("gpt-6-sol=vendor/model:tag")).toEqual([
      { model: "gpt-6-sol", value: "vendor/model:tag" },
    ]);
  });

  it("writes longer names first so a contained id cannot shadow them", () => {
    expect(
      formatModelAssignments([
        { model: "gpt-6-sol", value: "gpt-6-luna" },
        { model: "opus", value: "haiku" },
        { model: "gpt-6-sol-mini", value: "inherit" },
        { model: "gpt-6-sun", value: "gpt-6-sol" },
      ]),
    ).toBe("gpt-6-sol-mini=inherit, gpt-6-sol=gpt-6-luna, gpt-6-sun=gpt-6-sol, opus=haiku");
  });

  it("reports which account models each entry decides, first match winning", () => {
    const models = ["gpt-6-sol", "gpt-6-sol-mini", "gpt-6-luna"];
    expect(
      modelsDecidedByAssignments(
        [
          { model: "gpt-6-sol", value: "gpt-6-luna" },
          { model: "SOL-MINI", value: "inherit" },
          { model: "luna", value: "" },
        ],
        models,
        usable,
      ),
    ).toEqual([["gpt-6-sol", "gpt-6-sol-mini"], [], []]);
    expect(
      modelsDecidedByAssignments(
        [
          { model: "opus", value: "not-a-worker" },
          { model: "opus", value: "haiku" },
        ],
        ["claude-opus-5-5"],
        (value) => claudeWorkerValue(value) !== undefined,
      ),
    ).toEqual([[], ["claude-opus-5-5"]]);
  });

  it("finds the entry in effect for a model, so a new row can repeat its value", () => {
    const rows = [
      { model: "opus", value: "not-a-worker" },
      { model: "opus", value: "sonnet" },
    ];
    const isWorker = (value: string) => claudeWorkerValue(value) !== undefined;
    expect(decidingAssignment(rows, "claude-opus-5-5", isWorker)).toBe(1);
    expect(decidingAssignment(rows, "claude-haiku-5", isWorker)).toBe(-1);
  });

  it("offers the first model without its own entry and skips ids the text cannot hold", () => {
    const rows = [{ model: "GPT-6-SOL", value: "inherit" }];
    expect(nextUnassignedModel(rows, ["gpt-6-sol", "vendor:model", "gpt-6-luna"])).toBe(
      "gpt-6-luna",
    );
    expect(nextUnassignedModel(rows, ["gpt-6-sol"])).toBeUndefined();
  });

  it("maps saved names and worker values onto known ids without changing unknown ones", () => {
    expect(canonicalName("GPT-6-Sol", ["gpt-6-sol", "gpt-6-luna"])).toBe("gpt-6-sol");
    expect(canonicalName("opus", ["claude-opus-5-5"])).toBe("opus");
    expect(claudeWorkerValue(" Sonnet ")).toBe("sonnet");
    expect(claudeWorkerValue("gpt-6")).toBeUndefined();
    expect(claudeWorkerValue("constructor")).toBeUndefined();
    expect(claudeWorkerValue(undefined)).toBeUndefined();
    expect(isCodexSubagentValue("gpt-6-luna")).toBe(true);
    expect(isCodexSubagentValue("two words")).toBe(false);
  });

  it("shows a saved value that is not offered as an extra option", () => {
    const options = [{ value: "gpt-6-sol", label: "GPT-6 Sol" }];
    expect(withSavedOption(options, "gpt-6-sol", (saved) => saved)).toBe(options);
    expect(withSavedOption(options, "retired", (saved) => `${saved} (목록에 없음)`)).toEqual([
      ...options,
      { value: "retired", label: "retired (목록에 없음)" },
    ]);
  });
});

describe("helper API account", () => {
  const accounts = listHelperApiAccounts({
    codex: { driver: "codex", config: { apiConnection: { models: ["x"] } } },
    opencode: { driver: "opencode", config: {} },
    opencode_baidu: {
      driver: "opencode",
      displayName: "Baidu",
      config: { apiConnection: { protocol: "chat-completions", models: ["ernie-5.1", "ernie:x"] } },
    },
    opencode_off: {
      driver: "opencode",
      enabled: false,
      config: { apiConnection: { protocol: "chat-completions", models: ["m"] } },
    },
    opencode_resp: {
      driver: "opencode",
      config: { apiConnection: { protocol: "responses", models: ["r1"] } },
    },
  });

  it("lists only enabled OpenCode accounts with an API connection", () => {
    expect(accounts).toEqual([
      {
        instanceId: "opencode_baidu",
        displayName: "Baidu",
        models: ["ernie-5.1", "ernie:x"],
        supported: true,
      },
      {
        instanceId: "opencode_resp",
        displayName: "opencode_resp",
        models: ["r1"],
        supported: false,
      },
    ]);
    expect(listHelperApiAccounts(undefined)).toEqual([]);
  });

  it("offers one option per model and disables an unsupported protocol", () => {
    expect(helperAccountOptions(accounts)).toEqual([
      { value: "", label: "사용 안 함" },
      { value: "opencode_baidu:ernie-5.1", label: "Baidu · ernie-5.1" },
      { value: "opencode_baidu:ernie:x", label: "Baidu · ernie:x" },
      {
        value: "opencode_resp:r1",
        label: "opencode_resp · r1 (Chat Completions 형식만 지원)",
        disabled: true,
      },
    ]);
  });

  it("resolves a saved display name or id to the id-based option", () => {
    expect(resolveHelperAccount("Baidu:ernie-5.1", accounts)).toBe("opencode_baidu:ernie-5.1");
    expect(resolveHelperAccount(" baidu : ernie:x ", accounts)).toBe("opencode_baidu:ernie:x");
    expect(resolveHelperAccount("OPENCODE_BAIDU:ernie-5.1", accounts)).toBe(
      "opencode_baidu:ernie-5.1",
    );
  });

  it("returns what it cannot resolve unchanged", () => {
    expect(resolveHelperAccount("Baidu:gone-model", accounts)).toBe("Baidu:gone-model");
    expect(resolveHelperAccount("Nobody:ernie-5.1", accounts)).toBe("Nobody:ernie-5.1");
    expect(resolveHelperAccount("no-colon", accounts)).toBe("no-colon");
    expect(resolveHelperAccount("", accounts)).toBe("");
  });
});

describe("helper answering-model list", () => {
  const models = ["claude-opus-5-5", "claude-opus-4-8", "claude-sonnet-5", "claude-sonnet-5-pro"];

  it("round-trips the saved names", () => {
    const names = parseHelperModelNames("opus; claude-sonnet-5\nretired");
    expect(names).toEqual(["opus", "claude-sonnet-5", "retired"]);
    expect(formatHelperModelNames(names)).toBe("opus, claude-sonnet-5, retired");
    expect(parseHelperModelNames("")).toEqual([]);
  });

  it("marks models allowed by a partial name and surfaces names that match nothing", () => {
    expect(helperModelChoices(["opus", "claude-sonnet-5", "retired"], models)).toEqual({
      models: [
        { slug: "claude-opus-5-5", checked: true, locked: false },
        { slug: "claude-opus-4-8", checked: true, locked: false },
        { slug: "claude-sonnet-5", checked: true, locked: false },
        { slug: "claude-sonnet-5-pro", checked: true, locked: true },
      ],
      unknown: ["retired"],
    });
  });

  it("narrows a partial name to the other models when one is turned off", () => {
    expect(toggleHelperModel(["opus", "retired"], models, "claude-opus-4-8", false)).toEqual([
      "retired",
      "claude-opus-5-5",
    ]);
  });

  it("adds a model once and removes its own name", () => {
    expect(toggleHelperModel([], models, "claude-sonnet-5", true)).toEqual(["claude-sonnet-5"]);
    expect(toggleHelperModel(["opus"], models, "claude-opus-5-5", true)).toEqual(["opus"]);
    expect(toggleHelperModel(["claude-opus-4-8"], models, "claude-opus-4-8", false)).toEqual([]);
  });

  it("keeps a longer id allowed when the id it contains is turned off", () => {
    expect(toggleHelperModel(["claude-sonnet-5"], models, "claude-sonnet-5", false)).toEqual([
      "claude-sonnet-5-pro",
    ]);
  });
});

describe("config draft", () => {
  const config = { binaryPath: "codex", subagentModel: "gpt-6-luna", helperScope: "project" };

  it("reads the draft over the saved value", () => {
    expect(draftText(config, {}, "subagentModel")).toBe("gpt-6-luna");
    expect(draftText(config, { subagentModel: "" }, "subagentModel")).toBe("");
    expect(draftText(config, {}, "helperAccount")).toBe("");
  });

  it("is dirty only when a drafted key differs from what is saved", () => {
    expect(isDraftDirty(config, {})).toBe(false);
    expect(isDraftDirty(config, { subagentModel: "gpt-6-luna", helperAccount: " " })).toBe(false);
    expect(isDraftDirty(config, { subagentModel: "gpt-6-sol" })).toBe(true);
    expect(isDraftDirty(undefined, { helperAccount: "opencode_baidu:ernie-5.1" })).toBe(true);
  });

  it("saves every drafted key with a single write and leaves other keys alone", () => {
    const onChange = vi.fn();
    commitDraft(
      config,
      {
        subagentModel: "",
        subagentModelByModel: "gpt-6-sol=inherit",
        helperScope: "project",
        helperAccount: "opencode_baidu:ernie-5.1",
      },
      onChange,
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      binaryPath: "codex",
      helperScope: "project",
      subagentModelByModel: "gpt-6-sol=inherit",
      helperAccount: "opencode_baidu:ernie-5.1",
    });
  });

  it("writes nothing when the draft changes nothing", () => {
    const onChange = vi.fn();
    commitDraft(config, { subagentModel: "gpt-6-luna" }, onChange);
    commitDraft(config, {}, onChange);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("removes a key when its text becomes empty and keeps unrelated keys", () => {
    expect(applyDraft(config, { subagentModel: " ", helperScope: "" })).toEqual({
      binaryPath: "codex",
    });
    expect(applyDraft(config, { subagentModel: " gpt-6-sol " })).toEqual({
      ...config,
      subagentModel: "gpt-6-sol",
    });
  });

  it("drops the config when the last key is cleared", () => {
    expect(applyDraft({ helperScope: "project" }, { helperScope: "" })).toBe(undefined);
    expect(applyDraft(undefined, {})).toBe(undefined);
  });
});

describe("subordinates", () => {
  const claude = ProviderInstanceId.make("claudeAgent");
  const codex = ProviderInstanceId.make("codex");
  const subordinate: SubordinateAssignment = {
    answeringInstanceId: claude,
    instanceId: ProviderInstanceId.make("codex_work"),
    model: "gpt-6-luna",
    role: "advisor",
  };
  const all: ReadonlyArray<SubordinateAssignment> = [
    { ...subordinate, answeringInstanceId: codex, role: "scout" },
    subordinate,
    { ...subordinate, answeringInstanceId: codex, role: "worker" },
    { ...subordinate, forModel: "claude-opus-5-5", role: "worker" },
  ];

  it("shows only the answering account's rows, with their place in the whole list", () => {
    expect(accountSubordinates(all, claude)).toEqual([
      { index: 1, subordinate: all[1] },
      { index: 3, subordinate: all[3] },
    ]);
    expect(accountSubordinates(all, "codex_other")).toEqual([]);
  });

  it("replaces one row in the whole list without touching other accounts' rows", () => {
    const edited: SubordinateAssignment = { ...subordinate, role: "scout" };
    const next = withSubordinateAt(all, 1, edited);
    expect(next).toEqual([all[0], edited, all[2], all[3]]);
    expect(next[0]).toBe(all[0]);
    expect(next[2]).toBe(all[2]);
  });

  it("removes one row and keeps the rest, down to an empty list", () => {
    expect(withSubordinateAt(all, 3, undefined)).toEqual([all[0], all[1], all[2]]);
    expect(withSubordinateAt([subordinate], 0, undefined)).toEqual([]);
  });

  it("drops forModel for 'every answering model' and sets it otherwise", () => {
    const scoped = withSubordinateForModel(subordinate, "claude-opus-5-5");
    expect(scoped).toEqual({ ...subordinate, forModel: "claude-opus-5-5" });
    expect(withSubordinateForModel(scoped, "")).toEqual(subordinate);
    expect(withSubordinateForModel(scoped, "")).not.toHaveProperty("forModel");
  });

  it("keys an account model unambiguously", () => {
    expect(subordinateKey("a:b", "c")).not.toBe(subordinateKey("a", "b:c"));
  });
});
