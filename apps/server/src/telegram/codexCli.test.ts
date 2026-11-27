// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  codexSummaryArgs,
  codexTextCatalog,
  prepareCodexThread,
  runCodexSummary,
} from "./codexCli.ts";
import { systemPrompt } from "./summary.ts";

const launch = {
  email: "reader@example.test",
  model: "custom-exact",
  cwd: "fixture",
  catalog: "fixture/model.json",
};
const thread = {
  thread: { id: "t" },
  model: launch.model,
  modelProvider: "openai",
  sandbox: { type: "readOnly", networkAccess: false },
  approvalPolicy: "never",
  runtimeWorkspaceRoots: [],
  instructionSources: [],
};
const init = { userAgent: "codex/0.170.0 (fixture)" };
const auth = { account: { type: "chatgpt", email: launch.email } };
const page = { data: [{ model: launch.model }] };
const config = { layers: [{ name: { type: "user" }, config: {} }] };
const responses: Record<string, unknown> = {
  initialize: init,
  "config/read": config,
  "account/read": auth,
  "model/list": page,
  "thread/start": thread,
};
const prompt = "합성 자료에 의하면 공개 행사는 토요일입니다.";

it("probes the real identity twice and all model pages before opening a text-only thread", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const id = await prepareCodexThread(async (method, params) => {
    calls.push([method, params]);
    if (method === "model/list" && !params.cursor) return { data: [], nextCursor: "two" };
    return responses[method];
  }, launch);
  expect(id).toBe("t");
  expect(calls.map(([method]) => method)).toEqual([
    "initialize",
    "config/read",
    "account/read",
    "model/list",
    "model/list",
    "thread/start",
    "account/read",
  ]);
  expect(calls[5]?.[1]).toMatchObject({
    allowProviderModelFallback: false,
    model: launch.model,
    modelProvider: "openai",
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
    environments: [],
    dynamicTools: [],
    selectedCapabilityRoots: [],
    runtimeWorkspaceRoots: [],
  });
  expect(JSON.stringify(calls)).not.toContain(prompt);
  expect(codexTextCatalog(launch.model).models).toEqual([
    expect.objectContaining({
      slug: launch.model,
      base_instructions: systemPrompt,
      shell_type: "disabled",
      experimental_supported_tools: [],
      node_repl_disabled: true,
    }),
  ]);
  expect(codexSummaryArgs).toContain("tools.experimental_request_user_input.enabled=false");
});

it.each([
  ["account/read", { account: { type: "apiKey" } }],
  ["account/read", { account: { type: "chatgpt", email: "switched@example.test" } }],
  ["model/list", { data: [{ model: "different" }] }],
  ["config/read", { layers: [{ name: { type: "user" }, config: { mcp_servers: { other: {} } } }] }],
  ["thread/start", { ...thread, model: "fallback" }],
  ["thread/start", { ...thread, instructionSources: ["AGENTS.md"] }],
  ["thread/start", { ...thread, sandbox: { type: "workspaceWrite", networkAccess: false } }],
  ["initialize", { userAgent: "codex/untested" }],
])("rejects an incompatible %s before accepting a payload", async (method, response) => {
  const calls: string[] = [];
  await expect(
    prepareCodexThread(async (m) => {
      calls.push(m);
      return m === method ? response : responses[m];
    }, launch),
  ).rejects.toThrow();
  expect(calls).not.toContain("turn/start");
});

it("roundtrips an isolated registered CLI protocol, sends text once, and cleans its ephemeral workspace", async () => {
  const root = NodePath.resolve(NodeOS.tmpdir()),
    dir = await NodeFSP.mkdtemp(NodePath.join(root, "t3-test-codex-summary-"));
  try {
    const script = NodePath.join(dir, "cli.cjs"),
      audit = NodePath.join(dir, "received");
    const mock =
      `
const readline=require("node:readline"), fs=require("node:fs");
const replies=` +
      JSON.stringify(responses) +
      `;
function send(data){process.stdout.write(JSON.stringify(data)+"\\n");}
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);
 if(m.id===undefined) return;
 if(m.method==="turn/start"){
  fs.writeFileSync(process.argv[2],JSON.stringify({input:m.params.input,cwd:process.cwd()}));
  send({id:m.id,result:{turn:{id:"u"}}});
  send({method:"item/completed",params:{threadId:"t",turnId:"u",item:{type:"agentMessage",text:"문서 근거를 확인했습니다."}}});
  send({method:"turn/completed",params:{threadId:"t",turn:{id:"u",status:"completed"}}});
 }else send({id:m.id,result:replies[m.method]});
});`;
    await NodeFSP.writeFile(script, mock);
    const cmd = { command: process.execPath, args: [script, audit], shell: false };
    const result = await runCodexSummary(
      { cmd, env: process.env, email: launch.email, model: launch.model },
      { prompt, count: 1 },
      AbortSignal.timeout(15000),
    );
    expect(result).toBe("문서 근거를 확인했습니다.");
    const record = JSON.parse(await NodeFSP.readFile(audit, "utf8"));
    expect(record.input).toEqual([{ type: "text", text: prompt }]);
    await expect(NodeFSP.stat(record.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    await NodeFSP.unlink(audit);
    await expect(
      runCodexSummary(
        { cmd, env: process.env, email: "wrong@example.test", model: launch.model },
        { prompt, count: 1 },
        AbortSignal.timeout(15000),
      ),
    ).rejects.toThrow();
    await expect(NodeFSP.stat(audit)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (NodePath.dirname(NodePath.resolve(dir)) === root)
      await NodeFSP.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
