import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import {
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  ProviderOptionSelections,
} from "./model.ts";
import { ModelSelection, WorkspaceExecutionProfile } from "./orchestration.ts";
import { ProviderInstanceConfig, ProviderInstanceId } from "./providerInstance.ts";
import { ManagedMcpServerConfig, McpProjectProfile, McpServerName } from "./mcpTools.ts";
import { WorkspaceSearchModel } from "./workspaceResearch.ts";
import { ThreadCharacter } from "./threadCharacter.ts";
import { GlobalAssistantConfig } from "./globalAssistant.ts";
import { ThreadResponseStyle } from "./threadResponseStyle.ts";
import { ThreadSettingsPreset } from "./threadSettingsLibrary.ts";
import {
  ThreadTeamMember,
  ThreadTeamRole,
  ThreadModelTeam,
  ThreadModelTeamScope,
  ThreadModelTeamUpdate,
  ThreadSubordinateTeamUpdate,
} from "./threadModelTeam.ts";
export * from "./threadModelTeam.ts";
export * from "./threadResponseStyle.ts";
export * from "./globalAssistant.ts";
export * from "./livingPersona.ts";
export { ThreadCharacter } from "./threadCharacter.ts";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
export const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";
export const MIN_SIDEBAR_THREAD_PREVIEW_COUNT = 1;
export const MAX_SIDEBAR_THREAD_PREVIEW_COUNT = 15;
export const SidebarThreadPreviewCount = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
    maximum: MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  }),
);
export type SidebarThreadPreviewCount = typeof SidebarThreadPreviewCount.Type;
export const DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT: SidebarThreadPreviewCount = 6;
export const MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 1;
export const MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 90;
export const SidebarAutoSettleAfterDays = Schema.Number.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
    maximum: MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  }),
);
export type SidebarAutoSettleAfterDays = typeof SidebarAutoSettleAfterDays.Type;
export const DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS: SidebarAutoSettleAfterDays = 3;
export const MIN_GLASS_OPACITY = 40;
export const MAX_GLASS_OPACITY = 100;
export const GlassOpacity = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_GLASS_OPACITY,
    maximum: MAX_GLASS_OPACITY,
  }),
);
export type GlassOpacity = typeof GlassOpacity.Type;
export const DEFAULT_GLASS_OPACITY: GlassOpacity = 80;
export const MIN_CHAT_HORIZONTAL_INSET_PX = 0;
export const MAX_CHAT_HORIZONTAL_INSET_PX = 160;
export const ChatHorizontalInsetPx = Schema.NullOr(
  Schema.Int.check(
    Schema.isBetween({
      minimum: MIN_CHAT_HORIZONTAL_INSET_PX,
      maximum: MAX_CHAT_HORIZONTAL_INSET_PX,
    }),
  ),
);
export type ChatHorizontalInsetPx = typeof ChatHorizontalInsetPx.Type;
export const DEFAULT_CHAT_HORIZONTAL_INSET_PX: ChatHorizontalInsetPx = null;
/**
 * Font size preferences, in CSS pixels. The upper bounds reach well past a
 * comfortable reading size so low-vision and high-DPI setups are usable. The
 * interface size scales every rem-based dimension, so the largest values do
 * trade layout density for legibility — that is the user's call, not a limit.
 */
export const MIN_INTERFACE_FONT_SIZE = 12;
export const MAX_INTERFACE_FONT_SIZE = 32;
export const InterfaceFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_INTERFACE_FONT_SIZE, maximum: MAX_INTERFACE_FONT_SIZE }),
);
export type InterfaceFontSize = typeof InterfaceFontSize.Type;
export const DEFAULT_INTERFACE_FONT_SIZE: InterfaceFontSize = 16;

export const MIN_PROMPT_FONT_SIZE = 12;
export const MAX_PROMPT_FONT_SIZE = 32;
export const PromptFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_PROMPT_FONT_SIZE, maximum: MAX_PROMPT_FONT_SIZE }),
);
export type PromptFontSize = typeof PromptFontSize.Type;
export const DEFAULT_PROMPT_FONT_SIZE: PromptFontSize = 14;

export const MIN_CODE_FONT_SIZE = 10;
export const MAX_CODE_FONT_SIZE = 32;
export const CodeFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_CODE_FONT_SIZE, maximum: MAX_CODE_FONT_SIZE }),
);
export type CodeFontSize = typeof CodeFontSize.Type;
export const DEFAULT_CODE_FONT_SIZE: CodeFontSize = 13;

export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 32;
export const TerminalFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_TERMINAL_FONT_SIZE, maximum: MAX_TERMINAL_FONT_SIZE }),
);
export type TerminalFontSize = typeof TerminalFontSize.Type;
export const DEFAULT_TERMINAL_FONT_SIZE: TerminalFontSize = 12;

export const EnvironmentIdentificationMode = Schema.Literals(["artwork", "pill", "none"]);
export type EnvironmentIdentificationMode = typeof EnvironmentIdentificationMode.Type;
export const DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE: EnvironmentIdentificationMode = "artwork";

/**
 * A user-chosen font family (a single name or a comma-separated list). Empty
 * means "use the app default"; clients compose their own fallback stacks.
 */
export const FontFamilyPreference = Schema.String.check(Schema.isMaxLength(200));
export type FontFamilyPreference = typeof FontFamilyPreference.Type;

