import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { SkillBinding } from "./agentSkills.ts";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

// ============================================================================
// 0. Engine Limits & Versioning Constants
// ============================================================================

export const WORKFLOW_SCHEMA_VERSION_V1 = 1 as const;
export const WORKFLOW_SCHEMA_VERSION_V2 = 2 as const;

/** 정적 그래프 정의에 허용되는 최대 노드 수 (런타임 동적 팬아웃 인스턴스와는 별개) */
export const WORKFLOW_MAX_STATIC_NODES = 24 as const;
/** MapFanOut 노드가 런타임에 동적 생성할 수 있는 최대 병렬 태스크 상한 */
export const WORKFLOW_MAX_DYNAMIC_FANOUT = 64 as const;
/** 단일 LoopSpec에서 허용하는 최대 순환 반복 상한 */
export const WORKFLOW_MAX_LOOP_ITERATIONS = 20 as const;
/** 하위 워크플로(Subworkflow) 재귀/중첩 호출 최대 깊이 */
export const WORKFLOW_MAX_SUBWORKFLOW_DEPTH = 4 as const;

// ============================================================================
// 1. Existing T3 V1 Contracts (Preserved for 100% Backward Compatibility)
// ============================================================================

const Slug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
);

/** v1 하위 호환용 레거시 에이전트 리터럴 */
export const LegacyWorkflowAgent = Schema.Literals(["fable", "codex", "grok"]);
export type LegacyWorkflowAgent = typeof LegacyWorkflowAgent.Type;

/** v1 하위 호환용 레거시 노드 종류 */
export const LegacyWorkflowNodeKind = Schema.Literals([
  "orchestration",
  "research",
  "implementation",
  "debug",
]);
export type LegacyWorkflowNodeKind = typeof LegacyWorkflowNodeKind.Type;

export const WorkflowInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  type: Schema.Literals(["string", "number", "boolean", "path"]),
  required: Schema.Boolean,
  defaultValue: Schema.String,
});
export type WorkflowInput = typeof WorkflowInput.Type;

export const WorkflowNode = Schema.Struct({
  id: Slug,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  kind: LegacyWorkflowNodeKind,
  agent: LegacyWorkflowAgent,
  participantId: Schema.NullOr(Schema.String),
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
  dependsOn: Schema.Array(Slug),
  successCriteria: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(4000))),
  skills: Schema.Array(SkillBinding),
});
export type WorkflowNode = typeof WorkflowNode.Type;

export const WorkflowValues = Schema.Record(Schema.String, Schema.String);
export type WorkflowValues = typeof WorkflowValues.Type;

export const WorkflowExecutionContext = Schema.Struct({
  definitionId: Schema.String,
  definitionRevision: NonNegativeInt,
  definitionDigest: Schema.String,
  title: Schema.String,
  values: WorkflowValues,
  nodeSkills: Schema.Array(
    Schema.Struct({ nodeId: Schema.String, skills: Schema.Array(SkillBinding) }),
  ),
  control: Schema.Literals(["active", "pause-requested", "paused"]),
  controlRevision: NonNegativeInt,
  executionRevision: Schema.optionalKey(NonNegativeInt),
  updatedAt: IsoDateTime,
  requestDigest: Schema.String,
  requestMode: Schema.optionalKey(Schema.Literals(["direct", "ask-first", "conditions"])),
});
export type WorkflowExecutionContext = typeof WorkflowExecutionContext.Type;

// ============================================================================
// 2. V2 Branded Identifiers & Primitive Contracts
// ============================================================================

/**
 * v1 기존 ID(숫자 시작, 하이픈, 언더스코어, 콜론, 점 포함)와 100% 호환되면서
 * 공백 및 제어문자를 차단하는 식별자 규칙
 */
const IdentifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

export const WorkflowNodeId = Schema.String.check(
  Schema.isPattern(IdentifierPattern, {
    message:
      "WorkflowNodeId must start with an alphanumeric character and contain only [a-zA-Z0-9_.:-] (max 128 chars).",
  }),
).pipe(Schema.brand("WorkflowNodeId"));
export type WorkflowNodeId = typeof WorkflowNodeId.Type;

export const WorkflowEdgeId = Schema.String.check(Schema.isPattern(IdentifierPattern)).pipe(
  Schema.brand("WorkflowEdgeId"),
);
export type WorkflowEdgeId = typeof WorkflowEdgeId.Type;

export const WorkflowLoopId = Schema.String.check(Schema.isPattern(IdentifierPattern)).pipe(
  Schema.brand("WorkflowLoopId"),
);
export type WorkflowLoopId = typeof WorkflowLoopId.Type;

export const WorkflowDefinitionId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
).pipe(Schema.brand("WorkflowDefinitionId"));
export type WorkflowDefinitionId = typeof WorkflowDefinitionId.Type;

export const ArtifactId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).pipe(
  Schema.brand("ArtifactId"),
);
export type ArtifactId = typeof ArtifactId.Type;

/**
 * 바인딩 표현식 문자열
 * 예: "{{inputs.targetBranch}}", "{{nodes.analyze.output.files}}", "$.nodes.scan.output.targets"
 */
export const BindingExpression = TrimmedNonEmptyString;
export type BindingExpression = typeof BindingExpression.Type;

/** JSON Schema Draft 2020-12 호환 객체 페이로드 */
export const JsonSchemaObject = Schema.Record(Schema.String, Schema.Unknown);
export type JsonSchemaObject = typeof JsonSchemaObject.Type;

// ============================================================================
// 3. Capability Routing, Isolation & Execution Policies
// ============================================================================

/** v2 역량 기반 추상 라우팅 프로필 */
export const CapabilityProfile = Schema.Literals([
  "deep-architect", // 고난도 설계, 근본 원인 추론, 복잡한 계획 수립
  "code-surgeon", // 멀티파일 수정, 구현, 테스트 작성, 병합 충돌 해결
  "fast-scout", // 빠른 코드베이스 탐색, 파일 후보 수집, 경량 분류
  "adversarial-reviewer", // 교차 모델 코드 리뷰, 보안/엣지 케이스 적대적 검증
  "local-zero-cost", // 로컬 Ollama/EXAONE 기반 요약, 포맷 교정, 프라이버시 작업
  "custom", // 사용자 지정 라우팅 규칙 직접 사용
]);
export type CapabilityProfile = typeof CapabilityProfile.Type;

