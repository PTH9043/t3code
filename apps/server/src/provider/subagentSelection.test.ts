import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  buildSubordinateRoster,
  helperAllowedForModel,
  parseHelperAccount,
  parseModelAssignments,
  resolveAccountSubordinates,
  resolveConductorWorkerForModel,
  resolveTurnDelegateTeam,
  turnDelegateInstructions,
  resolveSubagentModelForModel,
  subordinatesForModel,
  type SubordinateSettingsSource,
} from "./subagentSelection.ts";

describe("subagent selection", () => {
  it("reads per-model assignments and ignores malformed entries", () => {
    expect(
      parseModelAssignments("opus=sonnet, sonnet : haiku\nfable=off; =x, broken, haiku="),
    ).toEqual([
      { model: "opus", value: "sonnet" },
      { model: "sonnet", value: "haiku" },
      { model: "fable", value: "off" },
    ]);
    expect(parseModelAssignments(undefined)).toEqual([]);
  });

  it("gives each answering model the worker assigned to it", () => {
    const byModel = "opus=sonnet, sonnet=haiku, fable=off";
    const worker = (model: string | undefined) =>
      resolveConductorWorkerForModel({ fallback: "opus", byModel, model });
    expect(worker("claude-opus-5-5")).toBe("sonnet");
    expect(worker("claude-SONNET-5-5")).toBe("haiku");
    expect(worker("claude-fable-5-2")).toBe("off");
    // A model the person did not mention, or an unknown one, keeps the default.
    expect(worker("claude-haiku-5-5")).toBe("opus");
    expect(worker(undefined)).toBe("opus");
  });

  it("skips an assignment whose value is not a worker model", () => {
    expect(
      resolveConductorWorkerForModel({
        fallback: undefined,
        byModel: "opus=gpt-6, opus=haiku",
        model: "claude-opus-5-5",
      }),
    ).toBe("haiku");
    expect(
      resolveConductorWorkerForModel({ fallback: "inherit", byModel: "opus=gpt-6", model: "opus" }),
    ).toBe("inherit");
  });

  it("gives each answering model the sub-agent model assigned to it", () => {
    const byModel = "gpt-6-sol=gpt-6-luna, terra=inherit, astra=not a model, astra=gpt-5.6-luna";
    const subagent = (model: string | undefined, fallback?: string) =>
      resolveSubagentModelForModel({ fallback, byModel, model });
    expect(subagent("gpt-6-sol")).toBe("gpt-6-luna");
    expect(subagent("gpt-6-sol", "gpt-5.6-luna")).toBe("gpt-6-luna");
    // `inherit` keeps the answering model even when the account has a default.
    expect(subagent("gpt-6.1-terra", "gpt-6-luna")).toBeUndefined();
    // A value that is not a model id is skipped; the next assignment applies.
    expect(subagent("gpt-6-astra")).toBe("gpt-5.6-luna");
    // A model the person did not mention keeps the account default.
    expect(subagent("gpt-6.1-sol", "gpt-6-luna")).toBe("gpt-6-luna");
    expect(subagent("gpt-6.1-sol")).toBeUndefined();
    expect(subagent(undefined, 'x" -c evil=1')).toBeUndefined();
  });

  it("allows the helper for every model unless a list names specific ones", () => {
    expect(helperAllowedForModel(undefined, "gpt-6.1-sol")).toBe(true);
    expect(helperAllowedForModel("  ", undefined)).toBe(true);
    expect(helperAllowedForModel("opus, sol", "gpt-6.1-Sol")).toBe(true);
    expect(helperAllowedForModel("opus, sol", "claude-haiku-5-5")).toBe(false);
    expect(helperAllowedForModel("opus", undefined)).toBe(false);
  });

  it("splits a helper account from its model", () => {
    expect(parseHelperAccount(" Baidu : ernie-5.1 ")).toEqual({
      account: "Baidu",
      model: "ernie-5.1",
    });
    expect(parseHelperAccount("Baidu:vendor:model")).toEqual({
      account: "Baidu",
      model: "vendor:model",
    });
    expect(parseHelperAccount("Baidu")).toBeUndefined();
    expect(parseHelperAccount(":ernie")).toBeUndefined();
    expect(parseHelperAccount(undefined)).toBeUndefined();
  });
});