export const ClientSettingsSchema = Schema.Struct({
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  dismissedProviderUpdateNotificationKeys: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  diffIgnoreWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  environmentIdentificationMode: EnvironmentIdentificationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE)),
  ),
  glassOpacity: GlassOpacity.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_GLASS_OPACITY)),
  ),
  // Custom horizontal inset (px) between the chat column and the left/right
  // pane dividers. `null` keeps the responsive auto inset (20px / 48px).
  chatHorizontalInsetPx: ChatHorizontalInsetPx.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CHAT_HORIZONTAL_INSET_PX)),
  ),
  fontSizeInterface: InterfaceFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_INTERFACE_FONT_SIZE)),
  ),
  fontSizePrompt: PromptFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROMPT_FONT_SIZE)),
  ),
  fontSizeCode: CodeFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CODE_FONT_SIZE)),
  ),
  fontSizeTerminal: TerminalFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TERMINAL_FONT_SIZE)),
  ),
  fontFamilyCode: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  fontFamilyComposer: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  fontFamilySans: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  fontFamilyTerminal: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  // Grayscale `-webkit-font-smoothing: antialiased` (thinner strokes);
  // disabling restores the platform's heavier default. No effect off macOS.
  fontSmoothing: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Model favorites. Historically keyed by provider kind, now
  // widened to `ProviderInstanceId` so users can favorite a specific model
  // on a custom provider instance (e.g. "Codex Personal · gpt-5") without
  // the UI collapsing it into the same bucket as the default Codex. The
  // widening is backward-compatible by construction: prior provider-kind
  // strings satisfy the `ProviderInstanceId` slug schema, so previously
  // persisted favorites decode unchanged and continue to point at the
  // default instance for their kind (because `defaultInstanceIdForDriver(kind)`
  // uses the same slug). The field name is kept as `provider` for storage
  // stability; new call sites should treat the value as an instance id.
  favorites: Schema.Array(
    Schema.Struct({
      provider: ProviderInstanceId,
      model: TrimmedNonEmptyString,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: Schema.Record(
    ProviderInstanceId,
    Schema.Struct({
      hiddenModels: Schema.Array(Schema.String).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
      modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // Legacy plan mode. The composer's Build/Plan toggle was removed from the
  // default UI; this beta flag restores it (plus the /plan and /default slash
  // commands) for users who still rely on the old workflow.
  planModeEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Legacy sidebar (the original per-project tree). Deliberately a fresh key
  // (was `sidebarV2Enabled` + `sidebarV2ConfiguredByUser`): decoding drops the
  // old keys, so everyone, including prior beta opt-outs, resets to the new
  // default sidebar.
  legacySidebarEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sidebarAutoSettleAfterDays: Schema.NullOr(SidebarAutoSettleAfterDays).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS)),
  ),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  sidebarThreadPreviewCount: SidebarThreadPreviewCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  // Chat timeline minimap (the clickable left-edge rail that jumps to a user
  // message). On by default; disabling hides the rail entirely.
  timelineMinimapEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  wordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

export const WorkspaceProgramPermissions = Schema.Struct({
  manualControl: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  collectLogs: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  autoStart: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  autoDiagnosis: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  autoRestartAfterRepair: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * 프로그램 모니터링 모드 may run an approved playbook (restart, stop, start,
   * repair) on its own. Off, the loop only observes and asks; `autoDiagnosis`
   * still gates whether it may start an AI turn at all.
   */
  monitoringAutoActions: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type WorkspaceProgramPermissions = typeof WorkspaceProgramPermissions.Type;

/**
 * T3 Code watching itself (server event loop, memory, slow spans; desktop
 * processes when the desktop is the host). Findings post into the monitoring
 * thread of ONE project — the one named here, or the first monitored project
 * when null — so a single server anomaly never spends several projects' budgets.
 */
export const SelfMonitoringSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  projectId: Schema.NullOr(ProjectId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type SelfMonitoringSettings = typeof SelfMonitoringSettings.Type;
export const DEFAULT_WORKSPACE_PROGRAM_PERMISSIONS: WorkspaceProgramPermissions = Schema.decodeSync(
  WorkspaceProgramPermissions,
)({});

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export type ProviderSettingsFormControl = "text" | "password" | "textarea" | "switch" | "select";

export interface ProviderSettingsFormAnnotation {
  readonly control?: ProviderSettingsFormControl | undefined;
  readonly placeholder?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string }> | undefined;
}

export interface ProviderSettingsFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly providerSettingsForm?: ProviderSettingsFormAnnotation | undefined;
      readonly providerSettingsFormSchema?: ProviderSettingsFormSchemaAnnotation | undefined;
    }
  }
}

export type ProviderSettingsOrder<Fields extends Schema.Struct.Fields> = readonly Extract<
  keyof Fields,
  string
>[];

export function makeProviderSettingsSchema<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  options?: {
    readonly order?: ProviderSettingsOrder<Fields> | undefined;
  },
): Schema.Struct<Fields> {
  return Schema.Struct(fields).pipe(
    Schema.annotate({
      providerSettingsFormSchema:
        options?.order === undefined ? undefined : { order: options.order },
    }),
  );
}

/** What a subordinate model is for; it decides the instructions the subordinate works under. */
export const SubordinateRole = ThreadTeamRole;
export type SubordinateRole = typeof SubordinateRole.Type;

/**
 * A model the user placed under an answering model. The subordinate may belong
 * to any provider account; the answering model hands it work through the
 * `workspace_delegate` tool. Stored server-wide rather than in the account's
 * own config, because changing an account's config restarts its sessions.
 */
export const SubordinateAssignment = Schema.Struct({
  /** Account of the answering model. */
  answeringInstanceId: ProviderInstanceId,
  /** Answering model this applies to; absent means every model of that account. */
  forModel: Schema.optionalKey(TrimmedNonEmptyString),
  /** Account and model of the subordinate. */
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  role: SubordinateRole,
});
export type SubordinateAssignment = typeof SubordinateAssignment.Type;

/**
 * Assigns a low-cost helper API (a registered API account) to this account's
 * answering models, for research and routine chores via the `workspace_helper`
 * tool. Optional keys: an account that sets none of them has no helper.
 */
const helperSettingsFields = {
  helperAccount: Schema.optionalKey(TrimmedString).pipe(
    Schema.annotateKey({
      title: "잡일용 하위 API",
      description:
        "리서치·요약·번역 같은 잡일을 맡길 API 계정과 모델입니다. '계정이름:모델' 형식으로 적습니다(예: Baidu:ernie-5.1). 계정은 API 연결로 등록한 계정의 이름이어야 합니다. 비우면 사용하지 않습니다.",
      providerSettingsForm: {
        hidden: true,
        placeholder: "Baidu:ernie-5.1",
        clearWhenEmpty: "omit",
      },
    }),
  ),
  helperForModels: Schema.optionalKey(TrimmedString).pipe(
    Schema.annotateKey({
      title: "하위 API를 쓸 답변 모델",
      description:
        "하위 API를 쓸 수 있는 답변 모델을 쉼표로 구분해 적습니다. 모델 이름의 일부만 적어도 됩니다(예: opus, sonnet). 비우면 이 계정의 모든 모델이 쓸 수 있습니다.",
      providerSettingsForm: {
        hidden: true,
        placeholder: "비우면 모든 모델",
        clearWhenEmpty: "omit",
      },
    }),
  ),
  helperScope: Schema.optionalKey(Schema.Literals(["public", "project"])).pipe(
    Schema.annotateKey({
      title: "하위 API에 보낼 수 있는 내용",
      description:
        "보낸 내용은 하위 API 제공사 서버로 나갑니다. 기본값은 공개 정보와 일반 잡일만 보내도록 답변 모델에 지시합니다. '프로젝트 내용도 허용'을 고르면 코드와 파일 내용도 보낼 수 있습니다.",
      providerSettingsForm: {
        hidden: true,
        control: "select",
        options: [
          { value: "public", label: "공개 정보·일반 잡일만 (기본)" },
          { value: "project", label: "프로젝트 내용도 허용" },
        ],
      },
    }),
  ),
};

export const CodexSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "실행 파일 경로",
        description: "이 계정에서 사용할 Codex 실행 파일 경로입니다.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME 경로",
        description: "사용자 지정 Codex 홈 및 설정 디렉터리입니다.",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "계정 전용 홈 경로",
        description:
          "계정별 Codex 홈입니다. CODEX_HOME의 상태는 공유하면서 auth.json은 분리합니다.",
        providerSettingsForm: {
          placeholder: "~/.codex-t3/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "실행 인수",
        description: "세션 시작 시 codex app-server에 전달할 추가 CLI 인수입니다.",
      }),
    ),
    subagentModel: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "하위 에이전트 모델",
        description:
          "Codex가 일을 나눠 맡기는 하위 에이전트가 쓸 모델입니다(예: gpt-6-luna). 비우면 Codex 기본 동작대로 답변 모델과 같은 모델을 씁니다. 에이전트 정의 파일(.codex/agents)에 모델을 적어 둔 에이전트는 그 모델을 그대로 씁니다. 새 세션부터 적용됩니다.",
        providerSettingsForm: { hidden: true, placeholder: "gpt-6-luna", clearWhenEmpty: "omit" },
      }),
    ),
    subagentModelByModel: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "답변 모델별 하위 에이전트 모델",
        description:
          "답변 모델마다 다른 하위 모델을 쓰려면 '답변모델=하위모델'을 쉼표로 구분해 적습니다(예: gpt-6-sol=gpt-6-luna, terra=inherit). 답변 모델은 이름의 일부만 적어도 되고, 하위 모델은 정확한 모델 이름이나 inherit(답변 모델과 같음)을 적습니다. 적지 않은 모델은 위의 하위 에이전트 모델 설정을 따릅니다.",
        providerSettingsForm: {
          hidden: true,
          placeholder: "gpt-6-sol=gpt-6-luna, terra=inherit",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    ...helperSettingsFields,
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: [
      "binaryPath",
      "homePath",
      "shadowHomePath",
      "launchArgs",
      "subagentModel",
      "subagentModelByModel",
      "helperAccount",
      "helperForModels",
      "helperScope",
    ],
  },
);
export type CodexSettings = typeof CodexSettings.Type;