export const ProviderFamily = Schema.Literals([
  "anthropic",
  "openai",
  "google",
  "xai",
  "antigravity",
  "opencode",
  "local-ollama",
  "local-exaone",
]);
export type ProviderFamily = typeof ProviderFamily.Type;

export const PrivacyTier = Schema.Literals(["standard", "no_training_retention", "local_only"]);
export type PrivacyTier = typeof PrivacyTier.Type;

export const ModelRoutingRequirements = Schema.Struct({
  requiresStructuredOutput: Schema.optionalKey(Schema.Boolean),
  requiresToolUse: Schema.optionalKey(Schema.Boolean),
  requiresShellAccess: Schema.optionalKey(Schema.Boolean),
  minContextTokens: Schema.optionalKey(PositiveInt),
  privacy: Schema.optionalKey(PrivacyTier),
  preferredProviders: Schema.optionalKey(Schema.Array(ProviderFamily)),
  /** 교차 검증(Adversarial Critique) 시 앞선 구현 노드와 동일 계열 모델 배제용 */
  excludeProviderFamilies: Schema.optionalKey(Schema.Array(ProviderFamily)),
  /** v1에서 업캐스트된 노드의 원래 에이전트 선호 힌트 보존 */
  legacyAgentHint: Schema.optionalKey(LegacyWorkflowAgent),
});
export type ModelRoutingRequirements = typeof ModelRoutingRequirements.Type;

/** 파일시스템 격리 수준 */
export const IsolationMode = Schema.Literals([
  "shared_readonly", // 루트 워크스페이스 읽기 전용 접근 (분석/탐색/검증용)
  "shared_write", // 단일 워크스페이스 직접 수정 (순차 노드 및 v1 호환 기본값)
  "git_worktree", // 노드 전용 임시 Git Worktree + Junction 격리 (병렬 구현용)
]);
export type IsolationMode = typeof IsolationMode.Type;

/** 다중 상위 엣지 합류(Join) 실행 조건 */
export const JoinPolicy = Schema.Literals([
  "all_succeeded", // 모든 상위 노드가 succeeded여야 실행 (기본값)
  "all_resolved_at_least_one_succeeded", // 조건부 분기 합류용: 상위 노드가 모두 종료(succeeded | skipped)되고 최소 1개 성공 시 실행
  "first_succeeded", // 경쟁 실행용: 가장 먼저 성공한 상위 결과 채택 후 형제 Fiber 취소
]);
export type JoinPolicy = typeof JoinPolicy.Type;

/** 메모이제이션 캐시 및 재시도 안전성 판별을 위한 부작용 분류 */
export const SideEffectPolicy = Schema.Literals([
  "pure_readonly", // 외부/파일 변이 없음 (안전하게 캐시 재사용 가능)
  "workspace_mutation", // 로컬 Git 트리 변경만 발생 (입력 SHA 동일 시 캐시 커밋 복원 가능)
  "external_idempotent", // 멱등성 키가 보장된 외부 API 호출
  "external_non_idempotent", // 원격 푸시, 웹훅, 알림 등 캐시 스킵 금지 대상
]);
export type SideEffectPolicy = typeof SideEffectPolicy.Type;

// ============================================================================
// 4. Budgets, Retries, Artifacts & Input Schemas
// ============================================================================

const PositiveNumber = Schema.Number.check(Schema.isGreaterThan(0));

export const BudgetPolicy = Schema.Struct({
  maxTotalTokens: Schema.optionalKey(PositiveInt),
  maxCostUsd: Schema.optionalKey(PositiveNumber),
  maxWallTimeMs: Schema.optionalKey(PositiveInt),
  maxToolCalls: Schema.optionalKey(PositiveInt),
  /** 소프트 임계치 비율 (예: 0.8 도달 시 컨텍스트 압축 또는 모델 티어 강등) */
  softThresholdRatio: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 0.99 })),
  ),
  onSoftThreshold: Schema.optionalKey(
    Schema.Literals(["warn_only", "compact_context", "downgrade_capability"]),
  ),
  onHardExceeded: Schema.optionalKey(Schema.Literals(["pause_run", "fail_node"])),
});
export type BudgetPolicy = typeof BudgetPolicy.Type;

export const RetryFailureReason = Schema.Literals([
  "provider_rate_limit",
  "transient_network",
  "schema_validation_failed",
  "timeout",
  "tool_execution_error",
]);
export type RetryFailureReason = typeof RetryFailureReason.Type;

export const RetryPolicy = Schema.Struct({
  maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  backoffStrategy: Schema.Literals(["fixed", "exponential_jitter"]),
  initialDelayMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 300_000 })),
  maxDelayMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600_000 })),
  retryOn: Schema.Array(RetryFailureReason),
});
export type RetryPolicy = typeof RetryPolicy.Type;

export const ArtifactKind = Schema.Literals([
  "git_patch",
  "test_report_json",
  "command_log",
  "markdown_document",
  "structured_json",
  "sarif_report",
]);
export type ArtifactKind = typeof ArtifactKind.Type;

/** CAS 아티팩트 버스에 저장된 대용량 산출물 경량 참조 포인터 */
export const ArtifactRef = Schema.Struct({
  artifactId: ArtifactId,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  kind: ArtifactKind,
  byteSize: NonNegativeInt,
  lineCount: Schema.optionalKey(NonNegativeInt),
  previewHead: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
});
export type ArtifactRef = typeof ArtifactRef.Type;

export const WorkflowInputValueType = Schema.Literals([
  "string",
  "number",
  "boolean",
  "string_array",
  "json",
  "git_ref",
  "file_path",
]);
export type WorkflowInputValueType = typeof WorkflowInputValueType.Type;

export const WorkflowInputParameterV2 = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/)),
  label: TrimmedNonEmptyString,
  description: Schema.optionalKey(Schema.String),
  valueType: WorkflowInputValueType,
  required: Schema.Boolean,
  defaultValue: Schema.optionalKey(Schema.Unknown),
  secret: Schema.optionalKey(Schema.Boolean),
});
export type WorkflowInputParameterV2 = typeof WorkflowInputParameterV2.Type;

