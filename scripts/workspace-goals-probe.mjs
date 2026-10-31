import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

// This probe owns its new sessions; it never resumes a T3 or user session.
const home = NodePath.resolve(process.argv[2] ?? `.t3/dots-goals-probe-${Date.now()}`);
const tokenBudget = Number(process.argv[3] ?? 80000);
NodeAssert.ok(Number.isSafeInteger(tokenBudget) && tokenBudget > 0);
const pauseBetweenTurns = process.argv[4] !== "auto";
const cwd = NodePath.join(home, "한글 목표 실측 repo");
NodeFS.mkdirSync(cwd, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(cwd, "AGENTS.md"),
  "This is an isolated capability probe. Do not delegate, use network tools, read other directories, or change user files. Use the supplied probe_step tool only.\n",
);
const codexBin = NodePath.join(process.env.APPDATA, "npm/node_modules/@openai/codex/bin/codex.js");
const version = NodeChildProcess.execFileSync(process.execPath, [codexBin, "--version"], {
  encoding: "utf8",
  windowsHide: true,
}).trim();
const evidence = {
  measuredAt: new Date().toISOString(),
  version,
  home,
  cwd,
  checks: [],
  turns: [],
  steps: [],
  tokenBudget,
  pauseBetweenTurns,
  externalDotsMeasured: false,
  privateReasoningIncluded: false,
};