/** Model of the `worker` subagent a Claude conductor delegates to; `off` disables conductor mode. */
export const ClaudeConductorWorkerModel = Schema.Literals([
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "inherit",
  "off",
]);
export type ClaudeConductorWorkerModel = typeof ClaudeConductorWorkerModel.Type;

export const CLAUDE_API_KEY_ENV = "ANTHROPIC_API_KEY";
export const CLAUDE_API_WORKSPACE_ENV = "T3_CLAUDE_API_WORKSPACE_ID";

export const ClaudeSettings = makeProviderSettingsSchema(
  {
    authMode: Schema.optionalKey(Schema.Literal("api-key")).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "실행 파일 경로",
        description: "이 계정에서 사용할 Claude 실행 파일 경로입니다.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CLAUDE_CONFIG_DIR 경로",
        description:
          "사용자 지정 Claude 홈 및 설정 디렉터리입니다. .claude.json과 .claude를 계정별로 분리합니다.",
        providerSettingsForm: { placeholder: "~/.claude", clearWhenEmpty: "omit" },
      }),
    ),
    promptCacheTtl: Schema.optionalKey(Schema.Literals(["inherit", "5m", "1h"])).pipe(
      Schema.annotateKey({
        title: "대화 캐시 유지 시간",
        description:
          "inherit: Claude 기본 설정 유지(대형 문맥 대화 권장), 5m: 5분, 1h: 1시간. 5~60분 간격 재쓰기가 잦은 대형 문맥에서는 1시간(또는 기본 설정)이 유리하며 새 세션부터 적용됩니다.",
        providerSettingsForm: {
          control: "select",
          options: [
            { value: "inherit", label: "Claude 기본 설정" },
            { value: "5m", label: "5분" },
            { value: "1h", label: "1시간" },
          ],
        },
      }),
    ),
    subagentPromptCacheTtl: Schema.optionalKey(Schema.Literals(["inherit", "5m", "1h"])).pipe(
      Schema.annotateKey({
        title: "Claude 내부 에이전트 캐시 유지 시간",
        description:
          "inherit, 5m(단기 위임 작업 권장), 1h 중 선택합니다. Claude가 내부에서 생성한 에이전트에 적용됩니다. 오케스트라의 개별 AI 실행은 위 대화 설정을 사용합니다.",
        providerSettingsForm: {
          control: "select",
          options: [
            { value: "inherit", label: "Claude 기본 설정" },
            { value: "5m", label: "5분" },
            { value: "1h", label: "1시간" },
          ],
        },
      }),
    ),
    skipDuplicateAgentsMdInjection: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "AGENTS.md 중복 주입 방지",
        description:
          "Claude Code 0.3.x가 프로젝트 루트 AGENTS.md를 자체 로드할 때 시스템 프롬프트에 64KB 사본을 중복 주입하지 않습니다(OIBOT 기준 세션당 약 5.1만 토큰 절감). 구버전 CLI에서만 끄세요.",
      }),
    ),
    proactiveCompactEnabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "문맥 사전 압축 활성화",
        description:
          "턴 종료 경계에서 입력 토큰이 임계치를 넘으면 핵심 맥락을 기억에 저장한 뒤 문맥을 사전 압축합니다. 턴 도중에는 절대 압축하지 않으며 스레드별로 끌 수 있습니다.",
      }),
    ),
    proactiveCompactThresholdTokens: Schema.Int.check(
      Schema.isBetween({ minimum: 50_000, maximum: 900_000 }),
    ).pipe(
      Schema.withDecodingDefault(Effect.succeed(250_000)),
      Schema.annotateKey({
        title: "사전 압축 토큰 임계치",
        description:
          "턴 종료 시 실제 입력 토큰이 이 값을 넘으면 사전 압축과 SDK autoCompactWindow가 동작합니다(기본 250,000 토큰, 권장 200,000~300,000).",
        providerSettingsForm: {
          placeholder: "250000",
        },
      }),
    ),
    conductorWorkerModel: Schema.optionalKey(ClaudeConductorWorkerModel).pipe(
      Schema.annotateKey({
        title: "지휘자 모드 · 일꾼 모델",
        description:
          "대화에서 고른 모델이 무엇이든 지휘자로 계획·검토를 맡고, 큰 구현은 이 모델로 실행되는 worker 하위 에이전트에 나눠 맡깁니다. 작은 수정은 지휘자가 바로 처리합니다. 일꾼 사용량은 모델별로 집계됩니다. 새 세션부터 적용됩니다.",
        providerSettingsForm: {
          hidden: true,
          control: "select",
          options: [
            { value: "opus", label: "Opus (기본)" },
            { value: "sonnet", label: "Sonnet" },
            { value: "haiku", label: "Haiku" },
            { value: "fable", label: "Fable" },
            { value: "inherit", label: "지휘자와 같은 모델" },
            { value: "off", label: "끄기 (지휘자 모드 사용 안 함)" },
          ],
        },
      }),
    ),
    conductorWorkerByModel: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "답변 모델별 일꾼 모델",
        description:
          "답변 모델마다 다른 일꾼을 쓰려면 '답변모델=일꾼모델'을 쉼표로 구분해 적습니다(예: opus=sonnet, sonnet=haiku, fable=off). 일꾼은 opus, sonnet, haiku, fable, inherit(같은 모델), off(끄기) 중 하나입니다. 적지 않은 모델은 위의 일꾼 모델 설정을 따릅니다. 새 세션부터 적용됩니다.",
        providerSettingsForm: {
          hidden: true,
          placeholder: "opus=sonnet, sonnet=haiku",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    ...helperSettingsFields,
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "실행 인수",
        description: "세션 시작 시 전달할 추가 CLI 인수입니다.",
        providerSettingsForm: {
          placeholder: "예: --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: [
      "binaryPath",
      "homePath",
      "launchArgs",
      "conductorWorkerModel",
      "conductorWorkerByModel",
      "helperAccount",
      "helperForModels",
      "helperScope",
      "promptCacheTtl",
      "subagentPromptCacheTtl",
      "skipDuplicateAgentsMdInjection",
      "proactiveCompactEnabled",
      "proactiveCompactThresholdTokens",
    ],
  },
);
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const CursorSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("cursor-agent").pipe(
      Schema.annotateKey({
        title: "실행 파일 경로",
        description: "Cursor 에이전트 실행 파일 경로입니다.",
        providerSettingsForm: { placeholder: "cursor-agent", clearWhenEmpty: "omit" },
      }),
    ),
    apiEndpoint: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API 엔드포인트",
        description: "이 계정에서 사용할 Cursor API 엔드포인트를 지정합니다.",
        providerSettingsForm: {
          placeholder: "https://...",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "apiEndpoint"],
  },
);
export type CursorSettings = typeof CursorSettings.Type;