// ============================================================================
// 5. Deterministic Verifier Specifications
// ============================================================================

export const CommandExitVerifierSpec = Schema.Struct({
  type: Schema.Literal("command_exit"),
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  cwdRelative: Schema.optionalKey(Schema.String),
  expectedExitCodes: Schema.optionalKey(Schema.Array(Schema.Int)),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 3_600_000 })),
  envAllowlist: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type CommandExitVerifierSpec = typeof CommandExitVerifierSpec.Type;

export const StructuredReportFormat = Schema.Literals([
  "vitest_json",
  "junit_xml",
  "eslint_json",
  "tsc_diagnostics",
  "sarif",
]);
export type StructuredReportFormat = typeof StructuredReportFormat.Type;

export const StructuredReportVerifierSpec = Schema.Struct({
  type: Schema.Literal("structured_report"),
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  reportFormat: StructuredReportFormat,
  reportFilePath: Schema.optionalKey(Schema.String),
  maxExtractedFailures: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 3_600_000 })),
});
export type StructuredReportVerifierSpec = typeof StructuredReportVerifierSpec.Type;

export const GitDiffGuardVerifierSpec = Schema.Struct({
  type: Schema.Literal("git_diff_guard"),
  forbiddenPathGlobs: Schema.Array(Schema.String),
  allowedPathGlobs: Schema.optionalKey(Schema.Array(Schema.String)),
  maxChangedFiles: Schema.optionalKey(PositiveInt),
  maxDeletedLinesRatio: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ),
  blockPotentialSecrets: Schema.Boolean,
});
export type GitDiffGuardVerifierSpec = typeof GitDiffGuardVerifierSpec.Type;

export const SchemaAssertVerifierSpec = Schema.Struct({
  type: Schema.Literal("schema_assert"),
  targetExpression: BindingExpression,
  jsonSchema: JsonSchemaObject,
  /** JSON 내 추출된 파일 경로 배열이 실제 디스크에 존재하는지 추가 검증 */
  verifyDiskPathsAtPointer: Schema.optionalKey(Schema.String),
});
export type SchemaAssertVerifierSpec = typeof SchemaAssertVerifierSpec.Type;

export const VerifierSpec = Schema.Union([
  CommandExitVerifierSpec,
  StructuredReportVerifierSpec,
  GitDiffGuardVerifierSpec,
  SchemaAssertVerifierSpec,
]);
export type VerifierSpec = typeof VerifierSpec.Type;

// ============================================================================
// 6. V2 Node Variants (7 First-Class Node Kinds)
// ============================================================================

const CommonNodeMetadata = Schema.Record(Schema.String, Schema.Unknown);

const BaseWorkflowNodeFields = {
  id: WorkflowNodeId,
  title: TrimmedNonEmptyString,
  description: Schema.optionalKey(Schema.String),
  joinPolicy: JoinPolicy,
  retryPolicy: Schema.optionalKey(RetryPolicy),
  budget: Schema.optionalKey(BudgetPolicy),
  metadata: Schema.optionalKey(CommonNodeMetadata),
} as const;

/** 6.1 자율 에이전트 실행 노드 */
export const AgentNodeV2 = Schema.Struct({
  ...BaseWorkflowNodeFields,
  kind: Schema.Literal("agent"),
  promptTemplate: TrimmedNonEmptyString,
  capability: CapabilityProfile,
  routing: Schema.optionalKey(ModelRoutingRequirements),
  isolation: IsolationMode,
  sideEffectPolicy: SideEffectPolicy,
  /** 상위 노드 산출물 및 워크플로 입력을 로컬 변수명으로 매핑 */
  inputBindings: Schema.Record(Schema.String, BindingExpression),
  /** 에이전트가 반드시 반환해야 하는 구조화된 JSON 출력 계약 */
  outputSchema: Schema.optionalKey(JsonSchemaObject),
  /**
   * v1 `successCriteria`에서 이관된 자연어 가이드라인.
   * 기계적 합격 판정은 `verifier` 노드가 담당하며 이 필드는 프롬프트 체크리스트로만 주입됨.
   */
  advisoryCriteria: Schema.Array(Schema.String),
  /** 이전 대화 이력을 상속하지 않고 깨끗한 핸드오프 봉투로 세션을 시작할지 여부 */
  cleanContext: Schema.Boolean,
  cacheable: Schema.Boolean,
  /** T3 v1 통합 작업 참가자·스킬·원래 노드 종류 무손실 보존 필드 */
  participantId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  skills: Schema.optionalKey(Schema.Array(SkillBinding)),
  legacyKind: Schema.optionalKey(LegacyWorkflowNodeKind),
});
export type AgentNodeV2 = typeof AgentNodeV2.Type;

/** 6.2 LLM 호출 없는 결정론적 기계 검증 노드 */
export const DeterministicVerifierNodeV2 = Schema.Struct({
  ...BaseWorkflowNodeFields,
  kind: Schema.Literal("verifier"),
  isolation: Schema.Literals(["shared_readonly", "git_worktree"]),
  verifier: VerifierSpec,
});
export type DeterministicVerifierNodeV2 = typeof DeterministicVerifierNodeV2.Type;

/** 6.3 조건부 경로 분기 라우터 노드 */
export const RouterRouteOption = Schema.Struct({
  routeKey: TrimmedNonEmptyString,
  description: Schema.optionalKey(Schema.String),
  /** deterministic 모드일 때 평가할 비교 표현식 (예: "$.nodes.verify.output.exitCode == 0") */
  conditionExpr: Schema.optionalKey(Schema.String),
});
export type RouterRouteOption = typeof RouterRouteOption.Type;

export const RouterNodeV2 = Schema.Struct({
  ...BaseWorkflowNodeFields,
  kind: Schema.Literal("router"),
  mode: Schema.Literals(["deterministic_rules", "llm_classifier"]),
  classifierPrompt: Schema.optionalKey(Schema.String),
  classifierCapability: Schema.optionalKey(CapabilityProfile),
  routes: Schema.Array(RouterRouteOption).check(Schema.isMinLength(1)),
  defaultRouteKey: TrimmedNonEmptyString,
});
export type RouterNodeV2 = typeof RouterNodeV2.Type;

