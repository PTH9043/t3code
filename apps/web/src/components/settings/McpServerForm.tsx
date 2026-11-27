import { useState } from "react";
import { ManagedMcpServerConfig, type ManagedMcpProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Button } from "../ui/button";

const decodeConfig = Schema.decodeUnknownSync(ManagedMcpServerConfig);

export function McpServerForm(props: {
  editing: ManagedMcpServerConfig | null;
  existingNames?: ReadonlyArray<string>;
  workspaceRoot?: string;
  busy: boolean;
  cancel: () => void;
  save: (config: ManagedMcpServerConfig) => Promise<boolean | undefined>;
}) {
  const initial = props.editing;
  const [name, setName] = useState(initial?.name ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [transport, setTransport] = useState<"http" | "stdio">(initial?.transport ?? "http");
  const [target, setTarget] = useState(
    initial?.transport === "stdio" ? initial.command : (initial?.url ?? ""),
  );
  const [args, setArgs] = useState(
    JSON.stringify(initial?.transport === "stdio" ? initial.args : []),
  );
  const [fields, setFields] = useState(
    JSON.stringify(
      initial?.transport === "stdio" ? initial.env : (initial?.headers ?? {}),
      null,
      2,
    ),
  );
  const [providers, setProviders] = useState<ManagedMcpProvider[]>(
    initial ? [...initial.providers] : ["codex", "claudeAgent", "gemini", "grok"],
  );
  const [projectOnly, setProjectOnly] = useState(
    Boolean(initial?.workspaceRoot ?? props.workspaceRoot),
  );
  const [error, setError] = useState<string | null>(null);
  const [composioPreset, setComposioPreset] = useState(false);
  const inputClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";
  const submit = async () => {
    setError(null);
    try {
      if (!initial && props.existingNames?.includes(name.trim())) {
        setError(
          "같은 이름의 MCP 서버가 이미 있습니다. 다른 이름을 입력하거나 기존 서버를 수정하세요.",
        );
        return;
      }
      const config = decodeConfig({
        name: name.trim(),
        label: label.trim() || name.trim(),
        enabled: initial?.enabled ?? true,
        providers,
        workspaceRoot: projectOnly ? (initial?.workspaceRoot ?? props.workspaceRoot ?? null) : null,
        ...(transport === "http"
          ? {
              transport,
              url: target.trim(),
              headers: JSON.parse(fields),
              ...(initial?.transport === "http" && initial.redactedHeaders
                ? { redactedHeaders: initial.redactedHeaders }
                : {}),
            }
          : { transport, command: target.trim(), args: JSON.parse(args), env: JSON.parse(fields) }),
      });
      if (await props.save(config)) {
        setName("");
        setLabel("");
        setTarget("");
        setArgs("[]");
        setFields("{}");
      }
    } catch {
      setError(
        "이름은 영문자로 시작하는 영문·숫자·밑줄·하이픈 64자 이내, 인자는 JSON 배열, 환경 변수·헤더는 문자열 값의 JSON 객체여야 합니다. 주소와 제공자 선택도 확인하세요.",
      );
    }
  };
  return (
    <details open={Boolean(initial)} className="mt-4 rounded-xl border border-border p-4">
      <summary className="cursor-pointer text-sm font-semibold">
        {initial ? `${initial.label} 수정` : "MCP 서버 등록"}
      </summary>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {!initial ? (
          <div className="flex flex-col items-start gap-2 md:col-span-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={props.busy}
              onClick={() => {
                setComposioPreset(true);
                setName(props.existingNames?.includes("composio") ? "" : "composio");
                setLabel("Composio");
                setTransport("http");
                setTarget("");
                setFields("{}");
                setError(null);
              }}
            >
              Composio 세션 입력
            </Button>
            {composioPreset ? (
              <p className="text-xs text-muted-foreground">
                Composio 계정과 세션이 있으면 같은 세션에서 받은 MCP 주소와 헤더를 아래에
                입력하세요. 주소에 키를 넣지 마세요. 계정이 없어도 다른 MCP 서버와 로컬 비서는
                사용할 수 있습니다.{" "}
                <a
                  className="underline"
                  href="https://docs.composio.dev/docs/sessions-via-mcp"
                  target="_blank"
                  rel="noreferrer"
                >
                  공식 세션 안내
                </a>
              </p>
            ) : null}
          </div>
        ) : null}
        <label className="grid gap-1 text-xs">
          서버 이름
          <input
            className={inputClass}
            value={name}
            disabled={Boolean(initial) || props.busy}
            onChange={(event) => setName(event.target.value)}
            placeholder="my-server"
          />
        </label>
        <label className="grid gap-1 text-xs">
          표시 이름
          <input
            className={inputClass}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="문서 검색"
          />
        </label>
        <label className="grid gap-1 text-xs">
          연결 방식
          <select
            className={inputClass}
            value={transport}
            onChange={(event) => {
              setTransport(event.target.value === "http" ? "http" : "stdio");
              setComposioPreset(false);
              setTarget("");
              setFields("{}");
            }}
          >
            <option value="http">HTTP 서버</option>
            <option value="stdio">로컬 명령</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          {transport === "http" ? "서버 주소" : "실행 파일"}
          <input
            className={inputClass}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder={
              transport === "http"
                ? composioPreset
                  ? "Composio 세션 MCP 주소"
                  : "https://example.com/mcp"
                : "node"
            }
          />
        </label>
        {transport === "stdio" ? (
          <label className="grid gap-1 text-xs md:col-span-2">
            명령 인자 (JSON 배열)
            <input
              className={inputClass}
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder={'["server.js"]'}
            />
          </label>
        ) : null}
        <label className="grid gap-1 text-xs md:col-span-2">
          {transport === "http" ? "요청 헤더" : "환경 변수"} (JSON 객체)
          <textarea
            className={`${inputClass} min-h-20 font-mono text-xs`}
            value={fields}
            onChange={(event) => setFields(event.target.value)}
          />
        </label>
        <p className="text-xs text-muted-foreground md:col-span-2">
          HTTP 헤더는 서버의 별도 비밀 저장소에 보관합니다. 수정 시 빈 값으로 표시되는 기존 헤더는
          그대로 두면 유지되고 새 값을 입력하면 교체됩니다. 헤더를 삭제하려면 해당 항목을 지우세요.
          {" ${TOKEN_NAME}"}으로 서버 환경 변수를 참조할 수도 있습니다.
        </p>
        <div className="flex flex-wrap gap-4 text-xs md:col-span-2">
          {(["codex", "claudeAgent", "gemini", "grok"] as const).map((provider) => (
            <label key={provider} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={providers.includes(provider)}
                onChange={(event) =>
                  setProviders((current) =>
                    event.target.checked
                      ? [...current, provider]
                      : current.filter((item) => item !== provider),
                  )
                }
              />
              {provider === "claudeAgent"
                ? "Claude"
                : provider === "gemini"
                  ? "Antigravity"
                  : provider === "grok"
                    ? "Grok"
                    : "Codex"}
            </label>
          ))}
          {props.workspaceRoot || initial?.workspaceRoot ? (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={projectOnly}
                onChange={(event) => setProjectOnly(event.target.checked)}
              />
              이 프로젝트에서만 사용
            </label>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive md:col-span-2">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2 md:col-span-2">
          <Button size="sm" disabled={props.busy} onClick={() => void submit()}>
            {initial ? "변경 저장" : "서버 등록"}
          </Button>
          {initial ? (
            <Button size="sm" variant="ghost" onClick={props.cancel}>
              취소
            </Button>
          ) : null}
        </div>
      </div>
    </details>
  );
}
