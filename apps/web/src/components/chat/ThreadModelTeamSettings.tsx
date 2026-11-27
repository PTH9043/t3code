import { useAtomValue } from "@effect/atom-react";
import { useMemo, useState, type Ref } from "react";
import {
  CouncilRoleArchetype,
  councilRoleArchetypeLabels,
  resolveSubordinateTeam,
  SubordinateCapabilityTag,
  subordinateCapabilityLabels,
  threadTeamRoleLabels as roles,
  ThreadTeamRole,
  type EnvironmentId,
  type ModelSelection,
  type ThreadId,
  type ThreadTeamMember,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { getAppModelOptionsForInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { serverEnvironment, EMPTY_SERVER_PROVIDERS } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";
import { notifyCommandFailure } from "../control-center/controlCenterShared";
import { WorkerFamilyFilter, workerModelFamily } from "./WorkerFamilyFilter";
import { Button } from "../ui/button";

type Props = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  modelSelection: ModelSelection;
  draftId?: DraftId | null;
  addModelRef?: Ref<HTMLSelectElement>;
  edits?: Map<string, readonly MemberRow[]>;
  onSaving?: (pending: boolean) => void;
};

const inputStyle =
  "min-w-0 w-full rounded border border-input bg-background px-2 py-1 text-foreground";
const modelKey = (account: string, model: string) => JSON.stringify([account, model]);
const memberKey = (member: ThreadTeamMember) =>
  JSON.stringify([member.instanceId, member.model.toLowerCase(), member.role]);

export type MemberRow = { key: string; member: ThreadTeamMember };

function sameMembers(left: readonly ThreadTeamMember[], right: readonly ThreadTeamMember[]) {
  return (
    left.length === right.length &&
    left.every((a, i) => {
      const b = right[i]!;
      return (
        a.instanceId === b.instanceId &&
        a.model === b.model &&
        a.role === b.role &&
        (a.instructions ?? "") === (b.instructions ?? "") &&
        (a.enabled ?? true) === (b.enabled ?? true) &&
        (a.councilRoleOverride ?? "") === (b.councilRoleOverride ?? "") &&
        JSON.stringify(a.capabilities ?? []) === JSON.stringify(b.capabilities ?? [])
      );
    })
  );
}

/** Reset unsaved row edits on scope changes, including promotion to a saved room. */
export function ThreadModelTeamSettings({
  environmentId,
  threadId,
  modelSelection,
  draftId = null,
  addModelRef,
  edits,
  onSaving,
}: Omit<Props, "threadId" | "modelSelection"> & {
  threadId: ThreadId | null;
  modelSelection: ModelSelection | null;
}) {
  if (!threadId || !modelSelection)
    return (
      <section
        aria-label="하위 모델"
        className="shrink-0 border-b border-border px-3 py-1.5 text-xs sm:px-5"
      >
        <strong>하위 모델</strong>{" "}
        <span className="text-muted-foreground">
          {threadId
            ? "일반 모델을 선택하면 설정할 수 있습니다."
            : "저장된 대화가 열리면 설정할 수 있습니다."}
        </span>
      </section>
    );
  return (
    <TeamEditor
      key={JSON.stringify([environmentId, threadId, draftId])}
      environmentId={environmentId}
      threadId={threadId}
      modelSelection={modelSelection}
      draftId={draftId}
      {...(addModelRef ? { addModelRef } : {})}
      {...(edits ? { edits } : {})}
      {...(onSaving ? { onSaving } : {})}
    />
  );
}

export function GlobalSubordinateTeamEditor({
  environmentId,
  addModelRef,
}: {
  environmentId: EnvironmentId;
  addModelRef?: Ref<HTMLSelectElement>;
}) {
  return <TeamEditor environmentId={environmentId} {...(addModelRef ? { addModelRef } : {})} />;
}

function TeamEditor({
  environmentId,
  threadId,
  draftId,
  addModelRef,
  edits,
  onSaving,
}: Omit<Props, "threadId" | "modelSelection"> & {
  threadId?: ThreadId;
  modelSelection?: ModelSelection;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const options = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      )
        .filter((entry) => entry.enabled && entry.isAvailable)
        .flatMap((entry) =>
          getAppModelOptionsForInstance(settings, entry).map((model) => ({
            family: workerModelFamily(entry.driverKind, entry.instanceId, model.slug),
            key: modelKey(entry.instanceId, model.slug),
            instanceId: entry.instanceId,
            model: model.slug,
            label:
              entry.displayName === entry.instanceId
                ? `${entry.instanceId} · ${model.name}`
                : `${entry.displayName} (${entry.instanceId}) · ${model.name}`,
          })),
        ),
    [providers, settings],
  );
  const [family, setFamily] = useState("all");
  const visibleFamily = options.some((option) => option.family === family) ? family : "all";
  const filtered =
    visibleFamily === "all" ? options : options.filter((option) => option.family === visibleFamily);
  const local = useComposerDraftStore((store) =>
    draftId ? store.draftThreadsByThreadKey[draftId]?.customSubordinateTeam : undefined,
  );
  const resolved = threadId ? resolveSubordinateTeam(settings, threadId) : null;
  const custom = draftId ? local : resolved?.source === "room" ? resolved.members : undefined;
  const editable = !threadId || custom !== undefined;
  const scopeKey = threadId ?? "global";
  const [draft, setDraft] = useState<readonly MemberRow[] | null>(
    () => edits?.get(scopeKey) ?? null,
  );
  const rows: readonly MemberRow[] =
    draft ??
    (custom ?? settings.globalSubordinateTeam ?? []).map((member) => ({
      key: memberKey(member),
      member,
    }));
  const members = rows.map((row) => row.member);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [expandedCouncilKeys, setExpandedCouncilKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const edit = (next: readonly MemberRow[]) => {
    setFeedback("");
    edits?.set(scopeKey, next);
    setDraft(next);
  };
  const replace = (key: string, member: ThreadTeamMember) =>
    edit(rows.map((row) => (row.key === key ? { ...row, member } : row)));
  const duplicate = new Set(members.map(memberKey)).size !== members.length;
  const save = async (next: readonly ThreadTeamMember[] | null) => {
    if (pending) return;
    const cleaned =
      next?.map(({ instructions, ...member }) =>
        instructions?.trim() ? { ...member, instructions: instructions.trim() } : member,
      ) ?? null;
    if (draftId && threadId) {
      const store = useComposerDraftStore.getState();
      const session = store.getDraftSession(draftId);
      if (
        session?.environmentId !== environmentId ||
        session.threadId !== threadId ||
        session.promotedTo
      ) {
        setFeedback("초안이 변경되어 팀 설정을 저장할 수 없습니다.");
        return;
      }
      store.updateDraftSubordinateTeam(draftId, { threadId, members: cleaned });
      const applied = useComposerDraftStore
        .getState()
        .getDraftSession(draftId)?.customSubordinateTeam;
      if (cleaned === null ? applied !== undefined : !applied || !sameMembers(applied, cleaned)) {
        setFeedback("초안에 팀 설정을 저장하지 못했습니다.");
        return;
      }
      edits?.delete(scopeKey);
      setDraft(null);
      setFeedback(
        cleaned === null ? "글로벌 팀을 사용합니다." : "첫 요청에 사용할 팀을 초안에 저장했습니다.",
      );
      return;
    }
    setPending(true);
    onSaving?.(true);
    setFeedback("");
    try {
      const result = await saveSettings({
        environmentId,
        input: {
          patch: threadId
            ? { threadSubordinateTeamUpdate: { threadId, members: cleaned } }
            : { globalSubordinateTeam: cleaned ?? [] },
        },
      });
      if (result._tag !== "Success") {
        notifyCommandFailure(result, "하위 AI 설정을 저장할 수 없습니다.");
        return;
      }
      const applied = threadId
        ? result.value.threadSubordinateTeams?.[threadId]
        : result.value.globalSubordinateTeam;
      if (cleaned === null ? applied != null : !applied || !sameMembers(applied, cleaned)) {
        setFeedback("서버에서 팀 변경을 확인하지 못했습니다.");
        return;
      }
      edits?.delete(scopeKey);
      setDraft(null);
      setFeedback(
        cleaned === null
          ? "글로벌 팀을 사용합니다."
          : threadId
            ? "이 방의 커스텀 팀을 저장했습니다."
            : "글로벌 팀을 저장했습니다.",
      );
    } catch {
      setFeedback("팀 설정을 저장하지 못했습니다. 서버 연결을 확인해 주세요.");
    } finally {
      setPending(false);
      onSaving?.(false);
    }
  };
  return (
    <section
      aria-label={threadId ? "하위 모델" : "글로벌 하위 작업 모델"}
      className="@container/team shrink-0 max-h-[32dvh] overflow-y-auto overscroll-contain border-b border-border bg-background px-3 py-2 text-xs sm:px-5"
    >
      <fieldset disabled={pending} className="grid min-w-0 gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="font-semibold">{threadId ? "하위 모델" : "글로벌 하위 작업 모델"}</h2>
          {threadId && (
            <span className="text-muted-foreground">
              {editable ? "이 방의 커스텀 팀" : "글로벌 팀 사용 중"}
            </span>
          )}
        </div>
        {!editable && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span>
              {members.map((member) => `${member.model} · ${roles[member.role]}`).join(" / ") ||
                "지정한 하위 모델 없음"}
            </span>
            <Button size="xs" variant="outline" onClick={() => void save(members)}>
              이 방에서 커스텀 사용
            </Button>
          </div>
        )}
        {editable && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <WorkerFamilyFilter options={options} value={visibleFamily} onChange={setFamily} />
              <label className="inline-flex min-w-0 max-w-full items-center gap-2">
                <span className="shrink-0">하위 모델 추가</span>
                <select
                  ref={addModelRef}
                  aria-label="하위 모델 추가"
                  className={inputStyle}
                  value=""
                  onChange={(event) => {
                    const picked = options.find(
                      (option) => option.key === event.currentTarget.value,
                    );
                    if (picked)
                      edit([
                        ...rows,
                        {
                          key: randomUUID(),
                          member: {
                            instanceId: picked.instanceId,
                            model: picked.model,
                            role: "worker",
                          },
                        },
                      ]);
                  }}
                >
                  <option value="">
                    {options.length ? "계정과 모델 선택" : "사용 가능한 모델이 없습니다"}
                  </option>
                  {filtered.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                size="xs"
                disabled={draft === null || duplicate}
                onClick={() => void save(members)}
              >
                팀 저장
              </Button>
              {members.length > 0 && (
                <Button size="xs" variant="outline" onClick={() => void save([])}>
                  {threadId ? "이 팀 사용 안 함" : "전역 팀 비우기"}
                </Button>
              )}
              {threadId && custom !== undefined && (
                <Button size="xs" variant="outline" onClick={() => void save(null)}>
                  글로벌 팀 사용
                </Button>
              )}
            </div>
            {duplicate && <p role="status">같은 모델에 같은 역할이 두 번 지정됐습니다.</p>}
            {!members.length && <p className="text-muted-foreground">하위 모델 없음</p>}
            {rows.map(({ key: rowKey, member }, index) => {
              const key = modelKey(member.instanceId, member.model);
              return (
                <div
                  key={rowKey}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2 border-t border-border pt-1 @xl/team:grid-cols-[minmax(0,1.5fr)_auto_minmax(0,1fr)_auto]"
                >
                  <label>
                    하위 모델 {index + 1}
                    <select
                      aria-label={`${index + 1}번 하위 모델`}
                      className={inputStyle}
                      value={key}
                      onChange={(event) => {
                        const picked = options.find(
                          (option) => option.key === event.currentTarget.value,
                        );
                        if (picked)
                          replace(rowKey, {
                            ...member,
                            instanceId: picked.instanceId,
                            model: picked.model,
                          });
                      }}
                    >
                      {!options.some((option) => option.key === key) && (
                        <option value={key}>
                          {member.instanceId} · {member.model} (현재 목록에 없음)
                        </option>
                      )}
                      {options
                        .filter(
                          (option) =>
                            visibleFamily === "all" ||
                            option.family === visibleFamily ||
                            option.key === key,
                        )
                        .map((option) => (
                          <option key={option.key} value={option.key}>
                            {option.label}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    역할
                    <select
                      aria-label={`${index + 1}번 역할`}
                      className={inputStyle}
                      value={member.role}
                      onChange={(event) => {
                        const role = event.currentTarget.value;
                        if (Schema.is(ThreadTeamRole)(role)) replace(rowKey, { ...member, role });
                      }}
                    >
                      {Object.entries(roles).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    역할 세부 지시
                    <textarea
                      aria-label={`${index + 1}번 역할 세부 지시`}
                      className={inputStyle}
                      rows={1}
                      value={member.instructions ?? ""}
                      onChange={(event) =>
                        replace(rowKey, { ...member, instructions: event.currentTarget.value })
                      }
                    />
                  </label>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`${index + 1}번 하위 모델 제거`}
                    className="justify-self-start"
                    onClick={() => edit(rows.filter((row) => row.key !== rowKey))}
                  >
                    제거
                  </Button>
                  <div className="col-span-full text-[11px] text-muted-foreground">
                    <button
                      type="button"
                      aria-expanded={expandedCouncilKeys.has(rowKey)}
                      onClick={() =>
                        setExpandedCouncilKeys((prev) => {
                          const next = new Set(prev);
                          if (next.has(rowKey)) next.delete(rowKey);
                          else next.add(rowKey);
                          return next;
                        })
                      }
                      className="cursor-pointer select-none hover:text-foreground"
                    >
                      다자간 위원회 옵션 ({member.enabled === false ? "비활성" : "활성"}
                      {member.councilRoleOverride
                        ? ` · ${councilRoleArchetypeLabels[member.councilRoleOverride]}`
                        : ""}
                      {member.capabilities?.length ? ` · 역량 ${member.capabilities.length}개` : ""}
                      )
                    </button>
                    {expandedCouncilKeys.has(rowKey) ? (
                      <div className="mt-1.5 flex flex-wrap items-center gap-3 rounded-md border border-border/60 bg-muted/20 p-2">
                        <label className="inline-flex cursor-pointer items-center gap-1.5 text-foreground">
                          <input
                            type="checkbox"
                            aria-label={`${index + 1}번 위원회 자동 합석 활성`}
                            checked={member.enabled !== false}
                            onChange={(event) =>
                              replace(rowKey, { ...member, enabled: event.currentTarget.checked })
                            }
                          />
                          위원회 자동 합석
                        </label>
                        <label className="inline-flex items-center gap-1.5">
                          <span>고정 역할</span>
                          <select
                            aria-label={`${index + 1}번 위원회 고정 역할`}
                            className={inputStyle}
                            value={member.councilRoleOverride ?? ""}
                            onChange={(event) => {
                              const val = event.currentTarget.value;
                              const { councilRoleOverride: _prev, ...rest } = member;
                              if (val && Schema.is(CouncilRoleArchetype)(val)) {
                                replace(rowKey, { ...rest, councilRoleOverride: val });
                              } else {
                                replace(rowKey, rest);
                              }
                            }}
                          >
                            <option value="">자동 역량 매칭</option>
                            {Object.entries(councilRoleArchetypeLabels)
                              .filter(([k]) => k !== "CHAIR_ARBITER")
                              .map(([k, label]) => (
                                <option key={k} value={k}>
                                  {label}
                                </option>
                              ))}
                          </select>
                        </label>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span>역량 태그:</span>
                          {Object.entries(subordinateCapabilityLabels).map(([tagKey, label]) => {
                            const active = member.capabilities?.includes(
                              tagKey as SubordinateCapabilityTag,
                            );
                            return (
                              <button
                                key={tagKey}
                                type="button"
                                aria-pressed={Boolean(active)}
                                onClick={() => {
                                  const current = member.capabilities ?? [];
                                  const nextCaps = active
                                    ? current.filter((c) => c !== tagKey)
                                    : [...current, tagKey as SubordinateCapabilityTag];
                                  const { capabilities: _prev, ...rest } = member;
                                  replace(
                                    rowKey,
                                    nextCaps.length > 0
                                      ? { ...rest, capabilities: nextCaps }
                                      : rest,
                                  );
                                }}
                                className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                                  active
                                    ? "border-primary bg-primary/15 font-medium text-foreground"
                                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                                }`}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </fieldset>
      {feedback && (
        <p role="status" className="mt-2">
          {feedback}
        </p>
      )}
    </section>
  );
}