/** 6.4 사람 개입 승인 및 상태 편집 게이트 (`interrupt()`) */
export const HumanResolutionAction = Schema.Literals([
  "approve",
  "edit_and_approve",
  "request_revision",
  "abort",
]);
export type HumanResolutionAction = typeof HumanResolutionAction.Type;

export const HumanGateNodeV2 = Schema.Struct({
  ...BaseWorkflowNodeFields,
  kind: Schema.Literal("human_gate"),
  instructions: TrimmedNonEmptyString,
  /** 승인 UI에 하이라이트할 상위 산출물/아티팩트 표현식 목록 */
  reviewTargets: Schema.Array(BindingExpression),
  allowedActions: Schema.Array(HumanResolutionAction).check(Schema.isMinLength(1)),
  /** request_revision 선택 시 되돌아갈 루프 상단 노드 ID */
  revisionTargetNodeId: Schema.optionalKey(WorkflowNodeId),
  suspendTimeoutMs: Schema.optionalKey(PositiveInt),
  onTimeout: Schema.optionalKey(Schema.Literals(["keep_suspended", "abort", "auto_approve"])),
});
export type HumanGateNodeV2 = typeof HumanGateNodeV2.Type;

/** 6.5 런타임 배열 기반 동적 병렬 팬아웃 (`Send` / Scatter-Gather) */
export const MapWorkerInlineTemplate = Schema.Struct({
  targetKind: Schema.Literal("inline_agent"),
  promptTemplate: TrimmedNonEmptyString,
  capability: CapabilityProfile,
  routing: Schema.optionalKey(ModelRoutingRequirements),
  outputSchema: Schema.optionalKey(JsonSchemaObject),
});
export type MapWorkerInlineTemplate = typeof MapWorkerInlineTemplate.Type;

export const MapWorkerSubworkflowTemplate = Schema.Struct({
  targetKind: Schema.Literal("subworkflow"),
  definitionId: WorkflowDefinitionId,
  pinnedRevision: PositiveInt,
});
export type MapWorkerSubworkflowTemplate = typeof MapWorkerSubworkflowTemplate.Type;

export const MapFanOutNodeV2 = Schema.Struct({
  ...BaseWorkflowNodeFields,
  kind: Schema.Literal("map_fanout"),
  /** 순회할 배열을 가리키는 상위 바인딩 표현식 */
  itemsExpression: BindingExpression,
  /** 템플릿 내부에서 개별 원소를 참조할 변수명 (기본: "item") */
  itemVariableName: Schema.String.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/)),
  maxFanOut: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: WORKFLOW_MAX_DYNAMIC_FANOUT }),
  ),
  concurrencyLimit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })),
  isolationPerItem: Schema.Literals(["shared_readonly", "git_worktree"]),
  failurePolicy: Schema.Literals(["fail_fast", "continue_and_collect"]),
  workerTemplate: Schema.Union([MapWorkerInlineTemplate, MapWorkerSubworkflowTemplate]),
});
export type MapFanOutNodeV2 = typeof MapFanOutNodeV2.Type;

/** 6.6 병렬 Git Worktree 3-way 병합 및 충돌 해결 통합 노드 */
export const ReconcileWorktreesNodeV2 = Schema.Struct({
  ...BaseWorkflowNodeFields,
  kind: Schema.Literal("reconcile_worktrees"),
  /** 병합 대상 커밋을 생성한 상위 Worktree 노드 목록 (비어 있으면 직계 상위 전체 수집) */
  sourceNodeIds: Schema.Array(WorkflowNodeId),
  strategy: Schema.Literals([
    "git_merge_tree_strict", // 무충돌 자동 병합만 허용, 충돌 시 즉시 실패
    "agent_assisted_conflict_resolve", // 충돌 파일 발생 시 전용 에이전트로 해결 시도
  ]),
  conflictResolverCapability: Schema.optionalKey(CapabilityProfile),
  /** 병합 직후 실행할 빠른 스모크 검증 명령 (예: "vp run typecheck") */
  postMergeVerifyCommand: Schema.optionalKey(Schema.String),
});
export type ReconcileWorktreesNodeV2 = typeof ReconcileWorktreesNodeV2.Type;

/** 6.7 버전 고정 하위 워크플로 합성 노드 */
export const SubworkflowNodeV2 = Schema.Struct({
  ...BaseWorkflowNodeFields,
  kind: Schema.Literal("subworkflow"),
  targetDefinitionId: WorkflowDefinitionId,
  /** 상위 워크플로 재현성 보장을 위해 리비전 번호 고정 필수 */
  pinnedRevision: PositiveInt,
  isolation: IsolationMode,
  inputBindings: Schema.Record(Schema.String, BindingExpression),
});
export type SubworkflowNodeV2 = typeof SubworkflowNodeV2.Type;

export const WorkflowNodeV2 = Schema.Union([
  AgentNodeV2,
  DeterministicVerifierNodeV2,
  RouterNodeV2,
  HumanGateNodeV2,
  MapFanOutNodeV2,
  ReconcileWorktreesNodeV2,
  SubworkflowNodeV2,
]);
export type WorkflowNodeV2 = typeof WorkflowNodeV2.Type;

// ============================================================================
// 7. Explicit Edges & Bounded Cyclic Loop Specifications
// ============================================================================

export const WorkflowEdgeKind = Schema.Literals([
  "unconditional", // 무조건 전이 (기존 v1 dependsOn 대응)
  "conditional", // conditionExpr 평가가 참일 때만 활성화 (거짓이면 하위 skipped 전파)
  "route_match", // 상위 RouterNode의 선택된 routeKey와 일치할 때 활성화
  "loop_back", // 순환 루프 재진입 역방향 엣지 (Forward-DAG 위상 정렬 시 제외됨)
]);
export type WorkflowEdgeKind = typeof WorkflowEdgeKind.Type;

export const WorkflowEdgeV2 = Schema.Struct({
  id: WorkflowEdgeId,
  from: WorkflowNodeId,
  to: WorkflowNodeId,
  kind: WorkflowEdgeKind,
  conditionExpr: Schema.optionalKey(Schema.String),
  routeKey: Schema.optionalKey(TrimmedNonEmptyString),
  /** kind === "loop_back" 일 때 반드시 대응하는 LoopSpec의 loopId를 참조해야 함 */
  loopId: Schema.optionalKey(WorkflowLoopId),
});
export type WorkflowEdgeV2 = typeof WorkflowEdgeV2.Type;

