import { PROVIDER_DISPLAY_NAMES, type ProviderDriverKind } from "@t3tools/contracts";

export function workerModelFamily(driver: ProviderDriverKind, instanceId: string, model: string) {
  const source = model.split("/")[0]?.toLowerCase();
  const account = instanceId.toLowerCase();
  if (
    driver === "ollama" ||
    source === "ollama" ||
    source === "t3_ollama" ||
    /^ollama(?:$|[-_:])/.test(account)
  )
    return "Ollama";
  if (/^claude_api_/.test(account)) return "Claude";
  if (/^exaone_/.test(account) || source === "t3_exaone") return "EXAONE";
  if (/^deepseek_/.test(account)) return "DeepSeek";
  if (/^antseed(?:$|_)/.test(account) || source === "t3_antseed") return "Antseed";
  return PROVIDER_DISPLAY_NAMES[driver] ?? "기타";
}

export function WorkerFamilyFilter(props: {
  options: ReadonlyArray<{ family: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  const families = [...new Set(props.options.map((option) => option.family))].sort((a, b) =>
    a === b ? 0 : a === "기타" ? 1 : b === "기타" ? -1 : a.localeCompare(b),
  );
  return (
    <label className="inline-flex min-w-0 items-center gap-2 text-xs">
      제공자
      <select
        aria-label="작업 모델 제공자"
        className="rounded border border-input bg-background px-2 py-1"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        <option value="all">전체</option>
        {families.map((family) => (
          <option key={family} value={family}>
            {family}
          </option>
        ))}
      </select>
    </label>
  );
}