describe("subordinate models", () => {
  const claude = ProviderInstanceId.make("claudeAgent");
  const codex = ProviderInstanceId.make("codex");
  const work = ProviderInstanceId.make("codex_work");
  const source: SubordinateSettingsSource = {
    subordinateModels: [
      { answeringInstanceId: claude, instanceId: work, model: "gpt-6-sol", role: "worker" },
      {
        answeringInstanceId: claude,
        forModel: "claude-opus-5-5",
        instanceId: codex,
        model: "gpt-6-astra",
        role: "advisor",
      },
      { answeringInstanceId: claude, instanceId: codex, model: "gpt-6.1-terra", role: "scout" },
      // Subordinate accounts that are gone or switched off.
      {
        answeringInstanceId: claude,
        instanceId: ProviderInstanceId.make("removed"),
        model: "x",
        role: "worker",
      },
      {
        answeringInstanceId: claude,
        instanceId: ProviderInstanceId.make("off"),
        model: "x",
        role: "worker",
      },
      {
        answeringInstanceId: claude,
        instanceId: ProviderInstanceId.make("grok"),
        model: "x",
        role: "scout",
      },
      // Another answering account's row.
      { answeringInstanceId: codex, instanceId: work, model: "gpt-6-luna", role: "worker" },
    ],
    providerInstances: {
      codex_work: { displayName: " Codex Work " },
      off: { enabled: false },
    },
    // The default account of a driver may exist only in the legacy settings.
    providers: { codex: { enabled: true }, grok: { enabled: false } },
  };

  it("resolves an account's subordinates, dropping missing and disabled accounts", () => {
    expect(resolveAccountSubordinates(source, claude)).toEqual([
      { role: "worker", account: "Codex Work", instanceId: work, model: "gpt-6-sol" },
      {
        forModel: "claude-opus-5-5",
        role: "advisor",
        account: "codex",
        instanceId: codex,
        model: "gpt-6-astra",
      },
      { role: "scout", account: "codex", instanceId: codex, model: "gpt-6.1-terra" },
    ]);
    expect(resolveAccountSubordinates(source, codex).map((row) => row.model)).toEqual([
      "gpt-6-luna",
    ]);
    expect(resolveAccountSubordinates(source, "constructor")).toEqual([]);
  });

  it("applies a per-model row only while that model answers", () => {
    const rows = resolveAccountSubordinates(source, claude);
    const roles = (model: string | undefined) =>
      subordinatesForModel(rows, model).map((row) => row.role);
    expect(roles("Claude-Opus-5-5")).toEqual(["worker", "advisor", "scout"]);
    expect(roles("claude-sonnet-5-5")).toEqual(["worker", "scout"]);
    // Without a known answering model only the rows for every model apply.
    expect(roles(undefined)).toEqual(["worker", "scout"]);
    // The same subordinate listed twice counts once.
    expect(subordinatesForModel([...rows, rows[0]!], undefined)).toHaveLength(2);
  });

  it("keeps the global roster across rooms, answering accounts, and models", () => {
    const scope = {
      threadId: ThreadId.make("room"),
      answeringInstanceId: claude,
      forModel: "opus",
    };
    const member = {
      role: "worker",
      instanceId: work,
      model: "exact",
      instructions: "Inspect sync.",
    } as const;
    const off = { ...member, instanceId: ProviderInstanceId.make("off") };
    const settings = {
      ...source,
      threadModelTeams: [{ ...scope, members: [] }],
      globalSubordinateTeam: [member, off],
    };
    const team = resolveTurnDelegateTeam(settings, scope);
    expect(team.source).toBe("global");
    expect(team.members).toEqual([
      { ...member, account: "Codex Work" },
      { ...off, account: "off", unavailable: true },
    ]);
    expect(turnDelegateInstructions(team, true)).toContain(member.instructions);
    expect(turnDelegateInstructions(team, true)).toContain("Account unavailable");
    expect(turnDelegateInstructions(team, false)).toContain("worker@off:exact");
    const changed = { ...scope, answeringInstanceId: codex, forModel: "other-model" };
    expect(resolveTurnDelegateTeam(settings, changed).members).toEqual(team.members);
    expect(resolveTurnDelegateTeam(source, scope).members).toEqual([]);
  });

  it("ignores legacy per-conversation custom teams and always applies the unified global roster", () => {
    const scope = {
      threadId: ThreadId.make("room"),
      answeringInstanceId: claude,
      forModel: "opus",
    };
    const global = { role: "worker", instanceId: work, model: "exact" } as const;
    const own = {
      role: "tester",
      instanceId: codex,
      model: "checker",
      instructions: "Run the unit tests.",
    } as const;
    const settings = {
      ...source,
      globalSubordinateTeam: [global],
      threadSubordinateTeams: { [scope.threadId]: [own] },
    };
    const resolved = resolveTurnDelegateTeam(settings, scope);
    expect(resolved.source).toBe("global");
    expect(resolved.members).toEqual([{ ...global, account: "Codex Work" }]);
    expect(
      resolveTurnDelegateTeam(settings, { ...scope, answeringInstanceId: codex, forModel: "other" })
        .members,
    ).toEqual(resolved.members);
    const other = resolveTurnDelegateTeam(settings, { ...scope, threadId: ThreadId.make("other") });
    expect(other).toMatchObject({
      source: "global",
      members: [{ ...global, account: "Codex Work" }],
    });
    expect(
      resolveTurnDelegateTeam({ ...settings, threadSubordinateTeams: { room: [] } }, scope),
    ).toMatchObject({ source: "global", members: [{ ...global, account: "Codex Work" }] });
  });

  it("tells the answering model what every role is for", () => {
    const roles = [
      "worker",
      "advisor",
      "scout",
      "planner",
      "tester",
      "writer",
      "diagnostician",
      "analyst",
      "translator",
    ] as const;
    const roster = buildSubordinateRoster(
      roles.map((role) => ({ role, account: "codex", instanceId: codex, model: role + "-model" })),
    )!;
    const purposes = roles.map(
      (role) =>
        roster
          .split("\n")
          .find((line) => line.startsWith("- " + role + " — "))!
          .split(" — ")[2],
    );
    expect(new Set(purposes).size).toBe(roles.length);
    expect(roster).toContain(
      "- planner — codex · planner-model — proposes a design, dependencies and acceptance criteria",
    );
    expect(roster).toContain(
      "- tester — codex · tester-model — runs scoped checks and reports evidence",
    );
    expect(roster).toContain(
      "- writer — codex · writer-model — writes or edits only the documentation assigned to it",
    );
    expect(roster).toContain('Exact to: "planner@codex:planner-model"');
  });

  it("builds the roster block only when there are subordinates", () => {
    expect(buildSubordinateRoster([])).toBeUndefined();
    const roster = buildSubordinateRoster([
      { role: "worker", account: "Codex\nWork", instanceId: work, model: "gpt-6-sol" },
      { role: "advisor", account: "codex", instanceId: codex, model: "gpt-6-astra" },
    ]);
    expect(roster).toMatch(/^<subordinate_models>\n[\s\S]*\n<\/subordinate_models>$/);
    expect(roster).toContain("- worker — Codex Work · gpt-6-sol — ");
    expect(roster).toContain("- advisor — codex · gpt-6-astra — ");
    expect(roster).toContain("`workspace_delegate` tool of the t3-code MCP server");
    // Delegating comes first; the exception for small tasks follows it and stays one sentence.
    expect(roster).not.toContain("Do NOT delegate");
    expect(roster!.indexOf("delegate that part first")).toBeGreaterThan(0);
    expect(roster).toContain("nothing obliges you to delegate");
    expect(roster!.indexOf("Small tasks are yours to do directly")).toBeGreaterThan(
      roster!.indexOf("delegate that part first"),
    );
    expect(roster).toContain("you stay responsible for the result");
    expect(roster).toContain("Only you (the supervisor) can call `workspace_delegate`");
    expect(roster).toContain("Use `advisor` for fast, focused single-pass reviews");
    expect(roster).not.toContain("actively delegate independent verification");

    const fullRoster = buildSubordinateRoster([
      { role: "tester", account: "Antseed", instanceId: work, model: "deepseek-v4.1-flash-1017" },
      { role: "writer", account: "Ollama", instanceId: codex, model: "qwen2.5-coder:14b" },
    ])!;
    expect(fullRoster).toContain("actively delegate independent verification");
    expect(fullRoster).toContain("actively delegate drafting/editing to `writer`");
  });
});