export const StagnationDetectionPolicy = Schema.Struct({
  enabled: Schema.Boolean,
  /** 동일한 (gitDiffHash + errorSignature) 조합이 N회 재등장하면 진동 루프로 판정해 조기 종료 */
  historyWindowSize: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 10 })),
});
export type StagnationDetectionPolicy = typeof StagnationDetectionPolicy.Type;

export const LoopExhaustedAction = Schema.Literals([
  "fail_run",
  "interrupt_for_human",
  "escalate_capability_once",
]);
export type LoopExhaustedAction = typeof LoopExhaustedAction.Type;

export const LoopSpecV2 = Schema.Struct({
  loopId: WorkflowLoopId,
  entryNodeId: WorkflowNodeId,
  exitNodeId: WorkflowNodeId,
  maxIterations: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: WORKFLOW_MAX_LOOP_ITERATIONS }),
  ),
  /** 루프 정상 탈출 결정론적 조건 (예: "$.nodes.verify.output.passed == true") */
  exitConditionExpr: Schema.optionalKey(Schema.String),
  stagnationDetection: StagnationDetectionPolicy,
  onExhausted: LoopExhaustedAction,
});
export type LoopSpecV2 = typeof LoopSpecV2.Type;

// ============================================================================
// 8. WorkflowGraph V2 (Draft vs Validated Executable Contract)
// ============================================================================

export const UpcastMigrationProvenance = Schema.Struct({
  migratedFromSchemaVersion: Schema.Literal(WORKFLOW_SCHEMA_VERSION_V1),
  migratedAtIso: Schema.optionalKey(Schema.String),
  unverifiedCriteriaNodeIds: Schema.Array(WorkflowNodeId),
});
export type UpcastMigrationProvenance = typeof UpcastMigrationProvenance.Type;

/**
 * UI 빌더/초안 편집 중 임시 저장을 허용하는 구조 스키마
 */
export const WorkflowGraphV2Draft = Schema.Struct({
  schemaVersion: Schema.Literal(WORKFLOW_SCHEMA_VERSION_V2),
  /** T3 저장 정의 메타데이터 보존용 optional 필드 */
  id: Schema.optionalKey(WorkflowDefinitionId),
  title: Schema.optionalKey(TrimmedNonEmptyString),
  description: Schema.optionalKey(Schema.String),
  inputs: Schema.Array(WorkflowInputParameterV2),
  nodes: Schema.Array(WorkflowNodeV2),
  edges: Schema.Array(WorkflowEdgeV2),
  loops: Schema.Array(LoopSpecV2),
  runBudget: Schema.optionalKey(BudgetPolicy),
  migrationProvenance: Schema.optionalKey(UpcastMigrationProvenance),
});
export type WorkflowGraphV2Draft = typeof WorkflowGraphV2Draft.Type;

/**
 * 그래프 참조 무결성(중복 ID, 끊어진 엣지, 자기 참조, 루프 계약 불일치)을 검증하는 순수 함수.
 * 위상 정렬(Forward-DAG 비순환 증명) 및 조인 데드락 심층 분석은 `packages/shared/src/workflow.ts`에서 수행.
 */
export const collectGraphReferentialIssues = (graph: WorkflowGraphV2Draft): readonly string[] => {
  const issues: string[] = [];

  if (graph.nodes.length === 0) {
    issues.push("WorkflowGraphV2 must contain at least 1 node.");
  }
  if (graph.nodes.length > WORKFLOW_MAX_STATIC_NODES) {
    issues.push(
      `Static node count (${graph.nodes.length}) exceeds maximum limit (${WORKFLOW_MAX_STATIC_NODES}). Use 'map_fanout' or 'subworkflow' for larger workloads.`,
    );
  }

  const nodeMap = new Map<WorkflowNodeId, WorkflowNodeV2>();
  for (const node of graph.nodes) {
    if (nodeMap.has(node.id)) {
      issues.push(`Duplicate node id detected: "${node.id}".`);
    }
    nodeMap.set(node.id, node);
  }

  const inputKeys = new Set<string>();
  for (const input of graph.inputs) {
    if (inputKeys.has(input.key)) {
      issues.push(`Duplicate workflow input key detected: "${input.key}".`);
    }
    inputKeys.add(input.key);
  }

  const loopMap = new Map<WorkflowLoopId, LoopSpecV2>();
  for (const loop of graph.loops) {
    if (loopMap.has(loop.loopId)) {
      issues.push(`Duplicate loopId detected: "${loop.loopId}".`);
    }
    loopMap.set(loop.loopId, loop);
    if (!nodeMap.has(loop.entryNodeId)) {
      issues.push(`Loop "${loop.loopId}" entryNodeId "${loop.entryNodeId}" does not exist.`);
    }
    if (!nodeMap.has(loop.exitNodeId)) {
      issues.push(`Loop "${loop.loopId}" exitNodeId "${loop.exitNodeId}" does not exist.`);
    }
  }

  for (const node of graph.nodes) {
    if (node.kind === "human_gate" && node.revisionTargetNodeId !== undefined) {
      if (!nodeMap.has(node.revisionTargetNodeId)) {
        issues.push(
          `Human gate "${node.id}" revisionTargetNodeId "${node.revisionTargetNodeId}" does not exist.`,
        );
      }
    }
    if (node.kind === "reconcile_worktrees") {
      for (const sourceId of node.sourceNodeIds) {
        if (!nodeMap.has(sourceId)) {
          issues.push(`Reconcile node "${node.id}" references missing sourceNodeId "${sourceId}".`);
        }
      }
    }
    if (node.kind === "router") {
      const routeKeys = new Set(node.routes.map((route) => route.routeKey));
      if (routeKeys.size !== node.routes.length) {
        issues.push(`Router node "${node.id}" contains duplicate routeKey entries.`);
      }
      if (!routeKeys.has(node.defaultRouteKey)) {
        issues.push(
          `Router node "${node.id}" defaultRouteKey "${node.defaultRouteKey}" is not declared in routes.`,
        );
      }
    }
  }

  const edgeIds = new Set<WorkflowEdgeId>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push(`Duplicate edge id detected: "${edge.id}".`);
    }
    edgeIds.add(edge.id);

    if (!nodeMap.has(edge.from)) {
      issues.push(`Edge "${edge.id}" references missing source node "${edge.from}".`);
    }
    if (!nodeMap.has(edge.to)) {
      issues.push(`Edge "${edge.id}" references missing target node "${edge.to}".`);
    }
    if (edge.from === edge.to && edge.kind !== "loop_back") {
      issues.push(
        `Self-edge "${edge.id}" on node "${edge.from}" is forbidden unless kind is "loop_back" bound to a LoopSpec.`,
      );
    }
    if (edge.kind === "loop_back") {
      if (edge.loopId === undefined) {
        issues.push(`Back-edge "${edge.id}" must specify a valid "loopId".`);
      } else if (!loopMap.has(edge.loopId)) {
        issues.push(`Back-edge "${edge.id}" references undeclared loopId "${edge.loopId}".`);
      }
    }
    if (
      edge.kind === "conditional" &&
      (edge.conditionExpr === undefined || edge.conditionExpr.trim() === "")
    ) {
      issues.push(`Conditional edge "${edge.id}" requires a non-empty "conditionExpr".`);
    }
    if (edge.kind === "route_match") {
      if (edge.routeKey === undefined) {
        issues.push(`Route-match edge "${edge.id}" requires a "routeKey".`);
      } else {
        const source = nodeMap.get(edge.from);
        if (source && source.kind === "router") {
          const validRoute = source.routes.some((route) => route.routeKey === edge.routeKey);
          if (!validRoute) {
            issues.push(
              `Route-match edge "${edge.id}" routeKey "${edge.routeKey}" is not declared on router "${source.id}".`,
            );
          }
        }
      }
    }
  }

  return issues;
};

