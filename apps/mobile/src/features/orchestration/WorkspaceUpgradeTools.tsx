import { useEffect, useState, type ReactNode } from "react";
import { Image, Linking, Pressable, Share, Switch, TextInput, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import {
  DEFAULT_COMPLETION_AUTOMATION,
  WorkspaceKnowledgeItemId,
  ProviderInstanceId,
  WorkspaceDesignReference,
  WorkspaceAutomationCheck,
  type ConversationSourceFormat,
  type ConversationPreview,
  type ExtensionCatalog,
  type ExtensionActionInput,
  type ManagedMcpProvider,
  type WorkspaceKnowledgeItem,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { Option, Schema } from "effect";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { useEnvironmentServerConfig, useListedThreadShells } from "../../state/entities";
import { useEnvironmentThread } from "../../state/threads";
import { useAssetUrl } from "../../state/assets";
import { serverEnvironment } from "../../state/server";
import { projectEnvironment } from "../../state/projects";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 as randomUUID } from "../../lib/uuid";

const isCheck = Schema.is(WorkspaceAutomationCheck);
const decodeDesign = Schema.decodeUnknownSync(WorkspaceDesignReference);

const providerLabel = {
  codex: "Codex",
  claudeAgent: "Claude",
  gemini: "Antigravity",
  grok: "Grok",
};
const actionLabel = {
  install: "설치",
  update: "업데이트",
  enable: "켜기",
  disable: "끄기",
  uninstall: "설치 해제",
};
const inputClass = "rounded-lg border border-border p-3 text-foreground";
function Button({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      className="rounded-lg border border-border p-2.5"
    >
      <Text className={disabled ? "text-xs text-foreground-muted" : "text-xs text-foreground"}>
        {label}
      </Text>
    </Pressable>
  );
}
function Fold({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-3 rounded-xl border border-border bg-card p-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <Text className="font-t3-bold text-foreground">
          {title} {open ? "⌃" : "⌄"}
        </Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

function Extensions({ project }: { project: EnvironmentProject }) {
  const get = useAtomCommand(serverEnvironment.getExtensions, { reportFailure: false });
  const manage = useAtomCommand(serverEnvironment.manageExtension, { reportFailure: false });
  const [catalog, setCatalog] = useState<ExtensionCatalog | null>(null);
  const [provider, setProvider] = useState<ManagedMcpProvider>("grok");
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const [instances, setInstances] = useState<NonNullable<ExtensionCatalog["instances"]>>([]);
  const [userSkillScope, setUserSkillScope] = useState(false);
  const [skill, setSkill] = useState(false);
  const [trust, setTrust] = useState(false);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async (account = instanceId) => {
    setBusy(true);
    try {
      const result = await get({
        environmentId: project.environmentId,
        input: {
          workspaceRoot: project.workspaceRoot,
          ...(account ? { providerInstanceId: account } : {}),
        },
      });
      if (result._tag === "Success") {
        setCatalog(result.value);
        setInstances(result.value.instances ?? []);
      } else setError("목록 확인에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };
  const run = async (input: ExtensionActionInput) => {
    setBusy(true);
    setError(null);
    try {
      const result = await manage({
        environmentId: project.environmentId,
        input: { ...input, ...(instanceId ? { providerInstanceId: instanceId } : {}) },
      });
      if (result._tag === "Success") {
        setTarget("");
        await refresh();
      } else setError("확장 도구 작업에 실패했습니다. 출처·CLI 상태를 확인하세요.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-3">
      <Text className="text-xs text-foreground-muted">
        변경은 새 세션부터 적용됩니다. CLI가 지원하는 관리 작업만 표시됩니다.
      </Text>
      <Button
        label={busy ? "확인 중…" : "목록 확인"}
        disabled={busy}
        onPress={() => void refresh()}
      />
      {instances.length ? (
        <View className="gap-2">
          <Text className="text-xs text-foreground">설치·관리할 계정</Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={`${instanceId === null ? "✓ " : ""}기본 계정 모두`}
              disabled={busy}
              onPress={() => {
                setInstanceId(null);
                void refresh(null);
              }}
            />
            {instances.map((item) => (
              <Button
                key={item.instanceId}
                label={`${instanceId === item.instanceId ? "✓ " : ""}${providerLabel[item.provider]} · ${item.displayName} (${item.instanceId})`}
                disabled={busy}
                onPress={() => {
                  setInstanceId(item.instanceId);
                  setProvider(item.provider);
                  void refresh(item.instanceId);
                }}
              />
            ))}
          </View>
        </View>
      ) : null}
      {catalog?.providers
        .filter((item) => item.error)
        .map((item) => (
          <Text key={item.provider} className="text-xs text-destructive">
            {providerLabel[item.provider]} · {item.error}
          </Text>
        ))}
      {catalog?.entries.slice(0, 40).map((entry) => (
        <View
          key={`${entry.provider}:${entry.kind}:${entry.id}`}
          className="gap-2 border-t border-border pt-2"
        >
          <Text className="text-xs text-foreground">
            {entry.name} · {providerLabel[entry.provider]} · {entry.enabled ? "켜짐" : "꺼짐"} ·{" "}
            {entry.scope === "user"
              ? "사용자"
              : entry.scope === "managed"
                ? "조직 관리"
                : entry.scope === "local"
                  ? "프로젝트(로컬)"
                  : "프로젝트"}
          </Text>
          <Text className="text-xs text-foreground-muted">{entry.source}</Text>
          <View className="flex-row flex-wrap gap-2">
            {entry.actions
              .filter(
                (action) =>
                  action !== "install" &&
                  (entry.enabled ? action !== "enable" : action !== "disable"),
              )
              .map((action) => (
                <Button
                  key={action}
                  label={actionLabel[action]}
                  disabled={busy}
                  onPress={() =>
                    void run({
                      provider: entry.provider,
                      kind: entry.kind,
                      ...(entry.scope !== "managed" ? { scope: entry.scope } : {}),
                      action,
                      target: entry.id,
                      ...(entry.kind === "skill" ||
                      entry.scope === "project" ||
                      entry.scope === "local"
                        ? { workspaceRoot: project.workspaceRoot }
                        : {}),
                    })
                  }
                />
              ))}
          </View>
        </View>
      ))}
      {catalog && catalog.entries.length > 40 ? (
        <Text className="text-xs text-foreground-muted">
          처음 40개 표시 · 전체 목록은 웹·데스크톱에서 확인하세요.
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {(["grok", "codex", "claudeAgent", "gemini"] as const).map((id) => (
          <Button
            key={id}
            label={`${provider === id ? "✓ " : ""}${providerLabel[id]}`}
            disabled={busy}
            onPress={() => {
              setProvider(id);
              if (instanceId) {
                setInstanceId(null);
                void refresh(null);
              }
            }}
          />
        ))}
      </View>
      <View className="flex-row justify-between">
        <Text className="text-xs text-foreground">스킬 설치</Text>
        <Switch value={skill} onValueChange={setSkill} />
      </View>
      {skill ? (
        <View className="flex-row justify-between">
          <Text className="flex-1 text-xs text-foreground">
            선택한 계정에 설치 (끄면 프로젝트에 설치)
          </Text>
          <Switch value={userSkillScope} onValueChange={setUserSkillScope} />
        </View>
      ) : null}
      <TextInput
        accessibilityLabel="설치할 확장 도구 출처"
        className={inputClass}
        value={target}
        onChangeText={setTarget}
        placeholder={
          skill ? "GitHub 스킬 폴더 주소 또는 서버의 로컬 폴더" : "플러그인 이름·Git URL"
        }
      />
      {skill ? (
        <>
          <Text className="text-xs text-foreground-muted">
            공개 GitHub 스킬 폴더나 로컬 SKILL.md 폴더를 선택하세요. 자기소개서 스킬은 T3에서
            제공하며 개별 ChatGPT GPT를 가져오는 것은 아닙니다.
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              label="OpenAI 스킬 살펴보기"
              onPress={() =>
                void Linking.openURL("https://github.com/openai/skills/tree/main/skills/.curated")
              }
            />
            <Button
              label="Anthropic 스킬 살펴보기"
              onPress={() =>
                void Linking.openURL("https://github.com/anthropics/skills/tree/main/skills")
              }
            />
            <Button
              label="한국어 자기소개서 스킬 설치"
              disabled={busy}
              onPress={() =>
                void run({
                  provider,
                  kind: "skill",
                  action: "install",
                  target: "t3-skill:resume-writing-ko",
                  workspaceRoot: project.workspaceRoot,
                  scope: userSkillScope ? "user" : "project",
                })
              }
            />
          </View>
        </>
      ) : null}
      {!skill && provider === "grok" ? (
        <View className="flex-row justify-between">
          <Text className="flex-1 text-xs text-foreground">출처의 도구·훅 실행 허용</Text>
          <Switch value={trust} onValueChange={setTrust} />
        </View>
      ) : null}
      <Text className="text-xs text-foreground-muted">
        스킬은 선택한 범위에, Claude 플러그인은 프로젝트에, Codex·Grok 플러그인은 서버 사용자에
        설치됩니다.
      </Text>
      <Button
        label="설치"
        disabled={busy || !target.trim() || (!skill && provider === "grok" && !trust)}
        onPress={() =>
          void run({
            provider,
            kind: skill ? "skill" : "plugin",
            action: "install",
            target: target.trim(),
            trust,
            workspaceRoot: project.workspaceRoot,
            ...(skill ? { scope: userSkillScope ? "user" : "project" } : {}),
          })
        }
      />
      {error ? <ErrorBanner message={error} /> : null}
    </View>
  );
}

function CompletionChecks({ project }: { project: EnvironmentProject }) {
  const stored = project.workspaceControl?.completionAutomation ?? DEFAULT_COMPLETION_AUTOMATION;
  const [config, setConfig] = useState(stored);
  const [format, setFormat] = useState(stored.formatCommands.join("\n"));
  const [checks, setChecks] = useState(stored.verificationCommands.join("\n"));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const update = useAtomCommand(projectEnvironment.updateWorkspaceControl, {
    reportFailure: false,
  });
  const threads = useListedThreadShells()
    .filter((item) => item.environmentId === project.environmentId && item.projectId === project.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const [selected, setSelected] = useState("");
  const thread = threads.find((item) => item.id === selected) ?? threads[0];
  const state = useEnvironmentThread(thread ? project.environmentId : null, thread?.id ?? null);
  const receipts =
    Option.getOrNull(state.data)
      ?.activities.filter((item) => item.kind.startsWith("automation."))
      .slice(-12) ?? [];
  const lines = (value: string) =>
    value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  const save = async () => {
    setBusy(true);
    try {
      const result = await update({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          longTermMemoryRoot: project.workspaceControl?.longTermMemoryRoot ?? null,
          completionAutomation: {
            ...config,
            formatCommands: lines(format),
            verificationCommands: lines(checks),
            followUpTask: config.followUpTask?.trim() || null,
          },
        },
      });
      setMessage(result._tag === "Success" ? "자동 검증 설정 저장됨" : "설정 저장 실패");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-3">
      <Text className="text-xs text-foreground-muted">
        Git 작업 공간의 일반 대화 완료 후 포맷·체크포인트·검증을 실행합니다. 실패·새 작업 시작 시
        결과 저장과 후속 실행을 보류합니다.
      </Text>
      <View className="flex-row justify-between">
        <Text className="text-xs text-foreground">자동 검증 사용</Text>
        <Switch
          value={config.enabled}
          onValueChange={(enabled) => setConfig({ ...config, enabled })}
        />
      </View>
      <TextInput
        accessibilityLabel="포맷 명령"
        multiline
        className={inputClass}
        value={format}
        onChangeText={setFormat}
        placeholder="포맷 명령 · 줄마다 하나"
      />
      <TextInput
        accessibilityLabel="검증 명령"
        multiline
        className={inputClass}
        value={checks}
        onChangeText={setChecks}
        placeholder="검증 명령 · 줄마다 하나"
      />
      <View className="flex-row justify-between">
        <Text className="text-xs text-foreground">검증 통과 후 기억에 저장</Text>
        <Switch
          value={config.saveResult}
          onValueChange={(saveResult) => setConfig({ ...config, saveResult })}
        />
      </View>
      <TextInput
        accessibilityLabel="검증 통과 후 작업"
        multiline
        maxLength={8000}
        className={inputClass}
        value={config.followUpTask ?? ""}
        onChangeText={(followUpTask) =>
          setConfig({ ...config, followUpTask: followUpTask || null })
        }
        placeholder="통과 후 1회 실행할 작업 (선택)"
      />
      <Button
        label="설정 저장"
        disabled={
          busy ||
          (config.enabled && !lines(checks).length) ||
          lines(format).length > 6 ||
          lines(checks).length > 6
        }
        onPress={() => void save()}
      />
      {message ? <Text className="text-xs text-foreground-muted">{message}</Text> : null}
      <Text className="font-t3-bold text-xs text-foreground">최근 실행 기록</Text>
      <View className="flex-row flex-wrap gap-2">
        {threads.slice(0, 4).map((item) => (
          <Button
            key={item.id}
            label={item.title.slice(0, 25)}
            onPress={() => setSelected(item.id)}
          />
        ))}
      </View>
      {receipts.map((item) => {
        const receipt = isCheck(item.payload) ? item.payload : null;
        return (
          <View key={item.id} className="gap-1 rounded-lg bg-fill p-2">
            <Text className="text-xs text-foreground">{item.summary}</Text>
            {receipt ? (
              <>
                <Text className="text-xs text-foreground-muted">
                  {receipt.command} · {receipt.completedAt}
                </Text>
                <Text numberOfLines={6} className="text-xs text-foreground-muted">
                  {receipt.output}
                </Text>
              </>
            ) : null}
          </View>
        );
      })}
      {!receipts.length ? (
        <Text className="text-xs text-foreground-muted">자동 검증 기록 없음</Text>
      ) : null}
    </View>
  );
}

function DesignImage({
  project,
  image,
}: {
  project: EnvironmentProject;
  image: WorkspaceDesignReference["images"][number];
}) {
  const stored = useAssetUrl(
    image.attachmentId ? project.environmentId : null,
    image.attachmentId ? { _tag: "attachment", attachmentId: image.attachmentId } : null,
  );
  const url = image.url ?? stored;
  return (
    <View className="gap-1">
      {url ? (
        <Image
          accessibilityLabel={image.caption || "참고 이미지"}
          source={{ uri: url }}
          style={{ width: "100%", height: 160 }}
          resizeMode="contain"
        />
      ) : null}
      <Text className="text-xs text-foreground-muted">{image.caption}</Text>
    </View>
  );
}

function DesignLibrary({ project }: { project: EnvironmentProject }) {
  const query = useEnvironmentQuery(
    orchestrationEnvironment.workspaceKnowledge({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const upsert = useAtomCommand(projectEnvironment.upsertWorkspaceKnowledgeItem, {
    reportFailure: false,
  });
  const upload = useAtomCommand(serverEnvironment.uploadDesignImage, { reportFailure: false });
  const archive = useAtomCommand(projectEnvironment.archiveWorkspaceKnowledgeItem, {
    reportFailure: false,
  });
  const [editing, setEditing] = useState<WorkspaceKnowledgeItem | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [design, setDesign] = useState<WorkspaceDesignReference>({
    version: "",
    components: [],
    layout: "",
    sourceUrl: null,
    images: [],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    query.refresh();
  }, [query.refresh]);
  const reset = () => {
    setEditing(null);
    setTitle("");
    setContent("");
    setDesign({ version: "", components: [], layout: "", sourceUrl: null, images: [] });
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const valid = decodeDesign({
        ...design,
        components: design.components.filter(Boolean),
      });
      const result = await upsert({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          itemId: editing?.id ?? WorkspaceKnowledgeItemId.make(`design-${randomUUID()}`),
          kind: "rag-source",
          title: title.trim(),
          content: content.trim(),
          origin: "user",
          status: "active",
          relativeFolder: editing?.relativeFolder ?? null,
          tags: [...new Set([...(editing?.tags ?? []), "design-reference"])],
          research: {
            ...(editing?.research ?? {
              query: title.trim(),
              sources: [],
              capturedAt: new Date().toISOString(),
              verification: "unverified",
            }),
            design: valid,
            sources: valid.sourceUrl ? [valid.sourceUrl] : [],
          },
        },
      });
      if (result._tag === "Success") {
        reset();
        query.refresh();
      } else setError("디자인 자료 저장 실패");
    } catch {
      setError("이미지 주소·출처는 HTTP 주소여야 합니다. 입력 길이를 확인하세요.");
    } finally {
      setBusy(false);
    }
  };
  const pickImage = async () => {
    setBusy(true);
    try {
      const picker = await import("expo-image-picker");
      const result = await picker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
      const asset = result.canceled ? null : result.assets[0];
      if (!asset) return;
      if ((asset.fileSize ?? 0) > 8_000_000) {
        setError("이미지는 8 MB 이내여야 합니다.");
        return;
      }
      const { File } = await import("expo-file-system");
      const base64 = await new File(asset.uri).base64();
      const uploaded = await upload({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          name: asset.fileName ?? "design-image",
          dataUrl: `data:${asset.mimeType ?? "image/jpeg"};base64,${base64}`,
        },
      });
      if (uploaded._tag === "Success")
        setDesign({ ...design, images: [...design.images, uploaded.value] });
      else setError("이미지 보관 실패 · PNG·JPEG·WebP·GIF를 선택하세요.");
    } catch {
      setError("이미지를 읽지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };
  const items = (query.data?.items ?? [])
    .filter((item) => item.status === "active" && item.research?.design)
    .slice(0, 20);
  return (
    <View className="gap-3">
      <Text className="text-xs text-foreground-muted">
        내용·컴포넌트·레이아웃·버전을 RAG에서 검색합니다. 시각 분석 설명은 내용에 기록하세요.
      </Text>
      <Button label="자료 새로고침" disabled={busy} onPress={query.refresh} />
      {items.map((item) => (
        <View key={item.id} className="gap-2 border-t border-border pt-3">
          <Text className="font-t3-bold text-sm text-foreground">
            {item.title} · {item.research?.design?.version}
          </Text>
          <Text numberOfLines={6} className="text-xs text-foreground-muted">
            {item.content}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {item.research?.design?.components.join(" · ")} · {item.research?.design?.layout}
          </Text>
          {item.research?.design?.sourceUrl ? (
            <Button
              label="원본 자료 열기"
              onPress={() => void Linking.openURL(item.research!.design!.sourceUrl!)}
            />
          ) : null}
          {item.research?.design?.images.map((image) => (
            <DesignImage
              key={`${image.attachmentId ?? image.url}:${image.caption}`}
              project={project}
              image={image}
            />
          ))}
          <View className="flex-row gap-2">
            <Button
              label="수정"
              onPress={() => {
                setEditing(item);
                setTitle(item.title);
                setContent(item.content);
                setDesign(item.research!.design!);
              }}
            />
            <Button
              label="보관 처리"
              disabled={busy}
              onPress={() => {
                setBusy(true);
                void archive({
                  environmentId: project.environmentId,
                  input: { projectId: project.id, itemId: item.id },
                })
                  .then((result) => {
                    if (result._tag === "Success") query.refresh();
                    else setError("자료 보관 처리 실패");
                  })
                  .finally(() => setBusy(false));
              }}
            />
          </View>
        </View>
      ))}
      <TextInput
        accessibilityLabel="디자인 자료 제목"
        value={title}
        onChangeText={setTitle}
        maxLength={180}
        placeholder="자료 제목"
        className={inputClass}
      />
      <TextInput
        accessibilityLabel="디자인 자료 내용"
        value={content}
        onChangeText={setContent}
        multiline
        placeholder="화면 설명·분석 내용"
        className={inputClass}
      />
      <TextInput
        accessibilityLabel="디자인 버전"
        value={design.version}
        maxLength={100}
        onChangeText={(version) => setDesign({ ...design, version })}
        placeholder="버전"
        className={inputClass}
      />
      <TextInput
        accessibilityLabel="디자인 출처"
        value={design.sourceUrl ?? ""}
        onChangeText={(sourceUrl) => setDesign({ ...design, sourceUrl: sourceUrl || null })}
        placeholder="원본·Figma 링크"
        className={inputClass}
      />
      <TextInput
        accessibilityLabel="디자인 컴포넌트"
        value={design.components.join(", ")}
        onChangeText={(value) =>
          setDesign({ ...design, components: value.split(",").map((item) => item.trim()) })
        }
        placeholder="컴포넌트 · 쉼표로 구분"
        className={inputClass}
      />
      <TextInput
        accessibilityLabel="디자인 레이아웃"
        value={design.layout}
        maxLength={4000}
        onChangeText={(layout) => setDesign({ ...design, layout })}
        multiline
        placeholder="레이아웃·스타일"
        className={inputClass}
      />
      <TextInput
        accessibilityLabel="디자인 이미지 주소"
        value={design.images
          .filter((item) => item.url)
          .map((item) => item.url)
          .join("\n")}
        onChangeText={(value) =>
          setDesign({
            ...design,
            images: [
              ...design.images.filter((item) => item.attachmentId),
              ...value
                .split("\n")
                .filter(Boolean)
                .map((url) => ({ url: url.trim(), caption: "" })),
            ],
          })
        }
        multiline
        placeholder="이미지 HTTP 주소 · 줄마다 하나"
        className={inputClass}
      />
      <Button
        label="이미지 파일 보관"
        disabled={busy || design.images.length >= 8}
        onPress={() => void pickImage()}
      />
      {design.images
        .filter((item) => item.attachmentId)
        .map((image) => (
          <Button
            key={image.attachmentId}
            label={`${image.caption} · 참고에서 제거`}
            onPress={() =>
              setDesign({ ...design, images: design.images.filter((item) => item !== image) })
            }
          />
        ))}
      <View className="flex-row gap-2">
        <Button
          label={editing ? "수정 저장" : "RAG 자료 저장"}
          disabled={busy || !title.trim() || !content.trim()}
          onPress={() => void save()}
        />
        <Button label="편집 초기화" onPress={reset} />
      </View>
      {error || query.error ? (
        <ErrorBanner message={error ?? "자료를 불러오지 못했습니다."} />
      ) : null}
    </View>
  );
}

function ConversationTransfer({ project }: { project: EnvironmentProject }) {
  const navigation = useNavigation();
  const preview = useAtomCommand(serverEnvironment.previewConversation, { reportFailure: false });
  const importChat = useAtomCommand(serverEnvironment.importConversation, { reportFailure: false });
  const exportChat = useAtomCommand(serverEnvironment.exportConversation, { reportFailure: false });
  const providers = (useEnvironmentServerConfig(project.environmentId)?.providers ?? []).filter(
    (item) => item.enabled,
  );
  const threads = useListedThreadShells().filter(
    (item) => item.environmentId === project.environmentId && item.projectId === project.id,
  );
  const [format, setFormat] = useState<ConversationSourceFormat>("grok");
  const [source, setSource] = useState("");
  const [title, setTitle] = useState("CLI 대화");
  const [providerId, setProviderId] = useState("");
  const provider = providers.find((item) => item.instanceId === providerId) ?? providers[0];
  const [model, setModel] = useState("");
  const selectedModel =
    model || provider?.models[0]?.slug || project.defaultModelSelection?.model || "";
  const [summary, setSummary] = useState<ConversationPreview | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const selected = threads.find((item) => item.id === selectedId) ?? threads[0];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await preview({
        environmentId: project.environmentId,
        input: { format, content: source },
      });
      if (result._tag === "Success") setSummary(result.value);
      else setError("대화 형식을 확인하세요.");
    } finally {
      setBusy(false);
    }
  };
  const importNow = async () => {
    if (!provider) return;
    setBusy(true);
    try {
      const result = await importChat({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          title,
          format,
          content: source,
          modelSelection: {
            instanceId: ProviderInstanceId.make(provider.instanceId),
            model: selectedModel,
          },
        },
      });
      if (result._tag === "Success")
        navigation.navigate("Thread", {
          environmentId: String(project.environmentId),
          threadId: String(result.value.threadId),
        });
      else setError("대화 가져오기 실패");
    } finally {
      setBusy(false);
    }
  };
  const exportNow = async (original: boolean) => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await exportChat({
        environmentId: project.environmentId,
        input: { threadId: selected.id, original },
      });
      if (result._tag !== "Success") {
        setError("내보낼 원본이 없거나 연결에 실패했습니다.");
        return;
      }
      const { File, Paths } = await import("expo-file-system");
      const sharing = await import("expo-sharing");
      const file = new File(Paths.cache, result.value.fileName);
      file.create({ overwrite: true, intermediates: true });
      file.write(result.value.content);
      if (await sharing.isAvailableAsync())
        await sharing.shareAsync(file.uri, { mimeType: "text/plain" });
      else await Share.share({ message: result.value.content });
    } catch {
      setError("파일 공유에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-3">
      <Text className="text-xs text-foreground-muted">
        JSONL·Grok Markdown·T3 JSON을 붙여넣으세요. 가져온 뒤 새 메시지를 보내면 이전 문맥을
        이어갑니다.
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {(["grok", "codex", "claude", "t3"] as const).map((item) => (
          <Button
            key={item}
            label={`${format === item ? "✓ " : ""}${item}`}
            onPress={() => {
              setFormat(item);
              setSummary(null);
            }}
          />
        ))}
      </View>
      <TextInput
        accessibilityLabel="CLI 대화 원본"
        multiline
        value={source}
        maxLength={8_000_000}
        onChangeText={(value) => {
          setSource(value);
          setSummary(null);
        }}
        placeholder="대화 원본 붙여넣기"
        className={inputClass}
        style={{ maxHeight: 200 }}
      />
      <TextInput
        accessibilityLabel="가져올 대화 제목"
        value={title}
        onChangeText={setTitle}
        maxLength={180}
        className={inputClass}
      />
      <View className="flex-row flex-wrap gap-2">
        {providers.map((item) => (
          <Button
            key={item.instanceId}
            label={`${provider?.instanceId === item.instanceId ? "✓ " : ""}${item.displayName}`}
            onPress={() => {
              setProviderId(item.instanceId);
              setModel("");
            }}
          />
        ))}
      </View>
      <TextInput
        accessibilityLabel="이어갈 모델"
        value={selectedModel}
        onChangeText={setModel}
        className={inputClass}
      />
      <Button
        label="가져올 내용 확인"
        disabled={busy || !source.trim()}
        onPress={() => void check()}
      />
      {summary ? (
        <>
          <Text className="text-xs text-foreground">
            메시지 {summary.messageCount}개 · {summary.sourceSessionId ?? "세션 ID 없음"}
          </Text>
          {summary.sample.map((item) => (
            <Text
              key={`${item.role}:${item.text}`}
              numberOfLines={4}
              className="text-xs text-foreground-muted"
            >
              {item.role} · {item.text}
            </Text>
          ))}
        </>
      ) : null}
      <Button
        label="새 대화로 가져오기"
        disabled={busy || !summary || !title.trim() || !provider || !selectedModel}
        onPress={() => void importNow()}
      />
      <Text className="text-xs text-foreground-muted">내보낼 대화 · 최근 8개</Text>
      {threads.slice(0, 8).map((item) => (
        <Button
          key={item.id}
          label={`${selected?.id === item.id ? "✓ " : ""}${item.title.slice(0, 45)}`}
          onPress={() => setSelectedId(item.id)}
        />
      ))}
      <View className="flex-row gap-2">
        <Button
          label="T3 JSON 공유"
          disabled={busy || !selected}
          onPress={() => void exportNow(false)}
        />
        <Button
          label="CLI 원본 공유"
          disabled={busy || !selected}
          onPress={() => void exportNow(true)}
        />
      </View>
      {error ? <ErrorBanner message={error} /> : null}
    </View>
  );
}

export function WorkspaceUpgradeTools({ project }: { project: EnvironmentProject }) {
  return (
    <View className="gap-3">
      <Fold title="스킬·플러그인">
        <Extensions project={project} />
      </Fold>
      <Fold title="완료 후 자동 검증">
        <CompletionChecks project={project} />
      </Fold>
      <Fold title="디자인 RAG">
        <DesignLibrary project={project} />
      </Fold>
      <Fold title="CLI 대화 이어오기">
        <ConversationTransfer project={project} />
      </Fold>
    </View>
  );
}
