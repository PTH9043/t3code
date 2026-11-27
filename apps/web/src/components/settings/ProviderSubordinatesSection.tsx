"use client";

import { useAtomValue } from "@effect/atom-react";
import { PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderModel,
  SubordinateAssignment,
  SubordinateRole,
} from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  accountSubordinates,
  canonicalName,
  CLAUDE_WORKER_LABELS,
  claudeWorkerValue,
  CODEX_INHERIT,
  commitDraft,
  type ConfigDraft,
  decidingAssignment,
  DEFAULT_CLAUDE_WORKER,
  draftText,
  formatHelperModelNames,
  formatModelAssignments,
  helperAccountOptions,
  helperModelChoices,
  isAssignmentName,
  isCodexSubagentValue,
  isDraftDirty,
  isListName,
  listHelperApiAccounts,
  modelsDecidedByAssignments,
  nextUnassignedModel,
  parseHelperModelNames,
  parseModelAssignments,
  readConfigText,
  resolveHelperAccount,
  type SelectOption,
  SUBORDINATE_ROLE_OPTIONS,
  subordinateKey,
  toggleHelperModel,
  withSavedOption,
  withSubordinateAt,
  withSubordinateForModel,
} from "./ProviderSubordinatesSection.logic";

function Picker(props: {
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<SelectOption>;
  readonly onChange: (value: string) => void;
}) {
  return (
    <select
      aria-label={props.label}
      className="min-w-0 flex-1 rounded-md border border-input bg-background p-2"
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function RemoveButton(props: { readonly label: string; readonly onClick: () => void }) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      className="size-8 text-muted-foreground hover:text-destructive"
      onClick={props.onClick}
      aria-label={props.label}
    >
      <XIcon className="size-3.5" />
    </Button>
  );
}

function AddButton(props: { readonly disabled: boolean; readonly onClick: () => void }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-7 gap-1.5 px-2 text-xs"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <PlusIcon className="size-3" />
      추가
    </Button>
  );
}

/** Rows of one "answering model = sub-model" text setting. */
function AssignmentRows(props: {
  readonly text: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly valueOptions: ReadonlyArray<SelectOption>;
  readonly normalizeValue: (value: string) => string;
  readonly isUsableValue: (value: string) => boolean;
  /**
   * Value a new row starts with when no saved entry covers its model yet: the
   * account default, so adding a row changes nothing until a value is picked.
   */
  readonly newValue: string;
  readonly onChange: (text: string) => void;
}) {
  const slugs = props.models.map((model) => model.slug);
  const rows = parseModelAssignments(props.text).map((row) => ({
    model: canonicalName(row.model, slugs),
    value: props.normalizeValue(row.value),
  }));
  const decided = modelsDecidedByAssignments(rows, slugs, props.isUsableValue);
  const nameOf = (slug: string) => props.models.find((model) => model.slug === slug)?.name ?? slug;
  const nextModel = nextUnassignedModel(rows, slugs);
  const write = (next: typeof rows) => props.onChange(formatModelAssignments(next));

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span>답변 모델별로 다르게</span>
        <AddButton
          disabled={nextModel === undefined}
          onClick={() => {
            if (nextModel === undefined) return;
            const inEffect = rows[decidingAssignment(rows, nextModel, props.isUsableValue)];
            write([...rows, { model: nextModel, value: inEffect?.value ?? props.newValue }]);
          }}
        />
      </div>
      {rows.map((row, index) => {
        const taken = new Set(
          rows.flatMap((other, position) => (position === index ? [] : [other.model])),
        );
        const modelOptions = withSavedOption(
          props.models
            .filter((model) => isAssignmentName(model.slug))
            .map((model) => ({
              value: model.slug,
              label: model.name,
              ...(taken.has(model.slug) ? { disabled: true } : {}),
            })),
          row.model,
          (saved) => (saved ? `이름에 "${saved}"이(가) 들어간 모델` : "(답변 모델 없음)"),
        );
        const applies = decided[index] ?? [];
        return (
          // eslint-disable-next-line react/no-array-index-key -- a row is only its place in the saved text
          <div key={index} className="grid gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Picker
                label={`답변 모델 ${index + 1}`}
                value={row.model}
                options={modelOptions}
                onChange={(model) =>
                  write(
                    rows.map((other, position) => (position === index ? { ...row, model } : other)),
                  )
                }
              />
              <Picker
                label={`하위 모델 ${index + 1}`}
                value={row.value}
                options={withSavedOption(props.valueOptions, row.value, (saved) =>
                  saved ? `${saved} (목록에 없음)` : "(선택 안 함)",
                )}
                onChange={(value) =>
                  write(
                    rows.map((other, position) => (position === index ? { ...row, value } : other)),
                  )
                }
              />
              <RemoveButton
                label={`${nameOf(row.model)} 줄 제거`}
                onClick={() => write(rows.filter((_, position) => position !== index))}
              />
            </div>
            {applies.length === 1 && applies[0] === row.model ? null : (
              <p className="text-muted-foreground">
                {applies.length > 0
                  ? `적용되는 답변 모델: ${applies.map(nameOf).join(", ")}`
                  : "적용되는 답변 모델이 없습니다. 값이 비었거나 다른 줄이 먼저 적용됩니다."}
              </p>
            )}
          </div>
        );
      })}
      <p className="text-muted-foreground">여기에 없는 답변 모델은 위의 기본 설정을 따릅니다.</p>
    </div>
  );
}