export const GrokSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("grok").pipe(
      Schema.annotateKey({
        title: "실행 파일 경로",
        description: "Grok CLI 실행 파일 경로입니다.",
        providerSettingsForm: { placeholder: "grok", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Grok 계정 홈 경로 (GROK_HOME)",
        description:
          "계정별 Grok 로그인(auth.json)·설정·플러그인을 분리할 GROK_HOME 경로입니다. 비워 두면 기본 ~/.grok을 사용합니다.",
        providerSettingsForm: { placeholder: "자동 관리 또는 ~/.grok", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath"],
  },
);
export type GrokSettings = typeof GrokSettings.Type;

export const MuseBackendMode = Schema.Literals(["code", "cloud"]);
export type MuseBackendMode = typeof MuseBackendMode.Type;

export const MuseSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    backendMode: Schema.optionalKey(MuseBackendMode).pipe(
      Schema.annotateKey({
        title: "연결 백엔드",
        description:
          "code: Meta 공식 Muse Code 로컬 코딩 에이전트(dev.meta.ai), cloud: muse.ai 웹 클라우드 에이전트(Google 로그인).",
        providerSettingsForm: {
          control: "select",
          options: [
            { value: "code", label: "Muse Code (Meta 로컬 CLI)" },
            { value: "cloud", label: "muse.ai 클라우드 (Google 로그인)" },
          ],
        },
      }),
    ),
    binaryPath: makeBinaryPathSetting("muse").pipe(
      Schema.annotateKey({
        title: "실행 파일 경로",
        description:
          "Meta Muse Code CLI 실행 파일 경로입니다. 비워 두면 %LOCALAPPDATA%\\Programs\\muse의 네이티브 바이너리를 자동 탐색합니다.",
        providerSettingsForm: { placeholder: "muse", clearWhenEmpty: "omit" },
      }),
    ),
    cloudBinaryPath: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "muse.ai CLI 경로 (muse-cli)",
        description:
          "muse.ai 클라우드 백엔드용 muse-cli 실행 파일 경로입니다. 비워 두면 PATH 및 ~/.local/bin/muse-cli에서 자동 탐색합니다.",
        providerSettingsForm: { placeholder: "muse-cli", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Muse 계정 홈 경로",
        description:
          "계정별 Muse 로그인(auth.json 또는 muse-cli cookies.txt)과 설정을 분리할 경로입니다. 비워 두면 기본 사용자 홈을 사용합니다.",
        providerSettingsForm: { placeholder: "자동 관리 또는 기본 홈", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["backendMode", "binaryPath", "cloudBinaryPath", "homePath"],
  },
);
export type MuseSettings = typeof MuseSettings.Type;

export const GeminiSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("agy").pipe(
      Schema.annotateKey({
        title: "실행 파일 경로",
        description: "Antigravity CLI (agy) 실행 파일 경로입니다.",
        providerSettingsForm: { placeholder: "agy", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Antigravity 계정 홈 경로",
        description:
          "Google 로그인과 세션을 이 계정에만 저장할 경로입니다. 비워 두면 T3 Code가 계정별 경로를 관리합니다.",
        providerSettingsForm: {
          placeholder: "자동 관리",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    autoOptimizeThoughtLevel: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "사고 수준(thought_level) 자동 절감",
        description:
          "대화 입력에서 사고 수준을 직접 지정하지 않은 경우 질문 난이도에 따라 low·medium·high로 자동 조절해 Gemini/Neon 토큰과 쿼터를 절감합니다.",
      }),
    ),
    ...helperSettingsFields,
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: [
      "binaryPath",
      "homePath",
      "autoOptimizeThoughtLevel",
      "helperAccount",
      "helperForModels",
      "helperScope",
    ],
  },
);
export type GeminiSettings = typeof GeminiSettings.Type;

export const OpenCodeApiConnection = Schema.Struct({
  providerId: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/)),
  baseUrl: TrimmedNonEmptyString.check(Schema.isPattern(/^https?:\/\//)),
  protocol: Schema.Literals(["chat-completions", "responses"]),
  models: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  contextTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  outputTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type OpenCodeApiConnection = typeof OpenCodeApiConnection.Type;
export const OPENCODE_API_KEY_ENV = "T3_OPENCODE_API_KEY";

export const OpenCodeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("opencode").pipe(
      Schema.annotateKey({
        title: "실행 파일 경로",
        description: "OpenCode 실행 파일 경로입니다.",
        providerSettingsForm: {
          placeholder: "opencode",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "서버 URL",
        description: "비워 두면 필요할 때 T3 Code가 서버를 실행합니다.",
        providerSettingsForm: {
          placeholder: "http://127.0.0.1:4096",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverPassword: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "서버 비밀번호",
        description: "디스크에 일반 텍스트로 저장됩니다.",
        providerSettingsForm: {
          control: "password",
          placeholder: "선택 사항",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    apiConnection: Schema.optionalKey(OpenCodeApiConnection).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "serverUrl", "serverPassword"],
  },
);
export type OpenCodeSettings = typeof OpenCodeSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const SourceControlWritingStyleMode = Schema.Literals([
  "repo_conventions",
  "conventional_commits",
  "custom",
]);
export type SourceControlWritingStyleMode = typeof SourceControlWritingStyleMode.Type;

export const SourceControlWritingStyleSettings = Schema.Struct({
  mode: SourceControlWritingStyleMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("repo_conventions" as const)),
  ),
  customInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  followChangeRequestTemplates: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
});
export type SourceControlWritingStyleSettings = typeof SourceControlWritingStyleSettings.Type;

export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.seconds(30);
export const DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL = Duration.minutes(5);

export const BackgroundActivityProfile = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
]);
export type BackgroundActivityProfile = typeof BackgroundActivityProfile.Type;
export const DEFAULT_BACKGROUND_ACTIVITY_PROFILE: BackgroundActivityProfile = "balanced";

export const BackgroundActivityProfileSelection = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
  "custom",
]);
export type BackgroundActivityProfileSelection = typeof BackgroundActivityProfileSelection.Type;

export const BackgroundActivityOverrides = Schema.Struct({
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorActiveInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorIdleInterval: Schema.optionalKey(Schema.DurationFromMillis),
  idleClientTtl: Schema.optionalKey(Schema.DurationFromMillis),
  pauseWhenHostLocked: Schema.optionalKey(Schema.Boolean),
  pauseWhenHostLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenClientLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenOnBattery: Schema.optionalKey(Schema.Boolean),
});
export type BackgroundActivityOverrides = typeof BackgroundActivityOverrides.Type;

export const BackgroundActivitySettings = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  profile: BackgroundActivityProfileSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  baseProfile: Schema.optionalKey(BackgroundActivityProfile),
  overrides: BackgroundActivityOverrides.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type BackgroundActivitySettings = typeof BackgroundActivitySettings.Type;

export const AiSearchEmbeddingMode = Schema.Literals(["embedding", "rerank"]);
export type AiSearchEmbeddingMode = typeof AiSearchEmbeddingMode.Type;

export const AiSearchSettings = Schema.Struct({
  semanticEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  embeddingEndpoint: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("http://127.0.0.1:11434")),
  ),
  /**
   * Optional registered provider instance ID used for document semantic search.
   * `null` or omitted uses the local Ollama server at `embeddingEndpoint`.
   */
  embeddingInstanceId: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
  /**
   * `"embedding"` uses vector embeddings (`/api/embed` or OpenAI-compatible `/embeddings`);
   * `"rerank"` uses a registered chat/reasoning model to semantically score search candidates.
   */
  embeddingMode: Schema.optionalKey(AiSearchEmbeddingMode),
  embeddingModel: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("embeddinggemma:300m-qat-q4_0")),
  ),
  ocrEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  documentCacheEnabled: Schema.optionalKey(Schema.Boolean),
  documentCacheEpoch: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  researchModel: TrimmedNonEmptyString.pipe(Schema.withDecodingDefault(Effect.succeed("grok-4.7"))),
  researchMaxTurns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(3)),
  ),
  researchDailyUsd: Schema.NullOr(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type AiSearchSettings = typeof AiSearchSettings.Type;

/** User-authored assistant identity, independent of the model or provider. */
export const ThreadAssistantProfile = Schema.Struct({
  name: Schema.String,
  instructions: Schema.String,
});
export type ThreadAssistantProfile = typeof ThreadAssistantProfile.Type;

const ThreadAssistantOverride = Schema.Struct({
  ...ThreadAssistantProfile.fields,
  mode: Schema.optionalKey(Schema.Literals(["global", "custom"])),
});

/**
 * The role a conversation saved for itself. A conversation set to "global" has none: it
 * follows the global answer style, which replaced the global assistant profile.
 */
export function resolveAssistantProfile(
  override: typeof ThreadAssistantOverride.Type | undefined,
): ThreadAssistantProfile | undefined {
  return override && override.mode !== "global" ? override : undefined;
}

export const ThreadAssistantComputer = Schema.Struct({
  containerId: TrimmedNonEmptyString,
  ownerId: TrimmedNonEmptyString,
  image: TrimmedNonEmptyString,
  network: Schema.Literals(["none", "bridge"]),
  kind: Schema.optionalKey(Schema.Literals(["container", "vm"])),
});
export type ThreadAssistantComputer = typeof ThreadAssistantComputer.Type;

export const UpgradeRoomOfflineQuestions = Schema.Literals(["decide", "wait"]);
export type UpgradeRoomOfflineQuestions = typeof UpgradeRoomOfflineQuestions.Type;

export const ServerSettings = Schema.Struct({
  globalAssistant: Schema.NullOr(GlobalAssistantConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  globalResponseStyle: Schema.NullOr(ThreadResponseStyle).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  globalSubordinateTeam: Schema.Array(ThreadTeamMember).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  threadSubordinateTeams: Schema.Record(
    ThreadId,
    Schema.NullOr(Schema.Array(ThreadTeamMember)),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // Stored with the team overrides. Only the settings service writes initialization receipts.
  threadModelTeamInitialization: Schema.optionalKey(
    Schema.Struct({
      initializedThreads: Schema.Array(ThreadId),
      resetScopes: Schema.Array(ThreadModelTeamScope),
    }),
  ),
  threadSettingsInheritedTeamScopes: Schema.Array(ThreadModelTeamScope).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  threadSettingsPresets: Schema.Array(ThreadSettingsPreset).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  threadModelTeams: Schema.Array(ThreadModelTeam).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  threadResponseStyles: Schema.Record(TrimmedNonEmptyString, ThreadResponseStyle).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  threadCharacters: Schema.Record(TrimmedNonEmptyString, ThreadCharacter).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  // Retired: the global answer style replaced it. Kept so settings saved earlier still decode.
  globalAssistantProfile: Schema.NullOr(ThreadAssistantProfile).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  threadAssistantProfiles: Schema.Record(TrimmedNonEmptyString, ThreadAssistantOverride).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  threadAssistantComputers: Schema.Record(
    TrimmedNonEmptyString,
    Schema.NullOr(ThreadAssistantComputer),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  threadCreatorModes: Schema.Record(TrimmedNonEmptyString, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /** Wave 3-B2: per-thread opt-out map for proactive context compaction (false/absent = enabled). */
  threadProactiveCompactDisabled: Schema.Record(ThreadId, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  searchModels: Schema.Array(WorkspaceSearchModel).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  aiSearch: AiSearchSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  customMcpServers: Schema.Record(McpServerName, ManagedMcpServerConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  mcpProjectProfiles: Schema.Record(TrimmedNonEmptyString, McpProjectProfile).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  mcpTools: Schema.Struct({
    openaiDocs: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    context7: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    filesystem: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    sequentialThinking: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    claudeTools: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  executionProfiles: Schema.Record(TrimmedNonEmptyString, WorkspaceExecutionProfile).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /** Which models work under which answering model; edited in account settings ("하위 모델"). */
  subordinateModels: Schema.Array(SubordinateAssignment).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  // Legacy token-by-token assistant output. Deliberately a fresh key (was
  // `enableAssistantStreaming`): decoding drops the old key, so everyone,
  // including prior opt-ins, resets to the buffered default.
  enableLegacyTokenStreaming: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  backgroundActivity: BackgroundActivitySettings,
  // Legacy flat fields retained for old settings files and old clients. New
  // consumers should resolve `backgroundActivity` instead.
  automaticGitFetchInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
  providerHealthRefreshInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL)),
    ),
  ),
  backgroundActivityProfile: BackgroundActivityProfile.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const satisfies ThreadEnvMode)),
  ),
  newWorktreesStartFromOrigin: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_TEXT_GENERATION_MODEL,
        options: [
          {
            id: "reasoningEffort",
            value: DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
          },
        ],
      }),
    ),
  ),
  sourceControlWritingStyle: SourceControlWritingStyleSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  sourceControlWriterModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),

  // Legacy single-instance-per-driver settings. Continues to be the source
  // of truth until `providerInstances` (below) lands per-driver migration
  // shims and the server starts hydrating instances from it. Driver-specific
  // schemas live here for the duration of the migration; once each driver
  // owns its config in its own package, this struct shrinks to nothing and
  // is removed entirely.
  providerAutoSwitch: Schema.Struct({
    codex: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    claudeAgent: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    grok: GrokSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    gemini: GeminiSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    muse: MuseSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // New driver-agnostic instance map. Keyed by `ProviderInstanceId`; values
  // are `ProviderInstanceConfig` envelopes. The driver-specific config blob
  // is `Schema.Unknown` at this layer so envelopes with unknown drivers
  // (forks, downgrades, in-flight PR branches) round-trip without loss.
  // See providerInstance.ts for the forward/backward compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  workspaceProgramPermissions: WorkspaceProgramPermissions.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  selfMonitoring: SelfMonitoringSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  backgroundWatchThreadIds: Schema.Array(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Server-written revocation times prevent stale watch work from surviving a later opt-in. */
  backgroundWatchRevokedAtMs: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, NonNegativeInt),
  ),
  /** Visibility of the background watch interruption banner, in seconds. Zero hides it. */
  backgroundWatchNoticeSeconds: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(30))),
  /** Shows the "T3가 꺼진 동안 한 작업" window in the upgrade room after a restart. */
  upgradeRoomDowntimeSummary: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** While T3 is off: "decide" tells the model the user is away; "wait" holds questions until T3 returns. */
  upgradeRoomOfflineQuestions: UpgradeRoomOfflineQuestions.pipe(
    Schema.withDecodingDefault(
      Effect.succeed("decide" as const satisfies UpgradeRoomOfflineQuestions),
    ),
  ),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export const ServerSettingsOperation = Schema.Literals([
  "normalize",
  "check-exists",
  "read-file",
  "read-secret",
  "remove-secret",
  "remove-stale-secret",
  "write-secret",
  "write-file",
  "prepare-directory",
]);
export type ServerSettingsOperation = typeof ServerSettingsOperation.Type;

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    operation: ServerSettingsOperation,
    providerInstanceId: Schema.optional(Schema.String),
    environmentVariable: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const provider =
      this.providerInstanceId === undefined ? "" : ` for provider ${this.providerInstanceId}`;
    const variable =
      this.environmentVariable === undefined
        ? ""
        : ` and environment variable ${this.environmentVariable}`;
    return `Server settings ${this.operation} failed${provider}${variable} at ${this.settingsPath}.`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  shadowHomePath: Schema.optionalKey(TrimmedString),
  launchArgs: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  authMode: Schema.optionalKey(Schema.Literal("api-key")),
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  launchArgs: Schema.optionalKey(TrimmedString),
});

const CursorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  apiEndpoint: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const GrokSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const GeminiSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  autoOptimizeThoughtLevel: Schema.optionalKey(Schema.Boolean),
  helperAccount: Schema.optionalKey(TrimmedString),
  helperForModels: Schema.optionalKey(TrimmedString),
  helperScope: Schema.optionalKey(Schema.Literals(["public", "project"])),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OpenCodeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  serverUrl: Schema.optionalKey(TrimmedString),
  serverPassword: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  apiConnection: Schema.optionalKey(OpenCodeApiConnection),
});

const MuseSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  backendMode: Schema.optionalKey(MuseBackendMode),
  binaryPath: Schema.optionalKey(TrimmedString),
  cloudBinaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ServerSettingsPatch = Schema.Struct({
  globalAssistant: Schema.optionalKey(Schema.NullOr(GlobalAssistantConfig)),
  globalResponseStyle: Schema.optionalKey(Schema.NullOr(ThreadResponseStyle)),
  globalSubordinateTeam: Schema.optionalKey(Schema.Array(ThreadTeamMember)),
  threadSubordinateTeamUpdate: Schema.optionalKey(ThreadSubordinateTeamUpdate),
  threadSettingsPresetSave: Schema.optionalKey(ThreadSettingsPreset),
  threadSettingsPresetRemove: Schema.optionalKey(TrimmedNonEmptyString),
  threadModelTeamUpdate: Schema.optionalKey(ThreadModelTeamUpdate),
  threadResponseStyles: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, ThreadResponseStyle),
  ),
  searchModels: Schema.optionalKey(Schema.Array(WorkspaceSearchModel)),
  aiSearch: Schema.optionalKey(
    Schema.Struct({
      semanticEnabled: Schema.optionalKey(Schema.Boolean),
      embeddingEndpoint: Schema.optionalKey(TrimmedNonEmptyString),
      embeddingInstanceId: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
      embeddingMode: Schema.optionalKey(AiSearchEmbeddingMode),
      embeddingModel: Schema.optionalKey(TrimmedNonEmptyString),
      ocrEnabled: Schema.optionalKey(Schema.Boolean),
      documentCacheEnabled: Schema.optionalKey(Schema.Boolean),
      documentCacheEpoch: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      researchModel: Schema.optionalKey(TrimmedNonEmptyString),
      researchMaxTurns: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
      ),
      researchDailyUsd: Schema.optionalKey(
        Schema.NullOr(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))),
      ),
    }),
  ),
  threadCharacters: Schema.optionalKey(Schema.Record(TrimmedNonEmptyString, ThreadCharacter)),
  globalAssistantProfile: Schema.optionalKey(Schema.NullOr(ThreadAssistantProfile)),
  threadAssistantProfiles: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, ThreadAssistantOverride),
  ),
  threadAssistantComputers: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, Schema.NullOr(ThreadAssistantComputer)),
  ),
  threadCreatorModes: Schema.optionalKey(Schema.Record(TrimmedNonEmptyString, Schema.Boolean)),
  customMcpServersToUpsert: Schema.optionalKey(
    Schema.Record(McpServerName, ManagedMcpServerConfig),
  ),
  customMcpServerIdsToRemove: Schema.optionalKey(Schema.Array(McpServerName)),
  mcpProjectProfilesToUpsert: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, McpProjectProfile),
  ),
  mcpProjectProfileRootsToRemove: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  mcpTools: Schema.optionalKey(
    Schema.Struct({
      openaiDocs: Schema.optionalKey(Schema.Boolean),
      context7: Schema.optionalKey(Schema.Boolean),
      filesystem: Schema.optionalKey(Schema.Boolean),
      sequentialThinking: Schema.optionalKey(Schema.Boolean),
      claudeTools: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  executionProfilesToUpsert: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, WorkspaceExecutionProfile),
  ),
  executionProfileIdsToRemove: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** Replaces the whole list. */
  subordinateModels: Schema.optionalKey(Schema.Array(SubordinateAssignment)),
  providerAutoSwitch: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(Schema.Boolean),
      claudeAgent: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  // Server settings
  enableLegacyTokenStreaming: Schema.optionalKey(Schema.Boolean),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  backgroundActivity: Schema.optionalKey(
    Schema.Struct({
      schemaVersion: Schema.optionalKey(Schema.Literal(1)),
      profile: Schema.optionalKey(BackgroundActivityProfileSelection),
      baseProfile: Schema.optionalKey(BackgroundActivityProfile),
      overrides: Schema.optionalKey(BackgroundActivityOverrides),
    }),
  ),
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  backgroundActivityProfile: Schema.optionalKey(BackgroundActivityProfile),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  sourceControlWritingStyle: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(SourceControlWritingStyleMode),
      customInstructions: Schema.optionalKey(TrimmedString),
      followChangeRequestTemplates: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(TrimmedString),
      otlpMetricsUrl: Schema.optionalKey(TrimmedString),
    }),
  ),
  workspaceProgramPermissions: Schema.optionalKey(
    Schema.Struct({
      manualControl: Schema.optionalKey(Schema.Boolean),
      collectLogs: Schema.optionalKey(Schema.Boolean),
      autoStart: Schema.optionalKey(Schema.Boolean),
      autoDiagnosis: Schema.optionalKey(Schema.Boolean),
      autoRestartAfterRepair: Schema.optionalKey(Schema.Boolean),
      monitoringAutoActions: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  backgroundWatchThreadUpdate: Schema.optionalKey(
    Schema.Struct({ threadId: ThreadId, enabled: Schema.Boolean }),
  ),
  backgroundWatchNoticeSeconds: Schema.optionalKey(NonNegativeInt),
  upgradeRoomDowntimeSummary: Schema.optionalKey(Schema.Boolean),
  upgradeRoomOfflineQuestions: Schema.optionalKey(UpgradeRoomOfflineQuestions),
  selfMonitoring: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      projectId: Schema.optionalKey(Schema.NullOr(ProjectId)),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      cursor: Schema.optionalKey(CursorSettingsPatch),
      grok: Schema.optionalKey(GrokSettingsPatch),
      gemini: Schema.optionalKey(GeminiSettingsPatch),
      opencode: Schema.optionalKey(OpenCodeSettingsPatch),
      muse: Schema.optionalKey(MuseSettingsPatch),
    }),
  ),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  // The web UI sends a fully-formed map every time it edits this field.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
  // Merge account entries under the settings write lock, preserving concurrent additions.
  providerInstancesToUpsert: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, ProviderInstanceConfig),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export const ClientSettingsPatch = Schema.Struct({
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  diffIgnoreWhitespace: Schema.optionalKey(Schema.Boolean),
  environmentIdentificationMode: Schema.optionalKey(EnvironmentIdentificationMode),
  glassOpacity: Schema.optionalKey(GlassOpacity),
  chatHorizontalInsetPx: Schema.optionalKey(ChatHorizontalInsetPx),
  fontSizeInterface: Schema.optionalKey(InterfaceFontSize),
  fontSizePrompt: Schema.optionalKey(PromptFontSize),
  fontSizeCode: Schema.optionalKey(CodeFontSize),
  fontSizeTerminal: Schema.optionalKey(TerminalFontSize),
  fontFamilyCode: Schema.optionalKey(FontFamilyPreference),
  fontFamilyComposer: Schema.optionalKey(FontFamilyPreference),
  fontFamilySans: Schema.optionalKey(FontFamilyPreference),
  fontFamilyTerminal: Schema.optionalKey(FontFamilyPreference),
  fontSmoothing: Schema.optionalKey(Schema.Boolean),
  favorites: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        provider: ProviderInstanceId,
        model: TrimmedNonEmptyString,
      }),
    ),
  ),
  providerModelPreferences: Schema.optionalKey(
    Schema.Record(
      ProviderInstanceId,
      Schema.Struct({
        hiddenModels: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
        modelOrder: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
      }),
    ),
  ),
  planModeEnabled: Schema.optionalKey(Schema.Boolean),
  legacySidebarEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarAutoSettleAfterDays: Schema.optionalKey(Schema.NullOr(SidebarAutoSettleAfterDays)),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  sidebarThreadPreviewCount: Schema.optionalKey(SidebarThreadPreviewCount),
  timestampFormat: Schema.optionalKey(TimestampFormat),
  timelineMinimapEnabled: Schema.optionalKey(Schema.Boolean),
  wordWrap: Schema.optionalKey(Schema.Boolean),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