class ProbeClient {
  pending = new Map();
  events = [];
  emitter = new NodeEvents.EventEmitter();
  nextId = 1;
  onTool = null;
  constructor(experimentalApi) {
    this.experimentalApi = experimentalApi;
    this.child = NodeChildProcess.spawn(
      process.execPath,
      [codexBin, "app-server", "--listen", "stdio://"],
      { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stderr.on("data", () => {});
    this.child.on("error", (error) => this.failPending(error));
    this.child.once("exit", (code) => this.failPending(new Error(`app-server exited ${code}`)));
    this.reader = NodeReadline.createInterface({ input: this.child.stdout });
    this.reader.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.method && message.id !== undefined) {
        if (message.method === "item/tool/call" && this.onTool) {
          Promise.resolve(this.onTool(message.params))
            .then((result) => {
              this.child.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
            })
            .catch((error) => {
              this.child.stdin.write(
                `${JSON.stringify({ id: message.id, error: { code: -32603, message: error.message } })}\n`,
              );
            });
        } else {
          this.child.stdin.write(
            `${JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported request in isolated probe" } })}\n`,
          );
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error)
          pending.reject(
            Object.assign(new Error(message.error.message), { code: message.error.code }),
          );
        else pending.resolve(message.result);
        return;
      }
      if (
        [
          "thread/goal/updated",
          "thread/goal/cleared",
          "turn/started",
          "turn/completed",
          "error",
        ].includes(message.method)
      ) {
        const event = { at: Date.now(), method: message.method, params: message.params };
        this.events.push(event);
        console.log(
          JSON.stringify({
            nativeEvent: message.method,
            threadId: message.params.threadId,
            status: message.params.goal?.status ?? message.params.turn?.status,
          }),
        );
        this.emitter.emit("event", event);
      }
    });
  }
  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} response timed out`));
        }, 30_000),
      });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  waitEvent(predicate, timeoutMs = 60_000, from = 0) {
    const existing = this.events.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        this.emitter.off("event", listener);
      };
      const listener = (event) => {
        if (predicate(event)) {
          stop();
          resolve(event);
        }
      };
      const timer = setTimeout(() => {
        stop();
        reject(new Error("Event observation deadline reached"));
      }, timeoutMs);
      this.emitter.on("event", listener);
    });
  }
  async initialize() {
    await this.rpc("initialize", {
      clientInfo: { name: "t3_goal_capability_probe", version: "1" },
      capabilities: { experimentalApi: this.experimentalApi },
    });
    this.child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  }
  async stop() {
    this.reader.close();
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const stopped = NodeEvents.once(this.child, "exit");
      const timer = setTimeout(() => this.child.kill(), 5_000);
      await stopped;
      clearTimeout(timer);
    }
  }
}

let client;
let threadId;
let cleanupRequired = false;
try {
  client = new ProbeClient(false);
  await client.initialize();
  const baseline = await client.rpc("thread/start", {
    cwd,
    model: "gpt-6.1-sol",
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const baselineId = baseline.thread.id;
  evidence.baselineThreadId = baselineId;
  NodeAssert.equal((await client.rpc("thread/goal/get", { threadId: baselineId })).goal, null);
  const objective = "Isolated API contract probe: keep paused and do not perform work.";
  await client.rpc("thread/goal/set", {
    threadId: baselineId,
    objective,
    status: "paused",
    tokenBudget: 6000,
  });
  const baselineGoal = (await client.rpc("thread/goal/get", { threadId: baselineId })).goal;
  NodeAssert.equal(baselineGoal.status, "paused");
  evidence.checks.push({
    name: "stable API set/get",
    passed: true,
    experimentalApi: false,
    goal: baselineGoal,
  });
  for (const [name, params] of [
    ["empty objective", { objective: "" }],
    ["4001-character objective", { objective: "x".repeat(4001) }],
    ["negative token budget", { tokenBudget: -1 }],
  ]) {
    try {
      await client.rpc("thread/goal/set", { threadId: baselineId, status: "paused", ...params });
      evidence.checks.push({ name, rejected: false });
    } catch (error) {
      evidence.checks.push({ name, rejected: true, code: error.code, message: error.message });
    }
  }
  await client.rpc("thread/goal/set", {
    threadId: baselineId,
    objective,
    status: "paused",
    tokenBudget: 6000,
  });
  await client.stop();

  client = new ProbeClient(true);
  await client.initialize();
  const restored = (await client.rpc("thread/goal/get", { threadId: baselineId })).goal;
  NodeAssert.equal(restored.objective, objective);
  evidence.checks.push({
    name: "goal storage survives app-server restart",
    passed: true,
    goal: restored,
  });
  const cleared = await client.rpc("thread/goal/clear", { threadId: baselineId });
  NodeAssert.equal(cleared.cleared, true);
  NodeAssert.equal((await client.rpc("thread/goal/get", { threadId: baselineId })).goal, null);
  evidence.checks.push({ name: "clear", passed: true });

  const steppedTurns = new Set();
  client.onTool = async (params) => {
    NodeAssert.equal(params.threadId, threadId);
    NodeAssert.equal(params.tool, "probe_step");
    if (steppedTurns.has(params.turnId)) {
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "Only one step per turn. End this turn now; the active goal may continue in a NEW turn.",
          },
        ],
      };
    }
    steppedTurns.add(params.turnId);
    const step = { number: steppedTurns.size, turnId: params.turnId, at: Date.now() };
    evidence.steps.push(step);
    NodeFS.writeFileSync(NodePath.join(cwd, `step-${step.number}.json`), JSON.stringify(step));
    console.log(JSON.stringify({ nativeStep: step }));
    if (step.number === 1 && pauseBetweenTurns) {
      const paused = (await client.rpc("thread/goal/set", { threadId, status: "paused" })).goal;
      evidence.checks.push({
        name: "pause before first turn completes",
        passed: paused.status === "paused",
        goal: paused,
      });
    }
    return {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text:
            step.number === 1
              ? "Step 1 verified. The goal is not complete. End this turn with a progress response. Do not call any more tools in this turn. The next step is available in a NEW turn."
              : "Step 2 verified in a distinct turn. Objective achieved. Mark the active goal complete using update_goal, then finish.",
        },
      ],
    };
  };
  const started = await client.rpc("thread/start", {
    cwd,
    model: "gpt-6.1-sol",
    approvalPolicy: "never",
    sandbox: "read-only",
    config: { model_reasoning_effort: "low" },
    developerInstructions:
      "Controlled capability measurement. Use only probe_step and goal status tools. No other tools, delegation, external changes, or research. Call probe_step exactly once per turn and end the turn after step 1. In a later turn perform step 2 and mark the goal complete. Do not mark completion before both verified steps.",
    dynamicTools: [
      {
        type: "function",
        name: "probe_step",
        description:
          "Perform one verifiable probe step per turn; two distinct turns are required for completion.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false, required: [] },
      },
    ],
  });
  threadId = started.thread.id;
  evidence.threadId = threadId;
  evidence.actualModel = started.model;
  const activeGoal = await client.rpc("thread/goal/set", {
    threadId,
    objective:
      "Complete exactly two probe_step calls in distinct turns, verified by the tool. After step 1, end the turn with a progress response. Continue with step 2 in a new turn without needing the user to say continue. Mark complete only after step 2 is verified. Use no other tools except goal tools.",
    status: "active",
    tokenBudget,
  });
  cleanupRequired = true;
  evidence.checks.push({ name: "activate", passed: activeGoal.goal.status === "active" });
  let explicitTurnStartCount = 0;
  try {
    await client.waitEvent(
      (event) => event.method === "turn/started" && event.params.threadId === threadId,
      10_000,
    );
    evidence.activationStartedTurn = true;
  } catch {
    evidence.activationStartedTurn = false;
    const turn = await client.rpc("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: "Start the controlled goal now. Call probe_step once and return progress. End this turn after the first step.",
          text_elements: [],
        },
      ],
      effort: "low",
    });
    explicitTurnStartCount++;
    evidence.seedTurnId = turn.turn.id;
  }
  const firstCompleted = await client.waitEvent(
    (event) => event.method === "turn/completed" && event.params.threadId === threadId,
    90_000,
  );
  const beforeResume = client.events.length;
  const firstGoal = (await client.rpc("thread/goal/get", { threadId })).goal;
  if (firstGoal.status === "paused") {
    try {
      await client.waitEvent(
        (event) => event.method === "turn/started" && event.params.threadId === threadId,
        10_000,
        beforeResume,
      );
      evidence.checks.push({
        name: "paused idle observation",
        passed: false,
        observationMs: 10000,
      });
    } catch {
      evidence.checks.push({ name: "paused idle observation", passed: true, observationMs: 10000 });
    }
    const resumedGoal = (await client.rpc("thread/goal/set", { threadId, status: "active" })).goal;
    evidence.checks.push({
      name: "resume preserves usage",
      passed: resumedGoal.status === "active" && resumedGoal.tokensUsed === firstGoal.tokensUsed,
      goal: resumedGoal,
    });
    evidence.firstTurnCompletedAt = firstCompleted.at;
  }
  try {
    await client.waitEvent(
      (event) =>
        event.method === "thread/goal/updated" &&
        event.params.threadId === threadId &&
        event.params.goal.status === "complete",
      180_000,
    );
  } catch (error) {
    evidence.continuationObservation = error.message;
  }
  evidence.explicitTurnStartCount = explicitTurnStartCount;
  evidence.turns = client.events
    .filter((event) => event.method === "turn/started" && event.params.threadId === threadId)
    .map((event) => ({ id: event.params.turn.id, at: event.at }));
  evidence.goalBeforePause = (await client.rpc("thread/goal/get", { threadId })).goal;
  evidence.nativeGoalExecutionPassed =
    evidence.steps.length === 2 &&
    evidence.turns.length >= 2 &&
    explicitTurnStartCount <= 1 &&
    evidence.goalBeforePause.status === "complete";
  evidence.automaticContinuationPassed = !pauseBetweenTurns && evidence.nativeGoalExecutionPassed;
  const paused = (await client.rpc("thread/goal/set", { threadId, status: "paused" })).goal;
  evidence.checks.push({ name: "pause", passed: paused.status === "paused", goal: paused });
  await client.stop();

  client = new ProbeClient(false);
  await client.initialize();
  const resumed = await client.rpc("thread/resume", {
    threadId,
    cwd,
    model: "gpt-6.1-sol",
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  NodeAssert.equal(resumed.thread.id, threadId);
  NodeAssert.equal(NodePath.resolve(resumed.thread.cwd), cwd);
  const afterRestart = (await client.rpc("thread/goal/get", { threadId })).goal;
  evidence.checks.push({
    name: "same thread and paused goal after restart",
    passed: afterRestart.status === "paused",
    goal: afterRestart,
  });
  const terminal = (await client.rpc("thread/goal/set", { threadId, status: "complete" })).goal;
  evidence.checks.push({ name: "cleanup terminal goal", passed: terminal.status === "complete" });
  cleanupRequired = false;
} catch (error) {
  evidence.error = { message: error.message, code: error.code };
  process.exitCode = 1;
} finally {
  if (client) {
    if (threadId && cleanupRequired)
      await client.rpc("thread/goal/set", { threadId, status: "paused" }).catch(() => {});
    await client.stop().catch(() => {});
  }
  NodeFS.writeFileSync(NodePath.join(home, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