/**
 * "하위 모델" section of a Claude or Codex account: which models work under
 * each answering model. The same-account and helper-API blocks edit the
 * account's own config, which restarts the account when saved, so they share
 * one draft and one save button. The cross-account block edits the server-wide
 * `subordinateModels` list and saves each change at once.
 */
export function ProviderSubordinatesSection(props: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: "claudeAgent" | "codex" | "gemini";
  readonly config: unknown;
  /** This account's answering models. */
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly environmentId: EnvironmentId;
  readonly onConfigChange: (nextConfig: Record<string, unknown> | undefined) => void;
}) {
  const { config, models } = props;
  const settings = useEnvironmentSettings(props.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const [draft, setDraft] = useState<ConfigDraft>({});
  // Settings change only once the server answers a save. Until then the draft
  // stays on screen and the save button stays off, so one save is one write.
  const [saveSent, setSaveSent] = useState(false);
  const [restrictingHelper, setRestrictingHelper] = useState(false);
  const [adding, setAdding] = useState<{
    readonly forModel: string;
    readonly key: string;
    readonly role: SubordinateRole;
  } | null>(null);
  // The list as last sent, shown and built upon until the server's answer replaces `base`.
  const [sentSubordinates, setSentSubordinates] = useState<{
    readonly base: ReadonlyArray<SubordinateAssignment> | undefined;
    readonly next: ReadonlyArray<SubordinateAssignment>;
  } | null>(null);

  const usableEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ).filter((entry) => entry.enabled && entry.isAvailable),
    [providers, settings],
  );
  const subordinateOptions = useMemo(
    () =>
      usableEntries.flatMap((entry) =>
        getAppModelOptionsForInstance(settings, entry).map((model) => ({
          value: subordinateKey(entry.instanceId, model.slug),
          label: `${entry.displayName} · ${model.name}`,
          instanceId: entry.instanceId,
          model: model.slug,
        })),
      ),
    [usableEntries, settings],
  );
  const helperAccounts = useMemo(
    () => listHelperApiAccounts(settings.providerInstances),
    [settings.providerInstances],
  );

  const text = (key: string) => draftText(config, draft, key);
  const setText = (key: string, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaveSent(false);
  };
  /**
   * For a select whose shown value can stand for differently written saved
   * text (an absent key, a display name): picking what is already saved keeps
   * the saved text, so it does not count as a change.
   */
  const choose = (key: string, value: string, savedValue: string) =>
    setText(key, value === savedValue ? readConfigText(config, key) : value);
  const dirty = isDraftDirty(config, draft);
  if (saveSent && !dirty) {
    // The saved config now matches the draft: the save landed, so drop the draft.
    setSaveSent(false);
    setDraft({});
    setRestrictingHelper(false);
  }

  // ── 같은 계정의 하위 모델 ──
  const workerOf = (value: string) => claudeWorkerValue(value) ?? DEFAULT_CLAUDE_WORKER;
  // Saved text that is not a worker shows as the default but must not count as
  // "already saved", or picking the default would write it back.
  const savedWorkerText = readConfigText(config, "conductorWorkerModel");
  const savedWorker = savedWorkerText ? (claudeWorkerValue(savedWorkerText) ?? "") : workerOf("");
  const workerOptions = Object.entries(CLAUDE_WORKER_LABELS).map(([value, label]) => ({
    value,
    label: value === DEFAULT_CLAUDE_WORKER ? `${label} (기본)` : label,
  }));
  const codexModelOf = (value: string) => (value.toLowerCase() === CODEX_INHERIT ? "" : value);
  const codexModelOptions = models
    .filter((model) => isCodexSubagentValue(model.slug))
    .map((model) => ({ value: model.slug, label: model.name }));
  const codexModel = codexModelOf(text("subagentModel"));

  // ── 역할을 맡길 다른 모델 ──
  // An environment whose server predates this setting may send no list.
  const savedSubordinates: ReadonlyArray<SubordinateAssignment> | undefined =
    settings.subordinateModels;
  const allSubordinates =
    sentSubordinates !== null &&
    savedSubordinates !== undefined &&
    sentSubordinates.base === savedSubordinates
      ? sentSubordinates.next
      : (savedSubordinates ?? []);
  const forModelOptions = [
    { value: "", label: "모든 답변 모델" },
    ...models.map((model) => ({ value: model.slug, label: model.name })),
  ];
  const saveSubordinates = (next: ReadonlyArray<SubordinateAssignment>) => {
    setSentSubordinates({ base: savedSubordinates, next });
    updateSettings({ subordinateModels: next });
  };

  // ── 잡일용 하위 API ──
  const helperOf = (value: string) => resolveHelperAccount(value, helperAccounts);
  const helperValue = helperOf(text("helperAccount"));
  const helperNames = parseHelperModelNames(text("helperForModels"));
  const helperSlugs = models.map((model) => model.slug).filter(isListName);
  const helperChoices = helperModelChoices(helperNames, helperSlugs);
  const helperRestricted = helperNames.length > 0 || restrictingHelper;
  const setHelperNames = (names: ReadonlyArray<string>) =>
    setText("helperForModels", formatHelperModelNames(names));
  const scopeOf = (value: string) => (value === "project" ? "project" : "public");

  return (
    <section className="grid gap-3 rounded-lg border border-border/60 p-3" aria-label="하위 모델">
      <div>
        <p className="text-sm font-medium">하위 모델</p>
        <p className="mt-1 text-xs text-muted-foreground">
          이 계정의 답변 모델 아래에서 일할 모델을 정합니다.
        </p>
      </div>

      {props.driver !== "gemini" ? (
        <div className="grid gap-2 rounded-lg border border-border/40 p-3 text-xs">
          <p className="text-sm font-medium">같은 계정의 하위 모델</p>
          {props.driver === "claudeAgent" ? (
            <>
              <p className="text-muted-foreground">
                답변 모델이 계획과 검토를 맡고, 큰 구현은 여기서 고른 모델로 실행되는 worker 하위
                에이전트에 맡깁니다. 새 세션부터 적용됩니다.
              </p>
              <label className="grid gap-1">
                지휘자 모드 일꾼
                <Picker
                  label="지휘자 모드 일꾼"
                  value={workerOf(text("conductorWorkerModel"))}
                  options={workerOptions}
                  onChange={(value) => choose("conductorWorkerModel", value, savedWorker)}
                />
              </label>
              <AssignmentRows
                text={text("conductorWorkerByModel")}
                models={models}
                valueOptions={workerOptions}
                normalizeValue={(value) => claudeWorkerValue(value) ?? value}
                isUsableValue={(value) => claudeWorkerValue(value) !== undefined}
                newValue={workerOf(text("conductorWorkerModel"))}
                onChange={(next) => setText("conductorWorkerByModel", next)}
              />
            </>
          ) : (
            <>
              <p className="text-muted-foreground">
                Codex가 일을 나눠 맡길 때 띄우는 하위 에이전트의 모델입니다. 에이전트 정의 파일에
                모델을 적어 둔 에이전트는 그 모델을 그대로 씁니다. 새 세션부터 적용됩니다.
              </p>
              <label className="grid gap-1">
                하위 에이전트 모델
                <Picker
                  label="하위 에이전트 모델"
                  value={codexModel}
                  options={withSavedOption(
                    [{ value: "", label: "답변 모델과 같음 (기본)" }, ...codexModelOptions],
                    codexModel,
                    (saved) =>
                      isCodexSubagentValue(saved)
                        ? `${saved} (목록에 없음)`
                        : `${saved} (쓸 수 없는 값 — 답변 모델과 같게 동작)`,
                  )}
                  onChange={(value) =>
                    choose(
                      "subagentModel",
                      value,
                      codexModelOf(readConfigText(config, "subagentModel")),
                    )
                  }
                />
              </label>
              <AssignmentRows
                text={text("subagentModelByModel")}
                models={models}
                valueOptions={[
                  ...codexModelOptions,
                  { value: CODEX_INHERIT, label: "답변 모델과 같음" },
                ]}
                normalizeValue={(value) =>
                  value.toLowerCase() === CODEX_INHERIT ? CODEX_INHERIT : value
                }
                isUsableValue={isCodexSubagentValue}
                newValue={codexModel || CODEX_INHERIT}
                onChange={(next) => setText("subagentModelByModel", next)}
              />
            </>
          )}
        </div>
      ) : null}

      <div className="grid gap-2 rounded-lg border border-border/40 p-3 text-xs">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">역할을 맡길 다른 모델</p>
          <AddButton
            disabled={adding !== null || subordinateOptions.length === 0}
            onClick={() => setAdding({ forModel: "", key: "", role: "worker" })}
          />
        </div>
        <p className="text-muted-foreground">
          답변 모델이 workspace_delegate 도구로 일을 맡기고, 돌아온 결과를 확인한 뒤 사용합니다.
          다른 제공자의 모델도 고를 수 있습니다. 바꾸면 바로 저장되고 다음 요청부터 적용되며, 진행
          중인 대화는 중단되지 않습니다.
        </p>
        {subordinateOptions.length === 0 ? (
          <p className="text-muted-foreground">지금 사용할 수 있는 계정과 모델이 없습니다.</p>
        ) : null}
        {accountSubordinates(allSubordinates, props.instanceId).map(({ index, subordinate }) => {
          const key = subordinateKey(subordinate.instanceId, subordinate.model);
          const account = usableEntries.find(
            (entry) => entry.instanceId === subordinate.instanceId,
          );
          const save = (next: SubordinateAssignment | undefined) =>
            saveSubordinates(withSubordinateAt(allSubordinates, index, next));
          return (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Picker
                label="답변 모델"
                value={subordinate.forModel ?? ""}
                options={withSavedOption(
                  forModelOptions,
                  subordinate.forModel ?? "",
                  (saved) => `${saved} (목록에 없는 모델)`,
                )}
                onChange={(forModel) => save(withSubordinateForModel(subordinate, forModel))}
              />
              <Picker
                label="하위 모델"
                value={key}
                options={withSavedOption(subordinateOptions, key, () =>
                  account
                    ? `${account.displayName} · ${subordinate.model} (목록에 없는 모델)`
                    : `${subordinate.instanceId} · ${subordinate.model} (사용 불가)`,
                )}
                onChange={(value) => {
                  const picked = subordinateOptions.find((option) => option.value === value);
                  if (picked)
                    save({ ...subordinate, instanceId: picked.instanceId, model: picked.model });
                }}
              />
              <Picker
                label="역할"
                value={subordinate.role}
                options={SUBORDINATE_ROLE_OPTIONS}
                onChange={(value) => {
                  const picked = SUBORDINATE_ROLE_OPTIONS.find((option) => option.value === value);
                  if (picked) save({ ...subordinate, role: picked.value });
                }}
              />
              {account ? null : (
                <Badge variant="warning" size="sm" className="shrink-0">
                  사용 불가
                </Badge>
              )}
              <RemoveButton
                label={`하위 모델 ${subordinate.model} 제거`}
                onClick={() => save(undefined)}
              />
            </div>
          );
        })}
        {adding ? (
          <div className="flex flex-wrap items-center gap-2">
            <Picker
              label="새 하위 모델의 답변 모델"
              value={adding.forModel}
              options={forModelOptions}
              onChange={(forModel) => setAdding({ ...adding, forModel })}
            />
            <Picker
              label="새 하위 모델"
              value={adding.key}
              options={[{ value: "", label: "하위 모델을 고르세요" }, ...subordinateOptions]}
              onChange={(key) => setAdding({ ...adding, key })}
            />
            <Picker
              label="새 하위 모델의 역할"
              value={adding.role}
              options={SUBORDINATE_ROLE_OPTIONS}
              onChange={(value) => {
                const picked = SUBORDINATE_ROLE_OPTIONS.find((option) => option.value === value);
                if (picked) setAdding({ ...adding, role: picked.value });
              }}
            />
            <Button
              type="button"
              size="sm"
              disabled={!subordinateOptions.some((option) => option.value === adding.key)}
              onClick={() => {
                const picked = subordinateOptions.find((option) => option.value === adding.key);
                if (!picked) return;
                saveSubordinates([
                  ...allSubordinates,
                  withSubordinateForModel(
                    {
                      answeringInstanceId: props.instanceId,
                      instanceId: picked.instanceId,
                      model: picked.model,
                      role: adding.role,
                    },
                    adding.forModel,
                  ),
                ]);
                setAdding(null);
              }}
            >
              목록에 추가
            </Button>
            <RemoveButton label="하위 모델 추가 취소" onClick={() => setAdding(null)} />
          </div>
        ) : null}
      </div>

      <div className="grid gap-2 rounded-lg border border-border/40 p-3 text-xs">
        <p className="text-sm font-medium">잡일용 하위 API</p>
        <p className="text-muted-foreground">
          리서치·요약·번역 같은 잡일을 값싼 API 모델에 맡깁니다.
        </p>
        {helperAccounts.length === 0 ? (
          <p className="text-muted-foreground">
            등록된 API 계정이 없습니다. 먼저 OpenCode 계정의 API 연결에서 API를 등록하세요.
          </p>
        ) : null}
        {helperAccounts.length > 0 ||
        ["helperAccount", "helperForModels", "helperScope"].some(
          (key) => key in draft || readConfigText(config, key) !== "",
        ) ? (
          <>
            <label className="grid gap-1">
              API 계정·모델
              <Picker
                label="잡일용 하위 API 계정·모델"
                value={helperValue}
                options={withSavedOption(
                  helperAccountOptions(helperAccounts),
                  helperValue,
                  (saved) => `${saved} (사용 불가)`,
                )}
                onChange={(value) =>
                  choose("helperAccount", value, helperOf(readConfigText(config, "helperAccount")))
                }
              />
            </label>
            <label className="grid gap-1">
              답변 모델 제한
              <Picker
                label="하위 API를 쓸 답변 모델"
                value={helperRestricted ? "some" : "all"}
                options={[
                  { value: "all", label: "모든 답변 모델" },
                  { value: "some", label: "고른 답변 모델만" },
                ]}
                onChange={(value) => {
                  setRestrictingHelper(value === "some");
                  if (value === "all") setText("helperForModels", "");
                }}
              />
            </label>
            {helperRestricted ? (
              <div className="grid gap-1">
                {helperChoices.models.map((choice) => (
                  <label key={choice.slug} className="flex cursor-pointer items-center gap-2">
                    <Checkbox
                      checked={choice.checked}
                      disabled={choice.locked}
                      onCheckedChange={(checked) =>
                        setHelperNames(
                          toggleHelperModel(
                            helperNames,
                            helperSlugs,
                            choice.slug,
                            checked === true,
                          ),
                        )
                      }
                    />
                    <span>
                      {models.find((model) => model.slug === choice.slug)?.name ?? choice.slug}
                    </span>
                    {choice.locked ? (
                      <span className="text-muted-foreground">
                        (이름이 겹치는 다른 모델과 함께 허용됩니다)
                      </span>
                    ) : null}
                  </label>
                ))}
                {helperChoices.unknown.map((name) => (
                  <label key={name} className="flex cursor-pointer items-center gap-2">
                    <Checkbox
                      checked
                      onCheckedChange={() =>
                        setHelperNames(helperNames.filter((other) => other !== name))
                      }
                    />
                    <span>{name}</span>
                    <span className="text-muted-foreground">(이 계정 목록에 없는 이름)</span>
                  </label>
                ))}
                {helperNames.length === 0 ? (
                  <p className="text-muted-foreground">
                    아직 고른 모델이 없어 모든 답변 모델이 사용할 수 있습니다.
                  </p>
                ) : null}
              </div>
            ) : null}
            <label className="grid gap-1">
              보낼 수 있는 내용
              <Picker
                label="하위 API에 보낼 수 있는 내용"
                value={scopeOf(text("helperScope"))}
                options={[
                  { value: "public", label: "공개 정보·일반 잡일만 (기본)" },
                  { value: "project", label: "프로젝트 내용도 허용" },
                ]}
                onChange={(value) =>
                  choose("helperScope", value, scopeOf(readConfigText(config, "helperScope")))
                }
              />
            </label>
            <p className="text-muted-foreground">보낸 내용은 하위 API 제공사 서버로 나갑니다.</p>
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!dirty || saveSent}
          onClick={() => {
            commitDraft(config, draft, props.onConfigChange);
            setSaveSent(true);
          }}
        >
          {dirty && saveSent ? "저장 중" : "저장"}
        </Button>
        {dirty ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setDraft({});
              setSaveSent(false);
              setRestrictingHelper(false);
            }}
          >
            되돌리기
          </Button>
        ) : null}
        {dirty ? (
          <p role="status" className="text-xs text-warning">
            {saveSent
              ? "저장 중입니다. 반영되지 않으면 되돌리기를 누른 뒤 다시 저장하세요."
              : "저장하면 이 계정에서 진행 중인 대화가 중단될 수 있습니다. 새 세션부터 적용됩니다."}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            ‘같은 계정의 하위 모델’과 ‘잡일용 하위 API’는 저장을 눌러야 반영됩니다.
          </p>
        )}
      </div>
    </section>
  );
}