/**
 * 실행 엔진(`workspaceWorkflow.ts`)에 투입 가능한 무결성 검증 완료 WorkflowGraph v2 스키마
 */
export const WorkflowGraphV2 = WorkflowGraphV2Draft.check(
  Schema.makeFilter(
    (graph) => {
      const issues = collectGraphReferentialIssues(graph);
      return issues.length === 0 || new SchemaIssue.InvalidValue({ message: issues.join(" | ") });
    },
    { identifier: "WorkflowGraphV2" },
  ),
);
export type WorkflowGraphV2 = typeof WorkflowGraphV2.Type;

/**
 * T3 저장 정의 계약 (v1 필드 100% 유지 + 선택적 `graphV2` 사이드카 지원)
 * 기존 SQLite 행과 `retainedBinding` JSON 쿼리 호환성을 유지하면서 v2 그래프를 함께 저장할 수 있다.
 */
export const WorkflowDefinition = Schema.Struct({
  schemaVersion: Schema.Literal(WORKFLOW_SCHEMA_VERSION_V1),
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  inputs: Schema.Array(WorkflowInput),
  nodes: Schema.Array(WorkflowNode).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(WORKFLOW_MAX_STATIC_NODES),
  ),
  graphV2: Schema.optionalKey(WorkflowGraphV2Draft),
});
export type WorkflowDefinition = typeof WorkflowDefinition.Type;

export const WorkflowVersion = Schema.Struct({
  ...WorkflowDefinition.fields,
  revision: NonNegativeInt,
  archived: Schema.Boolean,
  digest: Schema.String,
  createdAt: IsoDateTime,
});
export type WorkflowVersion = typeof WorkflowVersion.Type;

// ============================================================================
// 9. Legacy V1 Schemas & Deterministic Upcaster (upcastV1ToV2)
// ============================================================================

/** 외부/경량 v1 그래프 형식 (prompt 기반)도 함께 수용 */
export const WorkflowInputV1 = Schema.Union([
  TrimmedNonEmptyString,
  Schema.Struct({
    key: TrimmedNonEmptyString,
    label: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
    required: Schema.optionalKey(Schema.Boolean),
    defaultValue: Schema.optionalKey(Schema.String),
  }),
]);
export type WorkflowInputV1 = typeof WorkflowInputV1.Type;

export const WorkflowNodeV1 = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  prompt: TrimmedNonEmptyString,
  agent: LegacyWorkflowAgent,
  dependsOn: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  successCriteria: Schema.optionalKey(Schema.Array(Schema.String)),
  timeoutMs: Schema.optionalKey(PositiveInt),
  maxRetries: Schema.optionalKey(NonNegativeInt),
});
export type WorkflowNodeV1 = typeof WorkflowNodeV1.Type;

export const WorkflowGraphV1 = Schema.Struct({
  /** 초기 v1 저장분에는 schemaVersion 필드가 생략되어 있을 수 있으므로 optional 허용 */
  schemaVersion: Schema.optionalKey(Schema.Literal(WORKFLOW_SCHEMA_VERSION_V1)),
  inputs: Schema.optionalKey(Schema.Array(WorkflowInputV1)),
  nodes: Schema.Array(WorkflowNodeV1),
});
export type WorkflowGraphV1 = typeof WorkflowGraphV1.Type;

/**
 * 레거시 v1 에이전트 리터럴을 v2 CapabilityProfile 및 라우팅 요구사항으로 매핑
 */
export const mapLegacyAgentToCapability = (
  agent: LegacyWorkflowAgent,
): {
  readonly capability: CapabilityProfile;
  readonly routing: ModelRoutingRequirements;
} => {
  switch (agent) {
    case "codex":
      return {
        capability: "code-surgeon",
        routing: {
          legacyAgentHint: "codex",
          requiresToolUse: true,
          requiresShellAccess: true,
        },
      };
    case "fable":
      return {
        capability: "deep-architect",
        routing: {
          legacyAgentHint: "fable",
          requiresStructuredOutput: true,
        },
      };
    case "grok":
      return {
        capability: "fast-scout",
        routing: {
          legacyAgentHint: "grok",
        },
      };
  }
};

const sanitizeIdentifier = (raw: string, fallbackPrefix: string, index: number): string => {
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_");
  if (cleaned.length === 0) {
    return `${fallbackPrefix}_${index}`;
  }
  const ensuredStart = /^[a-zA-Z0-9]/.test(cleaned) ? cleaned : `n_${cleaned}`;
  return ensuredStart.slice(0, 128);
};

const sanitizeInputKey = (raw: string, index: number): string => {
  const cleanKey = raw.trim().replace(/[^a-zA-Z0-9_]/g, "_") || `input_${index}`;
  const validKey = /^[a-zA-Z_]/.test(cleanKey) ? cleanKey : `_${cleanKey}`;
  return validKey.slice(0, 64);
};

const mapV1InputType = (type: WorkflowInput["type"]): WorkflowInputValueType =>
  type === "path" ? "file_path" : type;

const isT3V1Definition = (
  value: WorkflowDefinition | WorkflowGraphV1,
): value is WorkflowDefinition =>
  "id" in value &&
  typeof value.id === "string" &&
  "title" in value &&
  typeof value.title === "string" &&
  "description" in value &&
  typeof value.description === "string" &&
  value.nodes.every((node) => "task" in node);

/**
 * T3 실제 저장 v1 `WorkflowDefinition`을 무손실로 `WorkflowGraphV2Draft`로 업캐스트.
 * - `id`, `title`, `description`, `inputs[].type(path -> file_path)`, `participantId`, `skills`, `kind` 모두 보존
 * - 동일 v1 입력에 대해 항상 동일한 노드/엣지 ID와 순서를 생성
 */
export const upcastV1DefinitionToV2 = (definition: WorkflowDefinition): WorkflowGraphV2Draft => {
  const normalizedInputs: WorkflowInputParameterV2[] = definition.inputs.map((entry, index) => ({
    key: sanitizeInputKey(entry.name, index),
    label: entry.label,
    valueType: mapV1InputType(entry.type),
    required: entry.required,
    ...(entry.defaultValue !== "" ? { defaultValue: entry.defaultValue } : {}),
  }));

  const inputBindingsFromWorkflowInputs: Record<string, BindingExpression> = {};
  for (const param of normalizedInputs) {
    inputBindingsFromWorkflowInputs[param.key] = `{{inputs.${param.key}}}`;
  }

  const rawToNodeId = new Map<string, WorkflowNodeId>();
  definition.nodes.forEach((node, idx) => {
    rawToNodeId.set(node.id, WorkflowNodeId.make(sanitizeIdentifier(node.id, "node", idx)));
  });

  const unverifiedCriteriaNodeIds: WorkflowNodeId[] = [];
  const edges: WorkflowEdgeV2[] = [];
  const usedEdgeIds = new Set<string>();

  const v2Nodes: WorkflowNodeV2[] = definition.nodes.map((v1Node, index) => {
    const nodeId =
      rawToNodeId.get(v1Node.id) ??
      WorkflowNodeId.make(sanitizeIdentifier(v1Node.id, "node", index));
    const { capability, routing } = mapLegacyAgentToCapability(v1Node.agent);

    if (v1Node.successCriteria.length > 0) {
      unverifiedCriteriaNodeIds.push(nodeId);
    }

    for (const depRawId of v1Node.dependsOn) {
      const fromId =
        rawToNodeId.get(depRawId) ??
        WorkflowNodeId.make(sanitizeIdentifier(depRawId, "dep", index));
      const baseEdgeId = sanitizeIdentifier(`e_${fromId}__${nodeId}`, "edge", edges.length);
      const uniqueEdgeId = usedEdgeIds.has(baseEdgeId)
        ? `${baseEdgeId.slice(0, 120)}_${edges.length}`
        : baseEdgeId;
      usedEdgeIds.add(uniqueEdgeId);

      edges.push({
        id: WorkflowEdgeId.make(uniqueEdgeId),
        from: fromId,
        to: nodeId,
        kind: "unconditional",
      });
    }

    return {
      id: nodeId,
      kind: "agent",
      title: v1Node.title,
      joinPolicy: "all_succeeded",
      promptTemplate: v1Node.task,
      capability,
      routing,
      isolation: "shared_write",
      sideEffectPolicy: "workspace_mutation",
      inputBindings: { ...inputBindingsFromWorkflowInputs },
      advisoryCriteria: [...v1Node.successCriteria],
      cleanContext: true,
      cacheable: false,
      participantId: v1Node.participantId,
      skills: [...v1Node.skills],
      legacyKind: v1Node.kind,
    };
  });

  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION_V2,
    id: WorkflowDefinitionId.make(definition.id.slice(0, 256)),
    title: definition.title,
    description: definition.description,
    inputs: normalizedInputs,
    nodes: v2Nodes,
    edges,
    loops: [],
    migrationProvenance: {
      migratedFromSchemaVersion: WORKFLOW_SCHEMA_VERSION_V1,
      unverifiedCriteriaNodeIds,
    },
  };
};

/**
 * 결정론적 무손실 업캐스터 (T3 `WorkflowDefinition` 또는 경량 `WorkflowGraphV1` -> `WorkflowGraphV2Draft`)
 * - 동일 v1 입력에 대해 항상 동일한 노드/엣지 ID와 순서를 생성하여 캐시 해시 일관성 보장
 * - 기존 런타임 시맨틱이 갑자기 변하지 않도록 파일 격리 모드는 보수적으로 `shared_write` 유지
 */
export const upcastV1ToV2 = (v1: WorkflowDefinition | WorkflowGraphV1): WorkflowGraphV2Draft => {
  if (isT3V1Definition(v1)) {
    return upcastV1DefinitionToV2(v1);
  }

  const normalizedInputs: WorkflowInputParameterV2[] = (v1.inputs ?? []).map((entry, index) => {
    if (typeof entry === "string") {
      return {
        key: sanitizeInputKey(entry, index),
        label: entry,
        valueType: "string",
        required: true,
      };
    }
    return {
      key: sanitizeInputKey(entry.key, index),
      label: entry.label?.trim() || entry.key,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      valueType: "string",
      required: entry.required ?? true,
      ...(entry.defaultValue !== undefined ? { defaultValue: entry.defaultValue } : {}),
    };
  });

  const inputBindingsFromWorkflowInputs: Record<string, BindingExpression> = {};
  for (const param of normalizedInputs) {
    inputBindingsFromWorkflowInputs[param.key] = `{{inputs.${param.key}}}`;
  }

  const rawToNodeId = new Map<string, WorkflowNodeId>();
  v1.nodes.forEach((n, idx) => {
    rawToNodeId.set(n.id, WorkflowNodeId.make(sanitizeIdentifier(n.id, "node", idx)));
  });

  const unverifiedCriteriaNodeIds: WorkflowNodeId[] = [];
  const edges: WorkflowEdgeV2[] = [];
  const usedEdgeIds = new Set<string>();

  const v2Nodes: WorkflowNodeV2[] = v1.nodes.map((v1Node, index) => {
    const nodeId =
      rawToNodeId.get(v1Node.id) ??
      WorkflowNodeId.make(sanitizeIdentifier(v1Node.id, "node", index));
    const { capability, routing } = mapLegacyAgentToCapability(v1Node.agent);
    const criteria = v1Node.successCriteria ?? [];

    if (criteria.length > 0) {
      unverifiedCriteriaNodeIds.push(nodeId);
    }

    for (const depRawId of v1Node.dependsOn ?? []) {
      const fromId =
        rawToNodeId.get(depRawId) ??
        WorkflowNodeId.make(sanitizeIdentifier(depRawId, "dep", index));
      const baseEdgeId = sanitizeIdentifier(`e_${fromId}__${nodeId}`, "edge", edges.length);
      const uniqueEdgeId = usedEdgeIds.has(baseEdgeId)
        ? `${baseEdgeId.slice(0, 120)}_${edges.length}`
        : baseEdgeId;
      usedEdgeIds.add(uniqueEdgeId);

      edges.push({
        id: WorkflowEdgeId.make(uniqueEdgeId),
        from: fromId,
        to: nodeId,
        kind: "unconditional",
      });
    }

    const displayTitle = v1Node.title?.trim() || v1Node.label?.trim() || v1Node.id;

    return {
      id: nodeId,
      kind: "agent",
      title: displayTitle,
      joinPolicy: "all_succeeded",
      promptTemplate: v1Node.prompt,
      capability,
      routing,
      isolation: "shared_write",
      sideEffectPolicy: "workspace_mutation",
      inputBindings: { ...inputBindingsFromWorkflowInputs },
      advisoryCriteria: [...criteria],
      cleanContext: true,
      cacheable: false,
      ...(v1Node.timeoutMs !== undefined ? { budget: { maxWallTimeMs: v1Node.timeoutMs } } : {}),
      ...(v1Node.maxRetries !== undefined && v1Node.maxRetries > 0
        ? {
            retryPolicy: {
              maxAttempts: Math.min(v1Node.maxRetries + 1, 10),
              backoffStrategy: "exponential_jitter" as const,
              initialDelayMs: 1_000,
              maxDelayMs: 30_000,
              retryOn: ["provider_rate_limit", "transient_network", "timeout"] as const,
            },
          }
        : {}),
    };
  });

  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION_V2,
    inputs: normalizedInputs,
    nodes: v2Nodes,
    edges,
    loops: [],
    migrationProvenance: {
      migratedFromSchemaVersion: WORKFLOW_SCHEMA_VERSION_V1,
      unverifiedCriteriaNodeIds,
    },
  };
};

// ============================================================================
// 10. Transparent Persistence Codec & Graph Topology Helpers
// ============================================================================

export const AnyPersistedWorkflowGraph = Schema.Union([
  WorkflowGraphV2Draft,
  WorkflowDefinition,
  WorkflowGraphV1,
]);
export type AnyPersistedWorkflowGraph = typeof AnyPersistedWorkflowGraph.Type;

/**
 * T3 `WorkflowDefinition`에서 실행·시각화용 정규 `WorkflowGraphV2Draft`를 얻는다.
 * 이미 `graphV2`가 첨부되어 있으면 그대로 사용하고, 없으면 v1 노드를 무손실 결정론적으로 업캐스트한다.
 */
export const resolveCanonicalWorkflowGraphV2 = (
  definition: WorkflowDefinition,
): WorkflowGraphV2Draft =>
  definition.graphV2 !== undefined ? definition.graphV2 : upcastV1DefinitionToV2(definition);

/**
 * DB(SQLite)나 파일에서 읽을 때는 T3 v1(`WorkflowDefinition`), 경량 v1(`WorkflowGraphV1`),
 * 또는 v2(`WorkflowGraphV2Draft`)를 모두 수용해 자동으로 검증된 `WorkflowGraphV2`로 승격하고,
 * 다시 직렬화(Encode)할 때는 항상 정규화된 v2 포맷으로 기록하는 표준 코덱
 */
export const CanonicalWorkflowGraphFromPersistence = AnyPersistedWorkflowGraph.pipe(
  Schema.decodeTo(
    WorkflowGraphV2,
    SchemaTransformation.transformOrFail({
      decode: (persisted) => {
        const candidate: WorkflowGraphV2Draft =
          persisted.schemaVersion === WORKFLOW_SCHEMA_VERSION_V2
            ? persisted
            : isT3V1Definition(persisted) && persisted.graphV2 !== undefined
              ? persisted.graphV2
              : upcastV1ToV2(persisted);
        return Effect.succeed(candidate as typeof WorkflowGraphV2.Encoded);
      },
      encode: (canonicalV2) => Effect.succeed(canonicalV2 as unknown as AnyPersistedWorkflowGraph),
    }),
  ),
);

/**
 * `packages/shared/src/workflow.ts` 위상 정렬기에서 사용할 Forward-DAG 전용 엣지 필터.
 * `loop_back` 역방향 엣지를 제외한 나머지 그래프는 반드시 비순환 DAG 불변식을 만족해야 함.
 */
export const extractForwardEdges = (
  graph: Pick<WorkflowGraphV2Draft, "edges">,
): readonly WorkflowEdgeV2[] => graph.edges.filter((edge) => edge.kind !== "loop_back");

export const extractLoopBackEdges = (
  graph: Pick<WorkflowGraphV2Draft, "edges">,
): readonly WorkflowEdgeV2[] => graph.edges.filter((edge) => edge.kind === "loop_back");

export const WorkflowGraph = WorkflowGraphV2;
export type WorkflowGraph = WorkflowGraphV2;
